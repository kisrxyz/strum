"""Song analysis: beats and bars (Beat This!), chords (BTC), the notes of the guitar stem (CREPE),
then plain numpy steps for the tempo, meter, key, the recording's tuning, the sections and the
guitar's tone. The result is the song's
analysis.json (mirrored by `Analysis` in src/song/types.ts).

As in separation.py, torch and the model packages are imported only inside the backends, the
models stay loaded between songs, and a GPU failure is retried on the CPU. The chords are heard
from the whole mix: on the author's songs BTC agreed with the published chords as well or better
than from the stems without vocals and drums (72 % against 60 % of «Кайен», 2026-11-07). The
tuning is measured on guitar + keys + other: bass overtones and singing pull it sharp.
"""

from __future__ import annotations

import functools
import importlib.util
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import numpy as np

from .harmony import NO_CHORD, clean_chords, estimate_key
from .messages import UserError, reason_of
from .models import ANALYSIS_WEIGHTS, weight_path, weight_ready
from .notes import frames_to_notes
from .rhythm import bar_spans, tempo_and_meter
from .sections import bar_levels, bar_patterns, find_sections
from .separation import Cancelled, MemoryProbe, TorchMemory, detect_device
from .tone import match_tone
from .tuning import estimate_tuning_cents

# 2: the notes of the guitar stem («радар нот»).
ANALYSIS_VERSION = 2
# Stems the recording's tuning is measured on (when the song has stems; else the mix).
TUNING_STEMS = ("guitar", "piano", "other")
Progress = Callable[[float], None]


class AnalysisError(UserError, RuntimeError):
    """A failure the user is told of: a code and its values."""


class PitchUnavailable(AnalysisError):
    """The notes' model (torchcrepe) is not installed yet: the analysis goes on without notes and
    is made again once it is there (`notesMissing`)."""


@functools.cache
def pitch_available() -> bool:
    """torchcrepe is installed (checked once per start: `npm run setup` restarts the service)."""
    return importlib.util.find_spec("torchcrepe") is not None


class BeatBackend(Protocol):
    def load(self, device: str) -> None: ...

    def beats(self, mono: np.ndarray, sr: int) -> tuple[np.ndarray, np.ndarray]: ...

    def unload(self) -> None: ...


class ChordBackend(Protocol):
    def load(self, device: str) -> None: ...

    def chords(self, mono: np.ndarray, sr: int) -> list[dict]: ...

    def unload(self) -> None: ...


class PitchBackend(Protocol):
    def load(self, device: str) -> None: ...

    def pitch(self, mono: np.ndarray, sr: int) -> tuple[np.ndarray, np.ndarray, float]:
        """(pitch in Hz per frame, periodicity 0..1 per frame, seconds per frame)."""
        ...

    def unload(self) -> None: ...


@dataclass
class AnalysisResult:
    data: dict  # analysis.json
    device: str
    seconds: float
    peak_vram_mb: int | None = None


def mono(x: np.ndarray) -> np.ndarray:
    """float32 (frames,) from (frames,) or (frames, channels)."""
    x = np.asarray(x, dtype=np.float32)
    return x.mean(axis=1, dtype=np.float32) if x.ndim == 2 else x


def _sized(x: np.ndarray, frames: int) -> np.ndarray:
    """Cut or zero-pad to `frames` (a stem a few samples off the mix still lines up)."""
    return x[:frames] if len(x) >= frames else np.pad(x, (0, frames - len(x)))


def _missing(weight_id: str) -> AnalysisError:
    """The weights are not there: the program's files are incomplete."""
    return AnalysisError("program.filesMissing", model=ANALYSIS_WEIGHTS[weight_id].id)


def _no_packages() -> AnalysisError:
    return AnalysisError("program.filesMissing", model="analysis")


def _seconds(values) -> list[float]:
    return [round(float(v), 3) for v in np.sort(np.asarray(values, dtype=np.float64).ravel())]


class Analyzer:
    """Runs the two models and the numpy steps. GPU → CPU when the GPU fails.

    `device` None means "find it at the first job": the real backends check their weights in
    their constructors, so a missing download fails before torch is imported.
    """

    def __init__(
        self,
        beat_factory: Callable[[], BeatBackend],
        chord_factory: Callable[[], ChordBackend],
        device: str | None = None,
        memory: MemoryProbe | None = None,
        pitch_factory: Callable[[], PitchBackend] | None = None,
    ):
        self.beat_factory = beat_factory
        self.chord_factory = chord_factory
        self.pitch_factory = pitch_factory
        self._pitch: PitchBackend | None = None
        self._device = device
        self.memory = memory or TorchMemory()
        self._beat: BeatBackend | None = None
        self._chord: ChordBackend | None = None
        self._loaded_on: str | None = None

    @property
    def device(self) -> str:
        if self._device is None:
            self._device = detect_device()[0]
        return self._device

    def _ensure(self, device: str | None) -> str:
        """Loads both models on `device` (None: the usual one). Returns the device."""
        if device is None and self._device is not None:
            device = self._device
        if device is not None and self._loaded_on == device:
            return device
        self.unload()
        beat, chord = self.beat_factory(), self.chord_factory()  # may raise AnalysisError
        pitch = self.pitch_factory() if self.pitch_factory else None
        device = device or self.device
        try:
            beat.load(device)
            chord.load(device)
            if pitch is not None:
                try:
                    pitch.load(device)
                except PitchUnavailable:
                    pitch = None  # bars and chords without the notes
        except BaseException:
            for backend in (beat, chord, pitch):
                try:
                    if backend is not None:
                        backend.unload()
                except Exception:  # noqa: BLE001 - the load error is the one to report
                    pass
            self.memory.release(device)
            raise
        self._beat, self._chord, self._pitch, self._loaded_on = beat, chord, pitch, device
        return device

    def unload(self) -> None:
        if self._loaded_on is None:
            return
        device = self._loaded_on
        for backend in (self._beat, self._chord, self._pitch):
            if backend is not None:
                backend.unload()
        self._beat = self._chord = self._pitch = self._loaded_on = None
        self.memory.release(device)

    def _infer(self, whole: np.ndarray, guitar: np.ndarray | None, sr: int, progress: Progress):
        """(beats, downbeats, raw chords, notes, device, peak video memory)."""
        attempts: list[str | None] = [None]
        while attempts:
            wanted = attempts.pop(0)
            device = wanted
            try:
                device = self._ensure(wanted)
                self.memory.reset(device)
                progress(0.05)
                beats, downbeats = self._beat.beats(whole, sr)  # type: ignore[union-attr]
                progress(0.45)
                chords = self._chord.chords(whole, sr)  # type: ignore[union-attr]
                progress(0.65)
                notes: list[dict] = []
                if guitar is not None and self._pitch is not None:
                    notes = frames_to_notes(*self._pitch.pitch(guitar, sr))
                progress(0.85)
                return beats, downbeats, chords, notes, device, self.memory.peak_mb(device)
            except (Cancelled, AnalysisError):
                raise
            except Exception as error:  # noqa: BLE001 - every GPU failure gets the CPU fallback
                failed_on = device or self._device or "cpu"
                self.unload()
                if failed_on == "cpu":
                    raise AnalysisError("analysis.failed", reason=reason_of(error)) from error
                attempts = ["cpu"]
        raise AssertionError("unreachable")

    def run(
        self,
        mix: np.ndarray,
        stems: dict[str, np.ndarray] | None,
        source: str,
        sr: int,
        progress: Progress,
    ) -> AnalysisResult:
        """mix and stems: float32 (frames, 2) or (frames,). Raises Cancelled or AnalysisError."""
        started = time.perf_counter()
        progress(0.0)
        whole = mono(mix)
        duration = len(whole) / sr
        stems = {name: _sized(mono(x), len(whole)) for name, x in stems.items()} if stems else None
        parts = [stems[s] for s in TUNING_STEMS if s in stems] if stems else []
        pitched = np.sum(parts, axis=0, dtype=np.float32) if parts else whole
        guitar = stems.get("guitar") if stems else None
        # The notes are heard in the guitar stem only, and only when it is not (almost) silent.
        if guitar is not None and float(np.sqrt(np.mean(np.square(guitar, dtype=np.float64)))) < 10 ** (-50 / 20):
            guitar = None
        beats, downbeats, raw, notes, device, peak = self._infer(whole, guitar, sr, progress)
        notes_missing = self.pitch_factory is not None and self._pitch is None

        beats = np.sort(np.asarray(beats, dtype=np.float64).ravel())
        beats = beats[(beats >= 0) & (beats <= duration)]
        downbeats = np.sort(np.asarray(downbeats, dtype=np.float64).ravel())
        downbeats = downbeats[(downbeats >= 0) & (downbeats <= duration)]
        chords = clean_chords(raw, beats, duration)
        if len(beats) < 4 and all(c["chord"] in NO_CHORD for c in chords):
            raise AnalysisError("analysis.noMusic")
        tempo, meter = tempo_and_meter(beats, downbeats)
        progress(0.9)

        bars = bar_spans(beats, downbeats, meter, duration)
        sections: list[dict] = []
        if bars:
            patterns = bar_patterns(bars, beats, chords)
            energy = bar_levels(whole, sr, bars)
            vocals = bar_levels(stems["vocals"], sr, bars) if stems and "vocals" in stems else None
            guitar = bar_levels(stems["guitar"], sr, bars) if stems and "guitar" in stems else None
            sections = find_sections(bars, patterns, energy, vocals, guitar)
        progress(0.95)
        tone = match_tone(stems["guitar"], sr) if stems and "guitar" in stems else None
        data = {
            "version": ANALYSIS_VERSION,
            "source": source,
            "beats": _seconds(beats),
            "downbeats": _seconds(downbeats),
            "tempo": float(tempo),
            "meter": int(meter),
            "chords": chords,
            "key": estimate_key(chords),
            "tuningCents": float(estimate_tuning_cents(pitched, sr)),
            "sections": sections,
            "tone": tone,
            "notes": [n for n in notes if n["end"] <= duration + 0.05],
            # The notes' model was not installed: made again once it is (library.analysis_needed).
            "notesMissing": notes_missing,
        }
        progress(1.0)
        return AnalysisResult(data, device, round(time.perf_counter() - started, 1), peak)


# ---- the real models


class BeatThisBackend:
    """Beat This! (CPJKU, ISMIR 2024, MIT): the final0 checkpoint, loaded from service/.models by
    path, so it never goes online. No DBN: the plain peak picking is what the paper recommends."""

    def __init__(self, models_dir: Path):
        if not weight_ready("beat_this", models_dir):
            raise _missing("beat_this")
        self.path = weight_path("beat_this", models_dir)
        self._model = None

    def load(self, device: str) -> None:
        try:
            from beat_this.inference import Audio2Beats
        except ImportError as error:
            raise _no_packages() from error

        self._model = Audio2Beats(checkpoint_path=str(self.path), device=device, float16=False, dbn=False)

    def beats(self, mono_mix: np.ndarray, sr: int) -> tuple[np.ndarray, np.ndarray]:
        beats, downbeats = self._model(np.asarray(mono_mix, dtype=np.float32), sr)  # type: ignore[misc]
        return np.asarray(beats, dtype=np.float64), np.asarray(downbeats, dtype=np.float64)

    def unload(self) -> None:
        self._model = None


class BtcBackend:
    """BTC (ISMIR 2019, MIT), large vocabulary: the network code vendored in kv_service/btc."""

    def __init__(self, models_dir: Path):
        if not weight_ready("btc", models_dir):
            raise _missing("btc")
        self.path = weight_path("btc", models_dir)
        self._model = None

    def load(self, device: str) -> None:
        try:
            import librosa  # noqa: F401 - the CQT features need it

            from .btc.model import BtcChords
        except ImportError as error:
            raise _no_packages() from error

        # The model is small and runs window by window: on a Mac the CPU is faster than MPS.
        self._model = BtcChords.load(self.path, "cpu" if device == "mps" else device)

    def chords(self, mono_mix: np.ndarray, sr: int) -> list[dict]:
        return self._model.predict(np.asarray(mono_mix, dtype=np.float32), sr)  # type: ignore[union-attr]

    def unload(self) -> None:
        if self._model is not None:
            self._model.release()
        self._model = None


class CrepeBackend:
    """CREPE (torchcrepe, MIT): the pitch of the guitar stem every 10 ms. Its weights ship inside
    the package, so it never goes online."""

    RATE = 16_000
    HOP = 160  # 10 ms

    def __init__(self) -> None:
        self.device = "cpu"

    def load(self, device: str) -> None:
        try:
            import torchcrepe  # noqa: F401
        except ImportError as error:
            raise PitchUnavailable("program.filesMissing", model="notes") from error
        # CREPE's convolutions are slow on MPS: the CPU on a Mac.
        self.device = "cpu" if device == "mps" else device

    def pitch(self, mono: np.ndarray, sr: int) -> tuple[np.ndarray, np.ndarray, float]:
        import torch
        import torchcrepe

        from .lyrics import to_whisper_audio  # 16 kHz mono, numpy only

        audio = torch.from_numpy(to_whisper_audio(mono, sr))[None]
        pitch, periodicity = torchcrepe.predict(
            audio,
            self.RATE,
            hop_length=self.HOP,
            fmin=70.0,
            fmax=1400.0,
            model="full",
            batch_size=1024,
            device=self.device,
            return_periodicity=True,
        )
        periodicity = torchcrepe.filter.median(periodicity, 3)
        return pitch[0].cpu().numpy(), periodicity[0].cpu().numpy(), self.HOP / self.RATE

    def unload(self) -> None:
        pass


def default_analyzer(models_dir: Path) -> Analyzer:
    """The real models. Nothing heavy is imported until a job runs."""
    return Analyzer(lambda: BeatThisBackend(models_dir), lambda: BtcBackend(models_dir), pitch_factory=CrepeBackend)
