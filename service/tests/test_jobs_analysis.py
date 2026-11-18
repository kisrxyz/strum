import threading

import pytest

from conftest import (
    analysis_of,
    as_stage_1,
    fake_analyzer,
    fake_separator,
    local_client,
    sine,
    song_of,
    tagged_flac,
    upload_song,
    wait_for,
)
from kv_service.analysis import ANALYSIS_VERSION
from kv_service.app import create_app
from kv_service.jobs import JobQueue
from kv_service.library import ANALYSIS, STEMS, Library, SongNotFound
from kv_service.separation import SeparationError

ANALYSIS_LOG = ("beats", "chords", "pitch")


def run_queue(library: Library, separator, analyzer, submit=None) -> None:
    jobs = JobQueue(library, separator, analyzer)
    jobs.start()
    try:
        if submit:
            submit(jobs)
        assert jobs.wait_idle(5)
    finally:
        jobs.stop()


def add_song(library: Library, name: bytes, seconds: float = 3.0) -> str:
    song, _ = library.create(name, "a.wav", sine(seconds))
    return song["id"]


def ready_stems(library: Library, song_id: str, model: str = "bs_roformer_sw") -> None:
    library.write_stems(song_id, model, {s: sine(3.0, amp=0.1) for s in STEMS}, {"device": "cuda"})


def fake_data(source: str = "mix") -> dict:
    return {"version": ANALYSIS_VERSION, "source": source, "beats": [], "downbeats": [], "tempo": 0.0, "meter": 4,
            "chords": [], "key": None, "tuningCents": 0.0, "sections": [], "tone": None}


# ---- the library


def test_new_songs_have_the_stage_2_fields(tmp_path):
    library = Library(tmp_path / "library")
    song = library.get(add_song(library, b"new"))
    assert song["analysis"] is None
    assert song["chords"] is None
    assert song["barShift"] == 0
    expected = {"capo": 0, "tuning": "standard", "simpleChords": False, "mode": "play", "reveal": 0,
                "countIn": False, "click": False, "toneMatch": True, "tuningApplied": False}
    assert {key: song["player"][key] for key in expected} == expected
    assert song["player"]["speed"] == 1.0


def test_write_and_read_analysis(tmp_path):
    library = Library(tmp_path / "library")
    song_id = add_song(library, b"song")
    with pytest.raises(FileNotFoundError):
        library.read_analysis(song_id)
    data = {**fake_data("htdemucs_6s"), "tempo": 117.6, "meter": 3, "key": {"tonic": 9, "mode": "minor", "confidence": 0.7}}
    song = library.write_analysis(song_id, data, {"device": "cuda", "seconds": 4.2})
    info = song["analysis"]
    assert info["status"] == "ready"
    assert info["version"] == ANALYSIS_VERSION
    assert info["source"] == "htdemucs_6s"
    assert info["device"] == "cuda"
    assert info["seconds"] == 4.2
    assert info["error"] is None
    assert info["finishedAt"]
    assert (info["tempo"], info["meter"], info["key"]) == (117.6, 3, data["key"])
    assert library.read_analysis(song_id) == data
    assert not list((library.root / song_id).glob("*.tmp"))
    again = library.write_analysis(song_id, data, {"device": "cuda", "seconds": 4.2})["analysis"]
    assert again["finishedAt"] != info["finishedAt"]
    assert library.set_analysis(song_id, status="queued", error=None)["analysis"]["finishedAt"] == again["finishedAt"]


def test_a_deleted_song_gets_no_analysis(tmp_path):
    library = Library(tmp_path / "library")
    song_id = add_song(library, b"song")
    library.delete(song_id)
    with pytest.raises(SongNotFound):
        library.write_analysis(song_id, fake_data(), {"device": "cpu", "seconds": 1.0})
    assert not (library.root / song_id).exists()


def test_recover_requeues_analyses(tmp_path):
    library = Library(tmp_path / "library")
    songs = {name: add_song(library, name.encode()) for name in
             ("missing", "done", "error", "from-mix", "old", "running", "mix-only", "mix-failed", "separating")}
    for name in ("missing", "done", "error", "from-mix", "old", "running"):
        ready_stems(library, songs[name])
    library.write_analysis(songs["done"], fake_data("bs_roformer_sw"), {"device": "cuda", "seconds": 1.0})
    library.set_analysis(songs["error"], status="error", error="Не получилось")
    library.write_analysis(songs["from-mix"], fake_data("mix"), {"device": "cuda", "seconds": 1.0})
    library.write_analysis(songs["old"], {**fake_data("bs_roformer_sw"), "version": 0}, {"device": "cuda", "seconds": 1.0})
    library.set_analysis(songs["running"], status="running")
    library.set_analysis(songs["mix-failed"], status="error", error="Не получилось")
    library.set_stems(songs["separating"], "bs_roformer_sw", status="running")

    keys = library.recover()
    analysed = {name for name, song_id in songs.items() if (song_id, ANALYSIS) in keys}
    assert analysed == {"missing", "error", "from-mix", "old", "running", "mix-only"}
    assert (songs["separating"], "bs_roformer_sw") in keys
    assert len(keys) == len(analysed) + 1
    for name in analysed:
        assert library.get(songs[name])["analysis"]["status"] == "queued"
    assert library.get(songs["done"])["analysis"]["status"] == "ready"
    # without an analyzer only the separations come back, as in stage 1
    library.set_analysis(songs["missing"], status="running")
    assert library.recover(analysis=False) == [(songs["separating"], "bs_roformer_sw")]


# ---- the queue


def test_backfill_on_start(settings):
    library = Library(settings.library_dir)
    song_id = add_song(library, b"stage 1 song")
    ready_stems(library, song_id)
    as_stage_1(library.root, song_id)
    log = []
    with local_client(create_app(settings, separator=fake_separator(log=log), analyzer=fake_analyzer(log=log))) as client:
        assert client.app.state.jobs.wait_idle(5)
        info = analysis_of(client, song_id)
        assert info["status"] == "ready"
        assert info["source"] == "bs_roformer_sw"
        assert client.get(f"/api/songs/{song_id}/analysis").json()["version"] == ANALYSIS_VERSION
    assert not [entry for entry in log if entry[0] == "separate"]
    assert [entry for entry in log if entry[0] == "beats"] == [("beats", 3.0)]


def test_a_failed_separation_falls_back_to_the_mix(tmp_path):
    library = Library(tmp_path / "library")
    holder = {}

    def submit(jobs):
        holder["id"] = add_song(library, b"song")  # after start: recover() must not queue it
        jobs.submit(holder["id"], "htdemucs_6s")

    run_queue(library, fake_separator(fails=[SeparationError("program.filesMissing")]), fake_analyzer(), submit)
    song = library.get(holder["id"])
    assert song["stems"]["htdemucs_6s"]["status"] == "error"
    assert song["analysis"]["status"] == "ready"
    assert song["analysis"]["source"] == "mix"


def test_a_mix_analysis_is_redone_when_the_stems_arrive(tmp_path):
    library = Library(tmp_path / "library")
    song_id = add_song(library, b"song")
    library.write_analysis(song_id, fake_data("mix"), {"device": "cuda", "seconds": 1.0})
    log = []
    run_queue(library, fake_separator(), fake_analyzer(log=log), lambda jobs: jobs.submit(song_id, "htdemucs_6s"))
    assert library.get(song_id)["analysis"]["source"] == "htdemucs_6s"
    assert len([e for e in log if e[0] == "beats"]) == 1


def test_an_interrupted_analysis_is_finished_after_a_restart(tmp_path):
    library = Library(tmp_path / "library")
    song_id = add_song(library, b"song")
    ready_stems(library, song_id, "htdemucs_6s")
    library.set_analysis(song_id, status="running")
    run_queue(library, fake_separator(), fake_analyzer())
    assert library.get(song_id)["analysis"]["status"] == "ready"


def test_an_analysis_counts_its_attempts_and_a_success_clears_them(tmp_path):
    library = Library(tmp_path / "library")
    song_id = add_song(library, b"song")
    ready_stems(library, song_id, "htdemucs_6s")
    library.set_analysis(song_id, status="running", attempts=1)  # it was interrupted once
    run_queue(library, fake_separator(), fake_analyzer())
    info = library.get(song_id)["analysis"]
    assert info["status"] == "ready"
    assert "attempts" not in info


def test_an_analysis_that_was_cut_off_twice_is_not_tried_again(tmp_path):
    # Twice running when the service stopped: it probably crashes the service, so the next start
    # marks it as an error instead of crashing again.
    library = Library(tmp_path / "library")
    song_id = add_song(library, b"song")
    ready_stems(library, song_id, "htdemucs_6s")
    library.set_analysis(song_id, status="running", attempts=2)
    log = []
    run_queue(library, fake_separator(), fake_analyzer(log=log))
    info = library.get(song_id)["analysis"]
    assert info["status"] == "error"
    assert info["error"] == {"code": "analysis.crashedTwice", "params": {}}
    assert not [e for e in log if e[0] in ANALYSIS_LOG]


def test_a_caught_failure_is_not_counted_as_a_crash(tmp_path):
    # A missing model twice in a row must not stop the retries once it is installed.
    from kv_service.analysis import AnalysisError

    library = Library(tmp_path / "library")
    song_id = add_song(library, b"song")
    ready_stems(library, song_id, "htdemucs_6s")
    library.set_analysis(song_id, status="running", attempts=1)
    run_queue(library, fake_separator(), fake_analyzer(fails=[AnalysisError("program.filesMissing")]))
    info = library.get(song_id)["analysis"]
    assert info["status"] == "error"
    assert info["attempts"] == 0
    log = []
    run_queue(library, fake_separator(), fake_analyzer(log=log))  # the next start tries again
    assert library.get(song_id)["analysis"]["status"] == "ready"


def test_one_model_in_video_memory_at_a_time(settings):
    log = []
    with local_client(create_app(settings, separator=fake_separator(log=log), analyzer=fake_analyzer(log=log))) as client:
        upload_song(client, tagged_flac("Первая", "А"))
        upload_song(client, tagged_flac("Вторая", "Б"))
        assert client.app.state.jobs.wait_idle(15)
        # both analyses ran and the idle queue unloaded the last model (a separator's own unload
        # between jobs looks the same, so the beats are counted too)
        wait_for(lambda: len([e for e in log if e[0] == "beats"]) == 2 and log[-1][0] == "unload", timeout=15)
    loaded: set[str] = set()
    for entry in log:
        if entry[0] == "load":
            loaded.add(entry[1])
        elif entry[0] == "unload":
            loaded.discard(entry[1])
        elif entry[0] == "separate":
            assert not loaded & set(ANALYSIS_LOG)
        elif entry[0] in ANALYSIS_LOG:
            assert not loaded - set(ANALYSIS_LOG)
    assert len([e for e in log if e[0] == "beats"]) == 2
    assert not loaded  # idle: everything unloaded


def test_delete_during_analysis(settings):
    gate = threading.Event()
    app = create_app(settings, separator=fake_separator(), analyzer=fake_analyzer(gate=gate))
    with local_client(app) as client:
        first = upload_song(client, tagged_flac("Первая", "А"))
        second = upload_song(client, tagged_flac("Вторая", "Б"))
        wait_for(lambda: (info := analysis_of(client, first["id"])) and info["status"] == "running")
        assert client.delete(f"/api/songs/{first['id']}").status_code == 204
        gate.set()
        wait_for(lambda: (info := analysis_of(client, second["id"])) and info["status"] == "ready")
        assert client.app.state.jobs.wait_idle(5)
        assert not (settings.library_dir / first["id"]).exists()
        assert client.get(f"/api/songs/{first['id']}").status_code == 404
        assert client.get(f"/api/songs/{first['id']}/analysis").status_code == 404


def test_analyze_twice_runs_once(settings):
    gate = threading.Event()
    log = []
    app = create_app(settings, separator=fake_separator(gate=gate), analyzer=fake_analyzer(log=log))
    with local_client(app) as client:
        song = upload_song(client)
        wait_for(lambda: song_of(client, song["id"])["stems"]["htdemucs_6s"]["status"] == "running")
        first = client.post(f"/api/songs/{song['id']}/analyze")
        second = client.post(f"/api/songs/{song['id']}/analyze")
        assert first.status_code == second.status_code == 202
        assert first.json()["analysis"]["status"] == second.json()["analysis"]["status"] == "queued"
        gate.set()
        assert client.app.state.jobs.wait_idle(5)
        info = analysis_of(client, song["id"])
        assert info["status"] == "ready"
        assert info["source"] == "htdemucs_6s"  # it waited for the stems that were being made
    assert len([e for e in log if e[0] == "beats"]) == 1


def test_analyze_while_it_runs_changes_nothing(settings):
    gate = threading.Event()
    log = []
    app = create_app(settings, separator=fake_separator(), analyzer=fake_analyzer(log=log, gate=gate))
    with local_client(app) as client:
        song = upload_song(client)
        wait_for(lambda: (info := analysis_of(client, song["id"])) and info["status"] == "running")
        response = client.post(f"/api/songs/{song['id']}/analyze")
        assert response.status_code == 202
        assert response.json()["analysis"]["status"] == "running"
        assert response.json()["analysis"]["progress"] >= 0
        gate.set()
        assert client.app.state.jobs.wait_idle(5)
    assert len([e for e in log if e[0] == "beats"]) == 1
