import numpy as np
import pytest

from conftest import SR
from kv_service.tone import match_tone

G_CHORD = (98.0, 123.47, 146.83, 196.0, 246.94, 392.0)  # an open G chord, 6th string to 1st


def sine_chord(seconds: float = 10.0, amp: float = 0.15) -> np.ndarray:
    t = np.arange(int(seconds * SR)) / SR
    return sum(amp * np.sin(2 * np.pi * f * t + i) for i, f in enumerate(G_CHORD)).astype(np.float32)


def melody(seconds: float = 10.0, amp: float = 0.3) -> np.ndarray:
    """Single notes of half a second with 4 harmonics, a little vibrato and a decay: a lead line."""
    notes = (440.0, 523.25, 587.33, 659.25, 587.33, 523.25, 440.0, 392.0)
    t = np.arange(int(0.5 * SR)) / SR
    parts = []
    for k in range(int(seconds / 0.5)):
        f = notes[k % len(notes)] * (1 + 0.003 * np.sin(2 * np.pi * 5 * t))
        phase = 2 * np.pi * np.cumsum(f) / SR
        parts.append(amp * sum(np.sin(h * phase) / h for h in range(1, 5)) * np.exp(-1.5 * t))
    return np.concatenate(parts).astype(np.float32)


def assert_eq_in_range(tone: dict) -> None:
    for band in ("bass", "mid", "treble"):
        assert isinstance(tone[band], int)
        assert -4 <= tone[band] <= 4
    assert 0 <= tone["confidence"] <= 1


def test_tone_classes():
    x = sine_chord()
    expected = {"clean-chorus": x, "crunch": np.tanh(2.5 * x), "drive": np.tanh(8 * x)}
    for preset, signal in expected.items():
        tone = match_tone(signal, SR)
        assert tone is not None
        assert tone["presetId"] == preset
        assert_eq_in_range(tone)
    assert match_tone(np.repeat(x[:, None], 2, axis=1), SR)["presetId"] == "clean-chorus"


def test_quiet_or_short_guitar_gives_no_tone():
    noise = np.random.default_rng(0).normal(0, 10 ** (-60 / 20), 10 * SR).astype(np.float32)
    assert match_tone(noise, SR) is None
    short = np.concatenate([sine_chord(4.0), np.zeros(6 * SR, dtype=np.float32)])
    assert match_tone(short, SR) is None
    assert match_tone(np.zeros(0, dtype=np.float32), SR) is None


def test_single_notes_are_clean_or_a_solo():
    m = melody()
    assert match_tone(m, SR)["presetId"] == "clean-chorus"
    tone = match_tone(np.tanh(8 * m), SR)
    assert tone["presetId"] == "solo"
    assert_eq_in_range(tone)


def test_eq_follows_the_band_balance():
    x = sine_chord()
    t = np.arange(len(x)) / SR
    bright = x + 0.2 * np.sin(2 * np.pi * 3520.0 * t).astype(np.float32)
    assert match_tone(bright, SR)["treble"] > match_tone(x, SR)["treble"]
