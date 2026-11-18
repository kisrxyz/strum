from conftest import fake_analyzer, fake_separator, fake_transcriber, local_client, upload_song
from kv_service.app import create_app


def make_client(settings):
    app = create_app(settings, separator=fake_separator(), analyzer=fake_analyzer(), transcriber=fake_transcriber())
    return local_client(app)


def test_tab_upload_roundtrip(settings):
    data = bytes(range(256)) * 4
    with make_client(settings) as client:
        song = upload_song(client)
        url = f"/api/songs/{song['id']}/tab"
        response = client.put(url, params={"name": "Kayen.gp5"}, content=data)
        assert response.status_code == 200
        tab = response.json()["tab"]
        assert tab["name"] == "Kayen.gp5"
        assert tab["ext"] == "gp5"
        assert tab["size"] == len(data)
        assert tab["track"] == 0
        assert tab["offset"] is None
        assert tab["ratio"] is None
        assert client.get(url).content == data
        assert client.put(url, params={"name": "song.mp3"}, content=data).status_code == 415
        patched = client.patch(f"/api/songs/{song['id']}", json={"tab": {"track": 2, "offset": 3, "ratio": 2}})
        assert patched.status_code == 200
        assert patched.json()["tab"] | {"addedAt": None} == tab | {"addedAt": None, "track": 2, "offset": 3, "ratio": 2}
        assert client.patch(f"/api/songs/{song['id']}", json={"tab": {"ratio": 3}}).status_code == 422
        # a new file replaces the old one, its sync starts afresh
        replaced = client.put(url, params={"name": "Kayen.musicxml"}, content=b"<score-partwise/>").json()["tab"]
        assert replaced["ext"] == "musicxml"
        assert replaced["offset"] is None
        assert not (settings.library_dir / song["id"] / "tab.gp5").exists()
        assert client.delete(url).json()["tab"] is None
        assert client.get(url).status_code == 404
        no_tab = client.patch(f"/api/songs/{song['id']}", json={"tab": {"track": 1}})
        assert no_tab.status_code == 409
        assert no_tab.json()["detail"] == {"code": "tab.none", "params": {}}


def test_tab_limits(settings):
    with make_client(settings) as client:
        song = upload_song(client)
        url = f"/api/songs/{song['id']}/tab"
        assert client.put(url, params={"name": "big.gp"}, content=b"x" * (10 * 2**20 + 1)).status_code == 413
        assert client.put(url, params={"name": "empty.gp"}, content=b"").status_code == 422
        assert client.put("/api/songs/0123456789ab/tab", params={"name": "a.gp"}, content=b"x").status_code == 404


def test_patch_lyrics_and_view(settings):
    with make_client(settings) as client:
        song = upload_song(client)
        url = f"/api/songs/{song['id']}"
        lyrics = {"source": "paste", "text": "Am\nслова", "anchors": [{"line": 0, "time": 1.5}], "shift": None}
        response = client.patch(url, json={"lyrics": lyrics, "player": {"view": "lyrics"}})
        assert response.status_code == 200
        assert response.json()["lyrics"] == lyrics
        assert response.json()["player"]["view"] == "lyrics"
        assert client.patch(url, json={"lyrics": {**lyrics, "text": "а" * 50_001}}).status_code == 422
        assert client.patch(url, json={"lyrics": {**lyrics, "source": "radio"}}).status_code == 422
        assert client.patch(url, json={"player": {"view": "solo"}}).status_code == 422
        assert client.patch(url, json={"player": {"view": "tab"}}).status_code == 200
        assert client.patch(url, json={"lyrics": None}).json()["lyrics"] is None
