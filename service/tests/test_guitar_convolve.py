"""The cabinet: partitioned convolution, the IR gain staging, reading IR files."""

import io

import numpy as np
import pytest
import soundfile as sf

from kv_guitar.assets import builtin_ir_path, builtin_model_path, read_ir, read_ir_native, repo_root
from kv_guitar.convolve import PartitionedConvolver
from kv_guitar.irgain import ir_in_band_gain_db

needs_tones = pytest.mark.skipif(
    not (repo_root() / "public" / "tones" / "irs" / "mesa.wav").exists(),
    reason="public/tones is missing: run npm run setup",
)


def run_blocks(conv: PartitionedConvolver, x: np.ndarray, block: int) -> np.ndarray:
    padded = np.zeros((len(x) + block - 1) // block * block, dtype=np.float32)
    padded[: len(x)] = x
    y = np.empty_like(padded)
    out = np.empty(block, dtype=np.float32)
    for start in range(0, len(padded), block):
        conv.process(padded[start : start + block], out)
        y[start : start + block] = out
    return y[: len(x)]


@pytest.mark.parametrize("block", [128, 64])
def test_convolver_matches_numpy(block):
    rng = np.random.default_rng(7)
    # Shaped like a cabinet: noise dying away, about unit energy.
    ir = (rng.standard_normal(3000) * np.exp(-np.arange(3000) / 600) * 0.06).astype(np.float32)
    x = rng.uniform(-1, 1, 10_000).astype(np.float32)
    y = run_blocks(PartitionedConvolver(ir, block), x, block)
    want = np.convolve(x.astype(np.float64), ir.astype(np.float64))[: len(x)]
    assert np.max(np.abs(y - want)) < 1e-4


def test_convolver_short_ir_and_first_sample_has_no_delay():
    ir = np.array([0.5, 0.25], dtype=np.float32)
    conv = PartitionedConvolver(ir, 64)
    x = np.zeros(64, dtype=np.float32)
    x[0] = 1.0
    out = np.empty(64, dtype=np.float32)
    conv.process(x, out)
    assert out[0] == pytest.approx(0.5, abs=1e-6)
    assert out[1] == pytest.approx(0.25, abs=1e-6)
    assert np.max(np.abs(out[2:])) < 1e-6


def test_convolver_wrong_block_length_raises():
    conv = PartitionedConvolver(np.ones(10, dtype=np.float32), 64)
    with pytest.raises(ValueError):
        conv.process(np.zeros(32, dtype=np.float32), np.zeros(32, dtype=np.float32))


def test_ir_gain_of_a_unit_impulse_is_zero_and_limits_hold():
    assert ir_in_band_gain_db(np.array([1.0], dtype=np.float32), 48000) == pytest.approx(0.0, abs=1e-9)
    assert ir_in_band_gain_db(np.array([0.5], dtype=np.float32), 48000) == pytest.approx(6.0206, abs=1e-3)
    assert ir_in_band_gain_db(np.zeros(8, dtype=np.float32), 48000) == 0.0
    assert ir_in_band_gain_db(np.array([1e-6], dtype=np.float32), 48000) == 24.0
    assert ir_in_band_gain_db(np.array([1e6], dtype=np.float32), 48000) == -48.0


# irInBandGainDb (src/dsp/irGain.ts) on the first channel of each file at the rate of the file,
# computed once with a throwaway Vitest file (2026-11-12).
TS_IR_GAIN_DB = {
    "celestion": (48000, -17.56694265203305),
    "mesa": (48000, -14.85929926504414),
    "eminence": (44100, -12.693463804330579),
}


@needs_tones
@pytest.mark.parametrize("name", sorted(TS_IR_GAIN_DB))
def test_ir_gain_matches_typescript(name):
    rate, want = TS_IR_GAIN_DB[name]
    taps, sr = read_ir_native(builtin_ir_path(f"ir:{name}"))
    assert sr == rate
    assert ir_in_band_gain_db(taps, sr) == pytest.approx(want, abs=0.01)


@needs_tones
def test_builtin_paths():
    assert builtin_model_path("nam:jcm").name == "jcm.nam"
    assert builtin_ir_path("ir:mesa").name == "mesa.wav"
    with pytest.raises(ValueError):
        builtin_model_path("simple")
    with pytest.raises(ValueError):
        builtin_ir_path("none")
    with pytest.raises(ValueError):
        builtin_ir_path("ir:../../secret")


def wav_bytes(x: np.ndarray, sr: int) -> bytes:
    buffer = io.BytesIO()
    sf.write(buffer, x, sr, format="WAV", subtype="FLOAT")
    return buffer.getvalue()


def test_read_ir_takes_the_first_channel_or_all():
    stereo = np.stack([np.linspace(0, 1, 100), np.linspace(1, 0, 100)], axis=1).astype(np.float32)
    data = wav_bytes(stereo, 48000)
    first = read_ir(data, 48000)
    assert first.shape == (100,) and first.dtype == np.float32
    np.testing.assert_allclose(first, stereo[:, 0], atol=1e-6)
    both = read_ir(data, 48000, channels="all")
    assert both.shape == (100, 2)


def test_read_ir_resamples_to_the_engine_rate():
    # A 1 kHz sine keeps its frequency and level; the length follows the rate.
    t = np.arange(4410) / 44100
    x = (0.5 * np.sin(2 * np.pi * 1000 * t)).astype(np.float32)
    y = read_ir(wav_bytes(x, 44100), 48000)
    assert abs(len(y) - 4800) <= 1
    want = 0.5 * np.sin(2 * np.pi * 1000 * np.arange(len(y)) / 48000)
    assert np.max(np.abs(y[200:-200] - want[200:-200])) < 2e-3


def test_read_ir_bad_file_has_a_message():
    with pytest.raises(ValueError, match="amp.irUnreadable"):
        read_ir(b"not a wav at all", 48000)
