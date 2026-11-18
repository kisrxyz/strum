import json
import sys

import numpy as np
import pytest

from conftest import SR, fake_analyzer, sine
from kv_service import analysis
from kv_service.analysis import ANALYSIS_VERSION, AnalysisError, BeatThisBackend, BtcBackend, default_analyzer
from kv_service.library import STEMS
from kv_service.separation import Cancelled

FREQS = {"vocals": 440.0, "drums": 60.0, "bass": 55.0, "guitar": 196.0, "piano": 262.0, "other": 330.0}
AMPS = {"vocals": 0.1, "drums": 0.2, "bass": 0.2, "guitar": 0.15, "piano": 0.1, "other": 0.05}


def song_stems(seconds: float = 16.0) -> dict[str, np.ndarray]:
    return {stem: sine(seconds, amp=AMPS[stem], freq=FREQS[stem]) for stem in STEMS}


def rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(x, dtype=np.float64))))


def chord_inputs(log: list) -> list[float]:
    return [entry[1] for entry in log if entry[0] == "chords"]


def test_analyzer_with_fakes():
    log, progress = [], []
    stems = song_stems()
    mix = sum(stems.values())
    result = fake_analyzer(log=log).run(mix, stems, "bs_roformer_sw", SR, progress.append)
    data = result.data
    assert data["version"] == ANALYSIS_VERSION == 2
    assert data["source"] == "bs_roformer_sw"
    assert data["meter"] == 4
    assert data["tempo"] == pytest.approx(120.0, abs=0.5)
    assert len(data["beats"]) == 32
    assert data["downbeats"] == data["beats"][::4]
    # the fake's changes come 70 ms late; they are moved onto the beats
    assert [c["chord"] for c in data["chords"][:4]] == ["C", "G", "A:min", "F"]
    assert [c["start"] for c in data["chords"][:4]] == [0.0, 2.0, 4.0, 6.0]
    assert data["chords"][-1]["end"] == pytest.approx(16.0)
    assert data["key"]["tonic"] == 0
    assert data["key"]["mode"] == "major"
    assert isinstance(data["sections"], list) and data["sections"]
    for section in data["sections"]:
        assert set(section) == {"start", "end", "kind", "name"}
    assert data["tone"] is None or set(data["tone"]) == {"presetId", "bass", "mid", "treble", "confidence"}
    assert -50 <= data["tuningCents"] < 50
    # the chords were heard from the whole mix (it matched the published chords better)
    assert chord_inputs(log) == [pytest.approx(rms(mix.mean(axis=1)), rel=1e-4)]
    assert result.device == "cuda"
    assert result.seconds >= 0
    assert progress[-1] == 1.0
    assert progress == sorted(progress)
    json.dumps(data)  # plain JSON types only


def test_without_stems_the_mix_is_heard_and_sections_are_parts():
    log = []
    mix = sum(song_stems().values())
    data = fake_analyzer(log=log).run(mix, None, "mix", SR, lambda f: None).data
    assert data["source"] == "mix"
    assert chord_inputs(log) == [pytest.approx(rms(mix.mean(axis=1)), rel=1e-4)]
    assert data["tone"] is None
    assert data["sections"] and {s["kind"] for s in data["sections"]} == {"other"}


def test_mono_stems_are_fine():
    stems = {stem: x.mean(axis=1) for stem, x in song_stems().items()}
    data = fake_analyzer().run(sum(stems.values()), stems, "htdemucs_6s", SR, lambda f: None).data
    assert data["meter"] == 4


def test_a_gpu_failure_falls_back_to_the_cpu():
    log = []
    analyzer = fake_analyzer(log=log, fails=[RuntimeError("CUDA error: an illegal memory access")])
    result = analyzer.run(sine(8.0), None, "mix", SR, lambda f: None)
    assert result.device == "cpu"
    loads = [entry for entry in log if entry[0] == "load"]
    assert loads[0] == ("load", "beats", "cuda")
    assert ("load", "beats", "cpu") in loads
    # the half-loaded models were let go before the CPU try
    assert ("unload", "beats") in log[: log.index(("load", "beats", "cpu"))]
    # the next song tries the GPU again
    analyzer.run(sine(8.0), None, "mix", SR, lambda f: None)
    assert [e for e in log if e[0] == "load"][-1][2] == "cuda"


def test_missing_weights_are_not_retried_on_the_cpu():
    log = []
    with pytest.raises(AnalysisError, match="program.filesMissing"):
        fake_analyzer(log=log, fails=[AnalysisError("program.filesMissing")]).run(sine(8.0), None, "mix", SR, lambda f: None)
    assert [e for e in log if e[0] == "load"] == [("load", "beats", "cuda")]


def test_a_failure_on_the_cpu_is_a_message_with_the_reason():
    with pytest.raises(AnalysisError) as error:
        fake_analyzer(device="cpu", fails=[RuntimeError("boom")]).run(sine(8.0), None, "mix", SR, lambda f: None)
    assert error.value.message == {"code": "analysis.failed", "params": {"reason": "boom"}}


def test_cancel_stops_it():
    log = []

    def progress(_fraction):
        raise Cancelled()

    with pytest.raises(Cancelled):
        fake_analyzer(log=log).run(sine(8.0), None, "mix", SR, progress)
    assert not [e for e in log if e[0] == "load" and e[2] == "cpu"]


def test_the_models_stay_loaded_until_unload():
    log = []
    analyzer = fake_analyzer(log=log)
    analyzer.run(sine(4.0), None, "mix", SR, lambda f: None)
    analyzer.run(sine(4.0), None, "mix", SR, lambda f: None)
    assert [e for e in log if e[0] == "load"] == [("load", "beats", "cuda"), ("load", "chords", "cuda"), ("load", "pitch", "cuda")]
    analyzer.unload()
    assert log[-3:] == [("unload", "beats"), ("unload", "chords"), ("unload", "pitch")]
    analyzer.unload()  # twice is fine
    assert log[-1] == ("unload", "pitch")


def test_no_beats_means_no_bars_but_the_chords_stay():
    data = fake_analyzer(period=None).run(sine(8.0), None, "mix", SR, lambda f: None).data
    assert data["beats"] == [] and data["downbeats"] == []
    assert data["tempo"] == 0.0 and data["meter"] == 4
    assert data["sections"] == []
    assert data["chords"][0]["chord"] == "C"


def test_nothing_musical_is_a_message():
    with pytest.raises(AnalysisError, match="analysis.noMusic"):
        fake_analyzer(period=None, progression=("N",)).run(sine(8.0), None, "mix", SR, lambda f: None)


@pytest.mark.parametrize("backend", [BeatThisBackend, BtcBackend])
def test_real_backends_without_weights_explain_what_to_do(tmp_path, backend):
    with pytest.raises(AnalysisError) as error:
        backend(tmp_path)
    assert error.value.code == "program.filesMissing"


def test_missing_packages_explain_what_to_do(monkeypatch, tmp_path):
    monkeypatch.setattr(analysis, "weight_ready", lambda *_: True)
    monkeypatch.setitem(sys.modules, "beat_this", None)  # importing it fails, as when not installed
    monkeypatch.setitem(sys.modules, "beat_this.inference", None)
    monkeypatch.setitem(sys.modules, "librosa", None)
    for backend in (BeatThisBackend, BtcBackend):
        with pytest.raises(AnalysisError, match="program.filesMissing"):
            backend(tmp_path).load("cpu")


def test_default_analyzer_without_weights_fails_fast(tmp_path):
    with pytest.raises(AnalysisError, match="program.filesMissing"):
        default_analyzer(tmp_path).run(sine(2.0), None, "mix", SR, lambda f: None)
