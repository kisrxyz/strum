"""The real analysis models. Run with: npm run test:service -- -m gpu -k "analysis or beat or btc"

They need `npm run setup` (the beat-this and librosa packages, and the weights in service/.models).
"""

from pathlib import Path

import numpy as np
import pytest

from kv_service.analysis import BeatThisBackend, BtcBackend, default_analyzer
from kv_service.audio import read_audio
from kv_service.config import REPO_ROOT, load_settings, prepare_model_env
from kv_service.harmony import parse_chord
from kv_service.models import weight_ready
from kv_service.rhythm import tempo_and_meter
from kv_service.separation import detect_device

pytestmark = pytest.mark.gpu
SR = 44100
SONGS = sorted((REPO_ROOT / "test-songs").glob("*.mp3"))


@pytest.fixture(scope="module")
def models_dir() -> Path:
    pytest.importorskip("beat_this", reason="the analysis packages are not installed: npm run setup")
    pytest.importorskip("librosa", reason="the analysis packages are not installed: npm run setup")
    settings = load_settings()
    prepare_model_env(settings.models_dir, offline=True)
    for weight in ("beat_this", "btc"):
        if not weight_ready(weight, settings.models_dir):
            pytest.skip(f"the {weight} weights are not downloaded: npm run setup")
    return Path(settings.models_dir)


@pytest.fixture(scope="module")
def device() -> str:
    return detect_device()[0]


def click_track(seconds: float = 30.0, bpm: float = 120.0) -> np.ndarray:
    """A drum loop at 120 BPM: a kick on every beat (louder on the first of the bar), a snare on 2
    and 4, a hi-hat between the beats; and per bar of 4 a new bass note and chord (E A G D).
    Without the backbeat and the chord changes the model has no bar to find: with a kick on every
    beat it calls every beat a downbeat, and the hi-hats alone make it hear double time."""
    out = np.zeros(int(seconds * SR))
    beat = 60.0 / bpm
    t = np.arange(int(0.25 * SR)) / SR
    noise = np.random.default_rng(0).normal(0, 1, len(t))
    kick = np.sin(2 * np.pi * (50 * t + 400 * 0.03 * (1 - np.exp(-t / 0.03)))) * np.exp(-t / 0.08)
    hat = noise * np.exp(-t / 0.01)
    snare = (0.7 * noise + 0.3 * np.sin(2 * np.pi * 190 * t)) * np.exp(-t / 0.06)
    bar_t = np.arange(int(4 * beat * SR)) / SR
    roots = (40, 45, 43, 38)  # E2, A2, G2, D2

    def add(x: np.ndarray, at: int, gain: float) -> None:
        if at < len(out):
            out[at : at + len(x)] += gain * x[: len(out) - at]

    def tone(midi: int) -> np.ndarray:
        f = 440.0 * 2 ** ((midi - 69) / 12)
        return sum(np.sin(2 * np.pi * h * f * bar_t) / h for h in range(1, 4))

    for k in range(int(seconds / beat)):
        start = int(k * beat * SR)
        add(kick, start, 1.0 if k % 4 == 0 else 0.6)
        add(hat, int((k + 0.5) * beat * SR), 0.15)
        if k % 2 == 1:
            add(snare, start, 0.5)
        if k % 4 == 0:
            root = roots[(k // 4) % len(roots)]
            third = 3 if root == 45 else 4  # A minor, the others major
            add(0.4 * tone(root) * np.exp(-bar_t / 1.5), start, 1.0)
            chord = sum(tone(root + 12 + step) for step in (0, third, 7))
            add(0.15 * chord * np.exp(-bar_t / 2.5), start, 1.0)
    return (0.5 * out / np.max(np.abs(out))).astype(np.float32)


CHORDS = {"C": (48, 52, 55, 60), "G": (43, 50, 55, 59), "A:min": (45, 52, 57, 60), "F": (41, 48, 53, 57)}


def piano_chords(order=("C", "G", "A:min", "F"), length: float = 2.0, rounds: int = 3) -> np.ndarray:
    """Each chord as piano-like tones: fundamental + 4 harmonics, a quick attack and a decay."""
    t = np.arange(int(length * SR)) / SR
    envelope = np.minimum(1.0, t / 0.01) * np.exp(-t / 1.2)
    pieces = []
    for _ in range(rounds):
        for name in order:
            tone = np.zeros_like(t)
            for midi in CHORDS[name]:
                f0 = 440.0 * 2 ** ((midi - 69) / 12)
                tone += sum(np.sin(2 * np.pi * k * f0 * t) / k for k in range(1, 6))
            pieces.append(tone * envelope)
    out = np.concatenate(pieces)
    return (0.5 * out / np.max(np.abs(out))).astype(np.float32)


def chord_at(segments: list[dict], t: float) -> str:
    for segment in segments:
        if segment["start"] <= t < segment["end"]:
            return segment["chord"]
    return "N"


def test_btc_wrapper_matches_the_window_by_window_loop(tmp_path, monkeypatch, device):
    """No weights needed: random weights, made-up features. Batching, labels and times."""
    torch = pytest.importorskip("torch")
    from kv_service.btc import features
    from kv_service.btc import model as btc

    torch.manual_seed(0)
    net = btc.BTC_model(btc.MODEL_CONFIG)
    path = tmp_path / "btc.pt"
    torch.save({"model": net.state_dict(), "mean": np.float64(0.5), "std": np.float64(2.0)}, path)
    n = features.TIMESTEP
    frames = 3 * n + 7  # not a whole number of windows
    feats = np.random.default_rng(0).normal(0.5, 2.0, (frames, 144)).astype(np.float32)
    monkeypatch.setattr(features, "log_cqt", lambda mono, sr: feats)

    chords = btc.BtcChords.load(path, device)
    try:
        segments = chords.predict(np.zeros(10, dtype=np.float32), SR)
        # the original predict(): one window at a time
        x = np.zeros((4 * n, 144), dtype=np.float32)
        x[:frames] = (feats - 0.5) / 2.0
        expected = []
        with torch.inference_mode():
            for t in range(4):
                window = torch.from_numpy(x[t * n : (t + 1) * n])[None].to(device)
                hidden, _ = chords.model.self_attn_layers(window)
                prediction, _ = chords.model.output_layer(hidden)
                expected.extend(prediction.reshape(-1).cpu().tolist())
    finally:
        chords.release()
    labels = features.idx2voca_chord()
    heard = []
    for segment in segments:
        count = round((segment["end"] - segment["start"]) / features.FRAME_SECONDS)
        heard.extend([segment["chord"]] * count)
    assert heard == [labels[i] for i in expected[:frames]]
    assert segments[0]["start"] == 0.0
    assert segments[-1]["end"] == pytest.approx(frames * features.FRAME_SECONDS, abs=1e-3)
    assert all(a["end"] == b["start"] and a["chord"] != b["chord"] for a, b in zip(segments, segments[1:]))
    assert chords.model is None


def test_beat_this_on_a_click_track(models_dir, device):
    backend = BeatThisBackend(models_dir)
    backend.load(device)
    try:
        beats, downbeats = backend.beats(click_track(), SR)
    finally:
        backend.unload()
    tempo, meter = tempo_and_meter(beats, downbeats)
    assert tempo == pytest.approx(120.0, abs=3)
    assert len(beats) >= 50
    assert len(downbeats) >= 10
    assert float(np.median(np.diff(downbeats))) == pytest.approx(2.0, abs=0.1)
    assert meter == 4
    # on the bar lines (every 2 s from 0), where the bass and the chord change
    off_the_bar = np.abs((np.asarray(downbeats) + 1.0) % 2.0 - 1.0)
    assert np.mean(off_the_bar < 0.1) >= 0.8


def test_btc_on_synthetic_chords(models_dir, device):
    backend = BtcBackend(models_dir)
    backend.load(device)
    try:
        segments = backend.chords(piano_chords(), SR)
    finally:
        backend.unload()
    assert segments[0]["start"] == 0.0
    assert all(a["end"] == b["start"] for a, b in zip(segments, segments[1:]))
    expected = [parse_chord(name)[0] for name in ("C", "G", "A:min", "F")]
    for round_ in range(3):
        heard = []
        for k in range(4):
            label = chord_at(segments, round_ * 8.0 + k * 2.0 + 1.0)
            parsed = parse_chord(label)
            heard.append(parsed[0] if parsed else None)
        right = sum(h == e for h, e in zip(heard, expected))
        assert right >= 3, (round_, heard, segments)


def test_analysis_on_a_test_song(models_dir, device):
    if not SONGS:
        pytest.skip("test-songs/ is empty")
    audio, sr = read_audio(SONGS[0])
    assert sr == SR
    mix = audio[: 30 * sr]
    progress = []
    analyzer = default_analyzer(models_dir)
    try:
        result = analyzer.run(mix, None, "mix", sr, progress.append)
    finally:
        analyzer.unload()
    data = result.data
    assert 50 <= data["tempo"] <= 220
    assert len(data["beats"]) >= 20
    assert len([c for c in data["chords"] if c["chord"] not in ("N", "X")]) >= 3
    assert data["key"] is not None
    assert -50 <= data["tuningCents"] < 50
    assert result.device == device
    assert progress[-1] == 1.0


@pytest.mark.skipif(not SONGS, reason="no song in test-songs/")
def test_crepe_notes_on_a_test_song_guitar(models_dir):
    """The notes of the guitar stem of 40 s of a test song (Demucs 6s guitar, the fastest)."""
    pytest.importorskip("torchcrepe", reason="torchcrepe is not installed: npm run setup")
    from kv_service.analysis import CrepeBackend
    from kv_service.notes import frames_to_notes
    from kv_service.separation import default_separator

    mix, sr = read_audio(SONGS[0])
    mix = mix[60 * sr : 100 * sr]
    separator = default_separator(models_dir)
    guitar = separator.run("htdemucs_6s", mix, sr, lambda _f: None).stems["guitar"]
    separator.unload()
    backend = CrepeBackend()
    backend.load(detect_device()[0])
    notes = frames_to_notes(*backend.pitch(guitar.mean(axis=1), sr))
    print(f"\n{len(notes)} notes, e.g. {[n['midi'] for n in notes[:12]]}")
    assert all(40 <= n["midi"] <= 88 for n in notes)
    assert all(b["start"] >= a["end"] - 1e-6 for a, b in zip(notes, notes[1:]))
