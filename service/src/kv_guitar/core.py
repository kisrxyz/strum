"""The guitar engine's core: the sound card, the audio callback, and the link to the server.

Two processes (the probe decided it: with the server's work in the same interpreter one callback
came 9.6 ms late):

- the **audio process** (`audio_main`, `AudioHost`) owns the card. PortAudio's thread runs
  `AudioHost.callback`: the raw input into a ring, the amp chain, a few counters — nothing else.
  The only other thread that lives there is the control thread, asleep on a pipe: it wakes for a
  command (open, close, preset…) and twenty times a second for a moment, to publish the output
  level and to see whether the card is still alive. (A loader thread of `Chain` exists only while
  a model or cabinet that was not loaded ahead is being read.)
- the **server process** holds a `Core`: it starts and watches the audio process, sends it
  commands and reads what the callback wrote.

Between them:

- one block of `multiprocessing.shared_memory` (`Shared`): counters, the input ring, the output
  ring (what the card plays, for «Запись») and the callback times. The callback is the only writer and takes no lock; the reader checks the
  counters before and after copying and throws a torn read away;
- two one-way pipes: commands down, events up (whole `state` snapshots and `need-asset`).
"""

from __future__ import annotations

import gc
import logging
import math
import multiprocessing
import os
import queue
import signal
import sys
import threading
import time
from collections import deque
from collections.abc import Callable, Iterator
from multiprocessing import shared_memory
from typing import Any

import numpy as np

from kv_service.messages import failure, message, reason_of

from .config import (
    AUDIO_PROCESS_DIED,
    AUDIO_PROCESS_FAILED,
    CHAIN_BROKE,
    DEVICE_LOST,
    DEVICE_NOT_FOUND,
    NO_DEVICES,
    OPEN_FAILED,
    RATE_ERROR,
    SAMPLE_RATE,
    EngineError,
    Settings,
    preload_presets,
)

log = logging.getLogger("kv_guitar")

# --- the shared memory -----------------------------------------------------------------------

# int64 cells
H_EPOCH = 0  # goes up each time a stream opens: the counters below start again
H_WRITTEN = 1  # frames written to both rings since the stream opened
H_CALLBACKS = 2  # callbacks measured (the write position of the times ring)
H_FLAGS = 3  # callbacks PortAudio flagged (input overflow, output underflow)
H_LATE = 4  # callbacks that began more than 1.5 periods after the one before
H_MAX_NS = 5  # the longest callback
H_ODD = 6  # callbacks with another block size than asked for (played as silence)
H_MAX_GAP_NS = 7  # the longest time from one callback's start to the next one's
_INTS = 16
# float64 cells
F_PEAK_DB = 0
F_RMS_DB = 1
_FLOATS = 8

# The rings hold 2.7 s of stereo input and as much output. «Запись» reads every frame of them: with
# 0.68 s (until 2026-11-16) one moment of the server standing still on a busy laptop left a hole of
# that length in a take.
RING_FRAMES = 1 << 17
# A reader that only listens (the tuner, the meter) does not want old sound: further behind than
# this (0.68 s) it goes on from the newest.
LISTEN_LAG_FRAMES = 1 << 15
TIMES = 1 << 11  # 5.5 s of callbacks at 128
SILENCE_DB = -200.0

# An entry-to-entry interval over this many periods is a late callback (as in the probe).
LATE_PERIODS = 1.5
# A stream's first moments are not judged: drivers settle.
SETTLE_S = 0.5
# Opening and closing fade over this long.
FADE_S = 0.05
# No callbacks for this long while the stream says it runs: the card is gone.
STALL_S = 1.0
# How often the control thread looks up from the pipe.
TICK_S = 0.05
TICK_LOADING_S = 0.02
# The browser gets the input in pieces of this many frames (10 ms).
FRAME = 480


class Shared:
    """The memory both processes see. Created by the server (`name=None`), attached by the audio process."""

    def __init__(self, name: str | None = None) -> None:
        ints_bytes = _INTS * 8
        floats_bytes = _FLOATS * 8
        ring_bytes = RING_FRAMES * 2 * 4
        size = ints_bytes + floats_bytes + 2 * ring_bytes + TIMES * 8
        self.owner = name is None
        self._shm = (
            shared_memory.SharedMemory(create=True, size=size) if name is None else shared_memory.SharedMemory(name=name)
        )
        buf = self._shm.buf
        self.name = self._shm.name
        self.ints = np.ndarray((_INTS,), dtype=np.int64, buffer=buf, offset=0)
        self.floats = np.ndarray((_FLOATS,), dtype=np.float64, buffer=buf, offset=ints_bytes)
        self.ring = np.ndarray((RING_FRAMES, 2), dtype=np.float32, buffer=buf, offset=ints_bytes + floats_bytes)
        #: What the card played: frame i was made from input frame i, in the same callback.
        self.out_ring = np.ndarray(
            (RING_FRAMES, 2), dtype=np.float32, buffer=buf, offset=ints_bytes + floats_bytes + ring_bytes
        )
        self.times = np.ndarray(
            (TIMES,), dtype=np.int64, buffer=buf, offset=ints_bytes + floats_bytes + 2 * ring_bytes
        )
        if self.owner:
            self.ints[:] = 0
            self.floats[:] = SILENCE_DB

    def close(self) -> None:
        # The arrays point into the memory: they have to go first.
        self.ints = self.floats = self.ring = self.out_ring = self.times = None  # type: ignore[assignment]
        try:
            self._shm.close()
            if self.owner:
                self._shm.unlink()
        except (BufferError, OSError):
            pass


class InputReader:
    """Reads the input ring (and the output ring beside it) from the other process, in whole
    pieces, never waiting."""

    def __init__(self, shared: Shared) -> None:
        self._shared = shared
        self._epoch = -1
        self._at = 0
        #: Pieces skipped because the reader fell behind the ring (the server stood still).
        self.skipped = 0

    def read(self, frames: int = FRAME) -> tuple[int, np.ndarray] | None:
        """(the stream's sample clock at the first frame, a fresh (frames, 2) float32), or None
        when that many new frames are not there yet."""
        piece = self._read(frames, False)
        return None if piece is None else (piece[0], piece[1])

    def read_both(self, frames: int = FRAME) -> tuple[int, np.ndarray, np.ndarray] | None:
        """Like `read`, plus what the card played for those frames."""
        piece = self._read(frames, True)
        if piece is None or piece[2] is None:
            return None
        return piece[0], piece[1], piece[2]

    def _read(self, frames: int, output: bool) -> tuple[int, np.ndarray, np.ndarray | None] | None:
        ints = self._shared.ints
        ring = self._shared.ring
        epoch = int(ints[H_EPOCH])
        if epoch != self._epoch:
            self._epoch = epoch
            self._at = 0
        written = int(ints[H_WRITTEN])
        at = self._at
        if written - at < frames:
            return None
        # A recording wants every frame the ring still holds; listening wants the newest sound.
        if written - at > (RING_FRAMES if output else LISTEN_LAG_FRAMES) - frames:
            # Too far behind (for a recording: what we wanted is overwritten). Go on from the newest whole pieces.
            fresh = (written // frames - 4) * frames
            self.skipped += (fresh - at) // frames
            at = self._at = max(at, fresh)
        start = at % RING_FRAMES
        head = min(frames, RING_FRAMES - start)
        out = np.empty((frames, 2), dtype=np.float32)
        out[:head] = ring[start : start + head]
        if head < frames:
            out[head:] = ring[: frames - head]
        played = None
        if output:
            played = np.empty((frames, 2), dtype=np.float32)
            out_ring = self._shared.out_ring
            played[:head] = out_ring[start : start + head]
            if head < frames:
                played[head:] = out_ring[: frames - head]
        # The writer went on meanwhile: was our piece overwritten while we copied it? Did the stream restart?
        if int(ints[H_EPOCH]) != epoch or int(ints[H_WRITTEN]) - at > RING_FRAMES:
            return None
        self._at = at + frames
        return at, out, played


# --- the sound card ----------------------------------------------------------------------------


# ASIO drivers that are not a sound card of their own: wrappers of the computer's sound, mixers,
# a DAW's driver. "Automatic" passes them over while a real card is there.
NOT_A_CARD = (
    "asio4all", "flexasio", "asio2wasapi", "realtek", "voicemeeter", "fl studio", "asio link",
    "generic low latency", "bandlab", "cakewalk", "jackrouter", "steinberg built-in",
)


def pick_device(names: list[str], wanted: str | None) -> str:
    """The contract's rule: a name must be there; null is the first real card (not one of
    `NOT_A_CARD`), else the first card."""
    if not names:
        raise EngineError(NO_DEVICES)
    if wanted is None:
        return next((name for name in names if not any(w in name.casefold() for w in NOT_A_CARD)), names[0])
    if wanted not in names:
        raise EngineError(DEVICE_NOT_FOUND, name=wanted)
    return wanted


def _is_rate_error(error: BaseException) -> bool:
    code = error.args[1] if len(error.args) > 1 else None
    return code == -9997 or "sample rate" in str(error).casefold()  # paInvalidSampleRate


class _CardStream:
    """`sounddevice.Stream`, cut down to what the engine uses."""

    def __init__(self, stream: Any, in_channels: int, out_channels: int) -> None:
        self._stream = stream
        self.in_channels = in_channels
        self.out_channels = out_channels
        latency = stream.latency
        self.latency = (float(latency[0]), float(latency[1]))

    @property
    def active(self) -> bool:
        try:
            return bool(self._stream.active)
        except Exception:  # noqa: BLE001 — a stream that cannot even answer is not running
            return False

    def start(self) -> None:
        self._stream.start()

    def close(self) -> None:
        self._stream.close(ignore_errors=True)


class CardBackend:
    """The real cards, through PortAudio: ASIO devices on Windows, the system's on a Mac."""

    def __init__(self) -> None:
        # PortAudio only shows ASIO devices when this is set before the import.
        os.environ.setdefault("SD_ENABLE_ASIO", "1")
        import sounddevice as sd

        self._sd = sd

    def refresh(self) -> None:
        """PortAudio lists the cards once, when it starts: start it again to see a card that was
        plugged in since. Only while no stream is open."""
        try:
            self._sd._terminate()
            self._sd._initialize()
        except Exception:  # noqa: BLE001 — the old list is still better than none
            log.debug("PortAudio did not restart", exc_info=True)

    def _cards(self) -> list[tuple[str, int, int, int]]:
        sd = self._sd
        try:
            apis = [dict(api) for api in sd.query_hostapis()]
            devices = [dict(device) for device in sd.query_devices()]
        except Exception:  # noqa: BLE001
            return []
        asio = [index for index, api in enumerate(apis) if "asio" in str(api["name"]).casefold()]
        if asio:
            host = asio[0]
        else:
            try:
                host = int(sd.default.hostapi)
            except Exception:  # noqa: BLE001
                return []
        found = []
        seen = set()
        for index, device in enumerate(devices):
            name = " ".join(str(device["name"]).split())
            ins, outs = int(device["max_input_channels"]), int(device["max_output_channels"])
            if device["hostapi"] != host or ins < 1 or outs < 1 or name in seen:
                continue
            seen.add(name)
            found.append((name, index, min(2, ins), min(2, outs)))
        return found

    def devices(self) -> list[str]:
        return [card[0] for card in self._cards()]

    def open(self, name: str, block: int, sample_rate: int, callback: Callable) -> _CardStream:
        sd = self._sd
        card = next((card for card in self._cards() if card[0] == name), None)
        if card is None:
            raise EngineError(DEVICE_NOT_FOUND, name=name)
        _, index, ins, outs = card
        try:
            sd.check_input_settings(device=index, channels=ins, dtype="float32", samplerate=sample_rate)
            sd.check_output_settings(device=index, channels=outs, dtype="float32", samplerate=sample_rate)
            stream = sd.Stream(
                device=(index, index),
                samplerate=sample_rate,
                blocksize=block,
                channels=(ins, outs),
                dtype="float32",
                latency="low",
                callback=callback,
            )
        except Exception as error:  # noqa: BLE001 — sd.PortAudioError, or a driver's own surprise
            if _is_rate_error(error):
                raise EngineError(RATE_ERROR) from error
            raise EngineError(OPEN_FAILED, reason=reason_of(error)) from error
        if round(float(stream.samplerate)) != sample_rate:
            stream.close(ignore_errors=True)
            raise EngineError(RATE_ERROR)
        return _CardStream(stream, ins, outs)


def make_backend(settings: Settings) -> Any:
    if settings.fake:
        from .fake import FakeBackend

        return FakeBackend(settings.fake)
    return CardBackend()


# --- the audio process ---------------------------------------------------------------------------


class AudioHost:
    """The card, the chain and the callback. Lives in the audio process (tests run it in theirs).

    `emit` gets the events for the server: {'ev': 'state', ...} with the fields of
    `protocol.state_message`, and {'ev': 'need-asset', 'id': ...}.
    """

    def __init__(
        self,
        settings: Settings,
        shared: Shared,
        emit: Callable[[dict], None],
        backend: Any = None,
        clock: Callable[[], int] = time.perf_counter_ns,
    ) -> None:
        from .assets import AssetStore

        self.settings = settings
        self.shared = shared
        self.backend = backend if backend is not None else make_backend(settings)
        self.assets = AssetStore(settings.tones_dir)
        self._emit = emit
        self._clock = clock

        self.status = "idle"
        self.device: str | None = None
        self.buffer = 0
        self.latency_ms: tuple[float, float] | None = None
        self.error: dict | None = None  # a message (kv_service.messages)
        self._devices: list[str] = []
        self._amp: tuple[str, dict | None] = ("idle", None)
        self._amp_note: dict | None = None
        self._model: str | None = None

        self.chain: Any = None
        self.stream: Any = None
        # What the browser asked for; a new chain gets it all again.
        self._preset: dict | None = None
        self._tone: dict | None = None
        self._master: tuple[float, bool] | None = None
        self._channel: str | None = None
        # «Подстроить под мою гитару», dB: kept across openings of the card, like the channel.
        self._trim = 0.0
        # The hum filter's mains (src/dsp/mains.ts): kept across openings of the card, like the trim.
        self._mains = 50
        self._waiting_asset = False

        # The callback's own (set by `_arm`).
        self.block = 0
        self._ints = shared.ints
        self._ring = shared.ring
        self._out_ring = shared.out_ring
        self._times = shared.times
        self._written = 0
        self._count = 0
        self._max_ns = 0
        self._max_gap_ns = 0
        self._last_entry = 0
        self._judge_from = 0
        self._late_ns = 0
        self._in_channels = 2
        self._out_channels = 2
        self._in2 = np.zeros((1, 2), dtype=np.float32)
        self._out2 = np.zeros((1, 2), dtype=np.float32)
        self._ramp = np.zeros(1, dtype=np.float32)
        self._env = np.zeros((1, 1), dtype=np.float32)
        self._gain = 0.0
        self._gain_target = 0.0
        self._gain_step = 1.0
        # Blocks played as pure silence since the output gain reached zero: `_close_stream`
        # waits for them, so the card is not stopped in the middle of the fade.
        self._silent_blocks = 0
        #: How many times the callback caught an exception (it should never).
        self.callback_errors = 0
        #: What broke the callback, if anything did: it plays silence from then on.
        self.callback_error: BaseException | None = None
        self._seen_count = 0
        self._seen_at = 0.0

    # --- the audio thread ------------------------------------------------------------------------

    def callback(self, indata: np.ndarray, outdata: np.ndarray, frames: int, _time: object, status: object) -> None:
        t0 = self._clock()
        ints = self._ints
        last = self._last_entry
        self._last_entry = t0
        if not last:
            self._judge_from = t0 + int(SETTLE_S * 1e9)
        judged = t0 > self._judge_from
        if judged:
            gap = t0 - last
            if gap > self._late_ns:
                ints[H_LATE] += 1
            if gap > self._max_gap_ns:
                self._max_gap_ns = gap
                ints[H_MAX_GAP_NS] = gap
        if status and judged:
            ints[H_FLAGS] += 1
        try:
            if frames != self.block or self.callback_error is not None:
                # ASIO always gives whole blocks; anything else is played as silence and counted.
                if frames != self.block:
                    ints[H_ODD] += 1
                outdata.fill(0)
            else:
                if self._in_channels == 2:
                    inp = indata
                else:
                    inp = self._in2
                    inp[:, 0] = indata[:, 0]
                    inp[:, 1] = indata[:, 0]
                # The raw input, before the gate, for the browser.
                ring = self._ring
                written = self._written
                at = written & (RING_FRAMES - 1)
                head = RING_FRAMES - at
                if head >= frames:
                    ring[at : at + frames] = inp
                else:
                    ring[at:] = inp[:head]
                    ring[: frames - head] = inp[head:]

                out = outdata if self._out_channels == 2 else self._out2
                self.chain.process(inp, out)
                gain = self._gain
                target = self._gain_target
                if gain != target:
                    step = self._gain_step
                    new = min(target, gain + step) if target > gain else max(target, gain - step)
                    env = self._env
                    np.multiply(self._ramp, new - gain, out=env)
                    np.add(env, gain, out=env)
                    np.multiply(out, env, out=out)
                    self._gain = new
                elif gain == 0.0:
                    out.fill(0)
                    self._silent_blocks += 1
                # What the card plays, for «Запись». Both rings are published together, after it.
                out_ring = self._out_ring
                if head >= frames:
                    out_ring[at : at + frames] = out
                else:
                    out_ring[at:] = out[:head]
                    out_ring[: frames - head] = out[head:]
                self._written = written = written + frames
                ints[H_WRITTEN] = written
                if out is not outdata:
                    outdata[:, 0] = out[:, 0]
        except BaseException as error:  # noqa: BLE001 — never out of the callback: silence, and the control thread tells
            if self.callback_error is None:
                self.callback_error = error
            self.callback_errors += 1
            outdata.fill(0)
        elapsed = self._clock() - t0
        count = self._count
        self._times[count & (TIMES - 1)] = elapsed
        self._count = count = count + 1
        ints[H_CALLBACKS] = count
        if elapsed > self._max_ns and judged:
            self._max_ns = elapsed
            ints[H_MAX_NS] = elapsed

    # --- the control thread ----------------------------------------------------------------------

    def warm_up(self) -> None:
        """Before the first `open`: compiles every kernel and the NAM engine, lists the cards."""
        from .chain import Chain

        with np.errstate(all="ignore"):
            Chain(SAMPLE_RATE, 128, self.assets).close()
        self._devices = self._list_devices()
        gc.collect()
        gc.freeze()
        # The control thread gives the interpreter back quickly when the callback wants it.
        sys.setswitchinterval(0.0005)

    def _list_devices(self) -> list[str]:
        try:
            return list(self.backend.devices())
        except Exception:  # noqa: BLE001
            log.debug("could not list the cards", exc_info=True)
            return []

    def state_event(self) -> dict:
        amp_state, amp_message = self._amp
        return {
            "ev": "state",
            "status": self.status,
            "devices": list(self._devices),
            "device": self.device,
            "sample_rate": SAMPLE_RATE,
            "buffer": self.buffer,
            "latency_ms": self.latency_ms,
            "amp_state": amp_state,
            "amp_message": amp_message if amp_message is not None else self._amp_note,
            "error": self.error,
            # Not part of the contract's `state`: for the server's /health.
            "model": self._model,
        }

    def emit_state(self) -> None:
        self._emit(self.state_event())

    @property
    def tick_s(self) -> float:
        """How long the control thread may sleep on the pipe."""
        return TICK_LOADING_S if self.stream is not None and self._amp[0] == "loading" else TICK_S

    def handle(self, message: dict, drain: Callable[[], Iterator[dict]] | None = None) -> None:
        """One command from the server (a checked message of `protocol.parse_client_message`).
        `drain` gives the commands that are already waiting behind an `open`."""
        kind = message.get("type")
        if kind == "open":
            self.open(message["device"], message["buffer"], drain)
        elif kind == "close":
            self.close()
        elif kind == "reset-stats":
            self._reset_counters()
        elif kind == "preset":
            self._preset = message["preset"]
            self._tone = message["toneOffsets"]
            self._apply_preset()
        elif kind == "master":
            self._master = (float(message["db"]), bool(message["muted"]))
            if self.chain is not None:
                self.chain.set_master(*self._master)
        elif kind == "channel":
            self._channel = message["choice"]
            if self.chain is not None:
                self.chain.set_channel(self._channel)
        elif kind == "trim":
            self._trim = float(message["db"])
            if self.chain is not None:
                self.chain.set_trim(self._trim)
        elif kind == "mains":
            self._mains = int(message["hz"])
            if self.chain is not None:
                self.chain.set_mains(self._mains)
        elif kind == "asset":
            try:
                self.assets.put_user(message["id"], message["kind"], message["data"])
            except ValueError:
                log.debug("asset refused: %s", message.get("id"))
                return
            if self._waiting_asset:
                self._apply_preset()

    def open(self, device: str | None, buffer: int, drain: Callable[[], Iterator[dict]] | None = None) -> None:
        from .chain import Chain

        self._close_stream(fade=True)
        self.status = "starting"
        self.device = device
        self.buffer = int(buffer)
        self.latency_ms = None
        self.error = None
        self._amp = ("idle", None)
        self._amp_note = None
        self._model = None
        self.emit_state()
        try:
            self.backend.refresh()
            self._devices = self._list_devices()
            name = pick_device(self._devices, device)
            with np.errstate(all="ignore"):
                chain = Chain(SAMPLE_RATE, self.buffer, self.assets)
            chain.preload(preload_presets())
            self.chain = chain
            if self._channel is not None:
                chain.set_channel(self._channel)
            if self._master is not None:
                chain.set_master(*self._master)
            chain.set_trim(self._trim)
            chain.set_mains(self._mains)
            # The browser sends its preset, channel and volume right behind `open`: they are
            # in the pipe by now, and are applied before the first sound.
            if drain is not None:
                for message in drain():
                    self.handle(message)
            self._apply_preset()
            chain.wait_idle(15.0)
            self._arm(self.buffer)
            stream = self.backend.open(name, self.buffer, SAMPLE_RATE, self.callback)
            self._in_channels = int(stream.in_channels)
            self._out_channels = int(stream.out_channels)
            self.stream = stream
            # From here on nothing may stop the callback's thread for long: no garbage collector.
            gc.collect()
            gc.freeze()
            gc.disable()
            # A preset that waits for the user's file must not sound as the chain's defaults meanwhile.
            self._gain_target = 0.0 if self._waiting_asset else 1.0
            self._seen_count = 0
            self._seen_at = time.monotonic()
            stream.start()
        except EngineError as error:
            self._fail(error.message)
            return
        except Exception as error:  # noqa: BLE001 — whatever it is, the browser plays instead
            log.debug("open failed", exc_info=True)
            self._fail(message(OPEN_FAILED, reason=reason_of(error)))
            return
        self.status = "running"
        self.device = name
        self.latency_ms = (stream.latency[0] * 1000.0, stream.latency[1] * 1000.0)
        self._amp = chain.amp_state
        self._model = chain.model
        self.emit_state()

    def close(self) -> None:
        """Fades out over 50 ms and lets the card go."""
        self._close_stream(fade=True)
        self.status = "idle"
        self.device = None
        self.buffer = 0
        self.latency_ms = None
        self.error = None
        self._amp = ("idle", None)
        self._amp_note = None
        self._model = None
        self.emit_state()

    def tick(self) -> None:
        """Between commands: the output level for the server, the amp's news, the card's health."""
        stream = self.stream
        chain = self.chain
        if stream is None or chain is None:
            return
        peak, rms = chain.out_levels()
        floats = self.shared.floats
        floats[F_PEAK_DB] = peak
        floats[F_RMS_DB] = rms
        if self.callback_error is not None:
            error = self.callback_error
            self._fail(message(CHAIN_BROKE, reason=reason_of(error)))
            return
        now = time.monotonic()
        count = self._count
        if count != self._seen_count:
            self._seen_count = count
            self._seen_at = now
        if not stream.active or now - self._seen_at > STALL_S:
            self._fail(message(DEVICE_LOST))
            return
        amp = chain.amp_state
        warnings = chain.take_warnings()
        if warnings:
            self._amp_note = warnings[-1]
        if amp != self._amp or warnings or chain.model != self._model:
            self._amp = amp
            self._model = chain.model
            self.emit_state()

    def shutdown(self) -> None:
        self._close_stream(fade=True)

    # --- helpers ---------------------------------------------------------------------------------

    def _apply_preset(self) -> None:
        """Gives the chain the preset the browser wants. While the card is not open yet, the
        preset's own model and cabinet are loaded right here, not in a thread next to the sound."""
        preset = self._preset
        if preset is None:
            return
        missing = [asset for asset in (preset["amp"]["model"], preset["cab"]) if not self.assets.has(asset)]
        if missing:
            # The preset is kept: it is applied when the file arrives.
            self._waiting_asset = True
            for asset in dict.fromkeys(missing):
                self._emit({"ev": "need-asset", "id": asset})
            return
        self._waiting_asset = False
        chain = self.chain
        if chain is None:
            return
        try:
            if self.stream is None:
                chain.preload([preset])
            chain.apply_preset(preset, self._tone)
        except KeyError as error:  # a file that went away between the check and the load
            self._waiting_asset = True
            self._emit({"ev": "need-asset", "id": str(error.args[0]) if error.args else ""})
            return
        except Exception:  # noqa: BLE001 — a preset the chain cannot read changes nothing
            log.debug("preset refused", exc_info=True)
            return
        self._amp_note = None
        if self.stream is not None:
            self._gain_target = 1.0  # it may have been kept silent, waiting for a file
            amp = chain.amp_state
            if amp != self._amp:
                self._amp = amp
                self._model = chain.model
                self.emit_state()

    def _arm(self, block: int) -> None:
        """Everything the callback needs, made before the stream starts."""
        self.block = block
        self._in2 = np.zeros((block, 2), dtype=np.float32)
        self._out2 = np.zeros((block, 2), dtype=np.float32)
        self._ramp = (np.arange(1, block + 1, dtype=np.float32) / np.float32(block)).reshape(block, 1)
        self._env = np.zeros((block, 1), dtype=np.float32)
        self._gain = 0.0
        self._gain_target = 0.0
        self._gain_step = block / (FADE_S * SAMPLE_RATE)
        self._late_ns = int(LATE_PERIODS * block / SAMPLE_RATE * 1e9)
        self._last_entry = 0
        self._judge_from = 0
        self._written = 0
        self._count = 0
        self.callback_error = None
        # Its first blocks are slower (cold caches): let them pass before the card asks.
        silence = np.zeros((block, 2), dtype=np.float32)
        out = np.zeros((block, 2), dtype=np.float32)
        for _ in range(64):
            self.chain.process(silence, out)
        # The rings both processes see, and the callbacks' times: every page of them here and now.
        # The callback walks them a block at a time, and a page it met for the first time could
        # cost it tens of milliseconds when the laptop is short of memory (see `dsp.zeros`).
        self._ring.fill(0)
        self._out_ring.fill(0)
        self._times.fill(0)
        ints = self.shared.ints
        ints[H_WRITTEN] = 0
        ints[H_CALLBACKS] = 0
        self._reset_counters()
        self.shared.floats[:] = SILENCE_DB
        ints[H_EPOCH] += 1

    def _reset_counters(self) -> None:
        ints = self.shared.ints
        ints[H_FLAGS] = 0
        ints[H_LATE] = 0
        ints[H_ODD] = 0
        ints[H_MAX_NS] = 0
        ints[H_MAX_GAP_NS] = 0
        self._max_ns = 0
        self._max_gap_ns = 0

    def _close_stream(self, fade: bool) -> None:
        """Lets the card go. `fade`: the sound goes down over 50 ms first.

        The chain stays in place until the stream is closed: the callback plays through it to
        the last block."""
        stream = self.stream
        chain = self.chain
        if stream is not None:
            if fade and stream.active and self.callback_error is None:
                self._silent_blocks = 0
                self._gain_target = 0.0
                # The callback brings the gain down and then plays silence; two silent blocks
                # later the fade has left the card. A card that stopped calling is not waited for.
                deadline = time.monotonic() + 4 * FADE_S
                while self._silent_blocks < 2 and stream.active and time.monotonic() < deadline:
                    time.sleep(0.002)
            try:
                stream.close()
            except Exception:  # noqa: BLE001 — a card that is gone may not close nicely
                log.debug("the stream did not close cleanly", exc_info=True)
            gc.enable()
            gc.unfreeze()
        # Only now: nothing calls the callback any more.
        self.stream = None
        self.chain = None
        if chain is not None:
            try:
                chain.close()
            except Exception:  # noqa: BLE001
                log.debug("the chain did not close cleanly", exc_info=True)
        if stream is not None:
            gc.collect()
            self.shared.floats[:] = SILENCE_DB

    def _fail(self, error: dict) -> None:
        # Told first: closing a card that was pulled out may take long, or never return.
        self.status = "error"
        self.error = error
        self.latency_ms = None
        self._amp = ("idle", None)
        self._amp_note = None
        self._model = None
        self.emit_state()
        self._close_stream(fade=False)
        devices = self._list_devices()
        if devices != self._devices:
            self._devices = devices
            self.emit_state()


def audio_main(commands: Any, events: Any, shm_name: str, settings: Settings) -> None:
    """The audio process: warm up, then sleep on the pipe until the server wants something."""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    # Ctrl+C in the terminal is for the server: it closes this process properly (with the fade).
    try:
        signal.signal(signal.SIGINT, signal.SIG_IGN)
    except (ValueError, OSError):
        pass
    threading.current_thread().name = "kv-guitar-control"

    def emit(event: dict) -> None:
        events.send(event)

    shared = Shared(shm_name)
    host: AudioHost | None = None
    try:
        try:
            host = AudioHost(settings, shared, emit)
            host.warm_up()
        except Exception as error:  # noqa: BLE001 — told to the server, which tells the browser
            emit({"ev": "fatal", "error": failure(AUDIO_PROCESS_FAILED, error)})
            return
        host.emit_state()
        backlog: deque[dict] = deque()

        def drain() -> Iterator[dict]:
            while commands.poll(0):
                message = commands.recv()
                if message.get("type") in ("open", "close", "quit"):
                    backlog.append(message)
                    return
                yield message

        while True:
            if backlog:
                message = backlog.popleft()
            elif commands.poll(host.tick_s):
                message = commands.recv()
            else:
                message = None
            if message is not None:
                if message.get("type") == "quit":
                    break
                host.handle(message, drain)
            host.tick()
    except (EOFError, OSError):
        pass  # the server is gone: let the card go and leave
    finally:
        if host is not None:
            try:
                host.shutdown()
            except Exception:  # noqa: BLE001
                pass
        shared.close()


# --- the server's side ---------------------------------------------------------------------------


def _idle_state() -> dict:
    return {
        "status": "idle",
        "devices": [],
        "device": None,
        "sample_rate": SAMPLE_RATE,
        "buffer": 0,
        "latency_ms": None,
        "amp_state": "idle",
        "amp_message": None,
        "error": None,
    }


def _finite(value: float, fallback: float = 0.0) -> float:
    value = float(value)
    return value if math.isfinite(value) else fallback


class Core:
    """The engine as the server sees it. Every method returns at once.

    `open`, `close`, `send`, `start`, `shutdown` are for the thread that talks to the browsers;
    `poll`, `read_input`, `stats` for the one that pumps the audio. `state` is for both.
    """

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._shared = Shared()
        self._reader = InputReader(self._shared)
        self._lock = threading.RLock()
        self._state = _idle_state()
        self._process: Any = None
        self._commands: Any = None
        self._events: Any = None
        self._dead = False
        self._outbox: queue.SimpleQueue = queue.SimpleQueue()
        self._sender: threading.Thread | None = None
        self._closed = False
        #: How many times the audio process was started.
        self.starts = 0
        #: The id of the amp model that plays (for /health; not in the contract's `state`).
        self.model: str | None = None

    # --- the audio process -------------------------------------------------------------------------

    @property
    def alive(self) -> bool:
        process = self._process
        return process is not None and process.is_alive()

    @property
    def pid(self) -> int | None:
        process = self._process
        return process.pid if process is not None else None

    def start(self) -> None:
        """Starts the audio process, or a new one when the old one died."""
        with self._lock:
            # `_dead`: its pipe closed (or it said it cannot work) — it may take a moment to be gone.
            if self._closed or (self.alive and not self._dead):
                return
            self._drop_process()
            context = multiprocessing.get_context("spawn")
            commands_in, commands_out = context.Pipe(duplex=False)
            events_in, events_out = context.Pipe(duplex=False)
            process = context.Process(
                target=audio_main,
                args=(commands_in, events_out, self._shared.name, self.settings),
                name="kv-guitar-audio",
                daemon=True,
            )
            process.start()
            # Our copies of the far ends: closed, so a dead process shows as a closed pipe.
            commands_in.close()
            events_out.close()
            self._process = process
            self._commands = commands_out
            self._events = events_in
            self._dead = False
            self.starts += 1
            devices = self._state["devices"]
            self._state = {**_idle_state(), "devices": devices}
            if self._sender is None:
                self._sender = threading.Thread(target=self._send_loop, name="kv-guitar-commands", daemon=True)
                self._sender.start()

    def _drop_process(self) -> None:
        process, self._process = self._process, None
        for conn in (self._commands, self._events):
            if conn is not None:
                try:
                    conn.close()
                except OSError:
                    pass
        self._commands = self._events = None
        if process is not None:
            if process.is_alive():
                process.kill()
            process.join(2.0)

    def _send_loop(self) -> None:
        # A thread of its own: a big file (a user's model) must not hold the server while the
        # audio process is busy opening the card.
        while True:
            item = self._outbox.get()
            if item is None:
                return
            conn, message = item
            try:
                conn.send(message)
            except (OSError, ValueError):
                pass  # that process is gone; `poll` tells

    def send(self, message: dict) -> None:
        """A command for the audio process (dropped while there is none)."""
        with self._lock:
            conn = self._commands
            if conn is not None and not self._dead:
                self._outbox.put((conn, message))

    def open(self, device: str | None, buffer: int) -> None:
        """Opens the card (again). Starts a new audio process when the old one died. The xruns
        count starts from zero."""
        with self._lock:
            self.start()
            self._state = {
                **self._state,
                "status": "starting",
                "device": device,
                "buffer": int(buffer),
                "latency_ms": None,
                "error": None,
            }
            self.send({"type": "open", "device": device, "buffer": int(buffer)})

    def reset_stats(self) -> None:
        self.send({"type": "reset-stats"})

    def close(self) -> None:
        self.send({"type": "close"})

    def shutdown(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            process = self._process
            self.send({"type": "quit"})
        if process is not None:
            process.join(3.0)
        self._outbox.put(None)
        with self._lock:
            self._drop_process()
            self._shared.close()

    # --- reading -----------------------------------------------------------------------------------

    def poll(self) -> list[dict]:
        """What happened since the last call: {'ev': 'state'} (read it with `state()`) and
        {'ev': 'need-asset', 'id': ...}."""
        found: list[dict] = []
        with self._lock:
            if self._closed:
                return found
            conn = self._events
            lost = False
            if conn is not None:
                try:
                    while conn.poll(0):
                        found.append(conn.recv())
                except (EOFError, OSError):
                    lost = True
            process = self._process
            if process is not None and not process.is_alive():
                lost = True
            events: list[dict] = []
            for event in found:
                kind = event.get("ev")
                if kind == "state":
                    self._state = {key: event[key] for key in self._state}
                    self.model = event.get("model")
                    events.append({"ev": "state"})
                elif kind == "fatal":
                    self._dead = True
                    self._state = {**_idle_state(), "status": "error", "error": event.get("error")}
                    events.append({"ev": "state"})
                elif kind == "need-asset":
                    events.append({"ev": "need-asset", "id": str(event.get("id"))})
            if lost and not self._dead:
                self._dead = True
                self._state = {**_idle_state(), "status": "error", "error": message(AUDIO_PROCESS_DIED)}
                events.append({"ev": "state"})
            return events

    def state(self) -> dict:
        """The fields of `protocol.state_message`."""
        with self._lock:
            return dict(self._state)

    def read_input(self, max_frames: int = FRAME) -> tuple[int, np.ndarray] | None:
        """The next `max_frames` frames of raw input as (frame0, (max_frames, 2) float32), or None
        when that many are not there yet. Never waits."""
        with self._lock:
            if self._closed:
                return None
            return self._reader.read(max_frames)

    def read_both(self, max_frames: int = FRAME) -> tuple[int, np.ndarray, np.ndarray] | None:
        """Like `read_input`, plus what the card played for the same frames (for «Запись»)."""
        with self._lock:
            if self._closed:
                return None
            return self._reader.read_both(max_frames)

    def counters(self) -> dict:
        with self._lock:
            if self._closed:
                return {"flags": 0, "late": 0, "odd": 0, "callbacks": 0, "skipped": 0, "max_gap_ms": 0.0}
            ints = self._shared.ints
            return {
                "flags": int(ints[H_FLAGS]),
                "late": int(ints[H_LATE]),
                "odd": int(ints[H_ODD]),
                "callbacks": int(ints[H_CALLBACKS]),
                "skipped": self._reader.skipped,
                "max_gap_ms": int(ints[H_MAX_GAP_NS]) / 1e6,
            }

    def stats(self) -> dict:
        """The numbers of `protocol.stats_message`, all finite: zeros before the first callback.

        `xruns` = what the driver flagged + late callbacks (the driver's flags alone missed a
        9.6 ms gap in the probe). p50 / p99 are of the last second, `max_ms` since `open`.
        """
        with self._lock:
            buffer = int(self._state["buffer"])
            empty = {
                "xruns": 0,
                "budget_ms": buffer / SAMPLE_RATE * 1000.0,
                "p50": 0.0,
                "p99": 0.0,
                "max_ms": 0.0,
                "out_peak_db": SILENCE_DB,
                "out_rms_db": SILENCE_DB,
            }
            if self._closed or self._state["status"] != "running" or buffer <= 0:
                return empty
            ints = self._shared.ints
            count = int(ints[H_CALLBACKS])
            take = min(count, TIMES, math.ceil(SAMPLE_RATE / buffer))
            if take <= 0:
                return empty
            index = (count - take + np.arange(take)) & (TIMES - 1)
            times_ms = self._shared.times[index] / 1e6
            p50, p99 = np.percentile(times_ms, (50, 99))
            floats = self._shared.floats
            return {
                "xruns": int(ints[H_FLAGS]) + int(ints[H_LATE]) + int(ints[H_ODD]),
                "budget_ms": empty["budget_ms"],
                "p50": _finite(p50),
                "p99": _finite(p99),
                "max_ms": _finite(int(ints[H_MAX_NS]) / 1e6),
                "out_peak_db": _finite(floats[F_PEAK_DB], SILENCE_DB),
                "out_rms_db": _finite(floats[F_RMS_DB], SILENCE_DB),
            }
