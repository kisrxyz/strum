"""The real models on 10 seconds of a test song. Run with: npm run test:service -- -m gpu"""

from pathlib import Path

import numpy as np
import pytest

from kv_service.audio import read_audio
from kv_service.config import REPO_ROOT, load_settings, prepare_model_env
from kv_service.library import STEMS
from kv_service.models import weights_ready
from kv_service.separation import DemucsBackend, RoformerBackend, detect_device

pytestmark = pytest.mark.gpu
SONGS = sorted((REPO_ROOT / "test-songs").glob("*.mp3"))


@pytest.fixture(scope="module")
def excerpt() -> np.ndarray:
    if not SONGS:
        pytest.skip("test-songs/ is empty")
    audio, sr = read_audio(SONGS[0])
    assert sr == 44100
    start = 60 * sr
    return np.ascontiguousarray(audio[start : start + 10 * sr].T)


@pytest.mark.parametrize("backend_class", [DemucsBackend, RoformerBackend])
def test_real_model_separates_an_excerpt(backend_class, excerpt):
    settings = load_settings()
    prepare_model_env(settings.models_dir, offline=True)
    backend = backend_class(Path(settings.models_dir))
    if not weights_ready(backend.model_id, settings.models_dir):
        pytest.skip("weights are not downloaded: npm run setup")
    device, _ = detect_device()
    backend.load(device)
    try:
        progress = []
        stems = backend.separate(excerpt, 44100, progress.append, small=False)
    finally:
        backend.unload()
    assert set(stems) == set(STEMS)
    for stem in STEMS:
        assert stems[stem].shape == excerpt.shape
        assert np.isfinite(stems[stem]).all()
    assert np.sqrt(np.mean(stems["guitar"] ** 2)) > 1e-3
    assert progress and progress[-1] <= 1.0
