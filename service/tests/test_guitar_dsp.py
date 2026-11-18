"""The kernels of the guitar chain (kv_guitar.dsp, kv_guitar.reverb) against the browser's maths."""

import math

import numpy as np
import pytest

from kv_guitar import dsp
from kv_guitar.reverb import ReverbConvolver, convolver_normalization

SR = 48000


def sine(seconds: float, db: float, freq: float) -> np.ndarray:
    amp = 10 ** (db / 20) * math.sqrt(2)
    i = np.arange(round(seconds * SR))
    return (amp * np.sin(2 * np.pi * freq * i / SR)).astype(np.float32)


def rms_db(x: np.ndarray) -> float:
    return float(10 * np.log10(np.mean(np.square(x, dtype=np.float64)) + 1e-30))


def run_gate(gate: dsp.GateCore, x: np.ndarray, marks: tuple[int, ...] = ()) -> tuple[np.ndarray, dict]:
    out = np.zeros_like(x)
    seen = {}
    for block, start in enumerate(range(0, len(x), 128)):
        gate.process(x[start : start + 128], out[start : start + 128])
        if block in marks:
            seen[block] = (gate.gain, gate.is_open)
    return out, seen


# --- the gate: values printed by src/dsp/gate.ts itself (GateCore, 48 kHz, threshold −50) ---

# «passes a played note almost untouched»: sine(0.2 s, −20 dB, 200 Hz) in blocks of 128.
TS_GAIN_AFTER_BLOCK = {
    0: 0.9244781554912258,
    1: 0.9947524816008186,
    2: 0.9996353843112696,
    3: 0.9999746652435768,
    5: 0.9999998776850626,
    10: 0.9999999999998018,
    40: 0.9999999999999973,
    74: 0.9999999999999973,
}
TS_OUTPUT = {  # sample index → output
    1: 0.0,
    3: 0.0,
    5: 0.0007533296011388302,
    8: 0.0029087038710713387,
    13: 0.00887800008058548,
    21: 0.02310696430504322,
    34: 0.05229001119732857,
    55: 0.09275474399328232,
    89: 0.08548460900783539,
    144: -0.07871990650892258,
    233: -0.025558123365044594,
    500: 0.07070843130350113,
    1000: 0.12247448414564133,
    5000: -0.12247448414564133,
    9599: -0.0037019795272499323,
}
# The same note for 0.1 s, then silence up to 1 s: hold, then release.
TS_RELEASE = {
    37: (0.9999999999999973, True),
    60: (0.9999999999999973, True),
    80: (0.9999999999999973, True),
    100: (0.8447200570049443, False),
    200: (0.09154064275346081, False),
}


def test_gate_matches_typescript():
    gate = dsp.GateCore(SR, threshold_db=-50)
    burst = sine(0.2, -20, 200)
    out, seen = run_gate(gate, burst, tuple(TS_GAIN_AFTER_BLOCK))
    for block, gain in TS_GAIN_AFTER_BLOCK.items():
        assert seen[block][0] == pytest.approx(gain, abs=1e-6), block
    for index, value in TS_OUTPUT.items():
        assert out[index] == pytest.approx(value, abs=1e-6), index
    # The TypeScript test's own assertion.
    assert math.sqrt(np.mean(out.astype(np.float64) ** 2) / np.mean(burst.astype(np.float64) ** 2)) > 0.95


def test_gate_holds_and_releases_like_typescript():
    gate = dsp.GateCore(SR, threshold_db=-50)
    x = np.zeros(SR, dtype=np.float32)
    x[: round(0.1 * SR)] = sine(0.1, -20, 200)
    _, seen = run_gate(gate, x, tuple(TS_RELEASE))
    for block, (gain, is_open) in TS_RELEASE.items():
        assert seen[block][0] == pytest.approx(gain, abs=1e-6), block
        assert seen[block][1] is is_open, block


def test_gate_follows_a_new_threshold():
    gate = dsp.GateCore(SR, threshold_db=-50)
    rng = np.random.default_rng(5)
    hiss = (rng.uniform(-1, 1, SR // 5) * 10 ** (-70 / 20) * math.sqrt(3)).astype(np.float32)
    run_gate(gate, hiss)
    assert gate.is_open is False
    gate.set_threshold(-80)
    run_gate(gate, hiss)
    assert gate.is_open is True


# How much hiss sits under the hum: chosen so that the peaks come out at the measured −55 dBFS.
NOISE_HISS = 0.38


def measured_noise(seconds: float = 10.0) -> np.ndarray:
    """The author's input 2 at rest (12 Nov): mains hum with odd harmonics, a 3 028 Hz whine, hiss."""
    rng = np.random.default_rng(2026)
    t = np.arange(round(seconds * SR)) / SR
    x = np.zeros(len(t))
    for freq, level, phase in ((50, 1.0, 0.0), (150, 0.5, 1.1), (250, 0.3, 2.3), (350, 0.2, 0.7), (3028, 0.3, 0.0)):
        x += level * np.sin(2 * np.pi * freq * t + phase)
    x += NOISE_HISS * rng.standard_normal(len(t))
    x *= 10 ** (-66 / 20) / math.sqrt(np.mean(x**2))
    return x.astype(np.float32)


def test_measured_noise_is_what_was_measured():
    x = measured_noise()
    assert rms_db(x) == pytest.approx(-66.0, abs=0.05)
    assert 20 * math.log10(float(np.max(np.abs(x)))) == pytest.approx(-55.0, abs=0.5)


def pluck(seconds: float = 1.0, peak_db: float = -9.0) -> np.ndarray:
    """One plucked note: a 110 Hz sawtooth with a sharp attack and a ringing tail."""
    t = np.arange(round(seconds * SR)) / SR
    x = (2 * ((t * 110.0) % 1.0) - 1) * (0.75 * np.exp(-40 * t) + 0.25 * np.exp(-2 * t))
    return (x * 10 ** (peak_db / 20) / np.max(np.abs(x))).astype(np.float32)


@pytest.mark.parametrize("extra_db", [0.0, 0.5])
def test_gate_at_minus_58_stays_closed_on_measured_noise(extra_db):
    """A closed gate stays closed on the noise of the author's input at rest, from −58 dB up.

    The numbers are the author's input 2 at rest on 12 Nov 2026: RMS −66 dBFS, peaks −55 dBFS
    (`measured_noise`), also tried half a decibel louder. This is a fact about the gate, the same
    in the browser and here. The presets are not changed for it: the threshold is the author's
    («Шумодав» on «Комбик»), and the built-in ones stay at −70 / −64 / −58 / −60.
    """
    gate = dsp.GateCore(SR, threshold_db=-58)
    out, _ = run_gate(gate, measured_noise() * np.float32(10 ** (extra_db / 20)))
    assert rms_db(out[round(0.2 * SR) :]) < -90
    assert gate.is_open is False
    # One decibel lower it does open (as measured): −58 is where «stays closed» begins.
    lower = dsp.GateCore(SR, threshold_db=-60)
    run_gate(lower, measured_noise())
    assert lower.is_open is True


@pytest.mark.parametrize("extra_db", [0.0, 0.5])
def test_gate_at_minus_54_closes_after_a_note_on_measured_noise(extra_db):
    """After a played note the gate closes again on that noise within 0.3 s — from −54 dB up.

    Staying closed is not enough: the gate closes 6 dB under its threshold, and the noise's
    envelope sits at −62 … −59 dBFS, so at −58 (close level −64) a gate that a note has opened
    never closes again. Same measurement as above (12 Nov 2026, RMS −66, peaks −55 dBFS); the
    presets are not changed.
    """
    noise = measured_noise() * np.float32(10 ** (extra_db / 20))
    note = pluck(1.0)
    x = noise.copy()
    x[: len(note)] += note
    gate = dsp.GateCore(SR, threshold_db=-54)
    out = np.zeros_like(x)
    open_at = []
    for start in range(0, len(x), 128):
        gate.process(x[start : start + 128], out[start : start + 128])
        open_at.append(gate.is_open)
    open_at = np.array(open_at)
    per_second = SR / 128
    assert open_at[: int(0.5 * per_second)].all()  # the note plays
    # The note is under the noise about 0.9 s after its attack... the gate must be shut 0.3 s
    # after the note's second, and stay shut.
    assert not open_at[int(1.3 * per_second) :].any()
    assert rms_db(out[round(1.8 * SR) :]) < -90
    # At −58 it never closes: the reason the test asks for −54.
    stuck = dsp.GateCore(SR, threshold_db=-58)
    run_gate(stuck, x)
    assert stuck.is_open is True


# --- «Шумодав сам»: the gate finds the noise floor itself ---


def hissy_noise(seconds: float = 10.0) -> np.ndarray:
    """The same measurement (RMS −66 dBFS) read the other way: mostly hiss, the tones only what
    sticks out of its spectrum. The hum filter takes almost nothing off this one."""
    rng = np.random.default_rng(2026)
    t = np.arange(round(seconds * SR)) / SR
    x = np.zeros(len(t))
    for freq, level, phase in ((50, 0.35, 0.0), (150, 0.2, 1.1), (250, 0.14, 2.3), (350, 0.1, 0.7), (3028, 0.08, 0.0)):
        x += level * np.sin(2 * np.pi * freq * t + phase)
    x += rng.standard_normal(len(t))
    x *= 10 ** (-66 / 20) / math.sqrt(np.mean(x**2))
    return x.astype(np.float32)


def run_hum_and_gate(gate: dsp.GateCore, x: np.ndarray, hum_on: bool = True) -> tuple[np.ndarray, np.ndarray]:
    """As in the chain: the hum filter, then the gate. Returns the output and, per block, was the gate open."""
    hum = dsp.HumFilter(SR)
    hum.set_on(hum_on)
    hum.settle()
    out = np.zeros_like(x)
    opened = []
    for start in range(0, len(x), 128):
        hum.process(x[start : start + 128], out[start : start + 128])
        gate.process(out[start : start + 128], out[start : start + 128])
        opened.append(gate.is_open)
    return out, np.array(opened)


PER_SECOND = SR / 128
# The four built-in presets' thresholds (src/state/presets.ts; test_guitar_chain.py checks the list).
PRESET_GATES = (-70.0, -64.0, -60.0, -58.0)


@pytest.mark.parametrize("threshold", PRESET_GATES)
@pytest.mark.parametrize("noise", [measured_noise, hissy_noise])
def test_auto_gate_falls_silent_on_the_input_noise_at_every_preset_threshold(threshold, noise):
    """What the author heard as «всегда шум»: behind the hum filter the input's noise still holds
    the gate's envelope at −66 … −60 dBFS, so with the threshold alone the clean and the crunch
    presets (−70, −64) never closed, and none did on a hissy input. With `auto` the gate is shut
    on that noise from the first moment, lets a note through whole, and shuts again after it."""
    x = noise(14.0)
    note = pluck(1.0)
    played = x.copy()
    played[6 * SR : 7 * SR] += note

    out, opened = run_hum_and_gate(dsp.GateCore(SR, threshold_db=threshold, auto=True), played)
    assert not opened[: int(6 * PER_SECOND)].any()  # at rest, from the very start
    assert opened[int(6.01 * PER_SECOND) : int(6.9 * PER_SECOND)].all()  # the note
    assert not opened[int(8 * PER_SECOND) :].any()  # shut a second after it, for good
    assert rms_db(out[8 * SR :]) < -90
    # The note comes through: its ringing untouched (0.06 dB is the hum filter's), its attack with
    # the gate's own 1 ms of opening (this sawtooth starts at full height at once — no string does;
    # a real attack loses less).
    tenth = SR // 10
    assert rms_db(out[6 * SR + tenth : 7 * SR]) == pytest.approx(rms_db(note[tenth:]), abs=0.15)
    assert rms_db(out[6 * SR : 6 * SR + tenth]) == pytest.approx(rms_db(note[:tenth]), abs=1.0)


def test_without_auto_the_low_thresholds_never_close_on_that_noise():
    """The plain gate behind the hum filter, for the record: this is what «Шумодав сам» is for."""
    for threshold in (-70.0, -64.0):
        x = measured_noise(8.0)
        x[SR : 2 * SR] += pluck(1.0)
        _, opened = run_hum_and_gate(dsp.GateCore(SR, threshold_db=threshold), x)
        assert opened[int(4 * PER_SECOND) :].all()


def ts_noise(seconds: float, db: float, seed: int = 7) -> np.ndarray:
    """`noise()` of src/dsp/gate.test.ts, number for number (a Lehmer generator, uniform)."""
    amp = 10 ** (db / 20) * math.sqrt(3)
    out = np.empty(round(seconds * SR))
    for i in range(len(out)):
        seed = seed * 16807 % 2147483647
        out[i] = amp * (seed / 2147483647 * 2 - 1)
    return out.astype(np.float32)


# What src/dsp/gate.ts itself gives (GateCore, 48 kHz, threshold −70, auto), played in this order:
# name, the input, then (the floor in dB, the level that opens the gate in dB, open?).
TS_AUTO = (
    ("rest", lambda: ts_noise(7, -66, 7), (-62.086966493865845, -54.086966493865845, False)),
    ("a note", lambda: sine(0.3, -20, 200), (-62.086966493865845, -54.086966493865845, True)),
    ("rest again", lambda: ts_noise(3, -66, 9), (-62.09018033599865, -54.09018033599865, False)),
    ("a louder noise", lambda: ts_noise(6, -58, 13), (-54.081663130482276, -46.08166313048228, False)),
    ("a quieter one", lambda: ts_noise(1, -75, 17), (-71.06570845869078, -63.06570845869078, False)),
)


def test_auto_gate_matches_typescript():
    gate = dsp.GateCore(SR, threshold_db=-70, auto=True)
    # Before anything is heard: the floor the gate starts from, and the margin over it.
    assert gate.floor_db == pytest.approx(dsp.GATE_START_DB, abs=1e-9)
    assert gate.open_db == pytest.approx(dsp.GATE_START_DB + dsp.GATE_MARGIN_DB, abs=1e-9)
    for name, make, (floor_db, open_db, is_open) in TS_AUTO:
        run_gate(gate, make())
        assert gate.floor_db == pytest.approx(floor_db, abs=1e-6), name
        assert gate.open_db == pytest.approx(open_db, abs=1e-6), name
        assert gate.is_open is is_open, name


def test_auto_gate_keeps_to_the_preset_the_cap_and_the_off_position():
    quiet = hissy_noise(8.0)
    # Never lower than the preset asks.
    gate = dsp.GateCore(SR, threshold_db=-40, auto=True)
    run_gate(gate, quiet)
    assert gate.open_db == pytest.approx(-40.0, abs=1e-9)
    # Never higher than the cap, however loud a steady input is (feedback, an e-bow).
    gate = dsp.GateCore(SR, threshold_db=-70, auto=True)
    run_gate(gate, sine(8.0, -20, 220))
    assert gate.open_db == pytest.approx(dsp.GATE_CAP_DB, abs=1e-9)
    assert gate.is_open is True
    # «выкл» on the slider is off, whatever `auto` says.
    gate = dsp.GateCore(SR, threshold_db=dsp.GATE_OFF_DB, auto=True)
    out, _ = run_gate(gate, quiet)
    assert gate.is_open is True
    assert rms_db(out[SR:]) == pytest.approx(rms_db(quiet[SR:]), abs=0.01)
    # Switched off by hand it is the plain gate again; switched on, what it learned is back at once.
    gate = dsp.GateCore(SR, threshold_db=-70, auto=True)
    run_gate(gate, quiet)
    learned = gate.open_db
    assert learned > -56
    gate.set_auto(False)
    assert gate.open_db == pytest.approx(-70.0, abs=1e-9)
    gate.set_auto(True)
    assert gate.open_db == pytest.approx(learned, abs=1e-9)


def test_input_trim_gives_its_gain_glides_and_keeps_to_its_range():
    trim = dsp.InputTrim(SR)
    x = sine(0.5, -30.0, 110.0)
    y = x.copy()
    trim.process(y)
    assert np.array_equal(x, y)  # 0 dB until set: nothing is touched
    trim.set(16.0)
    trim.settle()
    y = x.copy()
    trim.process(y)
    assert rms_db(y) == pytest.approx(rms_db(x) + 16.0, abs=0.01)
    # A change glides (no step), and lands.
    trim.set(0.0)
    y = x.copy()
    for start in range(0, len(y), 128):
        trim.process(y[start : start + 128])
    assert float(np.max(np.abs(np.diff(y)))) < 1.05 * float(np.max(np.abs(np.diff(x)))) * 10 ** (16 / 20)
    assert rms_db(y[-SR // 10 :]) == pytest.approx(rms_db(x[-SR // 10 :]), abs=0.05)
    # Kept to −12 … +24 dB; nonsense is 0 dB.
    for asked, got in ((40.0, 24.0), (-30.0, -12.0), (float("nan"), 0.0)):
        trim.set(asked)
        trim.settle()
        y = x.copy()
        trim.process(y)
        assert rms_db(y) == pytest.approx(rms_db(x) + got, abs=0.01)


def test_auto_gate_moves_its_floor_with_the_channel_pick():
    """From both halves to the guitar's side everything doubles, the noise too (the app picks the
    side on the first note). Told so, the gate shuts after that note at once; untold it would stay
    open on the doubled noise until it had been steady for five seconds."""
    assert dsp.channel_step("both", "right") == 2.0
    assert dsp.channel_step("left", "both") == 0.5
    assert dsp.channel_step("left", "right") == 1.0
    assert dsp.channel_step("right", "right") == 1.0

    told = dsp.GateCore(SR, threshold_db=-70, auto=True)
    untold = dsp.GateCore(SR, threshold_db=-70, auto=True)
    for gate in (told, untold):
        run_gate(gate, hissy_noise(8.0) * np.float32(0.5))
    before = told.floor_db
    told.scale_floor(2.0)
    assert told.floor_db == pytest.approx(before + 20 * math.log10(2), abs=1e-9)
    after = hissy_noise(4.0)
    after[:SR] += pluck(1.0)
    run_gate(told, after)
    run_gate(untold, after)
    assert told.is_open is False
    assert untold.is_open is True
    # Nonsense is ignored.
    told.scale_floor(0.0)
    told.scale_floor(float("nan"))
    assert told.floor_db == pytest.approx(before + 20 * math.log10(2), abs=1.0)


def test_auto_gate_does_not_take_a_ringing_chord_for_noise():
    """A chord left to ring is flat like noise, but it fades: the floor stays where the noise is,
    and the chord rings down to it."""
    gate = dsp.GateCore(SR, threshold_db=-70, auto=True)
    x = measured_noise(20.0)
    t = np.arange(12 * SR) / SR
    x[8 * SR :] += (10 ** ((-12 - 3 * t) / 20) * np.sin(2 * np.pi * 147.0 * t)).astype(np.float32)
    _, opened = run_hum_and_gate(gate, x)
    assert not opened[: int(8 * PER_SECOND)].any()
    # Open while the chord is over the noise: from −12 down to −48 dBFS, twelve seconds of ringing.
    assert opened[int(8.01 * PER_SECOND) : int(20 * PER_SECOND)].all()
    at_rest = dsp.GateCore(SR, threshold_db=-70, auto=True)
    run_hum_and_gate(at_rest, measured_noise(8.0))
    assert gate.floor_db == pytest.approx(at_rest.floor_db, abs=1.0)


# --- EQ: the Web Audio biquad formulas, written out from the specification ---


def webaudio_response_db(kind: str, f0: float, gain_db: float, q: float, freqs: np.ndarray) -> np.ndarray:
    a = 10 ** (gain_db / 40)
    w0 = 2 * math.pi * f0 / SR
    cos, sin = math.cos(w0), math.sin(w0)
    if kind == "lowshelf":
        alpha = sin / 2 * math.sqrt((a + 1 / a) * (1 / 1 - 1) + 2)
        k = 2 * alpha * math.sqrt(a)
        b = (a * ((a + 1) - (a - 1) * cos + k), 2 * a * ((a - 1) - (a + 1) * cos), a * ((a + 1) - (a - 1) * cos - k))
        den = ((a + 1) + (a - 1) * cos + k, -2 * ((a - 1) + (a + 1) * cos), (a + 1) + (a - 1) * cos - k)
    elif kind == "highshelf":
        alpha = sin / 2 * math.sqrt((a + 1 / a) * (1 / 1 - 1) + 2)
        k = 2 * alpha * math.sqrt(a)
        b = (a * ((a + 1) + (a - 1) * cos + k), -2 * a * ((a - 1) + (a + 1) * cos), a * ((a + 1) + (a - 1) * cos - k))
        den = ((a + 1) - (a - 1) * cos + k, 2 * ((a - 1) - (a + 1) * cos), (a + 1) - (a - 1) * cos - k)
    else:  # peaking
        alpha = sin / (2 * q)
        b = (1 + alpha * a, -2 * cos, 1 - alpha * a)
        den = (1 + alpha / a, -2 * cos, 1 - alpha / a)
    z = np.exp(-1j * 2 * np.pi * freqs / SR)
    h = (b[0] + b[1] * z + b[2] * z * z) / (den[0] + den[1] * z + den[2] * z * z)
    return 20 * np.log10(np.abs(h))


def test_eq_response_matches_webaudio():
    freqs = np.array([60.0, 120.0, 750.0, 3000.0, 8000.0])
    bass, mid, treble = 6.0, -4.0, 3.0
    want = (
        webaudio_response_db("lowshelf", 120, bass, 1, freqs)
        + webaudio_response_db("peaking", 750, mid, 0.8, freqs)
        + webaudio_response_db("highshelf", 3000, treble, 1, freqs)
    )
    eq = dsp.Eq(SR)
    eq.set(bass, mid, treble)
    eq.settle()
    impulse = np.zeros(128 * 256, dtype=np.float32)
    impulse[0] = 1.0
    h = np.zeros_like(impulse)
    for start in range(0, len(impulse), 128):
        eq.process(impulse[start : start + 128], h[start : start + 128])
    n = np.arange(len(h))
    got = np.array([20 * math.log10(abs(np.sum(h * np.exp(-2j * np.pi * f / SR * n)))) for f in freqs])
    assert np.max(np.abs(got - want)) < 0.05, (got, want)
    # The shelves do what they are named for.
    assert got[0] > 4 and got[4] > 2 and got[2] < -3


def test_eq_gains_are_clamped_and_glide():
    eq = dsp.Eq(SR)
    eq.set(40.0, 0.0, -40.0)
    assert eq.targets == (12.0, 0.0, -12.0)
    x = sine(0.5, -20, 60)
    y = np.zeros_like(x)
    for start in range(0, len(x) - 127, 128):
        eq.process(x[start : start + 128], y[start : start + 128])
    # +12 dB of bass arrives over tens of milliseconds, not in one block.
    first = rms_db(y[:480]) - rms_db(x[:480])
    last = rms_db(y[19200:23040]) - rms_db(x[19200:23040])
    assert first < 3.0
    assert 9.0 < last < 12.5
    # No click on the way: the steps stay those of a (louder) 60 Hz sine.
    assert float(np.max(np.abs(np.diff(y[:23040])))) < 4.5 * float(np.max(np.abs(np.diff(x))))


# --- the curves of src/dsp/curves.ts ---


def ts_soft_clip(x: float, knee: float = 0.7) -> float:
    room = 1 - knee
    a = abs(x)
    return x if a <= knee else math.copysign(knee + room * math.tanh((a - knee) / room), x)


def ts_drive(x: float, asymmetry: float = 0.15, hardness: float = 2.5) -> float:
    return math.tanh(hardness * (x + asymmetry * x * x)) / math.tanh(hardness * (1 + asymmetry))


def test_softclip_and_drive_curves_match():
    xs = np.linspace(-1.0, 1.0, 50)
    for x in xs:
        assert dsp.soft_clip(float(x)) == pytest.approx(ts_soft_clip(float(x)), abs=1e-9)
        assert dsp.drive_curve(float(x)) == pytest.approx(ts_drive(float(x)), abs=1e-9)
    # The tables the browser gives its WaveShaperNodes.
    soft = dsp.make_soft_clip_curve()
    drive = dsp.make_drive_curve()
    assert soft.dtype == np.float32 and len(soft) == 2048
    assert drive.dtype == np.float32 and len(drive) == 4096
    for i in np.linspace(0, 2047, 50).astype(int):
        assert soft[i] == pytest.approx(ts_soft_clip(i / 2047 * 2 - 1), abs=1e-6)
    for i in np.linspace(0, 4095, 50).astype(int):
        assert drive[i] == pytest.approx(ts_drive(i / 4095 * 2 - 1), abs=1e-6)
    # A WaveShaperNode holds its curve's ends beyond ±1: so do the kernels.
    assert dsp.soft_clip(3.0) == pytest.approx(ts_soft_clip(1.0), abs=1e-9)
    assert dsp.drive_curve(-3.0) == pytest.approx(ts_drive(-1.0), abs=1e-9)


# --- the reverb's convolver: long IRs, no latency ---


def run_reverb(reverb: ReverbConvolver, x: np.ndarray, block: int) -> np.ndarray:
    """`x` is (2, n) with n a multiple of `block`."""
    y = np.zeros_like(x)
    wet = np.zeros((2, block), dtype=np.float32)
    for start in range(0, x.shape[1], block):
        send = np.ascontiguousarray(x[:, start : start + block])
        reverb.process(send, wet, not send.any())
        y[:, start : start + block] = wet
    return y


@pytest.mark.parametrize("block", [128, 64, 256])
@pytest.mark.parametrize("channels", [1, 2])
def test_reverb_equals_direct_convolution(block, channels):
    rng = np.random.default_rng(block + channels)
    # Longer than all three partition sizes need, and not a multiple of anything.
    ir = (rng.standard_normal((block * 150 + 37, channels)) * 0.05).astype(np.float32)
    x = (rng.standard_normal((2, block * 400)) * 0.1).astype(np.float32)
    x[:, block * 90 : block * 130] = 0  # a pause in the playing
    y = run_reverb(ReverbConvolver(ir, block), x, block)
    for ch in range(2):
        want = np.convolve(x[ch].astype(np.float64), ir[:, ch % channels].astype(np.float64))[: x.shape[1]]
        assert np.max(np.abs(y[ch] - want)) < 2e-4, ch


def test_reverb_short_ir_and_silence():
    ir = np.zeros((300, 1), dtype=np.float32)
    ir[0, 0] = 0.5
    ir[299, 0] = -0.25
    reverb = ReverbConvolver(ir, 128)
    x = np.zeros((2, 128 * 40), dtype=np.float32)
    x[0, 5] = 1.0
    x[1, 700] = 1.0
    y = run_reverb(reverb, x, 128)
    assert y[0, 5] == pytest.approx(0.5, abs=1e-5) and y[0, 304] == pytest.approx(-0.25, abs=1e-5)
    assert y[1, 700] == pytest.approx(0.5, abs=1e-5) and y[1, 999] == pytest.approx(-0.25, abs=1e-5)
    assert np.sum(np.abs(y) > 1e-4) == 4
    # Long after the last sound it rests, and wakes up exactly where it should.
    quiet = np.zeros((2, 128 * 300), dtype=np.float32)
    assert not run_reverb(reverb, quiet, 128).any()
    assert reverb.idle is True
    again = run_reverb(reverb, x, 128)
    assert again[0, 5] == pytest.approx(0.5, abs=1e-5) and again[1, 999] == pytest.approx(-0.25, abs=1e-5)


def test_convolver_normalization_is_webaudio_s():
    rng = np.random.default_rng(3)
    ir = (rng.standard_normal((4800, 2)) * 0.1).astype(np.float32)
    power = math.sqrt(float(np.mean(ir.astype(np.float64) ** 2)))
    assert convolver_normalization(ir, 48000) == pytest.approx(0.00125 / power * 44100 / 48000, rel=1e-6)
    # A silent response does not blow the gain up.
    assert convolver_normalization(np.zeros((100, 1), dtype=np.float32), 48000) == pytest.approx(
        0.00125 / 0.000125 * 44100 / 48000, rel=1e-6
    )


# --- chorus and delay ---


def run_post(fx: dsp.PostFx, x: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    post = np.zeros((2, len(x)), dtype=np.float32)
    send = np.zeros_like(post)
    p = np.zeros((2, 128), dtype=np.float32)
    s = np.zeros((2, 128), dtype=np.float32)
    for start in range(0, len(x), 128):
        fx.process(x[start : start + 128], p, s)
        post[:, start : start + 128] = p
        send[:, start : start + 128] = s
    return post, send


def test_effects_off_pass_the_guitar_through():
    fx = dsp.PostFx(SR)
    fx.set_chorus(False, 0.8, 0.5, 0.5)
    fx.set_delay(False, 380, 0.3, 0.2)
    fx.set_reverb(False, 0.2)
    fx.settle()
    x = sine(0.5, -20, 220)[: 128 * 180]
    post, send = run_post(fx, x)
    assert np.array_equal(post[0], x) and np.array_equal(post[1], x)
    assert not send.any()


def test_delay_repeats_at_its_time_and_darkens():
    fx = dsp.PostFx(SR)
    fx.set_chorus(False, 0.8, 0.5, 0.5)
    fx.set_delay(True, 250, 0.5, 1.0)
    fx.set_reverb(True, 0.5)
    fx.settle()
    x = np.zeros(128 * 300, dtype=np.float32)
    x[:480] = sine(0.01, -6, 1000)
    post, send = run_post(fx, x)
    step = round(0.25 * SR)
    dry = rms_db(post[0, :480])
    first = rms_db(post[0, step : step + 600])
    second = rms_db(post[0, 2 * step : 2 * step + 700])
    assert rms_db(post[0, 2000 : step - 100]) < -100  # nothing before the first repeat
    assert dry - 4 < first < dry  # 1 kHz passes the 120–3500 Hz loop almost whole
    assert first - 9 < second < first - 5  # feedback 0.5 = −6 dB a repeat
    assert np.array_equal(post[0], post[1])
    assert np.allclose(send, post * np.float32(0.4), atol=1e-7)  # the reverb send: mix · 0.8

    # Off: nothing new goes in, the repeats ring out.
    fx.set_delay(False, 250, 0.5, 1.0)
    quiet, _ = run_post(fx, np.zeros(128 * 300, dtype=np.float32))
    assert rms_db(quiet[0, :step]) > -80
    assert rms_db(quiet[0, -step:]) < rms_db(quiet[0, :step]) - 10


def test_chorus_spreads_left_and_right():
    fx = dsp.PostFx(SR)
    fx.set_chorus(True, 0.8, 0.55, 0.5)
    fx.set_delay(False, 380, 0.3, 0.2)
    fx.set_reverb(False, 0.2)
    fx.settle()
    x = sine(2.0, -20, 440)[: 128 * 700]
    post, _ = run_post(fx, x)
    tail = slice(48000, None)
    assert not np.allclose(post[0, tail], post[1, tail], atol=1e-3)
    # dry 1 − 0.3·mix plus the wet voice: about as loud as the guitar alone.
    for ch in range(2):
        assert abs(rms_db(post[ch, tail]) - rms_db(x[tail])) < 3.5
    # The two voices swing in opposite directions around 12 ms: 12 ± 4.5 ms at the deepest.
    impulse = np.zeros(128 * 20, dtype=np.float32)
    impulse[0] = 1.0
    deep = dsp.PostFx(SR)
    deep.set_chorus(True, 5.0, 1.0, 1.0)
    deep.set_delay(False, 380, 0.3, 0.2)
    deep.set_reverb(False, 0.2)
    deep.settle()
    wet, _ = run_post(deep, impulse)
    assert wet[0, 0] == pytest.approx(0.7, abs=1e-6)  # the dry part: 1 − 0.3·mix
    for ch in range(2):
        at = np.flatnonzero(np.abs(wet[ch, 1:]) > 0.05) + 1
        assert len(at) and 0.0075 * SR - 1 <= at.min() and at.max() <= 0.0165 * SR + 1


@pytest.mark.parametrize("phase", [0, 10, 13])
def test_cabinet_convolver_equals_the_uniform_one(phase):
    from kv_guitar.convolve import PartitionedConvolver
    from kv_guitar.reverb import CabinetConvolver

    rng = np.random.default_rng(7)
    ir = (rng.standard_normal(24000) * np.exp(-np.arange(24000) / 3000) * 0.05).astype(np.float32)
    x = (rng.standard_normal(128 * 300) * 0.1).astype(np.float32)
    uniform = PartitionedConvolver(ir, 128)
    zoned = CabinetConvolver(ir, 128)
    zoned.align(phase)  # wherever its big transforms fall, the sound is the same
    want = np.zeros_like(x)
    got = np.zeros_like(x)
    row = np.zeros((1, 128), dtype=np.float32)
    for start in range(0, len(x), 128):
        uniform.process(x[start : start + 128], want[start : start + 128])
        row[0] = x[start : start + 128]
        zoned.process(row, row)  # in place, as the chain does
        got[start : start + 128] = row[0]
    assert np.max(np.abs(got - want)) < 1e-5
    with pytest.raises(RuntimeError):
        zoned.align(3)  # only before the first block


def test_reverb_rests_and_resumes_with_a_long_response():
    rng = np.random.default_rng(11)
    ir = (rng.standard_normal((128 * 40 + 5, 2)) * 0.05).astype(np.float32)  # all three zones
    reverb = ReverbConvolver(ir, 128)
    x = np.zeros((2, 128 * 500), dtype=np.float32)
    x[:, : 128 * 30] = rng.standard_normal((2, 128 * 30)) * 0.1
    x[:, 128 * 403 + 7 :] = rng.standard_normal((2, 128 * 97 - 7)) * 0.1  # back after a long rest
    y = np.zeros_like(x)
    wet = np.zeros((2, 128), dtype=np.float32)
    rested = False
    for start in range(0, x.shape[1], 128):
        send = np.ascontiguousarray(x[:, start : start + 128])
        reverb.process(send, wet, not send.any())
        rested = rested or reverb.idle
        y[:, start : start + 128] = wet
    assert rested
    for ch in range(2):
        want = np.convolve(x[ch].astype(np.float64), ir[:, ch].astype(np.float64))[: x.shape[1]]
        assert np.max(np.abs(y[ch] - want)) < 2e-4


def test_a_cloned_convolver_is_fresh_and_independent():
    rng = np.random.default_rng(12)
    ir = (rng.standard_normal((128 * 40, 2)) * 0.05).astype(np.float32)
    x = (rng.standard_normal((2, 128 * 120)) * 0.1).astype(np.float32)
    first = ReverbConvolver(ir, 128)
    a = run_reverb(first, x, 128)
    copy_ = first.clone()  # made while the first one is full of sound
    assert copy_.idle and type(copy_) is ReverbConvolver
    b = run_reverb(copy_, x, 128)
    assert np.array_equal(a, b)
    assert np.shares_memory(first._h, copy_._h) and not np.shares_memory(first._ring, copy_._ring)


# --- «Фильтр гула» ----------------------------------------------------------------------------------


def run_hum(hum: dsp.HumFilter, x: np.ndarray) -> np.ndarray:
    out = np.zeros_like(x)
    for start in range(0, len(x), 128):
        hum.process(x[start : start + 128], out[start : start + 128])
    return out


def hum_on() -> dsp.HumFilter:
    hum = dsp.HumFilter(SR)
    hum.set_on(True)
    hum.settle()
    return hum


@pytest.mark.parametrize("harmonic", [1, 2, 3, 4, 5, 6])
def test_hum_filter_takes_the_mains_hum_out(harmonic):
    x = sine(4.0, -55.0, 50.0 * harmonic)
    y = run_hum(hum_on(), x)
    # After the notch has settled (its time constant is about 160 ms).
    assert rms_db(y[SR:]) < rms_db(x[SR:]) - 40


@pytest.mark.parametrize(("freq", "most_db"), [(82.41, 0.1), (98.0, 1.1), (110.0, 0.2), (146.83, 0.5), (196.0, 0.4), (329.63, 0.1)])
def test_hum_filter_leaves_the_notes(freq, most_db):
    x = sine(3.0, -20.0, freq)
    y = run_hum(hum_on(), x)
    assert rms_db(y[SR:]) == pytest.approx(rms_db(x[SR:]), abs=most_db)


def test_hum_filter_off_changes_nothing_and_switches_without_a_click():
    x = sine(2.0, -12.0, 110.0) + sine(2.0, -40.0, 50.0)
    off = dsp.HumFilter(SR)
    assert np.array_equal(run_hum(off, x), x)
    # On in the middle of a note: no jump bigger than the note's own steps.
    hum = dsp.HumFilter(SR)
    y = np.zeros_like(x)
    half = len(x) // 2 // 128 * 128
    for start in range(0, len(x), 128):
        if start == half:
            hum.set_on(True)
        hum.process(x[start : start + 128], y[start : start + 128])
    assert np.max(np.abs(np.diff(y))) <= np.max(np.abs(np.diff(x))) * 1.05
    # The 50 Hz part is gone (its amplitude over the last half second: 25 whole cycles), the note stays.
    tail = y[-SR // 2 :].astype(np.float64)
    t = np.arange(len(tail)) / SR
    hum_left = abs(np.dot(tail, np.exp(-2j * np.pi * 50.0 * t))) * 2 / len(tail)
    assert 20 * math.log10(hum_left) < -40 - 30
    assert rms_db(tail) == pytest.approx(-12.0, abs=0.3)


@pytest.mark.parametrize("harmonic", [1, 2, 3, 6])
def test_hum_filter_on_60_hz_mains_takes_that_hum_out(harmonic):
    hum = hum_on()
    hum.set_mains(60)
    x = sine(4.0, -55.0, 60.0 * harmonic)
    y = run_hum(hum, x)
    assert rms_db(y[SR:]) < rms_db(x[SR:]) - 40


def test_hum_filter_on_60_hz_mains_leaves_50_hz_alone():
    # A note near the old notch (G2 is 98 Hz, the 50 Hz filter's 100 Hz notch) is not touched any more.
    hum = hum_on()
    hum.set_mains(60)
    x = sine(3.0, -20.0, 100.0)
    y = run_hum(hum, x)
    assert rms_db(y[SR:]) == pytest.approx(rms_db(x[SR:]), abs=0.2)
