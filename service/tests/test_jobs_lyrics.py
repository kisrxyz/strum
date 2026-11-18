import json
import threading

from conftest import (
    fake_analyzer,
    fake_separator,
    fake_transcriber,
    local_client,
    sine,
    song_of,
    tagged_flac,
    upload_song,
    wait_for,
)
from kv_service.analysis import ANALYSIS_VERSION
from kv_service.app import create_app
from kv_service.library import STEMS, Library
from kv_service.lyrics import TRANSCRIPT_VERSION, TranscribeError
from kv_service.separation import SeparationError


def make_app(settings, log=None, separator=None, transcriber=None):
    log = log if log is not None else []
    return create_app(
        settings,
        separator=separator or fake_separator(log=log),
        analyzer=fake_analyzer(log=log),
        transcriber=transcriber or fake_transcriber(log=log),
    )


def transcript_of(client, song_id: str) -> dict | None:
    return song_of(client, song_id)["transcript"]


def test_words_are_heard_only_when_asked(settings):
    # Whisper is 3 GB and slow without a graphics card: a new song does not get its words by itself.
    log = []
    with local_client(make_app(settings, log)) as client:
        song = upload_song(client)
        assert client.app.state.jobs.wait_idle(5)
        assert transcript_of(client, song["id"]) is None
        assert client.post(f"/api/songs/{song['id']}/transcribe").status_code == 202
        assert client.app.state.jobs.wait_idle(5)
        info = transcript_of(client, song["id"])
        assert info["status"] == "ready"
        assert info["source"] == "htdemucs_6s"
        assert info["language"] == "ru"
        assert info["version"] == TRANSCRIPT_VERSION
        words = client.get(f"/api/songs/{song['id']}/words")
        assert words.status_code == 200
        assert [w["word"] for w in words.json()["words"]] == ["раз", "два", "три"]
    kinds = [entry[0] for entry in log if entry[0] in ("separate", "beats", "transcribe")]
    assert kinds == ["separate", "beats", "transcribe"]  # the words come after the bars and chords
    # the fake heard the vocal stem (mix × 0.1), not the mix: RMS ≈ 0.035, not 0.35
    heard = [entry for entry in log if entry[0] == "transcribe"][0]
    assert heard[2] < 0.06


def test_no_transcript_without_stems(settings):
    log = []
    separator = fake_separator(log=log, fails=[SeparationError("program.filesMissing")])
    with local_client(make_app(settings, log, separator=separator)) as client:
        song = upload_song(client)
        assert client.app.state.jobs.wait_idle(5)
        assert transcript_of(client, song["id"]) is None
        assert song_of(client, song["id"])["analysis"]["status"] == "ready"  # from the mix
        response = client.post(f"/api/songs/{song['id']}/transcribe")
        assert response.status_code == 409
        assert response.json()["detail"] == {"code": "transcript.needsStems", "params": {}}
        assert client.get(f"/api/songs/{song['id']}/words").status_code == 404
    assert not [entry for entry in log if entry[0] == "transcribe"]


def test_transcript_backfill_on_start(settings):
    library = Library(settings.library_dir)
    song, _ = library.create(b"stage 2 song", "a.wav", sine(3.0))
    library.write_stems(song["id"], "bs_roformer_sw", {s: sine(3.0, amp=0.1) for s in STEMS}, {"device": "cuda"})
    data = {"version": ANALYSIS_VERSION, "source": "bs_roformer_sw", "beats": [], "downbeats": [], "tempo": 0.0, "meter": 4,
            "chords": [], "key": None, "tuningCents": 0.0, "sections": [], "tone": None, "notes": []}
    library.write_analysis(song["id"], data, {"device": "cuda", "seconds": 1})
    path = settings.library_dir / song["id"] / "song.json"
    stored = json.loads(path.read_text(encoding="utf-8"))
    for key in ("transcript", "lyrics", "tab"):
        stored.pop(key, None)
    path.write_text(json.dumps(stored, ensure_ascii=False), encoding="utf-8")
    log = []
    with local_client(make_app(settings, log)) as client:
        assert client.app.state.jobs.wait_idle(5)
        assert transcript_of(client, song["id"]) is None  # never asked for: nothing on start
    assert not [entry for entry in log if entry[0] == "transcribe"]
    # Words heard by an older version are heard again on start (the user asked for them once).
    stored = json.loads(path.read_text(encoding="utf-8"))
    stored["transcript"] = {"status": "ready", "version": 0, "source": "bs_roformer_sw"}
    path.write_text(json.dumps(stored, ensure_ascii=False), encoding="utf-8")
    log = []
    with local_client(make_app(settings, log)) as client:
        assert client.app.state.jobs.wait_idle(5)
        assert transcript_of(client, song["id"])["version"] == TRANSCRIPT_VERSION
    assert not [entry for entry in log if entry[0] in ("separate", "beats")]
    assert len([entry for entry in log if entry[0] == "transcribe"]) == 1


def test_failed_transcription_is_reported(settings):
    transcriber = fake_transcriber(fails=[TranscribeError("program.filesMissing", model="whisper")])
    with local_client(make_app(settings, transcriber=transcriber)) as client:
        song = upload_song(client)
        assert client.app.state.jobs.wait_idle(5)
        assert client.post(f"/api/songs/{song['id']}/transcribe").status_code == 202
        assert client.app.state.jobs.wait_idle(5)
        info = transcript_of(client, song["id"])
        assert info["status"] == "error"
        assert info["error"] == {"code": "program.filesMissing", "params": {"model": "whisper"}}
        assert client.get(f"/api/songs/{song['id']}/mix.flac").status_code == 200
        # «Черновик по вокалу» asks again: this time it works
        assert client.post(f"/api/songs/{song['id']}/transcribe").status_code == 202
        assert client.app.state.jobs.wait_idle(5)
        assert transcript_of(client, song["id"])["status"] == "ready"


def test_delete_during_transcription(settings):
    gate = threading.Event()
    with local_client(make_app(settings, transcriber=fake_transcriber(gate=gate))) as client:
        first = upload_song(client, tagged_flac("Первая", "А"))
        wait_for(lambda: (song_of(client, first["id"]).get("analysis") or {}).get("status") == "ready")
        assert client.post(f"/api/songs/{first['id']}/transcribe").status_code == 202
        wait_for(lambda: (info := transcript_of(client, first["id"])) and info["status"] == "running")
        assert client.delete(f"/api/songs/{first['id']}").status_code == 204
        gate.set()
        assert client.app.state.jobs.wait_idle(5)
        assert not (settings.library_dir / first["id"]).exists()
        assert client.get(f"/api/songs/{first['id']}/words").status_code == 404


def test_transcription_progress_is_shown(settings):
    gate = threading.Event()
    with local_client(make_app(settings, transcriber=fake_transcriber(gate=gate))) as client:
        song = upload_song(client)
        wait_for(lambda: (song_of(client, song["id"]).get("analysis") or {}).get("status") == "ready")
        assert client.post(f"/api/songs/{song['id']}/transcribe").status_code == 202
        info = wait_for(lambda: (i := transcript_of(client, song["id"])) and i["status"] == "running" and i)
        assert "progress" in info
        gate.set()
        assert client.app.state.jobs.wait_idle(5)


def test_stage2_song_gets_stage3_defaults(settings):
    with local_client(make_app(settings)) as client:
        song = upload_song(client)
        assert client.app.state.jobs.wait_idle(5)
    path = settings.library_dir / song["id"] / "song.json"
    stored = json.loads(path.read_text(encoding="utf-8"))
    for key in ("transcript", "lyrics", "tab"):
        stored.pop(key)
    stored["player"].pop("view")
    path.write_text(json.dumps(stored, ensure_ascii=False), encoding="utf-8")
    loaded = Library(settings.library_dir).get(song["id"])
    assert loaded["lyrics"] is None
    assert loaded["tab"] is None
    assert loaded["transcript"] is None
    assert loaded["player"]["view"] == "chords"


def test_health_lists_lyrics_model(settings):
    with local_client(make_app(settings)) as client:
        body = client.get("/api/health").json()
    assert body["lyricsModel"] == {"id": "whisper", "name": "Whisper large-v3", "ready": False}


def test_pasted_lyrics_ask_for_the_words(settings):
    # Lyrics put on a song whose words were never heard: their timing needs them, so they are heard now.
    log = []
    with local_client(make_app(settings, log)) as client:
        song = upload_song(client)
        assert client.app.state.jobs.wait_idle(5)
        assert transcript_of(client, song["id"]) is None
        lyrics = {"text": "раз два три", "source": "paste", "anchors": [], "shift": 0}
        assert client.patch(f"/api/songs/{song['id']}", json={"lyrics": lyrics}).status_code == 200
        assert client.app.state.jobs.wait_idle(5)
        assert transcript_of(client, song["id"])["status"] == "ready"
        # Lyrics changed again: no second hearing.
        lyrics["text"] = "раз два"
        assert client.patch(f"/api/songs/{song['id']}", json={"lyrics": lyrics}).status_code == 200
        assert client.app.state.jobs.wait_idle(5)
    assert len([entry for entry in log if entry[0] == "transcribe"]) == 1
