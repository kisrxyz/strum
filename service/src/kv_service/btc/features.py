# Vendored from puar-playground/btc-chord @ d436f2f, btc_src/features.py ("CQT feature extraction +
# chord-index maps for BTC", trimmed from BTC-ISMIR19's utils/mir_eval_modules.py). MIT, see LICENSE.
# Changes: librosa is imported inside the function, the input may come at any sample rate, the
# result is (frames, bins) as the network takes it, and librosa's short-signal warnings are hushed.
"""CQT features and chord labels of BTC."""

from __future__ import annotations

import warnings

import numpy as np

SAMPLE_RATE = 22050
INST_LEN = 10.0  # s: the CQT is computed per 10-second window, as in training
N_BINS = 144
BINS_PER_OCTAVE = 24
HOP_LENGTH = 2048
TIMESTEP = 108  # frames per 10-second window: the network's sequence length
FRAME_SECONDS = INST_LEN / TIMESTEP

# --- chord index -> label maps
idx2chord = ['C', 'C:min', 'C#', 'C#:min', 'D', 'D:min', 'D#', 'D#:min', 'E', 'E:min',
             'F', 'F:min', 'F#', 'F#:min', 'G', 'G:min', 'G#', 'G#:min', 'A', 'A:min',
             'A#', 'A#:min', 'B', 'B:min', 'N']

root_list = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
quality_list = ['min', 'maj', 'dim', 'aug', 'min6', 'maj6', 'min7', 'minmaj7', 'maj7',
                '7', 'dim7', 'hdim7', 'sus2', 'sus4']


def idx2voca_chord():
    """170-class large-vocabulary map: 168 root×quality, 168 = 'X', 169 = 'N'."""
    m = {169: 'N', 168: 'X'}
    for i in range(168):
        root = root_list[i // 14]
        quality = quality_list[i % 14]
        m[i] = root if (i % 14) == 1 else root + ':' + quality
    return m


def log_cqt(mono: np.ndarray, sr: int) -> np.ndarray:
    """(frames, 144) log-CQT of a mono signal, as BTC was trained on: 22 050 Hz, 144 bins, 24 per
    octave, hop 2048, computed per 10-second window (108 frames each) and concatenated."""
    import librosa

    wav = np.asarray(mono, dtype=np.float32)
    if sr != SAMPLE_RATE:
        # librosa.load's own resampler, so the input matches what the original read from files
        wav = librosa.resample(wav, orig_sr=sr, target_sr=SAMPLE_RATE, res_type="soxr_hq")

    def _cqt(y):
        # The last window is usually short, and librosa warns about every octave of it.
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            return librosa.cqt(y, sr=SAMPLE_RATE, n_bins=N_BINS, bins_per_octave=BINS_PER_OCTAVE, hop_length=HOP_LENGTH)

    win = int(SAMPLE_RATE * INST_LEN)
    feature = None
    cur = 0
    while len(wav) > cur + win:
        tmp = _cqt(wav[cur:cur + win])
        feature = tmp if feature is None else np.concatenate((feature, tmp), axis=1)
        cur += win
    tmp = _cqt(wav[cur:])
    feature = tmp if feature is None else np.concatenate((feature, tmp), axis=1)

    feature = np.log(np.abs(feature) + 1e-6)
    return np.ascontiguousarray(feature.T)
