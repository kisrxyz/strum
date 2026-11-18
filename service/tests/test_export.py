import io
from urllib.parse import unquote

import numpy as np
import pytest
import soundfile as sf

from conftest import local_client, SR, fake_separator, sine, tagged_flac, wav_bytes
from kv_service.app import create_app
from kv_service.export import ExportRequest, content_disposition, encode_mp3, export_file_name, render_backing, stretch
from kv_service.library import STEMS

ALL_ON = {stem: 1.0 for stem in STEMS}
NO_GUITAR = {**ALL_ON, "guitar": 0.0}
SONG = {"title": "Кайен", "artist": "Валентин Стрыкало", "duration": 181.7}


def peak_frequency(x: np.ndarray, sr: int = SR) -> float:
    mono = x[:, 0] * np.hanning(len(x))
    spectrum = np.abs(np.fft.rfft(mono))
    return float(np.fft.rfftfreq(len(mono), 1 / sr)[np.argmax(spectrum)])


def test_slowing_down_keeps_the_timing():
    x = np.zeros((4 * SR, 2), np.float32)
    x[SR] = 1.0  # an impulse at 1.0 s
    y = stretch(x, SR, speed=0.8, semitones=0)
    assert abs(len(y) - 5 * SR) <= 1
    found = np.argmax(np.abs(y[: 2 * SR, 0])) / SR
    assert found == pytest.approx(1.25, abs=0.005)


def test_pitch_shift_moves_the_frequency():
    y = stretch(sine(2.0, freq=440), SR, speed=1.0, semitones=12)
    assert peak_frequency(y[SR // 2 :]) == pytest.approx(880, rel=0.02)


def test_backing_is_normalised_to_minus_one_dbfs():
    stems = {stem: sine(2.0, amp=0.05) for stem in STEMS}
    y = render_backing(stems, SR, ExportRequest(model="htdemucs_6s", gains=ALL_ON, speed=0.8))
    assert 20 * np.log10(np.max(np.abs(y))) == pytest.approx(-1.0, abs=0.05)


def test_muted_guitar_is_not_in_the_backing():
    stems = {stem: np.zeros((2 * SR, 2), np.float32) for stem in STEMS}
    stems["guitar"] = sine(2.0, freq=1000)
    stems["drums"] = sine(2.0, freq=200)
    y = render_backing(stems, SR, ExportRequest(model="htdemucs_6s", gains=NO_GUITAR))
    spectrum = np.abs(np.fft.rfft(y[:, 0] * np.hanning(len(y))))
    freqs = np.fft.rfftfreq(len(y), 1 / SR)
    level = lambda f: spectrum[np.argmin(np.abs(freqs - f))]  # noqa: E731
    assert 20 * np.log10(level(1000) / level(200)) < -60


def test_backing_cuts_the_requested_range():
    stems = {stem: sine(4.0, amp=0.1) for stem in STEMS}
    y = render_backing(stems, SR, ExportRequest(model="htdemucs_6s", gains=ALL_ON, speed=0.5, start=1.0, end=2.0))
    assert abs(len(y) - 2 * SR) <= 1


def test_mp3_encodes_and_decodes_back():
    data = encode_mp3(sine(1.0, amp=0.3), SR)
    assert data[:3] == b"ID3" or (data[0] == 0xFF and data[1] & 0xE0 == 0xE0)
    decoded, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
    assert sr == SR
    assert decoded.shape[1] == 2
    assert abs(len(decoded) - SR) < 0.1 * SR


@pytest.mark.parametrize(
    ("gains", "speed", "semitones", "start", "end", "name"),
    [
        (NO_GUITAR, 0.8, -1, 65, 92, "Валентин Стрыкало - Кайен (без гитары, 80%, тон −1, 1.05–1.32).mp3"),
        (NO_GUITAR, 1.0, 0, 0, None, "Валентин Стрыкало - Кайен (без гитары).mp3"),
        ({**{s: 0.0 for s in STEMS}, "guitar": 1.0}, 1.0, 0, 0, 181.7, "Валентин Стрыкало - Кайен (только гитара).mp3"),
        (ALL_ON, 0.75, 0.5, 0, None, "Валентин Стрыкало - Кайен (с гитарой, 75%, тон +0,5).mp3"),
        (NO_GUITAR, 1.0, -1.05, 0, None, "Валентин Стрыкало - Кайен (без гитары, тон −1,05).mp3"),
    ],
)
def test_file_names(gains, speed, semitones, start, end, name):
    request = ExportRequest(model="htdemucs_6s", gains=gains, speed=speed, semitones=semitones, start=start, end=end)
    assert export_file_name(SONG, request, "ru") == name


@pytest.mark.parametrize(
    ("gains", "speed", "semitones", "name"),
    [
        (NO_GUITAR, 0.8, -1.05, "Валентин Стрыкало - Кайен (no guitar, 80%, pitch -1.05).mp3"),
        ({**{s: 0.0 for s in STEMS}, "guitar": 1.0}, 1.0, 0.5, "Валентин Стрыкало - Кайен (guitar only, pitch +0.5).mp3"),
        (ALL_ON, 1.0, 0, "Валентин Стрыкало - Кайен (with guitar).mp3"),
    ],
)
def test_file_names_in_english(gains, speed, semitones, name):
    request = ExportRequest(model="htdemucs_6s", gains=gains, speed=speed, semitones=semitones)
    assert export_file_name(SONG, request) == name  # English is the default
    assert export_file_name(SONG, request, "en") == name


def test_file_name_without_artist_and_with_unsafe_characters():
    song = {"title": 'Что? Где: "Когда"/', "artist": "", "duration": 100}
    request = ExportRequest(model="htdemucs_6s", gains=NO_GUITAR)
    assert export_file_name(song, request, "ru") == "Что Где Когда (без гитары).mp3"
    nothing = {"title": "?", "artist": "", "duration": 100}
    assert export_file_name(nothing, request, "ru") == "Минусовка (без гитары).mp3"
    assert export_file_name(nothing, request, "en") == "Backing track (no guitar).mp3"


def test_content_disposition_carries_the_utf8_name():
    header = content_disposition("Кино - Кукушка (без гитары).mp3")
    assert header.startswith("attachment; filename=\"")
    assert header.split('filename="')[1].split('"')[0].isascii()
    encoded = header.split("filename*=UTF-8''")[1]
    assert unquote(encoded) == "Кино - Кукушка (без гитары).mp3"


@pytest.fixture
def client(settings):
    with local_client(create_app(settings, separator=fake_separator())) as c:
        yield c


def test_export_endpoint(client):
    files = {
        "original": ("Кино - Кукушка.flac", tagged_flac("Кукушка", "Кино"), "audio/flac"),
        "mix": ("mix.wav", wav_bytes(sine(2.0)), "audio/wav"),
    }
    song = client.post("/api/songs", files=files, data={"fileName": "Кино - Кукушка.flac"}).json()["song"]
    client.app.state.jobs.wait_idle(5)
    body = {"model": "htdemucs_6s", "gains": NO_GUITAR, "speed": 0.8, "semitones": 0, "start": 0, "end": None, "lang": "ru"}
    response = client.post(f"/api/songs/{song['id']}/export", json=body)
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/mpeg"
    assert "filename*=UTF-8''" in response.headers["content-disposition"]
    assert unquote(response.headers["content-disposition"].split("UTF-8''")[1]) == "Кино - Кукушка (без гитары, 80%).mp3"
    decoded, _ = sf.read(io.BytesIO(response.content), dtype="float32", always_2d=True)
    assert abs(len(decoded) - 2.5 * SR) < 0.1 * SR

    missing = client.post(f"/api/songs/{song['id']}/export", json={**body, "model": "bs_roformer_sw"})
    assert missing.status_code == 409
    assert missing.json()["detail"] == {"code": "export.stemsNotReady", "params": {}}
    english = client.post(f"/api/songs/{song['id']}/export", json={**body, "lang": "en"})
    assert unquote(english.headers["content-disposition"].split("UTF-8''")[1]) == "Кино - Кукушка (no guitar, 80%).mp3"
    no_lang = {key: value for key, value in body.items() if key != "lang"}
    assert "no%20guitar" in client.post(f"/api/songs/{song['id']}/export", json=no_lang).headers["content-disposition"]
    assert client.post(f"/api/songs/{song['id']}/export", json={**body, "lang": "de"}).status_code == 422
    assert client.post(f"/api/songs/{song['id']}/export", json={**body, "speed": 0.3}).status_code == 422
