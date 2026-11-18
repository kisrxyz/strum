"""Song sections (intro, verse, chorus…) from the bars, their chords and where the voice sings.

An experiment (plan decision 19): 4-bar phrases are grouped by how alike their chords are, and a
section ends where the chords or the singing change. Sung sections: the repeated group that is
loudest is the chorus, the rest are verses. Instrumental ones: the first is the intro, the last
the outro, those in between a solo when the guitar stands out, else a bridge. Without the vocal
stem only the chord groups are known: Part 1, Part 2…

`name` is English and only a fallback: the app names a section by its `kind` in the user's language.
"""

from __future__ import annotations

import numpy as np

from .harmony import simple_label

PHRASE = 4  # bars
ALIKE = 0.75  # share of beats with the same chord for two phrases to be the same part
QUIET_DB = -100.0
VOICE_BELOW_LOUD_DB = 18.0  # a bar has singing when its vocal stem is at most this far below the loud bars
VOICE_FLOOR_DB = -40.0  # ...and above this (separation leaves some voice in every stem)
PICKUP_DB = 6.0  # a sung bar this much quieter than its neighbours is a pickup or a fade, not the part
SOLO_DB = 3.0  # the guitar this much above its median makes an instrumental part a solo

NAMES = {
    "intro": "Intro",
    "verse": "Verse",
    "chorus": "Chorus",
    "bridge": "Bridge",
    "solo": "Solo",
    "outro": "Outro",
    "other": "Part",
}
ALWAYS_NUMBERED = {"verse", "chorus", "other"}

Bars = list[tuple[float, float]]


def bar_levels(x: np.ndarray, sr: int, bars: Bars) -> list[float]:
    """RMS level of each bar, dB (−100 for silence or a bar past the end of the recording)."""
    mono = np.asarray(x, dtype=np.float32)
    if mono.ndim == 2:
        mono = mono.mean(axis=1)
    levels = []
    for start, end in bars:
        piece = mono[max(0, int(round(start * sr))) : max(0, int(round(end * sr)))]
        power = float(np.mean(np.square(piece, dtype=np.float64))) if len(piece) else 0.0
        levels.append(max(QUIET_DB, 10 * np.log10(power)) if power > 0 else QUIET_DB)
    return levels


def _chord_at(chords: list[dict], starts: list[float], t: float) -> str:
    k = int(np.searchsorted(starts, t, side="right")) - 1
    if k < 0 or k >= len(chords) or t >= float(chords[k]["end"]):
        return "N"
    return str(chords[k]["chord"])


def bar_patterns(bars: Bars, beats: np.ndarray, chords: list[dict]) -> list[str]:
    """The chord on each beat of each bar, simplified to major or minor, joined by spaces:
    'A:min A:min F F'. Each beat is read in its middle, so a change on the beat counts."""
    beats = np.sort(np.asarray(beats, dtype=np.float64).ravel())
    chords = sorted(chords, key=lambda c: float(c["start"]))
    starts = [float(c["start"]) for c in chords]
    patterns = []
    for start, end in bars:
        inside = [float(b) for b in beats if start - 1e-6 <= b < end - 1e-6] or [start]
        edges = inside + [end]
        labels = [simple_label(_chord_at(chords, starts, (a + b) / 2)) for a, b in zip(edges, edges[1:])]
        patterns.append(" ".join(labels))
    return patterns


def _same(x: str, y: str) -> float:
    """1 for the same chord; ½ for the same root as major and minor (the chord model often hears
    one for the other); 0 otherwise."""
    if x == y:
        return 1.0
    if x in ("N", "X") or y in ("N", "X"):
        return 0.0
    return 0.5 if x.split(":")[0] == y.split(":")[0] else 0.0


def _similarity(a: list[str], b: list[str]) -> float:
    """Share of beats with the same chord. One phrase may be shifted against the other by up to
    a bar: the beat tracker sometimes puts a bar line in the middle of a bar, and the same chords
    then come a few beats early or late."""
    beats_a = " ".join(a).split()
    beats_b = " ".join(b).split()
    longest = max(len(beats_a), len(beats_b))
    if not longest:
        return 1.0
    bar = max(1, round(len(beats_a) / max(1, len(a))))
    best = 0.0
    for shift in range(-bar, bar + 1):
        pairs = zip(beats_a[max(0, shift) :], beats_b[max(0, -shift) :])
        best = max(best, sum(_same(x, y) for x, y in pairs))
    return best / longest


def _runs(values: list) -> list[tuple[int, int]]:
    """[start, end) index ranges of equal consecutive values."""
    runs, start = [], 0
    for i in range(1, len(values) + 1):
        if i == len(values) or values[i] != values[start]:
            runs.append((start, i))
            start = i
    return runs


def _singing(vocal_db: list[float]) -> list[bool]:
    levels = np.asarray(vocal_db, dtype=np.float64)
    loud = float(np.percentile(levels, 90))
    sung = list(levels > max(VOICE_FLOOR_DB, loud - VOICE_BELOW_LOUD_DB))
    # a bar on its own (a breath, a shout) does not make or break a part
    for start, end in _runs(sung):
        if end - start == 1 and len(sung) > 1:
            sung[start] = sung[start - 1] if start > 0 else sung[end]
    # a quiet sung bar at either end of a sung run is a pickup or a fade-out
    for start, end in _runs(sung):
        if not sung[start] or end - start < 3:
            continue
        typical = float(np.median(levels[start:end]))
        if start > 0 and levels[start] < typical - PICKUP_DB:
            sung[start] = False
        if end < len(sung) and levels[end - 1] < typical - PICKUP_DB:
            sung[end - 1] = False
    return sung


def _phrases(spans: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Cuts each span of bars into 4-bar phrases; a single bar left over joins the one before."""
    phrases = []
    for start, end in spans:
        cuts = list(range(start, end, PHRASE)) + [end]
        pieces = list(zip(cuts, cuts[1:]))
        if len(pieces) > 1 and pieces[-1][1] - pieces[-1][0] == 1:
            pieces[-2:] = [(pieces[-2][0], pieces[-1][1])]
        phrases.extend(pieces)
    return phrases


def _classes(phrases: list[tuple[int, int]], patterns: list[str]) -> list[int]:
    """Groups phrases whose chords are alike; each group is named by its first phrase."""
    groups: list[list[str]] = []
    out = []
    for start, end in phrases:
        bars = patterns[start:end]
        scores = [_similarity(bars, group) for group in groups]
        best = int(np.argmax(scores)) if scores else -1
        if best >= 0 and scores[best] >= ALIKE:
            out.append(best)
        else:
            groups.append(bars)
            out.append(len(groups) - 1)
    return out


def _name(kinds: list[str]) -> list[str]:
    totals = {kind: kinds.count(kind) for kind in set(kinds)}
    seen: dict[str, int] = {}
    names = []
    for kind in kinds:
        seen[kind] = seen.get(kind, 0) + 1
        numbered = kind in ALWAYS_NUMBERED or totals[kind] > 1
        names.append(f"{NAMES[kind]} {seen[kind]}" if numbered else NAMES[kind])
    return names


def find_sections(
    bars: Bars,
    patterns: list[str],
    energy_db: list[float],
    vocal_db: list[float] | None,
    guitar_db: list[float] | None,
) -> list[dict]:
    """[{start, end, kind, name}] covering the bars, in order. Kinds: intro verse chorus bridge solo
    outro, or 'other' when there is no vocal stem to tell them apart."""
    n = len(bars)
    if not n or len(patterns) != n:
        return []
    energy = np.asarray(energy_db if len(energy_db) == n else [0.0] * n, dtype=np.float64)
    voiced = vocal_db is not None and len(vocal_db) == n
    sung = _singing(list(vocal_db)) if voiced else [False] * n

    phrases = _phrases(_runs(sung))
    classes = _classes(phrases, patterns)
    # a part = consecutive phrases of one group, all sung or all not
    parts: list[tuple[int, int, int, bool]] = []  # first bar, end bar, group, sung
    for (start, end), group in zip(phrases, classes):
        if parts and parts[-1][2] == group and parts[-1][3] == sung[start] and parts[-1][1] == start:
            parts[-1] = (parts[-1][0], end, group, sung[start])
        else:
            parts.append((start, end, group, sung[start]))

    if not voiced:
        if len(parts) > max(2, len(phrases) / 2):
            return []  # hardly anything repeats: these would be chord noise, not parts of a song
        kinds = ["other"] * len(parts)
    else:
        kinds = _kinds(parts, energy, guitar_db if guitar_db is not None and len(guitar_db) == n else None)
        # neighbours of one kind are one section (a verse of two different phrases, say)
        merged: list[tuple[int, int, int, bool]] = []
        merged_kinds: list[str] = []
        for part, kind in zip(parts, kinds):
            if merged_kinds and merged_kinds[-1] == kind:
                merged[-1] = (merged[-1][0], part[1], merged[-1][2], merged[-1][3])
            else:
                merged.append(part)
                merged_kinds.append(kind)
        parts, kinds = merged, merged_kinds

    return [
        {"start": round(float(bars[start][0]), 3), "end": round(float(bars[end - 1][1]), 3), "kind": kind, "name": name}
        for (start, end, _, _), kind, name in zip(parts, kinds, _name(kinds))
    ]


def _kinds(parts: list[tuple[int, int, int, bool]], energy: np.ndarray, guitar_db: list[float] | None) -> list[str]:
    sung_groups = [group for _, _, group, sung in parts if sung]
    repeated = {group for group in sung_groups if sung_groups.count(group) > 1}
    chorus = None
    if len(set(sung_groups)) > 1 and repeated:
        def loudness(group: int) -> float:
            return float(np.mean(np.concatenate([energy[a:b] for a, b, g, s in parts if g == group and s])))

        chorus = max(sorted(repeated), key=loudness)
    guitar = np.asarray(guitar_db, dtype=np.float64) if guitar_db is not None else None
    median_guitar = float(np.median(guitar)) if guitar is not None else 0.0

    kinds = []
    for index, (start, end, group, sung) in enumerate(parts):
        if sung:
            kinds.append("chorus" if group == chorus else "verse")
        elif index == 0:
            kinds.append("intro")
        elif index == len(parts) - 1:
            kinds.append("outro")
        elif guitar is not None and float(np.mean(guitar[start:end])) >= median_guitar + SOLO_DB:
            kinds.append("solo")
        else:
            kinds.append("bridge")
    return kinds
