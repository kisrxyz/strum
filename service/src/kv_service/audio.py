"""Audio helpers: the uploaded mix, loudness, waveform peaks, FLAC files, tags.

Arrays are float32 with shape (frames, channels), as soundfile reads them.
"""

from __future__ import annotations

import io
import math
from collections.abc import Iterable
from pathlib import Path

import numpy as np
import soundfile as sf

from .messages import UserError

SAMPLE_RATE = 44100
SILENCE_DB = -70.0


class AudioError(UserError, ValueError):
    """A sound file the service cannot use: a code and its values, for the user."""


def read_mix_wav(data: bytes) -> np.ndarray:
    """The browser's decoded song: WAV, 44.1 kHz, stereo, float."""
    try:
        with sf.SoundFile(io.BytesIO(data)) as f:
            if f.samplerate != SAMPLE_RATE:
                raise AudioError("audio.wrongRate", rate=f.samplerate, want=SAMPLE_RATE)
            if f.channels != 2:
                raise AudioError("audio.notStereo", channels=f.channels)
            if f.subtype not in ("FLOAT", "DOUBLE"):
                raise AudioError("audio.notFloat")
            return f.read(dtype="float32", always_2d=True)
    except sf.LibsndfileError as error:
        raise AudioError("audio.unreadable") from error


def loudness_db(x: np.ndarray, sr: int) -> float:
    """Average loudness in dB: mean square over 400 ms blocks, quiet blocks left out.

    Gates as in BS.1770 (without its K-weighting): blocks under -60 dBFS are silence, then blocks
    more than 20 dB below the average of the rest are dropped too.
    """
    block = max(1, int(round(0.4 * sr)))
    count = max(1, len(x) // block)
    squares = np.square(x[: count * block], dtype=np.float64)
    blocks = squares.reshape(count, -1).mean(axis=1) if len(squares) else np.zeros(1)
    kept = blocks[blocks > 10 ** (-60 / 10)]
    if not len(kept):
        return SILENCE_DB
    kept = kept[kept > kept.mean() * 10 ** (-20 / 10)]
    return max(SILENCE_DB, float(10 * np.log10(kept.mean())))


def peaks_int8(x: np.ndarray, sr: int, per_second: int = 100) -> bytes:
    """Waveform for drawing: min and max of the mono mix per 1/per_second s, as int8 pairs."""
    mono = x.mean(axis=1) if x.ndim == 2 else x
    size = sr // per_second
    bins = max(1, math.ceil(len(mono) / size))
    padded = np.zeros(bins * size, dtype=np.float32)
    padded[: len(mono)] = mono
    grid = padded.reshape(bins, size)
    out = np.empty(2 * bins, dtype=np.int8)
    out[0::2] = np.round(np.clip(grid.min(axis=1), -1, 1) * 127)
    out[1::2] = np.round(np.clip(grid.max(axis=1), -1, 1) * 127)
    return out.tobytes()


def headroom_scale(arrays: Iterable[np.ndarray], ceiling: float = 0.98) -> float:
    """One common gain that keeps every array under `ceiling`, so their balance stays the same."""
    peak = max((float(np.max(np.abs(a))) for a in arrays if a.size), default=0.0)
    return 1.0 if peak <= ceiling else ceiling / peak


def gain_db(scale: float) -> float:
    return round(20 * math.log10(scale), 2)


def write_flac(path: Path, x: np.ndarray, sr: int) -> None:
    sf.write(str(path), np.clip(x, -1.0, 1.0), sr, format="FLAC", subtype="PCM_16")


def read_audio(path: Path) -> tuple[np.ndarray, int]:
    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    return data, int(sr)


def read_tags(path: Path) -> dict[str, str]:
    """Title, artist and so on, when soundfile can read the file (mp3, flac, wav, ogg)."""
    try:
        with sf.SoundFile(str(path)) as f:
            return {key: value for key, value in f.copy_metadata().items() if isinstance(value, str)}
    except Exception:  # noqa: BLE001 - m4a and broken files simply have no tags for us
        return {}
