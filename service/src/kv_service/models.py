"""The models: two for separation, two for song analysis, one for the words of the vocals. Names,
where their weights live, how to download them.

Checking the weights only looks at files, so the service answers quickly without importing torch.
"""

from __future__ import annotations

import hashlib
import importlib.util
import os
import re
import urllib.request
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ModelInfo:
    id: str
    name: str
    # demucs: HuggingFace repository with the bag yaml and one safetensors file per model
    hf_repo: str | None = None
    # bs-roformer-infer: registry slug and the files it downloads into <models>/bs-roformer/<slug>/
    slug: str | None = None
    checkpoint: str | None = None
    config: str | None = None


MODELS: dict[str, ModelInfo] = {
    "htdemucs_6s": ModelInfo("htdemucs_6s", "Demucs 6s", hf_repo="adefossez/HTDemucs-6s"),
    "bs_roformer_sw": ModelInfo(
        "bs_roformer_sw",
        "BS-RoFormer SW",
        slug="roformer-model-bs-roformer-sw-by-jarredou",
        checkpoint="BS-Rofo-SW-Fixed.ckpt",
        config="BS-Rofo-SW-Fixed.yaml",
    ),
}


@dataclass(frozen=True)
class WeightFile:
    """One weights file of an analysis model: a plain download into service/.models."""

    id: str
    name: str
    url: str
    path: str  # relative to the models folder
    size: int
    sha256: str | None = None


ANALYSIS_WEIGHTS: dict[str, WeightFile] = {
    # Beat This! (CPJKU, ISMIR 2024; code and weights MIT): the main model, trained on all data
    # except GTZAN. The SHA-256 is of the file as downloaded on 2026-11-07. Its own loader fetches it through torch.hub at first use; we download it at
    # install time and load it by path, so the service never goes online.
    "beat_this": WeightFile(
        "beat_this",
        "Beat This! (доли и такты)",
        "https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/final0.ckpt",
        "beat-this/final0.ckpt",
        81_058_141,
        sha256="8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331",
    ),
    # BTC (ISMIR 2019, MIT), large vocabulary of 170 chords. The original weights, from a pinned
    # revision of the Hugging Face copy (the SHA-256 is the file's LFS id there).
    "btc": WeightFile(
        "btc",
        "BTC (аккорды)",
        "https://huggingface.co/puar-playground/btc-chord/resolve/"
        "d436f2f664f5107cd987774279b8ce171846e376/btc_model_large_voca.pt",
        "btc/btc_model_large_voca.pt",
        12_229_576,
        sha256="1673d23f8f9a55ae7f9e8b80a51da616debb22675b8d8b67ea6ce0ef37b0ab51",
    ),
}

# Stage 3: Whisper large-v3 (OpenAI, MIT) converted for CTranslate2 by SYSTRAN (faster-whisper):
# the words of the vocal stem. Five files of a pinned revision, loaded from the folder by path.
# The SHA-256 of model.bin is its LFS id there; the small files were hashed on 2026-11-08.
WHISPER_DIR = "whisper-large-v3"
_WHISPER_URL = "https://huggingface.co/Systran/faster-whisper-large-v3/resolve/edaa852ec7e145841d8ffdb056a99866b5f0a478/"


def _whisper_file(file: str, size: int, sha256: str) -> WeightFile:
    return WeightFile(f"whisper/{file}", f"Whisper large-v3 ({file})", _WHISPER_URL + file, f"{WHISPER_DIR}/{file}", size, sha256)


LYRICS_WEIGHTS: dict[str, WeightFile] = {
    w.id: w
    for w in (
        _whisper_file("model.bin", 3_087_284_237, "69f74147e3334731bc3a76048724833325d2ec74642fb52620eda87352e3d4f1"),
        _whisper_file("config.json", 2_394, "a9306624f5ec14270a014b647e5c316b6e03a662c369758d1b90697a7b0655b9"),
        _whisper_file("preprocessor_config.json", 340, "7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711"),
        _whisper_file("tokenizer.json", 2_480_617, "6d8cbd7cd0d8d5815e478dac67b85a26bbe77c1f5e0c6d76d1ce2abc0e5f21ca"),
        _whisper_file("vocabulary.json", 1_068_114, "c69260f2ab26d659b7c398f9a2b2b48ed0df16c3b47d7326782fd9cba71690c1"),
    )
}


def _weight(weight_id: str) -> WeightFile | None:
    return ANALYSIS_WEIGHTS.get(weight_id) or LYRICS_WEIGHTS.get(weight_id)


def whisper_dir(models_dir: Path) -> Path:
    return models_dir / WHISPER_DIR


def whisper_ready(models_dir: Path) -> bool:
    """All five files of the Whisper model are there with the right sizes."""
    return all(weight_ready(weight_id, models_dir) for weight_id in LYRICS_WEIGHTS)


def ml_installed() -> bool:
    """True when the neural-network packages (uv group `ml`) are installed. BS-RoFormer is not one of
    them: it is only in the author's copy (group `roformer`)."""
    return all(
        importlib.util.find_spec(name) is not None
        for name in ("torch", "demucs", "beat_this", "librosa")
    )


def model_installed(model_id: str) -> bool:
    """The package that runs this separation model is installed (BS-RoFormer only in the author's copy)."""
    package = "bs_roformer" if MODELS[model_id].slug else "demucs"
    return importlib.util.find_spec(package) is not None


def weight_path(weight_id: str, models_dir: Path) -> Path:
    info = _weight(weight_id)
    if info is None:
        raise KeyError(weight_id)
    return models_dir / info.path


def weight_ready(weight_id: str, models_dir: Path) -> bool:
    """The file is there and has the right size (a broken download is never mistaken for it)."""
    info = _weight(weight_id)
    if info is None:
        return False
    path = models_dir / info.path
    return path.is_file() and path.stat().st_size == info.size


def fetch_weight(weight_id: str, models_dir: Path) -> None:
    """Downloads one weights file, checks its size and SHA-256, then puts it in place.

    Big files print their progress every 10 %, so a long download does not look stuck.
    """
    info = _weight(weight_id)
    if info is None:
        raise KeyError(weight_id)
    target = models_dir / info.path
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_name(target.name + ".part")
    digest = hashlib.sha256()
    request = urllib.request.Request(info.url, headers={"User-Agent": "kvartirnik-setup"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response, part.open("wb") as out:
            done = 0
            shown = 0
            while chunk := response.read(1 << 20):
                out.write(chunk)
                digest.update(chunk)
                done += len(chunk)
                if info.size >= 200_000_000 and done * 10 // info.size > shown:
                    shown = done * 10 // info.size
                    print(f"[setup]   {min(shown, 10) * 10} %", flush=True)
        size = part.stat().st_size
        if size != info.size:
            raise RuntimeError(f"скачалось {size} байт вместо {info.size}")
        if info.sha256 and digest.hexdigest() != info.sha256:
            raise RuntimeError("файл скачался с ошибкой (не сходится контрольная сумма)")
        os.replace(part, target)
    finally:
        part.unlink(missing_ok=True)


def roformer_dir(models_dir: Path) -> Path:
    return models_dir / "bs-roformer"


def hf_snapshots(models_dir: Path, repo: str) -> list[Path]:
    folder = models_dir / "huggingface" / "hub" / ("models--" + repo.replace("/", "--")) / "snapshots"
    return sorted(p for p in folder.iterdir() if p.is_dir()) if folder.is_dir() else []


def weights_ready(model_id: str, models_dir: Path) -> bool:
    info = MODELS.get(model_id)
    if info is None:
        return False
    if info.slug:
        folder = roformer_dir(models_dir) / info.slug
        return (folder / str(info.checkpoint)).is_file() and (folder / str(info.config)).is_file()
    for snapshot in hf_snapshots(models_dir, str(info.hf_repo)):
        bag = snapshot / f"{model_id}.yaml"
        if not bag.is_file():
            continue
        signatures = re.findall(r"\b[0-9a-f]{8}\b", bag.read_text(encoding="utf-8", errors="replace"))
        if signatures and all((snapshot / f"{sig}.safetensors").is_file() for sig in signatures):
            return True
    return False


def fetch_weights(model_id: str, models_dir: Path) -> None:
    """Downloads a model's weights. Needs `prepare_model_env(models_dir, offline=False)` first."""
    info = MODELS[model_id]
    if info.slug:
        from bs_roformer.download import ensure_model_assets

        # Downloads with a SHA-256 check recorded in the package.
        ensure_model_assets(info.slug, models_dir=roformer_dir(models_dir))
    else:
        # HuggingFace only: demucs' fallback to its old AWS repository would hide a failed download.
        from demucs.hf import get_hf_model

        get_hf_model(model_id)
    if not weights_ready(model_id, models_dir):
        raise RuntimeError(f"weights for {model_id} are still missing after the download")
