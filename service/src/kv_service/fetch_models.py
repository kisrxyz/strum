"""Downloads the separation, analysis and lyrics models into service/.models (run by `npm run setup`).

    uv run --project service python -m kv_service.fetch_models

Never fails the install: a missing network or missing packages only print what to do.
"""

from __future__ import annotations

import sys

from .config import load_settings, prepare_model_env
from .models import (
    ANALYSIS_WEIGHTS,
    LYRICS_WEIGHTS,
    MODELS,
    fetch_weight,
    fetch_weights,
    ml_installed,
    model_installed,
    weight_ready,
    weights_ready,
)


def main() -> int:
    # The Windows console is cp1251; the model libraries print emoji while downloading.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    settings = load_settings()
    prepare_model_env(settings.models_dir, offline=False)

    if not ml_installed():
        print("[setup] Нейросети не установлены. В терминале: npm run setup")
        return 0

    missing = 0
    for model in MODELS.values():
        if not model_installed(model.id):
            continue  # BS-RoFormer only where its package is (the author's copy)
        if weights_ready(model.id, settings.models_dir):
            print(f"[setup] Модель {model.name} уже скачана.")
            continue
        print(f"[setup] Скачиваю модель {model.name}…")
        try:
            fetch_weights(model.id, settings.models_dir)
        except Exception as error:  # noqa: BLE001 - any failure only means "try again later"
            missing += 1
            print(f"[setup] Не получилось скачать {model.name}: {error}")
        else:
            print(f"[setup] Модель {model.name} готова.")
    for weight in (*ANALYSIS_WEIGHTS.values(), *LYRICS_WEIGHTS.values()):
        if weight_ready(weight.id, settings.models_dir):
            print(f"[setup] Модель {weight.name} уже скачана.")
            continue
        size = f", {weight.size / 1e6:.0f} МБ" if weight.size >= 1_000_000 else ""
        print(f"[setup] Скачиваю модель {weight.name}{size}…", flush=True)
        try:
            fetch_weight(weight.id, settings.models_dir)
        except Exception as error:  # noqa: BLE001 - any failure only means "try again later"
            missing += 1
            print(f"[setup] Не получилось скачать {weight.name}: {error}")
        else:
            print(f"[setup] Модель {weight.name} готова.")
    if missing:
        print("[setup] Проверь интернет и запусти npm run setup ещё раз. Комбик работает и без моделей.")
    else:
        print(f"[setup] Модели на месте: {settings.models_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
