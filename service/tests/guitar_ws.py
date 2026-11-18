"""Test helpers for the guitar engine: a real engine in its own processes, and a small
WebSocket client over a plain socket (what a browser does, nothing more)."""

from __future__ import annotations

import base64
import hashlib
import contextlib
import json
import os
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path


HOST = "127.0.0.1"

# --- WebSocket framing (RFC 6455), the little a test client needs: its own code, so the engine's
# server (uvicorn + websockets) is checked against something that is not the same library ---

OP_CONTINUATION = 0x0
OP_TEXT = 0x1
OP_BINARY = 0x2
OP_CLOSE = 0x8
OP_PING = 0x9
OP_PONG = 0xA

_GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class ProtocolError(Exception):
    """The peer broke the protocol; `code` is the close code to answer with."""

    def __init__(self, code: int, reason: str) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason


def accept_key(key: bytes) -> bytes:
    """Sec-WebSocket-Accept for a Sec-WebSocket-Key."""
    return base64.b64encode(hashlib.sha1(key.strip() + _GUID).digest())  # noqa: S324 — the RFC's handshake


def encode_frame(opcode: int, payload: bytes, mask: bytes | None = None) -> bytes:
    """One unfragmented frame; a client masks what it sends."""
    size = len(payload)
    first = 0x80 | opcode
    masked = 0x80 if mask is not None else 0
    if size < 126:
        head = struct.pack("!BB", first, masked | size)
    elif size < 1 << 16:
        head = struct.pack("!BBH", first, masked | 126, size)
    else:
        head = struct.pack("!BBQ", first, masked | 127, size)
    if mask is None:
        return head + payload
    return head + mask + apply_mask(payload, mask)


def apply_mask(data: bytes, mask: bytes) -> bytes:
    """XOR with the 4-byte mask, as two big integers: a megabyte takes about a millisecond."""
    size = len(data)
    if not size:
        return b""
    key = (mask * (size // 4 + 1))[:size]
    return (int.from_bytes(data, "big") ^ int.from_bytes(key, "big")).to_bytes(size, "big")


def close_payload(code: int, reason: str = "") -> bytes:
    return struct.pack("!H", code) + reason.encode("utf-8")[:120]


class FrameParser:
    """Bytes from a client in, whole messages out: (opcode, payload) with the opcode of a text,
    binary, close, ping or pong."""

    def __init__(self, max_size: int = 16 * 1024 * 1024, need_mask: bool = True) -> None:
        self._buffer = bytearray()
        self._max_size = max_size
        self._need_mask = need_mask
        self._parts: list[bytes] = []
        self._parts_size = 0
        self._opcode = 0

    def feed(self, data: bytes) -> list[tuple[int, bytes]]:
        self._buffer += data
        found: list[tuple[int, bytes]] = []
        while True:
            frame = self._next_frame()
            if frame is None:
                return found
            fin, opcode, payload = frame
            if opcode >= 0x8:
                if not fin or len(payload) > 125:
                    raise ProtocolError(1002, "bad control frame")
                if opcode not in (OP_CLOSE, OP_PING, OP_PONG):
                    raise ProtocolError(1002, "unknown opcode")
                found.append((opcode, payload))
                continue
            if opcode == OP_CONTINUATION:
                if not self._opcode:
                    raise ProtocolError(1002, "nothing to continue")
            elif opcode in (OP_TEXT, OP_BINARY):
                if self._opcode:
                    raise ProtocolError(1002, "message inside a message")
                self._opcode = opcode
            else:
                raise ProtocolError(1002, "unknown opcode")
            self._parts.append(payload)
            self._parts_size += len(payload)
            if self._parts_size > self._max_size:
                raise ProtocolError(1009, "message too big")
            if fin:
                found.append((self._opcode, b"".join(self._parts)))
                self._parts = []
                self._parts_size = 0
                self._opcode = 0

    def _next_frame(self) -> tuple[bool, int, bytes] | None:
        buffer = self._buffer
        if len(buffer) < 2:
            return None
        first, second = buffer[0], buffer[1]
        if first & 0x70:
            raise ProtocolError(1002, "reserved bits")
        masked = bool(second & 0x80)
        if self._need_mask and not masked:
            raise ProtocolError(1002, "client frames must be masked")
        size = second & 0x7F
        at = 2
        if size == 126:
            if len(buffer) < 4:
                return None
            size = struct.unpack_from("!H", buffer, 2)[0]
            at = 4
        elif size == 127:
            if len(buffer) < 10:
                return None
            size = struct.unpack_from("!Q", buffer, 2)[0]
            at = 10
        if size > self._max_size:
            raise ProtocolError(1009, "message too big")
        end = at + (4 if masked else 0) + size
        if len(buffer) < end:
            return None
        if masked:
            payload = apply_mask(bytes(buffer[at + 4 : end]), bytes(buffer[at : at + 4]))
        else:
            payload = bytes(buffer[at:end])
        del buffer[:end]
        return bool(first & 0x80), first & 0x0F, payload


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind((HOST, 0))
        return probe.getsockname()[1]


def pid_alive(pid: int) -> bool:
    if sys.platform == "win32":
        import ctypes

        kernel = ctypes.windll.kernel32
        handle = kernel.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        code = ctypes.c_ulong()
        kernel.GetExitCodeProcess(handle, ctypes.byref(code))
        kernel.CloseHandle(handle)
        return code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def health(port: int) -> dict:
    with urllib.request.urlopen(f"http://{HOST}:{port}/health", timeout=5) as response:
        return json.loads(response.read().decode("utf-8"))


class Engine:
    """`python -m kv_guitar` with a fake card, on a free port."""

    def __init__(self, tmp_path: Path, fake: str = "saw", env: dict | None = None) -> None:
        self.port = free_port()
        self.log_path = tmp_path / "engine.log"
        self._log = open(self.log_path, "wb")  # noqa: SIM115 — closed in stop()
        full_env = {
            **os.environ,
            "KV_GUITAR_PORT": str(self.port),
            "PYTHONUTF8": "1",
            "PYTHONUNBUFFERED": "1",
            **(env or {}),
        }
        if fake:
            full_env["KV_GUITAR_FAKE"] = fake
        else:
            full_env.pop("KV_GUITAR_FAKE", None)
        self.process = subprocess.Popen(  # noqa: S603
            [sys.executable, "-m", "kv_guitar"], env=full_env, stdout=self._log, stderr=subprocess.STDOUT
        )
        deadline = time.monotonic() + 30
        while True:
            try:
                health(self.port)
                break
            except OSError:
                if self.process.poll() is not None or time.monotonic() > deadline:
                    self.stop()
                    raise RuntimeError(f"the engine did not start:\n{self.log()}") from None
                time.sleep(0.1)

    def health(self) -> dict:
        return health(self.port)

    def log(self) -> str:
        if not self._log.closed:
            self._log.flush()
        return self.log_path.read_text(encoding="utf-8", errors="replace")

    def connect(self, **options) -> "WsClient":
        return WsClient(self.port, **options)

    def stop(self) -> None:
        if self.process.poll() is None:
            self.process.kill()
            self.process.wait(10)
        self._log.close()


class WsClient:
    """A browser's side of `/guitar`. `read=False`: connected, but never reads (a stuck tab)."""

    def __init__(self, port: int, origin: str | None = None, read: bool = True, hello: bool = True) -> None:
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        if not read:
            # A small buffer, so that the server feels at once that nobody reads.
            self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 8192)
        self.sock.settimeout(10)
        self.sock.connect((HOST, port))
        key = base64.b64encode(os.urandom(16))
        lines = [
            b"GET /guitar HTTP/1.1",
            b"Host: " + f"{HOST}:{port}".encode(),
            b"Upgrade: websocket",
            b"Connection: Upgrade",
            b"Sec-WebSocket-Key: " + key,
            b"Sec-WebSocket-Version: 13",
        ]
        if origin is not None:
            lines.append(b"Origin: " + origin.encode())
        self.sock.sendall(b"\r\n".join(lines) + b"\r\n\r\n")
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(1)
            if not chunk:
                raise ConnectionError(f"no handshake: {head!r}")
            head += chunk
        self.status = int(head.split(b" ", 2)[1])
        if self.status != 101:
            raise ConnectionError(f"HTTP {self.status}")
        assert accept_key(key) in head
        self.sock.settimeout(None)

        self._cond = threading.Condition()
        self.messages: list[dict] = []
        self._cursor = 0
        #: (frame0, frames, time.monotonic() when it arrived)
        self.frames: list[tuple[int, int, float]] = []
        #: Output frames («Запись»): (frame0, frames, time.monotonic() when it arrived)
        self.outputs: list[tuple[int, int, float]] = []
        self.pongs: list[bytes] = []
        self.close_code: int | None = None
        self.closed = False
        self._send_lock = threading.Lock()
        self._reader: threading.Thread | None = None
        if read:
            self._reader = threading.Thread(target=self._read, daemon=True)
            self._reader.start()
        if hello:
            self.send({"type": "hello", "protocol": 1})

    # --- sending ---

    def send_raw(self, opcode: int, payload: bytes, fin: bool = True) -> None:
        frame = bytearray(encode_frame(opcode, payload, mask=os.urandom(4)))
        if not fin:
            frame[0] &= 0x7F
        with self._send_lock:
            self.sock.sendall(bytes(frame))

    def send(self, message: dict) -> None:
        self.send_raw(OP_TEXT, json.dumps(message, ensure_ascii=False).encode("utf-8"))

    # --- receiving ---

    def _read(self) -> None:
        parser = FrameParser(need_mask=False)
        try:
            while True:
                data = self.sock.recv(65536)
                if not data:
                    break
                now = time.monotonic()
                for opcode, payload in parser.feed(data):
                    with self._cond:
                        if opcode == OP_TEXT:
                            self.messages.append(json.loads(payload.decode("utf-8")))
                        elif opcode == OP_BINARY:
                            magic, count, frame0 = struct.unpack_from("<4sId", payload)
                            assert magic in (b"KVG1", b"KVO1") and len(payload) == 16 + count * 8
                            (self.frames if magic == b"KVG1" else self.outputs).append((int(frame0), count, now))
                        elif opcode == OP_PONG:
                            self.pongs.append(payload)
                        elif opcode == OP_CLOSE:
                            self.close_code = struct.unpack("!H", payload[:2])[0] if len(payload) >= 2 else 1005
                        self._cond.notify_all()
        except OSError:
            pass
        finally:
            with self._cond:
                self.closed = True
                self._cond.notify_all()

    def wait_for(self, predicate, timeout: float = 15.0, what: str = "a message") -> dict:
        """The next message (after the ones already returned) that `predicate` accepts."""
        deadline = time.monotonic() + timeout
        with self._cond:
            while True:
                while self._cursor < len(self.messages):
                    message = self.messages[self._cursor]
                    self._cursor += 1
                    if predicate(message):
                        return message
                left = deadline - time.monotonic()
                if left <= 0 or self.closed:
                    raise AssertionError(f"no {what} in {timeout} s; got {self.messages[-5:]}")
                self._cond.wait(left)

    def skip(self) -> None:
        """Forget what has arrived: the next wait is for something new."""
        with self._cond:
            self._cursor = len(self.messages)

    def wait_state(self, status: str | None = None, timeout: float = 15.0, **fields) -> dict:
        def fits(message: dict) -> bool:
            if message.get("type") != "state":
                return False
            if status is not None and message["status"] != status:
                return False
            return all(message.get(key) == value for key, value in fields.items())

        return self.wait_for(fits, timeout, f"state {status or ''} {fields or ''}")

    def wait_stats(self, predicate=lambda stats: True, timeout: float = 10.0) -> dict:
        return self.wait_for(lambda m: m.get("type") == "stats" and predicate(m), timeout, "stats")

    def wait_until(self, condition, timeout: float = 10.0) -> bool:
        deadline = time.monotonic() + timeout
        with self._cond:
            while not condition():
                left = deadline - time.monotonic()
                if left <= 0:
                    return False
                self._cond.wait(min(left, 0.1))
        return True

    def frames_since(self, since: float) -> list[tuple[int, int, float]]:
        with self._cond:
            return [frame for frame in self.frames if frame[2] >= since]

    def close(self) -> None:
        with contextlib.suppress(OSError):
            self.send_raw(OP_CLOSE, struct.pack("!H", 1000))
        if self._reader is not None:
            self._reader.join(2.0)
        with contextlib.suppress(OSError):
            self.sock.close()

    def drop(self) -> None:
        """The tab is gone without a goodbye."""
        with contextlib.suppress(OSError):
            self.sock.close()


__all__ = ["Engine", "WsClient", "free_port", "health", "pid_alive", "OP_PING", "OP_PONG", "OP_TEXT", "OP_BINARY"]
