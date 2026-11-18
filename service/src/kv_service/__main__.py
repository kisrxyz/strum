"""Starts the song service: `uv run --project service python -m kv_service` (npm run dev does it)."""

from __future__ import annotations

import socket
import sys

from .config import load_settings, prepare_model_env
from .priority import lower_priority

HOST = "127.0.0.1"


def port_is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind((HOST, port))
        except OSError:
            return False
    return True


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    settings = load_settings()
    # Before torch or huggingface_hub are imported anywhere: weights only from service/.models.
    prepare_model_env(settings.models_dir, offline=True)

    if not port_is_free(settings.port):
        print(f"Порт {settings.port} занят — сервис песен уже запущен?")
        return 0

    # Below the guitar engine: songs are separated while someone plays.
    lower_priority()

    import uvicorn

    from .app import create_app

    app = create_app(settings)
    print(f"Сервис песен: http://{HOST}:{settings.port} · песни в {settings.library_dir}")
    separator = app.state.jobs.separator
    if separator.device == "cpu":
        print("Видеокарты нет — песни будут делиться на процессоре, это в несколько раз дольше.")
    else:
        print(f"Делю песни на видеокарте: {separator.gpu_name}")
    # No access log: the app polls the service every few seconds.
    uvicorn.run(app, host=HOST, port=settings.port, log_level="warning", access_log=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
