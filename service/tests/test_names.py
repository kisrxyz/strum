import pytest

from kv_service.names import clean_tag, guess_title_artist


@pytest.mark.parametrize(
    ("raw", "clean"),
    [
        ("Кайен (Sefon.Pro)", "Кайен"),
        ("Я Тебя Люблю [muzofond.fm]", "Я Тебя Люблю"),
        ("Песня - www.site.ru", "Песня"),
        ("Песня (www.site.ru) [Muzofond.fm]", "Песня"),
        ("  Группа   Крови  ", "Группа Крови"),
        ("Song (Live)", "Song (Live)"),
        ("Track (feat. Name)", "Track (feat. Name)"),
        ("Песня (St.Petersburg mix)", "Песня (St.Petersburg mix)"),
    ],
)
def test_clean_tag(raw, clean):
    assert clean_tag(raw) == clean


def test_tags_win_and_get_cleaned():
    tags = {"title": "Кайен (Sefon.Pro)", "artist": "Валентин Стрыкало"}
    assert guess_title_artist(tags, "x.mp3") == ("Кайен", "Валентин Стрыкало")


def test_file_name_artist_dash_title():
    assert guess_title_artist({}, "Где Фантом - Я Тебя Люблю.mp3") == ("Я Тебя Люблю", "Где Фантом")


def test_file_name_with_underscores_and_no_artist():
    assert guess_title_artist({}, "Darkhan_Juzz_Qubylmaly.mp3") == ("Darkhan Juzz Qubylmaly", "")


def test_title_tag_without_artist_takes_the_artist_from_the_file_name():
    assert guess_title_artist({"title": "Кукушка"}, "Кино - 07 Кукушка.mp3") == ("Кукушка", "Кино")


def test_empty_everything_still_has_a_title():
    assert guess_title_artist({"title": "  "}, ".mp3") == ("Untitled", "")


def test_file_name_with_hyphens_and_no_spaces():
    # A Guitar Pro file from a tab site: words joined by hyphens, the parts it holds at the end.
    assert guess_title_artist({}, "Muse-Supermassive-Black-Hole-guitar-bass-drums.gp5") == (
        "Muse Supermassive Black Hole",
        "",
    )
    assert guess_title_artist({}, "nirvana_come_as_you_are_tab.gp4") == ("nirvana come as you are", "")


def test_a_title_is_never_left_empty_by_the_dropped_words():
    assert guess_title_artist({}, "guitar-bass.gp5") == ("guitar bass", "")


def test_a_dash_with_spaces_still_splits_artist_and_title():
    assert guess_title_artist({}, "Кино - Группа крови.gp4") == ("Группа крови", "Кино")


def test_a_title_that_ends_with_one_part_word_keeps_it():
    assert guess_title_artist({}, "All_About_That_Bass.mp3") == ("All About That Bass", "")
    assert guess_title_artist({}, "All About That Bass.mp3") == ("All About That Bass", "")


def test_underscored_artist_dash_title_keeps_the_artist():
    assert guess_title_artist({}, "Nirvana_-_Smells_Like_Teen_Spirit.mp3") == ("Smells Like Teen Spirit", "Nirvana")
    assert guess_title_artist({}, "Kino_-_Gruppa_krovi.mp3") == ("Gruppa krovi", "Kino")
