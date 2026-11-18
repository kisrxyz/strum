"""Takes («Запись»): chunks, the two clocks, the mix, the routes."""

import json

import numpy as np
import pytest
import soundfile as sf

from conftest import fake_analyzer, fake_separator, fake_transcriber, local_client
from kv_service.app import create_app
from kv_service.takes import Takes, TakeError, fit_clock

G_RATE = 48000


def pcm(x: np.ndarray) -> bytes:
    """(frames, 2) float → int16 LE interleaved, as the app sends it."""
    return (np.clip(x, -1, 1) * 32767).astype("<i2").tobytes()


def stereo(mono: np.ndarray) -> np.ndarray:
    return np.repeat(mono[:, None], 2, axis=1).astype(np.float32)


def send(takes: Takes, take_id: str, track: str, audio: np.ndarray, rate: int, moment, chunk_s: float = 0.5,
         skip: tuple[int, ...] = ()) -> None:
    """Sends `audio` in chunks; `moment(frame)` is the anchor (ms) of a chunk's first frame."""
    step = int(chunk_s * rate)
    for n, at in enumerate(range(0, len(audio), step)):
        if n in skip:
            continue
        takes.append(take_id, track, at, rate, moment(at), pcm(audio[at : at + step]))


def pulses(frames: int, at: list[float], width: float = 12.0) -> np.ndarray:
    """Smooth bumps (Gaussian, `width` frames) centred on fractional frames `at`: interpolation keeps their peaks."""
    i = np.arange(frames, dtype=np.float64)
    x = np.zeros(frames)
    for centre in at:
        x += 0.8 * np.exp(-0.5 * ((i - centre) / width) ** 2)
    return stereo(x)


def peaks_of(x: np.ndarray, count: int) -> list[int]:
    """Frames of the `count` highest bumps of channel 0 (one per bump)."""
    mono = x[:, 0].copy()
    found = []
    for _ in range(count):
        top = int(np.argmax(mono))
        found.append(top)
        mono[max(0, top - 2000) : top + 2000] = 0
    return sorted(found)


@pytest.fixture
def takes(tmp_path) -> Takes:
    return Takes(tmp_path / "library")


def test_fit_clock_one_point_uses_the_nominal_rate():
    t0, slope = fit_clock([(4800, 1100.0)], 48000)
    assert slope == pytest.approx(1000 / 48000)
    assert t0 == pytest.approx(1000.0)


def test_fit_clock_finds_drift_and_drops_a_late_point():
    slope = 1000 / 48000 * (1 + 2e-4)
    points = [(f, 500 + slope * f) for f in range(0, 48000 * 60, 24000)]
    points[10] = (points[10][0], points[10][1] + 40)  # a chunk whose anchor came late
    t0, fitted = fit_clock(points, 48000)
    assert fitted == pytest.approx(slope, rel=1e-6)
    assert t0 == pytest.approx(500, abs=0.01)


def test_fit_clock_refuses_a_wild_slope():
    # Two noisy points close together say 1 % fast: not a sound card. The nominal rate wins.
    t0, slope = fit_clock([(0, 0.0), (48000, 1010.0)], 48000)
    assert slope == pytest.approx(1000 / 48000)


def test_band_follows_guitar_clock(takes):
    """The band at 44.1 kHz on a card 100 ppm fast, starting 250 ms after the guitar: its bumps land
    on the guitar's timeline where the player heard them."""
    seconds = 12
    b_rate = 44100
    g_t0, b_t0 = 1000.0, 1250.0
    g_slope = 1000 / G_RATE
    b_slope = 1000 / b_rate * (1 + 1e-4)
    moments = [2000.0, 6000.0, 11000.0]  # ms on the browser's clock
    band = pulses(int(seconds * b_rate), [(m - b_t0) / b_slope for m in moments])
    guitar = stereo(np.full(seconds * G_RATE, 0.01))
    take = takes.create(title="Кайен", artist="Стрыкало", song_id="0123456789ab", path="native")
    send(takes, take["id"], "guitar", guitar, G_RATE, lambda f: g_t0 + g_slope * f)
    send(takes, take["id"], "band", band, b_rate, lambda f: b_t0 + b_slope * f)
    done = takes.finish(take["id"])
    assert done["status"] == "ready"
    assert done["hasBand"] is True
    assert done["sampleRate"] == G_RATE
    assert done["duration"] == pytest.approx(seconds)
    aligned, rate = sf.read(str(takes.folder(take["id"]) / "band.flac"), dtype="float32", always_2d=True)
    assert rate == G_RATE
    assert len(aligned) == len(guitar)
    expected = [round((m - g_t0) / g_slope) for m in moments]
    for got, want in zip(peaks_of(aligned, 3), expected):
        assert abs(got - want) <= 2  # 0.04 ms
    assert (takes.folder(take["id"]) / "take.mp3").stat().st_size > 1000
    # The raw chunks are gone once the take is saved.
    assert not list(takes.folder(take["id"]).glob("*.pcm"))


def test_the_dry_input_is_kept_frame_for_frame_beside_the_guitar(takes):
    """The dry guitar: the card's raw input, both halves, on the guitar's own frames (the app starts
    it where the guitar starts, so a first piece that came earlier is left out). Kept as dry.flac,
    to check the input's noise and level by; not in the mix."""
    seconds = 3
    rng = np.random.default_rng(7)
    raw = np.zeros((seconds * G_RATE, 2), dtype=np.float32)
    raw[:, 1] = rng.standard_normal(seconds * G_RATE) * 0.05  # the guitar on input 2, input 1 silent
    guitar = stereo(np.full(seconds * G_RATE, 0.2))

    def moment(frame: int) -> float:
        return 1000.0 + frame / 48

    take = takes.create(title="Кайен", artist="", song_id=None, path="native")
    send(takes, take["id"], "guitar", guitar, G_RATE, moment)
    piece = 480  # the input's first 10 ms came before the guitar's first frame
    for at in range(piece, len(raw), 4800):
        takes.append(take["id"], "dry", at, G_RATE, moment(at), pcm(raw[at : at + 4800]))
    done = takes.finish(take["id"])
    assert done["status"] == "ready" and done["duration"] == pytest.approx(seconds)
    folder = takes.folder(take["id"])
    dry, rate = sf.read(str(folder / "dry.flac"), dtype="float32", always_2d=True)
    assert rate == G_RATE and len(dry) == len(guitar)
    assert np.all(dry[:piece] == 0)
    # Frame for frame: one frame off would leave errors of the noise's own size (0.05).
    assert np.max(np.abs(dry[piece:] - raw[piece:])) < 1e-4
    assert not list(folder.glob("*.pcm")) and not list(folder.glob("*.anchors"))

    # The same guitar without it: no dry.flac, and the very same mix.
    plain = takes.create(title="Кайен", artist="", song_id=None, path="native")
    send(takes, plain["id"], "guitar", guitar, G_RATE, moment)
    takes.finish(plain["id"])
    assert not (takes.folder(plain["id"]) / "dry.flac").exists()
    assert (folder / "take.mp3").read_bytes() == (takes.folder(plain["id"]) / "take.mp3").read_bytes()


def test_chunk_gap_is_silence(takes):
    guitar = stereo(np.full(int(1.5 * G_RATE), 0.5))
    take = takes.create(title="Без песни", artist="", song_id=None, path="native")
    send(takes, take["id"], "guitar", guitar, G_RATE, lambda f: f / 48, skip=(1,))
    done = takes.finish(take["id"])
    assert done["hasBand"] is False
    saved, _ = sf.read(str(takes.folder(take["id"]) / "guitar.flac"), dtype="float32", always_2d=True)
    assert len(saved) == len(guitar)
    half = G_RATE // 2
    assert np.allclose(saved[:half], 0.5, atol=1e-3)
    assert np.all(saved[half : 2 * half] == 0)
    assert np.allclose(saved[2 * half :], 0.5, atol=1e-3)


def test_a_silent_band_is_dropped(takes):
    take = takes.create(title="Кайен", artist="", song_id=None, path="browser")
    send(takes, take["id"], "guitar", stereo(np.full(G_RATE * 2, 0.3)), G_RATE, lambda f: f / 48)
    send(takes, take["id"], "band", stereo(np.zeros(G_RATE * 2)), G_RATE, lambda f: f / 48)
    done = takes.finish(take["id"])
    assert done["hasBand"] is False
    assert not (takes.folder(take["id"]) / "band.flac").exists()


def test_too_short_is_refused(takes):
    take = takes.create(title="Кайен", artist="", song_id=None, path="native")
    send(takes, take["id"], "guitar", stereo(np.full(G_RATE // 2, 0.3)), G_RATE, lambda f: f / 48)
    with pytest.raises(TakeError):
        takes.finish(take["id"])


def test_chunk_checks(takes):
    take = takes.create(title="Кайен", artist="", song_id=None, path="native")
    with pytest.raises(TakeError):
        takes.append(take["id"], "guitar", 0, G_RATE, 0.0, b"\x00\x00\x00")  # not whole frames
    takes.append(take["id"], "guitar", 0, G_RATE, 0.0, b"\x00" * 400)
    with pytest.raises(TakeError):
        takes.append(take["id"], "guitar", 100, 44100, 1.0, b"\x00" * 400)  # the rate changed
    with pytest.raises(TakeError):
        takes.append(take["id"], "guitar", 31 * 60 * G_RATE, G_RATE, 1.0, b"\x00" * 400)  # past 30 minutes


def test_nudge_rerenders_the_mix(takes):
    take = takes.create(title="Кайен", artist="", song_id=None, path="native")
    guitar = pulses(G_RATE * 2, [G_RATE])
    send(takes, take["id"], "guitar", guitar, G_RATE, lambda f: f / 48)
    send(takes, take["id"], "band", pulses(G_RATE * 2, [G_RATE // 2]), G_RATE, lambda f: f / 48)
    takes.finish(take["id"])
    before = (takes.folder(take["id"]) / "take.mp3").read_bytes()
    moved = takes.update(take["id"], guitar_offset_ms=-20)
    assert moved["guitarOffsetMs"] == -20
    assert (takes.folder(take["id"]) / "take.mp3").read_bytes() != before
    assert json.loads((takes.folder(take["id"]) / "take.json").read_text(encoding="utf-8"))["guitarOffsetMs"] == -20


def test_recover_finishes_an_interrupted_take(tmp_path):
    first = Takes(tmp_path / "library")
    take = first.create(title="Кайен", artist="", song_id=None, path="native")
    send(first, take["id"], "guitar", stereo(np.full(G_RATE * 2, 0.3)), G_RATE, lambda f: f / 48)
    short = first.create(title="Кайен", artist="", song_id=None, path="native")
    send(first, short["id"], "guitar", stereo(np.full(G_RATE // 4, 0.3)), G_RATE, lambda f: f / 48)
    again = Takes(tmp_path / "library")
    again.recover()
    assert again.get(take["id"])["status"] == "ready"
    assert [t["id"] for t in again.list()] == [take["id"]]


def make_client(settings):
    app = create_app(settings, separator=fake_separator(), analyzer=fake_analyzer(), transcriber=fake_transcriber())
    return local_client(app)


def test_take_routes(settings):
    with make_client(settings) as client:
        created = client.post("/api/takes", json={"songId": None, "title": "Кайен", "artist": "Стрыкало", "path": "native"})
        assert created.status_code == 201
        take = created.json()
        assert take["status"] == "recording"
        url = f"/api/takes/{take['id']}"
        body = pcm(stereo(np.full(G_RATE * 2, 0.3)))
        params = {"track": "guitar", "at": 0, "rate": G_RATE, "perf": 1234.5}
        assert client.post(f"{url}/chunk", params=params, content=body).status_code == 204
        assert client.post(f"{url}/chunk", params={**params, "track": "dry"}, content=body).status_code == 204
        assert client.post(f"{url}/chunk", params={**params, "track": "drums"}, content=body).status_code == 422
        assert client.post(f"{url}/chunk", params=params, content=body[:-1]).status_code == 422
        done = client.post(f"{url}/finish")
        assert done.status_code == 200
        assert done.json()["status"] == "ready"
        assert client.post(f"{url}/chunk", params=params, content=body).status_code == 409
        assert [t["id"] for t in client.get("/api/takes").json()] == [take["id"]]
        mp3 = client.get(f"{url}/take.mp3")
        assert mp3.status_code == 200
        assert mp3.headers["content-type"] == "audio/mpeg"
        download = client.get(f"{url}/take.mp3", params={"download": 1})
        assert "attachment" in download.headers["content-disposition"]
        assert "%28take%20" in download.headers["content-disposition"]  # English by default: «(take …»
        russian = client.get(f"{url}/take.mp3", params={"download": 1, "lang": "ru"})
        assert "%D0%B7%D0%B0%D0%BF%D0%B8%D1%81%D1%8C" in russian.headers["content-disposition"]  # «запись»
        assert client.get(f"{url}/take.mp3", params={"download": 1, "lang": "de"}).status_code == 422
        assert client.patch(url, json={"guitarOffsetMs": 30}).json()["guitarOffsetMs"] == 30
        assert client.patch(url, json={"guitarOffsetMs": 900}).status_code == 422
        assert client.delete(url).status_code == 204
        assert client.get(f"{url}/take.mp3").status_code == 404
        assert client.get("/api/takes/nope/take.mp3").status_code == 404


def test_short_take_is_removed_by_finish(settings):
    with make_client(settings) as client:
        take = client.post("/api/takes", json={"songId": None, "title": "Без песни", "artist": "", "path": "browser"}).json()
        url = f"/api/takes/{take['id']}"
        client.post(f"{url}/chunk", params={"track": "guitar", "at": 0, "rate": G_RATE, "perf": 0}, content=pcm(stereo(np.zeros(4800))))
        refused = client.post(f"{url}/finish")
        assert refused.status_code == 422
        assert refused.json()["detail"] == {"code": "take.tooShort", "params": {}}
        assert client.get("/api/takes").json() == []


def test_a_take_without_a_title_is_named_in_the_apps_language(settings):
    with make_client(settings) as client:
        english = client.post("/api/takes", json={"songId": None, "title": " ", "artist": "", "path": "browser"}).json()
        assert english["title"] == "No song"
        russian = client.post("/api/takes", json={"title": "", "path": "native", "lang": "ru"}).json()
        assert russian["title"] == "Без песни"
        url = f"/api/takes/{english['id']}"
        params = {"track": "guitar", "at": 0, "rate": G_RATE, "perf": 0}
        assert client.post(f"{url}/chunk", params=params, content=b"abc").json()["detail"]["code"] == "take.chunkBroken"
        client.post(f"{url}/chunk", params=params, content=pcm(stereo(np.zeros(4800))))
        changed = client.post(f"{url}/chunk", params={**params, "rate": 44_100}, content=pcm(stereo(np.zeros(4800))))
        assert changed.status_code == 409
        assert changed.json()["detail"] == {"code": "take.rateChanged", "params": {}}
