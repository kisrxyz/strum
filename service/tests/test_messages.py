"""Messages for people: Python sends a code and its values, the app owns the words."""

import re
from pathlib import Path

import pytest
from conftest import fake_analyzer, fake_separator, fake_transcriber, local_client

from kv_service.app import create_app
from kv_service.messages import UserError, message, reason_of

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "service" / "src"


def test_message_is_a_code_and_its_values():
    assert message("song.tooLong", limit=720) == {"code": "song.tooLong", "params": {"limit": 720}}
    assert message("song.notFound") == {"code": "song.notFound", "params": {}}


def test_user_error_carries_its_message():
    error = UserError("guitar.deviceNotFound", name="UMC22")
    assert error.code == "guitar.deviceNotFound"
    assert error.params == {"name": "UMC22"}
    assert error.message == {"code": "guitar.deviceNotFound", "params": {"name": "UMC22"}}
    assert str(error) == "guitar.deviceNotFound"  # what the logs show
    with pytest.raises(UserError) as raised:
        raise error
    assert raised.value is error


def test_reason_of_an_unexpected_error():
    assert reason_of(RuntimeError("CUDA  out of\nmemory")) == "CUDA out of memory"
    assert reason_of(RuntimeError()) == "RuntimeError"
    assert reason_of(UserError("x.y")) == "x.y"


def test_a_route_answers_with_a_code(settings):
    app = create_app(settings, separator=fake_separator(), analyzer=fake_analyzer(), transcriber=fake_transcriber())
    with local_client(app) as client:
        too_long = client.post(
            "/api/songs/tab",
            files={"tab": ("song.gp5", b"tab bytes")},
            data={"fileName": "song.gp5", "duration": str(settings.max_seconds + 1)},
        )
        assert too_long.status_code == 413
        assert too_long.json()["detail"] == {"code": "tab.tooLong", "params": {"limit": settings.max_seconds}}
        too_big = client.post(
            "/api/songs/tab",
            files={"tab": ("song.gp5", b"x" * (10 * 2**20 + 1))},
            data={"fileName": "song.gp5", "duration": "10"},
        )
        assert too_big.status_code == 413
        assert too_big.json()["detail"]["code"] == "tab.tooBig"
        missing = client.get("/api/songs/0123456789ab")
        assert missing.status_code == 404
        assert missing.json()["detail"] == {"code": "song.notFound", "params": {}}


def test_a_foreign_page_gets_a_code(settings):
    app = create_app(settings, separator=fake_separator(), analyzer=fake_analyzer(), transcriber=fake_transcriber())
    with local_client(app) as client:
        refused = client.get("/api/songs", headers={"origin": "https://example.com"})
        assert refused.status_code == 403
        assert refused.json()["detail"] == {"code": "origin.forbidden", "params": {}}


AREAS = (
    "program", "origin", "song", "audio", "stems", "separation", "analysis", "words", "transcript",
    "tab", "tabSong", "export", "take", "guitar", "amp", "settings", "asset", "components",
)
FILE_ENDINGS = {"json", "flac", "mp3", "wav", "pcm", "anchors", "tmp", "bin", "nam", "log"}


def _codes_in_python() -> set[str]:
    """Every string literal shaped like a code (`area.what`) in the service and the engine."""
    pattern = re.compile(rf"""["']((?:{"|".join(AREAS)})\.[a-z][A-Za-z]*)["']""")
    found = set()
    for path in [*SRC.glob("kv_service/*.py"), *SRC.glob("kv_guitar/*.py")]:
        found.update(code for code in pattern.findall(path.read_text(encoding="utf-8")) if code.split(".")[1] not in FILE_ENDINGS)
    return found


def _codes_in_app(lang: str) -> set[str]:
    text = (ROOT / "src" / "i18n" / lang / "service.ts").read_text(encoding="utf-8")
    return set(re.findall(r"^\s*'([A-Za-z]+\.[A-Za-z]+)':", text, re.MULTILINE))


def test_every_code_has_words_in_both_languages():
    codes = _codes_in_python()
    assert {"song.notFound", "guitar.rate", "amp.modelFailed", "program.filesMissing"} <= codes
    for lang in ("en", "ru"):
        assert codes - _codes_in_app(lang) == set(), lang
