import threading
import time

import numpy as np
import pytest

from conftest import local_client, SR, fake_separator, sine, tagged_flac, wav_bytes
from kv_service.app import create_app
from kv_service.audio import read_audio
from kv_service.jobs import JobQueue
from kv_service.library import STEMS, Library
from kv_service.separation import SeparationError


def wait_for(condition, timeout: float = 5.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        value = condition()
        if value:
            return value
        time.sleep(0.02)
    raise AssertionError("condition not reached in time")


def upload(client, original: bytes = b"") -> dict:
    files = {
        "original": ("Кино - Кукушка.flac", original or tagged_flac("Кукушка", "Кино"), "audio/flac"),
        "mix": ("mix.wav", wav_bytes(sine(1.0)), "audio/wav"),
    }
    return client.post("/api/songs", files=files, data={"fileName": "Кино - Кукушка.flac"}).json()["song"]


@pytest.fixture
def gate():
    return threading.Event()


@pytest.fixture
def log():
    return []


@pytest.fixture
def client(settings, gate, log):
    app = create_app(settings, separator=fake_separator(log=log, gate=gate))
    with local_client(app) as c:
        yield c


def stems_of(client, song_id, model="htdemucs_6s"):
    return client.get(f"/api/songs/{song_id}").json()["stems"].get(model)


def test_upload_queues_the_default_model_and_shows_progress(client, gate, settings):
    song = upload(client)
    assert song["stems"]["htdemucs_6s"]["status"] in ("queued", "running")
    running = wait_for(lambda: (s := stems_of(client, song["id"])) and s["status"] == "running" and s)
    assert running["progress"] == pytest.approx(0.5)
    gate.set()
    ready = wait_for(lambda: (s := stems_of(client, song["id"])) and s["status"] == "ready" and s)
    assert ready["device"] == "cuda"
    assert ready["peakVramMb"] == 1234
    assert ready["gainDb"] <= 0
    assert "progress" not in ready
    assert client.get(f"/api/songs/{song['id']}").json()["activeModel"] == "htdemucs_6s"
    library = Library(settings.library_dir)
    for stem in STEMS:
        assert library.stem_path(song["id"], "htdemucs_6s", stem).is_file()
    guitar = client.get(f"/api/songs/{song['id']}/stems/htdemucs_6s/guitar.flac")
    assert guitar.status_code == 200
    assert guitar.content[:4] == b"fLaC"


def test_second_model_on_request_and_double_submit_runs_once(client, gate, log):
    gate.set()
    song = upload(client)
    wait_for(lambda: stems_of(client, song["id"])["status"] == "ready")
    first = client.post(f"/api/songs/{song['id']}/separate", params={"model": "bs_roformer_sw"})
    second = client.post(f"/api/songs/{song['id']}/separate", params={"model": "bs_roformer_sw"})
    assert first.status_code == 202
    assert second.status_code == 202
    wait_for(lambda: stems_of(client, song["id"], "bs_roformer_sw")["status"] == "ready")
    assert [e for e in log if e == ("separate", "bs_roformer_sw", False)] == [("separate", "bs_roformer_sw", False)]
    assert client.post(f"/api/songs/{song['id']}/separate", params={"model": "kazoo"}).status_code == 422


def test_delete_while_running_stops_the_job_and_leaves_nothing(client, settings):
    song = upload(client)
    wait_for(lambda: stems_of(client, song["id"])["status"] == "running")
    assert client.delete(f"/api/songs/{song['id']}").status_code == 204
    app_jobs = client.app.state.jobs
    assert app_jobs.wait_idle(5)
    assert not (settings.library_dir / song["id"]).exists()
    assert client.get(f"/api/songs/{song['id']}").status_code == 404


def test_dropping_stems_cancels_their_job(client):
    song = upload(client)
    wait_for(lambda: stems_of(client, song["id"])["status"] == "running")
    response = client.delete(f"/api/songs/{song['id']}/stems/htdemucs_6s")
    assert response.status_code == 200
    assert "htdemucs_6s" not in response.json()["stems"]
    assert client.app.state.jobs.wait_idle(5)
    assert stems_of(client, song["id"]) is None


def test_a_job_interrupted_by_a_restart_is_finished(tmp_path):
    library = Library(tmp_path / "library")
    song, _ = library.create(b"song", "a.wav", sine(1.0))
    library.set_stems(song["id"], "bs_roformer_sw", status="running")
    jobs = JobQueue(library, fake_separator())
    jobs.start()
    try:
        assert jobs.wait_idle(5)
    finally:
        jobs.stop()
    info = library.get(song["id"])["stems"]["bs_roformer_sw"]
    assert info["status"] == "ready"
    stem, sr = read_audio(library.stem_path(song["id"], "bs_roformer_sw", "bass"))
    assert sr == SR
    assert np.max(np.abs(stem)) == pytest.approx(0.5 * 0.3, abs=0.01)


def test_model_without_weights_ends_in_a_message(tmp_path):
    library = Library(tmp_path / "library")
    song, _ = library.create(b"song", "a.wav", sine(1.0))
    jobs = JobQueue(library, fake_separator(fails=[SeparationError("program.filesMissing", model="htdemucs_6s")]))
    jobs.start()
    try:
        jobs.submit(song["id"], "htdemucs_6s")
        assert jobs.wait_idle(5)
    finally:
        jobs.stop()
    info = library.get(song["id"])["stems"]["htdemucs_6s"]
    assert info["status"] == "error"
    assert info["error"] == {"code": "program.filesMissing", "params": {"model": "htdemucs_6s"}}


def test_a_broken_song_does_not_stop_the_queue(tmp_path):
    library = Library(tmp_path / "library")
    broken, _ = library.create(b"broken", "a.wav", sine(1.0))
    fine, _ = library.create(b"fine", "b.wav", sine(1.0))
    library.mix_path(broken["id"]).unlink()
    jobs = JobQueue(library, fake_separator())
    jobs.start()
    try:
        jobs.submit(broken["id"], "htdemucs_6s")
        jobs.submit(fine["id"], "htdemucs_6s")
        assert jobs.wait_idle(5)
    finally:
        jobs.stop()
    assert library.get(broken["id"])["stems"]["htdemucs_6s"]["status"] == "error"
    assert library.get(fine["id"])["stems"]["htdemucs_6s"]["status"] == "ready"


def test_the_model_is_unloaded_when_the_queue_is_empty(tmp_path):
    library = Library(tmp_path / "library")
    song, _ = library.create(b"song", "a.wav", sine(1.0))
    log = []
    jobs = JobQueue(library, fake_separator(log=log))
    jobs.start()
    try:
        jobs.submit(song["id"], "htdemucs_6s")
        assert jobs.wait_idle(5)
        wait_for(lambda: log[-1] == ("unload", "htdemucs_6s"))
    finally:
        jobs.stop()


def test_health_reports_the_device(client):
    body = client.get("/api/health").json()
    assert body["device"] == "cuda"
    assert body["gpuName"] == "Fake GPU"
