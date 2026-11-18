import pytest

from conftest import local_client, fake_separator, sine, tagged_flac, wav_bytes
from kv_service.app import create_app

NAME = "Валентин Стрыкало - Кайен.flac"


@pytest.fixture
def client(settings):
    with local_client(create_app(settings, separator=fake_separator())) as c:
        yield c


def upload(client, seconds: float = 2.0, original: bytes | None = None, mix: bytes | None = None, name: str = NAME):
    files = {
        "original": (name, original or tagged_flac("Кайен (Sefon.Pro)", "Валентин Стрыкало"), "audio/flac"),
        "mix": ("mix.wav", mix or wav_bytes(sine(seconds)), "audio/wav"),
    }
    return client.post("/api/songs", files=files, data={"fileName": name})


def test_upload_creates_a_song_from_the_tags(client):
    response = upload(client)
    assert response.status_code == 201
    body = response.json()
    assert body["created"] is True
    assert body["song"]["title"] == "Кайен"
    assert body["song"]["artist"] == "Валентин Стрыкало"
    assert body["song"]["duration"] == pytest.approx(2.0)


def test_same_upload_twice_returns_the_existing_song(client):
    first = upload(client).json()["song"]
    client.app.state.jobs.wait_idle(5)
    response = upload(client)
    assert response.status_code == 200
    assert response.json()["created"] is False
    assert response.json()["song"]["id"] == first["id"]
    assert response.json()["song"]["stems"]["htdemucs_6s"]["status"] == "ready"  # not queued again
    assert [s["id"] for s in client.get("/api/songs").json()] == [first["id"]]


def test_get_patch_and_validation(client):
    song_id = upload(client).json()["song"]["id"]
    assert client.get(f"/api/songs/{song_id}").json()["id"] == song_id
    response = client.patch(f"/api/songs/{song_id}", json={"player": {"speed": 0.8, "solo": "guitar"}})
    assert response.status_code == 200
    assert response.json()["player"]["speed"] == 0.8
    assert response.json()["player"]["solo"] == "guitar"
    assert client.patch(f"/api/songs/{song_id}", json={"player": {"solo": None}}).json()["player"]["solo"] is None
    assert client.patch(f"/api/songs/{song_id}", json={"player": {"speed": 2}}).status_code == 422
    assert client.patch(f"/api/songs/{song_id}", json={"player": {"speed": None}}).status_code == 422
    assert client.patch(f"/api/songs/{song_id}", json={"player": {"muted": ["kazoo"]}}).status_code == 422
    assert client.patch(f"/api/songs/{song_id}", json={"colour": "red"}).status_code == 422
    # the default model is queued on upload; the other one was never asked for
    assert client.patch(f"/api/songs/{song_id}", json={"activeModel": "bs_roformer_sw"}).status_code == 422


def test_peaks_and_mix_files(client):
    song_id = upload(client, seconds=2.0).json()["song"]["id"]
    peaks = client.get(f"/api/songs/{song_id}/peaks")
    assert peaks.status_code == 200
    assert peaks.headers["x-peaks-per-second"] == "100"
    assert len(peaks.content) == 2 * 100 * 2
    mix = client.get(f"/api/songs/{song_id}/mix.flac")
    assert mix.status_code == 200
    assert mix.headers["content-type"] == "audio/flac"
    assert mix.content[:4] == b"fLaC"


def test_stems_that_do_not_exist_are_404(client):
    song_id = upload(client).json()["song"]["id"]
    assert client.get(f"/api/songs/{song_id}/stems/htdemucs_6s/guitar.flac").status_code == 404
    assert client.get(f"/api/songs/{song_id}/stems/nope/guitar.flac").status_code == 404
    assert client.get(f"/api/songs/{song_id}/stems/htdemucs_6s/kazoo.flac").status_code == 404


def test_too_long_song_is_refused(client):
    response = upload(client, seconds=4.0)
    assert response.status_code == 413
    assert response.json()["detail"] == {"code": "song.tooLong", "params": {"limit": 3}}


def test_wrong_wav_is_refused_with_a_message(client):
    response = upload(client, mix=wav_bytes(sine(1.0, sr=48000), sr=48000))
    assert response.status_code == 400
    assert response.json()["detail"] == {"code": "audio.wrongRate", "params": {"rate": 48000, "want": 44100}}


def test_delete(client):
    song_id = upload(client).json()["song"]["id"]
    assert client.delete(f"/api/songs/{song_id}").status_code == 204
    response = client.get(f"/api/songs/{song_id}")
    assert response.status_code == 404
    assert response.json()["detail"] == {"code": "song.notFound", "params": {}}
    assert client.get("/api/songs").json() == []


def test_bad_song_id_is_404(client):
    assert client.get("/api/songs/zzz").status_code == 404
