import numpy as np
import pytest

from kv_service.rhythm import bar_spans, tempo_and_meter

BEATS = np.arange(0.0, 20.0, 0.5)


def test_tempo_meter_steady_4_4():
    tempo, meter = tempo_and_meter(BEATS, BEATS[::4])
    assert tempo == pytest.approx(120.0, abs=0.5)
    assert meter == 4
    assert tempo_and_meter(BEATS, BEATS[::3]) == (pytest.approx(120.0, abs=0.5), 3)


def test_tempo_meter_few_beats():
    assert tempo_and_meter(np.zeros(0), np.zeros(0)) == (0.0, 4)
    assert tempo_and_meter(np.array([1.0]), np.array([1.0])) == (0.0, 4)


def test_tempo_is_the_median_and_meter_the_most_common_bar():
    rng = np.random.default_rng(0)
    beats = BEATS + rng.normal(0, 0.01, len(BEATS))
    # one stray downbeat in the middle of a bar makes two bars of 2 beats among nine of 4
    downbeats = np.sort(np.append(beats[::4], beats[10]))
    tempo, meter = tempo_and_meter(beats, downbeats)
    assert tempo == pytest.approx(120.0, abs=2)
    assert meter == 4


def test_meter_without_usable_downbeats_is_4():
    assert tempo_and_meter(BEATS, np.zeros(0))[1] == 4
    assert tempo_and_meter(BEATS, BEATS[::8])[1] == 4  # 8 beats per bar is outside 2–7
    assert tempo_and_meter(BEATS, BEATS[:1])[1] == 4


def test_bar_spans_follow_the_downbeats():
    bars = bar_spans(BEATS, BEATS[1::4], 4, 20.0)
    assert bars[0] == pytest.approx((0.5, 2.5))
    assert bars[1] == pytest.approx((2.5, 4.5))
    # the last bar is as long as a bar of the song, but never past its end
    assert bars[-1] == pytest.approx((18.5, 20.0))
    assert len(bars) == 10


def test_bar_spans_without_downbeats_group_the_beats():
    bars = bar_spans(BEATS, np.zeros(0), 4, 20.0)
    assert bars[0] == pytest.approx((0.0, 2.0))
    assert len(bars) == 10


def test_bar_spans_need_four_beats():
    assert bar_spans(np.zeros(0), np.zeros(0), 4, 10.0) == []
    assert bar_spans(BEATS[:3], BEATS[:1], 4, 10.0) == []
