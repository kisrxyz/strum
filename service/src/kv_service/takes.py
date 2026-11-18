"""Takes («Запись»): the user's own playing, recorded by the app.

While it records, the browser sends up to three tracks in chunks of 16-bit stereo PCM:

- `guitar`: the guitar as the player heard it (the engine's final output);
- `band`: the song as it reached the speakers (absent when no song played);
- `dry`: the card's raw input, both halves, before the hum filter and the gate — on the guitar's
  own frames (the app numbers it from the guitar's first frame). Not in the mix: it is kept to
  check the input's noise, hum and level by (2026-11-16).

Each chunk carries an *anchor*: the browser's clock (performance.now(), ms) at the moment the
player lived the chunk's first frame — for the guitar the moment the string was hit, for the band
the moment it was heard. The tracks come from two sound clocks (the guitar engine's card and
Chrome's output, maybe two devices), so on finish a line is fitted through each track's anchors
and the band is resampled onto the guitar's timeline. That takes up both the offset between the
tracks and the drift of one clock against the other.

A take is the folder `takes/<id>/` of the library: `take.json`; while recording the raw tracks
(`<track>.pcm`, written at each chunk's frame, so a lost chunk is silence in its place) and their
anchors (`<track>.anchors`, "frame rate ms" lines); once saved `guitar.flac`, `band.flac` (on the
guitar's timeline and rate), `dry.flac` and `take.mp3`, what the player heard, peak-normalised.
"""

from __future__ import annotations

import json
import math
import re
import secrets
import threading
from collections.abc import Sequence
from datetime import datetime
from pathlib import Path

import lameenc
import numpy as np
import soundfile as sf

from .export import _safe_file_name
from .library import _now, _remove_tree, _replace, _write_json
from .messages import UserError, failure

TAKES_DIR = "takes"
TAKE_FILE = "take.json"
TAKE_ID_RE = re.compile(r"^[0-9a-f]{12}$")
TRACKS = ("guitar", "band", "dry")

MAX_SECONDS = 30 * 60
# The app stops at 30 minutes; chunks in flight may still arrive a little later.
MAX_FRAMES_S = MAX_SECONDS + 60
MIN_SECONDS = 1.0
MAX_CHUNK_BYTES = 4 << 20
MIN_RATE, MAX_RATE = 8000, 192_000
MAX_OFFSET_MS = 500

# A clock fit whose slope is further than this from the nominal rate is noise, not a sound card.
MAX_DRIFT = 2e-3
# Anchors further than this off the fitted line (a chunk whose moment was misjudged) are dropped once.
OUTLIER_MS = 3.0
# A band quieter than this everywhere (−60 dBFS) was no song: the take keeps the guitar alone.
SILENT_BAND = 0.001
# The mix is raised (at most +20 dB) or lowered so that its peak sits here (−1 dBFS).
PEAK_TARGET = 10 ** (-1 / 20)
MAX_GAIN = 10.0

BLOCK = 1 << 18  # frames per pass step (5.5 s at 48 kHz)

# Codes of messages (messages.py): the app has the words.
TOO_SHORT = "take.tooShort"
TOO_LONG = "take.tooLong"  # limit (seconds)
NOT_RECORDING = "take.notRecording"
RATE_CHANGED = "take.rateChanged"
BAD_CHUNK = "take.chunkBroken"
BROKEN = "take.broken"  # reason

# file-name words (exception): the title of a take without a song and the name a downloaded take
# gets are file names, in the language the app asks for (`lang`).
FILE_WORDS = {
    "en": {"noSong": "No song", "take": "take"},
    "ru": {"noSong": "Без песни", "take": "запись"},
}


class TakeNotFound(LookupError):
    pass


class TakeError(UserError, ValueError):
    """Something the user did or the recording went wrong: a code and its values."""


Clock = tuple[float, float]  # (t0 ms, ms per frame): the moment of frame f is t0 + slope·f


def fit_clock(points: Sequence[tuple[float, float]], rate: float) -> Clock:
    """A line through a track's (frame, ms) anchors.

    Least squares; anchors more than 3 ms off the line are dropped once and the line fitted again.
    Too few points, too little spread or a slope further than 0.2 % from the nominal 1000 / rate
    (noise, not a sound card) keep the nominal slope and only fit the offset.
    """
    if not points:
        raise ValueError("no anchors")
    nominal = 1000.0 / rate
    frames = np.array([p[0] for p in points], dtype=np.float64)
    moments = np.array([p[1] for p in points], dtype=np.float64)

    def line(f: np.ndarray, t: np.ndarray) -> Clock:
        if len(f) >= 2 and np.ptp(f) >= rate * 0.5:
            slope, t0 = np.polyfit(f, t, 1)
            if abs(slope / nominal - 1) <= MAX_DRIFT:
                return float(t0), float(slope)
        return float(np.median(t - nominal * f)), nominal

    t0, slope = line(frames, moments)
    keep = np.abs(moments - (t0 + slope * frames)) <= OUTLIER_MS
    if 0 < keep.sum() < len(frames):
        t0, slope = line(frames[keep], moments[keep])
    return t0, slope


def band_positions(start: int, count: int, guitar: Clock, band: Clock) -> np.ndarray:
    """Where in the band track (fractional frames) guitar frames start … start+count were heard."""
    i = np.arange(start, start + count, dtype=np.float64)
    return (guitar[0] + guitar[1] * i - band[0]) / band[1]


def interp_cubic(seg: np.ndarray, x: np.ndarray) -> np.ndarray:
    """Catmull-Rom interpolation of `seg` (m, 2) at fractional frames `x`, each within [1, m − 2]."""
    i = np.floor(x).astype(np.int64)
    f = (x - i)[:, None].astype(np.float32)
    p0, p1, p2, p3 = seg[i - 1], seg[i], seg[i + 1], seg[i + 2]
    return p1 + 0.5 * f * (p2 - p0 + f * (2 * p0 - 5 * p1 + 4 * p2 - p3 + f * (3 * (p1 - p2) + p3 - p0)))


def _pcm_frames(path: Path) -> int:
    return path.stat().st_size // 4 if path.exists() else 0


def _flac_from_pcm(raw: Path, path: Path, rate: int, frames: int) -> None:
    """The first `frames` frames of a raw track as 16-bit stereo FLAC; zeros where it has none."""
    total = _pcm_frames(raw)
    with sf.SoundFile(str(path), "w", samplerate=rate, channels=2, format="FLAC", subtype="PCM_16") as out:
        for start in range(0, frames, BLOCK):
            out.write(_read_pcm(raw, start, min(frames, start + BLOCK), total))


def _read_pcm(path: Path, start: int, stop: int, total: int) -> np.ndarray:
    """Frames start … stop of a raw track as float32 (n, 2); zeros outside the track."""
    out = np.zeros((stop - start, 2), dtype=np.float32)
    a, b = max(start, 0), min(stop, total)
    if a < b:
        with path.open("rb") as f:
            f.seek(a * 4)
            data = np.frombuffer(f.read((b - a) * 4), dtype="<i2").reshape(-1, 2)
        out[a - start : a - start + len(data)] = data / 32768.0
    return out


class _FlacReader:
    """Reads any range of a FLAC file, zeros outside it."""

    def __init__(self, path: Path) -> None:
        self._file = sf.SoundFile(str(path))
        self.frames = self._file.frames

    def read(self, start: int, stop: int) -> np.ndarray:
        out = np.zeros((stop - start, 2), dtype=np.float32)
        a, b = max(start, 0), min(stop, self.frames)
        if a < b:
            self._file.seek(a)
            data = self._file.read(b - a, dtype="float32", always_2d=True)
            out[a - start : a - start + len(data)] = data[:, :2]
        return out

    def close(self) -> None:
        self._file.close()


def _anchors(path: Path) -> tuple[int | None, list[tuple[float, float]]]:
    """(rate, [(frame, ms)]) of a track's anchors file; (None, []) when there is none."""
    if not path.exists():
        return None, []
    rate: int | None = None
    points: list[tuple[float, float]] = []
    for line in path.read_text(encoding="ascii").splitlines():
        parts = line.split()
        if len(parts) != 3:
            continue  # a line cut by a crash
        try:
            frame, line_rate, moment = int(parts[0]), int(parts[1]), float(parts[2])
        except ValueError:
            continue
        rate = rate or line_rate
        if math.isfinite(moment):
            points.append((frame, moment))
    return rate, points


def file_stamp(created_at: str) -> str:
    """«15.11 18-30» in local time (Windows does not allow ":" in file names)."""
    try:
        moment = datetime.fromisoformat(created_at).astimezone()
    except ValueError:
        return ""
    return moment.strftime("%d.%m %H-%M")


def download_name(take: dict, lang: str = "en") -> str:
    """The name of a downloaded take: «Кино - Кукушка (запись 15.11 18-30).mp3», its words in `lang`."""
    words = FILE_WORDS.get(lang, FILE_WORDS["en"])
    base = f"{take['artist']} - {take['title']}" if take.get("artist") else take["title"]
    return _safe_file_name(base, lang)[:150] + f" ({words['take']} {file_stamp(take['createdAt'])}).mp3"


class Takes:
    def __init__(self, library_root: Path) -> None:
        self.root = library_root / TAKES_DIR
        self.lock = threading.RLock()
        self._rates: dict[tuple[str, str], int] = {}

    # --- files ---------------------------------------------------------------------------------

    def folder(self, take_id: str) -> Path:
        if not TAKE_ID_RE.match(take_id or ""):
            raise TakeNotFound(take_id)
        return self.root / take_id

    def mp3_path(self, take_id: str) -> Path:
        take = self.get(take_id)
        if take["status"] != "ready":
            raise TakeNotFound(take_id)
        return self.folder(take_id) / "take.mp3"

    def get(self, take_id: str) -> dict:
        path = self.folder(take_id) / TAKE_FILE
        with self.lock:
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except FileNotFoundError as error:
                raise TakeNotFound(take_id) from error

    def _save(self, take: dict) -> dict:
        with self.lock:
            _write_json(self.folder(take["id"]) / TAKE_FILE, take)
        return take

    def _patch(self, take_id: str, **fields) -> dict:
        with self.lock:
            return self._save({**self.get(take_id), **fields})

    def list(self) -> list[dict]:
        if not self.root.exists():
            return []
        takes = []
        for folder in self.root.iterdir():
            if folder.is_dir() and TAKE_ID_RE.match(folder.name):
                try:
                    takes.append(self.get(folder.name))
                except (TakeNotFound, ValueError):
                    continue
        return sorted(takes, key=lambda t: t["createdAt"], reverse=True)

    # --- recording -----------------------------------------------------------------------------

    def create(self, title: str, artist: str, song_id: str | None, path: str, lang: str = "en") -> dict:
        """A new take, recording. Without a title it is named «No song» in `lang`."""
        with self.lock:
            self.root.mkdir(parents=True, exist_ok=True)
            while True:
                take_id = secrets.token_hex(6)
                folder = self.root / take_id
                if not folder.exists():
                    break
            folder.mkdir()
            return self._save(
                {
                    "id": take_id,
                    "title": title.strip() or FILE_WORDS.get(lang, FILE_WORDS["en"])["noSong"],
                    "artist": artist.strip(),
                    "songId": song_id,
                    "createdAt": _now(),
                    "status": "recording",
                    "error": None,
                    "duration": 0.0,
                    "sampleRate": None,
                    "hasBand": False,
                    "guitarOffsetMs": 0,
                    "path": path,
                }
            )

    def append(self, take_id: str, track: str, at: int, rate: int, moment: float, data: bytes) -> None:
        """Writes a chunk at its frame and notes its anchor."""
        if track not in TRACKS:
            raise TakeError(BAD_CHUNK)
        if not data or len(data) % 4 or len(data) > MAX_CHUNK_BYTES or at < 0 or not math.isfinite(moment):
            raise TakeError(BAD_CHUNK)
        if not MIN_RATE <= rate <= MAX_RATE:
            raise TakeError(BAD_CHUNK)
        if at + len(data) // 4 > MAX_FRAMES_S * rate:
            raise TakeError(TOO_LONG, limit=MAX_SECONDS)
        folder = self.folder(take_id)
        with self.lock:
            if self.get(take_id)["status"] != "recording":
                raise TakeError(NOT_RECORDING)
            key = (take_id, track)
            known = self._rates.get(key) or _anchors(folder / f"{track}.anchors")[0]
            if known is not None and known != rate:
                raise TakeError(RATE_CHANGED)
            self._rates[key] = rate
            raw = folder / f"{track}.pcm"
            with raw.open("r+b" if raw.exists() else "wb") as f:
                f.seek(at * 4)  # past the end: the gap reads back as zeros
                f.write(data)
            with (folder / f"{track}.anchors").open("a", encoding="ascii") as f:
                f.write(f"{at} {rate} {moment!r}\n")

    def finish(self, take_id: str) -> dict:
        """Builds the take's files. TakeError (too short) leaves the folder for the caller to remove."""
        with self.lock:
            take = self.get(take_id)
            if take["status"] == "ready":
                return take
            take = self._patch(take_id, status="saving")
            for track in TRACKS:
                self._rates.pop((take_id, track), None)
        folder = self.folder(take_id)
        try:
            fields = self._build(folder, take)
        except TakeError:
            raise
        except Exception as error:  # noqa: BLE001 — told to the user, with the error as the reason
            return self._patch(take_id, status="error", error=failure(BROKEN, error))
        for track in TRACKS:
            (folder / f"{track}.pcm").unlink(missing_ok=True)
            (folder / f"{track}.anchors").unlink(missing_ok=True)
        return self._patch(take_id, status="ready", error=None, **fields)

    def _build(self, folder: Path, take: dict) -> dict:
        g_raw, b_raw = folder / "guitar.pcm", folder / "band.pcm"
        g_rate, g_points = _anchors(folder / "guitar.anchors")
        g_frames = _pcm_frames(g_raw)
        if g_rate is None or not g_points or g_frames < MIN_SECONDS * g_rate:
            raise TakeError(TOO_SHORT)
        _flac_from_pcm(g_raw, folder / "guitar.flac", g_rate, g_frames)
        # The dry input is on the guitar's frames already: written as it came, as long as the guitar.
        d_raw = folder / "dry.pcm"
        d_rate, _ = _anchors(folder / "dry.anchors")
        if d_rate == g_rate and _pcm_frames(d_raw):
            _flac_from_pcm(d_raw, folder / "dry.flac", g_rate, g_frames)
        else:
            (folder / "dry.flac").unlink(missing_ok=True)

        b_rate, b_points = _anchors(folder / "band.anchors")
        b_frames = _pcm_frames(b_raw)
        has_band = b_rate is not None and bool(b_points) and self._loud(b_raw, b_frames)
        if has_band:
            assert b_rate is not None
            g_clock = fit_clock(g_points, g_rate)
            b_clock = fit_clock(b_points, b_rate)
            with sf.SoundFile(str(folder / "band.flac"), "w", samplerate=g_rate, channels=2, format="FLAC", subtype="PCM_16") as out:
                for start in range(0, g_frames, BLOCK):
                    count = min(g_frames, start + BLOCK) - start
                    x = band_positions(start, count, g_clock, b_clock)
                    lo = math.floor(float(x.min()))
                    hi = math.floor(float(x.max())) + 1
                    seg = _read_pcm(b_raw, lo - 1, hi + 2, b_frames)
                    out.write(np.clip(interp_cubic(seg, x - (lo - 1)), -1.0, 1.0))
        else:
            (folder / "band.flac").unlink(missing_ok=True)
        self._render(folder, g_rate, has_band, int(take.get("guitarOffsetMs") or 0))
        return {"duration": round(g_frames / g_rate, 3), "sampleRate": g_rate, "hasBand": has_band}

    @staticmethod
    def _loud(raw: Path, frames: int) -> bool:
        threshold = SILENT_BAND * 32768
        with raw.open("rb") as f:
            for _ in range(0, frames, BLOCK):
                data = np.frombuffer(f.read(BLOCK * 4), dtype="<i2")
                if data.size and int(np.abs(data.astype(np.int32)).max()) > threshold:
                    return True
        return False

    def _render(self, folder: Path, rate: int, has_band: bool, offset_ms: int) -> None:
        """take.mp3: the guitar (moved by `offset_ms`, later when positive) plus the band, peak-normalised."""
        guitar = _FlacReader(folder / "guitar.flac")
        band = _FlacReader(folder / "band.flac") if has_band else None
        shift = round(offset_ms * rate / 1000)
        frames = guitar.frames

        def mix(start: int, stop: int) -> np.ndarray:
            out = guitar.read(start - shift, stop - shift)
            if band is not None:
                out += band.read(start, stop)
            return out

        try:
            peak = 0.0
            for start in range(0, frames, BLOCK):
                peak = max(peak, float(np.abs(mix(start, min(frames, start + BLOCK))).max(initial=0.0)))
            gain = min(MAX_GAIN, PEAK_TARGET / peak) if peak > 1e-6 else 1.0
            encoder = lameenc.Encoder()
            encoder.set_bit_rate(192)
            encoder.set_in_sample_rate(rate)
            encoder.set_channels(2)
            encoder.set_quality(2)
            tmp = folder / "take.mp3.tmp"
            with tmp.open("wb") as f:
                for start in range(0, frames, BLOCK):
                    x = np.clip(mix(start, min(frames, start + BLOCK)) * gain, -1.0, 1.0)
                    f.write(bytes(encoder.encode((x * 32767).astype("<i2").tobytes())))
                f.write(bytes(encoder.flush()))
        finally:
            guitar.close()
            if band is not None:
                band.close()
        _replace(tmp, folder / "take.mp3")

    # --- after -----------------------------------------------------------------------------------

    def update(self, take_id: str, guitar_offset_ms: int) -> dict:
        """«Гитара раньше / позже»: moves the guitar against the band and builds the mp3 again."""
        take = self.get(take_id)
        if take["status"] != "ready":
            raise TakeError(NOT_RECORDING)
        offset = max(-MAX_OFFSET_MS, min(MAX_OFFSET_MS, int(guitar_offset_ms)))
        self._render(self.folder(take_id), int(take["sampleRate"]), bool(take["hasBand"]), offset)
        return self._patch(take_id, guitarOffsetMs=offset)

    def delete(self, take_id: str) -> None:
        folder = self.folder(take_id)
        with self.lock:
            if not (folder / TAKE_FILE).exists():
                raise TakeNotFound(take_id)
            for track in TRACKS:
                self._rates.pop((take_id, track), None)
            _remove_tree(folder)

    def recover(self) -> None:
        """After a restart: saves takes a closed tab left unfinished; removes those too short to keep."""
        for take in self.list():
            if take["status"] in ("recording", "saving"):
                try:
                    self.finish(take["id"])
                except TakeError:
                    self.delete(take["id"])
