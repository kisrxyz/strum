import numpy as np
import pytest

from conftest import SR
from kv_service.tuning import estimate_tuning_cents


def detuned_chord(cents: float, seconds: float = 5.0) -> np.ndarray:
    """A3, C♯4 and E4 as harmonic tones (fundamental + 4 harmonics), all off by `cents`."""
    t = np.arange(int(seconds * SR)) / SR
    out = np.zeros_like(t)
    for midi in (57, 61, 64):
        f0 = 440.0 * 2 ** ((midi - 69) / 12) * 2 ** (cents / 1200)
        for k in range(1, 6):
            out += (0.1 / k) * np.sin(2 * np.pi * k * f0 * t + midi)
    return out.astype(np.float32)


@pytest.mark.parametrize("cents", [23.0, -17.0, 0.0])
def test_tuning_cents(cents):
    assert estimate_tuning_cents(detuned_chord(cents), SR) == pytest.approx(cents, abs=2)


def test_silence_is_in_tune():
    assert estimate_tuning_cents(np.zeros(5 * SR, dtype=np.float32), SR) == 0.0
    assert estimate_tuning_cents(np.zeros(0, dtype=np.float32), SR) == 0.0


def test_stereo_and_a_quarter_tone_stay_in_range():
    stereo = np.repeat(detuned_chord(-17.0)[:, None], 2, axis=1)
    assert estimate_tuning_cents(stereo, SR) == pytest.approx(-17.0, abs=2)
    for cents in (49.0, -49.5, 50.0):
        result = estimate_tuning_cents(detuned_chord(cents), SR)
        assert -50.0 <= result < 50.0
        # 50 cents sharp and 50 flat are the same grid: the distance wraps around
        assert min(abs(result - cents), 100 - abs(result - cents)) <= 2
