"""Tempo, meter and bars from the beats a beat tracker found (seconds, ascending)."""

from __future__ import annotations

from collections import Counter

import numpy as np

DEFAULT_METER = 4
METERS = range(2, 8)  # beats per bar a song may have
MATCH = 0.05  # s: a downbeat this close to a beat is that beat


def _sorted(values) -> np.ndarray:
    return np.sort(np.asarray(values, dtype=np.float64).ravel())


def tempo_and_meter(beats: np.ndarray, downbeats: np.ndarray) -> tuple[float, int]:
    """(BPM, beats per bar). BPM comes from the median beat interval, 0.0 with fewer than 2 beats.
    The meter is the most common number of beats between consecutive downbeats within 2–7, else 4."""
    beats = _sorted(beats)
    intervals = np.diff(beats)
    intervals = intervals[intervals > 0]
    tempo = round(60.0 / float(np.median(intervals)), 1) if len(intervals) else 0.0

    downbeats = _sorted(downbeats)
    counts = Counter()
    for start, end in zip(downbeats, downbeats[1:]):
        count = int(np.searchsorted(beats, end - MATCH) - np.searchsorted(beats, start - MATCH))
        if count in METERS:
            counts[count] += 1
    if not counts:
        return tempo, DEFAULT_METER
    # ties go to 4, then 3: the common meters
    meter = max(counts, key=lambda m: (counts[m], m == 4, m == 3, -m))
    return tempo, meter


def bar_spans(beats: np.ndarray, downbeats: np.ndarray, meter: int, duration: float) -> list[tuple[float, float]]:
    """(start, end) of every whole bar: from one downbeat to the next. Without downbeats, groups of
    `meter` beats from the first beat. The last bar is as long as the song's bars usually are, but
    never past the end. Fewer than 4 beats give no bars (a pickup before the first downbeat is
    not a bar either)."""
    beats = _sorted(beats)
    if len(beats) < 4:
        return []
    downbeats = _sorted(downbeats)
    starts = list(downbeats) if len(downbeats) else list(beats[:: max(1, meter)])
    beat = float(np.median(np.diff(beats)))
    bar_length = float(np.median(np.diff(starts))) if len(starts) > 1 else meter * beat
    spans = [(float(a), float(b)) for a, b in zip(starts, starts[1:]) if b > a]
    last = float(starts[-1])
    end = min(duration, last + bar_length) if duration > 0 else last + bar_length
    if end - last > beat / 2:
        spans.append((last, end))
    return spans
