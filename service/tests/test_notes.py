import numpy as np

from kv_service.notes import frames_to_notes

HOP = 0.01


def frames(*parts: tuple[float, float, float]) -> tuple[np.ndarray, np.ndarray]:
    """(hz, periodicity, seconds) parts → pitch and periodicity frames every 10 ms."""
    hz, per = [], []
    for f, p, seconds in parts:
        n = int(round(seconds / HOP))
        hz += [f] * n
        per += [p] * n
    return np.array(hz), np.array(per)


def test_a_steady_tone_is_one_note():
    hz, per = frames((440.0, 0.9, 1.0))
    notes = frames_to_notes(hz, per, HOP)
    assert len(notes) == 1
    assert notes[0]["midi"] == 69
    assert notes[0]["start"] == 0.0
    assert abs(notes[0]["end"] - 1.0) < 0.011
    assert 0.85 < notes[0]["conf"] <= 0.9


def test_three_pitches_are_three_notes():
    hz, per = frames((440.0, 0.9, 0.3), (493.88, 0.9, 0.3), (523.25, 0.9, 0.3))
    assert [n["midi"] for n in frames_to_notes(hz, per, HOP)] == [69, 71, 72]


def test_unclear_pitch_gives_no_notes():
    hz, per = frames((440.0, 0.3, 1.0))
    assert frames_to_notes(hz, per, HOP) == []


def test_short_runs_are_dropped_and_tiny_gaps_joined():
    hz, per = frames((440.0, 0.9, 0.05), (0.0, 0.0, 0.2), (330.0, 0.9, 0.3), (330.0, 0.1, 0.03), (330.0, 0.9, 0.3))
    notes = frames_to_notes(hz, per, HOP)
    assert [n["midi"] for n in notes] == [64]  # the 50 ms blip is gone, the E is one note
    assert abs(notes[0]["end"] - notes[0]["start"] - 0.63) < 0.02


def test_out_of_the_guitar_range_is_ignored():
    hz, per = frames((50.0, 0.9, 0.5), (3000.0, 0.9, 0.5))
    assert frames_to_notes(hz, per, HOP) == []


def test_vibrato_stays_one_note():
    t = np.arange(0, 1.0, HOP)
    hz = 440.0 * 2 ** (0.3 * np.sin(2 * np.pi * 5 * t) / 12)  # ±0.3 semitone at 5 Hz
    notes = frames_to_notes(hz, np.full(len(t), 0.9), HOP)
    assert [n["midi"] for n in notes] == [69]


# ---- in the analysis and the API

from conftest import fake_analyzer, fake_separator, fake_transcriber, local_client, sine, upload_song  # noqa: E402
from kv_service.app import create_app  # noqa: E402

SR = 44_100


def stems_with_guitar(guitar_amp: float) -> dict:
    return {stem: sine(16.0, amp=0.3 if stem != "guitar" else guitar_amp, freq=220.0) for stem in ("vocals", "guitar", "piano", "other")}


def test_the_analysis_hears_notes_in_the_guitar_stem_only():
    log = []
    data = fake_analyzer(log=log).run(sine(16.0, amp=0.5), stems_with_guitar(0.05), "bs_roformer_sw", SR, lambda _f: None).data
    assert [n["midi"] for n in data["notes"]] == [69]
    assert data["notes"][0]["end"] <= 16.0
    heard = [entry for entry in log if entry[0] == "pitch"]
    assert len(heard) == 1 and heard[0][1] < 0.06  # the guitar stem (0.05 → RMS 0.035), not the mix


def test_notes_need_a_guitar():
    log = []
    without_stems = fake_analyzer(log=log).run(sine(16.0), None, "mix", SR, lambda _f: None).data
    assert without_stems["notes"] == []
    silent = fake_analyzer(log=log).run(sine(16.0), stems_with_guitar(0.0), "bs_roformer_sw", SR, lambda _f: None).data
    assert silent["notes"] == []
    assert not [entry for entry in log if entry[0] == "pitch"]


def test_patch_notes_and_lists(settings):
    app = create_app(settings, separator=fake_separator(), analyzer=fake_analyzer(), transcriber=fake_transcriber())
    with local_client(app) as client:
        song = upload_song(client)
        url = f"/api/songs/{song['id']}"
        assert client.get(url).json()["guitarNotes"] is None
        assert client.get(url).json()["lists"] == []
        notes = [{"start": 1.0, "end": 1.5, "midi": 64}]
        response = client.patch(url, json={"guitarNotes": notes, "lists": ["favorite"], "notes": "соло со 2:04"})
        assert response.status_code == 200
        assert response.json()["guitarNotes"] == notes
        assert response.json()["lists"] == ["favorite"]
        assert response.json()["notes"] == "соло со 2:04"  # the card's text notes are a different field
        assert client.patch(url, json={"guitarNotes": [{"start": 1.0, "end": 1.5, "midi": 120}]}).status_code == 422
        assert client.patch(url, json={"lists": ["best"]}).status_code == 422
        assert client.patch(url, json={"guitarNotes": None}).json()["guitarNotes"] is None


class MissingPitch:
    """torchcrepe not installed yet."""

    def load(self, device: str) -> None:
        from kv_service.analysis import PitchUnavailable

        raise PitchUnavailable("program.filesMissing", model="notes")

    def unload(self) -> None:
        pass


def test_without_the_notes_model_bars_and_chords_still_come(monkeypatch):
    from conftest import FakeBeats, FakeChords, NoMemory

    from kv_service import library as library_module
    from kv_service.analysis import Analyzer
    from kv_service.library import analysis_needed

    log: list = []
    analyzer = Analyzer(lambda: FakeBeats(log, [], None, 0.5), lambda: FakeChords(log, ("C", "G")), device="cuda",
                        memory=NoMemory(), pitch_factory=MissingPitch)
    data = analyzer.run(sine(16.0, amp=0.5), stems_with_guitar(0.05), "bs_roformer_sw", SR, lambda _f: None).data
    assert data["chords"] and data["beats"]
    assert data["notes"] == [] and data["notesMissing"] is True
    # Once the model is installed, the song is analysed again by itself.
    song = {"analysis": {"status": "ready", "version": data["version"], "notesMissing": True, "source": "bs_roformer_sw"},
            "activeModel": "bs_roformer_sw", "stems": {"bs_roformer_sw": {"status": "ready"}}}
    monkeypatch.setattr(library_module, "pitch_available", lambda: False)
    assert analysis_needed(song) is False
    monkeypatch.setattr(library_module, "pitch_available", lambda: True)
    assert analysis_needed(song) is True
    song["analysis"]["notesMissing"] = False
    assert analysis_needed(song) is False


def test_notes_heard_are_not_missing():
    data = fake_analyzer().run(sine(16.0, amp=0.5), stems_with_guitar(0.05), "bs_roformer_sw", SR, lambda _f: None).data
    assert data["notesMissing"] is False
