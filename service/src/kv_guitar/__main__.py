"""Starts the fast guitar engine: `uv run --no-sync --project service python -m kv_guitar`
(`npm run dev` does it through scripts/dev-guitar.mjs).

Env: KV_GUITAR_PORT (5175), KV_GUITAR_FAKE (`saw` or a .wav: no sound card at all), KV_TONES_DIR.
"""

from __future__ import annotations

import socket
import sys

from .config import HOST, load_settings


def port_is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind((HOST, port))
        except OSError:
            return False
    return True


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    settings = load_settings()
    if not port_is_free(settings.port):
        print(f"Порт {settings.port} занят — быстрый звук уже запущен?")
        return 0

    import uvicorn

    from .server import create_app

    app = create_app(settings)
    print(f"Быстрый звук гитары: ws://{HOST}:{settings.port}/guitar")
    if settings.fake:
        print(f"Без звуковой карты: вместо гитары — {'пила 110 Гц' if settings.fake == 'saw' else settings.fake}.")
    # No access log: nothing here is worth a line per request.
    uvicorn.run(
        app,
        host=HOST,
        port=settings.port,
        log_level="warning",
        access_log=False,
        # The `websockets` library (service/pyproject.toml). It waits when a browser's socket is
        # full, which is what lets one slow browser fall behind alone (server.ClientQueue).
        ws="websockets-sansio",
        # Float audio does not compress; packing a hundred frames a second would only cost time.
        ws_per_message_deflate=False,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
