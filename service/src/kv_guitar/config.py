"""The guitar engine's settings, the codes of what it tells the user and the built-in sounds it loads ahead."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from kv_service.messages import UserError

from .assets import ENGINE_RATE, repo_root

HOST = "127.0.0.1"
DEFAULT_PORT = 5175
SAMPLE_RATE = ENGINE_RATE
BUFFER_SIZES = (32, 64, 128, 256)

# --- what the user is told (the `error` of a `state` message): codes of messages, whose words
# live in the app (src/i18n/*/service.ts); the values each one takes are in its comment ---

RATE_ERROR = "guitar.rate"
DEVICE_LOST = "guitar.deviceLost"
NO_DEVICES = "guitar.noDevices"
DEVICE_NOT_FOUND = "guitar.deviceNotFound"  # name
OPEN_FAILED = "guitar.openFailed"  # reason
CHAIN_BROKE = "guitar.chainBroke"  # reason
AUDIO_PROCESS_DIED = "guitar.processDied"
AUDIO_PROCESS_FAILED = "guitar.processFailed"  # reason


class EngineError(UserError):
    """Something the user has to be told: a code and its values (`.message`)."""


# The model, cabinet and reverb of each built-in preset (DEFAULT_PRESETS in src/state/presets.ts):
# loaded before the card opens, so switching between them never loads anything while playing.
# tests/test_guitar_core.py checks this list against presets.ts.
BUILTIN_SOUNDS: tuple[tuple[str, bool, str, str], ...] = (
    ("nam:twin", False, "ir:celestion", "spring"),
    ("nam:jcm2000", False, "ir:celestion", "spring"),
    ("nam:jcm900", False, "ir:mesa", "plate"),
    ("nam:shirley", False, "ir:celestion", "plate"),
)


def preload_presets() -> list[dict]:
    """BUILTIN_SOUNDS in the shape `Chain.preload` reads."""
    return [
        {"amp": {"model": model, "slim": slim}, "cab": cab, "reverb": {"type": reverb}}
        for model, slim, cab, reverb in BUILTIN_SOUNDS
    ]


@dataclass(frozen=True)
class Settings:
    port: int = DEFAULT_PORT
    # '' = the real card; 'saw' or a path to a .wav = no card at all (see fake.py).
    fake: str = ""
    tones_dir: Path = repo_root() / "public" / "tones"


def load_settings() -> Settings:
    env = os.environ
    return Settings(
        port=int(env.get("KV_GUITAR_PORT") or DEFAULT_PORT),
        fake=(env.get("KV_GUITAR_FAKE") or "").strip(),
        tones_dir=Path(env.get("KV_TONES_DIR") or repo_root() / "public" / "tones"),
    )
