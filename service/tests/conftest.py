import io
import json
import threading
import time
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from kv_service.analysis import Analyzer
from kv_service.config import Settings
from kv_service.library import STEMS
from kv_service.lyrics import Transcriber
from kv_service.separation import Separator

SR = 44100


class OutOfMemoryError(RuntimeError):
    """Named like torch.OutOfMemoryError, which the separator recognises."""


class NoMemory:
    """Stands in for the torch memory probe, so tests never touch the real GPU."""

    def reset(self, device: str) -> None:
        pass

    def peak_mb(self, device: str) -> int | None:
        return 1234 if device == "cuda" else None

    def release(self, device: str) -> None:
        pass


class FakeBackend:
    """A separation model double: stem k is the mix times 0.1·(k+1).

    `fails` is shared between instances (the separator makes a new backend per device) and holds
    exceptions to raise from successive separate() calls. While `gate` is not set, separate()
    keeps reporting progress 0.5, which lets a test look at a running job.
    """

    def __init__(self, model_id: str, log: list, fails: list | None = None, gate: threading.Event | None = None):
        self.model_id = model_id
        self.log = log
        self.fails = fails if fails is not None else []
        self.gate = gate

    def load(self, device: str) -> None:
        self.log.append(("load", self.model_id, device))

    def separate(self, mix, sr, progress, small):
        self.log.append(("separate", self.model_id, small))
        if self.fails:
            raise self.fails.pop(0)
        progress(0.5)
        if self.gate is not None:
            while not self.gate.wait(0.01):
                progress(0.5)
        progress(1.0)
        return {stem: mix * 0.1 * (k + 1) for k, stem in enumerate(STEMS)}

    def unload(self) -> None:
        self.log.append(("unload", self.model_id))


def fake_separator(device: str = "cuda", log: list | None = None, fails: list | None = None, gate=None) -> Separator:
    log = log if log is not None else []
    fails = fails if fails is not None else []
    factories = {m: (lambda m=m: FakeBackend(m, log, fails, gate)) for m in ("htdemucs_6s", "bs_roformer_sw")}
    return Separator(factories, device=device, gpu_name="Fake GPU" if device == "cuda" else None, memory=NoMemory())


class FakeBeats:
    """A beat model double: a beat every `period` s from 0, every `per_bar`-th one a downbeat.

    `fails` is shared between instances (the analyzer makes new backends per device) and holds
    exceptions to raise from successive load() calls. While `gate` is not set, beats() waits (up
    to 10 s), which lets a test look at a running analysis. `period=None` finds no beats at all.
    """

    def __init__(self, log: list, fails: list | None = None, gate: threading.Event | None = None,
                 period: float | None = 0.5, per_bar: int = 4):
        self.log = log
        self.fails = fails if fails is not None else []
        self.gate = gate
        self.period = period
        self.per_bar = per_bar

    def load(self, device: str) -> None:
        self.log.append(("load", "beats", device))
        if self.fails:
            raise self.fails.pop(0)

    def beats(self, mono: np.ndarray, sr: int) -> tuple[np.ndarray, np.ndarray]:
        self.log.append(("beats", round(len(mono) / sr, 3)))
        if self.gate is not None:
            self.gate.wait(10)
        if self.period is None:
            return np.zeros(0), np.zeros(0)
        beats = np.arange(0.0, len(mono) / sr, self.period)
        return beats, beats[:: self.per_bar]

    def unload(self) -> None:
        self.log.append(("unload", "beats"))


class FakeChords:
    """A chord model double: the progression, `length` s per chord, round and round, each change a
    little late (as a real model's are). Logs the RMS of what it heard."""

    def __init__(self, log: list, progression: tuple[str, ...] = ("C", "G", "A:min", "F"),
                 length: float = 2.0, late: float = 0.07):
        self.log = log
        self.progression = progression
        self.length = length
        self.late = late

    def load(self, device: str) -> None:
        self.log.append(("load", "chords", device))

    def chords(self, mono: np.ndarray, sr: int) -> list[dict]:
        self.log.append(("chords", float(np.sqrt(np.mean(np.square(mono, dtype=np.float64))))))
        duration = len(mono) / sr
        segments, start, k = [], 0.0, 0
        while start < duration:
            end = min(duration, (k + 1) * self.length + self.late)
            segments.append({"start": start, "end": end, "chord": self.progression[k % len(self.progression)]})
            start, k = end, k + 1
        return segments

    def unload(self) -> None:
        self.log.append(("unload", "chords"))


class FakePitch:
    """A pitch model double: A4 (440 Hz), clearly pitched, over the whole input; logs the RMS of
    what it got, so a test can tell the guitar stem from the mix."""

    def __init__(self, log: list):
        self.log = log

    def load(self, device: str) -> None:
        self.log.append(("load", "pitch", device))

    def pitch(self, mono: np.ndarray, sr: int):
        self.log.append(("pitch", round(float(np.sqrt(np.mean(np.square(mono)))), 3)))
        frames = int(len(mono) / sr * 100)
        return np.full(frames, 440.0), np.full(frames, 0.9), 0.01

    def unload(self) -> None:
        self.log.append(("unload", "pitch"))


def fake_analyzer(device: str = "cuda", log: list | None = None, fails: list | None = None, gate=None,
                  period: float | None = 0.5, progression: tuple[str, ...] = ("C", "G", "A:min", "F")) -> Analyzer:
    log = log if log is not None else []
    fails = fails if fails is not None else []
    return Analyzer(
        lambda: FakeBeats(log, fails, gate, period),
        lambda: FakeChords(log, progression),
        device=device,
        memory=NoMemory(),
        pitch_factory=lambda: FakePitch(log),
    )


class FakeWhisper:
    """A Whisper double: three words a second apart from 1 s, language "ru". Records the audio it
    got (length, RMS, language asked for) in `log`; `fails` and `gate` work as in FakeBeats.
    `hears` overrides the answer: a function (audio, language) -> (language, words, lines)."""

    def __init__(self, log: list, fails: list | None = None, gate: threading.Event | None = None, hears=None):
        self.log = log
        self.fails = fails if fails is not None else []
        self.gate = gate
        self.hears = hears

    def load(self, device: str, compute_type: str) -> None:
        self.log.append(("load", "whisper", device, compute_type))
        if self.fails:
            raise self.fails.pop(0)

    def transcribe(self, audio: np.ndarray, progress, language=None) -> tuple[str, list[dict], list[dict]]:
        self.log.append(("transcribe", len(audio), round(float(np.sqrt(np.mean(np.square(audio)))), 3), language))
        if self.gate is not None:
            self.gate.wait(10)
        progress(0.5)
        if self.hears is not None:
            return self.hears(audio, language)
        words = [
            {"start": 3.0, "end": 3.4, "word": " три", "p": 0.8},
            {"start": 1.0, "end": 1.4, "word": " раз", "p": 0.9},
            {"start": 2.0, "end": 2.4, "word": " два", "p": 0.9},
        ]
        return "ru", words, [{"start": 1.0, "end": 3.4, "text": " раз два три"}]

    def unload(self) -> None:
        self.log.append(("unload", "whisper"))


def fake_transcriber(device: str = "cuda", log: list | None = None, fails: list | None = None, gate=None, hears=None) -> Transcriber:
    log = log if log is not None else []
    return Transcriber(lambda: FakeWhisper(log, fails, gate, hears), device=device)


def sine(seconds: float, amp: float = 0.5, freq: float = 440.0, sr: int = SR, channels: int = 2) -> np.ndarray:
    t = np.arange(int(round(seconds * sr))) / sr
    mono = (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)
    return np.repeat(mono[:, None], channels, axis=1)


def wav_bytes(data: np.ndarray, sr: int = SR, subtype: str = "FLOAT") -> bytes:
    buf = io.BytesIO()
    sf.write(buf, data, sr, format="WAV", subtype=subtype)
    return buf.getvalue()


def tagged_flac(title: str, artist: str, seconds: float = 0.2) -> bytes:
    """A small 'original' file with tags, like an mp3 from the internet."""
    buf = io.BytesIO()
    with sf.SoundFile(buf, "w", SR, 2, format="FLAC", subtype="PCM_16") as f:
        f.title = title
        f.artist = artist
        f.write(sine(seconds, amp=0.1))
    return buf.getvalue()


def local_client(app) -> TestClient:
    """A test client that talks like the app: from a localhost address (the service refuses others)."""
    return TestClient(app, base_url="http://127.0.0.1:5174")


def wait_for(condition, timeout: float = 5.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        value = condition()
        if value:
            return value
        time.sleep(0.02)
    raise AssertionError("condition not reached in time")


def upload_song(client, original: bytes = b"", seconds: float = 3.0) -> dict:
    files = {
        "original": ("Кино - Кукушка.flac", original or tagged_flac("Кукушка", "Кино"), "audio/flac"),
        "mix": ("mix.wav", wav_bytes(sine(seconds)), "audio/wav"),
    }
    return client.post("/api/songs", files=files, data={"fileName": "Кино - Кукушка.flac"}).json()["song"]


def song_of(client, song_id: str) -> dict:
    return client.get(f"/api/songs/{song_id}").json()


def analysis_of(client, song_id: str) -> dict | None:
    return song_of(client, song_id)["analysis"]


STAGE_2_PLAYER = {"capo": 0, "tuning": "standard", "simpleChords": False, "mode": "play", "reveal": 0,
                  "countIn": False, "click": False, "toneMatch": True, "tuningApplied": False}


def as_stage_1(library_root: Path, song_id: str) -> None:
    """Rewrites song.json as stage 1 wrote it: without the stage-2 keys."""
    path = library_root / song_id / "song.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    for key in ("analysis", "chords", "barShift"):
        data.pop(key, None)
    for key in STAGE_2_PLAYER:
        data["player"].pop(key, None)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


@pytest.fixture
def settings(tmp_path) -> Settings:
    return Settings(
        library_dir=tmp_path / "library",
        models_dir=tmp_path / "models",
        default_model="htdemucs_6s",
        max_seconds=3,
    )
