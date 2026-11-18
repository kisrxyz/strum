import numpy as np
import pytest

from conftest import SR, sine, tagged_flac, wav_bytes
from kv_service import audio


def test_loudness_of_a_full_scale_sine():
    assert audio.loudness_db(sine(5, amp=1.0, freq=1000), SR) == pytest.approx(-3.01, abs=0.05)


def test_loudness_ignores_silence():
    quiet = sine(4.8, amp=0.1, freq=1000)  # exactly 12 blocks of 400 ms, none half silent
    x = np.concatenate([quiet, np.zeros((10 * SR, 2), np.float32)])
    assert audio.loudness_db(x, SR) == pytest.approx(-23.01, abs=0.05)


def test_loudness_ignores_a_quiet_intro_too():
    # -49 dB is above the -60 dB silence gate but more than 20 dB under the song: left out.
    intro = sine(4.8, amp=0.005, freq=1000)
    x = np.concatenate([intro, sine(4.8, amp=0.1, freq=1000)])
    assert audio.loudness_db(x, SR) == pytest.approx(-23.01, abs=0.05)


def test_loudness_of_silence_is_a_floor():
    assert audio.loudness_db(np.zeros((SR, 2), np.float32), SR) == -70.0


def test_peaks_are_min_max_pairs_per_hundredth_of_a_second():
    # A 0.5-amplitude square wave hits exactly ±0.5 in every bin: ±63.5 rounds to ±64.
    square = np.where(np.arange(SR) % 2 == 0, 0.5, -0.5).astype(np.float32)
    peaks = np.frombuffer(audio.peaks_int8(np.stack([square, square], axis=1), SR), dtype=np.int8)
    assert len(peaks) == 200
    assert set(peaks[0::2]) == {-64}
    assert set(peaks[1::2]) == {64}


def test_peaks_cover_a_partial_last_bin():
    peaks = audio.peaks_int8(sine(1.005), SR)
    assert len(peaks) == 2 * 101


def test_reads_a_float_stereo_wav():
    x = audio.read_mix_wav(wav_bytes(sine(0.5)))
    assert x.dtype == np.float32
    assert x.shape == (SR // 2, 2)


@pytest.mark.parametrize(
    ("data", "code"),
    [
        (wav_bytes(sine(0.5, sr=48000), sr=48000), "audio.wrongRate"),
        (wav_bytes(sine(0.5, channels=1)), "audio.notStereo"),
        (wav_bytes(sine(0.5), subtype="PCM_16"), "audio.notFloat"),
        (b"not a wav at all", "audio.unreadable"),
    ],
)
def test_rejects_other_wav_formats_with_a_message(data, code):
    with pytest.raises(audio.AudioError) as error:
        audio.read_mix_wav(data)
    assert error.value.code == code


def test_headroom_scale():
    assert audio.headroom_scale([np.array([0.2, -1.5])]) == pytest.approx(0.98 / 1.5)
    assert audio.headroom_scale([np.array([0.5]), np.array([-0.3])]) == 1.0


def test_flac_roundtrip_keeps_the_signal(tmp_path):
    x = sine(0.5)
    audio.write_flac(tmp_path / "a.flac", x, SR)
    y, sr = audio.read_audio(tmp_path / "a.flac")
    assert sr == SR
    assert y.shape == x.shape
    assert np.max(np.abs(y - x)) < 1e-4


def test_read_tags(tmp_path):
    path = tmp_path / "song.flac"
    path.write_bytes(tagged_flac("Кайен (Sefon.Pro)", "Валентин Стрыкало"))
    tags = audio.read_tags(path)
    assert tags["title"] == "Кайен (Sefon.Pro)"
    assert tags["artist"] == "Валентин Стрыкало"


def test_read_tags_of_an_unreadable_file_is_empty(tmp_path):
    path = tmp_path / "song.m4a"
    path.write_bytes(b"\x00\x00\x00\x20ftypM4A ")
    assert audio.read_tags(path) == {}
