"""The built-in presets, read from src/state/presets.ts — the one place they are written down."""

import json
import re
from pathlib import Path

PRESETS_TS = Path(__file__).resolve().parents[2] / "src" / "state" / "presets.ts"


def _to_json(ts: str) -> str:
    ts = re.sub(r"//[^\n]*", "", ts)
    ts = re.sub(r"([{,]\s*)([A-Za-z_]\w*)\s*:", r'\1"\2":', ts)
    ts = ts.replace("'", '"')
    return re.sub(r",(\s*[}\]])", r"\1", ts)


def default_presets() -> dict[str, dict]:
    """DEFAULT_PRESETS by id, as the browser would send them."""
    source = PRESETS_TS.read_text(encoding="utf-8")
    consts = dict(re.findall(r"const (\w+): \w+ = (\{[^}]*\});", source))
    block = re.search(r"export const DEFAULT_PRESETS[^=]*= (\[.*?\n\]);", source, re.S).group(1)
    for name, body in consts.items():
        block = re.sub(rf"\b{name}\b", body, block)
    return {preset["id"]: preset for preset in json.loads(_to_json(block))}


def first_presets() -> dict[str, dict]:
    """The presets as they were until 2026-11-16 (`FIRST_AMPS`: the TONE3000 demo amps, and
    `FIRST_EFFECTS`), without the hum filter and the self-adjusting gate that came the same day:
    what the browser's levels of 12 Nov were measured with."""
    source = PRESETS_TS.read_text(encoding="utf-8")
    consts = dict(re.findall(r"const (\w+): \w+ = (\{[^}]*\});", source))
    amps = json.loads(_to_json(re.search(r"export const FIRST_AMPS[^=]*= (\{.*?\n\});", source, re.S).group(1)))
    effects_block = re.search(r"export const FIRST_EFFECTS[^=]*= (\{.*?\n\});", source, re.S).group(1)
    for name, body in consts.items():
        effects_block = re.sub(rf"\b{name}\b", body, effects_block)
    effects = json.loads(_to_json(effects_block))
    presets = default_presets()
    for preset_id, preset in presets.items():
        preset["amp"].update(amps[preset_id])
        preset["amp"]["hum"] = False
        preset["amp"]["gateAuto"] = False
        preset.update(effects[preset_id])
    return presets
