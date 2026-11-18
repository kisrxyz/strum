"""A sound card that is not there: `KV_GUITAR_FAKE=saw` or `KV_GUITAR_FAKE=<path to a .wav>`.

The fake calls the engine's audio callback exactly as PortAudio does — callback(indata, outdata,
frames, time, status), one block per block time — from a thread of its own, and throws the output
away. Tests and browser checks without a guitar run on it.

It offers three «cards»:

- `Fake M-Track` works;
- `Fake 44100` refuses 48 000 Hz, like a card whose driver is locked to another rate;
- `Fake lost` works for half a second and then goes away, like a pulled USB cable.
"""

from __future__ import annotations

import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path

import numpy as np

from .assets import resample
from .config import DEVICE_NOT_FOUND, OPEN_FAILED, RATE_ERROR, EngineError

FAKE_GOOD = "Fake M-Track"
FAKE_44100 = "Fake 44100"
FAKE_LOST = "Fake lost"
FAKE_DEVICES = (FAKE_GOOD, FAKE_44100, FAKE_LOST)
# `Fake lost` goes away after this long.
LOST_AFTER_S = 0.5

SAW_HZ = 110.0
SAW_EVERY_S = 2.0
SAW_PEAK_DB = -9.0
# The last stretch before a block is due is spun, not slept. It is longer than a tick of the Windows
# timer (15.6 ms): a sleep of a fraction of a millisecond now and then ends a whole tick late
# (measured 2026-11-16: 4 times in 40 s, each counted by the engine as a late callback — a fault of
# this fake, not of the engine: a real card is driven by its hardware, not by a sleep). So at the
# block sizes the engine uses (2.7 … 5.3 ms) the fake never sleeps at all: one core spins.
_SPIN_S = 0.020
# Further behind than this (the laptop slept), the fake starts its clock again instead of racing.
_RESYNC_S = 0.25


def saw_loop(sample_rate: int) -> np.ndarray:
    """One pluck of a 110 Hz sawtooth, 2 s long, peaking at −9 dBFS, on the right channel —
    where the guitar is on the cards we know (input 2). Shape (frames, 2)."""
    count = int(SAW_EVERY_S * sample_rate)
    t = np.arange(count) / sample_rate
    saw = 2 * ((t * SAW_HZ) % 1.0) - 1
    envelope = 0.75 * np.exp(-40 * t) + 0.25 * np.exp(-2 * t)
    mono = saw * envelope
    mono *= 10 ** (SAW_PEAK_DB / 20) / np.max(np.abs(mono))
    stereo = np.zeros((count, 2), dtype=np.float32)
    stereo[:, 1] = mono
    return stereo


def wav_loop(path: Path, sample_rate: int) -> np.ndarray:
    """A recording as (frames, 2) at the engine's rate. A mono file goes to the right channel."""
    import soundfile as sf

    try:
        data, rate = sf.read(str(path), dtype="float32", always_2d=True)
    except Exception as error:  # noqa: BLE001 — a missing or broken file: one message
        raise EngineError(OPEN_FAILED, reason=f"KV_GUITAR_FAKE: cannot read {path} ({error})") from error
    if not len(data):
        raise EngineError(OPEN_FAILED, reason=f"KV_GUITAR_FAKE: no sound in {path}")
    if data.shape[1] == 1:
        data = np.concatenate([np.zeros_like(data), data], axis=1)
    data = data[:, :2]
    if rate != sample_rate:
        data = np.stack([resample(data[:, c], rate, sample_rate) for c in range(2)], axis=1)
    return np.ascontiguousarray(data, dtype=np.float32)


def source_loop(source: str, sample_rate: int) -> np.ndarray:
    return saw_loop(sample_rate) if source == "saw" else wav_loop(Path(source), sample_rate)


def _like_a_driver_thread() -> None:
    """An ASIO driver calls from a thread the system puts first. Without that the fake's blocks
    come up to a millisecond late on a busy laptop — and now and then much later — which the
    engine would rightly count as dropouts."""
    if sys.platform != "win32":
        return
    try:
        import ctypes

        kernel = ctypes.windll.kernel32
        kernel.GetCurrentThread.restype = ctypes.c_void_p
        kernel.SetThreadPriority(ctypes.c_void_p(kernel.GetCurrentThread()), 15)  # THREAD_PRIORITY_TIME_CRITICAL
    except Exception:  # noqa: BLE001 — only a nicety
        pass


class FakeStream:
    """What the engine uses of `sounddevice.Stream`: start, close, active, latency."""

    in_channels = 2
    out_channels = 2

    def __init__(
        self,
        loop: np.ndarray,
        block: int,
        sample_rate: int,
        callback: Callable,
        lose_after_s: float | None = None,
    ) -> None:
        self.block = block
        self.sample_rate = sample_rate
        self.latency = (block / sample_rate, block / sample_rate)
        self.closed = False
        #: Tests set this to a list to get a copy of every block the engine played.
        self.heard: list[np.ndarray] | None = None
        self._callback = callback
        self._lose_after = None if lose_after_s is None else max(1, int(lose_after_s * sample_rate / block))
        # The loop with its first block once more at the end: a block never has to wrap.
        self._frames = len(loop)
        self._loop = np.concatenate([loop, loop[np.arange(block) % len(loop)]])
        self._loop.setflags(write=False)
        self._out = np.zeros((block, 2), dtype=np.float32)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._active = False

    @property
    def active(self) -> bool:
        return self._active

    def start(self) -> None:
        if self._thread is not None:
            return
        self._active = True
        self._thread = threading.Thread(target=self._run, name="kv-fake-audio", daemon=True)
        self._thread.start()

    def close(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(2.0)
        self._active = False
        self.closed = True

    def _run(self) -> None:
        block = self.block
        period = block / self.sample_rate
        loop = self._loop
        out = self._out
        at = 0
        done = 0
        _like_a_driver_thread()
        started = time.perf_counter()
        try:
            while not self._stop.is_set():
                self._callback(loop[at : at + block], out, block, None, None)
                if self.heard is not None:
                    self.heard.append(out.copy())
                at = (at + block) % self._frames
                done += 1
                if self._lose_after is not None and done >= self._lose_after:
                    return  # the «cable» is out: no more callbacks, and the stream says so
                due = started + done * period
                wait = due - time.perf_counter()
                if wait < -_RESYNC_S:
                    started -= wait
                    continue
                if wait > _SPIN_S:
                    time.sleep(wait - _SPIN_S)
                while time.perf_counter() < due:
                    time.sleep(0)
        finally:
            self._active = False


class FakeBackend:
    """The fake cards (see the module's text). `streams` keeps every stream that was opened."""

    def __init__(self, source: str = "saw") -> None:
        self.source = source
        self._loops: dict[int, np.ndarray] = {}
        self.streams: list[FakeStream] = []

    def refresh(self) -> None:
        pass

    def devices(self) -> list[str]:
        return list(FAKE_DEVICES)

    def open(self, name: str, block: int, sample_rate: int, callback: Callable) -> FakeStream:
        if name not in FAKE_DEVICES:
            raise EngineError(DEVICE_NOT_FOUND, name=name)
        if name == FAKE_44100:
            raise EngineError(RATE_ERROR)
        loop = self._loops.get(sample_rate)
        if loop is None:
            loop = self._loops[sample_rate] = source_loop(self.source, sample_rate)
        stream = FakeStream(loop, block, sample_rate, callback, LOST_AFTER_S if name == FAKE_LOST else None)
        self.streams.append(stream)
        del self.streams[:-8]
        return stream
