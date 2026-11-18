"""The song library on disk: one folder per song.

    library/<id>/song.json        everything about the song, readable by eye
                 original.<ext>   the dropped file as it was
                 mix.flac         the browser's decoded song, 44.1 kHz stereo
                 peaks.bin        waveform for drawing (int8 min/max pairs, 100 per second)
                 stems/<model>/<stem>.flac
                 analysis.json    beats, chords, key, sections… (the machine's; the user's
                                  corrections live in song.json and survive a new analysis)
                 words.json       the words heard in the vocal stem, with times (Whisper)
                 tab.<ext>        the song's tab: Guitar Pro, MusicXML or alphaTex

A *tab-song* (`kind: "tab"`) has only song.json and tab.<ext>: the app plays the tab itself (its
synthesizer renders the parts when the song opens), so there is nothing to separate, analyse or
hear. Its id is the start of the SHA-256 of the tab file.

<id> is the start of the SHA-256 of the original file, so the same song is never added twice.
New folders and stems are built under a `.tmp-` name and renamed when complete: a crash or a
deletion in the middle never leaves something that looks finished.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import shutil
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from .analysis import ANALYSIS_VERSION, pitch_available
from .lyrics import TRANSCRIPT_VERSION
from .messages import UserError, message
from .audio import SAMPLE_RATE, gain_db, headroom_scale, loudness_db, peaks_int8, read_tags, write_flac
from .names import guess_title_artist

STEMS = ("vocals", "drums", "bass", "guitar", "piano", "other")
SONG_ID_RE = re.compile(r"^[0-9a-f]{12}$")
SONG_FILE = "song.json"
ANALYSIS_FILE = "analysis.json"
ANALYSIS = "analysis"  # the job queue's name for an analysis job (next to the model ids)
WORDS_FILE = "words.json"
TRANSCRIBE = "transcribe"  # the job queue's name for hearing the words of the vocals
TAB_EXTENSIONS = ("gp", "gp3", "gp4", "gp5", "gpx", "musicxml", "mxl", "xml", "alphatex")
MAX_TAB_BYTES = 10 * 2**20
# An analysis that was still running when the service stopped this many times is not started
# again by itself: it probably crashes the service (a native crash cannot be caught).
MAX_ANALYSIS_ATTEMPTS = 2
UNFINISHED = ("queued", "running")


class SongNotFound(KeyError):
    pass


class LibraryError(UserError, ValueError):
    """A change the library refuses; the user is told why."""


class NoTab(LibraryError):
    """The song has no tab to change."""


class TabSongTab(LibraryError):
    """A tab-song's tab is the song itself: it cannot be replaced or removed."""


KIND_TAB = "tab"
KIND_RECORDING = "recording"


def is_tab_song(song: dict) -> bool:
    """The song is a tab played by the app itself: no recording, stems or analysis jobs."""
    return song.get("kind") == KIND_TAB


def default_player() -> dict:
    return {
        "speed": 1.0,
        "semitones": 0,
        "cents": 0,
        "volumesDb": {stem: 0 for stem in STEMS},
        "muted": ["guitar"],
        "solo": None,
        "loop": {"start": 0, "end": 0, "on": False},
        "bookmarks": [],
        "presetId": None,
        # stage 2
        "capo": 0,
        "tuning": "standard",
        "simpleChords": False,
        "mode": "play",
        "reveal": 0,
        "countIn": False,
        "click": False,
        "toneMatch": True,
        "tuningApplied": False,
        # stage 3
        "view": "chords",
    }


def stage_2_fields() -> dict:
    """Top-level song.json fields added in stage 2 (older songs get them when read)."""
    return {"analysis": None, "chords": None, "barShift": 0}


def stage_3_fields() -> dict:
    """Top-level song.json fields added in stage 3: the heard words' state, the user's lyrics and tab;
    and in stage 4: the user's edited notes of the guitar (null: the analysis' own) and the lists."""
    return {"transcript": None, "lyrics": None, "tab": None, "guitarNotes": None, "lists": []}


def _with_defaults(song: dict) -> dict:
    song.setdefault("kind", KIND_RECORDING)
    for key, value in {**stage_2_fields(), **stage_3_fields()}.items():
        song.setdefault(key, value)
    player = song.setdefault("player", default_player())
    for key, value in default_player().items():
        player.setdefault(key, value)
    return song


def has_ready_stems(song: dict) -> bool:
    """The active model's stems are there: the analysis can hear them."""
    model = song.get("activeModel")
    return bool(model) and song["stems"].get(model, {}).get("status") == "ready"


def analysis_needed(song: dict) -> bool:
    """Whether the song should be analysed (again) with what it has now: never analysed, failed,
    made by an older version, or made from the whole mix while stems are ready now. A queued or
    running analysis is already on its way. A tab-song's analysis comes from its score."""
    if is_tab_song(song):
        return False
    info = song.get("analysis")
    if info is None:
        return True
    status = info.get("status")
    if status in UNFINISHED:
        return False
    if status == "error" or info.get("version", 0) < ANALYSIS_VERSION:
        return True
    if info.get("notesMissing") and has_ready_stems(song) and pitch_available():
        return True  # made before the notes' model was installed
    return info.get("source") == "mix" and has_ready_stems(song)


def transcript_needed(song: dict) -> bool:
    """Whether the words of the vocals should be heard again by themselves: there is a vocal stem,
    and words the user asked for once failed, are from an older version or from another model's
    stems. Never heard: only on request (Whisper is 3 GB and slow without a graphics card,
    2026-11-17). A queued or running transcription is already on its way."""
    if is_tab_song(song) or not has_ready_stems(song):
        return False
    info = song.get("transcript")
    if info is None:
        return False
    status = info.get("status")
    if status in UNFINISHED:
        return False
    if status == "error" or info.get("version", 0) < TRANSCRIPT_VERSION:
        return True
    return info.get("source") != song.get("activeModel")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _stamp(previous: str | None) -> str:
    """A finish time in milliseconds that differs from the previous one: the app puts it in the
    analysis URL, so a new analysis is never mistaken for the old one in a cache."""
    while True:
        stamp = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
        if stamp != previous:
            return stamp
        time.sleep(0.001)


def _replace(src: Path, dst: Path, attempts: int = 30) -> None:
    """os.replace that waits up to 3 s: on Windows a file someone has open (an antivirus, an
    editor, a request reading it) cannot be renamed or replaced."""
    for attempt in range(attempts):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if attempt == attempts - 1:
                raise
            time.sleep(0.1)


def _write_json(path: Path, data: dict, indent: int | None = 2) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=indent), encoding="utf-8")
    _replace(tmp, path)


def _remove_tree(path: Path, attempts: int = 10) -> bool:
    """rmtree that waits for Windows file locks (a stem being served, a scanner). False if it gave up."""
    for _ in range(attempts):
        if not path.exists():
            return True
        shutil.rmtree(path, ignore_errors=True)
        if not path.exists():
            return True
        time.sleep(0.2)
    return not path.exists()


def _original_ext(file_name: str) -> str:
    ext = file_name.rsplit(".", 1)[-1].lower() if "." in file_name else ""
    return ext if re.fullmatch(r"[a-z0-9]{1,5}", ext) else "bin"


class Library:
    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        # One lock for every change on disk; the separation worker holds it while it writes stems.
        self.lock = threading.RLock()

    @staticmethod
    def song_id(original: bytes) -> str:
        return hashlib.sha256(original).hexdigest()[:12]

    # ---- paths

    def song_dir(self, song_id: str) -> Path:
        if not SONG_ID_RE.match(song_id or ""):
            raise SongNotFound(song_id)
        return self.root / song_id

    def original_path(self, song_id: str) -> Path:
        return self.song_dir(song_id) / f"original.{self.get(song_id)['originalExt']}"

    def mix_path(self, song_id: str) -> Path:
        return self.song_dir(song_id) / "mix.flac"

    def peaks_path(self, song_id: str) -> Path:
        return self.song_dir(song_id) / "peaks.bin"

    def stems_dir(self, song_id: str, model: str) -> Path:
        return self.song_dir(song_id) / "stems" / model

    def stem_path(self, song_id: str, model: str, stem: str) -> Path:
        return self.stems_dir(song_id, model) / f"{stem}.flac"

    def analysis_path(self, song_id: str) -> Path:
        return self.song_dir(song_id) / ANALYSIS_FILE

    def words_path(self, song_id: str) -> Path:
        return self.song_dir(song_id) / WORDS_FILE

    def tab_path(self, song_id: str, ext: str) -> Path:
        return self.song_dir(song_id) / f"tab.{ext}"

    # ---- songs

    def create(self, original: bytes, file_name: str, mix: np.ndarray) -> tuple[dict, bool]:
        """Adds a song (mix: float32 (frames, 2) at 44.1 kHz). Returns (song, created)."""
        song_id = self.song_id(original)
        folder = self.song_dir(song_id)
        with self.lock:
            if (folder / SONG_FILE).exists():
                return self.get(song_id), False
            tmp = self.root / f".tmp-{song_id}"
            _remove_tree(tmp)
            tmp.mkdir()
            ext = _original_ext(file_name)
            (tmp / f"original.{ext}").write_bytes(original)
            title, artist = guess_title_artist(read_tags(tmp / f"original.{ext}"), file_name)
            scale = headroom_scale([mix])
            stored = mix * scale if scale < 1 else mix
            write_flac(tmp / "mix.flac", stored, SAMPLE_RATE)
            (tmp / "peaks.bin").write_bytes(peaks_int8(stored, SAMPLE_RATE))
            song = {
                "version": 1,
                "id": song_id,
                "title": title,
                "artist": artist,
                "fileName": file_name,
                "originalExt": ext,
                "addedAt": _now(),
                "duration": round(len(stored) / SAMPLE_RATE, 3),
                "sampleRate": SAMPLE_RATE,
                "loudnessDb": round(loudness_db(stored, SAMPLE_RATE), 2),
                "mixGainDb": gain_db(scale),
                "stems": {},
                "activeModel": None,
                "notes": "",
                "player": default_player(),
                **stage_2_fields(),
                **stage_3_fields(),
            }
            _write_json(tmp / SONG_FILE, song)
            _remove_tree(folder)  # leftovers of a song deleted while its files were locked
            _replace(tmp, folder)
        return song, True

    def create_tab_song(self, data: bytes, name: str, meta: dict) -> tuple[dict, bool]:
        """Adds a tab-song: the tab file is the whole song (see the module's doc). `meta` is what the
        app read from the score: title, artist (may be empty: the file name's guess then), duration,
        loudnessDb, tempo, meter, track (the part shown first), capo. Returns (song, created)."""
        ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
        if ext not in TAB_EXTENSIONS:
            raise LibraryError("tab.notATab")
        song_id = self.song_id(data)
        folder = self.song_dir(song_id)
        with self.lock:
            if (folder / SONG_FILE).exists():
                return self.get(song_id), False
            tmp = self.root / f".tmp-{song_id}"
            _remove_tree(tmp)
            tmp.mkdir()
            (tmp / f"tab.{ext}").write_bytes(data)
            title, artist = str(meta.get("title") or "").strip(), str(meta.get("artist") or "").strip()
            if not title or not artist:
                # A score often has no artist (or no title): «Кино — Группа крови.gp4» says both.
                guessed_title, guessed_artist = guess_title_artist({}, name)
                title, artist = (title, artist) if title and not guessed_artist else (guessed_title, guessed_artist or artist)
            now = _now()
            player = default_player()
            player.update({"view": "tab", "muted": [], "capo": int(meta.get("capo") or 0)})
            song = {
                "version": 1,
                "kind": KIND_TAB,
                "id": song_id,
                "title": title[:200],
                "artist": artist[:200],
                "fileName": name[-300:],
                "originalExt": ext,
                "addedAt": now,
                "duration": round(float(meta.get("duration") or 0), 3),
                "sampleRate": SAMPLE_RATE,
                "loudnessDb": round(float(meta.get("loudnessDb") or -20.0), 2),
                "mixGainDb": 0.0,
                "stems": {},
                "activeModel": None,
                "notes": "",
                "player": player,
                **stage_2_fields(),
                **stage_3_fields(),
            }
            # The list shows the tempo and the meter; the app makes the rest from the score itself.
            song["analysis"] = {
                "status": "ready",
                "version": 0,
                "source": KIND_TAB,
                "tempo": round(float(meta.get("tempo") or 0), 2),
                "meter": int(meta.get("meter") or 4),
                "key": copy.deepcopy(meta.get("key")),
            }
            song["tab"] = {
                "name": name[-200:],
                "ext": ext,
                "size": len(data),
                "addedAt": now,
                "track": int(meta.get("track") or 0),
                "notation": False,
                "offset": 0,
                "ratio": 1,
            }
            _write_json(tmp / SONG_FILE, song)
            _remove_tree(folder)  # leftovers of a song deleted while its files were locked
            _replace(tmp, folder)
        return song, True

    def list(self) -> list[dict]:
        songs = []
        for folder in self.root.iterdir():
            if folder.is_dir() and SONG_ID_RE.match(folder.name) and (folder / SONG_FILE).exists():
                try:
                    songs.append(self.get(folder.name))
                except (SongNotFound, ValueError):
                    continue
        return sorted(songs, key=lambda s: s["addedAt"], reverse=True)

    def get(self, song_id: str) -> dict:
        """song.json; fields a newer stage added get their defaults (written back on the next save)."""
        path = self.song_dir(song_id) / SONG_FILE
        # Under the lock: a request reading song.json would block the worker's replace on Windows.
        with self.lock:
            try:
                return _with_defaults(json.loads(path.read_text(encoding="utf-8")))
            except FileNotFoundError as error:
                raise SongNotFound(song_id) from error

    def _save(self, song: dict) -> dict:
        _write_json(self.song_dir(song["id"]) / SONG_FILE, song)
        return song

    def update(self, song_id: str, patch: dict) -> dict:
        """Applies a validated patch: top-level fields replace, `player` merges, `volumesDb` per stem."""
        with self.lock:
            song = self.get(song_id)
            model = patch.get("activeModel")
            if model is not None and song["stems"].get(model, {}).get("status") != "ready":
                raise LibraryError("stems.notReady")
            if "tab" in patch and song.get("tab") is None:
                raise NoTab("tab.none")
            for key, value in patch.items():
                if key == "tab":
                    song["tab"] = {**song["tab"], **copy.deepcopy(value)}
                elif key != "player":
                    song[key] = copy.deepcopy(value)
            for key, value in (patch.get("player") or {}).items():
                if key == "volumesDb":
                    song["player"]["volumesDb"].update(value)
                else:
                    song["player"][key] = copy.deepcopy(value)
            return self._save(song)

    def set_stems(self, song_id: str, model: str, **fields) -> dict:
        with self.lock:
            song = self.get(song_id)
            song["stems"].setdefault(model, {}).update(fields)
            return self._save(song)

    def write_stems(self, song_id: str, model: str, stems: dict[str, np.ndarray], meta: dict) -> dict:
        """Saves finished stems (float32 (frames, 2) each) with one common headroom gain."""
        with self.lock:
            song = self.get(song_id)  # SongNotFound if it was deleted meanwhile
            scale = headroom_scale(stems.values())
            final = self.stems_dir(song_id, model)
            tmp = final.with_name(f".tmp-{model}")
            _remove_tree(tmp)
            tmp.mkdir(parents=True)
            for stem in STEMS:
                write_flac(tmp / f"{stem}.flac", stems[stem] * scale, SAMPLE_RATE)
            _remove_tree(final)
            _replace(tmp, final)
            song["stems"][model] = {
                **meta,
                "status": "ready",
                "gainDb": gain_db(scale),
                "error": None,
                "finishedAt": _now(),
            }
            if not song.get("activeModel"):
                song["activeModel"] = model
            return self._save(song)

    def set_analysis(self, song_id: str, **fields) -> dict:
        """Merges `fields` into song["analysis"] (the earlier result stays readable meanwhile)."""
        with self.lock:
            song = self.get(song_id)
            song["analysis"] = {**(song.get("analysis") or {}), **fields}
            return self._save(song)

    def write_analysis(self, song_id: str, data: dict, meta: dict) -> dict:
        """Saves analysis.json (atomically) and marks the analysis ready in song.json, with the
        tempo, meter and key the library list shows. The user's chords and bar shift stay."""
        with self.lock:
            song = self.get(song_id)  # SongNotFound if it was deleted meanwhile: nothing is written
            _write_json(self.analysis_path(song_id), data, indent=None)
            previous = (song.get("analysis") or {}).get("finishedAt")
            song["analysis"] = {
                "status": "ready",
                "version": data["version"],
                "source": data["source"],
                "seconds": meta.get("seconds"),
                "device": meta.get("device"),
                "error": None,
                "finishedAt": _stamp(previous),
                "tempo": data["tempo"],
                "meter": data["meter"],
                "key": copy.deepcopy(data["key"]),
                "notesMissing": bool(data.get("notesMissing")),
            }
            return self._save(song)

    def read_analysis(self, song_id: str) -> dict:
        """analysis.json; FileNotFoundError when the song has none yet."""
        with self.lock:
            self.get(song_id)
            return json.loads(self.analysis_path(song_id).read_text(encoding="utf-8"))

    def set_transcript(self, song_id: str, **fields) -> dict:
        """Merges `fields` into song["transcript"] (the earlier words stay readable meanwhile)."""
        with self.lock:
            song = self.get(song_id)
            song["transcript"] = {**(song.get("transcript") or {}), **fields}
            return self._save(song)

    def write_words(self, song_id: str, data: dict, meta: dict) -> dict:
        """Saves words.json (atomically) and marks the transcript ready. The user's lyrics stay."""
        with self.lock:
            song = self.get(song_id)  # SongNotFound if it was deleted meanwhile: nothing is written
            _write_json(self.words_path(song_id), data, indent=None)
            previous = (song.get("transcript") or {}).get("finishedAt")
            song["transcript"] = {
                "status": "ready",
                "version": data["version"],
                "source": data["source"],
                "language": data["language"],
                "seconds": meta.get("seconds"),
                "device": meta.get("device"),
                "error": None,
                "finishedAt": _stamp(previous),
            }
            return self._save(song)

    def read_words(self, song_id: str) -> dict:
        """words.json; FileNotFoundError when the words were not heard yet."""
        with self.lock:
            self.get(song_id)
            return json.loads(self.words_path(song_id).read_text(encoding="utf-8"))

    def write_tab(self, song_id: str, data: bytes, name: str) -> dict:
        """Stores the song's tab (replacing an older one) with automatic bar sync and the first part."""
        ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
        if ext not in TAB_EXTENSIONS:
            raise LibraryError("tab.notATab")
        with self.lock:
            song = self.get(song_id)
            if is_tab_song(song):
                raise TabSongTab("tabSong.tabIsTheSong")
            old = song.get("tab")
            path = self.tab_path(song_id, ext)
            tmp = path.with_name(path.name + ".tmp")
            tmp.write_bytes(data)
            _replace(tmp, path)
            if old and old.get("ext") != ext:
                self.tab_path(song_id, old["ext"]).unlink(missing_ok=True)
            song["tab"] = {
                "name": name[-200:],
                "ext": ext,
                "size": len(data),
                "addedAt": _now(),
                "track": 0,
                "notation": False,
                "offset": None,
                "ratio": None,
            }
            return self._save(song)

    def read_tab(self, song_id: str) -> tuple[bytes, str]:
        """(the tab file, its extension); FileNotFoundError when the song has no tab."""
        with self.lock:
            tab = self.get(song_id).get("tab")
            if not tab:
                raise FileNotFoundError(song_id)
            return self.tab_path(song_id, tab["ext"]).read_bytes(), tab["ext"]

    def drop_tab(self, song_id: str) -> dict:
        with self.lock:
            song = self.get(song_id)
            if is_tab_song(song):
                raise TabSongTab("tabSong.tabIsTheSong")
            tab = song.get("tab")
            if tab:
                self.tab_path(song_id, tab["ext"]).unlink(missing_ok=True)
            song["tab"] = None
            return self._save(song)

    def drop_stems(self, song_id: str, model: str) -> dict:
        with self.lock:
            song = self.get(song_id)
            _remove_tree(self.stems_dir(song_id, model))
            song["stems"].pop(model, None)
            if song.get("activeModel") == model:
                ready = [m for m, info in song["stems"].items() if info.get("status") == "ready"]
                song["activeModel"] = ready[0] if ready else None
            return self._save(song)

    def delete(self, song_id: str) -> None:
        with self.lock:
            folder = self.song_dir(song_id)
            if not (folder / SONG_FILE).exists():
                raise SongNotFound(song_id)
            # The song disappears from the list at once, even if Windows keeps a file locked;
            # a folder without song.json is cleaned up by recover() on the next start.
            _replace(folder / SONG_FILE, folder / ".deleted.json")
            _remove_tree(folder)

    def recover(self, analysis: bool = True, transcription: bool = False) -> list[tuple[str, str]]:
        """After a restart: removes half-built folders and returns the jobs to run, oldest song
        first: (id, model) for unfinished separations; with `analysis`, (id, ANALYSIS) for
        analyses that were interrupted or are due (see `_analysis_due`); with `transcription`,
        (id, TRANSCRIBE) after them, for words that were being heard or are due."""
        unfinished: list[tuple[str, str, int, str]] = []
        with self.lock:
            for folder in list(self.root.iterdir()):
                if not folder.is_dir():
                    continue
                if folder.name.startswith(".tmp-"):
                    _remove_tree(folder)
                    continue
                if not SONG_ID_RE.match(folder.name):
                    continue  # not ours: never delete anything else in this folder
                if not (folder / SONG_FILE).exists():
                    _remove_tree(folder)
                    continue
                for leftover in (folder / "stems").glob(".tmp-*"):
                    _remove_tree(leftover)
                try:
                    song = self.get(folder.name)
                except (SongNotFound, ValueError):
                    continue
                changed = False
                for model, info in song["stems"].items():
                    if info.get("status") in UNFINISHED:
                        info["status"] = "queued"
                        changed = True
                        unfinished.append((song["addedAt"], song["id"], 0, model))
                info = song.get("analysis") or {}
                if analysis and info.get("status") in UNFINISHED and _attempts(info) >= MAX_ANALYSIS_ATTEMPTS:
                    song["analysis"] = {**info, "status": "error", "error": message("analysis.crashedTwice")}
                    changed = True
                elif analysis and _analysis_due(song):
                    song["analysis"] = {**(song.get("analysis") or {}), "status": "queued", "error": None}
                    changed = True
                    unfinished.append((song["addedAt"], song["id"], 1, ANALYSIS))
                info = song.get("transcript") or {}
                if transcription and info.get("status") in UNFINISHED and _attempts(info) >= MAX_ANALYSIS_ATTEMPTS:
                    song["transcript"] = {**info, "status": "error", "error": message("words.crashedTwice")}
                    changed = True
                elif transcription and _transcript_due(song):
                    song["transcript"] = {**(song.get("transcript") or {}), "status": "queued", "error": None}
                    changed = True
                    unfinished.append((song["addedAt"], song["id"], 2, TRANSCRIBE))
                if changed:
                    self._save(song)
        return [(song_id, job) for _, song_id, _, job in sorted(unfinished)]


def _attempts(info: dict) -> int:
    """How many times this analysis was started without finishing (cleared by a result)."""
    try:
        return int(info.get("attempts") or 0)
    except (TypeError, ValueError):
        return 0


def _analysis_due(song: dict) -> bool:
    """At start-up: an interrupted analysis; ready stems whose analysis is missing, failed, old or
    made from the mix; a song without stems or a separation on the way and never analysed (or
    analysed by an older version) gets one from the mix. Never a tab-song."""
    if is_tab_song(song):
        return False
    info = song.get("analysis")
    if info is not None and info.get("status") in UNFINISHED:
        return True
    if info is not None and info.get("status") == "error" and _attempts(info) >= MAX_ANALYSIS_ATTEMPTS:
        return False  # it was cut off twice: only the user's «заново» starts it again
    if has_ready_stems(song):
        return analysis_needed(song)
    if any(s.get("status") in UNFINISHED + ("ready",) for s in song["stems"].values()):
        return False  # the stems will bring their own analysis
    return info is None or (info.get("status") == "ready" and info.get("version", 0) < ANALYSIS_VERSION)


def _transcript_due(song: dict) -> bool:
    """At start-up: words that were being heard, or are due by `transcript_needed`; never after
    two cut-off attempts (only the user's «Черновик по вокалу» starts it again)."""
    if is_tab_song(song):
        return False
    info = song.get("transcript")
    if info is not None and info.get("status") in UNFINISHED:
        return has_ready_stems(song)
    if info is not None and info.get("status") == "error" and _attempts(info) >= MAX_ANALYSIS_ATTEMPTS:
        return False
    return transcript_needed(song)
