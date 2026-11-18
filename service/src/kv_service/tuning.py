"""How far a recording drifts from A = 440 Hz, in cents (old tape recordings often do)."""

from __future__ import annotations

import numpy as np

N_FFT = 16384  # 2.7 Hz bins at 44.1 kHz; peaks are interpolated well below that
HOP = 8192
MAX_FRAMES = 400  # spread over the song: plenty for one number, quick on a long song
FMIN, FMAX = 80.0, 2000.0
PEAK_RANGE_DB = -40.0  # peaks this far below the frame's loudest one are ignored
SILENCE = 1e-4  # amplitude of a peak (relative to full scale) that is still worth hearing


def estimate_tuning_cents(x: np.ndarray, sr: int) -> float:
    """The recording's offset from the A440 semitone grid, in [−50, 50): +23 means everything
    sounds 23 cents sharp. 0.0 for silence.

    Spectral peaks between 80 and 2000 Hz (frequency refined by parabolic interpolation of the
    log magnitude) give their distance to the nearest equal-tempered note; the answer is the
    magnitude-weighted circular mean of those distances, so 49 cents sharp and 49 flat average to
    a quarter tone, not to zero. Overtones above the fourth bias it by about a cent.
    """
    mono = np.asarray(x, dtype=np.float64)
    if mono.ndim == 2:
        mono = mono.mean(axis=1)
    if len(mono) == 0:
        return 0.0
    if len(mono) < N_FFT:
        mono = np.pad(mono, (0, N_FFT - len(mono)))
    starts = np.arange(0, len(mono) - N_FFT + 1, HOP)
    if len(starts) > MAX_FRAMES:
        starts = starts[np.linspace(0, len(starts) - 1, MAX_FRAMES).astype(int)]
    window = np.hanning(N_FFT)
    floor = SILENCE * window.sum() / 2  # a full-scale sine peaks at sum(window) / 2
    lo = max(1, int(np.floor(FMIN * N_FFT / sr)))
    hi = min(N_FFT // 2 - 1, int(np.ceil(FMAX * N_FFT / sr)))
    if hi <= lo:
        return 0.0

    phasor = 0j
    weight = 0.0
    for chunk in np.array_split(starts, max(1, int(np.ceil(len(starts) / 32)))):
        frames = np.stack([mono[s : s + N_FFT] for s in chunk]) * window
        mag = np.abs(np.fft.rfft(frames, axis=1))[:, lo - 1 : hi + 2]
        centre = mag[:, 1:-1]
        peak = (centre > mag[:, :-2]) & (centre >= mag[:, 2:])
        peak &= centre > np.maximum(floor, centre.max(axis=1, keepdims=True) * 10 ** (PEAK_RANGE_DB / 20))
        rows, cols = np.nonzero(peak)
        if not len(rows):
            continue
        log_mag = np.log(mag[rows[:, None], cols[:, None] + np.arange(3)] + 1e-12)
        a, b, c = log_mag[:, 0], log_mag[:, 1], log_mag[:, 2]
        bend = a - 2 * b + c
        offset = np.where(np.abs(bend) > 1e-12, 0.5 * (a - c) / np.where(bend == 0, 1, bend), 0.0)
        freq = (lo + cols + np.clip(offset, -0.5, 0.5)) * sr / N_FFT
        cents = 1200 * np.log2(freq / 440.0)
        w = centre[rows, cols]
        phasor += np.sum(w * np.exp(2j * np.pi * cents / 100))
        weight += float(np.sum(w))
    if weight == 0 or abs(phasor) < 1e-9 * weight:
        return 0.0
    cents = float(np.angle(phasor)) * 100 / (2 * np.pi)
    cents = round(cents, 1)
    return -50.0 if cents >= 50 else cents
