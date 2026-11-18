"""Where the built-in amp models, cabinets and the NAM engine live, and reading IR files.

The files are the browser app's own (`public/tones`, `public/nam`), put there by `npm run setup`.
"""

from __future__ import annotations

import io
import math
import os
import re
import threading
from pathlib import Path

import numpy as np
import soundfile as sf

from kv_service.messages import UserError

ENGINE_RATE = 48000
# Codes of messages (kv_service.messages); the words are the app's (src/i18n/*/service.ts).
MISSING_TONES = "program.filesMissing"
# As src/audio/assets.ts says them.
USER_MODEL_GONE = "amp.userModelGone"
USER_IR_GONE = "amp.userIrGone"
UNKNOWN_BUILTIN = "amp.unknownBuiltIn"  # id

_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")


class AssetError(UserError, ValueError):
    """A sound that cannot be loaded; the user is told why."""


def repo_root() -> Path:
    # service/src/kv_guitar/assets.py → the repository
    return Path(__file__).resolve().parents[3]


def public_dir() -> Path:
    """The page's static files: public/ in the author's copy; in the installed app the built page,
    whose tones/ KV_TONES_DIR points at."""
    tones = os.environ.get("KV_TONES_DIR")
    return Path(tones).parent if tones else repo_root() / "public"


def nam_wasm_path() -> Path:
    """The NAM engine translated for wasmtime (see scripts/setup-tones.mjs)."""
    return public_dir() / "nam" / "nam-engine.exnref.wasm"


def _builtin(asset_id: str, prefix: str, folder: str, ext: str) -> Path:
    name = asset_id[len(prefix) :] if asset_id.startswith(prefix) else ""
    if not _NAME.match(name):
        raise AssetError(UNKNOWN_BUILTIN, id=asset_id)
    return public_dir() / "tones" / folder / f"{name}{ext}"


def builtin_model_path(asset_id: str) -> Path:
    """'nam:jcm' → public/tones/models/jcm.nam"""
    return _builtin(asset_id, "nam:", "models", ".nam")


def builtin_ir_path(asset_id: str) -> Path:
    """'ir:mesa' → public/tones/irs/mesa.wav"""
    return _builtin(asset_id, "ir:", "irs", ".wav")


def read_ir_native(source: Path | str | bytes) -> tuple[np.ndarray, int]:
    """The first channel of a WAV at the file's own rate, and that rate."""
    data, rate = _read_wav(source)
    return np.ascontiguousarray(data[:, 0]), rate


def read_ir(source: Path | str | bytes, sample_rate: int = ENGINE_RATE, channels: str = "first") -> np.ndarray:
    """An impulse response as float32 at `sample_rate`.

    `channels="first"` gives the first channel, shape (n,) — a cabinet; `"all"` gives every
    channel, shape (n, channels) — a reverb.
    """
    data, rate = _read_wav(source)
    if channels == "first":
        data = data[:, :1]
    elif channels != "all":
        raise ValueError("channels: 'first' or 'all'")
    if rate != sample_rate:
        data = np.stack([resample(data[:, c], rate, sample_rate) for c in range(data.shape[1])], axis=1)
    data = np.ascontiguousarray(data, dtype=np.float32)
    return data[:, 0].copy() if channels == "first" else data


def _read_wav(source: Path | str | bytes) -> tuple[np.ndarray, int]:
    if isinstance(source, (bytes, bytearray, memoryview)):
        handle: object = io.BytesIO(bytes(source))
    else:
        path = Path(source)
        if not path.is_file():
            raise AssetError(MISSING_TONES)
        handle = str(path)
    try:
        data, rate = sf.read(handle, dtype="float32", always_2d=True)
    except (sf.LibsndfileError, RuntimeError) as error:
        raise AssetError("amp.irUnreadable") from error
    if not len(data):
        raise AssetError("amp.irSilent")
    return data, int(rate)


def resample(x: np.ndarray, rate_in: int, rate_out: int, half_width: int = 32) -> np.ndarray:
    """Band-limited resampling with a Kaiser-windowed sinc (numpy only; meant for short IRs).

    Built-in cabinets are 48 kHz except one at 44.1 kHz; the browser resamples that one when it
    decodes the file, so we must as well.
    """
    if rate_in == rate_out:
        return np.asarray(x, dtype=np.float32)
    x = np.asarray(x, dtype=np.float64)
    count = int(math.floor(len(x) * rate_out / rate_in + 0.5))
    # Below the lower of the two Nyquist limits, with a little room for the filter's slope.
    cutoff = min(1.0, rate_out / rate_in) * 0.96
    span = half_width / cutoff
    reach = int(math.ceil(span))
    offsets = np.arange(-reach, reach + 1)
    beta = 9.0
    out = np.empty(count, dtype=np.float64)
    padded = np.concatenate([np.zeros(reach + 1), x, np.zeros(reach + 2)])
    # Short steps: each numpy call is brief, so a loader thread never keeps the interpreter long.
    step = 512
    for start in range(0, count, step):
        t = np.arange(start, min(count, start + step)) * (rate_in / rate_out)
        base = np.floor(t).astype(np.int64)
        frac = t - base
        # Distance from each input sample to the output instant, in input samples.
        d = offsets[None, :] - frac[:, None]
        window = np.i0(beta * np.sqrt(np.clip(1 - (d / span) ** 2, 0, None))) / np.i0(beta)
        window[np.abs(d) > span] = 0
        kernel = cutoff * np.sinc(cutoff * d) * window
        idx = base[:, None] + offsets[None, :] + reach + 1
        out[start : start + len(t)] = np.sum(padded[idx] * kernel, axis=1)
    return out.astype(np.float32)


class AssetStore:
    """Amp models and impulse responses by the browser's ids.

    'nam:<file>' and 'ir:<file>' are the built-in files under `tones_dir` (public/tones);
    'user:<id>' are the files the browser sent over (`put_user`). An unknown 'user:' id raises
    KeyError: the engine then asks the browser for the file. Anything else that goes wrong is an
    AssetError (a ValueError) with a message's code.
    """

    def __init__(self, tones_dir: Path | str) -> None:
        self.tones_dir = Path(tones_dir)
        self._lock = threading.Lock()
        self._user: dict[str, tuple[str, bytes]] = {}
        self._irs: dict[tuple[str, str, int], np.ndarray] = {}
        self._revisions: dict[str, int] = {}

    def put_user(self, asset_id: str, kind: str, data: bytes) -> None:
        """Keeps a dropped file: `kind` is 'model' (.nam text) or 'ir' (.wav bytes)."""
        if not asset_id.startswith("user:"):
            raise ValueError(f"not a user file: {asset_id}")
        if kind not in ("model", "ir"):
            raise ValueError(f"unknown asset kind: {kind}")
        with self._lock:
            self._user[asset_id] = (kind, bytes(data))
            self._revisions[asset_id] = self._revisions.get(asset_id, 0) + 1
            for key in [key for key in self._irs if key[0] == asset_id]:
                del self._irs[key]

    def revision(self, asset_id: str) -> int:
        """Goes up each time a 'user:' file is sent again: what was built from the old one is stale."""
        with self._lock:
            return self._revisions.get(asset_id, 0)

    def has(self, asset_id: str) -> bool:
        """False only for a 'user:' file that was never sent."""
        if not asset_id.startswith("user:"):
            return True
        with self._lock:
            return asset_id in self._user

    def _user_data(self, asset_id: str, kind: str) -> bytes:
        with self._lock:
            found = self._user.get(asset_id)
        if found is None or found[0] != kind:
            raise KeyError(asset_id)
        return found[1]

    def _builtin(self, asset_id: str, prefix: str, folder: str, ext: str) -> Path:
        name = asset_id[len(prefix) :] if asset_id.startswith(prefix) else ""
        if not _NAME.match(name):
            raise AssetError(UNKNOWN_BUILTIN, id=asset_id)
        return self.tones_dir / folder / f"{name}{ext}"

    def model_json(self, asset_id: str) -> str:
        """The text of a .nam file."""
        if asset_id.startswith("user:"):
            return self._user_data(asset_id, "model").decode("utf-8", errors="replace")
        path = self._builtin(asset_id, "nam:", "models", ".nam")
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as error:
            raise AssetError(MISSING_TONES) from error
        # The browser checks the contents, because a missing file comes back as a web page there.
        if not text.lstrip().startswith("{"):
            raise AssetError(MISSING_TONES)
        return text

    def ir(self, asset_id: str, channels: str = "first", sample_rate: int = ENGINE_RATE) -> np.ndarray:
        """An impulse response at the engine's rate: (n,) for a cabinet, (n, channels) with
        `channels="all"` for a reverb. The array is shared: do not write to it."""
        key = (asset_id, channels, sample_rate)
        with self._lock:
            cached = self._irs.get(key)
        if cached is not None:
            return cached
        if asset_id.startswith("user:"):
            source: Path | bytes = self._user_data(asset_id, "ir")
        else:
            source = self._builtin(asset_id, "ir:", "irs", ".wav")
        taps = read_ir(source, sample_rate, channels)
        taps.setflags(write=False)
        with self._lock:
            self._irs[key] = taps
        return taps
