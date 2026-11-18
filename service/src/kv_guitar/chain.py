"""The whole amp chain, as the browser builds it (`buildGraph` in src/audio/engine.ts):

    input → channel pick → hum filter → gate → drive → amp (NAM / simple) → EQ → cabinet → chorus → delay
          → reverb → preset level → master → soft clip → output

Three kinds of callers:

- the audio thread calls `process` for every block. It allocates nothing, takes no lock, and
  picks finished loads up from a queue (`deque.popleft`, which never waits);
- the control thread calls `apply_preset`, `set_master`, `set_channel`: they write the targets
  the kernels glide to (τ = 30 ms, like `setTargetAtTime`) and return at once;
- a loader thread, alive only while something is loading, reads the model or impulse response,
  builds the new amp / cabinet / reverb and hands it over. The audio thread fades it in: a new
  cabinet crossfades with the old one (τ = 20 ms, as `SwapSlot`); a new amp model waits for the
  old one to fade out (10 ms) and then fades in (10 ms); a new reverb waits for the old one's
  return to fade out (τ = 20 ms, to −40 dB) and then fades in. Two amp models or two reverbs never
  run at once: each is too much work to double inside one block.
  While it loads (about 0.1 s for a preset with another model, cabinet and reverb) the audio
  thread's blocks get slower, by about half a millisecond each: the two threads share one
  interpreter. Nothing is loaded when only knobs change, nor for a model, cabinet or reverb that was used
  before (or given to `preload`): amp models stay loaded while they do not play, and a cabinet or
  reverb is copied from a ready one in the control thread. Pedal switching between the built-in
  presets therefore never starts the loader.

Every load has a token, as in `AmpSlot.setModel`: a load that was overtaken is dropped.
"""

from __future__ import annotations

import threading
import time
from collections import OrderedDict, deque
from pathlib import Path

import numpy as np

from kv_service.messages import UserError, failure

from . import dsp, reverb
from .assets import USER_IR_GONE, USER_MODEL_GONE, AssetStore, nam_wasm_path
from .irgain import db_to_lin, ir_in_band_gain_db
from .nam_wasm import NamWasm
from .reverb import CabinetConvolver, ReverbConvolver, convolver_normalization

# `OUTPUT_TRIM_DB` in src/audio/engine.ts.
OUTPUT_TRIM_DB = 0.0  # 3.0 until 2026-11-16 (see engine.ts)
# `SLIM_SIZE` in src/audio/amp.ts.
SLIM_SIZE = 0.3
# The ids of src/audio/assets.ts.
SIMPLE_AMP = "simple"
NO_CAB = "none"
REVERB_IR = {"spring": "ir:spring", "plate": "ir:plate"}
# A new amp model: the old one fades out over this long, then the new one fades in. Not a
# crossfade: two models at once are twice the amp's work, more than one block has room for.
MODEL_FADE_S = 0.01
# `SwapSlot` drops the old cabinet / reverb this long after the swap.
SWAP_DROP_S = 0.2

# The messages of src/audio/amp.ts and src/audio/engine.ts, as codes (kv_service.messages); each
# takes the failure's `reason`. A failure that has its own message (a missing file) says that one.
MODEL_FAILED = "amp.modelFailed"
NAM_UNAVAILABLE = "amp.engineFailed"
CAB_FAILED = "amp.cabFailed"
REVERB_FAILED = "amp.reverbFailed"

_KINDS = ("cab", "model", "reverb")
# Amp models kept loaded while they do not play, and cabinets / reverbs kept ready to copy:
# going back to a preset that was used before loads nothing.
MODEL_CACHE = 6
IR_CACHE = 8
# A model that played remembers this much of the guitar (measured: up to 6 400 samples on the
# built-in models): before it plays again, it is run on this much silence.
MODEL_MEMORY_SAMPLES = 8192
# A second cabinet or reverb swap waits until the one before it has faded this far (−40 dB).
_SWAP_BUSY = 0.01
# The cabinet's big transforms run this many blocks away from the reverb's (see `align`).
_CAB_PHASE = 10


class Chain:
    def __init__(self, sample_rate: int, block: int, assets: AssetStore, wasm_path: Path | None = None) -> None:
        dsp.warm_up()
        reverb.warm_up(int(block))
        self.sample_rate = int(sample_rate)
        self.block = int(block)
        self.assets = assets
        self._wasm_path = Path(wasm_path) if wasm_path is not None else nam_wasm_path()

        self._pick = dsp.ChannelPick(sample_rate)
        self._channel = "both"  # as `ChannelPick` starts
        self._trim = dsp.InputTrim(sample_rate)
        self._hum = dsp.HumFilter(sample_rate)
        self._gate = dsp.GateCore(sample_rate, -60.0)
        self._drive = dsp.Drive(sample_rate)
        self._simple = dsp.SimpleAmp(sample_rate)
        self._simple_was_live = True
        self._eq = dsp.Eq(sample_rate)
        self._cab_swap = dsp.SwapGains(sample_rate)
        self._fx = dsp.PostFx(sample_rate)
        self._rv_return = dsp.reverb_return(sample_rate)
        self._output = dsp.Output(sample_rate, block)

        def mono() -> np.ndarray:
            return np.zeros(block, dtype=np.float32)

        def planar() -> np.ndarray:
            return np.zeros((2, block), dtype=np.float32)

        self._in = np.zeros((block, 2), dtype=np.float32)
        self._out = np.zeros((block, 2), dtype=np.float32)
        self._mono = mono()
        self._nam_in = mono()
        self._simple_in = mono()
        self._simple_out = mono()
        self._work = mono()
        # The convolvers take (channels, block): the same memory, seen as one row.
        self._work_row = self._work.reshape(1, block)
        self._cab_new_buf = np.zeros((1, block), dtype=np.float32)
        self._cab_old_buf = np.zeros((1, block), dtype=np.float32)
        self._post = planar()
        self._send = planar()
        self._wet = planar()

        # What plays now; only the audio thread touches these.
        self._nam: NamWasm | None = None
        self._nam_next: NamWasm | None = None
        self._nam_gain = 1.0
        # Per sample: negative while the old model fades out, positive while the new one fades in.
        self._nam_step = 0.0
        self._nam_fade_step = 1.0 / max(1, round(MODEL_FADE_S * sample_rate))
        self._cab: CabinetConvolver | None = None
        self._cab_old: CabinetConvolver | None = None
        self._cab_fading = False
        self._cab_old_left = 0
        self._rv: ReverbConvolver | None = None
        # A swap that arrived while the one before it was still fading: (thing,) or None.
        self._cab_wait: tuple | None = None
        self._rv_wait: tuple | None = None
        self._drop_blocks = -(-round(SWAP_DROP_S * sample_rate) // block)
        # Blocks played: new convolvers line their big transforms up against it.
        self._blocks = 0

        # Loader / control → audio, and what the audio thread is done with, for others to free.
        self._inbox: deque = deque()
        self._outbox: deque = deque()

        # Control and loader threads only, under the lock.
        self._lock = threading.Lock()
        self._tokens = dict.fromkeys(_KINDS, 0)
        self._jobs: dict[str, tuple] = {}
        self._loader: threading.Thread | None = None
        self._applied: dict | None = None
        self._amp_state: tuple[str, dict | None] = ("idle", None)
        self._model: str | None = None
        self._warnings: deque[dict] = deque()
        self._closed = False
        # Idle amp models by (id, slim, revision), least recently used first.
        self._models: OrderedDict[tuple, NamWasm] = OrderedDict()
        # Ready convolvers by (kind, id, revision). They never play: every use is a `clone()`.
        self._irs: OrderedDict[tuple, CabinetConvolver | ReverbConvolver] = OrderedDict()
        #: How many models / cabinets / reverbs were really loaded (read from disk and built).
        self.loads = dict.fromkeys(_KINDS, 0)

        # Is the NAM engine there at all? (Also compiles it, once per process.)
        self._nam_error: dict | None = None  # the message that says why not
        try:
            NamWasm(self._wasm_path, self.sample_rate, self.block).close()
        except Exception as error:  # noqa: BLE001 — whatever it is, the simple amp plays
            self._nam_error = failure(NAM_UNAVAILABLE, error)

    # --- the audio thread ----------------------------------------------------------------------

    def process(self, inp: np.ndarray, out: np.ndarray) -> None:
        """One block: `inp` and `out` are (block, 2) float32."""
        if self._inbox:
            self._take_inbox()
        if self._cab_wait is not None and not self._swap_busy(self._cab_swap, self._cab_old_left):
            self._swap_cab(self._cab_wait[0])
            self._cab_wait = None
        if self._rv_wait is not None and (self._rv is None or self._rv_return[0] <= _SWAP_BUSY):
            # The old reverb's return has faded out: the new one takes its place and fades in.
            if self._rv is not None:
                self._outbox.append(self._rv)
            self._rv = self._rv_wait[0]
            self._rv.align(self._blocks)
            self._rv_wait = None
            self._rv_return[1] = 1.0
        self._blocks += 1
        work = self._work
        np.copyto(self._in, inp)
        self._pick.process(self._in, self._mono)
        self._trim.process(self._mono)
        self._hum.process(self._mono, self._mono)
        self._gate.process(self._mono, self._mono)
        drive = self._drive
        nam_in = self._nam_in
        drive.process(self._mono, nam_in, self._simple_in)

        # The amp: NAM, the simple one, or both while one fades into the other.
        nam = self._nam
        nam_live = nam is not None and drive.nam_live
        if nam_live:
            try:
                nam.process(nam_in)
            except Exception as error:  # noqa: BLE001 — a broken amp must not stop the sound
                self._nam_broke(error)
                nam_live = False
            step = self._nam_step
            if step != 0.0 and nam_live:
                gain = self._nam_gain = dsp.ramp(nam_in, self._nam_gain, step)
                if gain <= 0.0 and self._nam_next is not None:
                    # Silent: the next model takes the old one's place and fades in.
                    self._outbox.append(nam)
                    self._nam = self._nam_next
                    self._nam_next = None
                    self._nam_step = self._nam_fade_step
                elif gain >= 1.0:
                    self._nam_step = 0.0
        elif nam is not None:
            # Faded out behind the simple amp: let the model go, it only costs CPU.
            self._outbox.append(nam)
            self._nam = self._nam_next
            self._nam_next = None
            self._nam_gain = 1.0
            self._nam_step = 0.0
        simple_live = drive.simple_live
        if simple_live:
            self._simple.process(self._simple_in, self._simple_out)
            self._simple_was_live = True
            if nam_live:
                dsp.add_into(nam_in, self._simple_out)
                amp_out = nam_in
            else:
                amp_out = self._simple_out
        else:
            if self._simple_was_live:
                self._simple_was_live = False
                self._simple.reset()
            if not nam_live:
                nam_in.fill(0)
            amp_out = nam_in
        self._eq.process(amp_out, work)

        # The cabinet, or two of them while one fades into the other.
        cab = self._cab
        row = self._work_row
        if self._cab_fading:
            new_buf = self._cab_new_buf
            old_buf = self._cab_old_buf
            old = self._cab_old
            if old is not None:
                old.process(row, old_buf)
            else:
                np.copyto(old_buf, row)
            if cab is not None:
                cab.process(row, new_buf)
            else:
                np.copyto(new_buf, row)
            self._cab_swap.mix(new_buf[0], old_buf[0], work)
            if self._cab_old_left > 0:
                self._cab_old_left -= 1
                if self._cab_old_left == 0:
                    if old is not None:
                        self._outbox.append(old)
                        self._cab_old = None
                    self._cab_swap.s[1] = 0.0
            elif self._cab_swap.settled:
                self._cab_fading = False
        elif cab is not None:
            cab.process(row, row)

        peak = self._fx.process(work, self._post, self._send)

        wets = 0
        rv = self._rv
        if rv is not None:
            rv.process(self._send, self._wet, peak == 0.0)
            wets = 1
        self._output.process(self._post, self._wet, wets, self._rv_return, self._out)
        np.copyto(out, self._out)

    def _take_inbox(self) -> None:
        inbox = self._inbox
        while inbox:
            kind, thing = inbox.popleft()
            if kind == "nam":
                if self._nam is not None and self._drive.nam_live:
                    # One is playing: it fades out first.
                    if self._nam_next is not None:
                        self._outbox.append(self._nam_next)
                    self._nam_next = thing
                    self._nam_step = -self._nam_fade_step
                else:
                    if self._nam is not None:
                        self._outbox.append(self._nam)
                    self._nam = thing
                    self._nam_gain = 1.0
                    self._nam_step = 0.0
                self._drive.route(True)
            elif kind == "simple":
                self._drive.route(False)
            elif kind == "cab":
                if self._swap_busy(self._cab_swap, self._cab_old_left):
                    if self._cab_wait is not None and self._cab_wait[0] is not None:
                        self._outbox.append(self._cab_wait[0])
                    self._cab_wait = (thing,)  # the newest one waiting wins
                else:
                    self._cab_wait = None
                    self._swap_cab(thing)
            elif kind == "reverb":
                if self._rv_wait is not None:
                    self._outbox.append(self._rv_wait[0])  # the newest one waiting wins
                self._rv_wait = (thing,)
                self._rv_return[1] = 0.0

    @staticmethod
    def _swap_busy(swap: dsp.SwapGains, old_left: int) -> bool:
        """The side that is fading out is still heard: swapping now would cut it off with a click."""
        return old_left > 0 and swap.s[1] > _SWAP_BUSY

    def _swap_cab(self, thing: CabinetConvolver | None) -> None:
        if self._cab_old is not None:
            self._outbox.append(self._cab_old)
        self._cab_old = self._cab
        self._cab = thing
        if thing is not None:
            thing.align(self._blocks + _CAB_PHASE)
        self._cab_swap.swap()
        self._cab_old_left = self._drop_blocks
        self._cab_fading = True

    def _nam_broke(self, error: BaseException) -> None:
        """The amp model failed while playing: the simple amp takes over, at once."""
        if self._nam is not None:
            self._nam.kv_broken = True  # never played again: `_free` closes it
        for nam in (self._nam, self._nam_next):
            if nam is not None:
                self._outbox.append(nam)
        self._nam = None
        self._nam_next = None
        self._nam_gain = 1.0
        self._nam_step = 0.0
        self._nam_in.fill(0)
        self._drive.route(False)
        self._drive.s[2] = 0.0
        self._drive.s[4] = 1.0
        self._amp_state = ("fallback", failure(MODEL_FAILED, error))

    # --- the control thread ----------------------------------------------------------------------

    def set_channel(self, choice: str) -> None:
        """'left', 'right' or 'both' (the two halves summed)."""
        self._pick.set(choice)
        # The pick is made on the first note: from both halves to the guitar's side everything
        # gets twice as loud, the noise too — the gate's learned floor moves with it.
        step = dsp.channel_step(self._channel, choice)
        self._channel = choice
        if step != 1.0:
            self._gate.scale_floor(step)

    def set_master(self, db: float, muted: bool) -> None:
        self._output.set_master(db, muted)

    def set_trim(self, db: float) -> None:
        """«Подстроить под мою гитару»: the input's own gain, dB, before the hum filter, the gate and
        the amp — the amps then get the level they were levelled for."""
        self._trim.set(db)

    def set_mains(self, hz: float) -> None:
        """The mains the hum filter notches: 50 or 60 Hz (src/dsp/mains.ts). Anything else is ignored."""
        if hz in (50, 60):
            self._hum.set_mains(float(hz))

    def apply_preset(self, preset: dict, tone_offsets: dict | None = None) -> None:
        """Applies a preset (the browser's `Preset`) and «Звук как в песне»'s EQ offsets.

        The knobs start gliding at once. The model, the cabinet and the reverb are loaded in the
        background, and only when they changed. Raises KeyError(id) — before doing anything — when
        the preset needs a 'user:' file that was not sent yet: send it (`assets.put_user`) and
        apply the preset again.
        """
        self._free()
        amp = preset["amp"]
        for asset_id in (amp["model"], preset["cab"]):
            if not self.assets.has(asset_id):
                raise KeyError(asset_id)
        reverb = preset["reverb"]
        if reverb["type"] not in REVERB_IR:
            raise ValueError(f"unknown reverb: {reverb['type']}")
        prev = self._applied
        self._applied = {
            "model": amp["model"],
            "slim": bool(amp["slim"]),
            "cab": preset["cab"],
            "reverb": reverb["type"],
        }

        tone = tone_offsets or {}
        # A preset from before the hum filter has no field: off, as it was then.
        self._hum.set_on(bool(amp.get("hum", False)))
        # Nor one from before «Шумодав сам»: the threshold alone, as it was.
        self._gate.set_auto(bool(amp.get("gateAuto", False)))
        self._gate.set_threshold(amp["gateDb"])
        self._drive.set_drive(amp["inputDb"])
        self._eq.set(
            amp["bass"] + tone.get("bass", 0.0), amp["mid"] + tone.get("mid", 0.0), amp["treble"] + tone.get("treble", 0.0)
        )
        chorus = preset["chorus"]
        self._fx.set_chorus(chorus["on"], chorus["rate"], chorus["depth"], chorus["mix"])
        delay = preset["delay"]
        self._fx.set_delay(delay["on"], delay["timeMs"], delay["feedback"], delay["mix"])
        self._fx.set_reverb(reverb["on"], reverb["mix"])
        self._output.set_level(amp["levelDb"] + OUTPUT_TRIM_DB)

        now = self._applied
        if prev is None or prev["model"] != now["model"] or prev["slim"] != now["slim"]:
            kept = None if now["model"] == SIMPLE_AMP else self._take_model(now["model"], now["slim"])
            if now["model"] == SIMPLE_AMP:
                self._post_now("model", ("simple", None), ("ready", None), SIMPLE_AMP)
            elif kept is not None:
                self._settle(kept)
                self._post_now("model", ("nam", kept), ("ready", None), now["model"])
            else:
                self._request("model", (now["model"], now["slim"]))
        if prev is None or prev["cab"] != now["cab"]:
            ready = None if now["cab"] == NO_CAB else self._ready_ir("cab", now["cab"])
            if now["cab"] == NO_CAB:
                self._post_now("cab", ("cab", None))
            elif ready is not None:
                self._post_now("cab", ("cab", ready.clone()))
            else:
                self._request("cab", (now["cab"],))
        if prev is None or prev["reverb"] != now["reverb"]:
            ready = self._ready_ir("reverb", now["reverb"])
            if ready is not None:
                self._post_now("reverb", ("reverb", ready.clone()))
            else:
                self._request("reverb", (now["reverb"],))

    def preload(self, presets: list[dict]) -> None:
        """Loads the models, cabinets and reverbs of these presets now, in this thread, and keeps
        them: applying any of them later loads nothing. Call it before the stream opens (it takes
        about 0.1 s a preset). What cannot be loaded is skipped: applying that preset will say why.
        """
        for preset in presets:
            amp = preset["amp"]
            model, slim, cab, reverb = amp["model"], bool(amp["slim"]), preset["cab"], preset["reverb"]["type"]
            try:
                if model != SIMPLE_AMP and not self._nam_error and self._model_key(model, slim) not in self._models:
                    self._keep_model(self._build_model(model, slim))
            except Exception:  # noqa: BLE001
                pass
            for kind, asset_id in (("cab", cab), ("reverb", reverb)):
                try:
                    if asset_id != NO_CAB and self._ready_ir(kind, asset_id) is None:
                        self._build_ir(kind, asset_id)
                except Exception:  # noqa: BLE001
                    pass

    @property
    def amp_state(self) -> tuple[str, dict | None]:
        """('idle' | 'loading' | 'ready' | 'fallback', the message of a fallback)."""
        return self._amp_state

    @property
    def model(self) -> str | None:
        """The id of the model that was loaded last ('simple' for the simple amp)."""
        return self._model

    def out_levels(self) -> tuple[float, float]:
        """(peak, RMS) of the output's last 100 ms, dBFS."""
        return self._output.levels()

    def take_warnings(self) -> list[dict]:
        """Messages about a cabinet or reverb that did not load, each given once."""
        found = []
        while self._warnings:
            found.append(self._warnings.popleft())
        return found

    def wait_idle(self, timeout: float | None = None) -> bool:
        """Waits for the loads in flight. False when the time ran out."""
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            with self._lock:
                loader = self._loader
                if loader is None:
                    return not self._jobs
            left = None if deadline is None else deadline - time.monotonic()
            if left is not None and left <= 0:
                return False
            loader.join(left)

    def close(self) -> None:
        """Stops loading and lets the amps go. The stream must be closed already."""
        with self._lock:
            self._closed = True
            self._jobs.clear()
            for kind in _KINDS:
                self._tokens[kind] += 1
        self.wait_idle(10.0)
        self._inbox.clear()
        for nam in (self._nam, self._nam_next):
            if nam is not None:
                nam.close()
        self._nam = self._nam_next = None
        self._free()
        with self._lock:
            for nam in self._models.values():
                nam.close()
            self._models.clear()
            self._irs.clear()

    # --- loading ---------------------------------------------------------------------------------

    def _free(self) -> None:
        """Takes back what the audio thread no longer plays: amp models are kept for the next time."""
        outbox = self._outbox
        while outbox:
            thing = outbox.popleft()
            if isinstance(thing, NamWasm):
                if getattr(thing, "kv_broken", False):
                    thing.close()  # it failed while playing
                else:
                    thing.kv_played = True
                    self._keep_model(thing)

    def _settle(self, nam: NamWasm) -> None:
        """A kept model that played still holds the end of what it played. Silence through it
        (about 35 ms of work, here in the control thread; the engine's call does not hold the
        interpreter) lets it start clean, as a new model does."""
        if not getattr(nam, "kv_played", False):
            return
        silence = np.zeros(self.block, dtype=np.float32)
        try:
            for _ in range(-(-MODEL_MEMORY_SAMPLES // self.block)):
                silence.fill(0)
                nam.process(silence)
        except Exception:  # noqa: BLE001 — if it is broken, the audio thread finds out and falls back
            pass
        nam.kv_played = False

    def _model_key(self, model_id: str, slim: bool) -> tuple:
        return (model_id, bool(slim), self.assets.revision(model_id))

    def _keep_model(self, nam: NamWasm) -> None:
        """An amp model that is not playing: kept loaded, the least recently used ones let go."""
        key = getattr(nam, "kv_key", None)
        drop = []
        with self._lock:
            if self._closed or key is None or key in self._models or key != self._model_key(key[0], key[1]):
                drop.append(nam)
            else:
                self._models[key] = nam
                while len(self._models) > MODEL_CACHE:
                    drop.append(self._models.popitem(last=False)[1])
        for old in drop:
            old.close()

    def _take_model(self, model_id: str, slim: bool) -> NamWasm | None:
        with self._lock:
            return self._models.pop(self._model_key(model_id, slim), None)

    def _ir_key(self, kind: str, asset_id: str) -> tuple:
        file_id = REVERB_IR[asset_id] if kind == "reverb" else asset_id
        return (kind, asset_id, self.assets.revision(file_id))

    def _ready_ir(self, kind: str, asset_id: str) -> CabinetConvolver | ReverbConvolver | None:
        with self._lock:
            key = self._ir_key(kind, asset_id)
            found = self._irs.get(key)
            if found is not None:
                self._irs.move_to_end(key)
            return found

    def _post_now(self, kind: str, message: tuple, state: tuple | None = None, model: str | None = None) -> None:
        """Something that needs no loading; it still overtakes a load of the same kind in flight."""
        with self._lock:
            self._tokens[kind] += 1
            self._jobs.pop(kind, None)
            self._inbox.append(message)
            if state is not None:
                self._amp_state = state
                self._model = model

    def _request(self, kind: str, args: tuple) -> None:
        with self._lock:
            if self._closed:
                return
            self._tokens[kind] += 1
            self._jobs[kind] = (self._tokens[kind], args)
            if kind == "model":
                self._amp_state = ("loading", None)
            if self._loader is None:
                self._loader = threading.Thread(target=self._load_all, name="kv-guitar-loader", daemon=True)
                self._loader.start()

    def _load_all(self) -> None:
        while True:
            with self._lock:
                kind = next((k for k in _KINDS if k in self._jobs), None)
                if kind is None:
                    self._loader = None
                    return
                token, args = self._jobs.pop(kind)
            thing = None
            error: dict | None = None
            try:
                if kind == "model":
                    thing = self._load_model(token, *args)
                elif kind == "cab":
                    thing = self._load_cab(*args)
                else:
                    thing = self._load_reverb(*args)
            except KeyError:
                error = UserError(USER_MODEL_GONE if kind == "model" else USER_IR_GONE).message
            except Exception as failed:  # noqa: BLE001 — every failure becomes a message
                code = MODEL_FAILED if kind == "model" else CAB_FAILED if kind == "cab" else REVERB_FAILED
                error = failure(code, failed)
            with self._lock:
                if token != self._tokens[kind]:
                    stale = thing
                    thing = None
                else:
                    stale = None
                    if kind == "model":
                        if thing is not None:
                            self._inbox.append(("nam", thing))
                            self._amp_state = ("ready", None)
                        else:
                            self._inbox.append(("simple", None))
                            self._amp_state = ("fallback", error or failure(MODEL_FAILED, RuntimeError()))
                        self._model = args[0]
                    elif thing is not None:
                        self._inbox.append((kind, thing))
                    else:
                        self._warnings.append(error or failure(CAB_FAILED if kind == "cab" else REVERB_FAILED, RuntimeError()))
            if isinstance(stale, NamWasm):
                self._keep_model(stale)  # overtaken, but loaded: it may be asked for again

    def _load_model(self, token: int, model_id: str, slim: bool) -> NamWasm | None:
        if self._nam_error:
            raise UserError(self._nam_error["code"], **self._nam_error["params"])
        if token != self._tokens["model"]:
            return None
        return self._build_model(model_id, slim)

    def _build_model(self, model_id: str, slim: bool) -> NamWasm:
        key = self._model_key(model_id, slim)
        text = self.assets.model_json(model_id)
        self.loads["model"] += 1
        nam = NamWasm(self._wasm_path, self.sample_rate, self.block)
        nam.kv_key = key
        try:
            nam.load_model(text, SLIM_SIZE if slim else -1.0)
            # Its first blocks are slower (cold caches): let them pass here.
            warm = np.zeros(self.block, dtype=np.float32)
            for _ in range(8):
                warm.fill(0)
                nam.process(warm)
        except BaseException:
            nam.close()
            raise
        return nam

    def _load_cab(self, cab_id: str) -> CabinetConvolver:
        return self._build_ir("cab", cab_id).clone()

    def _load_reverb(self, reverb_type: str) -> ReverbConvolver:
        return self._build_ir("reverb", reverb_type).clone()

    def _build_ir(self, kind: str, asset_id: str) -> CabinetConvolver | ReverbConvolver:
        """Reads the response, builds its convolver and keeps it as the one to copy from."""
        key = self._ir_key(kind, asset_id)
        self.loads[kind] += 1
        if kind == "cab":
            taps = self.assets.ir(asset_id)
            # Unity gain in the guitar band, so switching cabinets does not change the volume.
            gain = db_to_lin(ir_in_band_gain_db(taps, self.sample_rate))
            ready: CabinetConvolver | ReverbConvolver = CabinetConvolver(taps * np.float32(gain), self.block)
        else:
            taps = self.assets.ir(REVERB_IR[asset_id], channels="all")
            scale = convolver_normalization(taps, self.sample_rate)
            ready = ReverbConvolver(taps * np.float32(scale), self.block)
        with self._lock:
            self._irs[key] = ready
            while len(self._irs) > IR_CACHE:
                self._irs.popitem(last=False)
        return ready
