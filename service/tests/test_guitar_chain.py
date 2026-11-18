"""The whole amp chain (kv_guitar.chain): presets, loudness, switching, loading, speed."""

import copy
import gc
import io
import math
import sys
import time

import numpy as np
import pytest
import soundfile as sf

from guitar_presets import default_presets, first_presets
from kv_guitar.assets import AssetStore, nam_wasm_path, repo_root
from kv_guitar.chain import Chain
from test_guitar_dsp import PRESET_GATES, hissy_noise, measured_noise, pluck

SR = 48000
BLOCK = 128
TONES = repo_root() / "public" / "tones"

pytestmark = pytest.mark.skipif(
    not (TONES / "models" / "jcm.nam").exists() or not nam_wasm_path().exists(),
    reason="public/tones or public/nam is missing: run npm run setup",
)

PRESETS = default_presets()
# The browser's levels below were measured with the first presets (the TONE3000 demo amps, no hum filter).
FIRST = first_presets()


def make_chain() -> Chain:
    chain = Chain(SR, BLOCK, AssetStore(TONES))
    chain.set_channel("right")
    chain.set_master(0.0, False)
    return chain


def load(chain: Chain, preset: dict, tone_offsets: dict | None = None) -> None:
    chain.apply_preset(preset, tone_offsets)
    assert chain.wait_idle(20.0)


def plucks(seconds: float, peak_db: float = -9.0, hz: float = 110.0) -> np.ndarray:
    """A guitar-like signal: sawtooth plucks twice a second, a sharp attack and a ringing tail.

    Stereo blocks with the guitar on the right, like input 2 of the card.
    """
    count = int(seconds * SR) // BLOCK * BLOCK
    t = np.arange(count) / SR
    saw = 2 * ((t * hz) % 1.0) - 1
    since = t % 0.5
    envelope = 0.75 * np.exp(-40 * since) + 0.25 * np.exp(-2 * since)
    mono = saw * envelope
    mono *= 10 ** (peak_db / 20) / np.max(np.abs(mono))
    stereo = np.zeros((count, 2), dtype=np.float32)
    stereo[:, 1] = mono
    return stereo


def run(chain: Chain, x: np.ndarray) -> np.ndarray:
    y = np.zeros_like(x)
    out = np.zeros((BLOCK, 2), dtype=np.float32)
    for start in range(0, len(x), BLOCK):
        chain.process(x[start : start + BLOCK], out)
        y[start : start + BLOCK] = out
    return y


def rms_db(x: np.ndarray) -> float:
    return float(10 * np.log10(np.mean(np.square(x, dtype=np.float64)) + 1e-30))


def mono_of(y: np.ndarray) -> np.ndarray:
    # What the browser's output analyser sees of a stereo signal.
    return (y[:, 0] + y[:, 1]) / 2


# What the browser's own chain gives for `plucks()` (looped, the guitar on the right, master 0 dB):
# the committed app (d0c016e) in Chrome with tools/browser-fake-input.js, `__kvEngine.readOutputDb`
# read every 37 ms for 12 s and averaged as power; (RMS, peak) in dBFS. Measured 12 Nov 2026 with
# the output trim at +3 dB; it is 0 since 16 Nov (3 dB of headroom), so these are those numbers
# minus 3 dB: a gain before the soft clip, the same in both chains.
#
# The presets are levelled for a real DI recording (−21 dB RMS, «Соло» −19.5): a synthetic pluck
# is not one, and lands elsewhere — in the browser exactly as here.
BROWSER_LEVELS = {
    "clean-chorus": (-22.50, -5.79),
    "crunch": (-24.58, -11.70),
    "drive": (-16.63, -10.72),
    "solo": (-24.77, -16.10),
}
# The presets with the amps of 2026-11-16 (captures of real amps, levelled on a real DI to the
# first presets' loudness) and the hum filter, on `plucks()`: a bright sawtooth, which these amps
# take differently from the demo ones (the drive is 7 dB quieter on it, the solo 5.6 dB louder,
# while on the DI each is within 0.2 dB of the first). In the browser (16 Nov, Chrome, the fake input
# playing the DI at −9 dBFS peak, 0.5–10.5 s) every new preset read within 0.25 dB of this chain.
NEW_AMP_LEVELS = {
    "clean-chorus": (-22.58, -4.22),
    "crunch": (-23.22, -11.32),
    "drive": (-23.68, -12.14),
    "solo": (-18.72, -12.72),
}
# The same for presets changed in one place: every block of the chain against the browser.
BROWSER_VARIANTS = {
    "the simple amp": ("drive", {"amp": {"model": "simple"}}, (-16.51, -5.88)),
    "EQ at its ends": (
        "clean-chorus",
        {"amp": {"bass": 12, "mid": -6, "treble": -12}, "chorus": {"on": False}, "reverb": {"on": False}},
        # Its peaks go into the soft clip: with the headroom less deep, so measured in this chain.
        (-15.56, -1.44),
    ),
    "no cabinet": ("drive", {"cab": "none", "reverb": {"on": False}}, (-16.34, -10.46)),
    "a 44.1 kHz cabinet": ("drive", {"cab": "ir:eminence", "reverb": {"on": False}}, (-15.18, -9.99)),
    "a long echo": (
        "crunch",
        {"delay": {"on": True, "timeMs": 250, "feedback": 0.6, "mix": 0.5}, "reverb": {"on": False}},
        (-22.77, -9.98),
    ),
    "a lot of spring": ("crunch", {"reverb": {"on": True, "type": "spring", "mix": 0.8}}, (-22.68, -12.26)),
    "the slim model": ("drive", {"amp": {"slim": True}, "reverb": {"on": False}}, (-16.92, -11.15)),
    "«Соло» without reverb": ("solo", {"reverb": {"on": False}}, (-25.16, -15.96)),
    "«Соло» without delay": ("solo", {"delay": {"on": False}}, (-22.39, -15.21)),
}


def looped_levels(chain: Chain) -> tuple[float, float]:
    """(RMS, peak) of the mono mix over one pass of the plucks, after a pass to settle."""
    x = plucks(4.0)
    run(chain, x)
    mono = mono_of(run(chain, x))
    return rms_db(mono), 20 * math.log10(float(np.max(np.abs(mono))))


@pytest.mark.parametrize("preset_id", list(BROWSER_LEVELS))
def test_calibration_drive_preset(preset_id):
    chain = make_chain()
    load(chain, FIRST[preset_id])
    assert chain.amp_state == ("ready", None)
    level, peak = looped_levels(chain)
    want_level, want_peak = BROWSER_LEVELS[preset_id]
    print(f"{preset_id}: {level:.2f} dB RMS, peak {peak:.2f} (the browser: {want_level}, {want_peak})")
    assert level == pytest.approx(want_level, abs=0.3)
    if not FIRST[preset_id]["chorus"]["on"]:  # with the chorus the peak depends on where its LFO is
        assert peak == pytest.approx(want_peak, abs=0.3)
    meter_peak, meter_rms = chain.out_levels()
    assert -40 < meter_rms < meter_peak <= 0


@pytest.mark.parametrize("name", list(BROWSER_VARIANTS))
def test_chain_matches_the_browser(name):
    preset_id, patch, (want_level, want_peak) = BROWSER_VARIANTS[name]
    preset = copy.deepcopy(FIRST[preset_id])
    for key, value in patch.items():
        if isinstance(value, dict):
            preset[key].update(value)
        else:
            preset[key] = value
    chain = make_chain()
    load(chain, preset)
    assert chain.amp_state == ("ready", None)
    level, peak = looped_levels(chain)
    print(f"{name}: {level:.2f} dB RMS, peak {peak:.2f} (the browser: {want_level}, {want_peak})")
    assert level == pytest.approx(want_level, abs=0.3)
    assert peak == pytest.approx(want_peak, abs=0.3)


def test_preset_switch_no_click():
    chain = make_chain()
    load(chain, PRESETS["crunch"])
    x = plucks(6.0)
    half = len(x) // 2 // BLOCK * BLOCK
    # Each preset alone: the largest step its own sound makes.
    own = 0.0
    for preset_id in ("crunch", "solo"):
        alone = make_chain()
        load(alone, PRESETS[preset_id])
        own = max(own, float(np.max(np.abs(np.diff(run(alone, x), axis=0)))))

    first = run(chain, x[:half])
    chain.apply_preset(PRESETS["solo"], None)  # same model: nothing to load, the knobs glide
    second = run(chain, x[half:])
    chain.apply_preset(PRESETS["crunch"], None)
    third = run(chain, x[:half])
    steps = float(np.max(np.abs(np.diff(np.concatenate([first, second, third]), axis=0))))
    print(f"largest step while switching {steps:.4f}, of the presets alone {own:.4f}")
    assert steps <= own + 0.1
    assert chain.amp_state == ("ready", None)


def test_model_and_cabinet_swap_crossfade():
    chain = make_chain()
    load(chain, PRESETS["crunch"])
    x = plucks(2.0)
    run(chain, x)
    own = 0.0
    for preset_id in ("crunch", "drive"):
        alone = make_chain()
        load(alone, PRESETS[preset_id])
        own = max(own, float(np.max(np.abs(np.diff(run(alone, x), axis=0)))))
    chain.apply_preset(PRESETS["drive"], None)  # another model, cabinet and reverb
    pieces = []
    out = np.zeros((BLOCK, 2), dtype=np.float32)
    for start in range(0, len(x), BLOCK):  # the loads land while the guitar plays
        chain.process(x[start : start + BLOCK], out)
        pieces.append(out.copy())
        time.sleep(0.001)
    assert chain.wait_idle(20.0)
    pieces.append(run(chain, x))
    y = np.concatenate(pieces)
    assert np.all(np.isfinite(y))
    assert float(np.max(np.abs(np.diff(y, axis=0)))) <= own + 0.1
    assert chain.amp_state == ("ready", None)
    assert rms_db(mono_of(y)[-SR:]) == pytest.approx(NEW_AMP_LEVELS["drive"][0], abs=0.5)


def test_stale_model_load_is_dropped():
    chain = make_chain()
    loaded: list[str] = []
    original = chain.assets.model_json

    def spy(asset_id: str) -> str:
        loaded.append(asset_id)
        return original(asset_id)

    chain.assets.model_json = spy
    started = time.perf_counter()
    for model in ("nam:jc", "nam:jcm", "nam:dumble"):
        preset = copy.deepcopy(PRESETS["solo"])
        preset["amp"]["model"] = model
        chain.apply_preset(preset, None)
    assert time.perf_counter() - started < 0.05  # apply_preset does not wait for the loads
    assert chain.amp_state[0] in ("loading", "ready")
    assert chain.wait_idle(20.0)
    assert chain.amp_state == ("ready", None)
    assert chain.model == "nam:dumble"
    assert loaded[-1] == "nam:dumble"

    # And it is the Dumble that plays: the same sound as a chain that only ever had it.
    fresh = make_chain()
    preset = copy.deepcopy(PRESETS["solo"])
    preset["amp"]["model"] = "nam:dumble"
    load(fresh, preset)
    x = plucks(1.0)
    assert np.allclose(run(chain, x)[SR // 2 :], run(fresh, x)[SR // 2 :], atol=1e-4)


def test_unknown_user_asset_raises_keyerror():
    store = AssetStore(TONES)
    with pytest.raises(KeyError):
        store.model_json("user:nope")
    with pytest.raises(KeyError):
        store.ir("user:nope")

    chain = Chain(SR, BLOCK, store)
    preset = copy.deepcopy(PRESETS["drive"])
    preset["cab"] = "user:my-cab"
    with pytest.raises(KeyError) as caught:
        chain.apply_preset(preset, None)
    assert caught.value.args[0] == "user:my-cab"
    assert chain.amp_state == ("idle", None)  # nothing was started

    # The browser sends the file, the engine applies the preset again.
    buffer = io.BytesIO()
    taps = np.zeros(2000, dtype=np.float32)
    taps[0] = 1.0
    sf.write(buffer, taps, SR, format="WAV", subtype="FLOAT")
    store.put_user("user:my-cab", "ir", buffer.getvalue())
    preset["amp"]["model"] = "user:my-amp"
    with pytest.raises(KeyError) as caught:
        chain.apply_preset(preset, None)
    assert caught.value.args[0] == "user:my-amp"
    store.put_user("user:my-amp", "model", (TONES / "models" / "jcm.nam").read_bytes())
    load(chain, preset)
    assert chain.amp_state == ("ready", None)
    assert chain.take_warnings() == []


def test_bad_model_falls_back_to_the_simple_amp():
    store = AssetStore(TONES)
    store.put_user("user:broken", "model", b"{}")
    chain = Chain(SR, BLOCK, store)
    chain.set_channel("right")
    preset = copy.deepcopy(PRESETS["drive"])
    preset["amp"]["model"] = "user:broken"
    load(chain, preset)
    state, message = chain.amp_state
    assert state == "fallback"
    assert message["code"] == "amp.modelFailed" and message["params"]["reason"]
    y = run(chain, plucks(2.0))
    assert np.all(np.isfinite(y))
    assert -40 < rms_db(mono_of(y)[SR:]) < -6  # the simple amp plays

    simple = copy.deepcopy(PRESETS["drive"])
    simple["amp"]["model"] = "simple"
    load(chain, simple)
    assert chain.amp_state == ("ready", None)
    assert -40 < rms_db(mono_of(run(chain, plucks(1.0)))[SR // 2 :]) < -6


def test_missing_tones_say_run_setup(tmp_path):
    chain = Chain(SR, BLOCK, AssetStore(tmp_path))
    load(chain, PRESETS["drive"])
    state, message = chain.amp_state
    assert state == "fallback" and message == {"code": "program.filesMissing", "params": {}}
    warnings = chain.take_warnings()
    assert warnings == [{"code": "program.filesMissing", "params": {}}] * 2  # the cabinet, the reverb
    assert np.all(np.isfinite(run(chain, plucks(0.5))))


def test_master_mute_and_channel():
    chain = make_chain()
    load(chain, PRESETS["drive"])
    x = plucks(1.0)
    loud = rms_db(run(chain, x)[SR // 2 :])
    chain.set_master(-12.0, False)
    quieter = rms_db(run(chain, x)[SR // 2 :])
    assert quieter == pytest.approx(loud - 12, abs=1.5)
    chain.set_master(-12.0, True)
    y = run(chain, x)
    assert float(np.max(np.abs(np.diff(y, axis=0)))) < 0.2  # the mute glides too
    assert rms_db(y[SR // 2 :]) < -100
    assert chain.out_levels()[1] < -100
    chain.set_master(0.0, False)
    chain.set_channel("left")  # the guitar is on the right: nothing but the reverb's tail
    run(chain, x)
    assert rms_db(run(chain, plucks(4.0))[-SR:]) < -80
    with pytest.raises(ValueError):
        chain.set_channel("middle")


def test_tone_offsets_move_the_eq():
    chain = make_chain()
    preset = copy.deepcopy(PRESETS["clean-chorus"])
    load(chain, preset, None)
    x = plucks(2.0)
    flat = rms_db(run(chain, x)[SR:])
    chain.apply_preset(preset, {"bass": -30.0, "mid": -30.0, "treble": -30.0})  # clamped to −12 each
    assert chain.wait_idle(1.0)
    cut = rms_db(run(chain, x)[SR:])
    assert flat - 14 < cut < flat - 6


def test_preloaded_presets_switch_without_loading():
    chain = make_chain()
    order = ["clean-chorus", "crunch", "drive", "solo"]
    chain.preload([PRESETS[preset_id] for preset_id in order])
    loaded = dict(chain.loads)
    assert loaded == {"model": 4, "cab": 2, "reverb": 2}  # twin, jcm2000, jcm900, shirley; celestion, mesa; spring, plate
    chain.apply_preset(PRESETS["solo"], None)
    assert chain.amp_state == ("ready", None)  # at once: nothing to wait for
    assert chain.wait_idle(0.0)

    x = plucks(4.0)
    blocks = len(x) // BLOCK
    out = np.zeros((BLOCK, 2), dtype=np.float32)

    def play(count: int, switch_every: int = 0) -> tuple[np.ndarray, float]:
        times = np.zeros(count, dtype=np.int64)
        step = 0.0
        last = None
        for index in range(count):
            if switch_every and index % switch_every == 0:
                chain.apply_preset(PRESETS[order[(index // switch_every) % 4]], None)
                assert chain.amp_state == ("ready", None)
            block = x[index % blocks * BLOCK :][:BLOCK]
            t0 = time.perf_counter_ns()
            chain.process(block, out)
            times[index] = time.perf_counter_ns() - t0
            if last is not None:
                step = max(step, float(np.max(np.abs(out[0] - last))))
            step = max(step, float(np.max(np.abs(np.diff(out, axis=0)))))
            last = out[-1].copy()
        return times / 1e6, step

    play(1500)
    gc.collect()
    gc.disable()
    try:
        before, _ = play(3000)
        # A pedal pressed every 64 ms for 8 s: 125 switches round the four presets, each a new
        # model, and most a new cabinet or reverb too.
        storm, step = play(3000, switch_every=24)
        after, _ = play(3000)
    finally:
        gc.enable()
    assert chain.loads == loaded  # not one model, cabinet or reverb was loaded
    assert chain._loader is None
    steady = max(float(np.percentile(before, 99)), float(np.percentile(after, 99)))
    stormy = float(np.percentile(storm, 99))
    print(
        f"p99 per block: steady {np.percentile(before, 99):.3f} / {np.percentile(after, 99):.3f} ms, "
        f"during the switches {stormy:.3f} ms (p50 {np.percentile(before, 50):.3f} → {np.percentile(storm, 50):.3f}); "
        f"largest step {step:.3f}"
    )
    assert stormy <= 1.10 * steady
    assert step < 0.25  # no clicks either
    assert np.all(np.isfinite(out))

    # A model that was not preloaded is loaded once, and then kept too.
    other = copy.deepcopy(PRESETS["drive"])
    other["amp"]["model"] = "nam:ac10"
    for preset in (other, PRESETS["solo"], other):
        load(chain, preset)
        run(chain, plucks(0.5))  # the audio thread hands the model before back
    assert chain.loads == {"model": 5, "cab": 2, "reverb": 2}  # the four preloaded and the AC10
    chain.close()


def test_a_user_file_sent_again_is_loaded_again():
    store = AssetStore(TONES)
    chain = Chain(SR, BLOCK, store)
    store.put_user("user:amp", "model", (TONES / "models" / "jcm.nam").read_bytes())
    preset = copy.deepcopy(PRESETS["drive"])
    preset["amp"]["model"] = "user:amp"
    load(chain, preset)
    load(chain, PRESETS["solo"])
    run(chain, plucks(0.5))  # the audio thread lets the first model go
    store.put_user("user:amp", "model", (TONES / "models" / "jc.nam").read_bytes())
    load(chain, preset)
    assert chain.loads["model"] == 3  # not the kept copy of the old file
    assert chain.amp_state == ("ready", None)


def test_chain_block_128_under_budget():
    chain = make_chain()
    preset = copy.deepcopy(PRESETS["solo"])
    preset["chorus"] = {"on": True, "rate": 0.8, "depth": 0.55, "mix": 0.5}  # «Соло» with every effect on
    load(chain, preset)
    x = plucks(4.0)
    blocks = len(x) // BLOCK
    out = np.zeros((BLOCK, 2), dtype=np.float32)
    for index in range(1500):  # warm: the reverb fills up, the caches settle
        chain.process(x[index % blocks * BLOCK :][:BLOCK], out)
    times = np.zeros(3000, dtype=np.int64)
    gc.collect()
    gc.disable()  # the engine plays with the collector frozen, like the probe
    try:
        for index in range(len(times)):
            block = x[index % blocks * BLOCK :][:BLOCK]
            t0 = time.perf_counter_ns()
            chain.process(block, out)
            times[index] = time.perf_counter_ns() - t0
    finally:
        gc.enable()
    ms = times / 1e6
    p50, p99, worst = float(np.percentile(ms, 50)), float(np.percentile(ms, 99)), float(ms.max())
    print(f"Chain.process at {BLOCK}: p50 {p50:.3f} ms, p99 {p99:.3f} ms, max {worst:.3f} ms (budget 2.667 ms)")
    assert math.isfinite(p99)
    # Half the block at the 99th percentile was the probe's bar (12 Nov). The captures of real amps
    # (16 Nov) cost about 0.1 ms more a block than the demo A2 models — the NAM model is 0.69 of the
    # block's 0.80 ms, everything else together under 0.1 — so p99 is 1.37–1.46 ms here, and the
    # real engine on the fake card had as many xruns with them as with the demo amps (1–2 a
    # minute). Another program busy on the laptop pushes this past any bar.
    assert p99 < 1.6


def test_a_model_that_broke_while_playing_is_not_kept():
    chain = make_chain()
    load(chain, PRESETS["drive"])
    run(chain, plucks(0.2))
    broken = chain._nam
    assert broken is not None

    def trap(_buf):
        raise RuntimeError("trap")

    broken.process = trap
    run(chain, plucks(0.1))
    assert chain.amp_state[0] == "fallback"
    load(chain, PRESETS["clean-chorus"])  # takes back what the audio thread let go
    assert broken not in chain._models.values()
    assert broken._id == 0  # closed, not kept for the next time
    load(chain, PRESETS["drive"])
    run(chain, plucks(0.2))
    assert chain.amp_state == ("ready", None)
    assert chain._nam is not None and chain._nam is not broken
    chain.close()


def test_a_reused_model_starts_from_silence():
    chain = make_chain()
    chain.preload(list(PRESETS.values()))
    load(chain, PRESETS["drive"])
    loud = plucks(0.5, peak_db=-3.0)
    run(chain, loud)
    played = chain._nam
    load(chain, PRESETS["clean-chorus"])
    run(chain, loud[: BLOCK * 20])  # the old model fades out and is let go, full of the guitar
    assert chain._nam is not played
    loads = dict(chain.loads)
    load(chain, PRESETS["drive"])
    assert chain.loads == loads  # reused, not loaded again
    # Before the audio thread takes it: silence in must give silence out at once.
    kind, reused = chain._inbox[-1] if chain._inbox[-1][0] == "nam" else chain._inbox[0]
    assert kind == "nam" and reused is played
    block = np.zeros(BLOCK, dtype=np.float32)
    reused.process(block)
    assert float(np.max(np.abs(block))) < 1e-4  # −80 dB: before the fix it was 0.27
    chain.close()


def test_new_amps_measure_like_the_first_ones():
    """The amps of 2026-11-16 were levelled on a real DI recording to the first presets' loudness;
    on `plucks()` they land here (and the browser the same, measured on 16 Nov with this signal)."""
    for preset_id in PRESETS:
        chain = make_chain()
        load(chain, PRESETS[preset_id])
        assert chain.amp_state == ("ready", None)
        level, peak = looped_levels(chain)
        want_level, want_peak = NEW_AMP_LEVELS[preset_id]
        print(f"{preset_id}: {level:.2f} dB RMS, peak {peak:.2f} (measured: {want_level}, {want_peak})")
        assert level == pytest.approx(want_level, abs=0.3)
        chain.close()


def page_faults() -> int:
    """How many memory pages this process has had to be given so far."""
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes

        class Counters(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
                (f"size{i}", ctypes.c_size_t) for i in range(9)
            ]

        counters = Counters()
        counters.cb = ctypes.sizeof(counters)
        kernel = ctypes.windll.kernel32
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        psapi = ctypes.windll.psapi
        psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD]
        assert psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(), ctypes.byref(counters), counters.cb)
        return int(counters.PageFaultCount)
    import resource

    usage = resource.getrusage(resource.RUSAGE_SELF)
    return int(usage.ru_minflt + usage.ru_majflt)


def test_the_chain_meets_no_new_memory_once_the_card_is_open():
    """Every buffer the callback walks through is whole before the sound starts (`dsp.zeros`).

    The echo's line is a megabyte walked once every 2.7 s. Made with `np.zeros` its 256 pages came
    into being one by one in the callback, during the first lap; on a laptop short of memory each
    could take tens of milliseconds (16 Nov 2026: callbacks of 100–370 ms in the first seconds
    after the card opened, none over 2.6 ms once the pages were made beforehand)."""
    chain = make_chain()
    load(chain, PRESETS["solo"])
    out = np.zeros((BLOCK, 2), dtype=np.float32)
    silence = np.zeros((BLOCK, 2), dtype=np.float32)
    for _ in range(64):  # what the engine plays before it opens the card (`_arm`)
        chain.process(silence, out)
    x = plucks(4.0)
    blocks = len(x) // BLOCK
    before = page_faults()
    for index in range(1100):  # a whole lap of the echo's line, and some more
        chain.process(x[index % blocks * BLOCK :][:BLOCK], out)
    met = page_faults() - before
    chain.close()
    assert met < 100, met


def test_the_presets_have_the_gate_the_dsp_tests_expect():
    assert sorted({p["amp"]["gateDb"] for p in PRESETS.values()}) == sorted(PRESET_GATES)
    assert all(p["amp"]["gateAuto"] for p in PRESETS.values())
    assert not any(p["amp"]["gateAuto"] for p in FIRST.values())


def _on_input_noise(preset: dict, noise) -> tuple[float, float, float]:
    """The output's RMS at rest, while a note plays, and from 4 s after it, on the input's noise."""
    chain = make_chain()
    load(chain, preset)
    mono = noise(12.0).copy()
    mono[4 * SR : 5 * SR] += pluck(1.0)
    x = np.zeros((len(mono) // BLOCK * BLOCK, 2), dtype=np.float32)
    x[:, 1] = mono[: len(x)]
    y = mono_of(run(chain, x))
    chain.close()
    return rms_db(y[SR // 2 : 4 * SR]), rms_db(y[4 * SR : 5 * SR]), rms_db(y[9 * SR :])


@pytest.mark.parametrize(
    ("preset_id", "noise"),
    [("clean-chorus", measured_noise), ("clean-chorus", hissy_noise), ("crunch", hissy_noise), ("drive", hissy_noise), ("solo", hissy_noise)],
)
def test_every_preset_is_silent_on_the_input_noise(preset_id, noise):
    """The author: «всегда шум». Every preset must be silent on the input's own noise (as measured
    on 12 Nov, and a hissier reading of the same numbers) — at rest and again after a note."""
    rest, note, after = _on_input_noise(PRESETS[preset_id], noise)
    assert rest < -120
    assert note > -30
    assert after < -120


def test_the_gate_keeps_up_when_the_app_picks_the_guitars_side():
    """«Авто»: the chain starts on both halves, and the app picks the guitar's side on the first
    note — the input doubles under the gate. The first phrase must still end in silence."""
    chain = Chain(SR, BLOCK, AssetStore(TONES))  # as the engine makes it: both halves
    chain.set_master(0.0, False)
    load(chain, PRESETS["drive"])
    mono = hissy_noise(12.0).copy()
    mono[6 * SR : 7 * SR] += pluck(1.0)
    x = np.zeros((len(mono) // BLOCK * BLOCK, 2), dtype=np.float32)
    x[:, 1] = mono[: len(x)]
    y = np.zeros_like(x)
    out = np.zeros((BLOCK, 2), dtype=np.float32)
    for start in range(0, len(x), BLOCK):
        if start == int(6.3 * SR) // BLOCK * BLOCK:
            chain.set_channel("right")  # 0.3 s into the note, as the picker does
        chain.process(x[start : start + BLOCK], out)
        y[start : start + BLOCK] = out
    chain.close()
    heard = mono_of(y)
    assert rms_db(heard[SR:6 * SR]) < -120  # at rest
    assert rms_db(heard[6 * SR : 7 * SR]) > -30  # the note
    assert rms_db(heard[10 * SR :]) < -120  # and silence again, 3 s after it


@pytest.mark.parametrize("preset_id", ["crunch", "drive"])
def test_the_trim_makes_a_quiet_guitar_play_like_the_levelled_one(preset_id):
    """«Подстроить под мою гитару»: a guitar 16 dB quieter, trimmed up 16 dB, gives the amp exactly what
    the guitar the presets were levelled for gives (the trim is before everything that is not linear)."""
    levelled = plucks(4.0, peak_db=-9.0)
    quiet = plucks(4.0, peak_db=-25.0)
    chain = make_chain()
    load(chain, PRESETS[preset_id])
    want = mono_of(run(chain, levelled))
    chain.close()
    chain = make_chain()
    chain.set_trim(16.0)
    load(chain, PRESETS[preset_id])
    got = mono_of(run(chain, quiet))
    chain.close()
    late = slice(SR, None)  # the trim's glide from 0 dB (it starts before the card opens in the engine)
    assert rms_db(got[late]) == pytest.approx(rms_db(want[late]), abs=0.05)
    assert rms_db(got[late] - want[late]) < rms_db(want[late]) - 40


def test_without_the_self_adjusting_gate_the_solo_preset_plays_the_noise():
    """For the record, what «Шумодав сам» is for: the same preset with the threshold alone plays
    the hissy input's noise 22 dB under the note — at rest, and for good."""
    plain = copy.deepcopy(PRESETS["solo"])
    plain["amp"]["gateAuto"] = False
    rest, note, after = _on_input_noise(plain, hissy_noise)
    assert rest > -50 and after > -50
    assert note - after < 30


def test_the_mains_reaches_the_hum_filter():
    """60 Hz mains (src/dsp/mains.ts heard it, or the user chose it): the notches move there."""
    chain = make_chain()
    assert chain._hum.mains_hz == 50.0
    chain.set_mains(60)
    assert chain._hum.mains_hz == 60.0
    chain.set_mains(55)  # not a mains: ignored
    assert chain._hum.mains_hz == 60.0
    chain.close()
