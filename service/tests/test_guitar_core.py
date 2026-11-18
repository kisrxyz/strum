"""The guitar engine's core (kv_guitar.core): the callback and its counters, the shared ring,
the fake card, and the audio process as the server drives it."""

import math
import time

import numpy as np
import pytest

from guitar_presets import default_presets, first_presets
from guitar_ws import pid_alive
from kv_guitar import config
from kv_guitar.assets import nam_wasm_path, repo_root
from kv_guitar.config import DEVICE_LOST, RATE_ERROR, Settings
from kv_service.messages import message
from kv_guitar.core import (
    FRAME,
    H_EPOCH,
    H_FLAGS,
    H_LATE,
    H_MAX_GAP_NS,
    H_WRITTEN,
    LISTEN_LAG_FRAMES,
    RING_FRAMES,
    AudioHost,
    Core,
    InputReader,
    Shared,
    pick_device,
)
from kv_guitar.fake import FAKE_44100, FAKE_GOOD, FAKE_LOST, FakeBackend, saw_loop
from kv_guitar.protocol import stats_message

SR = 48000
BLOCK = 128
TONES = repo_root() / "public" / "tones"
PRESETS = default_presets()

needs_tones = pytest.mark.skipif(
    not (TONES / "models" / "jcm.nam").exists() or not nam_wasm_path().exists(),
    reason="public/tones or public/nam is missing: run npm run setup",
)


def wait_for(condition, timeout: float = 10.0, step: float = 0.01):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = condition()
        if value:
            return value
        time.sleep(step)
    raise AssertionError("timed out")


HOSTS: list = []


@pytest.fixture
def shared():
    memory = Shared()
    yield memory
    # A test that failed half way may have left a card open: its thread must stop before the
    # memory it writes to goes away.
    for host in HOSTS:
        host._close_stream(fade=False)
    HOSTS.clear()
    memory.close()


class ManualStream:
    """A card whose callbacks the test makes itself."""

    latency = (0.006, 0.005)

    def __init__(self, in_channels: int = 2, out_channels: int = 2) -> None:
        self.in_channels = in_channels
        self.out_channels = out_channels
        self.active = False
        self.closed = False

    def start(self) -> None:
        self.active = True

    def close(self) -> None:
        self.active = False
        self.closed = True


class ManualBackend:
    def __init__(self, in_channels: int = 2, out_channels: int = 2) -> None:
        self.channels = (in_channels, out_channels)
        self.stream: ManualStream | None = None

    def refresh(self) -> None:
        pass

    def devices(self) -> list[str]:
        return ["M-Track Manual"]

    def open(self, name, block, sample_rate, callback):
        self.stream = ManualStream(*self.channels)
        return self.stream


class Clock:
    def __init__(self) -> None:
        self.now = 1_000_000_000

    def __call__(self) -> int:
        return self.now


def manual_host(shared, in_channels: int = 2, out_channels: int = 2):
    events: list[dict] = []
    clock = Clock()
    backend = ManualBackend(in_channels, out_channels)
    host = AudioHost(Settings(fake="saw"), shared, events.append, backend=backend, clock=clock)
    HOSTS.append(host)
    return host, events, clock, backend


LOOP = saw_loop(SR)


def guitar_block(index: int, channels: int = 2) -> np.ndarray:
    at = index * BLOCK % (len(LOOP) - BLOCK)
    return LOOP[at : at + BLOCK, 2 - channels :]


def play(host, clock, blocks: int, period_ns: int = int(BLOCK / SR * 1e9), status=None, channels=(2, 2), start: int = 0):
    """Runs the callback `blocks` times, one period apart. Returns the output, (frames, channels)."""
    out = np.zeros((BLOCK, channels[1]), dtype=np.float32)
    heard = []
    for index in range(blocks):
        clock.now += period_ns
        host.callback(guitar_block(start + index, channels[0]), out, BLOCK, None, status)
        heard.append(out.copy())
    return np.concatenate(heard)


# --- the pieces --------------------------------------------------------------------------------


def test_builtin_sounds_are_the_presets_of_the_app():
    """config.BUILTIN_SOUNDS is a copy: it must follow src/state/presets.ts."""
    from_app = {(p["amp"]["model"], p["amp"]["slim"], p["cab"], p["reverb"]["type"]) for p in PRESETS.values()}
    assert set(config.BUILTIN_SOUNDS) == from_app


def test_pick_device_follows_the_contract():
    names = ["Realtek ASIO", "M-Track Solo and Duo ASIO", "Other"]
    # Automatic: the first real card, not a driver that wraps the computer's own sound or a mixer.
    assert pick_device(names, None) == "M-Track Solo and Duo ASIO"
    assert pick_device(["ASIO4ALL v2", "FL Studio ASIO", "Voicemeeter AUX Virtual ASIO", "UMC ASIO Driver"], None) == "UMC ASIO Driver"
    assert pick_device(["FlexASIO", "Focusrite USB ASIO"], None) == "Focusrite USB ASIO"
    assert pick_device(["ASIO2WASAPI", "BandLab ASIO", "JackRouter", "Steinberg built-in ASIO Driver", "M-Track Solo and Duo ASIO"], None) == "M-Track Solo and Duo ASIO"
    # Only such drivers: the first of them still plays.
    assert pick_device(["Realtek ASIO", "ASIO4ALL v2"], None) == "Realtek ASIO"
    assert pick_device(names, "Other") == "Other"
    with pytest.raises(config.EngineError) as missing:
        pick_device(names, "Nope")
    assert missing.value.message == {"code": "guitar.deviceNotFound", "params": {"name": "Nope"}}
    with pytest.raises(config.EngineError, match="guitar.noDevices"):
        pick_device([], None)


def test_reader_gives_whole_pieces_in_order(shared):
    reader = InputReader(shared)
    assert reader.read(FRAME) is None
    ramp = np.arange(RING_FRAMES * 3, dtype=np.float32)
    written = 0

    def write(count: int) -> None:
        nonlocal written
        index = (written + np.arange(count)) % RING_FRAMES
        shared.ring[index, 0] = ramp[written : written + count]
        shared.ring[index, 1] = -ramp[written : written + count]
        written += count
        shared.ints[H_WRITTEN] = written

    write(479)
    assert reader.read(FRAME) is None
    write(1)
    frame0, piece = reader.read(FRAME)
    assert frame0 == 0 and piece.shape == (FRAME, 2) and piece.dtype == np.float32
    assert np.array_equal(piece[:, 0], ramp[:FRAME]) and np.array_equal(piece[:, 1], -ramp[:FRAME])
    assert reader.read(FRAME) is None
    # Across the ring's end, many times over.
    expected = FRAME
    for _ in range(200):
        write(FRAME)
        frame0, piece = reader.read(FRAME)
        assert frame0 == expected
        assert np.array_equal(piece[:, 0], ramp[expected : expected + FRAME])
        expected += FRAME


def test_reader_that_fell_behind_skips_to_fresh_input(shared):
    reader = InputReader(shared)
    shared.ints[H_WRITTEN] = RING_FRAMES * 2 + 100  # the server stood still for more than the ring holds
    frame0, _ = reader.read(FRAME)
    assert frame0 % FRAME == 0
    assert RING_FRAMES * 2 + 100 - frame0 <= 5 * FRAME  # close to now
    assert reader.skipped > 0


def test_a_recording_loses_nothing_while_the_ring_still_holds_it(shared):
    """«Запись» reads the output beside the input. The server standing still for two seconds (a busy
    laptop: 16 Nov 2026, a hole of 0.67 s in a take) must cost nothing: the ring holds 2.7 s. Only
    listening (the tuner, the meter) goes on from the newest sound after 0.68 s."""
    assert RING_FRAMES / 48000 > 2.5 and LISTEN_LAG_FRAMES / 48000 < 0.7
    behind = 2 * 48000 // FRAME * FRAME  # two seconds, in whole pieces
    ramp = np.arange(behind, dtype=np.float32)
    shared.ring[:behind, 0] = ramp
    shared.out_ring[:behind, 0] = -ramp
    shared.ints[H_WRITTEN] = behind

    recording = InputReader(shared)
    at = 0
    while (piece := recording.read_both(FRAME)) is not None:
        frame0, raw, played = piece
        assert frame0 == at
        assert np.array_equal(raw[:, 0], ramp[at : at + FRAME]) and np.array_equal(played[:, 0], -ramp[at : at + FRAME])
        at += FRAME
    assert at == behind and recording.skipped == 0

    listening = InputReader(shared)
    frame0, _ = listening.read(FRAME)
    assert behind - frame0 <= 5 * FRAME  # close to now
    assert listening.skipped > 0

    # More than the ring holds is gone for a recording too: it goes on from the newest.
    shared.ints[H_WRITTEN] = RING_FRAMES * 2 + 100
    late = InputReader(shared)
    frame0, _raw, _played = late.read_both(FRAME)
    assert RING_FRAMES * 2 + 100 - frame0 <= 5 * FRAME
    assert late.skipped > 0


def test_reader_starts_again_when_the_stream_reopens(shared):
    reader = InputReader(shared)
    shared.ints[H_WRITTEN] = FRAME * 3
    assert reader.read(FRAME)[0] == 0
    assert reader.read(FRAME)[0] == FRAME
    shared.ints[H_WRITTEN] = 0
    shared.ints[H_EPOCH] += 1
    assert reader.read(FRAME) is None
    shared.ints[H_WRITTEN] = FRAME
    assert reader.read(FRAME)[0] == 0


# --- the callback, by hand -----------------------------------------------------------------------


@needs_tones
def test_callback_writes_the_raw_input_and_plays(shared):
    host, events, clock, backend = manual_host(shared)
    host.handle({"type": "preset", "preset": PRESETS["drive"], "toneOffsets": None})
    host.handle({"type": "open", "device": None, "buffer": BLOCK})
    assert [e["status"] for e in events if e["ev"] == "state"] == ["starting", "running"]
    running = events[-1]
    assert running["device"] == "M-Track Manual" and running["buffer"] == BLOCK
    assert running["latency_ms"] == pytest.approx((6.0, 5.0))
    assert running["amp_state"] == "ready" and running["model"] == "nam:jcm900"
    assert host.chain.loads["model"] == 4  # the four built-in presets were loaded ahead (four models)

    heard = play(host, clock, 60)
    frame0, piece = InputReader(shared).read(FRAME)
    assert frame0 == 0
    assert np.array_equal(piece, np.concatenate([guitar_block(i) for i in range(4)])[:FRAME])  # raw, before the gate
    assert np.max(np.abs(heard[-BLOCK * 20 :])) > 0.01  # the amp plays
    # It fades in over 50 ms: no step at the first sample.
    assert abs(float(heard[0, 0])) < 0.01
    assert host.callback_errors == 0
    host.close()
    assert backend.stream.closed
    assert events[-1]["status"] == "idle" and events[-1]["device"] is None


@needs_tones
def test_callback_writes_what_it_plays_beside_the_input(shared):
    host, _events, clock, _backend = manual_host(shared)
    host.handle({"type": "preset", "preset": PRESETS["drive"], "toneOffsets": None})
    host.handle({"type": "open", "device": None, "buffer": BLOCK})
    heard = play(host, clock, 60)
    reader = InputReader(shared)
    at = 0
    while (piece := reader.read_both(FRAME)) is not None:
        frame0, raw, played = piece
        assert frame0 == at
        assert np.array_equal(raw, np.concatenate([guitar_block(i) for i in range(60)])[at : at + FRAME])
        assert np.array_equal(played, heard[at : at + FRAME])  # exactly what the card got
        at += FRAME
    assert at == (60 * BLOCK) // FRAME * FRAME
    assert np.max(np.abs(heard)) > 0.01
    host.close()


@needs_tones
def test_late_callbacks_and_driver_flags_count_as_xruns(shared):
    host, events, clock, _ = manual_host(shared)
    host.open(None, BLOCK)
    period = int(BLOCK / SR * 1e9)
    ints = shared.ints
    # Inside the first half second nothing counts: neither a late start nor the driver's flag.
    play(host, clock, 10)
    play(host, clock, 1, period_ns=4 * period)
    play(host, clock, 1, status="input overflow")
    assert ints[H_LATE] == 0 and ints[H_FLAGS] == 0
    play(host, clock, 200)  # 0.53 s more
    assert ints[H_LATE] == 0
    play(host, clock, 1, period_ns=int(1.4 * period))  # not late yet
    assert ints[H_LATE] == 0
    play(host, clock, 1, period_ns=int(3.6 * period))  # the probe's 9.6 ms gap
    assert ints[H_LATE] == 1
    assert ints[H_MAX_GAP_NS] == int(3.6 * period)
    play(host, clock, 1, status="output underflow")
    assert ints[H_FLAGS] == 1
    # Every `open` starts the count again — also one that changes nothing.
    host.handle({"type": "reset-stats"})
    assert ints[H_LATE] == 0 and ints[H_FLAGS] == 0
    play(host, clock, 1, period_ns=int(3.6 * period))
    assert ints[H_LATE] == 1
    host.open(None, BLOCK)
    assert ints[H_LATE] == 0 and ints[H_WRITTEN] == 0
    host.close()


def block_peaks(blocks: list) -> np.ndarray:
    return np.array([float(np.max(np.abs(block))) for block in blocks])


def assert_fades_out(peaks: np.ndarray) -> None:
    """The played blocks end in a ramp down of at least 50 ms and then silence: never a block
    of signal followed by a block of nothing."""
    assert peaks[-1] == 0.0, "the last block the card got was not silence"
    sounding = np.nonzero(peaks)[0]
    last = int(sounding[-1])
    before = float(np.median(peaks[max(0, last - 60) : last - 25]))  # the level before the fade began
    assert before > 0.02
    assert peaks[last] < 0.15 * before, f"the sound was cut at {peaks[last] / before:.0%} of its level"
    # A straight ramp over 50 ms is 18.75 blocks of 128: k blocks before the last sounding one
    # the level is about k / 18.75 of what it was (the guitar's own level moves a little).
    ratio = peaks / before
    assert 0.03 < ratio[last - 4] < 0.5
    assert 0.25 < ratio[last - 9] < 0.75
    assert 0.45 < ratio[last - 14] < 1.1
    assert ratio[last - 17] > 0.55  # 45 ms before the end it still sounds: not shorter than 50 ms
    assert ratio[last - 22] > 0.6  # and the fade had not begun yet
    # No cliff at the end: the last blocks before the silence are already quiet. (Block peaks of
    # a 110 Hz saw jump by themselves, so neighbours are not compared.)
    assert ratio[last - 1] < 0.25 and ratio[last - 2] < 0.3 and ratio[last - 5 : last + 1].max() < 0.5


# The fades are measured on the first drive preset (JCM800): its level on the fake saw is steady
# enough for block peaks; the fade itself does not depend on the amp.
STEADY = {**first_presets()["drive"], "reverb": {"on": False, "type": "plate", "mix": 0}}


@needs_tones
def test_close_fades_out_over_50_ms(shared):
    """The real `close()` on the fake card, with everything the card was given recorded."""
    host, events = fake_host(shared)
    host.handle({"type": "preset", "preset": STEADY, "toneOffsets": None})
    host.open(None, BLOCK)
    stream = host.backend.streams[-1]
    time.sleep(0.3)
    stream.heard = []
    time.sleep(0.25)
    started = time.monotonic()
    host.close()
    took = time.monotonic() - started
    assert stream.closed and events[-1]["status"] == "idle"
    assert host.callback_errors == 0 and host.callback_error is None  # nothing was swallowed in the callback
    assert_fades_out(block_peaks(stream.heard))
    assert 0.05 <= took < 0.2, f"close() took {took * 1000:.0f} ms"


@needs_tones
def test_reopen_with_another_buffer_fades_the_old_stream_out(shared):
    host, events = fake_host(shared)
    host.handle({"type": "preset", "preset": STEADY, "toneOffsets": None})
    host.open(None, BLOCK)
    old = host.backend.streams[-1]
    time.sleep(0.3)
    old.heard = []
    time.sleep(0.25)
    host.open(None, 256)
    assert old.closed and events[-1]["status"] == "running" and events[-1]["buffer"] == 256
    assert host.callback_errors == 0
    assert_fades_out(block_peaks(old.heard))
    time.sleep(0.2)
    host.close()
    assert host.callback_errors == 0


@needs_tones
def test_a_missing_user_file_keeps_the_card_silent_until_it_arrives(shared):
    host, events = fake_host(shared)
    host.handle({"type": "preset", "preset": {**STEADY, "cab": "user:x"}, "toneOffsets": None})
    host.open(None, BLOCK)
    stream = host.backend.streams[-1]
    stream.heard = []
    time.sleep(0.3)
    assert not block_peaks(stream.heard).any()  # not the chain's default sound
    host.handle({"type": "asset", "id": "user:x", "kind": "ir", "data": (TONES / "irs" / "mesa.wav").read_bytes()})
    stream.heard = []
    time.sleep(0.4)
    assert block_peaks(stream.heard).max() > 0.02
    host.close()
    assert host.callback_errors == 0


@needs_tones
def test_a_broken_callback_plays_silence_and_is_reported(shared):
    host, events, clock, backend = manual_host(shared)
    host.open(None, BLOCK)
    play(host, clock, 5)

    def boom(_inp, _out):
        raise RuntimeError("kaboom")

    host.chain.process = boom
    heard = play(host, clock, 3)  # does not raise
    assert not heard.any()
    assert host.callback_errors == 1  # caught once; after that it plays silence without trying
    host.tick()
    assert events[-1]["status"] == "error"
    assert events[-1]["error"] == {"code": "guitar.chainBroke", "params": {"reason": "kaboom"}}
    assert backend.stream.closed


@needs_tones
def test_one_input_channel_feeds_both_sides(shared):
    host, events, clock, _ = manual_host(shared, in_channels=1, out_channels=1)
    host.handle({"type": "channel", "choice": "left"})
    host.handle({"type": "preset", "preset": PRESETS["drive"], "toneOffsets": None})
    host.open(None, BLOCK)
    heard = play(host, clock, 60, channels=(1, 1))
    assert heard.shape[1] == 1 and np.max(np.abs(heard)) > 0.01
    _, piece = InputReader(shared).read(FRAME)
    assert np.array_equal(piece[:, 0], piece[:, 1]) and piece.any()
    host.close()


# --- the fake card, in real time --------------------------------------------------------------------


def fake_host(shared):
    events: list[dict] = []
    host = AudioHost(Settings(fake="saw"), shared, events.append, backend=FakeBackend("saw"))
    HOSTS.append(host)
    return host, events


def run_ticks(host, seconds: float) -> None:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        host.tick()
        time.sleep(0.02)


@needs_tones
def test_fake_card_runs_in_real_time(shared):
    host, events = fake_host(shared)
    host.handle({"type": "preset", "preset": PRESETS["drive"], "toneOffsets": None})
    host.open(None, BLOCK)
    assert events[-1]["status"] == "running" and events[-1]["device"] == FAKE_GOOD
    reader = InputReader(shared)
    started = time.monotonic()
    pieces = []
    while time.monotonic() - started < 1.0:
        host.tick()
        while (piece := reader.read(FRAME)) is not None:
            pieces.append(piece)
        time.sleep(0.005)
    assert 85 <= len(pieces) <= 105  # 100 pieces of 10 ms in a second
    assert [frame0 for frame0, _ in pieces] == [index * FRAME for index in range(len(pieces))]
    right = np.concatenate([piece[:, 1] for _, piece in pieces])
    left = np.concatenate([piece[:, 0] for _, piece in pieces])
    assert not left.any()  # the guitar is on the right, like input 2 of the card
    assert np.max(np.abs(right)) == pytest.approx(10 ** (-9 / 20), abs=0.01)
    stream = host.backend.streams[-1]
    host.close()
    assert stream.closed and not stream.active
    assert events[-1]["status"] == "idle"


@needs_tones
def test_fake_card_at_44100_says_set_48000(shared):
    host, events = fake_host(shared)
    host.open(FAKE_44100, BLOCK)
    assert events[-1]["status"] == "error"
    assert events[-1]["error"] == message(RATE_ERROR) == {"code": "guitar.rate", "params": {}}
    host.open(FAKE_GOOD, BLOCK)  # and the engine is fine afterwards
    assert events[-1]["status"] == "running"
    host.close()


@needs_tones
def test_fake_card_lost_mid_run_is_an_error_and_open_recovers(shared):
    host, events = fake_host(shared)
    host.open(FAKE_LOST, BLOCK)
    assert events[-1]["status"] == "running"
    lost = host.backend.streams[-1]
    run_ticks(host, 1.0)
    assert events[-1]["status"] == "error"
    assert events[-1]["error"] == message(DEVICE_LOST) == {"code": "guitar.deviceLost", "params": {}}
    assert lost.closed
    host.open(None, BLOCK)
    assert events[-1]["status"] == "running" and events[-1]["device"] == FAKE_GOOD
    host.close()


@needs_tones
def test_a_card_that_stops_calling_is_lost(shared, monkeypatch):
    """A pulled cable under ASIO: the stream still says it runs, the callbacks just stop."""
    monkeypatch.setattr("kv_guitar.core.STALL_S", 0.2)
    host, events, clock, backend = manual_host(shared)
    host.open(None, BLOCK)
    play(host, clock, 5)
    host.tick()
    assert events[-1]["status"] == "running"
    time.sleep(0.3)
    host.tick()
    assert events[-1]["status"] == "error" and events[-1]["error"] == message(DEVICE_LOST)


@needs_tones
def test_user_file_is_asked_for_and_the_preset_waits(shared):
    host, events = fake_host(shared)
    preset = {**PRESETS["drive"], "cab": "user:x"}
    host.handle({"type": "preset", "preset": preset, "toneOffsets": None})  # before the card is open
    assert events[-1] == {"ev": "need-asset", "id": "user:x"}
    host.open(None, BLOCK)
    assert {"ev": "need-asset", "id": "user:x"} in events[-3:]
    assert host.chain._applied is None  # the preset is kept, not half applied
    host.handle({"type": "asset", "id": "user:x", "kind": "ir", "data": (TONES / "irs" / "mesa.wav").read_bytes()})
    assert host.chain._applied["cab"] == "user:x"
    assert host.chain.wait_idle(10.0)
    run_ticks(host, 0.3)
    assert host.chain.take_warnings() == []
    assert events[-1]["status"] == "running" and events[-1]["amp_state"] == "ready"
    host.close()


# --- the audio process ---------------------------------------------------------------------------


@pytest.fixture
def core():
    engine = Core(Settings(fake="saw"))
    engine.start()
    yield engine
    engine.shutdown()


def wait_status(engine: Core, status: str, timeout: float = 20.0) -> dict:
    def reached():
        engine.poll()
        state = engine.state()
        return state if state["status"] == status else None

    return wait_for(reached, timeout)


@needs_tones
def test_core_stats_are_finite_before_any_sound(core):
    stats = core.stats()
    assert stats == {
        "xruns": 0, "budget_ms": 0.0, "p50": 0.0, "p99": 0.0, "max_ms": 0.0,
        "out_peak_db": -200.0, "out_rms_db": -200.0,
    }  # fmt: skip
    stats_message(**stats)  # raises on NaN
    assert core.read_input(FRAME) is None
    assert core.state()["status"] == "idle"


@needs_tones
def test_core_opens_reads_and_closes(core):
    core.send({"type": "preset", "preset": PRESETS["drive"], "toneOffsets": None})
    core.open(None, BLOCK)
    assert core.state()["status"] == "starting"
    state = wait_status(core, "running")
    assert state["device"] == FAKE_GOOD and state["buffer"] == BLOCK
    assert state["devices"] == [FAKE_GOOD, FAKE_44100, FAKE_LOST]
    assert state["latency_ms"] is not None and state["amp_state"] == "ready"
    # The first half second after opening has one-off work (the collector freezes, the first
    # blocks): the engine's own counts skip it too. Then the count starts again.
    time.sleep(0.5)
    core.send({"type": "reset-stats"})
    pieces = []
    end = time.monotonic() + 1.0
    while time.monotonic() < end:
        while (piece := core.read_input(FRAME)) is not None:
            pieces.append(piece[0])
        time.sleep(0.005)
    assert len(pieces) >= 80
    assert pieces == list(range(pieces[0], pieces[0] + len(pieces) * FRAME, FRAME))
    stats = core.stats()
    stats_message(**stats)
    # On the fake card (a timer, not a sound card) a late callback comes about once a minute on the
    # author's laptop, with the first amps as with the captures of real amps (measured 16 Nov):
    # one in this second can happen, more is a fault.
    assert stats["xruns"] <= 1
    assert stats["budget_ms"] == pytest.approx(BLOCK / SR * 1000)
    assert 0 < stats["p50"] <= stats["p99"] < 50
    assert stats["out_rms_db"] > -60
    core.close()
    assert wait_status(core, "idle")["device"] is None
    assert core.alive  # the process stays, ready for the next open


@needs_tones
def test_core_reports_a_dead_audio_process_and_starts_a_new_one(core):
    core.open(None, BLOCK)
    wait_status(core, "running")
    pid = core.pid
    core._process.kill()
    state = wait_status(core, "error")
    assert state["error"] == message(config.AUDIO_PROCESS_DIED)
    stats_message(**core.stats())
    core.open(None, BLOCK)
    assert wait_status(core, "running")["device"] == FAKE_GOOD
    assert core.pid != pid and core.starts == 2


@needs_tones
def test_audio_process_leaves_when_the_core_shuts_down():
    engine = Core(Settings(fake="saw"))
    engine.start()
    engine.open(None, BLOCK)
    wait_status(engine, "running")
    pid = engine.pid
    engine.shutdown()
    assert not pid_alive(pid)


def test_fake_card_plays_a_wav_file(tmp_path):
    """KV_GUITAR_FAKE=<path>: a dry guitar recording instead of the sawtooth."""
    import soundfile as sf

    from kv_guitar.fake import wav_loop

    path = tmp_path / "di.wav"
    t = np.arange(22050) / 44100
    sf.write(str(path), (0.25 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), 44100, subtype="FLOAT")
    loop = wav_loop(path, SR)
    assert loop.shape == (24000, 2) and loop.dtype == np.float32
    assert not loop[:, 0].any()  # a mono file is the guitar: the right channel
    assert np.max(np.abs(loop[:, 1])) == pytest.approx(0.25, abs=0.01)

    got = []
    stream = FakeBackend(str(path)).open(FAKE_GOOD, BLOCK, SR, lambda indata, out, frames, _t, _s: got.append(indata.copy()))
    stream.start()
    wait_for(lambda: len(got) >= 20)
    stream.close()
    assert not stream.active and stream.closed
    assert np.array_equal(np.concatenate(got[:20]), loop[: 20 * BLOCK])
    with pytest.raises(config.EngineError) as broken:
        wav_loop(tmp_path / "missing.wav", SR)
    assert broken.value.code == "guitar.openFailed" and "KV_GUITAR_FAKE" in broken.value.params["reason"]
