"""The compiled kernels of the amp chain — the browser's Web Audio graph, sample for sample.

Every per-sample recursion (gate, parameter glides, biquads, modulated delays, the echo's loop,
the soft clip) is a numba kernel. The small classes around them own the state arrays: the control
thread writes targets into them, the audio thread runs the kernels. `warm_up()` compiles (or loads
from numba's cache) every kernel: call it before the stream opens, so that no compilation ever
lands in the audio callback.

The kernels keep the interpreter lock (no `nogil`), on purpose. Each takes a few microseconds; if
they let the lock go, a loader thread could take it between any two of them, and on Windows the
audio thread then waits about half a millisecond to get it back — a dozen chances per block
instead of the one or two that the amp model and the big transforms give anyway.

Ported from src/dsp/gate.ts, src/dsp/curves.ts, src/audio/effects.ts, src/audio/amp.ts and
`buildGraph` in src/audio/engine.ts. Parameter changes glide like `setTargetAtTime`:
v += (target − v)·(1 − exp(−1 / (τ·rate))) every sample.
"""

from __future__ import annotations

import math

import numpy as np
from numba import njit

# `makeSoftClipCurve` / `makeDriveCurve` in src/dsp/curves.ts.
SOFT_CLIP_KNEE = 0.7
DRIVE_ASYMMETRY = 0.15
DRIVE_HARDNESS = 2.5
# `smooth()` in src/audio/effects.ts and its callers.
TAU_DEFAULT = 0.03
TAU_ROUTE = 0.01  # the channel pick, NAM ↔ simple amp
TAU_SWAP = 0.02  # the master volume, a new cabinet or reverb coming in
TAU_DELAY_TIME = 0.05
# Closer than this to its target a glide lands on it (−160 dB for a gain).
_LANDED = 1e-8
# Smaller than this a decaying state is zero: denormal numbers are slow.
_TINY = 1e-30

MIN_DB = -120.0


def db_to_lin(db: float) -> float:
    return 10 ** (db / 20)


def lin_to_db(x: float) -> float:
    return max(MIN_DB, 20 * math.log10(x)) if x > 0 else MIN_DB


def _clamp(x: float, lo: float, hi: float) -> float:
    return min(hi, max(lo, x))


def glide_step(tau: float, sample_rate: float) -> float:
    """The share of the way to the target covered each sample."""
    return 1.0 - math.exp(-1.0 / (tau * sample_rate))


# `zeros` fills this many values at a time (64–256 KB: tens of microseconds each).
_ZEROS_PIECE = 16384


def zeros(shape: int | tuple, dtype: type = np.float64) -> np.ndarray:
    """Zeros that are really there. `np.zeros` only promises the memory: each page is made when it is
    first written — for a delay line or a ring that is in the audio callback, a page at a time over
    its first lap. With little free memory on the laptop such a page can take the system tens of
    milliseconds to find (measured 2026-11-16: callbacks of 65–370 ms in the first three seconds
    after the card opened, the echo's line being walked for the first time; with every page made
    beforehand the longest was 2.8 ms). Every buffer the callback walks through is made with this.

    A piece at a time: a reverb's state is megabytes, made in the control thread when a preset with
    another reverb comes in while the guitar plays. Filled in one go it kept the interpreter for a
    millisecond or two, and a callback that came just then started that much late (seen as one
    late callback in a storm of preset changes). Between pieces the audio thread gets its turn."""
    out = np.empty(shape, dtype=dtype)
    flat = out.reshape(-1)
    for start in range(0, flat.size, _ZEROS_PIECE):
        flat[start : start + _ZEROS_PIECE] = 0
    return out


@njit(inline="always")
def _slew(cur, target, step):
    cur += (target - cur) * step
    if abs(target - cur) < _LANDED:
        cur = target
    return cur


# --- curves --------------------------------------------------------------------------------------


@njit(cache=True)
def soft_clip(x):
    """`makeSoftClipCurve` as a function. Beyond ±1 it holds its end value, like a WaveShaperNode."""
    a = abs(x)
    if a <= SOFT_CLIP_KNEE:
        return x
    if a > 1.0:
        a = 1.0
    room = 1.0 - SOFT_CLIP_KNEE
    y = SOFT_CLIP_KNEE + room * math.tanh((a - SOFT_CLIP_KNEE) / room)
    return y if x > 0 else -y


_DRIVE_NORM = math.tanh(DRIVE_HARDNESS * (1 + DRIVE_ASYMMETRY))


@njit(cache=True)
def drive_curve(x):
    """`makeDriveCurve` as a function, held beyond ±1."""
    if x > 1.0:
        x = 1.0
    elif x < -1.0:
        x = -1.0
    return math.tanh(DRIVE_HARDNESS * (x + DRIVE_ASYMMETRY * x * x)) / _DRIVE_NORM


def make_soft_clip_curve(samples: int = 2048, knee: float = SOFT_CLIP_KNEE) -> np.ndarray:
    x = np.arange(samples) / (samples - 1) * 2 - 1
    a = np.abs(x)
    room = 1 - knee
    return np.where(a <= knee, x, np.sign(x) * (knee + room * np.tanh((a - knee) / room))).astype(np.float32)


def make_drive_curve(
    samples: int = 4096, asymmetry: float = DRIVE_ASYMMETRY, hardness: float = DRIVE_HARDNESS
) -> np.ndarray:
    x = np.arange(samples) / (samples - 1) * 2 - 1
    return (np.tanh(hardness * (x + asymmetry * x * x)) / math.tanh(hardness * (1 + asymmetry))).astype(np.float32)


# --- biquads: the Web Audio BiquadFilterNode formulas ----------------------------------------------

LOWPASS, HIGHPASS, PEAKING, LOWSHELF, HIGHSHELF, NOTCH = 0, 1, 2, 3, 4, 5


@njit(cache=True)
def biquad_coefs(kind, freq, sample_rate, q, gain_db):
    """(b0, b1, b2, a1, a2), divided by a0. For low/highpass `q` is in dB, as in Web Audio."""
    w0 = 2.0 * math.pi * freq / sample_rate
    cos = math.cos(w0)
    sin = math.sin(w0)
    a = 10.0 ** (gain_db / 40.0)
    if kind == NOTCH:
        alpha = sin / (2.0 * q)
        a0 = 1.0 + alpha
        return 1.0 / a0, -2.0 * cos / a0, 1.0 / a0, -2.0 * cos / a0, (1.0 - alpha) / a0
    if kind == LOWPASS or kind == HIGHPASS:
        alpha = sin / (2.0 * 10.0 ** (q / 20.0))
        if kind == LOWPASS:
            b0 = (1.0 - cos) / 2.0
            b1 = 1.0 - cos
        else:
            b0 = (1.0 + cos) / 2.0
            b1 = -(1.0 + cos)
        b2 = b0
        a0 = 1.0 + alpha
        a1 = -2.0 * cos
        a2 = 1.0 - alpha
    elif kind == PEAKING:
        alpha = sin / (2.0 * q)
        b0 = 1.0 + alpha * a
        b1 = -2.0 * cos
        b2 = 1.0 - alpha * a
        a0 = 1.0 + alpha / a
        a1 = -2.0 * cos
        a2 = 1.0 - alpha / a
    else:
        # Shelf slope S = 1.
        k = 2.0 * (sin / 2.0 * math.sqrt(2.0)) * math.sqrt(a)
        if kind == LOWSHELF:
            b0 = a * ((a + 1.0) - (a - 1.0) * cos + k)
            b1 = 2.0 * a * ((a - 1.0) - (a + 1.0) * cos)
            b2 = a * ((a + 1.0) - (a - 1.0) * cos - k)
            a0 = (a + 1.0) + (a - 1.0) * cos + k
            a1 = -2.0 * ((a - 1.0) + (a + 1.0) * cos)
            a2 = (a + 1.0) + (a - 1.0) * cos - k
        else:
            b0 = a * ((a + 1.0) + (a - 1.0) * cos + k)
            b1 = -2.0 * a * ((a - 1.0) + (a + 1.0) * cos)
            b2 = a * ((a + 1.0) + (a - 1.0) * cos - k)
            a0 = (a + 1.0) - (a - 1.0) * cos + k
            a1 = 2.0 * ((a - 1.0) - (a + 1.0) * cos)
            a2 = (a + 1.0) - (a - 1.0) * cos - k
    return b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0


# --- «Фильтр гула» -----------------------------------------------------------------------------------

# `createHumFilter` in src/audio/analysis.ts: notches at 50 Hz and its first harmonics, 2 Hz wide
# (a note next to one loses at most 1 dB; the hum, with the mains 0.05 Hz off, 26 → 11 dB).
HUM_HZ = 50.0
HUM_HARMONICS = 6
HUM_BANDWIDTH_HZ = 2.0


@njit(cache=True)
def _hum_kernel(x, out, c, z, s):
    # c: 5 coefficients per notch; z: 2 states per notch; s: [wet gain, target, step].
    wet = s[0]
    target = s[1]
    step = s[2]
    count = c.shape[0] // 5
    for i in range(x.shape[0]):
        dry = np.float64(x[i])
        v = dry
        for k in range(count):
            at = k * 5
            y = c[at] * v + z[2 * k]
            z[2 * k] = c[at + 1] * v - c[at + 3] * y + z[2 * k + 1]
            z[2 * k + 1] = c[at + 2] * v - c[at + 4] * y
            v = y
        wet = _slew(wet, target, step)
        out[i] = dry + (v - dry) * wet
    for k in range(z.shape[0]):
        if not (z[k] > _TINY or z[k] < -_TINY):
            z[k] = 0.0
    s[0] = wet


class HumFilter:
    """The notches run all the time; switching on or off mixes them in or out (τ = 30 ms, no click).
    In place is fine: each sample is read before it is written."""

    def __init__(self, sample_rate: int, mains_hz: float = HUM_HZ) -> None:
        self.sample_rate = sample_rate
        self.mains_hz = 0.0
        self.c = np.zeros(5 * HUM_HARMONICS)
        self.z = np.zeros(2 * HUM_HARMONICS)
        self.s = np.array([0.0, 0.0, glide_step(TAU_DEFAULT, sample_rate)])
        self.set_mains(mains_hz)

    def set_mains(self, hz: float) -> None:
        """50 or 60 Hz (src/dsp/mains.ts finds which). The new coefficients are built aside and copied in
        at once; the notch states carry over (a moment of ringing at most, once per change)."""
        if hz == self.mains_hz:
            return
        c = np.zeros(5 * HUM_HARMONICS)
        for k in range(HUM_HARMONICS):
            freq = hz * (k + 1)
            c[5 * k : 5 * k + 5] = biquad_coefs(NOTCH, freq, float(self.sample_rate), freq / HUM_BANDWIDTH_HZ, 0.0)
        self.c[:] = c
        self.mains_hz = hz

    def set_on(self, on: bool) -> None:
        self.s[1] = 1.0 if on else 0.0

    def settle(self) -> None:
        """Jumps to the target (before any sound, and in tests)."""
        self.s[0] = self.s[1]

    def process(self, x: np.ndarray, out: np.ndarray) -> None:
        _hum_kernel(x, out, self.c, self.z, self.s)


# --- «Подстроить под мою гитару» ---------------------------------------------------------------------

# `TRIM_MIN_DB` / `TRIM_MAX_DB` of src/dsp/inputTrim.ts.
TRIM_MIN_DB = -12.0
TRIM_MAX_DB = 24.0


@njit(cache=True)
def _trim_kernel(x, s):
    # s: [gain, target, step]
    gain = s[0]
    target = s[1]
    step = s[2]
    if gain == target:
        if gain != 1.0:
            for i in range(x.shape[0]):
                x[i] *= gain
        return
    for i in range(x.shape[0]):
        gain = _slew(gain, target, step)
        x[i] *= gain
    s[0] = gain


class InputTrim:
    """The input's own gain, after the channel pick (the trim node of `buildAnalysis`), gliding like
    `smooth()` (τ = 30 ms). In place."""

    def __init__(self, sample_rate: int) -> None:
        self.s = np.array([1.0, 1.0, glide_step(TAU_DEFAULT, sample_rate)])

    def set(self, db: float) -> None:
        db = float(db) if math.isfinite(float(db)) else 0.0
        self.s[1] = db_to_lin(_clamp(db, TRIM_MIN_DB, TRIM_MAX_DB))

    def settle(self) -> None:
        """Jumps to the target (before any sound, and in tests)."""
        self.s[0] = self.s[1]

    def process(self, x: np.ndarray) -> None:
        _trim_kernel(x, self.s)


# --- the channel pick ------------------------------------------------------------------------------

CHANNEL_GAINS = {"left": (1.0, 0.0), "right": (0.0, 1.0), "both": (0.5, 0.5)}


def channel_step(old: str, new: str) -> float:
    """`channelStep` of src/dsp/channel.ts: how many times louder the guitar's own input (and its
    noise) gets when the pick changes — 2 from both halves to one side, 0.5 back, else 1."""
    if old == new:
        return 1.0
    if old == "both":
        return 2.0
    if new == "both":
        return 0.5
    return 1.0


@njit(cache=True)
def _pick_kernel(inp, mono, s):
    # s: [left, left target, right, right target, step]
    gl = s[0]
    gr = s[2]
    tl = s[1]
    tr = s[3]
    step = s[4]
    for i in range(mono.shape[0]):
        gl = _slew(gl, tl, step)
        gr = _slew(gr, tr, step)
        mono[i] = inp[i, 0] * gl + inp[i, 1] * gr
    s[0] = gl
    s[2] = gr


class ChannelPick:
    """Input 1, input 2 or both halves → the mono guitar (`channelGains` in src/dsp/channel.ts)."""

    def __init__(self, sample_rate: int) -> None:
        self.s = np.array([0.5, 0.5, 0.5, 0.5, glide_step(TAU_ROUTE, sample_rate)])

    def set(self, choice: str) -> None:
        if choice not in CHANNEL_GAINS:
            raise ValueError(f"unknown channel: {choice}")
        self.s[1], self.s[3] = CHANNEL_GAINS[choice]

    def process(self, inp: np.ndarray, mono: np.ndarray) -> None:
        _pick_kernel(inp, mono, self.s)


# --- the noise gate --------------------------------------------------------------------------------

_G_ENV, _G_GAIN, _G_OPEN, _G_HOLD_LEFT, _G_OPEN_LEVEL, _G_CLOSE_LEVEL = 0, 1, 2, 3, 4, 5
_G_HOLD, _G_ENV_ATTACK, _G_ENV_RELEASE, _G_ATTACK, _G_RELEASE = 6, 7, 8, 9, 10
# «Шумодав сам»: the preset's own levels, whether the gate may go over them, and the floor's tracker.
_G_PRESET_OPEN, _G_PRESET_CLOSE, _G_AUTO, _G_HYSTERESIS, _G_FLOOR = 11, 12, 13, 14, 15
_G_WINDOW, _G_SUM, _G_TOP, _G_COUNT, _G_RING_AT, _G_FLAT_RUN, _G_RING = 16, 17, 18, 19, 20, 21, 22

# `GATE_OFF_DB` and `GATE_AUTO` of src/dsp/gate.ts (the reasons are written there).
GATE_OFF_DB = -90.0
GATE_WINDOW_S = 0.5
GATE_FLAT_DB = 3.0
GATE_STEADY_WINDOWS = 10
GATE_STEADY_DB = 2.0
GATE_MARGIN_DB = 8.0
GATE_CAP_DB = -40.0
GATE_NEAR_DB = 10.0
GATE_UP_DB = 0.25
GATE_START_DB = -64.0
GATE_SILENT_DB = -120.0

_GATE_FLAT = db_to_lin(GATE_FLAT_DB)
_GATE_STEADY = db_to_lin(GATE_STEADY_DB)
_GATE_MARGIN = db_to_lin(GATE_MARGIN_DB)
_GATE_CAP = db_to_lin(GATE_CAP_DB)
_GATE_NEAR = db_to_lin(GATE_NEAR_DB)
_GATE_UP = db_to_lin(GATE_UP_DB)
_GATE_SILENT = db_to_lin(GATE_SILENT_DB)


@njit(cache=True)
def _gate_levels(g):
    """The levels that open and close the gate now: the preset's, or the gate's own when higher."""
    own = min(_GATE_CAP, g[_G_FLOOR] * _GATE_MARGIN) if g[_G_AUTO] != 0.0 else 0.0
    if own > g[_G_PRESET_OPEN]:
        g[_G_OPEN_LEVEL] = own
        g[_G_CLOSE_LEVEL] = own * g[_G_HYSTERESIS]
    else:
        g[_G_OPEN_LEVEL] = g[_G_PRESET_OPEN]
        g[_G_CLOSE_LEVEL] = g[_G_PRESET_CLOSE]


@njit(cache=True)
def _gate_window(g, mean, top):
    """`endWindow` of src/dsp/gate.ts: what half a second says about the noise floor."""
    if mean < _GATE_SILENT:
        return
    if top > mean * _GATE_FLAT:
        g[_G_FLAT_RUN] = 0.0
        return
    at = int(g[_G_RING_AT])
    g[_G_RING + at] = mean
    g[_G_RING_AT] = (at + 1) % GATE_STEADY_WINDOWS
    g[_G_FLAT_RUN] += 1.0
    lo = g[_G_RING]
    hi = g[_G_RING]
    for i in range(1, GATE_STEADY_WINDOWS):
        v = g[_G_RING + i]
        if v < lo:
            lo = v
        if v > hi:
            hi = v
    floor = g[_G_FLOOR]
    if mean < floor:
        g[_G_FLOOR] = mean
    elif g[_G_FLAT_RUN] >= GATE_STEADY_WINDOWS and hi <= lo * _GATE_STEADY:
        g[_G_FLOOR] = lo
    elif mean < floor * _GATE_NEAR:
        g[_G_FLOOR] = floor * _GATE_UP
    _gate_levels(g)


@njit(cache=True)
def _gate_kernel(x, out, g):
    env = g[_G_ENV]
    gain = g[_G_GAIN]
    is_open = g[_G_OPEN] != 0.0
    hold_left = g[_G_HOLD_LEFT]
    open_level = g[_G_OPEN_LEVEL]
    close_level = g[_G_CLOSE_LEVEL]
    hold = g[_G_HOLD]
    env_attack = g[_G_ENV_ATTACK]
    env_release = g[_G_ENV_RELEASE]
    attack = g[_G_ATTACK]
    release = g[_G_RELEASE]
    window = g[_G_WINDOW]
    total = g[_G_SUM]
    top = g[_G_TOP]
    count = g[_G_COUNT]
    for i in range(x.shape[0]):
        v = np.float64(x[i])
        a = abs(v)
        k = env_attack if a > env else env_release
        env = k * env + (1.0 - k) * a
        total += env
        if env > top:
            top = env
        count += 1.0
        if count >= window:
            _gate_window(g, total / count, top)
            total = 0.0
            top = 0.0
            count = 0.0
            open_level = g[_G_OPEN_LEVEL]
            close_level = g[_G_CLOSE_LEVEL]
        if env >= open_level:
            is_open = True
            hold_left = hold
        elif is_open and env < close_level:
            if hold_left > 0.0:
                hold_left -= 1.0
            else:
                is_open = False
        target = 1.0 if is_open else 0.0
        c = attack if target > gain else release
        gain = c * gain + (1.0 - c) * target
        out[i] = v * gain
    g[_G_ENV] = env if env > _TINY else 0.0
    g[_G_GAIN] = gain if gain > _TINY else 0.0
    g[_G_OPEN] = 1.0 if is_open else 0.0
    g[_G_HOLD_LEFT] = hold_left
    g[_G_SUM] = total
    g[_G_TOP] = top
    g[_G_COUNT] = count


class GateCore:
    """`GateCore` of src/dsp/gate.ts: opens on a played note, closes on hiss; with `auto` it finds
    the input's noise floor itself and never opens lower than `GATE_MARGIN_DB` over it."""

    def __init__(
        self,
        sample_rate: int,
        threshold_db: float,
        hysteresis_db: float = 6.0,
        attack_ms: float = 1.0,
        hold_ms: float = 60.0,
        release_ms: float = 120.0,
        auto: bool = False,
    ) -> None:
        self.sample_rate = sample_rate
        self.hysteresis_db = hysteresis_db
        self.threshold_db = threshold_db
        self.auto = auto
        g = self.g = np.zeros(_G_RING + GATE_STEADY_WINDOWS)
        g[_G_ENV_ATTACK] = self._coef(0.2)
        g[_G_ENV_RELEASE] = self._coef(20.0)
        g[_G_HOLD] = math.floor(hold_ms / 1000 * sample_rate + 0.5)
        g[_G_ATTACK] = self._coef(attack_ms)
        g[_G_RELEASE] = self._coef(release_ms)
        g[_G_HYSTERESIS] = db_to_lin(-hysteresis_db)
        g[_G_FLOOR] = db_to_lin(GATE_START_DB)
        g[_G_WINDOW] = math.floor(GATE_WINDOW_S * sample_rate + 0.5)
        self.set_threshold(threshold_db)

    def _coef(self, ms: float) -> float:
        return math.exp(-1.0 / (ms / 1000 * self.sample_rate))

    def set_threshold(self, threshold_db: float) -> None:
        self.threshold_db = threshold_db
        self._apply()

    def set_auto(self, auto: bool) -> None:
        self.auto = bool(auto)
        self._apply()

    def scale_floor(self, factor: float) -> None:
        """`scaleFloor` of src/dsp/gate.ts: the input got `factor` times louder (the channel pick
        changed), and the learned floor moves with it."""
        if not (factor > 0 and math.isfinite(factor)):
            return
        g = self.g
        g[_G_FLOOR] *= factor
        g[_G_RING : _G_RING + GATE_STEADY_WINDOWS] *= factor
        g[_G_SUM] *= factor
        g[_G_TOP] *= factor
        _gate_levels(g)

    def _apply(self) -> None:
        g = self.g
        g[_G_PRESET_OPEN] = db_to_lin(self.threshold_db)
        g[_G_PRESET_CLOSE] = db_to_lin(self.threshold_db - self.hysteresis_db)
        g[_G_AUTO] = 1.0 if self.auto and self.threshold_db > GATE_OFF_DB else 0.0
        _gate_levels(g)

    @property
    def is_open(self) -> bool:
        return bool(self.g[_G_OPEN])

    @property
    def gain(self) -> float:
        return float(self.g[_G_GAIN])

    @property
    def floor_db(self) -> float:
        """The noise floor as the gate knows it, dBFS of its envelope."""
        return lin_to_db(float(self.g[_G_FLOOR]))

    @property
    def open_db(self) -> float:
        """The level that opens the gate now, dBFS."""
        return lin_to_db(float(self.g[_G_OPEN_LEVEL]))

    def process(self, x: np.ndarray, out: np.ndarray) -> None:
        """`x` and `out`: float32 of the same length (may be the same array)."""
        _gate_kernel(x, out, self.g)


# --- drive, and the way to the NAM amp or the simple one -------------------------------------------


@njit(cache=True)
def _drive_kernel(x, nam_in, simple_in, s):
    # s: [drive, target, nam send, target, simple send, target, step, route step]
    drive = s[0]
    nam = s[2]
    simple = s[4]
    td = s[1]
    tn = s[3]
    ts = s[5]
    step = s[6]
    route = s[7]
    for i in range(x.shape[0]):
        drive = _slew(drive, td, step)
        nam = _slew(nam, tn, route)
        simple = _slew(simple, ts, route)
        v = x[i] * drive
        nam_in[i] = v * nam
        simple_in[i] = v * simple
    s[0] = drive
    s[2] = nam
    s[4] = simple


class Drive:
    """`AmpSlot`'s input gain and its two sends. Starts on the simple amp, as the browser does."""

    def __init__(self, sample_rate: int) -> None:
        self.s = np.array(
            [1.0, 1.0, 0.0, 0.0, 1.0, 1.0, glide_step(TAU_DEFAULT, sample_rate), glide_step(TAU_ROUTE, sample_rate)]
        )

    def set_drive(self, input_db: float) -> None:
        self.s[1] = db_to_lin(input_db)

    def route(self, nam: bool) -> None:
        self.s[3] = 1.0 if nam else 0.0
        self.s[5] = 0.0 if nam else 1.0

    @property
    def nam_live(self) -> bool:
        """The NAM amp is heard, or about to be."""
        return self.s[2] != 0.0 or self.s[3] != 0.0

    @property
    def simple_live(self) -> bool:
        return self.s[4] != 0.0 or self.s[5] != 0.0

    def process(self, x: np.ndarray, nam_in: np.ndarray, simple_in: np.ndarray) -> None:
        _drive_kernel(x, nam_in, simple_in, self.s)


# --- the simple amp (`AmpSlot.buildSimpleAmp`) -------------------------------------------------------


@njit(inline="always")
def _biquad(v, c, at, z, zat):
    y = c[at] * v + z[zat]
    z[zat] = c[at + 1] * v - c[at + 3] * y + z[zat + 1]
    z[zat + 1] = c[at + 2] * v - c[at + 4] * y
    return y


@njit(inline="always")
def _flush(z):
    for i in range(z.shape[0]):
        if -_TINY < z[i] < _TINY:
            z[i] = 0.0


@njit(cache=True)
def _simple_amp_kernel(x, out, c, z, pre, post):
    for i in range(x.shape[0]):
        v = _biquad(np.float64(x[i]), c, 0, z, 0)  # tight low end
        v = drive_curve(v * pre)
        v = _biquad(v, c, 5, z, 2)  # the asymmetric curve leaves DC
        v = _biquad(v, c, 10, z, 4)  # speaker-like top cut
        out[i] = v * post
    _flush(z)


class SimpleAmp:
    """Highpass 90 Hz, +20 dB, the drive curve, DC block 20 Hz, lowpass 6 kHz, −12 dB. Not oversampled."""

    def __init__(self, sample_rate: int) -> None:
        self.c = np.array(
            [
                *biquad_coefs(HIGHPASS, 90.0, sample_rate, 1.0, 0.0),
                *biquad_coefs(HIGHPASS, 20.0, sample_rate, 1.0, 0.0),
                *biquad_coefs(LOWPASS, 6000.0, sample_rate, 1.0, 0.0),
            ]
        )
        self.z = np.zeros(6)
        self.pre = db_to_lin(20.0)
        self.post = db_to_lin(-12.0)

    def reset(self) -> None:
        self.z[:] = 0.0

    def process(self, x: np.ndarray, out: np.ndarray) -> None:
        _simple_amp_kernel(x, out, self.c, self.z, self.pre, self.post)


@njit(cache=True)
def add_into(a, b):
    """a += b"""
    for i in range(a.shape[0]):
        a[i] += b[i]


@njit(cache=True)
def ramp(x, gain, step):
    """x *= a gain that moves by `step` a sample and stops at 0 or 1. Returns the gain it reached."""
    for i in range(x.shape[0]):
        gain += step
        if gain > 1.0:
            gain = 1.0
        elif gain < 0.0:
            gain = 0.0
        x[i] *= gain
    return gain


# --- EQ (`createEq`) -----------------------------------------------------------------------------------

_EQ_FREQ = (120.0, 750.0, 3000.0)
_EQ_KIND = (LOWSHELF, PEAKING, HIGHSHELF)
_EQ_Q = (1.0, 0.8, 1.0)
# A gain this close to its target lands on it, dB.
_EQ_LANDED = 1e-4


@njit(cache=True)
def _eq_kernel(x, out, gains, targets, c, z, keep, sample_rate):
    n = x.shape[0]
    for band in range(3):
        at = band * 5
        b0 = c[at]
        b1 = c[at + 1]
        b2 = c[at + 2]
        a1 = c[at + 3]
        a2 = c[at + 4]
        d0 = d1 = d2 = d3 = d4 = 0.0
        gain = gains[band]
        target = targets[band]
        if gain != target:
            # Where setTargetAtTime gets to by the end of this block; the coefficients go there
            # in a straight line.
            gain = target + (gain - target) * keep
            if abs(gain - target) < _EQ_LANDED:
                gain = target
            gains[band] = gain
            n0, n1, n2, n3, n4 = biquad_coefs(_EQ_KIND[band], _EQ_FREQ[band], sample_rate, _EQ_Q[band], gain)
            d0 = (n0 - b0) / n
            d1 = (n1 - b1) / n
            d2 = (n2 - b2) / n
            d3 = (n3 - a1) / n
            d4 = (n4 - a2) / n
            c[at] = n0
            c[at + 1] = n1
            c[at + 2] = n2
            c[at + 3] = n3
            c[at + 4] = n4
        z1 = z[band * 2]
        z2 = z[band * 2 + 1]
        for i in range(n):
            b0 += d0
            b1 += d1
            b2 += d2
            a1 += d3
            a2 += d4
            v = np.float64(x[i]) if band == 0 else np.float64(out[i])
            y = b0 * v + z1
            z1 = b1 * v - a1 * y + z2
            z2 = b2 * v - a2 * y
            out[i] = y
        z[band * 2] = z1 if (z1 > _TINY or z1 < -_TINY) else 0.0
        z[band * 2 + 1] = z2 if (z2 > _TINY or z2 < -_TINY) else 0.0


class Eq:
    """Lowshelf 120 Hz, peaking 750 Hz (Q 0.8), highshelf 3 kHz; gains within ±12 dB."""

    def __init__(self, sample_rate: int) -> None:
        self.sample_rate = float(sample_rate)
        self.gains = np.zeros(3)
        self._targets = np.zeros(3)
        self.c = np.zeros(15)
        self.z = np.zeros(6)
        self._step = glide_step(TAU_DEFAULT, sample_rate)
        self._keep_block = 0
        self._keep = 1.0
        self._set_coefs()

    def _set_coefs(self) -> None:
        for band in range(3):
            self.c[band * 5 : band * 5 + 5] = biquad_coefs(
                _EQ_KIND[band], _EQ_FREQ[band], self.sample_rate, _EQ_Q[band], self.gains[band]
            )

    def set(self, bass: float, mid: float, treble: float) -> None:
        self._targets[0] = _clamp(bass, -12.0, 12.0)
        self._targets[1] = _clamp(mid, -12.0, 12.0)
        self._targets[2] = _clamp(treble, -12.0, 12.0)

    @property
    def targets(self) -> tuple[float, float, float]:
        return (float(self._targets[0]), float(self._targets[1]), float(self._targets[2]))

    def settle(self) -> None:
        """Jumps to the targets (before any sound, and in tests)."""
        self.gains[:] = self._targets
        self._set_coefs()

    def process(self, x: np.ndarray, out: np.ndarray) -> None:
        n = len(x)
        if n != self._keep_block:
            self._keep_block = n
            self._keep = (1.0 - self._step) ** n
        _eq_kernel(x, out, self.gains, self._targets, self.c, self.z, self._keep, self.sample_rate)


# --- a slot whose inside is swapped with a crossfade (`SwapSlot`) -------------------------------------


@njit(cache=True)
def _swap_kernel(new, old, out, s):
    # s: [new gain, old gain, step]; the new side glides to 1, the old one to 0.
    gn = s[0]
    go = s[1]
    step = s[2]
    for i in range(out.shape[0]):
        gn = _slew(gn, 1.0, step)
        go = _slew(go, 0.0, step)
        out[i] = new[i] * gn + old[i] * go
    s[0] = gn
    s[1] = go


class SwapGains:
    """The two gains of a `SwapSlot`: the new inside fades in, the old one out (τ = 20 ms)."""

    def __init__(self, sample_rate: int) -> None:
        self.s = np.array([1.0, 0.0, glide_step(TAU_SWAP, sample_rate)])

    def swap(self) -> None:
        self.s[1] = self.s[0]
        self.s[0] = 0.0

    @property
    def settled(self) -> bool:
        return self.s[0] == 1.0 and self.s[1] == 0.0

    def mix(self, new: np.ndarray, old: np.ndarray, out: np.ndarray) -> None:
        _swap_kernel(new, old, out, self.s)


# --- chorus, delay and the reverb send (`createChorus`, `createDelay`, `createReverb`) -----------------

CHORUS_CENTRE_S = 0.012
_CHORUS_LINE = 4096  # ≥ 50 ms at 48 kHz
_DELAY_LINE = 131072  # ≥ 2 s at 48 kHz
# Chrome renders in quanta of 128 frames and breaks the echo's feedback loop by handing the
# DelayNode the loop's output of the quantum before: every trip round the loop is 128 frames
# longer than the delay time (the first repeat is not). Measured against the browser: with the
# longer loop «Соло» matches it to 0.02 dB, without it it is 0.8 dB off (the repeats of a held
# note add up differently).
_FEEDBACK_QUANTUM = 128

(
    _F_RATE, _F_DEPTH, _F_CH_WET, _F_CH_DRY, _F_TIME, _F_FEEDBACK, _F_DL_WET, _F_DL_SEND, _F_RV_SEND,
) = range(9)  # fmt: skip
_F_COUNT = 9
# After the glides and their targets: the steps, the LFO phase, the rate.
_F_STEP = 2 * _F_COUNT
_F_STEP_TIME = _F_STEP + 1
_F_PHASE = _F_STEP + 2
_F_SR = _F_STEP + 3
_F_SIZE = _F_STEP + 4


@njit(cache=True)
def _post_kernel(x, post, send, p, c, z, chorus_line, delay_line, feedback_queue, idx):
    n = x.shape[0]
    rate = p[_F_RATE]
    depth = p[_F_DEPTH]
    ch_wet = p[_F_CH_WET]
    ch_dry = p[_F_CH_DRY]
    time = p[_F_TIME]
    feedback = p[_F_FEEDBACK]
    dl_wet = p[_F_DL_WET]
    dl_send = p[_F_DL_SEND]
    rv_send = p[_F_RV_SEND]
    t_rate = p[_F_COUNT + _F_RATE]
    t_depth = p[_F_COUNT + _F_DEPTH]
    t_ch_wet = p[_F_COUNT + _F_CH_WET]
    t_ch_dry = p[_F_COUNT + _F_CH_DRY]
    t_time = p[_F_COUNT + _F_TIME]
    t_feedback = p[_F_COUNT + _F_FEEDBACK]
    t_dl_wet = p[_F_COUNT + _F_DL_WET]
    t_dl_send = p[_F_COUNT + _F_DL_SEND]
    t_rv_send = p[_F_COUNT + _F_RV_SEND]
    step = p[_F_STEP]
    step_time = p[_F_STEP_TIME]
    phase = p[_F_PHASE]
    sr = p[_F_SR]
    two_pi = 2.0 * math.pi
    cw = idx[0]
    dw = idx[1]
    fq = idx[2]
    quantum = feedback_queue.shape[1]
    cmask = chorus_line.shape[0] - 1
    dmask = delay_line.shape[1] - 1
    centre = CHORUS_CENTRE_S * sr
    peak = 0.0
    for i in range(n):
        rate = _slew(rate, t_rate, step)
        depth = _slew(depth, t_depth, step)
        ch_wet = _slew(ch_wet, t_ch_wet, step)
        ch_dry = _slew(ch_dry, t_ch_dry, step)
        time = _slew(time, t_time, step_time)
        feedback = _slew(feedback, t_feedback, step)
        dl_wet = _slew(dl_wet, t_dl_wet, step)
        dl_send = _slew(dl_send, t_dl_send, step)
        rv_send = _slew(rv_send, t_rv_send, step)

        # Chorus: two delays of the mono guitar, swinging in opposite directions.
        v = np.float64(x[i])
        chorus_line[cw] = x[i]
        left = v * ch_dry
        right = left
        if ch_wet != 0.0:
            swing = depth * sr * math.sin(phase)
            pos = cw - (centre + swing)
            at = int(math.floor(pos))
            frac = pos - at
            left += ch_wet * (chorus_line[at & cmask] * (1.0 - frac) + chorus_line[(at + 1) & cmask] * frac)
            pos = cw - (centre - swing)
            at = int(math.floor(pos))
            frac = pos - at
            right += ch_wet * (chorus_line[at & cmask] * (1.0 - frac) + chorus_line[(at + 1) & cmask] * frac)
        phase += two_pi * rate / sr
        if phase >= two_pi:
            phase -= two_pi
        cw = (cw + 1) & cmask

        # Tape echo, one loop per side: delay → highpass 120 → lowpass 3500 → back in, and out.
        lag = time * sr
        if lag < 1.0:
            lag = 1.0
        pos = dw - lag
        at = int(math.floor(pos))
        frac = pos - at
        for ch in range(2):
            dry = left if ch == 0 else right
            echo = delay_line[ch, at & dmask] * (1.0 - frac) + delay_line[ch, (at + 1) & dmask] * frac
            echo = _biquad(echo, c, 0, z, ch * 4)
            echo = _biquad(echo, c, 5, z, ch * 4 + 2)
            # The way back passes the quantum-long queue (see _FEEDBACK_QUANTUM).
            back = feedback_queue[ch, fq]
            feedback_queue[ch, fq] = echo * feedback
            into = dry * dl_send + back
            if -1e-20 < into < 1e-20:
                into = 0.0
            delay_line[ch, dw] = into
            y = np.float32(dry + echo * dl_wet)
            post[ch, i] = y
            s = np.float32(y * rv_send)
            send[ch, i] = s
            if s > peak:
                peak = s
            elif -s > peak:
                peak = -s
        dw = (dw + 1) & dmask
        fq += 1
        if fq == quantum:
            fq = 0
    _flush(z)
    p[_F_RATE] = rate
    p[_F_DEPTH] = depth
    p[_F_CH_WET] = ch_wet
    p[_F_CH_DRY] = ch_dry
    p[_F_TIME] = time
    p[_F_FEEDBACK] = feedback
    p[_F_DL_WET] = dl_wet
    p[_F_DL_SEND] = dl_send
    p[_F_RV_SEND] = rv_send
    p[_F_PHASE] = phase
    idx[0] = cw
    idx[1] = dw
    idx[2] = fq
    return peak


class PostFx:
    """Chorus → delay → the reverb's send. Mono in, stereo out (`post`), plus what goes to the reverb."""

    def __init__(self, sample_rate: int) -> None:
        if sample_rate * 2 > _DELAY_LINE or sample_rate * 0.05 > _CHORUS_LINE:
            raise ValueError("the delay lines are sized for 48 kHz")
        p = self.p = np.zeros(_F_SIZE)
        p[_F_STEP] = glide_step(TAU_DEFAULT, sample_rate)
        p[_F_STEP_TIME] = glide_step(TAU_DELAY_TIME, sample_rate)
        p[_F_SR] = sample_rate
        # The browser's nodes before the first preset: everything dry.
        p[_F_CH_DRY] = p[_F_COUNT + _F_CH_DRY] = 1.0
        self.c = np.array(
            [
                *biquad_coefs(HIGHPASS, 120.0, sample_rate, 1.0, 0.0),
                *biquad_coefs(LOWPASS, 3500.0, sample_rate, 1.0, 0.0),
            ]
        )
        self.z = np.zeros(8)
        # A megabyte of echo, walked once every 2.7 s: made whole here, not page by page in the callback.
        self.chorus_line = zeros(_CHORUS_LINE, np.float32)
        self.delay_line = zeros((2, _DELAY_LINE), np.float32)
        self.feedback_queue = zeros((2, _FEEDBACK_QUANTUM), np.float64)
        self.idx = np.zeros(3, dtype=np.int64)
        self._fresh = True

    def _target(self, which: int, value: float) -> None:
        self.p[_F_COUNT + which] = value

    def set_chorus(self, on: bool, rate: float, depth: float, mix: float) -> None:
        mix = _clamp(mix, 0.0, 1.0)
        self._target(_F_RATE, _clamp(rate, 0.05, 5.0))
        self._target(_F_DEPTH, 0.0005 + _clamp(depth, 0.0, 1.0) * 0.004)
        self._target(_F_CH_WET, mix if on else 0.0)
        self._target(_F_CH_DRY, 1.0 - 0.3 * mix if on else 1.0)
        self._first()

    def set_delay(self, on: bool, time_ms: float, feedback: float, mix: float) -> None:
        self._target(_F_TIME, _clamp(time_ms, 20.0, 1500.0) / 1000.0)
        self._target(_F_FEEDBACK, _clamp(feedback, 0.0, 0.9))
        self._target(_F_DL_WET, _clamp(mix, 0.0, 1.0))
        self._target(_F_DL_SEND, 1.0 if on else 0.0)
        self._first()

    def set_reverb(self, on: bool, mix: float) -> None:
        self._target(_F_RV_SEND, _clamp(mix, 0.0, 1.0) * 0.8 if on else 0.0)

    def _first(self) -> None:
        # The LFO rate and the echo time of the very first preset are simply taken: nothing is
        # sounding yet, and a glide from the nodes' defaults (440 Hz, 0 s) would be a sweep.
        if self._fresh and self.p[_F_COUNT + _F_RATE] and self.p[_F_COUNT + _F_TIME]:
            self._fresh = False
            self.p[_F_RATE] = self.p[_F_COUNT + _F_RATE]
            self.p[_F_TIME] = self.p[_F_COUNT + _F_TIME]

    def settle(self) -> None:
        """Jumps to the targets (in tests)."""
        self.p[:_F_COUNT] = self.p[_F_COUNT : 2 * _F_COUNT]

    def process(self, x: np.ndarray, post: np.ndarray, send: np.ndarray) -> float:
        """`x`: (n,) float32; `post`, `send`: (2, n) float32. Returns the send's peak."""
        return _post_kernel(
            x, post, send, self.p, self.c, self.z, self.chorus_line, self.delay_line, self.feedback_queue, self.idx
        )


# --- preset level, master, soft clip, and the output meter ---------------------------------------------

_O_LEVEL, _O_LEVEL_T, _O_MASTER, _O_MASTER_T, _O_STEP, _O_STEP_MASTER = range(6)


@njit(cache=True)
def _output_kernel(post, wet, wets, rv, out, o, peaks, squares, at):
    level = o[_O_LEVEL]
    master = o[_O_MASTER]
    t_level = o[_O_LEVEL_T]
    t_master = o[_O_MASTER_T]
    step = o[_O_STEP]
    step_master = o[_O_STEP_MASTER]
    # rv: [the reverb return's gain, its target, step]
    rv_gain = rv[0]
    rv_target = rv[1]
    rv_step = rv[2]
    peak = 0.0
    square = 0.0
    for i in range(out.shape[0]):
        level = _slew(level, t_level, step)
        master = _slew(master, t_master, step_master)
        gain = level * master
        left = np.float64(post[0, i])
        right = np.float64(post[1, i])
        if wets > 0:
            rv_gain = _slew(rv_gain, rv_target, rv_step)
            left += wet[0, i] * rv_gain
            right += wet[1, i] * rv_gain
        left = np.float32(soft_clip(left * gain))
        right = np.float32(soft_clip(right * gain))
        out[i, 0] = left
        out[i, 1] = right
        # What an AnalyserNode sees of a stereo signal: the two sides halved and summed.
        m = 0.5 * (left + right)
        if m > peak:
            peak = m
        elif -m > peak:
            peak = -m
        square += m * m
    o[_O_LEVEL] = level
    o[_O_MASTER] = master
    rv[0] = rv_gain
    peaks[at] = peak
    squares[at] = square


class Output:
    """Reverb return → preset level → master → soft clip → the card, and the level of the last 100 ms."""

    def __init__(self, sample_rate: int, block: int) -> None:
        self.block = block
        self.o = np.array(
            [1.0, 1.0, 1.0, 1.0, glide_step(TAU_DEFAULT, sample_rate), glide_step(TAU_SWAP, sample_rate)]
        )
        count = max(1, math.ceil(0.1 * sample_rate / block))
        self._peaks = np.zeros(count)
        self._squares = np.zeros(count)
        self._at = 0

    def set_level(self, db: float) -> None:
        self.o[_O_LEVEL_T] = db_to_lin(db)

    def set_master(self, db: float, muted: bool) -> None:
        self.o[_O_MASTER_T] = 0.0 if muted else db_to_lin(db)

    def process(self, post: np.ndarray, wet: np.ndarray, wets: int, rv: np.ndarray, out: np.ndarray) -> None:
        """`post`, `wet`: (2, n); `out`: (n, 2). `wets`: 1 when there is a reverb, else 0.
        `rv`: [the reverb return's gain, its target, the glide's step] (see `reverb_return`)."""
        _output_kernel(post, wet, wets, rv, out, self.o, self._peaks, self._squares, self._at)
        self._at = (self._at + 1) % len(self._peaks)

    def levels(self) -> tuple[float, float]:
        """(peak, RMS) of the last 100 ms in dBFS; silence is −120."""
        peak = float(self._peaks.max())
        rms = math.sqrt(float(self._squares.sum()) / (len(self._squares) * self.block))
        return lin_to_db(peak), lin_to_db(rms)


def reverb_return(sample_rate: int) -> np.ndarray:
    """[gain, target, step] of the reverb's return: it glides (τ = 20 ms) to 0 before the reverb is
    replaced and back to 1 after."""
    return np.array([0.0, 1.0, glide_step(TAU_SWAP, sample_rate)])


# --- warming up ------------------------------------------------------------------------------------------

_warm = False


def warm_up(sample_rate: int = 48000, block: int = 128) -> None:
    """Runs every kernel once, so that each is compiled before the audio starts."""
    global _warm
    if _warm:
        return
    inp = np.zeros((block, 2), dtype=np.float32)
    a = np.zeros(block, dtype=np.float32)
    b = np.zeros(block, dtype=np.float32)
    c = np.zeros(block, dtype=np.float32)
    planar = np.zeros((2, block), dtype=np.float32)
    send = np.zeros((2, block), dtype=np.float32)
    ChannelPick(sample_rate).process(inp, a)
    trim = InputTrim(sample_rate)
    trim.process(a)
    trim.set(6.0)
    trim.process(a)
    HumFilter(sample_rate).process(a, a)
    GateCore(sample_rate, -60.0).process(a, b)
    Drive(sample_rate).process(b, a, c)
    SimpleAmp(sample_rate).process(c, b)
    add_into(a, b)
    ramp(a, 0.5, 0.01)
    eq = Eq(sample_rate)
    eq.set(1.0, 1.0, 1.0)
    eq.process(a, b)
    swap = SwapGains(sample_rate)
    swap.mix(a, b, c)
    PostFx(sample_rate).process(c, planar, send)
    Output(sample_rate, block).process(planar, send, 1, reverb_return(sample_rate), inp)
    soft_clip(0.5)
    drive_curve(0.5)
    _warm = True
