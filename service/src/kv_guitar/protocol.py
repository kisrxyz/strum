"""The WebSocket contract between the guitar engine and the browser.

Text frames are JSON control messages, binary frames are audio. The other side of the same
contract is src/audio/native/protocol.ts: change both together (the tests share golden bytes).

Binary frame (engine -> browser), little-endian:

    0   4 x u8        magic "KVG1"
    4   u32           frames = n
    8   f64           frame0: the engine's sample clock at the first frame
    16  n x 2 x f32   the raw input, interleaved L, R, before the gate

An output frame has the same layout with the magic "KVO1": what the card played for those frames
(the final output, after the master and the soft clip). It goes only to a browser that sent
`record` with `on: true` («Запись»).
"""

import base64
import json
import math
import struct
from collections.abc import Sequence

import numpy as np

PROTOCOL_VERSION = 1

FRAME_MAGIC = b"KVG1"
OUTPUT_MAGIC = b"KVO1"
FRAME_HEADER_BYTES = 16
_HEADER = struct.Struct("<4sId")
_BYTES_PER_FRAME = 8  # two float32
# A float64 holds whole numbers exactly up to here (2925 years of samples at 48 kHz).
_MAX_FRAME0 = 2**53

BUFFER_SIZES = (32, 64, 128, 256)
CHANNEL_CHOICES = ("left", "right", "both")
ASSET_KINDS = ("model", "ir")
REVERB_TYPES = ("spring", "plate")
STATUSES = ("idle", "starting", "running", "error")
AMP_STATES = ("idle", "loading", "ready", "fallback")

# What the level readings say for digital silence: JSON has no -Infinity.
SILENCE_DB = -200.0


# --- the binary frame ---


def encode_frame(frame0: int, interleaved: np.ndarray, magic: bytes = FRAME_MAGIC) -> bytes:
    """One audio frame. `interleaved` is L, R, L, R... (1-D, even length) or frames x 2.

    Allocates: call it on the sender thread, never in the audio callback.
    """
    if not 0 <= frame0 <= _MAX_FRAME0:
        raise ValueError(f"frame0 out of range: {frame0}")
    samples = np.asarray(interleaved)
    if samples.ndim == 2 and samples.shape[1] == 2:
        samples = samples.reshape(-1)  # C order: L0 R0 L1 R1...
    if samples.ndim != 1 or samples.size % 2:
        raise ValueError(f"expected interleaved stereo, got shape {np.shape(interleaved)}")
    body = np.ascontiguousarray(samples, dtype="<f4").tobytes()
    return _HEADER.pack(magic, samples.size // 2, float(frame0)) + body


def decode_frame(b: bytes, magic: bytes = FRAME_MAGIC) -> tuple[int, np.ndarray] | None:
    """(frame0, interleaved float32 of length 2 x frames), or None when it is not our frame.

    The array is a copy: it is writable and does not keep `b` alive.
    """
    if len(b) < FRAME_HEADER_BYTES:
        return None
    found, frames, frame0 = _HEADER.unpack_from(b)
    if found != magic or len(b) != FRAME_HEADER_BYTES + frames * _BYTES_PER_FRAME:
        return None
    if not (math.isfinite(frame0) and 0 <= frame0 <= _MAX_FRAME0 and frame0 == int(frame0)):
        return None
    samples = np.frombuffer(b, dtype="<f4", offset=FRAME_HEADER_BYTES).astype(np.float32, copy=True)
    return int(frame0), samples


# --- browser -> engine ---


class _Malformed(Exception):
    pass


def _number(value: object) -> int | float:
    # bool is an int in Python: `true` is not a number here.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _Malformed
    try:
        finite = math.isfinite(value)
    except OverflowError:  # an integer too big for a float
        raise _Malformed from None
    if not finite:
        raise _Malformed
    return value


def _string(value: object) -> str:
    if not isinstance(value, str):
        raise _Malformed
    return value


def _boolean(value: object) -> bool:
    if not isinstance(value, bool):
        raise _Malformed
    return value


def _one_of(value: object, allowed: Sequence[object]) -> object:
    # Type first: True == 1 and 64.0 == 64 must not slip through.
    if isinstance(value, bool) or not any(type(value) is type(a) and value == a for a in allowed):
        raise _Malformed
    return value


def _fields(value: object, readers: dict) -> dict:
    """A dict with exactly the named fields, each checked by its reader. Extra fields are dropped."""
    if not isinstance(value, dict):
        raise _Malformed
    out = {}
    for name, reader in readers.items():
        if name not in value:
            raise _Malformed
        out[name] = reader(value[name])
    return out


def _nullable(reader):
    return lambda value: None if value is None else reader(value)


def _reverb_type(value: object) -> object:
    return _one_of(value, REVERB_TYPES)


# src/state/presets.ts `Preset`, field for field.
_AMP = {
    "model": _string,
    "inputDb": _number,
    "gateDb": _number,
    "bass": _number,
    "mid": _number,
    "treble": _number,
    "levelDb": _number,
    "slim": _boolean,
}
_CHORUS = {"on": _boolean, "rate": _number, "depth": _number, "mix": _number}
_DELAY = {"on": _boolean, "timeMs": _number, "feedback": _number, "mix": _number}
_REVERB = {"on": _boolean, "type": _reverb_type, "mix": _number}


def _amp(value: object) -> dict:
    """`_AMP`, plus «Фильтр гула» (`hum`) and «Шумодав сам» (`gateAuto`), both of 2026-11-16: a tab
    opened before them sends no such fields, and its presets play as they did then — without."""
    out = _fields(value, _AMP)
    for name in ("hum", "gateAuto"):
        out[name] = _boolean(value[name]) if name in value else False  # type: ignore[operator,index]
    return out


_PRESET = {
    "id": _string,
    "name": _string,
    "amp": _amp,
    "cab": _string,
    "chorus": lambda v: _fields(v, _CHORUS),
    "delay": lambda v: _fields(v, _DELAY),
    "reverb": lambda v: _fields(v, _REVERB),
}
_TONE_OFFSETS = {"bass": _number, "mid": _number, "treble": _number}


def _asset_id(value: object) -> str:
    if not isinstance(value, str) or not value:
        raise _Malformed
    return value


def _base64(value: object) -> bytes:
    if not isinstance(value, str) or not value:
        raise _Malformed
    try:
        return base64.b64decode(value, validate=True)
    except ValueError:  # binascii.Error
        raise _Malformed from None


_CLIENT_MESSAGES: dict[str, dict] = {
    "hello": {"protocol": lambda v: _one_of(v, (PROTOCOL_VERSION,))},
    "open": {"device": _nullable(_string), "buffer": lambda v: _one_of(v, BUFFER_SIZES)},
    "close": {},
    "preset": {
        "preset": lambda v: _fields(v, _PRESET),
        "toneOffsets": _nullable(lambda v: _fields(v, _TONE_OFFSETS)),
    },
    "master": {"db": _number, "muted": _boolean},
    "channel": {"choice": lambda v: _one_of(v, CHANNEL_CHOICES)},
    # «Подстроить под мою гитару»: the input's own gain, dB (the engine keeps it in its range).
    "trim": {"db": _number},
    # The hum filter's mains (src/dsp/mains.ts): 50 or 60 Hz.
    "mains": {"hz": lambda v: _one_of(v, (50, 60))},
    "asset": {"id": _asset_id, "kind": lambda v: _one_of(v, ASSET_KINDS), "data": _base64},
    "record": {"on": _boolean},
}


def parse_client_message(text: str) -> dict | None:
    """A checked message from the browser, or None for anything else. Never raises.

    The result has `type` and exactly the contract's fields with the contract's types (unknown
    fields are dropped, a missing one makes the message malformed), so the engine can index it
    without checks: numbers are finite int / float and never bool, `preset` has every field of
    the TypeScript `Preset`.

    One difference from the wire: an `asset` message's `data` comes back as the decoded bytes
    of the file, not as the base64 text (strict base64, checked here, decoded once).
    """
    if not isinstance(text, str):
        return None
    try:
        raw = json.loads(text)
        if not isinstance(raw, dict):
            return None
        kind = raw.get("type")
        if not isinstance(kind, str) or kind not in _CLIENT_MESSAGES:
            return None
        return {"type": kind, **_fields(raw, _CLIENT_MESSAGES[kind])}
    except (_Malformed, ValueError, RecursionError):
        # ValueError: not JSON (JSONDecodeError), or a number with too many digits.
        return None


# --- engine -> browser ---


def _dumps(message: dict) -> str:
    # allow_nan=False: NaN / Infinity are not JSON, the browser's JSON.parse throws on them.
    return json.dumps(message, ensure_ascii=False, allow_nan=False)


def state_message(
    *,
    status: str = "idle",
    devices: Sequence[str] = (),
    device: str | None = None,
    sample_rate: int = 48000,
    buffer: int = 0,
    latency_ms: tuple[float, float] | None = None,
    amp_state: str = "idle",
    amp_message: dict | str | None = None,
    error: dict | str | None = None,
) -> str:
    """The `state` message. `latency_ms` is (input, output) from the driver; `error` and
    `amp_message` are messages, `{code, params}` (kv_service.messages): the app has the words."""
    if status not in STATUSES:
        raise ValueError(f"unknown status: {status}")
    if amp_state not in AMP_STATES:
        raise ValueError(f"unknown amp state: {amp_state}")
    amp: dict = {"state": amp_state}
    if amp_message is not None:
        amp["message"] = amp_message
    return _dumps(
        {
            "type": "state",
            "protocol": PROTOCOL_VERSION,
            "status": status,
            "devices": [str(name) for name in devices],
            "device": device,
            "sampleRate": int(sample_rate),
            "buffer": int(buffer),
            "latencyMs": None
            if latency_ms is None
            else {"input": float(latency_ms[0]), "output": float(latency_ms[1])},
            "amp": amp,
            "error": error,
        }
    )


def _db(value: float) -> float:
    value = float(value)
    return max(value, SILENCE_DB) if math.isfinite(value) else SILENCE_DB


def stats_message(
    *,
    xruns: int,
    budget_ms: float,
    p50: float,
    p99: float,
    max_ms: float,
    out_peak_db: float,
    out_rms_db: float,
) -> str:
    """The `stats` message (10 Hz). p50 / p99 / max_ms are the audio callback's times in ms.

    Silence (-inf dB, or NaN) is sent as SILENCE_DB. The other numbers must be finite
    (ValueError otherwise).
    """
    return _dumps(
        {
            "type": "stats",
            "xruns": int(xruns),
            "budgetMs": float(budget_ms),
            "callbackMs": {"p50": float(p50), "p99": float(p99), "max": float(max_ms)},
            "outPeakDb": _db(out_peak_db),
            "outRmsDb": _db(out_rms_db),
        }
    )


def need_asset_message(asset_id: str) -> str:
    """Asks the browser for a `user:` model or IR the engine does not have."""
    return _dumps({"type": "need-asset", "id": asset_id})
