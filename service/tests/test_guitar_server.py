"""The guitar engine as the browser meets it: `python -m kv_guitar` with a fake card
(KV_GUITAR_FAKE=saw), spoken to over a real WebSocket. Three processes: this test, the engine's
server, the engine's audio process."""

import asyncio
import base64
import time

import pytest

from guitar_presets import default_presets
from guitar_ws import OP_PING, OP_TEXT, Engine, WsClient, pid_alive
from kv_guitar.assets import nam_wasm_path, repo_root
from kv_guitar.fake import FAKE_44100, FAKE_GOOD, FAKE_LOST
from kv_guitar.server import MAX_QUEUED_FRAMES, MAX_QUEUED_OUTPUTS, ClientQueue, origin_allowed

TONES = repo_root() / "public" / "tones"
PRESETS = default_presets()

pytestmark = pytest.mark.skipif(
    not (TONES / "models" / "jcm.nam").exists() or not nam_wasm_path().exists(),
    reason="public/tones or public/nam is missing: run npm run setup",
)

RATE_TEXT = {"code": "guitar.rate", "params": {}}
LOST_TEXT = {"code": "guitar.deviceLost", "params": {}}


@pytest.fixture
def engine(tmp_path):
    running = Engine(tmp_path)
    try:
        yield running
    finally:
        running.stop()
        print(running.log())  # shown by pytest when the test failed


def open_card(client: WsClient, device: str | None = None, buffer: int = 128, preset: str | None = "drive") -> dict:
    """What the browser's session sends: open, then the preset, the channel and the volume."""
    client.send({"type": "open", "device": device, "buffer": buffer})
    if preset is not None:
        client.send({"type": "preset", "preset": PRESETS[preset], "toneOffsets": None})
    client.send({"type": "channel", "choice": "right"})
    client.send({"type": "master", "db": 0, "muted": False})
    return client.wait_state("running")


def contiguous(frames: list[tuple[int, int, float]]) -> bool:
    return all(count == 480 for _, count, _ in frames) and all(
        later[0] - earlier[0] == 480 for earlier, later in zip(frames, frames[1:])
    )


# --- the brief's list ------------------------------------------------------------------------------


def test_hello_gets_state(engine):
    client = engine.connect(hello=False)
    client.send({"type": "hello", "protocol": 1})
    first = client.wait_for(lambda message: True, 5)
    assert first["type"] == "state"
    assert first["protocol"] == 1 and first["status"] == "idle"
    assert first["sampleRate"] == 48000 and first["error"] is None and first["amp"] == {"state": "idle"}
    # Once the audio process is up, the cards are listed.
    listed = client.wait_for(lambda m: m["type"] == "state" and m["devices"], 20)
    assert listed["devices"] == [FAKE_GOOD, FAKE_44100, FAKE_LOST]
    client.close()


def test_open_streams_frames(engine):
    client = engine.connect()
    state = open_card(client)
    assert state["device"] == FAKE_GOOD and state["buffer"] == 128 and state["sampleRate"] == 48000
    assert state["latencyMs"]["input"] > 0 and state["latencyMs"]["output"] > 0
    since = time.monotonic()
    time.sleep(1.0)
    frames = client.frames_since(since)
    assert len(frames) >= 50
    assert contiguous(frames)
    assert contiguous(client.frames_since(0)) and client.frames_since(0)[0][0] == 0  # from the stream's first sample
    client.close()


def test_record_gets_output_frames_beside_the_input(engine):
    client = engine.connect()
    open_card(client)
    time.sleep(0.3)
    assert client.outputs == []  # nobody records: no output frames
    client.send({"type": "record", "on": True})
    time.sleep(1.0)
    outputs = list(client.outputs)
    assert len(outputs) >= 50
    assert contiguous(outputs)
    inputs = {frame0 for frame0, _, _ in client.frames}
    assert all(frame0 in inputs for frame0, _, _ in outputs)  # the same clock as the input
    client.send({"type": "record", "on": False})
    time.sleep(0.2)
    stopped = len(client.outputs)
    time.sleep(0.3)
    assert len(client.outputs) == stopped
    client.close()


def test_preset_applies_and_reports_amp_ready(engine):
    client = engine.connect()
    client.send({"type": "open", "device": None, "buffer": 128})
    client.wait_state("running")
    client.send({"type": "preset", "preset": PRESETS["drive"], "toneOffsets": None})
    ready = client.wait_for(lambda m: m["type"] == "state" and m["amp"]["state"] == "ready", 10, "amp ready")
    assert ready["status"] == "running" and "message" not in ready["amp"]
    client.wait_stats(lambda stats: stats["outRmsDb"] > -60, 5)
    since = time.monotonic()
    count = len(client.messages)
    time.sleep(1.0)
    stats = [m for m in client.messages[count:] if m["type"] == "stats"]
    assert 7 <= len(stats) <= 13, f"{len(stats)} stats in {time.monotonic() - since:.2f} s"  # ~10 Hz
    last = stats[-1]
    assert last["budgetMs"] == pytest.approx(128 / 48000 * 1000)
    assert 0 < last["callbackMs"]["p50"] <= last["callbackMs"]["p99"]
    assert engine.health()["audio"]["model"] == "nam:jcm900"
    client.close()


def test_user_asset_roundtrip(engine):
    client = engine.connect()
    client.send({"type": "open", "device": None, "buffer": 128})
    client.wait_state("running")
    preset = {**PRESETS["drive"], "cab": "user:x"}
    client.send({"type": "preset", "preset": preset, "toneOffsets": None})
    asked = client.wait_for(lambda m: m["type"] == "need-asset", 5, "need-asset")
    assert asked == {"type": "need-asset", "id": "user:x"}
    data = base64.b64encode((TONES / "irs" / "mesa.wav").read_bytes()).decode("ascii")
    client.send({"type": "asset", "id": "user:x", "kind": "ir", "data": data})
    ready = client.wait_for(lambda m: m["type"] == "state" and m["amp"]["state"] == "ready", 10, "amp ready")
    assert ready["status"] == "running" and ready["error"] is None and "message" not in ready["amp"]
    time.sleep(0.5)  # a cabinet that failed to load would say so by now
    assert not [m for m in client.messages if m["type"] == "state" and "message" in m["amp"]]
    assert not [m for m in client.messages if m["type"] == "need-asset"][1:]  # asked once
    client.wait_stats(lambda stats: stats["outRmsDb"] > -60, 5)
    client.close()


def test_two_clients_one_leaves_keeps_sound(engine):
    first = engine.connect()
    second = engine.connect()
    open_card(first)
    second.send({"type": "open", "device": None, "buffer": 128})
    second.wait_state("running")
    assert second.wait_until(lambda: len(second.frames) > 10)
    first.close()
    time.sleep(2.5)  # longer than the idle time: one browser is still there
    since = time.monotonic()
    time.sleep(0.5)
    assert len(second.frames_since(since)) >= 30
    assert contiguous(second.frames)
    assert engine.health()["state"]["status"] == "running"
    left_at = time.monotonic()
    second.drop()  # no goodbye: the tab was closed
    time.sleep(1.2)
    assert engine.health()["state"]["status"] == "running"  # not before 2 s
    deadline = left_at + 4.0
    while engine.health()["state"]["status"] != "idle":
        assert time.monotonic() < deadline, "the card was not closed after the last browser left"
        time.sleep(0.05)
    assert time.monotonic() - left_at >= 1.9
    health = engine.health()
    assert health["state"]["device"] is None and health["clients"] == []
    callbacks = health["counters"]["callbacks"]
    time.sleep(0.3)
    assert engine.health()["counters"]["callbacks"] == callbacks  # the fake card is closed: nothing calls
    assert health["audio"]["alive"]


def test_close_from_every_client_goes_idle(engine):
    client = engine.connect()
    open_card(client)
    client.send({"type": "close"})
    idle = client.wait_state("idle", 5)
    assert idle["device"] is None
    since = time.monotonic()
    time.sleep(0.3)
    assert client.frames_since(since) == []
    open_card(client)  # and it opens again
    assert client.wait_until(lambda: len(client.frames_since(since)) > 10)
    client.close()


def test_slow_client_does_not_block(engine):
    good = engine.connect()
    open_card(good)
    stuck = engine.connect(read=False)
    stuck.send({"type": "open", "device": None, "buffer": 128})
    since = time.monotonic()
    worst_queue = 0
    while time.monotonic() - since < 3.0:
        health = engine.health()
        worst_queue = max([worst_queue] + [client["queued"] for client in health["clients"]])
        time.sleep(0.1)
    frames = good.frames_since(since)
    assert len(frames) >= 270  # 3 s of 10 ms frames
    assert contiguous(good.frames)
    gaps = [later[2] - earlier[2] for earlier, later in zip(frames, frames[1:])]
    assert max(gaps) < 0.15, f"a frame came {max(gaps) * 1000:.0f} ms after the one before"
    assert good.wait_stats()["xruns"] == 0
    health = engine.health()
    assert len(health["clients"]) == 2
    assert worst_queue <= MAX_QUEUED_FRAMES
    assert max(client["dropped"] for client in health["clients"]) > 0  # the stuck one lost its oldest frames
    assert min(client["dropped"] for client in health["clients"]) == 0
    stuck.drop()
    good.close()


def test_preset_storm_no_overruns(engine):
    client = engine.connect()
    open_card(client, preset="clean-chorus")
    client.wait_stats()
    names = ["drive", "clean-chorus", "solo"]
    for index in range(30):
        client.send({"type": "preset", "preset": PRESETS[names[index % 3]], "toneOffsets": None})
        time.sleep(1 / 30)
    last = PRESETS[names[29 % 3]]
    # The engine takes the presets one after another (about 40 ms each: the amp is run on silence
    # before it plays), so it is still at them when the last one is sent — and passes the last
    # one's amp every third preset on its way. It has arrived when that amp stays for a second.
    deadline = time.monotonic() + 15
    since = None
    while since is None or time.monotonic() - since < 1.0:
        assert time.monotonic() < deadline, "the last preset's model is not the one playing"
        if engine.health()["audio"]["model"] != last["amp"]["model"]:
            since = None
        elif since is None:
            since = time.monotonic()
        time.sleep(0.05)
    client.skip()
    stats = client.wait_stats()
    assert stats["xruns"] == 0
    health = engine.health()
    assert health["counters"]["late"] == 0 and health["counters"]["flags"] == 0
    assert health["state"]["amp_state"] == "ready" and health["audio"]["model"] == last["amp"]["model"]
    assert contiguous(client.frames)
    client.close()


def test_wrong_rate_reports_its_message(engine):
    client = engine.connect()
    client.send({"type": "open", "device": FAKE_44100, "buffer": 128})
    error = client.wait_state("error")
    assert error["error"] == RATE_TEXT
    assert error["latencyMs"] is None
    assert client.frames == []
    client.close()


def test_device_lost_reports_error(engine):
    client = engine.connect()
    client.send({"type": "open", "device": FAKE_LOST, "buffer": 128})
    client.wait_state("running")
    error = client.wait_state("error", 5)
    assert error["status"] == "error" and error["error"] == LOST_TEXT
    frames_before = len(client.frames)
    state = open_card(client)  # a later `open` recovers
    assert state["device"] == FAKE_GOOD and state["error"] is None
    assert client.wait_until(lambda: len(client.frames) > frames_before + 20)
    client.close()


def test_foreign_origin_rejected(engine):
    for origin in ("https://evil.example", "http://evil.example:5173", "http://localhost.evil.example", "null",
                   "https://localhost:5173", "http://127.0.0.1.evil.example"):  # fmt: skip
        page = WsClient(engine.port, origin=origin)
        assert page.wait_until(lambda: page.closed or page.close_code is not None, 5), origin
        assert page.close_code == 1008, origin
        assert page.messages == [] and page.frames == [], origin  # not even the state
        page.drop()
    assert engine.health()["clients"] == []
    for origin in ("http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:5193", "http://localhost", None):
        app = WsClient(engine.port, origin=origin)
        assert app.wait_state()["status"] == "idle", origin
        app.close()


def test_origin_rule():
    assert origin_allowed(None)
    assert origin_allowed("http://localhost:5173") and origin_allowed("http://127.0.0.1:65535")
    for origin in ("", "null", "http://localhost:5173/", "http://localhost:5173.evil.example", "http://LOCALHOST.evil",
                   "file://", "http://[::1]:5173", "http://localhost:5173\nx", "http://localhost:5173\n"):  # fmt: skip
        assert not origin_allowed(origin), origin


# --- around it -------------------------------------------------------------------------------------


def test_bad_messages_are_ignored(engine):
    client = engine.connect()
    client.wait_state()
    client.send({"type": "open", "device": None, "buffer": 100})  # not a buffer of the contract
    client.send({"type": "nonsense"})
    client.send_raw(OP_TEXT, b"not json")
    client.send_raw(0x2, b"\x00\x01")  # the browser never sends binary
    time.sleep(0.3)
    assert engine.health()["state"]["status"] == "idle"
    open_card(client)  # the connection is still good
    client.close()


def test_websocket_ping_fragments_and_big_messages(engine):
    client = engine.connect(hello=False)
    client.wait_state()
    client.send_raw(OP_PING, b"are you there")
    assert client.wait_until(lambda: client.pongs == [b"are you there"], 5)
    # A message in three pieces.
    text = b'{"type":"hello","protocol":1}'
    count = len(client.messages)
    client.send_raw(OP_TEXT, text[:5], fin=False)
    client.send_raw(0x0, text[5:20], fin=False)
    client.send_raw(0x0, text[20:])
    assert client.wait_until(lambda: len(client.messages) > count, 5)
    assert client.messages[-1]["type"] == "state"
    client.close()
    assert client.wait_until(lambda: client.close_code == 1000, 5)


def test_audio_process_dies_then_open_starts_a_new_one(engine):
    import subprocess
    import sys

    client = engine.connect()
    open_card(client)
    pid = engine.health()["audio"]["pid"]
    if sys.platform == "win32":
        subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True, check=True)  # noqa: S603, S607
    else:
        import os
        import signal

        os.kill(pid, signal.SIGKILL)
    error = client.wait_state("error", 5)
    assert error["error"] == {"code": "guitar.processDied", "params": {}}
    state = open_card(client)
    assert state["device"] == FAKE_GOOD
    health = engine.health()
    assert health["audio"]["pid"] != pid and health["audio"]["starts"] == 2
    since = time.monotonic()
    assert client.wait_until(lambda: len(client.frames_since(since)) > 20)
    client.close()


def test_audio_process_leaves_when_the_server_is_killed(tmp_path):
    engine = Engine(tmp_path)
    try:
        client = engine.connect()
        open_card(client)
        pid = engine.health()["audio"]["pid"]
        assert pid_alive(pid)
    finally:
        engine.stop()  # a hard kill: nobody tells the audio process
    deadline = time.monotonic() + 5
    while pid_alive(pid):
        assert time.monotonic() < deadline, "the audio process outlived its server (it would keep the card)"
        time.sleep(0.05)


def test_second_engine_on_the_same_port_steps_aside(engine, tmp_path):
    import os
    import subprocess
    import sys

    env = {**os.environ, "KV_GUITAR_PORT": str(engine.port), "KV_GUITAR_FAKE": "saw", "PYTHONUTF8": "1"}
    again = subprocess.run([sys.executable, "-m", "kv_guitar"], env=env, capture_output=True, timeout=30)  # noqa: S603
    assert again.returncode == 0
    assert "занят" in again.stdout.decode("utf-8")


def test_open_right_after_the_idle_timer_fired_reopens_the_card():
    """«Браузер» and back to «Быстрый» two seconds later: the idle timer has just sent `close`,
    the audio process has not said `idle` yet, and its last word is still `running`."""
    from kv_guitar.server import Client, Hub

    class StubCore:
        alive = True

        def __init__(self):
            self.calls = []
            self.status = "idle"

        def state(self):
            running = self.status == "running"
            return {
                "status": self.status, "devices": [FAKE_GOOD], "device": FAKE_GOOD if running else None,
                "sample_rate": 48000, "buffer": 128 if running else 0, "latency_ms": None,
                "amp_state": "idle", "amp_message": None, "error": None,
            }  # fmt: skip

        def open(self, device, buffer):
            self.calls.append(("open", device, buffer))
            self.status = "starting"

        def close(self):
            self.calls.append(("close",))  # the audio process takes its time: the state stays `running`

        def reset_stats(self):
            self.calls.append(("reset-stats",))

    async def scenario():
        core = StubCore()
        hub = Hub(core)
        hub._loop = asyncio.get_running_loop()
        tab = Client(None)
        hub.clients.add(tab)
        open_message = {"type": "open", "device": None, "buffer": 128}
        hub.handle(tab, open_message)
        core.status = "running"
        hub.handle(tab, open_message)  # the same again while it plays: nothing is reopened
        assert core.calls == [("open", None, 128), ("reset-stats",)]
        hub.handle(tab, {"type": "close"})
        assert hub._idle_timer is not None
        hub._idle_timer.cancel()
        hub._go_idle()  # two seconds later
        assert core.calls[-1] == ("close",) and core.state()["status"] == "running"
        hub.handle(tab, open_message)
        assert core.calls[-1] == ("open", None, 128), "the open was taken for «already plays»: the card closes under it"
        assert tab.wants and hub._idle_timer is None

    asyncio.run(scenario())


def test_close_then_open_two_seconds_later_keeps_playing(engine):
    """The same on the real engine, a few times around the moment the idle timer fires."""
    client = engine.connect()
    open_card(client)
    for wait in (1.95, 2.0, 2.05, 2.1):
        client.send({"type": "close"})
        time.sleep(wait)
        client.skip()
        client.send({"type": "open", "device": None, "buffer": 128})
        time.sleep(1.5)  # long enough for a wrongly kept close to have shut the card
        assert engine.health()["state"]["status"] == "running", f"closed under the browser ({wait} s)"
        since = time.monotonic()
        assert client.wait_until(lambda: len(client.frames_since(since)) > 10, 3), wait
    client.close()


# --- the small parts ---------------------------------------------------------------------------------


def test_client_queue_drops_the_oldest_frames():
    async def scenario():
        queue = ClientQueue()
        for index in range(80):
            queue.push_frame(bytes([index]))
        assert queue.frames == MAX_QUEUED_FRAMES == 50
        assert queue.dropped == 30
        queue.push_text("state 1")
        queue.set_stats("stats 1")
        queue.set_stats("stats 2")  # only the newest stats are worth sending
        queue.push_text("state 2")
        taken = []
        while (item := queue.take()) is not None:
            taken.append(item)
        assert taken[:3] == ["state 1", "state 2", "stats 2"]
        assert taken[3:] == [bytes([index]) for index in range(30, 80)]
        waiter = asyncio.ensure_future(queue.wait())
        await asyncio.sleep(0.01)
        assert not waiter.done()
        queue.push_frame(b"x")
        await asyncio.wait_for(waiter, 1)

    asyncio.run(scenario())


def test_while_recording_the_input_frames_are_kept_as_long_as_the_output_ones():
    """While a browser records, its input frames are the take's dry track: a browser busy for a
    moment must not lose them (16 Nov 2026: 0.86 s of the dry track lost, the guitar whole)."""
    queue = ClientQueue()
    for index in range(MAX_QUEUED_OUTPUTS + 30):
        queue.push_frame(index.to_bytes(2, "little"), recording=True)
        queue.push_output(index.to_bytes(2, "little"))
    assert queue.frames == MAX_QUEUED_OUTPUTS > MAX_QUEUED_FRAMES
    assert queue.dropped == 2 * 30  # the oldest of each, as many as were over
    # Recording over: the input frames go back to their short queue as the browser reads them.
    for _ in range(2 * MAX_QUEUED_OUTPUTS):
        queue.take()
    for index in range(80):
        queue.push_frame(bytes([index]))
    assert queue.frames == MAX_QUEUED_FRAMES


@pytest.mark.asio
def test_asio_device_opens(tmp_path):
    """The real M-Track at 128 for 2 s. The guitar input is heard in the headphones."""
    engine = Engine(tmp_path, fake="", env={"SD_ENABLE_ASIO": "1"})
    try:
        client = engine.connect()
        state = open_card(client)
        assert state["status"] == "running" and state["buffer"] == 128 and state["sampleRate"] == 48000
        assert "M-Track" in state["device"]
        assert state["latencyMs"]["input"] > 0 and state["latencyMs"]["output"] > 0
        since = time.monotonic()
        time.sleep(2.0)
        stats = client.wait_stats()
        frames = client.frames_since(since)
        print(f"M-Track: {state['latencyMs']}, stats {stats}, {len(frames)} frames in 2 s")
        assert stats["xruns"] == 0
        assert len(frames) >= 150 and contiguous(client.frames)
        assert engine.health()["state"]["status"] == "running"
        client.send({"type": "close"})
        client.wait_state("idle", 5)
        client.close()
    finally:
        engine.stop()
        print(engine.log())


def test_the_installed_app_names_its_one_page(monkeypatch):
    monkeypatch.setenv("KV_PAGE_ORIGINS", "http://127.0.0.1:50100")
    assert origin_allowed("http://127.0.0.1:50100")
    assert not origin_allowed("http://127.0.0.1:5173")
    assert not origin_allowed("http://localhost:50100")
    assert origin_allowed(None)  # a program, not a page
