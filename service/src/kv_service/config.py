"""Service settings: where songs, the user's own files and model weights live, the port, the default
model, and what the installed app (the Strum window, shell/) adds: the built page and the engine's port."""

from __future__ import annotations

import importlib.util
import os
from dataclasses import dataclass
from pathlib import Path

from .models import MODELS

# service/src/kv_service/config.py -> the repository root
REPO_ROOT = Path(__file__).resolve().parents[3]

# The model a new song is split with. Chosen after comparing both on test-songs/ (plan Task 4).
# BS-RoFormer is only in the author's copy (uv group `roformer`: its weights may not be given away);
# everyone else gets Demucs.
DEFAULT_MODEL = "bs_roformer_sw"
PUBLIC_MODEL = "htdemucs_6s"


def roformer_installed() -> bool:
    return importlib.util.find_spec("bs_roformer") is not None


@dataclass(frozen=True)
class Settings:
    library_dir: Path
    models_dir: Path
    default_model: str = DEFAULT_MODEL
    port: int = 5174
    # Longer songs are refused: the player keeps 12 float channels at 48 kHz in memory.
    max_seconds: float = 12 * 60
    # The app's settings file and the user's own amps and cabinets (userdata.py). In the author's
    # copy the library folder; in the installed app «Documents\Strum».
    user_dir: Path | None = None
    # The built page (vite build), served at / by this service in the installed app. None: Vite does it.
    web_dir: Path | None = None
    # Started by the Strum window (shell/): the page may start the sound without a key press.
    shell: bool = False
    # The guitar engine's port, for a page this service serves (no Vite proxy in front of it).
    guitar_port: int | None = None
    # uv and the service's project folder: how the installed app adds the neural networks.
    uv: Path | None = None
    project_dir: Path | None = None
    # A random word from the Strum window, answered on /api/runtime (see shell/src/main.rs).
    instance: str = ""

    @property
    def user_root(self) -> Path:
        return self.user_dir or self.library_dir


def load_settings() -> Settings:
    env = os.environ
    default_model = env.get("KV_DEFAULT_MODEL") or (DEFAULT_MODEL if roformer_installed() else PUBLIC_MODEL)
    if default_model not in MODELS:
        raise ValueError(f"KV_DEFAULT_MODEL must be one of {sorted(MODELS)}, got {default_model!r}")
    library_dir = Path(env.get("KV_LIBRARY_DIR") or REPO_ROOT / "library")
    return Settings(
        library_dir=library_dir,
        models_dir=Path(env.get("KV_MODELS_DIR") or REPO_ROOT / "service" / ".models"),
        default_model=default_model,
        port=int(env.get("KV_PORT") or 5174),
        user_dir=Path(env["KV_USER_DIR"]) if env.get("KV_USER_DIR") else None,
        web_dir=Path(env["KV_WEB_DIR"]) if env.get("KV_WEB_DIR") else None,
        shell=env.get("KV_SHELL") == "1",
        guitar_port=int(env["KV_GUITAR_PORT"]) if env.get("KV_GUITAR_PORT") else None,
        uv=Path(env["KV_UV"]) if env.get("KV_UV") else None,
        project_dir=Path(env.get("KV_PROJECT_DIR") or REPO_ROOT / "service"),
        instance=env.get("KV_INSTANCE", ""),
    )


def prepare_model_env(models_dir: Path, offline: bool) -> None:
    """Points the model libraries at service/.models. Call before importing torch or huggingface_hub.

    Offline mode is how the service runs: weights come only from the local cache, nothing is
    downloaded while the app is in use (downloads belong to `npm run setup`).
    """
    os.environ["HF_HOME"] = str(models_dir / "huggingface")
    os.environ["TORCH_HOME"] = str(models_dir / "torch")
    os.environ["HF_HUB_OFFLINE"] = "1" if offline else "0"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
