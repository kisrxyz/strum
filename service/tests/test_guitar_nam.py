"""The NAM wasm engine under wasmtime (kv_guitar.nam_wasm)."""

import time

import numpy as np
import pytest

from kv_guitar.assets import builtin_model_path, nam_wasm_path, repo_root
from kv_guitar.nam_wasm import NamWasm

SR = 48000

pytestmark = pytest.mark.skipif(
    not (repo_root() / "public" / "tones" / "models" / "jcm.nam").exists() or not nam_wasm_path().exists(),
    reason="public/tones or public/nam is missing: run npm run setup",
)


def sine(seconds: float, hz: float = 110.0, db: float = -18.0) -> np.ndarray:
    t = np.arange(int(SR * seconds)) / SR
    return (10 ** (db / 20) * np.sqrt(2) * np.sin(2 * np.pi * hz * t)).astype(np.float32)


def rms_db(x: np.ndarray) -> float:
    return float(10 * np.log10(np.mean(np.square(x, dtype=np.float64)) + 1e-20))


def jcm() -> str:
    return builtin_model_path("nam:jcm").read_text(encoding="utf-8")


def test_nam_loads_builtin_a2_model():
    nam = NamWasm(nam_wasm_path(), SR, 256)
    assert nam.has_model is False
    info = nam.load_model(jcm())
    assert info.slimmable is True
    assert info.expected_sample_rate == SR
    assert nam.has_model is True

    x = sine(1.0)
    y = x.copy()
    for start in range(0, len(y) - 127, 128):
        nam.process(y[start : start + 128])
    y = y[: len(y) // 128 * 128]
    assert np.all(np.isfinite(y))
    assert not np.array_equal(y, x[: len(y)])
    assert -40.0 < rms_db(y) < 0.0

    nam.unload()
    assert nam.has_model is False


def test_nam_slim_size_loads_and_plays():
    nam = NamWasm(nam_wasm_path(), SR, 128)
    nam.load_model(jcm(), 0.3)
    y = sine(0.1)[: 128 * 30].copy()
    for start in range(0, len(y), 128):
        nam.process(y[start : start + 128])
    assert np.all(np.isfinite(y))
    assert -40.0 < rms_db(y[128 * 10 :]) < 0.0


def test_nam_bad_json_raises_with_message():
    nam = NamWasm(nam_wasm_path(), SR, 128)
    with pytest.raises(RuntimeError) as caught:
        nam.load_model("{}")
    assert str(caught.value).strip()
    # The engine survives a failed load.
    nam.load_model(jcm())
    assert nam.has_model is True


def test_nam_rejects_a_block_longer_than_max_frames():
    nam = NamWasm(nam_wasm_path(), SR, 128)
    nam.load_model(jcm())
    with pytest.raises(ValueError):
        nam.process(np.zeros(129, dtype=np.float32))


def test_nam_close_gives_the_whole_engine_back():
    """A closed amp frees its engine and the 64 MB it holds. Left to Python it never was freed
    (wasmtime keeps the store's functions, and they keep the amp): every amp ever loaded stayed."""
    nam = NamWasm(nam_wasm_path(), SR, 128)
    nam.load_model(jcm())
    nam.close()
    assert nam.has_model is False
    with pytest.raises(ValueError, match="closed"):
        nam._store.ptr()
    # Harmless afterwards: a block passes untouched, a second close does nothing.
    block = sine(0.01)[:128].copy()
    before = block.copy()
    nam.process(block)
    assert np.array_equal(block, before)
    nam.close()


def test_nam_missing_wasm_says_run_setup(tmp_path):
    with pytest.raises(RuntimeError, match="program.filesMissing"):
        NamWasm(tmp_path / "nam-engine.exnref.wasm", SR, 128)


def test_nam_process_128_under_budget(capsys):
    nam = NamWasm(nam_wasm_path(), SR, 128)
    nam.load_model(jcm())
    x = sine(0.5)
    block = np.empty(128, dtype=np.float32)
    for i in range(100):  # warm-up
        start = (i * 128) % 20000
        block[:] = x[start : start + 128]
        nam.process(block)
    times = np.empty(2000, dtype=np.int64)
    for i in range(2000):
        start = (i * 128) % 20000
        block[:] = x[start : start + 128]
        t0 = time.perf_counter_ns()
        nam.process(block)
        times[i] = time.perf_counter_ns() - t0
    ms = times / 1e6
    with capsys.disabled():
        print(
            f"\nNAM process(128): mean {ms.mean():.3f} ms, p50 {np.percentile(ms, 50):.3f} ms, "
            f"p99 {np.percentile(ms, 99):.3f} ms, max {ms.max():.3f} ms"
        )
    assert ms.mean() < 1.0
