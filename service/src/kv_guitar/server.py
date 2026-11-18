"""The guitar engine's server: the `/guitar` WebSocket of the contract (kv_guitar.protocol).

This process never touches the sound: the card and the amp live in the audio process
(kv_guitar.core). Here:

- a pump thread reads the raw input out of the shared ring every 5 ms, packs it into frames of
  480 samples (and, while a browser records, what the card played, as output frames) and
  collects the audio process's news and, ten times a second, the stats;
- the event loop gives all that to the browsers, each through its own bounded queue: a browser
  that does not read loses its oldest frames and holds nobody else up;
- the lifecycle: the card opens on `open`, stays open while a browser that asked for it is still
  connected, and closes (with a fade) 2 s after the last one left or sent `close`.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import threading
import time
from collections import deque
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, WebSocket
from starlette.websockets import WebSocketDisconnect

from .config import Settings
from .core import FRAME, Core
from .protocol import (
    OUTPUT_MAGIC,
    encode_frame,
    need_asset_message,
    parse_client_message,
    state_message,
    stats_message,
)

log = logging.getLogger("kv_guitar")

# The card closes this long after the last browser that wanted it has gone.
IDLE_AFTER_S = 2.0
# A browser that does not read keeps at most this many frames (half a second); older ones go.
MAX_QUEUED_FRAMES = 50
# Output frames are a recording: a browser busy for a moment must not lose them (4 s — more than
# the engine's ring holds, so all of it fits when the pump itself catches up after standing still).
MAX_QUEUED_OUTPUTS = 400
MAX_QUEUED_TEXTS = 256
PUMP_S = 0.005
STATS_S = 0.1
# Policy violation: a page that is not the app.
CLOSE_FOREIGN_ORIGIN = 1008

# The app's own pages: Vite on this machine, on any port (a second copy runs on another one).
# The browser's Origin comes through Vite's proxy unchanged.
_LOCAL_ORIGIN = re.compile(r"^http://(localhost|127\.0\.0\.1)(:\d{1,5})?$")


def origin_allowed(origin: str | None) -> bool:
    """Only the app may listen to the guitar and drive the engine: any other page open in the
    browser could reach 127.0.0.1 too. No Origin at all is a program, not a page (tests, Node).

    The installed app names its one page (KV_PAGE_ORIGINS, set by the Strum window): then a page
    another local program serves on some other port is refused too. In the author's copy any
    localhost port goes (Vite's port moves for checks)."""
    if origin is None:
        return True
    pages = [o.strip() for o in os.environ.get("KV_PAGE_ORIGINS", "").split(",") if o.strip()]
    if pages:
        return origin in pages
    return _LOCAL_ORIGIN.fullmatch(origin) is not None


class ClientQueue:
    """What one browser still has to get: texts in order, the newest stats, the newest frames."""

    def __init__(self, max_frames: int = MAX_QUEUED_FRAMES, max_outputs: int = MAX_QUEUED_OUTPUTS) -> None:
        self._max_frames = max_frames
        self._max_outputs = max_outputs
        self._texts: deque[str] = deque()
        self._stats: str | None = None
        self._frames: deque[bytes] = deque()
        self._outputs: deque[bytes] = deque()
        self._output_next = False
        self._wake = asyncio.Event()
        #: Frames thrown away because the browser was not reading.
        self.dropped = 0

    @property
    def frames(self) -> int:
        return len(self._frames)

    def push_text(self, text: str) -> None:
        if len(self._texts) >= MAX_QUEUED_TEXTS:
            self._texts.popleft()
        self._texts.append(text)
        self._wake.set()

    def set_stats(self, text: str) -> None:
        self._stats = text
        self._wake.set()

    def push_frame(self, frame: bytes, recording: bool = False) -> None:
        """An input frame. While the browser records they are the take's dry track: kept as long as
        the output frames (the browser's own queue drops a backlog, so the tuner never lags)."""
        if len(self._frames) >= (self._max_outputs if recording else self._max_frames):
            self._frames.popleft()
            self.dropped += 1
        self._frames.append(frame)
        self._wake.set()

    def push_output(self, frame: bytes) -> None:
        if len(self._outputs) >= self._max_outputs:
            self._outputs.popleft()
            self.dropped += 1
        self._outputs.append(frame)
        self._wake.set()

    def take(self) -> str | bytes | None:
        if self._texts:
            return self._texts.popleft()
        if self._stats is not None:
            text, self._stats = self._stats, None
            return text
        # Input and output frames take turns: neither waits behind the other.
        self._output_next = not self._output_next
        first, second = (self._outputs, self._frames) if self._output_next else (self._frames, self._outputs)
        if first:
            return first.popleft()
        if second:
            return second.popleft()
        return None

    async def wait(self) -> None:
        self._wake.clear()
        if not (self._texts or self._stats is not None or self._frames or self._outputs):
            await self._wake.wait()


class Client:
    def __init__(self, socket: WebSocket) -> None:
        self.socket = socket
        self.queue = ClientQueue()
        #: Sent `open` and no `close` since: gets the frames, and keeps the card open.
        self.wants = False
        #: Sent `record` on: gets the output frames too («Запись»).
        self.recording = False


class Hub:
    """The browsers and the one engine they share. Everything here runs on the event loop,
    except `_pump`."""

    def __init__(self, core: Core) -> None:
        self.core = core
        self.clients: set[Client] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._idle_timer: asyncio.TimerHandle | None = None
        # The last `open` passed on to the engine.
        self._asked: tuple[str | None, int] | None = None
        # Some browser records: the pump reads the output ring too. Written on the loop, read by the pump.
        self._recording = False

    # --- start and stop ----------------------------------------------------------------------------

    def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        self.core.start()
        self._thread = threading.Thread(target=self._pump, name="kv-guitar-pump", daemon=True)
        self._thread.start()

    async def stop(self) -> None:
        self._stop.set()
        if self._idle_timer is not None:
            self._idle_timer.cancel()
        thread = self._thread
        if thread is not None:
            await asyncio.to_thread(thread.join, 2.0)
        # Fades out and closes the card; takes a moment.
        await asyncio.to_thread(self.core.shutdown)

    # --- the pump thread -----------------------------------------------------------------------------

    def _pump(self) -> None:
        core = self.core
        loop = self._loop
        assert loop is not None
        next_stats = time.monotonic()
        while not self._stop.is_set():
            try:
                frames: list[bytes] = []
                outputs: list[bytes] = []
                recording = self._recording
                while len(frames) < 64:
                    if recording:
                        both = core.read_both(FRAME)
                        if both is None:
                            break
                        frames.append(encode_frame(both[0], both[1]))
                        outputs.append(encode_frame(both[0], both[2], OUTPUT_MAGIC))
                    else:
                        piece = core.read_input(FRAME)
                        if piece is None:
                            break
                        frames.append(encode_frame(piece[0], piece[1]))
                events = core.poll()
                stats = None
                now = time.monotonic()
                if now >= next_stats:
                    next_stats = next_stats + STATS_S if now - next_stats < 1.0 else now + STATS_S
                    if core.state()["status"] == "running":
                        stats = stats_message(**core.stats())
                if frames or events or stats:
                    loop.call_soon_threadsafe(self._deliver, frames, outputs, events, stats)
            except RuntimeError:
                return  # the loop is closed: the server is stopping
            except Exception:  # noqa: BLE001 — the pump must outlive one bad turn
                log.exception("kv_guitar pump")
            time.sleep(PUMP_S)

    def _deliver(self, frames: list[bytes], outputs: list[bytes], events: list[dict], stats: str | None) -> None:
        for event in events:
            if event["ev"] == "state":
                self.broadcast_state()
            elif event["ev"] == "need-asset":
                text = need_asset_message(event["id"])
                for client in self.clients:
                    client.queue.push_text(text)
        for client in self.clients:
            if not client.wants:
                continue
            for frame in frames:
                client.queue.push_frame(frame, client.recording)
            if client.recording:
                for frame in outputs:
                    client.queue.push_output(frame)
            if stats is not None:
                client.queue.set_stats(stats)

    # --- the browsers --------------------------------------------------------------------------------

    def state_text(self) -> str:
        return state_message(**self.core.state())

    def broadcast_state(self) -> None:
        text = self.state_text()
        for client in self.clients:
            client.queue.push_text(text)

    def add(self, socket: WebSocket) -> Client:
        client = Client(socket)
        self.clients.add(client)
        client.queue.push_text(self.state_text())
        return client

    def remove(self, client: Client) -> None:
        self.clients.discard(client)
        client.wants = False
        client.recording = False
        self._recording = any(c.recording for c in self.clients)
        self._check_idle()

    def handle(self, client: Client, message: dict) -> None:
        kind = message["type"]
        core = self.core
        if kind == "hello":
            client.queue.push_text(self.state_text())
        elif kind == "open":
            client.wants = True
            self._cancel_idle()
            asked = (message["device"], message["buffer"])
            state = core.state()
            same_card = asked[0] is None or asked[0] == state["device"]
            # `_asked is None`: the card is being closed (the idle timer fired, the audio process
            # has not said `idle` yet) — it has to be opened again, not taken for playing.
            if self._asked is not None and state["status"] == "running" and state["buffer"] == asked[1] and same_card:
                # It already plays what was asked for. The count of dropouts still starts again.
                core.reset_stats()
                client.queue.push_text(self.state_text())
            elif state["status"] == "starting" and core.alive and self._asked == asked:
                client.queue.push_text(self.state_text())  # the same card is being opened right now
            else:
                self._asked = asked
                core.open(*asked)
                self.broadcast_state()
        elif kind == "close":
            client.wants = False
            self._check_idle()
        elif kind == "record":
            client.recording = bool(message["on"])
            self._recording = any(c.recording for c in self.clients)
        else:
            # preset, master, channel, asset: the audio process's business.
            core.send(message)

    def _cancel_idle(self) -> None:
        if self._idle_timer is not None:
            self._idle_timer.cancel()
            self._idle_timer = None

    def _check_idle(self) -> None:
        if any(client.wants for client in self.clients) or self._idle_timer is not None:
            return
        if self.core.state()["status"] not in ("running", "starting"):
            return
        assert self._loop is not None
        self._idle_timer = self._loop.call_later(IDLE_AFTER_S, self._go_idle)

    def _go_idle(self) -> None:
        self._idle_timer = None
        if any(client.wants for client in self.clients):
            return
        if self.core.state()["status"] in ("running", "starting"):
            self._asked = None
            self.core.close()

    async def send_loop(self, client: Client) -> None:
        """One browser's sender: only this task waits when that browser is slow."""
        queue = client.queue
        socket = client.socket
        while True:
            item = queue.take()
            if item is None:
                await queue.wait()
            elif isinstance(item, str):
                await socket.send_text(item)
            else:
                await socket.send_bytes(item)

    def health(self) -> dict:
        core = self.core
        return {
            "state": core.state(),
            "audio": {"alive": core.alive, "pid": core.pid, "starts": core.starts, "model": core.model},
            "counters": core.counters(),
            "stats": core.stats(),
            "clients": [
                {
                    "wants": client.wants,
                    "recording": client.recording,
                    "queued": client.queue.frames,
                    "dropped": client.queue.dropped,
                }
                for client in self.clients
            ],
        }


def create_app(settings: Settings, core: Core | None = None) -> FastAPI:
    hub = Hub(core if core is not None else Core(settings))

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        hub.start()
        try:
            yield
        finally:
            await hub.stop()

    app = FastAPI(title="Strum: guitar engine", lifespan=lifespan)
    app.state.hub = hub

    @app.get("/health")
    def health() -> dict:
        return hub.health()

    @app.websocket("/guitar")
    async def guitar(socket: WebSocket) -> None:
        await socket.accept()
        if not origin_allowed(socket.headers.get("origin")):
            log.debug("refused a page that is not the app: %s", socket.headers.get("origin"))
            await socket.close(CLOSE_FOREIGN_ORIGIN)
            return
        client = hub.add(socket)
        sender = asyncio.create_task(hub.send_loop(client))
        try:
            while True:
                message = await socket.receive()
                if message["type"] == "websocket.disconnect":
                    break
                text = message.get("text")
                parsed = parse_client_message(text) if isinstance(text, str) else None
                if parsed is None:
                    log.debug("refused a message: %.200s", text if isinstance(text, str) else "<binary>")
                    continue
                hub.handle(client, parsed)
        except (WebSocketDisconnect, RuntimeError, OSError):
            pass
        finally:
            sender.cancel()
            with suppress(asyncio.CancelledError, Exception):
                await sender
            hub.remove(client)

    return app
