"""The installed app's own download of the neural networks (components.py)."""

import dataclasses
import subprocess
import textwrap

import pytest

from conftest import fake_analyzer, fake_separator, fake_transcriber, local_client

from kv_service import components as comp
from kv_service.app import create_app
from kv_service.components import Components, download_size, gpu_flavor


def smi(output: str):
    def run(*_args, **_kwargs):
        return subprocess.CompletedProcess([], 0, stdout=output)

    return run


def test_gpu_flavor(monkeypatch):
    monkeypatch.setattr(comp.shutil, "which", lambda _name: "nvidia-smi")
    assert gpu_flavor(smi("591.44, 8.9\n")) == "cuda"  # RTX 40xx on a new driver
    assert gpu_flavor(smi("572.16, 8.6\n")) == "cpu"  # driver too old for CUDA 13
    assert gpu_flavor(smi("591.44, 6.1\n")) == "cpu"  # GTX 10xx: CUDA 13 dropped it
    assert gpu_flavor(smi("[N/A], [N/A]\n")) == "cpu"
    assert gpu_flavor(smi("572.16, 8.6\n591.44, 7.5\n")) == "cuda"  # any card that fits


def test_no_nvidia_means_cpu(monkeypatch):
    monkeypatch.setattr(comp.shutil, "which", lambda _name: None)
    monkeypatch.setattr(comp.sys, "platform", "linux")
    assert gpu_flavor() == "cpu"


def test_download_size_counts_what_is_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(comp, "_platform_tag", lambda: "win_amd64")
    lock = tmp_path / "uv.lock"
    lock.write_text(
        textwrap.dedent(
            """
            [[package]]
            name = "torch"
            version = "2.15.0"
            wheels = [{ url = "https://x/torch-2.15.0-cp312-cp312-win_amd64.whl", size = 100 }]

            [[package]]
            name = "torch"
            version = "2.15.0+cu132"
            wheels = [{ url = "https://x/torch-2.15.0%2Bcu132-cp312-cp312-win_amd64.whl", size = 2000 }]

            [[package]]
            name = "nvidia-cublas-cu12"
            version = "12.9.2.10"
            wheels = [{ url = "https://x/nvidia_cublas_cu12-12.9.2.10-py3-none-win_amd64.whl", size = 500 }]

            [[package]]
            name = "librosa"
            version = "1.0.1"
            wheels = [{ url = "https://x/librosa-1.0.1-py3-none-any.whl", size = 7 }]

            [[package]]
            name = "numpy"
            version = "2.3.4"
            wheels = [{ url = "https://x/numpy-2.3.4-cp312-cp312-win_amd64.whl", size = 30 }]
            """
        ),
        encoding="utf-8",
    )
    have = {("numpy", "2.3.4")}
    assert download_size(lock, "cpu", have) == 100 + 7
    assert download_size(lock, "cuda", have) == 2000 + 500 + 7


def test_outside_the_installed_app_nothing_is_installed(settings):
    parts = Components(settings, restart=lambda: None)
    assert not parts.can_install
    assert parts.ready()  # the author's copy: jobs run as always
    assert parts.start("songs") is False
    status = parts.status()
    assert status["canInstall"] is False
    assert set(status) == {"canInstall", "songs", "words"}


def test_the_installed_app_waits_for_its_networks(settings, tmp_path, monkeypatch):
    installed = dataclasses.replace(settings, shell=True, uv=tmp_path / "uv.exe", project_dir=tmp_path)
    monkeypatch.setattr(comp, "ml_installed", lambda: False)
    parts = Components(installed, restart=lambda: None)
    assert parts.can_install
    assert not parts.ready()
    # Whisper only after the song networks.
    assert parts.start("words") is False


def test_songs_install_runs_sync_then_weights_then_restarts(settings, tmp_path, monkeypatch):
    installed = dataclasses.replace(settings, shell=True, uv=tmp_path / "uv.exe", project_dir=tmp_path)
    steps: list[str] = []
    state = {"ml": False}
    monkeypatch.setattr(comp, "ml_installed", lambda: state["ml"])
    monkeypatch.setattr(comp, "gpu_flavor", lambda: "cpu")

    def sync(self, part):
        steps.append(f"sync {part.flavor}")
        state["ml"] = True

    def fetch(self, part, what):
        steps.append(f"fetch {what}")

    monkeypatch.setattr(Components, "_sync", sync)
    monkeypatch.setattr(Components, "_fetch", fetch)
    restarted = []
    parts = Components(installed, restart=lambda: restarted.append(True))
    target = parts.songs
    target.state = "installing"
    parts._guarded(target, parts._install_songs)
    assert steps == ["sync cpu", "fetch songs"]
    assert target.state == "ready" and target.stage == "restarting"
    assert restarted == [True]


def test_a_failed_download_says_why(settings, tmp_path, monkeypatch):
    installed = dataclasses.replace(settings, shell=True, uv=tmp_path / "uv.exe", project_dir=tmp_path)
    monkeypatch.setattr(comp, "ml_installed", lambda: False)
    monkeypatch.setattr(comp, "gpu_flavor", lambda: "cpu")

    def broken(self, part):
        raise RuntimeError("no internet")

    monkeypatch.setattr(Components, "_sync", broken)
    parts = Components(installed, restart=lambda: None)
    parts._guarded(parts.songs, parts._install_songs)
    assert parts.songs.state == "failed"
    assert parts.songs.error == {"code": "components.failed", "params": {"reason": "no internet"}}


def test_health_reports_the_components(settings):
    app = create_app(settings, separator=fake_separator(), analyzer=fake_analyzer(), transcriber=fake_transcriber())
    with local_client(app) as client:
        health = client.get("/api/health").json()
        assert health["components"]["canInstall"] is False
        assert client.post("/api/components/songs").status_code == 202
        assert client.post("/api/components/movies").status_code == 422


def test_nothing_downloads_by_itself_and_the_size_is_shown_first(settings, tmp_path, monkeypatch):
    """The author, 2026-11-18: no gigabytes before anyone asked. The button says how many first."""
    (tmp_path / "uv.lock").write_text(
        textwrap.dedent(
            """
            [[package]]
            name = "torch"
            version = "2.15.0+cu132"
            wheels = [{ url = "https://x/torch-2.15.0%2Bcu132-cp312-cp312-win_amd64.whl" }]
            """
        ),
        encoding="utf-8",
    )
    (tmp_path / "wheel-sizes.json").write_text(
        '{"https://x/torch-2.15.0%2Bcu132-cp312-cp312-win_amd64.whl": 2108273925}', encoding="utf-8"
    )
    monkeypatch.setattr(comp, "_platform_tag", lambda: "win_amd64")
    monkeypatch.setattr(comp, "ml_installed", lambda: False)
    monkeypatch.setattr(comp, "gpu_flavor", lambda: "cuda")
    monkeypatch.setattr(comp, "head_size", lambda _url: pytest.fail("no network before the button"))
    monkeypatch.setattr(comp, "installed_packages", lambda: set())
    installed = dataclasses.replace(settings, shell=True, uv=tmp_path / "uv.exe", project_dir=tmp_path)
    app = create_app(installed, separator=fake_separator(), analyzer=fake_analyzer(), transcriber=fake_transcriber())
    with local_client(app) as client:
        songs = client.get("/api/health").json()["components"]["songs"]
        assert songs["state"] == "missing"  # not installing: nothing started by itself
        assert songs["estimate"] == 2108273925


def test_received_counts_the_busiest_interface_through_wraps():
    readings = iter([
        {1: 100, 2: 2**32 - 50},
        {1: 300, 2: 150},  # 2 wrapped: +200
        {1: 400, 2: 1150, 3: 7},  # 3 is new: counted from here
        {1: 400, 2: 1150, 3: 5007},
    ])
    received = comp.Received(lambda: next(readings))
    assert received.bytes() == 200
    assert received.bytes() == 1200
    assert received.bytes() == 5000


def test_received_without_counters_is_zero():
    assert comp.Received(lambda: None).bytes() == 0
