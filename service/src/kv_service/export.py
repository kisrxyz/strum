"""The backing track to take away: stems mixed as in the player, slowed down, as mp3.

python-stretch is the same Signalsmith Stretch the browser player uses, so the file sounds like
what you heard. Its `process()` returns exactly n / speed samples with no time shift.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from urllib.parse import quote

import lameenc
import numpy as np
import python_stretch

from .library import STEMS

PEAK_DB = -1.0

# file-name words (exception): the backing track's name is a file name, in the language the app
# asks for (`lang`).
FILE_WORDS = {
    "en": {
        "backing": "Backing track",
        "noGuitar": "no guitar",
        "guitarOnly": "guitar only",
        "withGuitar": "with guitar",
        "pitch": "pitch",
    },
    "ru": {
        "backing": "Минусовка",
        "noGuitar": "без гитары",
        "guitarOnly": "только гитара",
        "withGuitar": "с гитарой",
        "pitch": "тон",
    },
}


@dataclass
class ExportRequest:
    model: str
    gains: dict[str, float] = field(default_factory=dict)  # linear; a stem left out plays at 1
    speed: float = 1.0  # playback rate, 0.5–1
    semitones: float = 0.0  # cents included: −1.05 = a semitone and 5 cents down
    start: float = 0.0
    end: float | None = None


def stretch(x: np.ndarray, sr: int, speed: float, semitones: float) -> np.ndarray:
    """(frames, 2) at `speed` (0.8 = slower, 1.25× longer) and shifted by `semitones`."""
    if speed == 1 and semitones == 0:
        return x
    stretcher = python_stretch.Signalsmith.Stretch()
    stretcher.preset(x.shape[1], sr)
    stretcher.setTimeFactor(speed)  # despite the name, this is the playback rate
    stretcher.setTransposeSemitones(semitones)
    return np.ascontiguousarray(stretcher.process(np.ascontiguousarray(x.T, dtype=np.float32)).T)


def render_backing(stems: dict[str, np.ndarray], sr: int, req: ExportRequest) -> np.ndarray:
    frames = min(len(s) for s in stems.values())
    mix = np.zeros((frames, 2), dtype=np.float32)
    for stem in STEMS:
        gain = req.gains.get(stem, 1.0)
        if gain:
            mix += stems[stem][:frames] * gain
    start = min(frames, max(0, int(round(req.start * sr))))
    end = frames if req.end is None else min(frames, max(start, int(round(req.end * sr))))
    out = stretch(mix[start:end], sr, req.speed, req.semitones)
    peak = float(np.max(np.abs(out))) if out.size else 0.0
    if peak > 0:
        out = out * (10 ** (PEAK_DB / 20) / peak)
    return out.astype(np.float32)


def encode_mp3(x: np.ndarray, sr: int, kbps: int = 192) -> bytes:
    encoder = lameenc.Encoder()
    encoder.set_bit_rate(kbps)
    encoder.set_in_sample_rate(sr)
    encoder.set_channels(2)
    encoder.set_quality(2)
    pcm = (np.clip(x, -1.0, 1.0) * 32767).astype("<i2").tobytes()  # (frames, 2) row-major = interleaved
    return bytes(encoder.encode(pcm) + encoder.flush())


def _words(lang: str) -> dict[str, str]:
    return FILE_WORDS.get(lang, FILE_WORDS["en"])


def _signed(value: float, lang: str = "en") -> str:
    """+0.5 and -1.05 in English; +0,5 and −1,05 (a decimal comma, the minus sign) in Russian."""
    text = f"{abs(value):.2f}".rstrip("0").rstrip(".")
    if lang == "ru":
        return ("+" if value > 0 else "−") + text.replace(".", ",")
    return ("+" if value > 0 else "-") + text


def _clock(seconds: float) -> str:
    # m.ss: Windows does not allow ":" in file names
    total = int(round(seconds))
    return f"{total // 60}.{total % 60:02d}"


def _safe_file_name(name: str, lang: str = "en") -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name.rstrip(". ") or _words(lang)["backing"]


def export_file_name(song: dict, req: ExportRequest, lang: str = "en") -> str:
    """«Кино - Кукушка (без гитары, 80%, тон −1, 1.05–1.32).mp3», its words in `lang`."""
    words = _words(lang)
    base = f"{song['artist']} - {song['title']}" if song.get("artist") else song["title"]
    gains = req.gains
    if gains.get("guitar", 1.0) == 0:
        parts = [words["noGuitar"]]
    elif all(gains.get(stem, 1.0) == 0 for stem in STEMS if stem != "guitar"):
        parts = [words["guitarOnly"]]
    else:
        parts = [words["withGuitar"]]
    if round(req.speed * 100) != 100:
        parts.append(f"{round(req.speed * 100)}%")
    if round(req.semitones, 2) != 0:
        parts.append(f"{words['pitch']} {_signed(req.semitones, lang)}")
    whole = req.start <= 0.05 and (req.end is None or req.end >= song["duration"] - 0.05)
    if not whole:
        end = song["duration"] if req.end is None else req.end
        parts.append(f"{_clock(req.start)}–{_clock(end)}")
    return _safe_file_name(base, lang)[:150] + f" ({', '.join(parts)}).mp3"


def content_disposition(name: str, fallback: str = "backing-track.mp3") -> str:
    """An ASCII fallback for old clients plus the real UTF-8 name (RFC 5987)."""
    ascii_name = re.sub(r"[^A-Za-z0-9 ._()%-]", "", name).strip()
    if len(ascii_name) < 8:
        ascii_name = fallback
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name, safe='')}"
