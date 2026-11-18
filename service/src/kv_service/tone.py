"""«Звук как в песне»: which of the four amp presets sounds like the guitar in the recording.

An experiment (plan decision 20). Distortion flattens the waveform's peaks (a low crest factor)
and fills the top of the spectrum with dense overtones (a flat high band). Single notes have a
lower crest factor than chords even when clean, so the limits move with how much of the playing
is single notes; distorted single notes are «solo». The EQ nudges compare the band balance with
what a guitar of that kind usually has.
"""

from __future__ import annotations

import numpy as np

FRAME = 2048  # 46 ms at 44.1 kHz
QUIET_DB = -45.0  # a guitar stem quieter than this has no guitar worth matching
PLAYING_BELOW_LOUD_DB = 25.0  # frames this far below the loud ones are pauses, not playing
MIN_PLAYING = 5.0  # s
MAX_FRAMES = 3000  # analysed frames, spread over the song
PITCH_FRAMES = 300  # frames checked for single notes
SINGLE_NOTE_DIP = 0.15  # YIN dip below this: one clear pitch
SINGLE_NOTE_HZ = (150.0, 1500.0)  # lead-guitar range; power chords repeat at half their root, below it
SOLO_SHARE = 0.5

# Crest limits in dB (crest minus the flatness term), for chords and for single notes.
DRIVE_BELOW = {"chords": 4.5, "notes": 3.0}
CRUNCH_BELOW = {"chords": 7.0, "notes": 4.5}
FLATNESS_DB = 6.0  # dB taken off the crest per unit of high-band flatness

BANDS = {"bass": (40.0, 250.0), "mid": (400.0, 1500.0), "treble": (2500.0, 10000.0)}
# Typical share of each band in a recorded guitar of each kind, dB. Rough guesses to tune by ear.
REFERENCE_DB = {
    "clean-chorus": {"bass": -8.0, "mid": -5.0, "treble": -22.0},
    "crunch": {"bass": -9.0, "mid": -4.0, "treble": -18.0},
    "drive": {"bass": -10.0, "mid": -4.0, "treble": -15.0},
    "solo": {"bass": -18.0, "mid": -2.0, "treble": -14.0},
}
EQ_SHARE = 0.5  # how much of the difference the EQ makes up
EQ_LIMIT = 4


def _frames(mono: np.ndarray) -> np.ndarray:
    count = len(mono) // FRAME
    return mono[: count * FRAME].reshape(count, FRAME)


def _single_note_share(frames: np.ndarray, sr: int) -> float:
    """Share of frames with one clear pitch in the lead range (YIN's normalised difference dip)."""
    if not len(frames):
        return 0.0
    if len(frames) > PITCH_FRAMES:
        frames = frames[np.linspace(0, len(frames) - 1, PITCH_FRAMES).astype(int)]
    width = FRAME // 2
    tau_min = max(1, int(sr / SINGLE_NOTE_HZ[1]))
    tau_max = min(FRAME - width - 1, int(sr / SINGLE_NOTE_HZ[0]))
    size = 4096
    head = frames[:, :width]
    spectrum = np.conj(np.fft.rfft(head, size, axis=1)) * np.fft.rfft(frames[:, : width + tau_max + 1], size, axis=1)
    corr = np.fft.irfft(spectrum, size, axis=1)[:, : tau_max + 1]
    energy = np.cumsum(np.square(frames[:, : width + tau_max + 1]), axis=1)
    energy = np.concatenate([np.zeros((len(frames), 1)), energy], axis=1)
    taus = np.arange(tau_max + 1)
    shifted = energy[:, taus + width] - energy[:, taus]  # sum of x² over [τ, τ + width)
    diff = np.maximum(energy[:, width : width + 1] + shifted - 2 * corr, 0.0)[:, 1:]  # τ = 1…tau_max
    running = np.cumsum(diff, axis=1)
    normalised = diff * np.arange(1, tau_max + 1) / np.maximum(running, 1e-20)
    dips = normalised[:, tau_min - 1 :].min(axis=1)
    return float(np.mean(dips < SINGLE_NOTE_DIP))


def match_tone(guitar: np.ndarray, sr: int) -> dict | None:
    """{presetId, bass, mid, treble (whole dB, −4…4), confidence (0–1)}, or None when the guitar
    plays for less than 5 s or its stem is quieter than −45 dBFS."""
    mono = np.asarray(guitar, dtype=np.float64)
    if mono.ndim == 2:
        mono = mono.mean(axis=1)
    frames = _frames(mono)
    if not len(frames):
        return None
    if len(frames) > MAX_FRAMES:
        frames = frames[np.linspace(0, len(frames) - 1, MAX_FRAMES).astype(int)]
    rms = np.sqrt(np.mean(np.square(frames), axis=1))
    level = 20 * np.log10(np.maximum(rms, 1e-12))
    loud = float(np.percentile(level, 95))
    playing = level > max(QUIET_DB, loud - PLAYING_BELOW_LOUD_DB)
    playing_seconds = float(playing.sum()) * FRAME / sr * (len(mono) // FRAME) / len(level)
    if loud < QUIET_DB or playing_seconds < MIN_PLAYING:
        return None
    frames, rms = frames[playing], rms[playing]

    crest = float(np.median(20 * np.log10(np.max(np.abs(frames), axis=1) / rms)))
    power = np.square(np.abs(np.fft.rfft(frames * np.hanning(FRAME), axis=1)))
    freqs = np.fft.rfftfreq(FRAME, 1 / sr)
    total = power[:, freqs >= BANDS["bass"][0]].sum(axis=1) + 1e-20
    band_db = {
        band: float(10 * np.log10(np.mean(power[:, (freqs >= lo) & (freqs < hi)].sum(axis=1) / total) + 1e-12))
        for band, (lo, hi) in BANDS.items()
    }
    top = power[:, (freqs >= BANDS["treble"][0]) & (freqs < BANDS["treble"][1])] + 1e-20
    top_share = top.sum(axis=1) / total
    flatness = np.exp(np.mean(np.log(top), axis=1)) / np.mean(top, axis=1)
    flatness = float(np.median(np.where(top_share > 1e-6, flatness, 0.0)))  # an empty top is not flat

    notes = _single_note_share(frames, sr)
    drive_below = DRIVE_BELOW["chords"] + (DRIVE_BELOW["notes"] - DRIVE_BELOW["chords"]) * notes
    crunch_below = CRUNCH_BELOW["chords"] + (CRUNCH_BELOW["notes"] - CRUNCH_BELOW["chords"]) * notes
    score = crest - FLATNESS_DB * flatness
    if score < drive_below:
        preset = "solo" if notes >= SOLO_SHARE else "drive"
    elif score < crunch_below:
        preset = "crunch"
    else:
        preset = "clean-chorus"

    reference = REFERENCE_DB[preset]
    eq = {
        band: int(np.clip(np.round(EQ_SHARE * (band_db[band] - reference[band])), -EQ_LIMIT, EQ_LIMIT))
        for band in BANDS
    }
    margin = min(abs(score - drive_below), abs(score - crunch_below))
    confidence = (0.5 + 0.5 * min(1.0, margin / 2.0)) * min(1.0, playing_seconds / 20.0)
    return {"presetId": preset, **eq, "confidence": round(confidence, 2)}
