"""HTTP API of the song service (FastAPI). The browser reaches it through Vite's /api proxy.

Error messages (`detail`) are `{code, params}` (messages.py): the app owns the words. The names of
files to download are the only words (export.py and takes.py `FILE_WORDS`, by the request's `lang`).
"""

from __future__ import annotations

import copy
import json
import mimetypes
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Literal
from urllib.parse import urlsplit

from fastapi import FastAPI, File, Form, HTTPException, Query, Request, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from .analysis import Analyzer, default_analyzer
from .components import Components
from .audio import SAMPLE_RATE, AudioError, read_audio, read_mix_wav
from .config import Settings, roformer_installed
from .export import ExportRequest, content_disposition, encode_mp3, export_file_name, render_backing
from .jobs import JobQueue, NoStems
from .library import (
    ANALYSIS,
    MAX_TAB_BYTES,
    STEMS,
    TRANSCRIBE,
    Library,
    NoTab,
    SongNotFound,
    TabSongTab,
    has_ready_stems,
    is_tab_song,
)
from .lyrics import Transcriber, default_transcriber
from .messages import UserError, message
from .models import ANALYSIS_WEIGHTS, MODELS, ml_installed, weight_ready, weights_ready, whisper_ready
from .separation import Separator, default_separator
from .takes import MAX_CHUNK_BYTES, MAX_OFFSET_MS, TakeError, TakeNotFound, Takes, download_name
from .userdata import ASSET_ID_RE, KINDS, MAX_ASSET_BYTES, MAX_SETTINGS_BYTES, AssetNotFound, UserData

# The built page's files (the installed app). Windows takes MIME types from the registry, where .js
# is sometimes text/plain: a module script with that type is refused, so the page would stay blank.
for _ext, _type in {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".html": "text/html",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".otf": "font/otf",
    ".ico": "image/x-icon",
    ".wav": "audio/wav",
    ".nam": "application/octet-stream",
    ".sf2": "application/octet-stream",
    ".sf3": "application/octet-stream",
}.items():
    mimetypes.add_type(_type, _ext)

StemName = Literal["vocals", "drums", "bass", "guitar", "piano", "other"]
ModelName = Literal["htdemucs_6s", "bs_roformer_sw"]
# The language of the words in a downloaded file's name (the app's own setting).
FileLang = Literal["en", "ru"]
MAX_LYRICS_CHARS = 50_000
TAB_MEDIA_TYPES = {"musicxml": "application/xml", "xml": "application/xml", "alphatex": "text/plain; charset=utf-8"}
# BTC's chord labels: N, X, a root with sharps (major), or root:quality
CHORD_LABEL = r"^(N|X|[A-G]#?(:(min|maj|dim|aug|min6|maj6|min7|minmaj7|maj7|7|dim7|hdim7|sus2|sus4))?)$"
MAX_CHORDS = 3000


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class KeyIn(Strict):
    """A key as analysis.json has it (a tab-song's, found by the app)."""

    tonic: int = Field(ge=0, le=11)
    mode: Literal["major", "minor"]
    confidence: float = Field(ge=0, le=1)


class LoopIn(Strict):
    start: float = Field(ge=0)
    end: float = Field(ge=0)
    on: bool


class BookmarkIn(Strict):
    name: str = Field(max_length=100)
    start: float = Field(ge=0)
    end: float = Field(ge=0)


class PlayerPatch(Strict):
    # Fields that may not be null have plain types; their defaults are never used (exclude_unset).
    speed: float = Field(1.0, ge=0.5, le=1.0)
    semitones: int = Field(0, ge=-2, le=2)
    cents: float = Field(0, ge=-50, le=50)
    volumesDb: dict[StemName, Annotated[float, Field(ge=-60, le=12)]] = {}
    muted: list[StemName] = Field([], max_length=len(STEMS))
    solo: StemName | None = None
    loop: LoopIn = LoopIn(start=0, end=0, on=False)
    bookmarks: list[BookmarkIn] = Field([], max_length=100)
    presetId: str | None = Field(None, max_length=64)
    # stage 2
    capo: int = Field(0, ge=0, le=9)
    tuning: Literal["standard", "eb", "dropd"] = "standard"
    simpleChords: bool = False
    mode: Literal["play", "ear"] = "play"
    reveal: int = Field(0, ge=0, le=3)
    countIn: bool = False
    click: bool = False
    toneMatch: bool = True
    tuningApplied: bool = False
    # stage 3
    view: Literal["chords", "lyrics", "tab", "notes"] = "chords"


class ChordIn(Strict):
    start: float = Field(ge=0)
    end: float = Field(ge=0)
    chord: str = Field(pattern=CHORD_LABEL)


class AnchorIn(Strict):
    line: int = Field(ge=0, le=10_000)
    time: float = Field(ge=0)


class LyricsIn(Strict):
    """The user's lyrics as pasted or imported; their timing is worked out by the app."""

    source: Literal["paste", "file", "lrclib", "draft"]
    text: str = Field(max_length=MAX_LYRICS_CHARS)
    anchors: list[AnchorIn] = Field([], max_length=500)
    shift: int | None = Field(None, ge=-11, le=11)


class NoteIn(Strict):
    start: float = Field(ge=0)
    end: float = Field(ge=0)
    midi: int = Field(ge=28, le=100)


class TabPatch(Strict):
    track: int = Field(0, ge=0, le=63)
    notation: bool = False
    offset: int | None = Field(None, ge=-64, le=512)
    ratio: Literal[0.5, 1, 2] | None = None


class ExportIn(Strict):
    model: ModelName
    gains: dict[StemName, Annotated[float, Field(ge=0, le=4)]] = {}
    speed: float = Field(1.0, ge=0.5, le=1.0)
    semitones: float = Field(0.0, ge=-2.5, le=2.5)
    start: float = Field(0.0, ge=0)
    end: float | None = Field(None, ge=0)
    lang: FileLang = "en"  # of the words in the file's name


class SongPatch(Strict):
    title: str = Field("", max_length=200)
    artist: str = Field("", max_length=200)
    notes: str = Field("", max_length=10_000)
    activeModel: ModelName | None = None
    player: PlayerPatch | None = None
    # The user's corrected chords (null: the analysis' own) and the bar lines moved by beats.
    chords: list[ChordIn] | None = Field(None, max_length=MAX_CHORDS)
    barShift: int = Field(0, ge=-12, le=12)
    # stage 3: the user's lyrics (null: none) and the tab's part and bar sync (the file itself: PUT /tab)
    lyrics: LyricsIn | None = None
    tab: TabPatch = TabPatch()
    # stage 4: the user's edited notes of the guitar (null: the analysis' own) and the song's lists
    # (`notes` above is the text of the song card)
    guitarNotes: list[NoteIn] | None = Field(None, max_length=5000)
    lists: list[Literal["favorite", "learn"]] = Field([], max_length=2)


class TakeIn(Strict):
    songId: str | None = Field(None, pattern=r"^[0-9a-f]{12}$")
    title: str = Field("", max_length=200)
    artist: str = Field("", max_length=200)
    path: Literal["native", "browser"]
    lang: FileLang = "en"  # of the title a take without a song gets


class TakePatch(Strict):
    guitarOffsetMs: int = Field(ge=-MAX_OFFSET_MS, le=MAX_OFFSET_MS)


LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


def _hostname(netloc: str) -> str:
    """'localhost:5173' → 'localhost', '[::1]:5174' → '::1'."""
    netloc = netloc.strip().lower()
    if netloc.startswith("["):
        return netloc[1 : netloc.find("]")] if "]" in netloc else netloc
    return netloc.rsplit(":", 1)[0]


def _error(status: int, code: str, **params) -> HTTPException:
    """An HTTP error whose `detail` is a message: the app shows it in the user's language."""
    return HTTPException(status_code=status, detail=message(code, **params))


def create_app(
    settings: Settings,
    separator: Separator | None = None,
    analyzer: Analyzer | None = None,
    transcriber: Transcriber | None = None,
) -> FastAPI:
    """The app. Tests pass a fake `separator`, `analyzer` and `transcriber`; the real ones find the
    GPU and load their models lazily (the analyzer and the transcriber only when a job runs)."""
    library = Library(settings.library_dir)
    separator = separator or default_separator(settings.models_dir)
    analyzer = analyzer or default_analyzer(settings.models_dir)
    transcriber = transcriber or default_transcriber(settings.models_dir)
    components = Components(settings)
    jobs = JobQueue(library, separator, analyzer, transcriber, ready=components.ready)
    takes = Takes(settings.library_dir)
    userdata = UserData(settings.user_root)
    own_origins = {f"http://127.0.0.1:{settings.port}", f"http://localhost:{settings.port}"}

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        jobs.start()  # also resumes jobs a restart interrupted and analyses songs that need it
        # Takes a closed tab left unfinished are saved in the background.
        threading.Thread(target=takes.recover, name="kv-takes-recover", daemon=True).start()
        yield
        jobs.stop()

    app = FastAPI(title="Strum: songs", lifespan=lifespan)
    app.state.library = library
    app.state.jobs = jobs
    app.state.takes = takes
    app.state.components = components

    @app.middleware("http")
    async def only_this_laptop(request: Request, call_next):
        """Refuses other web sites open in the same browser.

        A form post from a foreign page is a "simple request" that CORS does not stop, and DNS
        rebinding reaches 127.0.0.1 under a foreign host name. The app (through Vite's proxy),
        compare.py and curl all use localhost names.
        """
        origin = request.headers.get("origin")
        foreign_origin = origin is not None and _hostname(urlsplit(origin).netloc) not in LOCAL_HOSTS
        # The installed app: only its own page (another local program's page on another port is
        # foreign too). In the author's copy the page comes through Vite's proxy, on its own port.
        if settings.web_dir is not None and origin is not None:
            foreign_origin = origin not in own_origins
        if _hostname(request.headers.get("host", "")) not in LOCAL_HOSTS or foreign_origin:
            return JSONResponse(status_code=403, content={"detail": message("origin.forbidden")})
        return await call_next(request)

    def view(song: dict) -> dict:
        """song.json plus the live progress of running separations, analyses and transcriptions."""
        song = copy.deepcopy(song)
        for model, info in song["stems"].items():
            if info.get("status") == "running":
                info["progress"] = jobs.progress(song["id"], model) or 0.0
        analysis = song.get("analysis")
        if analysis and analysis.get("status") == "running":
            analysis["progress"] = jobs.progress(song["id"], ANALYSIS) or 0.0
        transcript = song.get("transcript")
        if transcript and transcript.get("status") == "running":
            transcript["progress"] = jobs.progress(song["id"], TRANSCRIBE) or 0.0
        return song

    @app.exception_handler(SongNotFound)
    async def song_not_found(_request: Request, _error: SongNotFound) -> JSONResponse:
        return JSONResponse(status_code=404, content={"detail": message("song.notFound")})

    @app.exception_handler(TakeNotFound)
    async def take_not_found(_request: Request, _error: TakeNotFound) -> JSONResponse:
        return JSONResponse(status_code=404, content={"detail": message("take.none")})

    @app.get("/api/health")
    def health() -> dict:
        return {
            "ok": True,
            "mlInstalled": ml_installed(),
            # BS-RoFormer only where its package is (the author's copy).
            "models": [
                {"id": m.id, "name": m.name, "ready": weights_ready(m.id, settings.models_dir)}
                for m in MODELS.values()
                if not m.slug or roformer_installed()
            ],
            "defaultModel": settings.default_model,
            "maxSeconds": settings.max_seconds,
            "device": separator.device,
            "gpuName": separator.gpu_name,
            "analysisModels": [
                {"id": w.id, "name": w.name, "ready": weight_ready(w.id, settings.models_dir)}
                for w in ANALYSIS_WEIGHTS.values()
            ],
            "lyricsModel": {"id": "whisper", "name": "Whisper large-v3", "ready": whisper_ready(settings.models_dir)},
            "components": components.status(),
        }

    @app.post("/api/components/{part}", status_code=202)
    def install_component(part: Literal["songs", "words"]) -> dict:
        """Downloads the neural networks for songs, or Whisper (installed app only)."""
        components.start(part)
        return components.status()

    @app.get("/api/songs")
    def list_songs() -> list[dict]:
        return [view(song) for song in library.list()]

    @app.post("/api/songs", status_code=201)
    async def add_song(
        response: Response,
        original: Annotated[UploadFile, File()],
        mix: Annotated[UploadFile, File()],
        fileName: Annotated[str, Form(max_length=300)],
    ) -> dict:
        mix_bytes = await mix.read()
        try:
            samples = await run_in_threadpool(read_mix_wav, mix_bytes)
        except AudioError as error:
            raise HTTPException(status_code=400, detail=error.message) from error
        del mix_bytes
        if len(samples) / SAMPLE_RATE > settings.max_seconds:
            raise _error(413, "song.tooLong", limit=settings.max_seconds)
        original_bytes = await original.read()
        song, created = await run_in_threadpool(library.create, original_bytes, fileName, samples)
        if created:
            song = jobs.submit(song["id"], settings.default_model)
        else:
            response.status_code = 200
        return {"song": view(song), "created": created}

    @app.post("/api/songs/tab", status_code=201)
    async def add_tab_song(
        response: Response,
        tab: Annotated[UploadFile, File()],
        fileName: Annotated[str, Form(min_length=1, max_length=300)],
        duration: Annotated[float, Form(gt=0)],
        title: Annotated[str, Form(max_length=300)] = "",
        artist: Annotated[str, Form(max_length=300)] = "",
        loudnessDb: Annotated[float, Form(ge=-120, le=20)] = -20.0,
        tempo: Annotated[float, Form(ge=0, le=1000)] = 0.0,
        meter: Annotated[int, Form(ge=1, le=32)] = 4,
        track: Annotated[int, Form(ge=0, le=1000)] = 0,
        capo: Annotated[int, Form(ge=0, le=24)] = 0,
        key: Annotated[str, Form(max_length=200)] = "",
    ) -> dict:
        """A tab-song: the tab file is the whole song, the app plays it with its synthesizer."""
        try:
            song_key = KeyIn.model_validate_json(key).model_dump() if key else None
        except ValueError as error:
            raise _error(422, "tab.keyUnreadable") from error
        data = await tab.read()
        if len(data) > MAX_TAB_BYTES:
            raise _error(413, "tab.tooBig", limit=MAX_TAB_BYTES // 2**20)
        if not data:
            raise _error(422, "tab.empty")
        if duration > settings.max_seconds:
            raise _error(413, "tab.tooLong", limit=settings.max_seconds)
        meta = {
            "title": title,
            "artist": artist,
            "duration": duration,
            "loudnessDb": loudnessDb,
            "tempo": tempo,
            "meter": meter,
            "track": track,
            "capo": capo,
            "key": song_key,
        }
        try:
            song, created = await run_in_threadpool(library.create_tab_song, data, fileName, meta)
        except UserError as error:
            raise HTTPException(status_code=415, detail=error.message) from error
        if not created:
            response.status_code = 200
        return {"song": view(song), "created": created}

    @app.get("/api/songs/{song_id}")
    def get_song(song_id: str) -> dict:
        return view(library.get(song_id))

    @app.patch("/api/songs/{song_id}")
    def patch_song(song_id: str, patch: SongPatch) -> dict:
        try:
            changes = patch.model_dump(exclude_unset=True)
            song = library.update(song_id, changes)
            # Lyrics on a song whose words were never heard: their timing needs the words, so this is
            # the request for them (words are heard only on request since 2026-11-17).
            if changes.get("lyrics") and song.get("transcript") is None and has_ready_stems(song) and not is_tab_song(song):
                song = jobs.submit_transcription(song_id)
            return view(song)
        except NoTab as error:
            raise HTTPException(status_code=409, detail=error.message) from error
        except UserError as error:
            raise HTTPException(status_code=422, detail=error.message) from error

    @app.delete("/api/songs/{song_id}", status_code=204)
    def delete_song(song_id: str) -> Response:
        jobs.cancel(song_id)
        library.delete(song_id)
        return Response(status_code=204)

    @app.post("/api/songs/{song_id}/separate", status_code=202)
    def separate(song_id: str, model: Annotated[ModelName, Query()]) -> dict:
        if is_tab_song(library.get(song_id)):
            raise _error(409, "tabSong.nothingToSeparate")
        return view(jobs.submit(song_id, model))

    @app.delete("/api/songs/{song_id}/stems/{model}")
    def drop_stems(song_id: str, model: ModelName) -> dict:
        jobs.cancel(song_id, model)
        return view(library.drop_stems(song_id, model))

    @app.get("/api/songs/{song_id}/analysis")
    def song_analysis(song_id: str) -> dict:
        """analysis.json. The app adds ?v=<finishedAt> so a new analysis is never a cached one."""
        try:
            return library.read_analysis(song_id)
        except FileNotFoundError as error:
            raise _error(404, "analysis.none") from error

    @app.post("/api/songs/{song_id}/analyze", status_code=202)
    def analyze(song_id: str) -> dict:
        """Finds bars and chords again. The user's chords and bar shift in song.json stay."""
        if is_tab_song(library.get(song_id)):
            raise _error(409, "tabSong.nothingToSeparate")
        return view(jobs.submit_analysis(song_id))

    @app.get("/api/songs/{song_id}/words")
    def song_words(song_id: str) -> dict:
        """words.json. The app adds ?v=<finishedAt> so new words are never cached old ones."""
        try:
            return library.read_words(song_id)
        except FileNotFoundError as error:
            raise _error(404, "words.none") from error

    @app.post("/api/songs/{song_id}/transcribe", status_code=202)
    def transcribe(song_id: str) -> dict:
        """Hears the words of the vocals again. The user's lyrics in song.json stay."""
        try:
            return view(jobs.submit_transcription(song_id))
        except NoStems as error:
            raise HTTPException(status_code=409, detail=error.message) from error

    @app.put("/api/songs/{song_id}/tab")
    async def put_tab(song_id: str, request: Request, name: Annotated[str, Query(max_length=300)]) -> dict:
        """The song's tab file as the request body (Guitar Pro, MusicXML or alphaTex)."""
        library.get(song_id)
        data = await request.body()
        if len(data) > MAX_TAB_BYTES:
            raise _error(413, "tab.tooBig", limit=MAX_TAB_BYTES // 2**20)
        if not data:
            raise _error(422, "tab.empty")
        try:
            song = await run_in_threadpool(library.write_tab, song_id, data, name)
        except TabSongTab as error:
            raise HTTPException(status_code=409, detail=error.message) from error
        except UserError as error:
            raise HTTPException(status_code=415, detail=error.message) from error
        return view(song)

    @app.get("/api/songs/{song_id}/tab")
    def get_tab(song_id: str) -> Response:
        try:
            data, ext = library.read_tab(song_id)
        except FileNotFoundError as error:
            raise _error(404, "tab.none") from error
        return Response(content=data, media_type=TAB_MEDIA_TYPES.get(ext, "application/octet-stream"))

    @app.delete("/api/songs/{song_id}/tab")
    def delete_tab(song_id: str) -> dict:
        try:
            return view(library.drop_tab(song_id))
        except TabSongTab as error:
            raise HTTPException(status_code=409, detail=error.message) from error

    @app.post("/api/songs/{song_id}/export")
    def export(song_id: str, body: ExportIn) -> Response:
        """The backing track as mp3. Sync, so the stretching runs in the thread pool."""
        with library.lock:
            song = library.get(song_id)
            if is_tab_song(song):
                raise _error(409, "tabSong.noExport")
            if song["stems"].get(body.model, {}).get("status") != "ready":
                raise _error(409, "export.stemsNotReady")
            stems = {stem: read_audio(library.stem_path(song_id, body.model, stem))[0] for stem in STEMS}
        if body.end is not None and body.end - body.start < 0.5:
            raise _error(422, "export.tooShort")
        request = ExportRequest(**body.model_dump(exclude={"lang"}))
        data = encode_mp3(render_backing(stems, SAMPLE_RATE, request), SAMPLE_RATE)
        return Response(
            content=data,
            media_type="audio/mpeg",
            headers={"Content-Disposition": content_disposition(export_file_name(song, request, body.lang))},
        )

    @app.get("/api/songs/{song_id}/peaks")
    def song_peaks(song_id: str) -> Response:
        if is_tab_song(library.get(song_id)):
            raise _error(404, "tabSong.noAudio")
        return Response(
            content=library.peaks_path(song_id).read_bytes(),
            media_type="application/octet-stream",
            headers={"X-Peaks-Per-Second": "100"},
        )

    @app.get("/api/songs/{song_id}/mix.flac")
    def song_mix(song_id: str) -> FileResponse:
        if is_tab_song(library.get(song_id)):
            raise _error(404, "tabSong.noAudio")
        return FileResponse(library.mix_path(song_id), media_type="audio/flac")

    @app.get("/api/songs/{song_id}/stems/{model}/{stem}.flac")
    def song_stem(song_id: str, model: str, stem: str) -> FileResponse:
        song = library.get(song_id)
        if model not in MODELS or stem not in STEMS or song["stems"].get(model, {}).get("status") != "ready":
            raise _error(404, "stems.missing")
        return FileResponse(library.stem_path(song_id, model, stem), media_type="audio/flac")

    # --- takes («Запись») -------------------------------------------------------------------------

    @app.get("/api/takes")
    def list_takes() -> list[dict]:
        return takes.list()

    @app.post("/api/takes", status_code=201)
    def create_take(body: TakeIn) -> dict:
        return takes.create(title=body.title, artist=body.artist, song_id=body.songId, path=body.path, lang=body.lang)

    @app.post("/api/takes/{take_id}/chunk", status_code=204)
    async def take_chunk(
        take_id: str,
        request: Request,
        track: Literal["guitar", "band", "dry"],
        at: Annotated[int, Query(ge=0)],
        rate: Annotated[int, Query(ge=8000, le=192_000)],
        perf: Annotated[float, Query(allow_inf_nan=False)],
    ) -> Response:
        if int(request.headers.get("content-length") or 0) > MAX_CHUNK_BYTES:
            raise _error(413, "take.chunkTooBig")
        data = await request.body()
        if not data or len(data) % 4:
            raise _error(422, "take.chunkBroken")
        try:
            await run_in_threadpool(takes.append, take_id, track, at, rate, perf, data)
        except TakeError as error:
            raise HTTPException(status_code=409, detail=error.message) from error
        return Response(status_code=204)

    @app.post("/api/takes/{take_id}/finish")
    def finish_take(take_id: str) -> dict:
        """Sync: the band's alignment and the mp3 run in the thread pool."""
        try:
            return takes.finish(take_id)
        except TakeError as error:
            takes.delete(take_id)
            raise HTTPException(status_code=422, detail=error.message) from error

    @app.patch("/api/takes/{take_id}")
    def patch_take(take_id: str, body: TakePatch) -> dict:
        try:
            return takes.update(take_id, guitar_offset_ms=body.guitarOffsetMs)
        except TakeError as error:
            raise HTTPException(status_code=409, detail=error.message) from error

    @app.delete("/api/takes/{take_id}", status_code=204)
    def delete_take(take_id: str) -> Response:
        takes.delete(take_id)
        return Response(status_code=204)

    @app.get("/api/takes/{take_id}/take.mp3")
    def take_mp3(take_id: str, download: bool = False, lang: FileLang = "en") -> FileResponse:
        """The take's mp3; with `download`, under a name whose words are in `lang`."""
        path = takes.mp3_path(take_id)
        headers = {"Cache-Control": "no-store"}
        if download:
            name = download_name(takes.get(take_id), lang)
            headers["Content-Disposition"] = content_disposition(name, fallback="take.mp3")
        return FileResponse(path, media_type="audio/mpeg", headers=headers)

    # --- the user's own files (userdata.py) -----------------------------------------------------

    @app.get("/api/settings")
    def get_settings() -> Response:
        text = userdata.read_settings()
        if text is None:
            return JSONResponse(status_code=404, content={"detail": message("settings.none")})
        return Response(content=text, media_type="application/json", headers={"Cache-Control": "no-store"})

    @app.put("/api/settings", status_code=204)
    async def put_settings(request: Request) -> Response:
        body = await request.body()
        if len(body) > MAX_SETTINGS_BYTES:
            raise _error(413, "settings.tooBig")
        try:
            data = json.loads(body)
        except ValueError as bad:
            raise _error(422, "settings.bad") from bad
        if not isinstance(data, dict):
            raise _error(422, "settings.bad")
        await run_in_threadpool(userdata.write_settings, data)
        return Response(status_code=204)

    @app.get("/api/assets")
    def list_assets() -> list[dict]:
        return userdata.list_assets()

    @app.get("/api/assets/{asset_id}")
    def get_asset(asset_id: str) -> FileResponse:
        try:
            path, info = userdata.asset_path(asset_id)
        except AssetNotFound as missing:
            raise _error(404, "asset.none") from missing
        media = "application/json" if info["kind"] == "model" else "audio/wav"
        return FileResponse(path, media_type=media, headers={"Cache-Control": "no-store"})

    @app.put("/api/assets/{asset_id}", status_code=204)
    async def put_asset(
        asset_id: str,
        request: Request,
        name: Annotated[str, Query(max_length=200)],
        kind: Annotated[str, Query(pattern="^(model|ir)$")],
        addedAt: Annotated[float, Query(ge=0)] = 0,  # noqa: N803 - the app's field name
    ) -> Response:
        if not ASSET_ID_RE.match(asset_id) or kind not in KINDS:
            raise _error(422, "asset.bad")
        body = await request.body()
        if not body or len(body) > MAX_ASSET_BYTES:
            raise _error(413, "asset.tooBig")
        await run_in_threadpool(userdata.put_asset, asset_id, name, kind, addedAt, body)
        return Response(status_code=204)

    @app.delete("/api/assets/{asset_id}", status_code=204)
    def delete_asset(asset_id: str) -> Response:
        userdata.delete_asset(asset_id)
        return Response(status_code=204)

    @app.get("/api/runtime")
    def runtime() -> dict:
        """What the page needs to know about how it was started. `guitarPort` only when this service
        serves the page (the installed app): in the author's copy Vite proxies /guitar."""
        return {
            "shell": settings.shell,
            "guitarPort": settings.guitar_port if settings.web_dir is not None else None,
            # The Strum window checks it before it shows the page: a program that took the port
            # first would not know it.
            "instance": settings.instance,
        }

    # --- the built page (installed app only; in the author's copy Vite serves it) ----------------

    if settings.web_dir is not None:
        web_root = settings.web_dir.resolve()

        @app.get("/{path:path}", include_in_schema=False)
        def page(path: str) -> FileResponse:
            if path == "api" or path.startswith("api/"):
                raise _error(404, "song.notFound")
            target = (web_root / path).resolve()
            if path and target.is_file() and target.is_relative_to(web_root):
                # Vite's hashed bundles never change; everything else is checked on every load.
                immutable = path.startswith("assets/")
                cache = "public, max-age=31536000, immutable" if immutable else "no-cache"
                return FileResponse(target, headers={"Cache-Control": cache})
            # Unknown paths get the page, as Vite does (the loaders of tones check what they got).
            return FileResponse(web_root / "index.html", headers={"Cache-Control": "no-cache"})

    return app
