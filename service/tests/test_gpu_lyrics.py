"""The real Whisper model. Run with: npm run test:service -- -m gpu -k whisper

It needs `npm run setup` (faster-whisper, the CUDA 12 cuBLAS, the large-v3 weights) and a song
in test-songs/ (its vocals come from the Demucs 6s separation, the fastest one).
"""

from pathlib import Path

import pytest

from kv_service.audio import read_audio
from kv_service.config import REPO_ROOT, load_settings, prepare_model_env
from kv_service.lyrics import default_transcriber
from kv_service.models import weights_ready, whisper_ready
from kv_service.separation import default_separator, detect_device

pytestmark = pytest.mark.gpu
SONGS = sorted((REPO_ROOT / "test-songs").glob("*.mp3"))


@pytest.fixture(scope="module")
def models_dir() -> Path:
    pytest.importorskip("faster_whisper", reason="faster-whisper is not installed: npm run setup")
    settings = load_settings()
    prepare_model_env(settings.models_dir, offline=True)
    if not whisper_ready(settings.models_dir):
        pytest.skip("the Whisper weights are not downloaded: npm run setup")
    if not weights_ready("htdemucs_6s", settings.models_dir):
        pytest.skip("the Demucs weights are not downloaded: npm run setup")
    return Path(settings.models_dir)


@pytest.mark.skipif(not SONGS, reason="no song in test-songs/")
def test_whisper_on_a_test_song(models_dir):
    mix, sr = read_audio(SONGS[0])
    mix = mix[: 60 * sr]
    separator = default_separator(models_dir)
    vocals = separator.run("htdemucs_6s", mix, sr, lambda _f: None).stems["vocals"]
    separator.unload()
    result = default_transcriber(models_dir).run(vocals, sr, "htdemucs_6s", lambda _f: None)
    words = result.data["words"]
    print(f"\n{len(words)} words in {result.seconds} s on {result.device}, language {result.data['language']}")
    assert len(words) >= 5
    starts = [w["start"] for w in words]
    assert starts == sorted(starts)
    assert all(0 <= w["start"] <= w["end"] <= 60 for w in words)
    assert result.data["language"] in {"ru", "kk", "uk", "en"}
    if detect_device()[0] == "cuda":
        assert result.device == "cuda"
