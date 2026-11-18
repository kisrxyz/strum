import numpy as np
import pytest

from conftest import FakeWhisper, fake_transcriber, sine
from kv_service.lyrics import (
    TRANSCRIPT_VERSION,
    WHISPER_RATE,
    TranscribeError,
    Transcriber,
    default_transcriber,
    gaps,
    to_whisper_audio,
)
from kv_service.separation import Cancelled


def test_transcriber_with_fake():
    log = []
    result = fake_transcriber(log=log).run(sine(10.0), 44_100, "bs_roformer_sw", lambda _f: None)
    data = result.data
    assert data["version"] == TRANSCRIPT_VERSION
    assert data["model"] == "large-v3"
    assert data["language"] == "ru"
    assert data["source"] == "bs_roformer_sw"
    assert [w["word"] for w in data["words"]] == ["раз", "два", "три"]  # sorted by start, trimmed
    assert data["lines"] == [{"start": 1.0, "end": 3.4, "text": "раз два три"}]
    heard = [entry for entry in log if entry[0] == "transcribe"]
    assert len(heard) == 1
    assert abs(heard[0][1] - 160_000) <= 1  # 10 s at 16 kHz, mono
    assert result.device == "cuda"


def test_a_gpu_failure_tries_lighter_then_the_cpu():
    log = []
    fails = [RuntimeError("CUDA failed"), RuntimeError("out of memory")]
    result = fake_transcriber(log=log, fails=fails).run(sine(5.0), 44_100, "htdemucs_6s", lambda _f: None)
    loads = [entry[1:] for entry in log if entry[0] == "load"]
    assert loads == [("whisper", "cuda", "float16"), ("whisper", "cuda", "int8_float16"), ("whisper", "cpu", "int8")]
    assert result.device == "cpu"
    assert len(result.data["words"]) == 3


def test_a_failure_on_the_cpu_is_reported_with_the_reason():
    with pytest.raises(TranscribeError) as error:
        fake_transcriber(device="cpu", fails=[RuntimeError("broken")]).run(sine(2.0), 44_100, "x", lambda _f: None)
    assert error.value.message == {"code": "words.failed", "params": {"reason": "broken"}}


def test_transcriber_silence():
    log = []
    result = fake_transcriber(log=log).run(np.zeros((5 * 44_100, 2), np.float32), 44_100, "x", lambda _f: None)
    assert result.data["words"] == []
    assert result.data["language"] == ""
    assert not [entry for entry in log if entry[0] in ("load", "transcribe")]


def test_cancel_stops_it():
    def progress(fraction: float) -> None:
        if fraction > 0.1:
            raise Cancelled()

    with pytest.raises(Cancelled):
        fake_transcriber().run(sine(2.0), 44_100, "x", progress)


def test_missing_weights_fail_fast(tmp_path):
    transcriber = default_transcriber(tmp_path / "models")
    with pytest.raises(TranscribeError, match="program.filesMissing"):
        transcriber.run(sine(2.0), 44_100, "x", lambda _f: None)


def test_resampling_keeps_the_pitch_and_level():
    audio = to_whisper_audio(sine(2.0, amp=0.5, freq=440.0), 44_100)
    assert len(audio) == 32_000
    spectrum = np.abs(np.fft.rfft(audio))
    assert abs(np.argmax(spectrum) * 16_000 / len(audio) - 440.0) < 1.0
    assert abs(np.sqrt(np.mean(audio**2)) - 0.5 / np.sqrt(2)) < 0.01


def test_the_model_stays_loaded_between_songs():
    log = []
    transcriber = Transcriber(lambda: FakeWhisper(log), device="cuda")
    transcriber.run(sine(2.0), 44_100, "x", lambda _f: None)
    transcriber.run(sine(2.0), 44_100, "x", lambda _f: None)
    assert len([entry for entry in log if entry[0] == "load"]) == 1
    transcriber.unload()
    assert ("unload", "whisper") in log


def test_gaps_finds_long_stretches_without_words():
    words = [{"start": 1.0, "end": 2.0, "word": "раз"}, {"start": 20.0, "end": 21.0, "word": "два"}]
    assert gaps(words, 40.0) == [(2.0, 20.0), (21.0, 40.0)]
    assert gaps([], 10.0) == []
    assert gaps([], 30.0) == [(0.0, 30.0)]


def heard_once_then_holes(audio, language):
    """The whole song: words at 1 s and 35 s only (a sung part skipped); a hole alone: a word 5 s in."""
    if len(audio) == 40 * WHISPER_RATE:
        return "ru", [{"start": 1.0, "end": 1.4, "word": "раз", "p": 0.9}, {"start": 35.0, "end": 35.4, "word": "три", "p": 0.9}], []
    return "ru", [{"start": 5.0, "end": 5.4, "word": "два", "p": 0.8}], [{"start": 5.0, "end": 5.4, "text": "два"}]


def test_a_sung_hole_is_listened_to_again_in_the_found_language():
    log = []
    result = fake_transcriber(log=log, hears=heard_once_then_holes).run(sine(40.0), 44_100, "x", lambda _f: None)
    assert [w["word"] for w in result.data["words"]] == ["раз", "два", "три"]
    assert result.data["words"][1]["start"] == pytest.approx(1.4 + 5.0, abs=0.01)
    calls = [entry for entry in log if entry[0] == "transcribe"]
    assert len(calls) == 2  # the song, then the hole between 1.4 and 35 s (the ends are short)
    assert calls[1][3] == "ru"


def test_a_quiet_hole_is_left_alone():
    log = []
    song = sine(40.0)
    song[int(2 * 44_100) : int(34 * 44_100)] = 0  # an instrumental break: nothing in the vocal stem
    fake_transcriber(log=log, hears=heard_once_then_holes).run(song, 44_100, "x", lambda _f: None)
    assert len([entry for entry in log if entry[0] == "transcribe"]) == 1
