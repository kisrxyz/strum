"""Python sends people no words: messages are codes (kv_service/messages.py), the app has the
words in both languages (src/i18n/*/service.ts). A Russian string in these files is a text that
would reach the user untranslated.

Allowed: comments and docstrings; the words of downloaded files' names (a dict named
`FILE_WORDS`, marked `# file-name words (exception)`); a pattern that reads Russian input, marked
`# reads Russian input` on its line. Dev tools (probe.py, compare.py, fetch_models.py, the
`__main__` banners) and names.py (the junk of Russian download sites) are not listed.
"""

import ast
import io
import re
import tokenize
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src"
USER_FACING = [
    *(f"kv_service/{name}.py" for name in (
        "app", "jobs", "takes", "library", "export", "separation", "analysis", "lyrics", "sections", "audio",
    )),
    *(f"kv_guitar/{name}.py" for name in (
        "config", "assets", "nam_wasm", "core", "server", "chain", "protocol", "fake",
    )),
]
CYRILLIC = re.compile("[Ѐ-ӿ]")
STRING_TOKENS = {tokenize.STRING} | {getattr(tokenize, "FSTRING_MIDDLE", tokenize.STRING)}
FILE_WORDS_MARK = "# file-name words (exception)"
READS_INPUT_MARK = "# reads Russian input"


def _allowed_lines(source: str) -> set[int]:
    """Lines of docstrings (any bare string statement) and of FILE_WORDS tables."""
    allowed: set[int] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
            allowed.update(range(node.lineno, (node.end_lineno or node.lineno) + 1))
        elif isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == "FILE_WORDS" for target in node.targets
        ):
            allowed.update(range(node.lineno, (node.end_lineno or node.lineno) + 1))
    return allowed


def russian_strings(path: Path) -> list[str]:
    """`line: text` of each Russian string literal that is not allowed."""
    source = path.read_text(encoding="utf-8")
    lines = source.splitlines()
    allowed = _allowed_lines(source)
    found = []
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type not in STRING_TOKENS or not CYRILLIC.search(token.string):
            continue
        first, last = token.start[0], token.end[0]
        if any(line in allowed for line in range(first, last + 1)):
            continue
        if READS_INPUT_MARK in lines[first - 1]:
            continue
        found.append(f"{first}: {lines[first - 1].strip()}")
    return found


@pytest.mark.parametrize("name", USER_FACING)
def test_no_russian_text_for_people(name):
    path = SRC / name
    assert path.is_file(), name
    assert russian_strings(path) == []


@pytest.mark.parametrize("name", ["kv_service/export.py", "kv_service/takes.py"])
def test_file_words_are_marked(name):
    source = (SRC / name).read_text(encoding="utf-8")
    assert FILE_WORDS_MARK in source and "FILE_WORDS = {" in source


def test_the_check_finds_a_russian_string(tmp_path):
    path = tmp_path / "sample.py"
    path.write_text(
        '"""Модуль: docstrings may be Russian."""\n'
        "# a comment: Привет\n"
        'TEXT = "Песня не найдена."\n'
        'NAME = f"Таб {1}"\n'
        "FILE_WORDS = {\n"
        '    "ru": {"backing": "Минусовка"},\n'
        "}\n"
        'JUNK = re.compile("скачать")  # reads Russian input\n',
        encoding="utf-8",
    )
    assert [line.split(":")[0] for line in russian_strings(path)] == ["3", "4"]
