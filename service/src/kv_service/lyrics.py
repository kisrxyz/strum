"""The words of the vocal stem: Whisper large-v3 through faster-whisper (CTranslate2).

The result is the song's words.json (mirrored by `Transcript` in src/song/types.ts): every heard
word with its start and end, and Whisper's own lines. The app uses it two ways: as a draft of the
lyrics when the user has none, and to put pasted lyrics in time (the alignment is app-side).

As with the other models: the package is imported only inside the backend, the model stays loaded
between songs, and a GPU failure is retried with a lighter compute type, then on the CPU.
CTranslate2's GPU build needs CUDA 12's cuBLAS while our PyTorch brings CUDA 13, so on Windows the
DLL folders of the `nvidia-cublas-cu12` wheel are put on the search path before it loads.
"""

from __future__ import annotations

import gc
import os
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import numpy as np

from .messages import UserError, reason_of
from .models import whisper_dir, whisper_ready
from .separation import Cancelled, detect_device

# 2: holes in what was heard are listened to again (`_fill_gaps`).
TRANSCRIPT_VERSION = 2
MODEL_NAME = "large-v3"
WHISPER_RATE = 16_000
# Quieter than this (RMS, dBFS) the vocal stem is taken for silence: an instrumental song.
SILENCE_DB = -50.0
# Whisper sometimes skips a whole sung part of a long song (on «Кайен» once a minute with the
# second chorus; the same part alone was heard well). A hole this long between heard words where
# the vocal stem is this loud is listened to again on its own, in the language already found.
GAP_SECONDS = 12.0
SINGING_DB = -38.0
# …in at least this share of its half-second frames (the hole's edges hold the ends of sung words).
SUNG_SHARE = 0.3
Progress = Callable[[float], None]


class TranscribeError(UserError, RuntimeError):
    """A failure the user is told of: a code and its values."""


class WhisperBackend(Protocol):
    def load(self, device: str, compute_type: str) -> None: ...

    def transcribe(
        self, audio: np.ndarray, progress: Progress, language: str | None = None
    ) -> tuple[str, list[dict], list[dict]]:
        """16 kHz mono float32 → (language, words {start, end, word, p}, lines {start, end, text}).
        `language` None: found by the model."""
        ...

    def unload(self) -> None: ...


@dataclass
class TranscriptResult:
    data: dict  # words.json
    device: str
    seconds: float


def to_whisper_audio(x: np.ndarray, sr: int) -> np.ndarray:
    """Mono float32 at 16 kHz (band-limited resampling through the FFT, numpy only)."""
    x = np.asarray(x, dtype=np.float32)
    if x.ndim == 2:
        x = x.mean(axis=1, dtype=np.float32)
    if sr == WHISPER_RATE or len(x) == 0:
        return x.astype(np.float32, copy=False)
    frames = int(round(len(x) * WHISPER_RATE / sr))
    spectrum = np.fft.rfft(x)[: frames // 2 + 1]
    return (np.fft.irfft(spectrum, frames) * (frames / len(x))).astype(np.float32)


def _rms_db(x: np.ndarray) -> float:
    if len(x) == 0:
        return -120.0
    rms = float(np.sqrt(np.mean(np.square(x, dtype=np.float64))))
    return 20 * np.log10(rms) if rms > 0 else -120.0


def _clean_words(words: list[dict], duration: float) -> list[dict]:
    out = []
    for w in words:
        text = str(w.get("word", "")).strip()
        if not text:
            continue
        start = min(max(float(w["start"]), 0.0), duration)
        end = min(max(float(w["end"]), start), duration)
        out.append({"start": round(start, 3), "end": round(end, 3), "word": text, "p": round(float(w.get("p", 0)), 3)})
    return sorted(out, key=lambda w: (w["start"], w["end"]))


def _clean_lines(lines: list[dict], duration: float) -> list[dict]:
    out = []
    for line in lines:
        text = str(line.get("text", "")).strip()
        if not text:
            continue
        start = min(max(float(line["start"]), 0.0), duration)
        end = min(max(float(line["end"]), start), duration)
        out.append({"start": round(start, 3), "end": round(end, 3), "text": text})
    return sorted(out, key=lambda line: line["start"])


def gaps(words: list[dict], duration: float, min_gap: float = GAP_SECONDS) -> list[tuple[float, float]]:
    """Stretches without heard words longer than `min_gap` (before the first, between, after the last)."""
    edges = [0.0] + [t for w in sorted(words, key=lambda w: w["start"]) for t in (w["start"], w["end"])] + [duration]
    out = []
    for i in range(0, len(edges) - 1, 2):
        start, end = edges[i], edges[i + 1]
        if end - start > min_gap:
            out.append((start, end))
    return out


def sung_share(audio: np.ndarray) -> float:
    """Share of the half-second frames of 16 kHz audio where the vocal stem is loud."""
    frame = WHISPER_RATE // 2
    count = len(audio) // frame
    if not count:
        return 0.0
    frames = audio[: count * frame].reshape(count, frame).astype(np.float64)
    rms = np.sqrt(np.mean(frames**2, axis=1))
    return float(np.mean(rms >= 10 ** (SINGING_DB / 20)))


def _fill_gaps(
    backend: WhisperBackend, audio: np.ndarray, language: str, words: list[dict], lines: list[dict], progress: Progress
) -> tuple[list[dict], list[dict]]:
    """Listens again to the holes where the vocal stem is loud; adds what is heard inside them."""
    duration = len(audio) / WHISPER_RATE
    holes = [g for g in gaps(words, duration) if sung_share(audio[int(g[0] * WHISPER_RATE) : int(g[1] * WHISPER_RATE)]) >= SUNG_SHARE]
    words, lines = list(words), list(lines)
    for k, (start, end) in enumerate(holes):
        progress(k / len(holes))
        _, more_words, more_lines = backend.transcribe(
            audio[int(start * WHISPER_RATE) : int(end * WHISPER_RATE)], lambda _f: None, language or None
        )
        inside = lambda t: start + 0.1 <= t <= end - 0.1  # noqa: E731 - a one-line filter
        words += [{**w, "start": w["start"] + start, "end": w["end"] + start} for w in more_words if inside(w["start"] + start)]
        lines += [{**l, "start": l["start"] + start, "end": l["end"] + start} for l in more_lines if inside(l["start"] + start)]
    progress(1.0)
    return words, lines


def _attempts_for(device: str) -> list[tuple[str, str]]:
    """(device, compute type) to try in turn. CTranslate2 has no Apple GPU backend: the CPU there."""
    if device == "cuda":
        return [("cuda", "float16"), ("cuda", "int8_float16"), ("cpu", "int8")]
    return [("cpu", "int8")]


class Transcriber:
    """Runs Whisper on a vocal stem. `device` None means "find it at the first job"."""

    def __init__(self, backend_factory: Callable[[], WhisperBackend], device: str | None = None):
        self.backend_factory = backend_factory
        self._device = device
        self._backend: WhisperBackend | None = None
        self._loaded: tuple[str, str] | None = None
        # A backend made but not loaded yet: making it checks the weights before torch is imported.
        self._spare: WhisperBackend | None = None

    @property
    def device(self) -> str:
        if self._device is None:
            self._device = detect_device()[0]
        return self._device

    def _ensure(self, device: str, compute_type: str) -> WhisperBackend:
        if self._backend is not None and self._loaded == (device, compute_type):
            return self._backend
        self.unload()
        backend = self._spare or self.backend_factory()  # may raise TranscribeError (weights missing)
        self._spare = None
        try:
            backend.load(device, compute_type)
        except BaseException:
            try:
                backend.unload()
            except Exception:  # noqa: BLE001 - the load error is the one to report
                pass
            raise
        self._backend, self._loaded = backend, (device, compute_type)
        return backend

    def unload(self) -> None:
        if self._backend is not None:
            self._backend.unload()
        self._backend = self._loaded = None
        gc.collect()

    def run(self, vocals: np.ndarray, sr: int, source: str, progress: Progress) -> TranscriptResult:
        """vocals: float32 (frames, 2) or (frames,). Raises Cancelled or TranscribeError."""
        started = time.perf_counter()
        progress(0.0)
        audio = to_whisper_audio(vocals, sr)
        duration = len(audio) / WHISPER_RATE
        language, words, lines, device = "", [], [], "cpu"
        if _rms_db(audio) >= SILENCE_DB:
            if self._backend is None and self._spare is None:
                self._spare = self.backend_factory()  # fails fast without the weights
            attempts = _attempts_for(self.device)
            while attempts:
                device, compute_type = attempts.pop(0)
                try:
                    backend = self._ensure(device, compute_type)
                    progress(0.05)
                    language, words, lines = backend.transcribe(audio, lambda f: progress(0.05 + 0.8 * f))
                    words, lines = _fill_gaps(backend, audio, language, words, lines, lambda f: progress(0.85 + 0.1 * f))
                    break
                except (Cancelled, TranscribeError):
                    raise
                except Exception as error:  # noqa: BLE001 - every GPU failure gets the next attempt
                    self.unload()
                    if not attempts:
                        raise TranscribeError("words.failed", reason=reason_of(error)) from error
        data = {
            "version": TRANSCRIPT_VERSION,
            "model": MODEL_NAME,
            "source": source,
            "language": language,
            "words": _clean_words(words, duration),
            "lines": _clean_lines(lines, duration),
        }
        progress(1.0)
        return TranscriptResult(data, device, round(time.perf_counter() - started, 1))


# ---- the real model

_dll_dirs: list[object] = []


def _add_cuda12_dlls() -> None:
    """Windows: lets CTranslate2 find cublas64_12.dll and friends from the nvidia-* wheels."""
    if sys.platform != "win32" or _dll_dirs:
        return
    for base in map(Path, sys.path):
        for package in ("cublas", "cuda_nvrtc"):
            folder = base / "nvidia" / package / "bin"
            if folder.is_dir():
                _dll_dirs.append(os.add_dll_directory(str(folder)))
                os.environ["PATH"] = str(folder) + os.pathsep + os.environ.get("PATH", "")


class FasterWhisperBackend:
    """Whisper large-v3 (OpenAI, MIT) in SYSTRAN's CTranslate2 conversion, loaded from
    service/.models by path, so it never goes online."""

    def __init__(self, models_dir: Path):
        if not whisper_ready(models_dir):
            raise TranscribeError("program.filesMissing", model="whisper")
        self.folder = whisper_dir(models_dir)
        self.model = None

    def load(self, device: str, compute_type: str) -> None:
        _add_cuda12_dlls()
        try:
            from faster_whisper import WhisperModel
        except ImportError as error:
            raise TranscribeError("program.filesMissing", model="whisper") from error
        self.model = WhisperModel(str(self.folder), device=device, compute_type=compute_type, local_files_only=True)

    def transcribe(
        self, audio: np.ndarray, progress: Progress, language: str | None = None
    ) -> tuple[str, list[dict], list[dict]]:
        assert self.model is not None
        duration = max(len(audio) / WHISPER_RATE, 1e-3)
        segments, info = self.model.transcribe(
            audio,
            language=language,
            word_timestamps=True,
            vad_filter=True,  # Silero VAD: skips the instrumental parts, where Whisper invents text
            condition_on_previous_text=False,  # a misheard line does not repeat itself
            beam_size=5,
            hallucination_silence_threshold=2.0,
        )
        words: list[dict] = []
        lines: list[dict] = []
        for segment in segments:  # a generator: the decoding happens while it is read
            progress(min(0.99, segment.end / duration))
            lines.append({"start": segment.start, "end": segment.end, "text": segment.text})
            for word in segment.words or []:
                words.append({"start": word.start, "end": word.end, "word": word.word, "p": word.probability})
        return info.language or "", words, lines

    def unload(self) -> None:
        self.model = None


def default_transcriber(models_dir: Path) -> Transcriber:
    return Transcriber(lambda: FasterWhisperBackend(models_dir))
