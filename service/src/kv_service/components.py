"""The neural networks of the installed app, added from inside the app (2026-11-18).

The installer brings only the base packages: the amp, the tuner, the tabs and tab-songs work at once.
Separating and analysing songs needs PyTorch, Demucs, Beat This!, BTC and their weights; the words
of the vocals need Whisper. They are downloaded by the app itself:

- `songs`: uv adds the `ml` group and one PyTorch build (`cuda` for an NVIDIA card that CUDA 13
  supports, `cpu` otherwise: about 3 GB or 0.5 GB) to the app's environment, then the weights of
  Demucs, Beat This! and BTC. Only when the user presses the button on «Songs» (the author,
  2026-11-18: the program must not weigh gigabytes before anyone asked for it); the button shows the
  size first. When it is done the service ends with RESTART_CODE and the window starts it again, so
  that the separator finds the graphics card; songs added meanwhile wait in the queue (JobQueue `ready`).
- `words`: Whisper large-v3 (2.9 GB), only when the user asks for it.

The author's copy never runs this: `npm run setup` installs everything.
"""

from __future__ import annotations

import ctypes
import importlib
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import tomllib
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from importlib import metadata
from pathlib import Path

from .config import Settings, prepare_model_env
from .messages import message, reason_of
from .models import (
    ANALYSIS_WEIGHTS,
    LYRICS_WEIGHTS,
    MODELS,
    fetch_weight,
    fetch_weights,
    ml_installed,
    model_installed,
    weight_ready,
    weights_ready,
    whisper_ready,
)

RESTART_CODE = 75
# CUDA 13 needs driver 580+ and a card of compute capability 7.5+ (GTX 16xx, RTX 20xx and newer).
MIN_DRIVER = 580
MIN_COMPUTE = 7.5
NO_WINDOW = 0x0800_0000 if sys.platform == "win32" else 0


def _no_window() -> dict:
    return {"creationflags": NO_WINDOW} if NO_WINDOW else {}


def _nvidia_smi() -> str | None:
    """The driver's own nvidia-smi: on Windows from System32 first (a search of PATH would also look
    in the current folder)."""
    if sys.platform == "win32":
        candidate = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "nvidia-smi.exe"
        if candidate.is_file():
            return str(candidate)
    return shutil.which("nvidia-smi")


def gpu_flavor(run: Callable[..., subprocess.CompletedProcess] = subprocess.run) -> str:
    """'cuda' when an NVIDIA card can run our PyTorch build, else 'cpu'."""
    smi = _nvidia_smi()
    if smi is None:
        return "cpu"
    try:
        out = run(
            [smi, "--query-gpu=driver_version,compute_cap", "--format=csv,noheader"],
            capture_output=True,
            text=True,
            timeout=15,
            **_no_window(),
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return "cpu"
    for line in out.splitlines():
        try:
            driver, compute = (part.strip() for part in line.split(","))
            if int(driver.split(".")[0]) >= MIN_DRIVER and float(compute) >= MIN_COMPUTE:
                return "cuda"
        except ValueError:
            continue
    return "cpu"


def _platform_tag() -> str:
    if sys.platform == "win32":
        return "win_amd64"
    if sys.platform == "darwin":
        return "macosx"
    return "manylinux"


WHEEL_SIZES = "wheel-sizes.json"


def download_size(lock_file: Path, flavor: str, installed: set[tuple[str, str]], online: bool = False) -> int:
    """Roughly how many bytes uv will download: the wheel for this platform of every locked package
    not installed yet, PyTorch in the chosen build. Not exact (it does not follow markers), only to
    show how much is left. The PyTorch index gives no sizes: scripts/build-app.mjs writes them into
    wheel-sizes.json beside uv.lock; `online` asks the index (HEAD) for any still missing."""
    lock = tomllib.loads(lock_file.read_text(encoding="utf-8"))
    try:
        known = json.loads((lock_file.parent / WHEEL_SIZES).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        known = {}
    tag = _platform_tag()
    total = 0
    for package in lock.get("package", []):
        name, version = package["name"], package.get("version", "")
        # The full version: PyTorch for the processor (2.15.0) is not the CUDA one (2.15.0+cu132).
        if (name.lower().replace("_", "-"), version) in installed:
            continue
        if name == "torch" and (("+cu" in version) != (flavor == "cuda")):
            continue
        if name.startswith("nvidia-") and flavor != "cuda":
            continue
        wheels = package.get("wheels", [])
        fits = [w for w in wheels if tag in w["url"] and "cp312" in w["url"]] or [
            w for w in wheels if tag in w["url"] or "none-any" in w["url"] or "abi3" in w["url"] and tag in w["url"]
        ]
        if fits:
            wheel = fits[0]
            size = wheel.get("size") or known.get(wheel["url"]) or (head_size(wheel["url"]) if online else 0)
            total += int(size)
    return total


def head_size(url: str) -> int:
    """The size of a file the lock does not know it for (the PyTorch index gives none): a HEAD
    request. 0 when it does not answer: then the total is short, never wrong the other way."""
    try:
        request = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "strum-setup"})
        with urllib.request.urlopen(request, timeout=15) as response:
            return int(response.headers.get("Content-Length") or 0)
    except (OSError, ValueError):
        return 0


def installed_packages() -> set[tuple[str, str]]:
    return {
        (dist.metadata["Name"].lower().replace("_", "-"), dist.version)
        for dist in metadata.distributions()
        if dist.metadata["Name"]
    }


class _IoCounters(ctypes.Structure):
    _fields_ = [
        (name, ctypes.c_ulonglong)
        for name in (
            "ReadOperationCount",
            "WriteOperationCount",
            "OtherOperationCount",
            "ReadTransferCount",
            "WriteTransferCount",
            "OtherTransferCount",
        )
    ]


def _bytes_read(process: subprocess.Popen) -> int | None:
    """What uv has read so far (on Windows, the network included): its download progress."""
    if sys.platform != "win32":
        return None
    counters = _IoCounters()
    handle = getattr(process, "_handle", None)
    if handle is None:
        return None
    ok = ctypes.windll.kernel32.GetProcessIoCounters(ctypes.c_void_p(int(handle)), ctypes.byref(counters))
    return int(counters.ReadTransferCount + counters.OtherTransferCount) if ok else None


@dataclass
class Part:
    state: str = "missing"  # missing | installing | ready | failed
    stage: str = ""  # packages | weights | restarting
    done: int = 0
    total: int = 0
    unit: str = "bytes"  # bytes | steps (separation weights come in files of unknown size)
    error: dict | None = None
    flavor: str = ""
    lock: threading.Lock = field(default_factory=threading.Lock)

    def view(self) -> dict:
        return {
            "state": self.state,
            "stage": self.stage,
            "done": self.done,
            "total": self.total,
            "unit": self.unit,
            "error": self.error,
            "flavor": self.flavor,
        }


def _default_restart() -> None:
    # A moment for the page to see "restarting", then the window starts the service again.
    def later() -> None:
        time.sleep(1.5)
        os._exit(RESTART_CODE)

    threading.Thread(target=later, name="kv-restart", daemon=True).start()


class Components:
    def __init__(self, settings: Settings, restart: Callable[[], None] = _default_restart) -> None:
        self.settings = settings
        self.restart = restart
        self.songs = Part()
        self.words = Part()
        self._estimated: int | None = None
        self._refresh()

    @property
    def can_install(self) -> bool:
        """Only the installed app adds packages to its own environment."""
        return self.settings.shell and self.settings.uv is not None and self.settings.project_dir is not None

    def _songs_ready(self) -> bool:
        if not ml_installed():
            return False
        models_dir = self.settings.models_dir
        separation = all(weights_ready(m, models_dir) for m in MODELS if model_installed(m))
        return separation and all(weight_ready(w, models_dir) for w in ANALYSIS_WEIGHTS)

    def _refresh(self) -> None:
        if self.songs.state != "installing":
            self.songs.state = "ready" if self._songs_ready() else self.songs.state if self.songs.state == "failed" else "missing"
        if self.words.state != "installing":
            ready = whisper_ready(self.settings.models_dir)
            self.words.state = "ready" if ready else self.words.state if self.words.state == "failed" else "missing"

    def ready(self) -> bool:
        """Songs may be separated and analysed (always true outside the installed app)."""
        return not self.can_install or self.songs.state == "ready"

    def status(self) -> dict:
        self._refresh()
        songs = self.songs.view()
        if self.can_install and self.songs.state in ("missing", "failed"):
            songs["estimate"] = self._estimate()
        return {"canInstall": self.can_install, "songs": songs, "words": self.words.view()}

    def _estimate(self) -> int:
        """What pressing the button would download, for its label (offline: the lock and
        wheel-sizes.json; nvidia-smi once)."""
        if self._estimated is None:
            assert self.settings.project_dir is not None
            self.songs.flavor = self.songs.flavor or gpu_flavor()
            try:
                self._estimated = download_size(
                    self.settings.project_dir / "uv.lock", self.songs.flavor, installed_packages()
                )
            except (OSError, ValueError):
                self._estimated = 0
        return self._estimated

    def start(self, part: str) -> bool:
        """Starts a download in the background. False when it cannot run or already runs."""
        self._refresh()
        target = self.songs if part == "songs" else self.words
        if not self.can_install or target.state in ("installing", "ready"):
            return False
        if part == "words" and self.songs.state != "ready":
            return False
        with target.lock:
            target.state, target.stage, target.done, target.total, target.error = "installing", "", 0, 0, None
        run = self._install_songs if part == "songs" else self._install_words
        threading.Thread(target=self._guarded, args=(target, run), name=f"kv-install-{part}", daemon=True).start()
        return True

    def _guarded(self, target: Part, run: Callable[[Part], None]) -> None:
        try:
            run(target)
        except Exception as error:  # noqa: BLE001 - shown to the user, who may try again
            target.state, target.stage = "failed", ""
            target.error = message("components.failed", reason=reason_of(error))

    # --- songs ----------------------------------------------------------------------------------

    def _install_songs(self, part: Part) -> None:
        part.flavor = gpu_flavor()
        if not ml_installed():
            self._sync(part)
        part.stage, part.done, part.total = "weights", 0, 0
        self._fetch(part, "songs")
        importlib.invalidate_caches()
        part.state, part.stage = "ready", "restarting"
        self.restart()

    def _sync(self, part: Part) -> None:
        settings = self.settings
        assert settings.uv is not None and settings.project_dir is not None
        part.stage, part.unit = "packages", "bytes"
        part.total = download_size(settings.project_dir / "uv.lock", part.flavor, installed_packages(), online=True)
        command = [
            str(settings.uv), "sync", "--frozen", "--no-dev", "--inexact",
            "--group", "ml", "--group", part.flavor, "--project", str(settings.project_dir),
        ]
        log = settings.models_dir.parent / "logs" / "components.log"
        log.parent.mkdir(parents=True, exist_ok=True)
        with log.open("a", encoding="utf-8") as out:
            out.write(f"\n{time.strftime('%Y-%m-%d %H:%M:%S')} {' '.join(command)}\n")
            out.flush()
            process = subprocess.Popen(command, stdout=out, stderr=out, stdin=subprocess.DEVNULL, **_no_window())
            while process.poll() is None:
                read = _bytes_read(process)
                if read is not None and part.total:
                    part.done = min(read, int(part.total * 0.99))
                time.sleep(0.5)
        if process.returncode != 0:
            raise RuntimeError(f"uv exit {process.returncode}, see {log}")
        part.done = part.total

    def _fetch(self, part: Part, what: str) -> None:
        """The weights, in a separate Python: the packages uv just added load there, not in this
        process, and HuggingFace is allowed online there only."""
        command = [sys.executable, "-m", "kv_service.components", "fetch", what]
        env = {**os.environ, "HF_HUB_OFFLINE": "0"}
        process = subprocess.Popen(
            command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
            env=env, text=True, encoding="utf-8", errors="replace", **_no_window(),
        )
        failed: str | None = None
        assert process.stdout is not None
        for line in process.stdout:
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if "total" in event:
                part.total = int(event["total"])
                part.unit = str(event.get("unit", "bytes"))
            if "done" in event:
                part.done = int(event["done"])
            if "error" in event:
                failed = str(event["error"])
        process.wait()
        if process.returncode != 0 or failed:
            raise RuntimeError(failed or f"exit {process.returncode}")

    # --- words ----------------------------------------------------------------------------------

    def _install_words(self, part: Part) -> None:
        part.stage = "weights"
        self._fetch(part, "words")
        part.state, part.stage = "ready", ""


def _fetch_main(what: str) -> int:
    """`python -m kv_service.components fetch songs|words`: downloads weights, one JSON line per step."""
    from .config import load_settings

    settings = load_settings()
    prepare_model_env(settings.models_dir, offline=False)

    def say(**event: object) -> None:
        print(json.dumps(event), flush=True)

    if what == "words":
        files = [w for w in LYRICS_WEIGHTS.values() if not weight_ready(w.id, settings.models_dir)]
        total = sum(w.size for w in files)
        say(total=total, done=0, unit="bytes")
        done = 0
        for weight in files:
            try:
                fetch_weight(weight.id, settings.models_dir)
            except Exception as error:  # noqa: BLE001
                say(error=reason_of(error))
                return 1
            done += weight.size
            say(done=done)
        return 0

    separation = [m for m in MODELS if model_installed(m) and not weights_ready(m, settings.models_dir)]
    files = [w for w in ANALYSIS_WEIGHTS.values() if not weight_ready(w.id, settings.models_dir)]
    steps = len(separation) + len(files)
    say(total=steps, done=0, unit="steps")
    done = 0
    try:
        for model_id in separation:
            fetch_weights(model_id, settings.models_dir)
            done += 1
            say(done=done)
        for weight in files:
            fetch_weight(weight.id, settings.models_dir)
            done += 1
            say(done=done)
    except Exception as error:  # noqa: BLE001
        say(error=reason_of(error))
        return 1
    return 0


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "fetch":
        raise SystemExit(_fetch_main(sys.argv[2]))
    raise SystemExit(2)
