"""The NAM amp engine of the browser app, run under wasmtime.

The same `nam-engine.wasm` the AudioWorklet uses (package neural-amp-modeler-wasm), after one
translation at setup time: Emscripten built it with the legacy exception instructions, which
wasmtime does not have, so `scripts/setup-tones.mjs` writes `nam-engine.exnref.wasm`.

The host side mirrors the Emscripten glue in `public/nam/nam-worklet.js`: eight imports in module
`a` and the minified export names below.
"""

from __future__ import annotations

import struct
import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import wasmtime

from kv_service.messages import UserError

PAGE = 65536
# getHeapMax() of the glue.
HEAP_MAX = 536870912
# WASI errno values the glue answers with.
ERRNO_BADF = 52
ERRNO_SPIPE = 70

# getEnvStrings() of the glue, outside a browser.
ENV_STRINGS = (
    "USER=web_user",
    "LOGNAME=web_user",
    "PATH=/",
    "PWD=/",
    "HOME=/home/web_user",
    "LANG=C.UTF-8",
    "_=./this.program",
)

# The engine's file is missing or broken: a message's code (the words are the app's).
MISSING_ENGINE = "program.filesMissing"


class EngineMissing(UserError, RuntimeError):
    """The engine's wasm file is not there or cannot be compiled."""


# The compiled engine by file (path, time, size): compiling takes 0.1 s, a new amp on top of
# a compiled module a millisecond. Engine and Module may be shared between stores and threads.
_modules: dict[tuple[str, int, int], tuple[wasmtime.Engine, wasmtime.Module]] = {}
_modules_lock = threading.Lock()


def _compiled(wasm_path: Path) -> tuple[wasmtime.Engine, wasmtime.Module]:
    stat = wasm_path.stat()
    key = (str(wasm_path), stat.st_mtime_ns, stat.st_size)
    with _modules_lock:
        found = _modules.get(key)
        if found is None:
            config = wasmtime.Config()
            config.wasm_exceptions = True
            engine = wasmtime.Engine(config)
            try:
                found = (engine, wasmtime.Module(engine, wasm_path.read_bytes()))
            except wasmtime.WasmtimeError as error:
                raise EngineMissing(MISSING_ENGINE, file=wasm_path.name) from error
            _modules.clear()
            _modules[key] = found
    return found


@dataclass(frozen=True)
class ModelInfo:
    slimmable: bool
    # The model's own loudness in dB, None when the file does not say.
    loudness: float | None
    expected_sample_rate: float


class NamWasm:
    """One NAM instance: load a model, then `process` blocks in place."""

    def __init__(self, wasm_path: Path, sample_rate: int, max_frames: int) -> None:
        wasm_path = Path(wasm_path)
        if not wasm_path.is_file():
            raise EngineMissing(MISSING_ENGINE, file=wasm_path.name)
        engine, module = _compiled(wasm_path)
        self._store = wasmtime.Store(engine)

        self.max_frames = int(max_frames)
        self.sample_rate = int(sample_rate)
        self._memory: wasmtime.Memory | None = None
        self._view: np.ndarray | None = None
        self._has_model = False
        # What the engine printed (stdout, stderr), for error messages.
        self._printed: list[str] = []
        self._line = {1: bytearray(), 2: bytearray()}

        hosts = {
            "a": self._fd_write,
            "b": self._environ_get,
            "c": self._environ_sizes_get,
            "d": lambda caller, fd: ERRNO_BADF,
            "e": lambda caller, fd, iov, iovcnt, pnum: ERRNO_BADF,
            "f": lambda caller, fd, offset, whence, new_offset: ERRNO_SPIPE,
            "g": self._resize_heap,
            "h": self._abort,
        }
        imports = []
        for item in module.imports:
            if item.module != "a" or item.name not in hosts:
                raise RuntimeError(f"the amp engine asks for an unknown function {item.module}.{item.name}")
            imports.append(wasmtime.Func(self._store, item.type, hosts[item.name], access_caller=True))
        exports = wasmtime.Instance(self._store, module, imports).exports(self._store)

        self._memory = exports["i"]
        self._create = exports["k"]
        self._destroy = exports["l"]
        self._load = exports["m"]
        self._unload = exports["n"]
        self._has = exports["o"]
        self._get_buffer = exports["p"]
        self._process = exports["q"]
        self._is_slimmable = exports["r"]
        self._set_slim = exports["s"]
        self._has_loudness = exports["v"]
        self._get_loudness = exports["w"]
        self._expected_rate = exports["x"]
        self._last_error = exports["y"]
        self._free = exports["A"]
        self._malloc = exports["B"]

        exports["j"](self._store)  # the C++ runtime's static constructors, once
        self._id = self._create(self._store, float(sample_rate), self.max_frames)
        if self._id <= 0:
            raise RuntimeError("the amp engine made no amp")
        self._buffer_ptr = self._get_buffer(self._store, self._id)

    # --- the public surface -------------------------------------------------------------------

    @property
    def has_model(self) -> bool:
        return self._has_model

    def load_model(self, json_text: str, slim_size: float = -1.0) -> ModelInfo:
        """Loads a .nam file's text. `slim_size` < 0 keeps the full model of a slimmable capture."""
        data = json_text.encode("utf-8") + b"\0"
        store = self._store
        ptr = self._malloc(store, len(data))
        if not ptr:
            raise RuntimeError("the amp engine ran out of memory for the model")
        try:
            self._memory.write(store, data, ptr)
            ok = self._load(store, self._id, ptr, float(slim_size))
        finally:
            self._free(store, ptr)
            # Loading may have grown the memory: the pointer stays, the view does not.
            self._view = None
        if not ok:
            self._has_model = bool(self._has(store, self._id))
            raise RuntimeError(self._c_string(self._last_error(store)) or "the model did not load")
        self._has_model = True
        return ModelInfo(
            slimmable=self._is_slimmable(store, self._id) == 1,
            loudness=float(self._get_loudness(store, self._id)) if self._has_loudness(store, self._id) == 1 else None,
            expected_sample_rate=float(self._expected_rate(store, self._id)),
        )

    def set_slim_size(self, slim_size: float) -> None:
        self._set_slim(self._store, self._id, float(slim_size))
        self._view = None

    def unload(self) -> None:
        self._unload(self._store, self._id)
        self._has_model = False

    def process(self, buf: np.ndarray) -> None:
        """Runs the amp over `buf` (float32, at most `max_frames`) in place.

        Without a model the block is left as it is, like the worklet's pass-through.
        """
        frames = len(buf)
        if frames > self.max_frames:
            raise ValueError(f"block of {frames} frames, the engine was made for {self.max_frames}")
        if not self._has_model:
            return
        view = self._view
        if view is None:
            view = self._derive_view()
        view[:frames] = buf
        self._process(self._store, self._id, frames)
        # nam_process never allocates, so the view is still valid here.
        buf[:] = view[:frames]

    def close(self) -> None:
        """Lets the amp and its whole engine go. It must not be playing: its memory is given back.

        The store is closed by hand. Left to Python it is never freed: the store's functions hold
        this object, and wasmtime holds them for as long as the store lives — so every amp ever
        loaded kept its 64 MB (measured 2026-11-16: 2.9 GB after ten openings of the card)."""
        if self._id > 0:
            self._has_model = False
            self._view = None
            try:
                self._destroy(self._store, self._id)
            finally:
                self._id = 0
                self._store.close()

    # --- helpers ------------------------------------------------------------------------------

    def _derive_view(self) -> np.ndarray:
        raw = self._memory.get_buffer_ptr(self._store, self.max_frames * 4, self._buffer_ptr)
        self._view = np.frombuffer(raw, dtype=np.float32)
        return self._view

    def _c_string(self, ptr: int) -> str:
        if not ptr:
            return ""
        size = self._memory.data_len(self._store)
        out = bytearray()
        while ptr < size:
            chunk = bytes(self._memory.read(self._store, ptr, min(size, ptr + 256)))
            end = chunk.find(b"\0")
            if end >= 0:
                out += chunk[:end]
                break
            out += chunk
            ptr += len(chunk)
        return out.decode("utf-8", errors="replace")

    def _u32(self, caller: wasmtime.Caller, ptr: int) -> int:
        return struct.unpack("<I", bytes(self._memory.read(caller, ptr, ptr + 4)))[0]

    def _put_u32(self, caller: wasmtime.Caller, ptr: int, value: int) -> None:
        self._memory.write(caller, struct.pack("<I", value), ptr)

    # --- the imports (module "a") ---------------------------------------------------------------
    # They run while wasm is on the stack, so they get the memory from the caller: during
    # instantiation `self._memory` is not known yet.

    def _mem(self, caller: wasmtime.Caller) -> wasmtime.Memory:
        if self._memory is None:
            self._memory = caller["i"]
        return self._memory

    def _fd_write(self, caller: wasmtime.Caller, fd: int, iov: int, iovcnt: int, pnum: int) -> int:
        memory = self._mem(caller)
        written = 0
        line = self._line.setdefault(fd, bytearray())
        for _ in range(iovcnt):
            ptr = self._u32(caller, iov)
            length = self._u32(caller, iov + 4)
            iov += 8
            line += bytes(memory.read(caller, ptr, ptr + length))
            written += length
        while b"\n" in line:
            text, _, rest = bytes(line).partition(b"\n")
            self._printed.append(text.decode("utf-8", errors="replace"))
            del line[:]
            line += rest
        del self._printed[:-50]
        self._put_u32(caller, pnum, written)
        return 0

    def _environ_get(self, caller: wasmtime.Caller, environ: int, environ_buf: int) -> int:
        memory = self._mem(caller)
        offset = 0
        for index, text in enumerate(ENV_STRINGS):
            data = text.encode("utf-8") + b"\0"
            self._put_u32(caller, environ + index * 4, environ_buf + offset)
            memory.write(caller, data, environ_buf + offset)
            offset += len(data)
        return 0

    def _environ_sizes_get(self, caller: wasmtime.Caller, pcount: int, psize: int) -> int:
        self._mem(caller)
        self._put_u32(caller, pcount, len(ENV_STRINGS))
        self._put_u32(caller, psize, sum(len(text.encode("utf-8")) + 1 for text in ENV_STRINGS))
        return 0

    def _resize_heap(self, caller: wasmtime.Caller, requested: int) -> int:
        """emscripten_resize_heap: grow with the glue's 20 % headroom, then less, then exactly."""
        memory = self._mem(caller)
        requested &= 0xFFFFFFFF
        if requested > HEAP_MAX:
            return 0
        old = memory.data_len(caller)
        self._view = None
        for cut_down in (1, 2, 4):
            over_grown = min(old * (1 + 0.2 / cut_down), requested + 100663296)
            new_size = min(HEAP_MAX, -(-int(max(requested, over_grown)) // PAGE) * PAGE)
            pages = (new_size - old + PAGE - 1) // PAGE
            try:
                memory.grow(caller, pages)
                return 1
            except wasmtime.WasmtimeError:
                continue
        return 0

    def _abort(self, caller: wasmtime.Caller) -> None:
        tail = "; ".join(self._printed[-3:])
        raise RuntimeError(f"the amp engine stopped{': ' + tail if tail else ''}")
