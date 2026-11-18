"""Splitting a song into six stems with demucs htdemucs_6s or BS-RoFormer SW.

torch and the model packages are imported only inside the backends, so the service starts fast
and its tests run without them. Arrays at the backend boundary are float32 (2, frames); the
Separator converts from and to the library's (frames, 2).
"""

from __future__ import annotations

import gc
import time
from collections.abc import Callable
from contextlib import nullcontext
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Protocol

import numpy as np

from .messages import UserError, failure, message
from .models import MODELS, roformer_dir, weights_ready

Progress = Callable[[float], None]

SMALL_DEMUCS_SEGMENT = Fraction(4)  # seconds; the model's own is 7.8
ROFORMER_SMALL_CHUNK = 294_400  # samples; the model's own is 588 800 (13.35 s)


class Cancelled(Exception):
    """The job was cancelled: the song was deleted or its stems dropped."""


class SeparationError(UserError, RuntimeError):
    """A failure the user is told of: a code and its values."""


class Backend(Protocol):
    model_id: str

    def load(self, device: str) -> None: ...

    def separate(self, mix: np.ndarray, sr: int, progress: Progress, small: bool) -> dict[str, np.ndarray]: ...

    def unload(self) -> None: ...


class MemoryProbe(Protocol):
    def reset(self, device: str) -> None: ...

    def peak_mb(self, device: str) -> int | None: ...

    def release(self, device: str) -> None: ...


class TorchMemory:
    """Video memory bookkeeping on CUDA; nothing to do elsewhere."""

    def reset(self, device: str) -> None:
        if device == "cuda":
            import torch

            torch.cuda.reset_peak_memory_stats()

    def peak_mb(self, device: str) -> int | None:
        if device != "cuda":
            return None
        import torch

        return int(torch.cuda.max_memory_reserved() // 2**20)

    def release(self, device: str) -> None:
        gc.collect()
        if device == "cuda":
            import torch

            torch.cuda.empty_cache()


def detect_device() -> tuple[str, str | None]:
    """('cuda' | 'mps' | 'cpu', GPU name)."""
    try:
        import torch
    except ImportError:
        return "cpu", None
    if torch.cuda.is_available():
        return "cuda", torch.cuda.get_device_name(0)
    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_available():
        return "mps", "Apple GPU"
    return "cpu", None


def is_out_of_memory(error: BaseException) -> bool:
    return type(error).__name__ == "OutOfMemoryError" or "out of memory" in str(error).lower()


def _missing(model_id: str) -> SeparationError:
    """The model's weights are not there: the program's files are incomplete."""
    return SeparationError("program.filesMissing", model=MODELS[model_id].id)


@dataclass
class SeparationResult:
    stems: dict[str, np.ndarray]  # float32 (frames, 2)
    device: str
    seconds: float
    load_seconds: float
    peak_vram_mb: int | None
    note: dict | None  # a message: how the separation had to fall back


class Separator:
    """Runs one model at a time and falls back when the GPU cannot do it.

    GPU → GPU with smaller chunks (out of memory only) → CPU. A model stays loaded between jobs
    and is unloaded before another one loads.
    """

    def __init__(
        self,
        factories: dict[str, Callable[[], Backend]],
        device: str,
        gpu_name: str | None = None,
        memory: MemoryProbe | None = None,
    ):
        self.factories = factories
        self.device = device
        self.gpu_name = gpu_name
        self.memory = memory or TorchMemory()
        self._backend: Backend | None = None
        self._loaded: tuple[str, str] | None = None

    def _ensure(self, model_id: str, device: str) -> float:
        if self._loaded == (model_id, device):
            return 0.0
        self.unload()
        backend = self.factories[model_id]()
        started = time.perf_counter()
        backend.load(device)
        self._backend, self._loaded = backend, (model_id, device)
        return time.perf_counter() - started

    def unload(self) -> None:
        if self._backend is None or self._loaded is None:
            return
        device = self._loaded[1]
        self._backend.unload()
        self._backend = self._loaded = None
        self.memory.release(device)

    def run(self, model_id: str, mix: np.ndarray, sr: int, progress: Progress) -> SeparationResult:
        """mix: float32 (frames, 2). Raises Cancelled or SeparationError."""
        channels_first = np.ascontiguousarray(mix.T, dtype=np.float32)
        note = message("separation.cpuNoGpu") if self.device == "cpu" else None
        attempts = [(self.device, False)]
        last_error: BaseException | None = None
        while attempts:
            device, small = attempts.pop(0)
            try:
                load_seconds = self._ensure(model_id, device)
                self.memory.reset(device)
                started = time.perf_counter()
                stems = self._backend.separate(channels_first, sr, progress, small)  # type: ignore[union-attr]
                seconds = time.perf_counter() - started
                return SeparationResult(
                    stems={name: np.ascontiguousarray(data.T, dtype=np.float32) for name, data in stems.items()},
                    device=device,
                    seconds=round(seconds, 1),
                    load_seconds=round(load_seconds, 1),
                    peak_vram_mb=self.memory.peak_mb(device),
                    note=note,
                )
            except (Cancelled, SeparationError):
                raise
            except Exception as error:  # noqa: BLE001 - every GPU failure gets the CPU fallback
                last_error = error
                self.unload()
                if device == "cpu":
                    break
                if is_out_of_memory(error) and not small:
                    note = message("separation.smallerChunks")
                    attempts = [(device, True), ("cpu", False)]
                elif is_out_of_memory(error):
                    note = message("separation.cpuNoVram")
                    attempts = [("cpu", False)]
                else:
                    note = message("separation.cpuGpuFailed")
                    attempts = [("cpu", False)]
        last = failure("separation.failed", last_error or RuntimeError())
        raise SeparationError(last["code"], **last["params"])


class DemucsBackend:
    """demucs 4.1 htdemucs_6s from the HuggingFace cache in service/.models (offline)."""

    model_id = "htdemucs_6s"

    def __init__(self, models_dir: Path):
        self.models_dir = models_dir
        self._bag = None
        self._segments: list = []
        self._device = "cpu"

    def load(self, device: str) -> None:
        if not weights_ready(self.model_id, self.models_dir):
            raise _missing(self.model_id)
        # HuggingFace only: demucs' fallback to its old AWS repository would go online.
        from demucs.hf import get_hf_model

        self._bag = get_hf_model(self.model_id)
        self._bag.eval()
        self._segments = [m.segment for m in self._bag.models]
        self._device = device

    def separate(self, mix: np.ndarray, sr: int, progress: Progress, small: bool) -> dict[str, np.ndarray]:
        import torch
        from demucs.apply import apply_model

        bag = self._bag
        # HTDemucs pads every chunk to model.segment, so a smaller chunk only saves memory when
        # the model's own segment is lowered too.
        for model, own in zip(bag.models, self._segments):
            model.segment = min(own, SMALL_DEMUCS_SEGMENT) if small else own
        wav = torch.from_numpy(mix)  # stays on the CPU: the long output is kept in RAM, not VRAM
        frames = wav.shape[1]
        ref = wav.mean(0)
        mean, std = ref.mean(), ref.std() + 1e-8

        def callback(info: dict) -> None:
            progress((info["model_idx_in_bag"] + min(1.0, info["segment_offset"] / frames)) / info["models"])

        out = apply_model(
            bag,
            ((wav - mean) / std)[None],
            shifts=1,
            split=True,
            overlap=0.25,
            progress=False,
            device=self._device,
            num_workers=0,
            callback=callback,
        )
        out = out * std + mean
        progress(1.0)
        return {name: out[0, k].numpy() for k, name in enumerate(bag.sources)}

    def unload(self) -> None:
        if self._bag is not None:
            self._bag.cpu()
        self._bag = None


class RoformerBackend:
    """BS-RoFormer SW (bs-roformer-infer, pinned commit). Weights in service/.models/bs-roformer."""

    model_id = "bs_roformer_sw"

    def __init__(self, models_dir: Path):
        self.models_dir = models_dir
        self._session = None
        self._device = None

    def load(self, device: str) -> None:
        if not weights_ready(self.model_id, self.models_dir):
            raise _missing(self.model_id)
        from bs_roformer import BSRoformerSession

        info = MODELS[self.model_id]
        session = BSRoformerSession(
            model_name=info.slug, models_dir=str(roformer_dir(self.models_dir)), device=device, progress=False
        )
        self._session = session.load()
        self._device = session.device

    def separate(self, mix: np.ndarray, sr: int, progress: Progress, small: bool) -> dict[str, np.ndarray]:
        """Overlap-add over chunks, after bs_roformer.utils.demix_track (MIT), with progress and cancel.

        Differences: the long accumulators live in RAM (one shared 1-D weight), not in VRAM, and
        `progress` is called before every chunk.
        """
        import torch
        import torch.nn.functional as F

        session = self._session
        model, config = session._model, session._config  # noqa: SLF001 - pinned package version
        chunk = ROFORMER_SMALL_CHUNK if small else int(config.inference.chunk_size)
        step = chunk // int(config.inference.num_overlap)
        fade = chunk // 10
        border = chunk - step
        instruments = list(config.training.instruments)

        x = torch.from_numpy(mix)
        frames = x.shape[1]
        padded = frames > 2 * border and border > 0
        if padded:
            x = F.pad(x, (border, border), mode="reflect")
        total = x.shape[1]

        window = torch.ones(chunk)
        window[:fade] = torch.linspace(0, 1, fade)
        window[-fade:] *= torch.linspace(1, 0, fade)
        result = np.zeros((len(instruments), 2, total), dtype=np.float32)
        weight = np.zeros(total, dtype=np.float32)

        device = torch.device(self._device)
        autocast = torch.autocast(device_type="cuda") if device.type == "cuda" else nullcontext()
        with torch.no_grad(), autocast:
            start = 0
            while start < total:
                progress(start / total)
                part = x[:, start : start + chunk]
                length = part.shape[-1]
                if length < chunk:
                    mode = "reflect" if length > chunk // 2 + 1 else "constant"
                    part = F.pad(part, (0, chunk - length), mode=mode)
                out = model(part[None].to(device))[0].float().cpu().numpy()
                w = window.clone()
                if start == 0:
                    w[:fade] = 1
                if start + chunk >= total:
                    w[-fade:] = 1
                w = w[:length].numpy()
                result[..., start : start + length] += out[..., :length] * w
                weight[start : start + length] += w
                start += step
        estimates = result / np.maximum(weight, 1e-8)
        np.nan_to_num(estimates, copy=False)
        if padded:
            estimates = estimates[..., border:-border]
        progress(1.0)
        return {name: np.ascontiguousarray(estimates[k]) for k, name in enumerate(instruments)}

    def unload(self) -> None:
        if self._session is not None:
            self._session.release()
        self._session = None


def default_separator(models_dir: Path) -> Separator:
    device, gpu_name = detect_device()
    return Separator(
        {
            DemucsBackend.model_id: lambda: DemucsBackend(models_dir),
            RoformerBackend.model_id: lambda: RoformerBackend(models_dir),
        },
        device=device,
        gpu_name=gpu_name,
    )
