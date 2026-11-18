"""Tab-songs: a tab file played by the app itself (song.json + tab.<ext>, nothing to separate)."""

from conftest import fake_analyzer, fake_separator, fake_transcriber, local_client, upload_song
from kv_service.app import create_app
from kv_service.library import Library, analysis_needed, transcript_needed

TAB = bytes(range(256)) * 8
META = {
    "fileName": "Кино — Группа крови.gp4",
    "title": "",
    "artist": "",
    "duration": "2.5",
    "loudnessDb": "-17.25",
    "tempo": "120",
    "meter": "4",
    "track": "2",
    "capo": "0",
    "key": '{"tonic": 1, "mode": "minor", "confidence": 0.8}',
}


def make_client(settings, log=None):
    app = create_app(
        settings,
        separator=fake_separator(log=log),
        analyzer=fake_analyzer(log=log),
        transcriber=fake_transcriber(log=log),
    )
    return local_client(app)


def add_tab_song(client, data: bytes = TAB, **meta):
    fields = {**META, **meta}
    return client.post("/api/songs/tab", files={"tab": (fields["fileName"], data)}, data=fields)


def test_tab_song_is_created_from_the_file(settings):
    with make_client(settings) as client:
        response = add_tab_song(client)
        assert response.status_code == 201
        body = response.json()
        assert body["created"] is True
        song = body["song"]
        assert song["kind"] == "tab"
        # An empty title and artist in the score: the file name says both.
        assert (song["title"], song["artist"]) == ("Группа крови", "Кино")
        assert song["duration"] == 2.5
        assert song["loudnessDb"] == -17.25
        assert song["stems"] == {} and song["activeModel"] is None
        assert song["analysis"] == {
            "status": "ready",
            "version": 0,
            "source": "tab",
            "tempo": 120.0,
            "meter": 4,
            "key": {"tonic": 1, "mode": "minor", "confidence": 0.8},
        }
        assert song["tab"] | {"addedAt": None} == {
            "name": "Кино — Группа крови.gp4",
            "ext": "gp4",
            "size": len(TAB),
            "addedAt": None,
            "track": 2,
            "notation": False,
            "offset": 0,
            "ratio": 1,
        }
        # Everything is heard at first, the tab is on screen.
        assert song["player"]["muted"] == [] and song["player"]["view"] == "tab"
        folder = settings.library_dir / song["id"]
        assert sorted(p.name for p in folder.iterdir()) == ["song.json", "tab.gp4"]
        assert client.get(f"/api/songs/{song['id']}/tab").content == TAB
        assert [s["id"] for s in client.get("/api/songs").json()] == [song["id"]]

        again = add_tab_song(client)
        assert again.status_code == 200
        assert again.json()["created"] is False
        assert again.json()["song"]["id"] == song["id"]


def test_title_and_artist_from_the_score_win(settings):
    with make_client(settings) as client:
        song = add_tab_song(client, title="Танцы", artist="ssshhhiiittt!", fileName="97184.gp").json()["song"]
        assert (song["title"], song["artist"]) == ("Танцы", "ssshhhiiittt!")
        # A title with the artist inside and no artist: the file name's split is better.
        other = add_tab_song(
            client, data=TAB + b"x", title="Свидание - Я и твой кот", artist="", fileName="Свидание — Я и твой кот.gp"
        ).json()["song"]
        assert (other["title"], other["artist"]) == ("Я и твой кот", "Свидание")
        # A file name without an artist keeps the score's title.
        third = add_tab_song(client, data=TAB + b"y", title="Небо", artist="", fileName="95105.gp5").json()["song"]
        assert (third["title"], third["artist"]) == ("Небо", "")


def test_tab_song_capo_and_limits(settings):
    with make_client(settings) as client:
        song = add_tab_song(client, capo="4").json()["song"]
        assert song["player"]["capo"] == 4
        assert add_tab_song(client, data=b"x" * (10 * 2**20 + 1)).status_code == 413
        assert add_tab_song(client, data=b"").status_code == 422
        assert add_tab_song(client, data=TAB + b"z", fileName="song.mp3").status_code == 415
        assert add_tab_song(client, data=TAB + b"z", duration="0").status_code == 422
        assert add_tab_song(client, data=TAB + b"z", duration=str(settings.max_seconds + 1)).status_code == 413
        assert add_tab_song(client, data=TAB + b"z", key='{"tonic": 12, "mode": "minor", "confidence": 1}').status_code == 422
        no_key = add_tab_song(client, data=TAB + b"k", key="")
        assert no_key.status_code == 201 and no_key.json()["song"]["analysis"]["key"] is None


def test_tab_song_has_nothing_to_separate_or_hear(settings):
    log = []
    with make_client(settings, log=log) as client:
        song = add_tab_song(client).json()["song"]
        url = f"/api/songs/{song['id']}"
        for path in ("/separate?model=bs_roformer_sw", "/analyze"):
            refused = client.post(url + path)
            assert refused.status_code == 409
            assert refused.json()["detail"] == {"code": "tabSong.nothingToSeparate", "params": {}}
        assert client.post(url + "/transcribe").status_code == 409
        assert client.put(url + "/tab", params={"name": "other.gp5"}, content=b"x").status_code == 409
        assert client.delete(url + "/tab").status_code == 409
        assert client.get(url + "/peaks").status_code == 404
        assert client.get(url + "/mix.flac").status_code == 404
        body = {"model": "bs_roformer_sw", "gains": dict.fromkeys(["vocals", "drums", "bass", "guitar", "piano", "other"], 1.0),
                "speed": 1.0, "semitones": 0, "start": 0, "end": None}
        export = client.post(url + "/export", json=body)
        assert export.status_code == 409
        assert export.json()["detail"] == {"code": "tabSong.noExport", "params": {}}
        # The part and the notation change like any tab's.
        patched = client.patch(url, json={"tab": {"track": 0, "notation": True}, "player": {"muted": ["guitar"]}})
        assert patched.status_code == 200
        assert patched.json()["tab"]["track"] == 0 and patched.json()["tab"]["notation"] is True
        assert patched.json()["player"]["muted"] == ["guitar"]
        assert not [entry for entry in log if entry[0] in ("separate", "beats", "chords", "transcribe")]
        assert client.delete(url).status_code == 204
        assert client.get(url).status_code == 404


def test_recover_and_jobs_leave_tab_songs_alone(settings):
    with make_client(settings) as client:
        song = add_tab_song(client).json()["song"]
        recorded = upload_song(client)
    library = Library(settings.library_dir)
    tab_song = library.get(song["id"])
    assert not analysis_needed(tab_song) and not transcript_needed(tab_song)
    jobs = library.recover(analysis=True, transcription=True)
    assert all(song_id != song["id"] for song_id, _ in jobs)
    assert library.get(song["id"])["analysis"]["status"] == "ready"
    # Recorded songs get their kind when read.
    assert library.get(recorded["id"])["kind"] == "recording"
