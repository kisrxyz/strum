"""Compares the two models on test-songs/ through the running service.

    npm run dev                                   (or: node scripts/dev-service.mjs)
    node scripts/uv.mjs run --no-sync --project service python -m kv_service.compare

Adds every song to the library, splits it with both models, prints a Markdown table (time, video
memory, device) and bookmarks two 15-second places per song where the guitar stands out most —
the places to listen to when choosing the model by ear.
"""

from __future__ import annotations

import argparse
import io
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

from .audio import SAMPLE_RATE
from .config import REPO_ROOT
from .models import MODELS

AUDIO_SUFFIXES = {".mp3", ".m4a", ".flac", ".wav", ".ogg"}
DEVICE_NAMES = {"cuda": "видеокарта", "cpu": "процессор", "mps": "видеокарта Mac"}
BOOKMARK_PREFIX = "Слушать: гитара"


# A note is a message code now (messages.py); this dev table shows the code.
def _note_text(note) -> str:
    return note.get("code", "") if isinstance(note, dict) else (note or "")


def listening_windows(
    guitars: list[np.ndarray], mix: np.ndarray, sr: int, length: int = 15, count: int = 2
) -> list[tuple[float, float]]:
    """Non-overlapping windows (seconds) where the guitar stems are loudest relative to the mix."""
    frames = min(len(mix), *(len(g) for g in guitars))
    blocks = frames // sr
    if blocks < length:
        return [(0.0, float(blocks))] if blocks else []

    def energy(x: np.ndarray) -> np.ndarray:
        return np.square(x[: blocks * sr], dtype=np.float64).reshape(blocks, -1).mean(axis=1)

    guitar = np.mean([energy(g) for g in guitars], axis=0)
    ratio = guitar / (energy(mix) + 1e-9)
    scores = np.convolve(ratio, np.ones(length), mode="valid")  # score of the window starting at each second
    chosen: list[int] = []
    for _ in range(count):
        free = [s for s in range(len(scores)) if all(abs(s - c) >= length for c in chosen)]
        if not free:
            break
        chosen.append(max(free, key=lambda s: scores[s]))
    return [(float(s), float(s + length)) for s in sorted(chosen)]


def _clock(seconds: float) -> str:
    total = int(round(seconds))
    return f"{total // 60}:{total % 60:02d}"


def _speed(duration: float, seconds: float) -> str:
    factor = duration / seconds if seconds else 0.0
    text = f"{factor:.1f}" if factor >= 1 else f"{factor:.2f}"
    return "×" + text.replace(".", ",")


def markdown_table(rows: list[dict]) -> str:
    lines = [
        "| Песня | Длина | Модель | Где | Время | Быстрее реального | Пик видеопамяти | Заметка |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for r in rows:
        peak = f"{r['peakVramMb']} МиБ" if r.get("peakVramMb") else "—"
        cells = [
            r["song"],
            _clock(r["duration"]),
            r["model"],
            DEVICE_NAMES.get(r["device"], r["device"]),
            f"{round(r['seconds'])} с",
            _speed(r["duration"], r["seconds"]),
            peak,
            _note_text(r.get("note")),
        ]
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines)


def _upload(client, path: Path) -> dict:
    audio, sr = sf.read(str(path), dtype="float32", always_2d=True)
    if sr != SAMPLE_RATE:
        raise SystemExit(f"{path.name}: нужен файл 44,1 кГц, а у него {sr} Гц — добавь его через приложение.")
    if audio.shape[1] == 1:
        audio = np.repeat(audio, 2, axis=1)
    wav = io.BytesIO()
    sf.write(wav, audio[:, :2], sr, format="WAV", subtype="FLOAT")
    files = {"original": (path.name, path.read_bytes()), "mix": ("mix.wav", wav.getvalue(), "audio/wav")}
    response = client.post("/api/songs", files=files, data={"fileName": path.name})
    response.raise_for_status()
    return response.json()["song"]


def _read_flac(client, url: str) -> np.ndarray:
    response = client.get(url)
    response.raise_for_status()
    data, _ = sf.read(io.BytesIO(response.content), dtype="float32", always_2d=True)
    return data


def main(argv: list[str] | None = None) -> int:
    import httpx

    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    parser = argparse.ArgumentParser(description="Сравнение моделей разделения на test-songs/")
    parser.add_argument("--songs", type=Path, default=REPO_ROOT / "test-songs")
    parser.add_argument("--url", default="http://127.0.0.1:5174")
    parser.add_argument("--models", default=",".join(MODELS))
    args = parser.parse_args(argv)
    models = [m for m in args.models.split(",") if m]

    client = httpx.Client(base_url=args.url, timeout=600)
    try:
        health = client.get("/api/health").json()
    except httpx.HTTPError:
        print("Сервис песен не отвечает. Запусти npm run dev и повтори.")
        return 1
    missing = [m["name"] for m in health["models"] if m["id"] in models and not m["ready"]]
    if missing:
        print(f"Не скачаны модели: {', '.join(missing)}. В терминале: npm run setup")
        return 1
    print(f"Устройство: {health['device']} {health.get('gpuName') or ''}")

    paths = sorted(p for p in args.songs.iterdir() if p.suffix.lower() in AUDIO_SUFFIXES)
    songs = []
    for path in paths:
        song = _upload(client, path)
        print(f"Добавлена: {song['artist']} — {song['title']} ({_clock(song['duration'])})")
        songs.append(song)
    # One model after another over all songs: each model loads once.
    for model in models:
        for song in songs:
            if song["stems"].get(model, {}).get("status") not in ("ready", "queued", "running"):
                client.post(f"/api/songs/{song['id']}/separate", params={"model": model}).raise_for_status()

    pending = {(s["id"], m) for s in songs for m in models}
    last_report = 0.0
    while pending:
        time.sleep(2)
        for song_id, model in list(pending):
            info = client.get(f"/api/songs/{song_id}").json()["stems"].get(model, {})
            if info.get("status") in ("ready", "error"):
                pending.discard((song_id, model))
        if time.monotonic() - last_report > 20:
            last_report = time.monotonic()
            print(f"…осталось разделений: {len(pending)}")

    rows = []
    for song in songs:
        fresh = client.get(f"/api/songs/{song['id']}").json()
        guitars = []
        for model in models:
            info = fresh["stems"].get(model, {})
            if info.get("status") != "ready":
                print(f"{fresh['title']} / {MODELS[model].name}: не получилось — {info.get('error')}")
                continue
            rows.append({
                "song": fresh["title"], "duration": fresh["duration"], "model": MODELS[model].name,
                "device": info["device"], "seconds": info["seconds"], "peakVramMb": info.get("peakVramMb"),
                "note": info.get("note"),
            })
            version = info.get("finishedAt", "")
            guitars.append(_read_flac(client, f"/api/songs/{song['id']}/stems/{model}/guitar.flac?v={version}"))
        if not guitars:
            continue
        mix = _read_flac(client, f"/api/songs/{song['id']}/mix.flac")
        windows = listening_windows(guitars, mix, SAMPLE_RATE)
        marks = [b for b in fresh["player"]["bookmarks"] if not b["name"].startswith(BOOKMARK_PREFIX)]
        marks += [{"name": f"{BOOKMARK_PREFIX} {i + 1}", "start": a, "end": b} for i, (a, b) in enumerate(windows)]
        client.patch(f"/api/songs/{song['id']}", json={"player": {"bookmarks": marks}}).raise_for_status()
        print(f"Слушать в «{fresh['title']}»: " + ", ".join(f"{_clock(a)}–{_clock(b)}" for a, b in windows))

    print()
    print(markdown_table(rows))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
