import numpy as np
import pytest

from conftest import SR, OutOfMemoryError, fake_separator, sine
from kv_service.library import STEMS
from kv_service.separation import Cancelled, DemucsBackend, RoformerBackend, SeparationError

MIX = sine(1.0)  # (frames, 2), as the job queue reads it


def run(separator, progress=lambda f: None):
    return separator.run("htdemucs_6s", MIX, SR, progress)


def test_success_on_the_gpu_returns_stems_frames_first():
    log = []
    result = run(fake_separator(log=log))
    assert result.device == "cuda"
    assert result.note is None
    assert result.peak_vram_mb == 1234
    assert set(result.stems) == set(STEMS)
    assert result.stems["guitar"].shape == MIX.shape
    np.testing.assert_allclose(result.stems["drums"], MIX * 0.2, rtol=1e-6)
    assert log == [("load", "htdemucs_6s", "cuda"), ("separate", "htdemucs_6s", False)]


def test_out_of_memory_retries_with_smaller_chunks_on_the_gpu():
    log = []
    result = run(fake_separator(log=log, fails=[OutOfMemoryError("CUDA out of memory")]))
    assert result.device == "cuda"
    assert result.note == {"code": "separation.smallerChunks", "params": {}}
    assert [entry for entry in log if entry[0] == "separate"] == [
        ("separate", "htdemucs_6s", False),
        ("separate", "htdemucs_6s", True),
    ]


def test_out_of_memory_twice_goes_to_the_cpu():
    log = []
    result = run(fake_separator(log=log, fails=[OutOfMemoryError("oom"), OutOfMemoryError("oom")]))
    assert result.device == "cpu"
    assert result.peak_vram_mb is None
    assert result.note == {"code": "separation.cpuNoVram", "params": {}}
    assert ("unload", "htdemucs_6s") in log
    assert log[-2:] == [("load", "htdemucs_6s", "cpu"), ("separate", "htdemucs_6s", False)]


def test_other_gpu_errors_go_straight_to_the_cpu():
    log = []
    result = run(fake_separator(log=log, fails=[RuntimeError("cuDNN error")]))
    assert result.device == "cpu"
    assert [e for e in log if e[0] == "separate"] == [("separate", "htdemucs_6s", False)] * 2
    assert result.note == {"code": "separation.cpuGpuFailed", "params": {}}


def test_without_a_gpu_the_note_says_so():
    result = run(fake_separator(device="cpu"))
    assert result.device == "cpu"
    assert result.note == {"code": "separation.cpuNoGpu", "params": {}}


def test_a_failure_on_the_cpu_is_a_message_with_the_reason():
    with pytest.raises(SeparationError) as error:
        run(fake_separator(device="cpu", fails=[RuntimeError("boom")]))
    assert error.value.message == {"code": "separation.failed", "params": {"reason": "boom"}}


def test_cancel_is_not_retried():
    log = []

    def progress(_fraction):
        raise Cancelled()

    with pytest.raises(Cancelled):
        run(fake_separator(log=log), progress)
    assert [e for e in log if e[0] == "separate"] == [("separate", "htdemucs_6s", False)]


def test_the_loaded_model_is_reused_and_unloaded_on_switch():
    log = []
    separator = fake_separator(log=log)
    run(separator)
    run(separator)
    separator.run("bs_roformer_sw", MIX, SR, lambda f: None)
    assert [e for e in log if e[0] != "separate"] == [
        ("load", "htdemucs_6s", "cuda"),
        ("unload", "htdemucs_6s"),
        ("load", "bs_roformer_sw", "cuda"),
    ]
    separator.unload()
    assert log[-1] == ("unload", "bs_roformer_sw")


@pytest.mark.parametrize("backend", [DemucsBackend, RoformerBackend])
def test_real_backends_without_weights_explain_what_to_do(tmp_path, backend):
    with pytest.raises(SeparationError) as error:
        backend(tmp_path).load("cpu")
    assert error.value.code == "program.filesMissing"
