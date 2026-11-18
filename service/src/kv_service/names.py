"""Song title and artist from tags or the file name, without download-site junk."""

from __future__ import annotations

import re

# "Sefon.Pro", "muzofond.fm", "www.site.ru": a dot and a short top-level domain, no spaces.
_DOMAIN = r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,6}\b"
_JUNK_TAIL = re.compile(
    rf"\s*(?:\([^()]*{_DOMAIN}[^()]*\)|\[[^\[\]]*{_DOMAIN}[^\[\]]*\]|\s[-–—]\s+\S*{_DOMAIN}\S*)\s*$"
)
_DASH = re.compile(r"\s+[-–—]\s+")
_SPACES = re.compile(r"\s+")
# What a tab site appends to a file name: the parts the file holds ("…-guitar-bass-drums.gp5").
_PART_WORDS = {"guitar", "guitars", "bass", "drums", "vocals", "tab", "tabs", "full"}


def clean_tag(text: str) -> str:
    """Drops trailing parts that name a web site: «Кайен (Sefon.Pro)» → «Кайен»."""
    text = _SPACES.sub(" ", text or "").strip()
    while True:
        shorter = _JUNK_TAIL.sub("", text)
        if shorter == text:
            return text
        text = shorter.strip()


def guess_title_artist(tags: dict[str, str], file_name: str) -> tuple[str, str]:
    """Tags first; otherwise «Исполнитель - Название.mp3»."""
    name = file_name.replace("\\", "/").rsplit("/", 1)[-1]
    if "." in name:
        name = name.rsplit(".", 1)[0]
    if " " not in name.strip():
        # «Artist_-_Title»: the dash between underscores is the artist-title separator, kept as " - ".
        name = re.sub(r"_+[-–—]+_+", " - ", name)
    if " " not in name.strip():
        # Words joined by _ or - (tab sites): split them, drop the parts list at the end.
        name = _without_part_words(re.sub(r"[_-]+", " ", name))
    name = clean_tag(name.replace("_", " "))
    parts = _DASH.split(name, maxsplit=1)
    file_artist, file_title = (parts[0], parts[1]) if len(parts) == 2 else ("", name)
    title = clean_tag(tags.get("title", "")) or clean_tag(file_title) or "Untitled"
    artist = clean_tag(tags.get("artist", "")) or clean_tag(file_artist)
    return title, artist


def _without_part_words(name: str) -> str:
    """"Muse Supermassive Black Hole guitar bass drums" → "Muse Supermassive Black Hole". Only a
    list (two words or more) or a final "tab" counts: "All About That Bass" keeps its bass. A name
    made only of such words stays as it is."""
    words = name.split()
    kept = list(words)
    while kept and kept[-1].lower() in _PART_WORDS:
        kept.pop()
    dropped = words[len(kept):]
    if not kept or (len(dropped) < 2 and not (dropped and dropped[-1].lower() in {"tab", "tabs"})):
        return " ".join(words)
    return " ".join(kept)
