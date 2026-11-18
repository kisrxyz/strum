"""Cabinet IR gain staging — a port of `src/dsp/irGain.ts` (same constants).

Scale the kernel so its mean power response over the guitar band (100 Hz – 5 kHz, log-spaced)
is 0 dB. Then every cabinet keeps the amp at the same loudness.
"""

from __future__ import annotations

import math

import numpy as np

BAND_LO_HZ = 100
BAND_HI_HZ = 5000
BAND_POINTS = 64
MAX_BOOST_DB = 24
MAX_CUT_DB = 48


def ir_in_band_gain_db(taps: np.ndarray, sample_rate: int) -> float:
    """The gain in dB that brings the IR to 0 dB in the guitar band, within −48 … +24."""
    x = np.asarray(taps, dtype=np.float64).reshape(-1)
    if not len(x):
        return 0.0
    k = np.arange(BAND_POINTS)
    freqs = BAND_LO_HZ * (BAND_HI_HZ / BAND_LO_HZ) ** (k / (BAND_POINTS - 1))
    w = 2 * np.pi * freqs / sample_rate
    index = np.arange(len(x))
    acc = 0.0
    for wk in w:
        phase = wk * index
        re = float(np.dot(x, np.cos(phase)))
        im = float(np.dot(x, np.sin(phase)))
        acc += re * re + im * im
    mean_power = acc / BAND_POINTS
    if not (mean_power > 0) or not math.isfinite(mean_power):
        return 0.0
    return float(min(MAX_BOOST_DB, max(-MAX_CUT_DB, -10 * math.log10(mean_power))))


def db_to_lin(db: float) -> float:
    return 10 ** (db / 20)
