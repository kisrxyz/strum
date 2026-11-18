"""The WebSocket contract of the fast guitar engine: the audio frame and the JSON messages."""

import base64
import copy
import json
import math
import struct

import numpy as np
import pytest

from kv_guitar.protocol import (
    FRAME_HEADER_BYTES,
    FRAME_MAGIC,
    PROTOCOL_VERSION,
    OUTPUT_MAGIC,
    decode_frame,
    encode_frame,
    need_asset_message,
    parse_client_message,
    state_message,
    stats_message,
)

# frame0 = 96 000, 3 frames, L = [0.5, -0.25, 0], R = [1, 0, -1]. The same bytes are in
# src/audio/native/protocol.test.ts.
GOLDEN = bytes.fromhex(
    "4b564731" "03000000" "000000000070f740"
    "0000003f" "0000803f" "000080be" "00000000" "00000000" "000080bf"
)
GOLDEN_INTERLEAVED = np.array([0.5, 1, -0.25, 0, 0, -1], dtype=np.float32)

PRESET = {
    "id": "clean-chorus",
    "name": "Чистый с хорусом",
    "amp": {
        "model": "nam:jc", "inputDb": 0, "gateDb": -70, "bass": 0, "mid": 0, "treble": 1,
        "levelDb": 5.5, "slim": False, "hum": True, "gateAuto": True,
    },
    "cab": "ir:celestion",
    "chorus": {"on": True, "rate": 0.8, "depth": 0.55, "mix": 0.5},
    "delay": {"on": False, "timeMs": 380, "feedback": 0.3, "mix": 0.2},
    "reverb": {"on": True, "type": "spring", "mix": 0.22},
}


def parse(message: object) -> dict | None:
    return parse_client_message(json.dumps(message))


def preset_message(**changes: object) -> dict:
    return {"type": "preset", "preset": copy.deepcopy(PRESET), "toneOffsets": None, **changes}


# --- the binary frame ---


def test_constants() -> None:
    assert FRAME_MAGIC == b"KVG1"
    assert FRAME_HEADER_BYTES == 16
    assert PROTOCOL_VERSION == 1


def test_encode_frame_gives_the_golden_bytes() -> None:
    assert encode_frame(96_000, GOLDEN_INTERLEAVED) == GOLDEN


def test_encode_frame_takes_frames_by_two_channels() -> None:
    assert encode_frame(96_000, GOLDEN_INTERLEAVED.reshape(3, 2)) == GOLDEN


def test_encode_frame_converts_other_dtypes() -> None:
    assert encode_frame(96_000, GOLDEN_INTERLEAVED.astype(np.float64)) == GOLDEN


def test_encode_frame_takes_a_non_contiguous_view() -> None:
    wide = np.zeros((3, 4), dtype=np.float32)
    wide[:, :2] = GOLDEN_INTERLEAVED.reshape(3, 2)
    assert encode_frame(96_000, wide[:, :2]) == GOLDEN


def test_encode_frame_rejects_an_odd_sample_count() -> None:
    with pytest.raises(ValueError):
        encode_frame(0, np.zeros(5, dtype=np.float32))


def test_encode_frame_rejects_a_wrong_shape() -> None:
    with pytest.raises(ValueError):
        encode_frame(0, np.zeros((2, 3), dtype=np.float32))


def test_encode_frame_rejects_a_negative_clock() -> None:
    with pytest.raises(ValueError):
        encode_frame(-1, np.zeros(2, dtype=np.float32))


def test_decode_frame_reads_the_golden_bytes() -> None:
    decoded = decode_frame(GOLDEN)
    assert decoded is not None
    frame0, interleaved = decoded
    assert frame0 == 96_000 and isinstance(frame0, int)
    assert interleaved.dtype == np.float32 and interleaved.shape == (6,)
    np.testing.assert_array_equal(interleaved, GOLDEN_INTERLEAVED)


def test_frame_round_trip_at_the_real_size() -> None:
    rng = np.random.default_rng(1)
    block = rng.uniform(-1, 1, 960).astype(np.float32)
    data = encode_frame(2**40 + 480, block)
    assert len(data) == 16 + 3840
    decoded = decode_frame(data)
    assert decoded is not None
    assert decoded[0] == 2**40 + 480
    np.testing.assert_array_equal(decoded[1], block)


def test_an_empty_frame_round_trips() -> None:
    data = encode_frame(7, np.zeros(0, dtype=np.float32))
    assert len(data) == 16
    decoded = decode_frame(data)
    assert decoded is not None and decoded[0] == 7 and decoded[1].shape == (0,)


def test_output_frame_differs_only_by_its_magic() -> None:
    output = encode_frame(96_000, GOLDEN_INTERLEAVED, OUTPUT_MAGIC)
    assert output == b"KVO1" + GOLDEN[4:]
    assert decode_frame(output) is None  # not an input frame
    frame0, samples = decode_frame(output, OUTPUT_MAGIC)
    assert frame0 == 96_000 and np.array_equal(samples, GOLDEN_INTERLEAVED)


def test_decode_frame_rejects_a_wrong_magic() -> None:
    assert decode_frame(b"KVG2" + GOLDEN[4:]) is None


@pytest.mark.parametrize("size", [0, 3, 15, 16, len(GOLDEN) - 1])
def test_decode_frame_rejects_a_truncated_frame(size: int) -> None:
    assert decode_frame(GOLDEN[:size]) is None


def test_decode_frame_rejects_extra_bytes() -> None:
    assert decode_frame(GOLDEN + b"\0\0\0\0") is None


@pytest.mark.parametrize("clock", [math.nan, math.inf, -1.0, 0.5])
def test_decode_frame_rejects_a_bad_clock(clock: float) -> None:
    assert decode_frame(GOLDEN[:8] + struct.pack("<d", clock) + GOLDEN[16:]) is None


# --- browser -> engine ---


@pytest.mark.parametrize(
    "message",
    [
        {"type": "hello", "protocol": 1},
        {"type": "open", "device": None, "buffer": 64},
        {"type": "open", "device": "M-Track Solo and Duo ASIO", "buffer": 32},
        {"type": "open", "device": None, "buffer": 128},
        {"type": "open", "device": None, "buffer": 256},
        {"type": "close"},
        preset_message(),
        preset_message(toneOffsets={"bass": 1.5, "mid": -2, "treble": 0}),
        {"type": "master", "db": -6.5, "muted": False},
        {"type": "master", "db": 0, "muted": True},
        {"type": "channel", "choice": "left"},
        {"type": "channel", "choice": "right"},
        {"type": "channel", "choice": "both"},
        {"type": "record", "on": True},
        {"type": "record", "on": False},
    ],
)
def test_accepts_every_contract_variant(message: dict) -> None:
    assert parse(message) == message


def test_asset_data_is_decoded() -> None:
    raw = bytes(range(256)) * 3
    message = {"type": "asset", "id": "user:1b2c", "kind": "model", "data": base64.b64encode(raw).decode()}
    assert parse(message) == {"type": "asset", "id": "user:1b2c", "kind": "model", "data": raw}
    assert parse({**message, "kind": "ir"}) == {"type": "asset", "id": "user:1b2c", "kind": "ir", "data": raw}


def test_extra_fields_are_dropped() -> None:
    assert parse({"type": "close", "junk": 1}) == {"type": "close"}
    message = preset_message()
    message["preset"]["amp"]["junk"] = 1
    message["preset"]["junk"] = "x"
    assert parse(message) == preset_message()


@pytest.mark.parametrize(
    "text",
    ["", "not json", "{", "[]", "null", "1", '"hello"', "{}", '{"type": 1}', '{"type": "nope"}', "[" * 100_000],
)
def test_rejects_what_is_not_a_message(text: str) -> None:
    assert parse_client_message(text) is None


def test_rejects_non_text() -> None:
    assert parse_client_message(b'{"type":"close"}') is None  # type: ignore[arg-type]
    assert parse_client_message(None) is None  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "message",
    [
        {"type": "hello"},
        {"type": "hello", "protocol": 2},
        {"type": "hello", "protocol": True},
        {"type": "hello", "protocol": "1"},
        {"type": "open", "buffer": 100},
        {"type": "open", "device": None, "buffer": 100},
        {"type": "open", "device": None, "buffer": "64"},
        {"type": "open", "device": None, "buffer": 64.5},
        {"type": "open", "device": None, "buffer": True},
        {"type": "open", "device": None},
        {"type": "open", "buffer": 64},
        {"type": "open", "device": 3, "buffer": 64},
        {"type": "master", "db": "0", "muted": False},
        {"type": "master", "db": True, "muted": False},
        {"type": "master", "db": 0, "muted": 0},
        {"type": "master", "db": 0},
        {"type": "master", "muted": False},
        {"type": "channel", "choice": "auto"},
        {"type": "channel", "choice": None},
        {"type": "channel"},
        {"type": "asset", "id": "user:1", "kind": "song", "data": "AAAA"},
        {"type": "asset", "id": "user:1", "kind": "model", "data": "not base64!"},
        {"type": "asset", "id": "user:1", "kind": "model", "data": "AAA"},
        {"type": "asset", "id": "user:1", "kind": "model", "data": 5},
        {"type": "asset", "id": "user:1", "kind": "model"},
        {"type": "asset", "id": "", "kind": "model", "data": "AAAA"},
        {"type": "asset", "id": 7, "kind": "model", "data": "AAAA"},
        {"type": "preset", "preset": None, "toneOffsets": None},
        {"type": "preset", "preset": [], "toneOffsets": None},
        {"type": "preset", "toneOffsets": None},
        {"type": "preset", "preset": PRESET},
        preset_message(toneOffsets={"bass": 0, "mid": 0}),
        preset_message(toneOffsets={"bass": 0, "mid": 0, "treble": "1"}),
        preset_message(toneOffsets=[0, 0, 0]),
    ],
)
def test_rejects_malformed_messages(message: dict) -> None:
    assert parse(message) is None


@pytest.mark.parametrize(
    "text",
    [
        '{"type":"master","db":NaN,"muted":false}',
        '{"type":"master","db":-Infinity,"muted":false}',
        '{"type":"master","db":1e999,"muted":false}',
    ],
)
def test_rejects_non_finite_numbers(text: str) -> None:
    assert parse_client_message(text) is None


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (("id",), 1),
        (("name",), None),
        (("cab",), None),
        (("amp",), None),
        (("amp", "model"), 3),
        (("amp", "inputDb"), "0"),
        (("amp", "gateDb"), None),
        (("amp", "bass"), True),
        (("amp", "mid"), [0]),
        (("amp", "treble"), {}),
        (("amp", "levelDb"), "loud"),
        (("amp", "slim"), 0),
        (("chorus",), "off"),
        (("chorus", "on"), 1),
        (("chorus", "rate"), "0.8"),
        (("chorus", "depth"), None),
        (("chorus", "mix"), False),
        (("delay",), None),
        (("delay", "on"), "yes"),
        (("delay", "timeMs"), "380"),
        (("delay", "feedback"), None),
        (("delay", "mix"), None),
        (("reverb",), 1),
        (("reverb", "on"), None),
        (("reverb", "type"), "hall"),
        (("reverb", "type"), 1),
        (("reverb", "mix"), "0.2"),
    ],
)
def test_rejects_a_preset_with_a_wrong_field(path: tuple[str, ...], value: object) -> None:
    message = preset_message()
    target = message["preset"]
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value
    assert parse(message) is None
    # ... and with the field missing.
    del target[path[-1]]
    assert parse(message) is None


@pytest.mark.parametrize("field", ["hum", "gateAuto"])
def test_the_switches_of_16_november_are_optional_and_boolean(field: str) -> None:
    # A tab opened before the hum filter or «Шумодав сам» sends presets without them: they play without.
    message = preset_message()
    del message["preset"]["amp"][field]
    parsed = parse(message)
    assert parsed is not None and parsed["preset"]["amp"][field] is False
    message["preset"]["amp"][field] = 1
    assert parse(message) is None


def test_trim_message() -> None:
    # «Подстроить под мою гитару»: a number of decibels; the engine keeps it in its own range.
    assert parse({"type": "trim", "db": 8.5}) == {"type": "trim", "db": 8.5}
    assert parse({"type": "trim", "db": -40}) == {"type": "trim", "db": -40}
    for bad in ("8", True, None, float("inf")):
        assert parse({"type": "trim", "db": bad}) is None
    assert parse({"type": "trim"}) is None


def test_mains_message() -> None:
    # The hum filter's mains: 50 or 60 Hz, nothing else.
    assert parse({"type": "mains", "hz": 60}) == {"type": "mains", "hz": 60}
    assert parse({"type": "mains", "hz": 50}) == {"type": "mains", "hz": 50}
    for bad in (55, "60", True, None):
        assert parse({"type": "mains", "hz": bad}) is None


def test_plate_reverb_is_accepted() -> None:
    message = preset_message()
    message["preset"]["reverb"]["type"] = "plate"
    assert parse(message) == message


# --- engine -> browser ---

# The same message is parsed in src/audio/native/protocol.test.ts.
STATE = {
    "type": "state",
    "protocol": 1,
    "status": "running",
    "devices": ["M-Track Solo and Duo ASIO", "ASIO4ALL v2"],
    "device": "M-Track Solo and Duo ASIO",
    "sampleRate": 48000,
    "buffer": 64,
    "latencyMs": {"input": 2.5, "output": 3.25},
    "amp": {"state": "fallback", "message": {"code": "amp.modelFailed", "params": {"reason": "нет файла"}}},
    "error": None,
}


def test_state_message() -> None:
    text = state_message(
        status="running",
        devices=["M-Track Solo and Duo ASIO", "ASIO4ALL v2"],
        device="M-Track Solo and Duo ASIO",
        sample_rate=48000,
        buffer=64,
        latency_ms=(2.5, 3.25),
        amp_state="fallback",
        amp_message={"code": "amp.modelFailed", "params": {"reason": "нет файла"}},
        error=None,
    )
    assert json.loads(text) == STATE
    assert "нет файла" in text  # a reason in Russian stays readable in the logs


def test_state_message_defaults_to_an_idle_engine() -> None:
    assert json.loads(state_message()) == {
        "type": "state",
        "protocol": 1,
        "status": "idle",
        "devices": [],
        "device": None,
        "sampleRate": 48000,
        "buffer": 0,
        "latencyMs": None,
        "amp": {"state": "idle"},
        "error": None,
    }


def test_state_message_rejects_unknown_states() -> None:
    with pytest.raises(ValueError):
        state_message(status="paused")
    with pytest.raises(ValueError):
        state_message(amp_state="broken")


def test_stats_message() -> None:
    text = stats_message(xruns=2, budget_ms=1.333, p50=0.4, p99=0.9, max_ms=1.2, out_peak_db=-6.0, out_rms_db=-18.5)
    assert json.loads(text) == {
        "type": "stats",
        "xruns": 2,
        "budgetMs": 1.333,
        "callbackMs": {"p50": 0.4, "p99": 0.9, "max": 1.2},
        "outPeakDb": -6.0,
        "outRmsDb": -18.5,
    }


def test_stats_message_is_strict_json_on_silence() -> None:
    # JSON has no -Infinity: JSON.parse in the browser would throw on it.
    text = stats_message(
        xruns=0, budget_ms=1.333, p50=0.0, p99=0.0, max_ms=0.0, out_peak_db=-math.inf, out_rms_db=math.nan
    )
    assert "Infinity" not in text and "NaN" not in text
    message = json.loads(text)
    assert message["outPeakDb"] == -200 and message["outRmsDb"] == -200


def test_stats_message_takes_numpy_numbers() -> None:
    text = stats_message(
        xruns=np.int64(1), budget_ms=np.float64(1.5), p50=np.float32(0.5), p99=np.float32(0.5),
        max_ms=np.float32(0.5), out_peak_db=np.float32(-6), out_rms_db=np.float32(-12),
    )
    assert json.loads(text)["callbackMs"] == {"p50": 0.5, "p99": 0.5, "max": 0.5}


def test_need_asset_message() -> None:
    assert json.loads(need_asset_message("user:1b2c")) == {"type": "need-asset", "id": "user:1b2c"}
