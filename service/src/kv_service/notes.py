"""The notes of the guitar stem («радар нот»): pitch frames (CREPE, every 10 ms) → notes.

A note is a run of voiced frames that stay within a semitone of one pitch; very short runs are
dropped (slides and noise), and the same note cut by a tiny gap is joined. Strummed chords give
low periodicity (CREPE hears no single pitch there), so they mostly give no notes. This is a
draft for learning a solo by ear: which note and when; the string and fret are the player's call.
"""

from __future__ import annotations

import numpy as np

# Frames less periodic than this are not a clear single pitch (CREPE's periodicity, 0..1).
PERIODICITY_MIN = 0.5
# Notes shorter than this are slides, bends on the way or noise.
MIN_NOTE_SECONDS = 0.08
# The same note cut by a gap this short is one note.
JOIN_GAP_SECONDS = 0.04
# A pitch further than this from the note's centre (semitones) starts a new note.
SPLIT_SEMITONES = 0.6
# The guitar's range (E2 … E6, a 24-fret neck).
MIDI_MIN = 40
MIDI_MAX = 88


def _midi(hz: np.ndarray) -> np.ndarray:
    with np.errstate(divide="ignore", invalid="ignore"):
        return 69.0 + 12.0 * np.log2(np.asarray(hz, dtype=np.float64) / 440.0)


def frames_to_notes(pitch_hz: np.ndarray, periodicity: np.ndarray, hop_s: float) -> list[dict]:
    """Notes `{start, end, midi, conf}` (seconds, MIDI number, mean periodicity) from pitch frames."""
    midi = _midi(pitch_hz)
    periodicity = np.asarray(periodicity, dtype=np.float64)
    voiced = (periodicity >= PERIODICITY_MIN) & np.isfinite(midi) & (midi >= MIDI_MIN - 0.5) & (midi <= MIDI_MAX + 0.5)
    notes: list[dict] = []
    start = -1
    values: list[float] = []

    def close(end: int) -> None:
        if start < 0 or not values:
            return
        if (end - start) * hop_s < MIN_NOTE_SECONDS:
            return
        note = int(round(float(np.median(values))))
        notes.append(
            {
                "start": round(start * hop_s, 3),
                "end": round(end * hop_s, 3),
                "midi": note,
                "conf": round(float(np.mean(periodicity[start:end])), 3),
            }
        )

    for i, ok in enumerate(voiced):
        if not ok:
            close(i)
            start, values = -1, []
            continue
        if start >= 0 and abs(midi[i] - float(np.median(values))) > SPLIT_SEMITONES:
            close(i)
            start, values = -1, []
        if start < 0:
            start = i
        values.append(float(midi[i]))
    close(len(voiced))

    joined: list[dict] = []
    for note in notes:
        last = joined[-1] if joined else None
        if last and last["midi"] == note["midi"] and note["start"] - last["end"] < JOIN_GAP_SECONDS:
            last["end"] = note["end"]
            last["conf"] = round((last["conf"] + note["conf"]) / 2, 3)
        else:
            joined.append(note)
    return joined
