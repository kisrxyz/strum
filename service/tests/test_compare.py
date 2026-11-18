import numpy as np

from conftest import SR, sine
from kv_service.compare import listening_windows, markdown_table


def test_listening_windows_find_where_the_guitar_stands_out():
    seconds = 120
    mix = sine(seconds, amp=0.3, freq=200)
    guitar = np.zeros_like(mix)
    loud = sine(15, amp=0.25, freq=900)
    guitar[30 * SR : 45 * SR] = loud
    guitar[80 * SR : 95 * SR] = loud * 0.8
    guitar[10 * SR : 25 * SR] = loud * 0.2
    windows = listening_windows([guitar], mix, SR, length=15, count=2)
    assert windows == [(30.0, 45.0), (80.0, 95.0)]


def test_listening_windows_average_the_models_and_never_overlap():
    seconds = 60
    mix = sine(seconds, amp=0.3, freq=200)
    a = np.zeros_like(mix)
    b = np.zeros_like(mix)
    a[20 * SR : 35 * SR] = sine(15, amp=0.3, freq=900)
    b[22 * SR : 37 * SR] = sine(15, amp=0.3, freq=900)
    windows = listening_windows([a, b], mix, SR, length=15, count=2)
    first, second = windows
    assert 19 <= first[0] <= 23
    assert second[1] <= first[0] or second[0] >= first[1]


def test_markdown_table():
    rows = [
        {"song": "Кайен", "duration": 181.7, "model": "BS-RoFormer SW", "device": "cuda", "seconds": 95.2, "peakVramMb": 3812, "note": None},
        {"song": "Кайен", "duration": 181.7, "model": "Demucs 6s", "device": "cpu", "seconds": 400.0, "peakVramMb": None, "note": "Видеопамяти не хватило"},
    ]
    table = markdown_table(rows).splitlines()
    assert table[0].startswith("| Песня | Длина | Модель")
    assert table[2] == "| Кайен | 3:02 | BS-RoFormer SW | видеокарта | 95 с | ×1,9 | 3812 МиБ |  |"
    assert table[3] == "| Кайен | 3:02 | Demucs 6s | процессор | 400 с | ×0,45 | — | Видеопамяти не хватило |"
