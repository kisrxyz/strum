import numpy as np
import pytest

from conftest import SR
from kv_service.sections import bar_levels, bar_patterns, find_sections

VERSE = "A:min F C G"
CHORUS = "F G C A:min"


def form(parts: list[tuple[str, int, bool, float, float]]):
    """Bars of 2 s: (pattern, bars, sung, extra dB of the mix, extra dB of the guitar) per part."""
    bars, patterns, energy, vocals, guitar = [], [], [], [], []
    for pattern, count, sung, loud, lead in parts:
        for _ in range(count):
            start = 2.0 * len(bars)
            bars.append((start, start + 2.0))
            patterns.append(pattern)
            energy.append(-20.0 + loud)
            vocals.append(-18.0 if sung else -70.0)
            guitar.append(-25.0 + lead)
    return bars, patterns, energy, vocals, guitar


POP = [(VERSE, 4, False, 0, 0), (VERSE, 8, True, 0, 0), (CHORUS, 8, True, 4, 0),
       (VERSE, 8, True, 0, 0), (CHORUS, 8, True, 4, 0), (CHORUS, 4, False, 0, 0)]


def spans(sections: list[dict]) -> list[tuple[float, float]]:
    return [(s["start"], s["end"]) for s in sections]


def assert_covers(sections: list[dict], bars: list[tuple[float, float]]) -> None:
    assert sections[0]["start"] == bars[0][0]
    assert sections[-1]["end"] == bars[-1][1]
    for a, b in zip(sections, sections[1:]):
        assert a["end"] == b["start"]


def test_sections_pop_form():
    bars, patterns, energy, vocals, guitar = form(POP)
    sections = find_sections(bars, patterns, energy, vocals, guitar)
    assert [s["kind"] for s in sections] == ["intro", "verse", "chorus", "verse", "chorus", "outro"]
    assert [s["name"] for s in sections] == ["Intro", "Verse 1", "Chorus 1", "Verse 2", "Chorus 2", "Outro"]
    assert spans(sections) == [(0, 8), (8, 24), (24, 40), (40, 56), (56, 72), (72, 80)]


def test_sections_without_vocals_are_numbered_parts():
    bars, patterns, energy, _, _ = form(POP)
    sections = find_sections(bars, patterns, energy, None, None)
    assert {s["kind"] for s in sections} == {"other"}
    assert [s["name"] for s in sections] == [f"Part {i + 1}" for i in range(len(sections))]
    assert len(sections) >= 2
    assert_covers(sections, bars)


def test_without_vocals_and_without_repeats_there_are_no_parts():
    roots = ["C", "D", "E", "F", "G", "A", "B", "C#"]
    bars, patterns, energy, _, _ = form([(f"{root} {root}:min {root} {root}:min", 4, False, 0, 0) for root in roots])
    assert find_sections(bars, patterns, energy, None, None) == []


def test_chords_heard_a_little_differently_or_a_beat_late_are_the_same_part():
    late = "G A:min F C"  # the verse a beat late, as when the beat tracker misplaces a bar line
    minor_for_major = "A:min F:min C G:min"  # the chord model heard F and G as minor
    parts = [(VERSE, 8, False, 0, 0), (late, 8, False, 0, 0), (minor_for_major, 8, False, 0, 0), (CHORUS, 8, False, 0, 0)]
    bars, patterns, energy, _, _ = form(parts)
    assert spans(find_sections(bars, patterns, energy, None, None)) == [(0, 48), (48, 64)]


def test_no_bars_no_sections():
    assert find_sections([], [], [], None, None) == []
    assert find_sections([], [], [], [], []) == []


def test_loud_guitar_in_the_middle_is_a_solo_otherwise_a_bridge():
    parts = [(VERSE, 8, True, 0, 0), ("E", 8, False, 0, 6), (VERSE, 8, True, 0, 0), ("D", 4, False, 0, 0),
             (VERSE, 8, True, 0, 0)]
    sections = find_sections(*form(parts))
    assert [s["kind"] for s in sections] == ["verse", "solo", "verse", "bridge", "verse"]
    assert [s["name"] for s in sections] == ["Verse 1", "Solo", "Verse 2", "Bridge", "Verse 3"]


def test_a_bar_without_singing_does_not_split_a_verse():
    bars, patterns, energy, vocals, guitar = form(POP)
    vocals[7] = -70.0  # the singer takes a breath for a whole bar of the first verse
    sections = find_sections(bars, patterns, energy, vocals, guitar)
    assert [s["kind"] for s in sections] == ["intro", "verse", "chorus", "verse", "chorus", "outro"]


def test_a_pickup_before_the_verse_stays_in_the_intro():
    bars, patterns, energy, vocals, guitar = form(POP)
    vocals[3] = -30.0  # the singer comes in on the last beat of the intro
    sections = find_sections(bars, patterns, energy, vocals, guitar)
    assert spans(sections)[:2] == [(0, 8), (8, 24)]


def test_parts_that_come_twice_are_numbered():
    parts = [(VERSE, 4, False, 0, 0), (VERSE, 8, True, 0, 0), (CHORUS, 4, False, 0, 0), (VERSE, 8, True, 0, 0),
             (CHORUS, 4, False, 0, 0), (VERSE, 8, True, 0, 0)]
    names = [s["name"] for s in find_sections(*form(parts))]
    assert names == ["Intro", "Verse 1", "Bridge 1", "Verse 2", "Bridge 2", "Verse 3"]


def test_bar_levels_and_patterns():
    t = np.arange(4 * SR) / SR
    x = np.where(t < 2.0, 0.5, 0.05) * np.sin(2 * np.pi * 220 * t)
    levels = bar_levels(x, SR, [(0.0, 2.0), (2.0, 4.0), (4.0, 6.0)])
    assert levels[0] == pytest.approx(20 * np.log10(0.5 / np.sqrt(2)), abs=0.1)
    assert levels[1] == pytest.approx(levels[0] - 20, abs=0.1)
    assert levels[2] <= -90  # past the end of the recording: silence
    stereo = np.repeat(x[:, None], 2, axis=1)
    assert bar_levels(stereo, SR, [(0.0, 2.0)])[0] == pytest.approx(levels[0], abs=0.01)

    beats = np.arange(0.0, 4.0, 0.5)
    chords = [{"start": 0.0, "end": 1.0, "chord": "A:min7"}, {"start": 1.0, "end": 2.0, "chord": "F:maj7"},
              {"start": 2.0, "end": 4.0, "chord": "N"}]
    assert bar_patterns([(0.0, 2.0), (2.0, 4.0)], beats, chords) == ["A:min A:min F F", "N N N N"]
