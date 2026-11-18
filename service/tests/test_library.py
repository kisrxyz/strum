import json
import threading

import numpy as np
import pytest

from conftest import SR, sine
from kv_service.audio import read_audio
from kv_service.library import STEMS, Library, SongNotFound


@pytest.fixture
def library(tmp_path) -> Library:
    return Library(tmp_path / "library")


def add(library: Library, original: bytes = b"original-1", name: str = "Кино - Кукушка.mp3", seconds: float = 1.0):
    return library.create(original, name, sine(seconds))


def test_create_makes_the_song_folder(library):
    song, created = add(library)
    assert created is True
    folder = library.root / song["id"]
    assert sorted(p.name for p in folder.iterdir()) == ["mix.flac", "original.mp3", "peaks.bin", "song.json"]
    assert len(song["id"]) == 12
    assert song["title"] == "Кукушка"
    assert song["artist"] == "Кино"
    assert song["duration"] == pytest.approx(1.0)
    assert song["player"]["muted"] == ["guitar"]
    assert song["player"]["volumesDb"] == {stem: 0 for stem in STEMS}
    assert song["stems"] == {}
    assert song["activeModel"] is None


def test_same_file_twice_is_one_song(library):
    first, _ = add(library)
    second, created = add(library, name="другое имя.mp3")
    assert created is False
    assert second["id"] == first["id"]
    assert len(library.list()) == 1


def test_mix_with_overs_is_scaled_down(library):
    song, _ = library.create(b"loud", "loud.wav", sine(0.5, amp=1.5))
    mix, _ = read_audio(library.mix_path(song["id"]))
    assert np.max(np.abs(mix)) <= 0.981
    assert song["mixGainDb"] == pytest.approx(20 * np.log10(0.98 / 1.5), abs=0.01)


def test_list_is_newest_first(library):
    a, _ = add(library, b"a")
    b, _ = add(library, b"b")
    # addedAt has one-second resolution: make the first song explicitly older
    (library.root / a["id"] / "song.json").write_text(
        json.dumps({**library.get(a["id"]), "addedAt": "2026-01-01T00:00:00+00:00"}), encoding="utf-8"
    )
    assert [s["id"] for s in library.list()] == [b["id"], a["id"]]


def test_update_merges_the_player(library):
    song, _ = add(library)
    updated = library.update(song["id"], {"player": {"speed": 0.8, "volumesDb": {"bass": -6}}, "notes": "медленно"})
    assert updated["player"]["speed"] == 0.8
    assert updated["player"]["muted"] == ["guitar"]
    assert updated["player"]["volumesDb"]["bass"] == -6
    assert updated["player"]["volumesDb"]["vocals"] == 0
    assert library.get(song["id"])["notes"] == "медленно"


def test_active_model_must_be_ready(library):
    song, _ = add(library)
    with pytest.raises(ValueError):
        library.update(song["id"], {"activeModel": "htdemucs_6s"})


def test_write_stems_shares_one_headroom_and_picks_the_active_model(library):
    song, _ = add(library)
    stems = {stem: sine(1.0, amp=0.3) for stem in STEMS}
    stems["drums"] = sine(1.0, amp=1.96)
    updated = library.write_stems(song["id"], "htdemucs_6s", stems, {"device": "cuda", "seconds": 12.5})
    info = updated["stems"]["htdemucs_6s"]
    assert info["status"] == "ready"
    assert info["device"] == "cuda"
    assert info["gainDb"] == pytest.approx(20 * np.log10(0.5), abs=0.01)
    assert updated["activeModel"] == "htdemucs_6s"
    guitar, _ = read_audio(library.stem_path(song["id"], "htdemucs_6s", "guitar"))
    assert np.max(np.abs(guitar)) == pytest.approx(0.15, abs=0.002)
    assert not list((library.root / song["id"] / "stems").glob(".tmp-*"))


def test_write_stems_of_a_deleted_song_fails(library):
    song, _ = add(library)
    library.delete(song["id"])
    with pytest.raises(SongNotFound):
        library.write_stems(song["id"], "htdemucs_6s", {s: sine(1.0) for s in STEMS}, {})
    assert not (library.root / song["id"]).exists()


def test_drop_stems_switches_the_active_model(library):
    song, _ = add(library)
    for model in ("htdemucs_6s", "bs_roformer_sw"):
        library.write_stems(song["id"], model, {s: sine(1.0, amp=0.1) for s in STEMS}, {})
    library.drop_stems(song["id"], "htdemucs_6s")
    song = library.get(song["id"])
    assert "htdemucs_6s" not in song["stems"]
    assert song["activeModel"] == "bs_roformer_sw"
    assert not (library.root / song["id"] / "stems" / "htdemucs_6s").exists()


def test_recover_cleans_up_and_requeues(library):
    song, _ = add(library)
    library.set_stems(song["id"], "bs_roformer_sw", status="running")
    (library.root / ".tmp-abc").mkdir()
    (library.root / "0123456789ab").mkdir()  # a deleted song whose folder was locked
    (library.root / song["id"] / "stems" / ".tmp-bs_roformer_sw").mkdir(parents=True)
    assert library.recover() == [(song["id"], "bs_roformer_sw")]
    assert library.get(song["id"])["stems"]["bs_roformer_sw"]["status"] == "queued"
    assert not (library.root / ".tmp-abc").exists()
    assert not (library.root / "0123456789ab").exists()
    assert not (library.root / song["id"] / "stems" / ".tmp-bs_roformer_sw").exists()


def test_saving_waits_while_another_program_reads_song_json(library):
    # On Windows a file that is open (an antivirus, an editor, a request reading it) cannot be
    # replaced. The library has to wait a moment instead of failing.
    song, _ = add(library)
    handle = open(library.root / song["id"] / "song.json", "rb")
    threading.Timer(0.3, handle.close).start()
    library.set_stems(song["id"], "htdemucs_6s", status="queued")
    assert library.get(song["id"])["stems"]["htdemucs_6s"]["status"] == "queued"


def test_deleting_waits_while_another_program_reads_song_json(library):
    song, _ = add(library)
    handle = open(library.root / song["id"] / "song.json", "rb")
    threading.Timer(0.3, handle.close).start()
    library.delete(song["id"])
    with pytest.raises(SongNotFound):
        library.get(song["id"])


def test_delete_and_bad_ids(library):
    song, _ = add(library)
    library.delete(song["id"])
    with pytest.raises(SongNotFound):
        library.get(song["id"])
    with pytest.raises(SongNotFound):
        library.get("../../etc")
    with pytest.raises(SongNotFound):
        library.delete(song["id"])
