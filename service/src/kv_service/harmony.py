"""Chords as the chord model hears them, cleaned up for playing along, and the song's key.

Chord labels are BTC's (Harte) notation: 'N' (no chord), 'X' (unknown), a root with sharps for
major ('C', 'F#') or root:quality ('A:min', 'G:7', 'B:hdim7'). Segments are dicts
{start, end, chord} in seconds.
"""

from __future__ import annotations

import re

import numpy as np

ROOTS = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
INTERVALS: dict[str, tuple[int, ...]] = {
    "maj": (0, 4, 7),
    "min": (0, 3, 7),
    "dim": (0, 3, 6),
    "aug": (0, 4, 8),
    "min6": (0, 3, 7, 9),
    "maj6": (0, 4, 7, 9),
    "min7": (0, 3, 7, 10),
    "minmaj7": (0, 3, 7, 11),
    "maj7": (0, 4, 7, 11),
    "7": (0, 4, 7, 10),
    "dim7": (0, 3, 6, 9),
    "hdim7": (0, 3, 6, 10),
    "sus2": (0, 2, 7),
    "sus4": (0, 5, 7),
}
MINORISH = {"min", "min6", "min7", "minmaj7", "dim", "dim7", "hdim7"}
LABEL_RE = re.compile(r"^([A-G])([#b]?)(?::(\w+))?$")
NO_CHORD = ("N", "X")

SNAP = 0.3  # a change this close to a beat (share of the beat interval) moves onto it
SHORTEST = 0.5  # pieces shorter than this share of a beat go to a neighbour
FLICKER = 1.0  # a piece shorter than this many beats next to a chord on the same root joins it
DEFAULT_BEAT = 0.5  # s, when there are no beats to go by


def parse_chord(label: str) -> tuple[int, str] | None:
    """'C#:min' → (1, 'min'); 'G' → (7, 'maj'); 'N', 'X' and anything else → None."""
    match = LABEL_RE.match(label or "")
    if not match:
        return None
    letter, accidental, quality = match.groups()
    quality = quality or "maj"
    if quality not in INTERVALS:
        return None
    root = ROOTS.index(letter) + {"#": 1, "b": -1}.get(accidental, 0)
    return root % 12, quality


def chord_tones(root: int, quality: str) -> list[int]:
    """Pitch classes of the chord, root first."""
    return [(root + step) % 12 for step in INTERVALS[quality]]


def simple_label(label: str) -> str:
    """The chord as a plain major or minor triad (as the app's «простые аккорды»): A:min7 → A:min,
    G:7 → G, B:dim → B:min, D:sus4 → D. N and X stay."""
    chord = parse_chord(label)
    if chord is None:
        return label if label in NO_CHORD else "X"
    root, quality = chord
    return f"{ROOTS[root]}:min" if quality in MINORISH else ROOTS[root]


# ---- clean-up


class _Beats:
    def __init__(self, beats: np.ndarray):
        self.times = np.sort(np.asarray(beats, dtype=np.float64).ravel())
        gaps = np.diff(self.times)
        self.median = float(np.median(gaps)) if len(gaps) else DEFAULT_BEAT

    def interval_at(self, t):
        """The beat interval around `t` (a number or an array of them)."""
        times = self.times
        if len(times) < 2:
            return np.full(np.shape(t), self.median) if np.ndim(t) else self.median
        k = np.clip(np.searchsorted(times, t), 1, len(times) - 1)
        gaps = times[k] - times[k - 1]
        return gaps if np.ndim(t) else float(gaps)

    def snap(self, t: float) -> float:
        times = self.times
        if len(times) < 2:
            return t
        k = int(np.searchsorted(times, t))
        candidates = [i for i in (k - 1, k) if 0 <= i < len(times)]
        nearest = min(candidates, key=lambda i: abs(times[i] - t))
        if abs(times[nearest] - t) <= SNAP * self.interval_at(float(times[nearest])):
            return float(times[nearest])
        return t


def _contiguous(segments: list[dict], duration: float) -> list[list]:
    """[start, end, chord] lists from 0 to `duration`; gaps become 'N', overlaps are cut."""
    out: list[list] = []
    t = 0.0
    for seg in sorted(segments, key=lambda s: float(s["start"])):
        start = min(max(float(seg["start"]), 0.0), duration)
        end = min(max(float(seg["end"]), 0.0), duration)
        start = max(start, t)
        if end <= start:
            continue
        if start > t:
            out.append([t, start, "N"])
        out.append([start, end, str(seg["chord"])])
        t = end
    if t < duration:
        out.append([t, duration, "N"])
    return out


def _merge_equal(pieces: list[list]) -> list[list]:
    out: list[list] = []
    for piece in pieces:
        if out and out[-1][2] == piece[2]:
            out[-1][1] = piece[1]
        else:
            out.append(list(piece))
    return out


def _join_flickers(starts: np.ndarray, ends: np.ndarray, labels: list[str], grid: "_Beats"):
    """Pieces shorter than FLICKER beats next to a chord on the same root become that chord
    (the longer such neighbour), shortest first."""
    root = lambda label: (parsed[0] if (parsed := parse_chord(label)) else None)  # noqa: E731
    while len(labels) > 1:
        lengths = ends - starts
        beats_long = lengths / grid.interval_at((starts + ends) / 2)
        best = None
        for i in np.argsort(beats_long):
            if beats_long[i] >= FLICKER:
                break
            mine = root(labels[i])
            near = [j for j in (i - 1, i + 1) if mine is not None and 0 <= j < len(labels) and root(labels[j]) == mine]
            if near:
                best = (int(i), max(near, key=lambda j: lengths[j]))
                break
        if best is None:
            break
        i, j = best
        if j < i:
            ends[j] = ends[i]
        else:
            starts[j] = starts[i]
        starts, ends = np.delete(starts, i), np.delete(ends, i)
        del labels[i]
        k = j if j < i else j - 1
        # the chord that grew may now meet an equal one on its other side
        for a, b in ((k - 1, k), (k, k + 1)):
            if 0 <= a and b < len(labels) and labels[a] == labels[b]:
                ends[a] = ends[b]
                starts, ends = np.delete(starts, b), np.delete(ends, b)
                del labels[b]
                break
    return starts, ends, labels


def clean_chords(segments: list[dict], beats: np.ndarray, duration: float) -> list[dict]:
    """Chords to play along with: one contiguous track from 0 to `duration`.

    Changes within 30 % of the local beat interval move onto the nearest beat; pieces shorter
    than half a beat go to the longer neighbour; a piece shorter than a beat next to a chord on
    the same root joins it (BTC flickers: D7 for 0.3 s before D); equal neighbours merge.
    'N' (no chord) stays a chord of its own.
    """
    if duration <= 0:
        return []
    grid = _Beats(beats)
    pieces = _merge_equal(_contiguous(segments, duration))
    # snap every change, keeping them in order
    for i in range(1, len(pieces)):
        t = max(grid.snap(pieces[i][0]), pieces[i - 1][0])
        pieces[i - 1][1] = pieces[i][0] = min(t, duration)
    pieces = _merge_equal([p for p in pieces if p[1] > p[0]])
    # fold short pieces, shortest first (in beats), into their longer neighbour
    starts = np.array([p[0] for p in pieces], dtype=np.float64)
    ends = np.array([p[1] for p in pieces], dtype=np.float64)
    labels = [p[2] for p in pieces]
    while len(labels) > 1:
        lengths = ends - starts
        beats_long = lengths / grid.interval_at((starts + ends) / 2)
        i = int(np.argmin(beats_long))
        if beats_long[i] >= SHORTEST:
            break
        left = lengths[i - 1] if i > 0 else -1.0
        right = lengths[i + 1] if i + 1 < len(labels) else -1.0
        if left >= right:
            ends[i - 1] = ends[i]
        else:
            starts[i + 1] = starts[i]
        starts, ends = np.delete(starts, i), np.delete(ends, i)
        del labels[i]
        # the neighbours that just met may hold the same chord
        if 0 < i < len(labels) and labels[i - 1] == labels[i]:
            ends[i - 1] = ends[i]
            starts, ends = np.delete(starts, i), np.delete(ends, i)
            del labels[i]
    starts, ends, labels = _join_flickers(starts, ends, labels, grid)
    return [
        {"start": round(float(a), 3), "end": round(float(b), 3), "chord": c} for a, b, c in zip(starts, ends, labels)
    ]


# ---- key

MAJOR_SCALE = frozenset({0, 2, 4, 5, 7, 9, 11})
MINOR_SCALE = frozenset({0, 2, 3, 5, 7, 8, 10})  # natural minor
LEADING_TONE = 11  # minor keys also take the major V and V7 (harmonic minor)
TONIC_WEIGHT = 0.5  # time on the key's own chord counts this much extra
EDGE_WEIGHT = 0.1  # the first and the last chord being the tonic: this share of the song each
EDGE_SECONDS = 1.0  # shorter chords at the edges are slips, not the first or last chord
MIN_SECONDS = 4.0


def _fit(tones: list[int], root: int, tonic: int, mode: str) -> float:
    """Share of the chord's tones that belong to the key."""
    allowed = set(MAJOR_SCALE if mode == "major" else MINOR_SCALE)
    if mode == "minor" and (root - tonic) % 12 == 7:
        allowed.add(LEADING_TONE)
    return sum((t - tonic) % 12 in allowed for t in tones) / len(tones)


def _is_tonic(root: int, quality: str, tonic: int, mode: str) -> bool:
    return root == tonic and (quality in MINORISH) == (mode == "minor") and quality not in ("dim", "dim7", "hdim7")


def estimate_key(segments: list[dict]) -> dict | None:
    """{tonic: 0–11, mode: 'major'|'minor', confidence: 0–1}, or None with less than 4 s of
    chords (N and X do not count).

    Each of the 24 keys scores the time its chords fit in (minor keys accept the major V and V7),
    plus extra for time on its tonic chord and for the song starting or ending on it. Confidence
    is how clearly the best key beats the runner-up, times how well its chords fit.
    """
    chords = []
    for seg in segments:
        parsed = parse_chord(str(seg.get("chord")))
        length = float(seg["end"]) - float(seg["start"])
        if parsed and length > 0:
            chords.append((parsed[0], parsed[1], chord_tones(*parsed), length))
    total = sum(c[3] for c in chords)
    if total < MIN_SECONDS:
        return None
    edges = [c for c in chords if c[3] >= EDGE_SECONDS] or chords
    first, last = edges[0], edges[-1]

    scores: dict[tuple[int, str], float] = {}
    fits: dict[tuple[int, str], float] = {}
    for tonic in range(12):
        for mode in ("major", "minor"):
            fit = sum(length * _fit(tones, root, tonic, mode) for root, _, tones, length in chords)
            on_tonic = sum(length for root, quality, _, length in chords if _is_tonic(root, quality, tonic, mode))
            edge = sum(EDGE_WEIGHT * total for c in (first, last) if _is_tonic(c[0], c[1], tonic, mode))
            scores[(tonic, mode)] = fit + TONIC_WEIGHT * on_tonic + edge
            fits[(tonic, mode)] = fit / total
    ranked = sorted(scores, key=lambda k: scores[k], reverse=True)
    best, second = ranked[0], ranked[1]
    margin = (scores[best] - scores[second]) / (0.25 * total)
    confidence = min(1.0, max(0.0, margin)) * fits[best]
    return {"tonic": best[0], "mode": best[1], "confidence": round(confidence, 2)}
