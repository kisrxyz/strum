import json
import threading

import pytest

from conftest import (
    STAGE_2_PLAYER,
    analysis_of,
    as_stage_1,
    fake_analyzer,
    fake_separator,
    local_client,
    sine,
    song_of,
    upload_song,
    wait_for,
)
from kv_service.analysis import ANALYSIS_VERSION, AnalysisError
from kv_service.app import create_app
from kv_service.library import Library


@pytest.fixture
def log():
    return []


@pytest.fixture
def client(settings, log):
    app = create_app(settings, separator=fake_separator(log=log), analyzer=fake_analyzer(log=log))
    with local_client(app) as c:
        yield c


def analysed(client, song_id: str, after: str | None = None) -> dict:
    """The song once its analysis is ready (and newer than `after`)."""
    return wait_for(
        lambda: (song := song_of(client, song_id))["analysis"]
        and song["analysis"]["status"] == "ready"
        and song["analysis"]["finishedAt"] != after
        and song
    )


def test_analysis_after_separation(client, log):
    song = upload_song(client)
    assert song["analysis"] is None
    info = analysed(client, song["id"])["analysis"]
    assert info["source"] == "htdemucs_6s"
    assert info["version"] == ANALYSIS_VERSION
    assert info["device"] == "cuda"
    assert info["error"] is None
    assert info["seconds"] >= 0
    assert "progress" not in info
    response = client.get(f"/api/songs/{song['id']}/analysis", params={"v": info["finishedAt"]})
    assert response.status_code == 200
    data = response.json()
    assert data["version"] == ANALYSIS_VERSION
    assert data["source"] == "htdemucs_6s"
    assert data["tempo"] == pytest.approx(120.0, abs=0.5)
    # the library list shows the key and tempo without loading analysis.json
    assert info["tempo"] == data["tempo"]
    assert info["meter"] == data["meter"] == 4
    assert info["key"] == data["key"]
    # the separator left the video memory before the analysis came in
    assert log.index(("unload", "htdemucs_6s")) < log.index(("load", "beats", "cuda"))


def test_analysis_is_404_until_it_exists(settings):
    gate = threading.Event()
    app = create_app(settings, separator=fake_separator(gate=gate), analyzer=fake_analyzer())
    with local_client(app) as client:
        song = upload_song(client)
        response = client.get(f"/api/songs/{song['id']}/analysis")
        assert response.status_code == 404
        assert response.json()["detail"] == {"code": "analysis.none", "params": {}}
        gate.set()
        assert client.app.state.jobs.wait_idle(5)
        assert client.get(f"/api/songs/{song['id']}/analysis").status_code == 200
        assert client.get("/api/songs/0123456789ab/analysis").json()["detail"]["code"] == "song.notFound"
        assert client.post("/api/songs/0123456789ab/analyze").status_code == 404
        assert client.get("/api/songs/zzz/analysis").status_code == 404


def test_a_running_analysis_shows_its_progress(settings):
    gate = threading.Event()
    app = create_app(settings, separator=fake_separator(), analyzer=fake_analyzer(gate=gate))
    with local_client(app) as client:
        song = upload_song(client)
        info = wait_for(lambda: (info := analysis_of(client, song["id"])) and info["status"] == "running" and info)
        assert 0 <= info["progress"] < 1
        listed = client.get("/api/songs").json()[0]["analysis"]
        assert listed["status"] == "running" and "progress" in listed
        gate.set()
        assert client.app.state.jobs.wait_idle(5)


def test_failed_analysis_is_reported(settings):
    failure = AnalysisError("program.filesMissing", model="beat_this")
    app = create_app(settings, separator=fake_separator(), analyzer=fake_analyzer(fails=[failure]))
    with local_client(app) as client:
        song = upload_song(client)
        info = wait_for(lambda: (info := analysis_of(client, song["id"])) and info["status"] == "error" and info)
        assert info["error"] == {"code": "program.filesMissing", "params": {"model": "beat_this"}}
        assert client.app.state.jobs.wait_idle(5)
        assert analysis_of(client, song["id"])["status"] == "error"  # not retried in a loop
        assert client.get(f"/api/songs/{song['id']}/mix.flac").status_code == 200
        assert client.get(f"/api/songs/{song['id']}/stems/htdemucs_6s/guitar.flac").status_code == 200
        assert client.get(f"/api/songs/{song['id']}/analysis").status_code == 404
        # the button tries again
        assert client.post(f"/api/songs/{song['id']}/analyze").status_code == 202
        assert analysed(client, song["id"])["analysis"]["error"] is None


def test_edits_survive_reanalysis(client):
    song = upload_song(client)
    first = analysed(client, song["id"])["analysis"]
    chords = [{"start": 0.0, "end": 1.5, "chord": "A:min"}, {"start": 1.5, "end": 3.0, "chord": "E:7"}]
    response = client.patch(f"/api/songs/{song['id']}", json={"chords": chords, "barShift": 1})
    assert response.status_code == 200
    response = client.post(f"/api/songs/{song['id']}/analyze")
    assert response.status_code == 202
    assert response.json()["analysis"]["status"] == "queued"
    again = analysed(client, song["id"], after=first["finishedAt"])
    assert again["chords"] == chords
    assert again["barShift"] == 1
    assert again["analysis"]["finishedAt"] != first["finishedAt"]


def test_patch_validation(client):
    url = f"/api/songs/{upload_song(client)['id']}"
    assert client.patch(url, json={"chords": [{"start": 0, "end": 1, "chord": "H"}]}).status_code == 422
    assert client.patch(url, json={"chords": [{"start": 0, "end": 1, "chord": "Bb"}]}).status_code == 422
    assert client.patch(url, json={"chords": [{"start": 0, "end": 1, "chord": "C:min9"}]}).status_code == 422
    assert client.patch(url, json={"chords": [{"start": -1, "end": 1, "chord": "C"}]}).status_code == 422
    assert client.patch(url, json={"chords": [{"start": 0, "end": 1, "chord": "C", "x": 1}]}).status_code == 422
    too_many = [{"start": i, "end": i + 1, "chord": "C"} for i in range(3001)]
    assert client.patch(url, json={"chords": too_many}).status_code == 422
    for bad in (13, -13, 0.5, None):
        assert client.patch(url, json={"barShift": bad}).status_code == 422
    for bad in ({"capo": 10}, {"capo": -1}, {"tuning": "dadgad"}, {"reveal": 4}, {"mode": "listen"},
                {"countIn": None}, {"toneMatch": "maybe"}):
        assert client.patch(url, json={"player": bad}).status_code == 422, bad

    player = {"capo": 9, "tuning": "dropd", "simpleChords": True, "mode": "ear", "reveal": 3, "countIn": True,
              "click": True, "toneMatch": False, "tuningApplied": True}
    body = client.patch(url, json={"player": player}).json()
    assert {key: body["player"][key] for key in player} == player
    assert body["player"]["speed"] == 1.0  # the rest of the player stays
    chords = [{"start": 0.0, "end": 1.5, "chord": "C#:hdim7"}, {"start": 1.5, "end": 3.0, "chord": "N"}]
    body = client.patch(url, json={"chords": chords, "barShift": -12}).json()
    assert body["chords"] == chords
    assert body["barShift"] == -12
    assert client.patch(url, json={"chords": None}).status_code == 200
    assert client.get(url).json()["chords"] is None


@pytest.mark.parametrize("label", ["N", "X", "C", "F#", "A:min", "G:7", "B:hdim7", "D#:minmaj7", "E:sus2", "A#:maj6"])
def test_every_kind_of_label_is_accepted(client, label):
    url = f"/api/songs/{upload_song(client)['id']}"
    assert client.patch(url, json={"chords": [{"start": 0, "end": 1, "chord": label}]}).status_code == 200


def test_health_lists_analysis_models(client):
    body = client.get("/api/health").json()
    assert [m["id"] for m in body["analysisModels"]] == ["beat_this", "btc"]
    assert [m["ready"] for m in body["analysisModels"]] == [False, False]
    assert all(m["name"] for m in body["analysisModels"])


def test_stage1_song_gets_defaults(settings):
    library = Library(settings.library_dir)
    song, _ = library.create(b"old song", "Кино - Кукушка.mp3", sine(3.0))
    as_stage_1(library.root, song["id"])
    song = library.get(song["id"])
    assert song["analysis"] is None
    assert song["chords"] is None
    assert song["barShift"] == 0
    assert {key: song["player"][key] for key in STAGE_2_PLAYER} == STAGE_2_PLAYER
    on_disk = json.loads((library.root / song["id"] / "song.json").read_text(encoding="utf-8"))
    assert "barShift" not in on_disk and "capo" not in on_disk["player"]  # reading does not write

    app = create_app(settings, separator=fake_separator(), analyzer=fake_analyzer())
    with local_client(app) as client:
        response = client.patch(f"/api/songs/{song['id']}", json={"player": {"capo": 2}})
        assert response.status_code == 200
        assert response.json()["player"]["capo"] == 2
        assert response.json()["player"]["toneMatch"] is True
        assert response.json()["player"]["speed"] == 1.0
        assert client.app.state.jobs.wait_idle(5)
        # a stage-1 song without stems gets its bars and chords from the whole mix
        assert analysis_of(client, song["id"])["source"] == "mix"
