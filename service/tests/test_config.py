import hashlib
import os
from pathlib import Path

import pytest

from conftest import local_client, fake_separator
from kv_service import config, models
from kv_service.app import create_app

ENV_KEYS = ("KV_LIBRARY_DIR", "KV_MODELS_DIR", "KV_PORT", "KV_DEFAULT_MODEL")


def test_repo_root_is_the_project():
    assert (config.REPO_ROOT / "SPEC.md").is_file()


def test_settings_defaults(monkeypatch):
    for key in ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    settings = config.load_settings()
    assert settings.library_dir == config.REPO_ROOT / "library"
    assert settings.models_dir == config.REPO_ROOT / "service" / ".models"
    assert settings.port == 5174
    assert settings.max_seconds == 720
    assert settings.default_model in models.MODELS


def test_settings_from_env(monkeypatch, tmp_path):
    monkeypatch.setenv("KV_LIBRARY_DIR", str(tmp_path / "lib"))
    monkeypatch.setenv("KV_MODELS_DIR", str(tmp_path / "weights"))
    monkeypatch.setenv("KV_PORT", "6001")
    monkeypatch.setenv("KV_DEFAULT_MODEL", "htdemucs_6s")
    settings = config.load_settings()
    assert settings.library_dir == tmp_path / "lib"
    assert settings.models_dir == tmp_path / "weights"
    assert settings.port == 6001
    assert settings.default_model == "htdemucs_6s"


def test_prepare_model_env_offline(monkeypatch, tmp_path):
    for key in ("HF_HOME", "HF_HUB_OFFLINE", "TORCH_HOME", "HF_HUB_DISABLE_TELEMETRY"):
        monkeypatch.delenv(key, raising=False)
    config.prepare_model_env(tmp_path, offline=True)
    assert os.environ["HF_HOME"] == str(tmp_path / "huggingface")
    assert os.environ["TORCH_HOME"] == str(tmp_path / "torch")
    assert os.environ["HF_HUB_OFFLINE"] == "1"
    assert os.environ["HF_HUB_DISABLE_TELEMETRY"] == "1"


def test_prepare_model_env_online(monkeypatch, tmp_path):
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    config.prepare_model_env(tmp_path, offline=False)
    assert os.environ["HF_HUB_OFFLINE"] == "0"


def test_roformer_weights_need_checkpoint_and_config(tmp_path):
    assert models.weights_ready("bs_roformer_sw", tmp_path) is False
    folder = tmp_path / "bs-roformer" / "roformer-model-bs-roformer-sw-by-jarredou"
    folder.mkdir(parents=True)
    (folder / "BS-Rofo-SW-Fixed.ckpt").write_bytes(b"weights")
    assert models.weights_ready("bs_roformer_sw", tmp_path) is False
    (folder / "BS-Rofo-SW-Fixed.yaml").write_text("model: {}\n")
    assert models.weights_ready("bs_roformer_sw", tmp_path) is True


def test_demucs_weights_need_every_model_of_the_bag(tmp_path):
    assert models.weights_ready("htdemucs_6s", tmp_path) is False
    snapshot = tmp_path / "huggingface" / "hub" / "models--adefossez--HTDemucs-6s" / "snapshots" / "abc123"
    snapshot.mkdir(parents=True)
    (snapshot / "htdemucs_6s.yaml").write_text("models: ['5c90dfd2']\n")
    assert models.weights_ready("htdemucs_6s", tmp_path) is False
    (snapshot / "5c90dfd2.safetensors").write_bytes(b"weights")
    assert models.weights_ready("htdemucs_6s", tmp_path) is True


def test_unknown_model_is_never_ready(tmp_path):
    assert models.weights_ready("nope", tmp_path) is False


def fake_weight(monkeypatch, tmp_path, data: bytes, sha256: str | None) -> None:
    """An analysis weights file served from a local file:// URL."""
    source = tmp_path / "source.bin"
    source.write_bytes(data)
    monkeypatch.setitem(
        models.ANALYSIS_WEIGHTS, "w", models.WeightFile("w", "Test", source.as_uri(), "w/w.bin", len(data), sha256)
    )


def test_analysis_weights_are_listed_with_sizes():
    assert set(models.ANALYSIS_WEIGHTS) == {"beat_this", "btc"}
    assert all(w.size > 1_000_000 for w in models.ANALYSIS_WEIGHTS.values())
    assert models.weight_ready("nope", Path(".")) is False


def test_whisper_files_are_listed_and_ready_only_when_all_are_there(monkeypatch, tmp_path):
    assert len(models.LYRICS_WEIGHTS) == 5
    assert models.LYRICS_WEIGHTS["whisper/model.bin"].size > 3_000_000_000
    assert all(w.sha256 and len(w.sha256) == 64 for w in models.LYRICS_WEIGHTS.values())
    # Small stand-ins for the five files: ready only when every one is there with its size.
    small = {k: models.WeightFile(k, w.name, w.url, w.path, 3, None) for k, w in models.LYRICS_WEIGHTS.items()}
    monkeypatch.setattr(models, "LYRICS_WEIGHTS", small)
    models_dir = tmp_path / "models"
    assert models.whisper_ready(models_dir) is False
    for weight_id in small:
        path = models.weight_path(weight_id, models_dir)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"abc")
    assert models.whisper_ready(models_dir) is True
    assert models.whisper_dir(models_dir) == models_dir / "whisper-large-v3"


def test_fetch_weight_checks_size_and_checksum(monkeypatch, tmp_path):
    data = b"weights" * 100
    fake_weight(monkeypatch, tmp_path, data, hashlib.sha256(data).hexdigest())
    models_dir = tmp_path / "models"
    assert models.weight_ready("w", models_dir) is False
    models.fetch_weight("w", models_dir)
    assert models.weight_ready("w", models_dir) is True
    assert models.weight_path("w", models_dir).read_bytes() == data


def test_fetch_weight_with_a_wrong_checksum_leaves_nothing(monkeypatch, tmp_path):
    fake_weight(monkeypatch, tmp_path, b"weights", "0" * 64)
    with pytest.raises(RuntimeError, match="контрольная сумма"):
        models.fetch_weight("w", tmp_path / "models")
    assert not list((tmp_path / "models").rglob("w.bin*"))


def test_a_weight_of_the_wrong_size_is_not_ready(monkeypatch, tmp_path):
    fake_weight(monkeypatch, tmp_path, b"weights", None)
    path = models.weight_path("w", tmp_path / "models")
    path.parent.mkdir(parents=True)
    path.write_bytes(b"weig")  # an interrupted download
    assert models.weight_ready("w", tmp_path / "models") is False


def test_health_lists_models_and_limits(tmp_path):
    settings = config.Settings(library_dir=tmp_path / "lib", models_dir=tmp_path / "models", default_model="htdemucs_6s")
    with local_client(create_app(settings, separator=fake_separator(device="cpu"))) as client:
        response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["defaultModel"] == "htdemucs_6s"
    assert body["maxSeconds"] == 720
    assert {m["id"]: m["ready"] for m in body["models"]} == {"htdemucs_6s": False, "bs_roformer_sw": False}
    assert {m["id"]: m["name"] for m in body["models"]} == {"htdemucs_6s": "Demucs 6s", "bs_roformer_sw": "BS-RoFormer SW"}
