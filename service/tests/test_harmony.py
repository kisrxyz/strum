import numpy as np
import pytest

from kv_service.harmony import chord_tones, clean_chords, estimate_key, parse_chord, simple_label

BEATS = np.arange(0.0, 10.01, 0.5)


def seg(chord: str, start: float, end: float) -> dict:
    return {"start": start, "end": end, "chord": chord}


def progression(labels: list[str], rounds: int = 4, length: float = 2.0) -> list[dict]:
    out = []
    for k in range(rounds * len(labels)):
        out.append(seg(labels[k % len(labels)], k * length, (k + 1) * length))
    return out


def assert_contiguous(chords: list[dict], duration: float) -> None:
    assert chords[0]["start"] == 0.0
    assert chords[-1]["end"] == pytest.approx(duration)
    for a, b in zip(chords, chords[1:]):
        assert a["end"] == b["start"]
        assert a["chord"] != b["chord"]
        assert a["end"] > a["start"]


def test_clean_chords_snaps_and_folds():
    raw = [seg("C", 0.0, 1.93), seg("G", 1.93, 2.05), seg("A:min", 2.05, 4.0)]
    assert clean_chords(raw, BEATS, 4.0) == [seg("C", 0.0, 2.0), seg("A:min", 2.0, 4.0)]


def test_no_chord_stays_a_chord_of_its_own_and_the_song_is_covered():
    # a gap between 4.4 and 5.6 and the end after 7.2 are filled with no chord
    raw = [seg("N", 0.0, 0.62), seg("C", 0.62, 3.1), seg("C", 3.1, 4.4), seg("G", 5.6, 7.2)]
    chords = clean_chords(raw, BEATS, 8.0)
    assert chords[0] == seg("N", 0.0, 0.5)
    assert chords[1] == seg("C", 0.5, 4.5)  # 4.4 is 0.1 s from 4.5: within 30 % of a beat
    assert chords[2] == seg("N", 4.5, 5.5)
    assert chords[3] == seg("G", 5.5, 7.2)  # 7.2 is 0.2 s from 7.0: too far to move
    assert_contiguous(chords, 8.0)
    assert [c["chord"] for c in chords] == ["N", "C", "N", "G", "N"]


def test_boundaries_far_from_a_beat_stay_where_they_are():
    chords = clean_chords([seg("C", 0.0, 2.25), seg("G", 2.25, 4.0)], BEATS, 4.0)
    assert chords == [seg("C", 0.0, 2.25), seg("G", 2.25, 4.0)]


def test_short_fragments_go_to_the_longer_neighbour():
    raw = [seg("C", 0.0, 2.0), seg("D", 2.0, 2.2), seg("G", 2.2, 3.0)]
    chords = clean_chords(raw, BEATS, 3.0)
    assert [c["chord"] for c in chords] == ["C", "G"]
    assert_contiguous(chords, 3.0)
    # a fragment between two equal chords disappears into them
    chords = clean_chords([seg("C", 0.0, 2.0), seg("E:min", 2.0, 2.2), seg("C", 2.2, 4.0)], BEATS, 4.0)
    assert chords == [seg("C", 0.0, 4.0)]


def test_a_short_flicker_of_the_same_root_joins_its_neighbour():
    # BTC heard «D7» for 0.3 s right before D (a real case in «Кайен»): it is the same chord
    out = clean_chords([seg("A:min", 0, 2), seg("D:7", 2.0, 2.3), seg("D", 2.3, 4.0), seg("E:min", 4.0, 6.0)], BEATS, 6.0)
    assert [(c["chord"], c["start"], c["end"]) for c in out] == [("A:min", 0.0, 2.0), ("D", 2.0, 4.0), ("E:min", 4.0, 6.0)]


def test_a_short_chord_with_another_root_stays():
    out = clean_chords([seg("C", 0, 2), seg("G", 2.0, 2.3), seg("A:min", 2.3, 4.0)], BEATS, 4.0)
    assert [c["chord"] for c in out] == ["C", "G", "A:min"]


def test_clean_chords_without_beats_and_without_chords():
    chords = clean_chords([seg("C", 0.0, 1.93), seg("G", 1.93, 4.0)], np.zeros(0), 4.0)
    assert chords == [seg("C", 0.0, 1.93), seg("G", 1.93, 4.0)]
    assert clean_chords([], BEATS, 3.0) == [seg("N", 0.0, 3.0)]
    assert clean_chords([seg("C", 0.0, 1.0)], BEATS, 0.0) == []


def test_key_minor_progression():
    key = estimate_key(progression(["A:min", "F", "C", "G"]))
    assert (key["tonic"], key["mode"]) == (9, "minor")
    assert 0 < key["confidence"] <= 1
    key = estimate_key(progression(["C", "G", "A:min", "F"]))
    assert (key["tonic"], key["mode"]) == (0, "major")
    key = estimate_key(progression(["E:min", "A:min", "B:7"]))
    assert (key["tonic"], key["mode"]) == (4, "minor")
    assert estimate_key([seg("N", 0.0, 30.0)]) is None


def test_key_needs_four_seconds_of_chords():
    assert estimate_key([seg("N", 0.0, 10.0), seg("C", 10.0, 11.5), seg("G", 11.5, 13.0)]) is None
    assert estimate_key([seg("X", 0.0, 10.0), seg("C", 10.0, 12.0), seg("G", 12.0, 14.0)]) is not None


def test_key_ignores_silence_at_the_edges_and_a_clear_key_is_confident():
    song = progression(["D", "G", "A:7", "D"], rounds=3)  # 0–24 s
    for c in song:
        c["start"] += 3.0
        c["end"] += 3.0
    key = estimate_key([seg("N", 0.0, 3.0), *song, seg("N", 27.0, 33.0)])
    assert (key["tonic"], key["mode"]) == (2, "major")
    assert key["confidence"] > 0.6


def test_chord_labels():
    assert parse_chord("C#:min") == (1, "min")
    assert parse_chord("G") == (7, "maj")
    assert parse_chord("B:hdim7") == (11, "hdim7")
    assert parse_chord("N") is None
    assert parse_chord("X") is None
    assert parse_chord("H") is None
    assert chord_tones(9, "min") == [9, 0, 4]
    assert chord_tones(7, "7") == [7, 11, 2, 5]
    assert simple_label("A:min7") == "A:min"
    assert simple_label("G:7") == "G"
    assert simple_label("B:dim") == "B:min"
    assert simple_label("D:sus4") == "D"
    assert simple_label("N") == "N"
