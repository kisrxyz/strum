"""The user's own files beside the songs: the app's settings and the amps and cabinets they added.

Until 2026-11-18 both lived in the browser (localStorage and IndexedDB of `localhost:5173`): another
port, another window or «clear site data» lost them. Now they are files, and the browser keeps only a
copy. In the author's copy they sit in the library folder (`library/settings.json`, `library/Amps/`);
in the installed app in «Documents/Strum».

- `settings.json`: whatever the app stores (Zustand's `{state, version}`), written whole.
- `Amps/`: one file per amp (.nam) or cabinet (.wav), named after the file the user dropped, and
  `Amps/index.json` with each one's id (`user:<uuid>`), name, kind and when it was added.
"""

from __future__ import annotations

import json
import re
import threading
import time
from pathlib import Path

from .library import _replace, _write_json

SETTINGS_FILE = "settings.json"
AMPS_DIR = "Amps"
INDEX_FILE = "index.json"
MAX_SETTINGS_BYTES = 2_000_000
# A .nam of the biggest architecture is a few MB of JSON; a cabinet is at most 20 s of wav.
MAX_ASSET_BYTES = 50_000_000
ASSET_ID_RE = re.compile(r"^user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
KINDS = {"model": ".nam", "ir": ".wav"}
_UNSAFE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


class AssetNotFound(Exception):
    pass


def _safe_stem(name: str) -> str:
    """A file name Windows and macOS both accept, from what the user's file was called."""
    # Not Path(name).stem: a slash in a name is not a folder here.
    stem = re.sub(r"\.(nam|wav)$", "", name or "", flags=re.IGNORECASE)
    stem = _UNSAFE.sub("_", stem).strip(" .")[:80]
    return stem or "amp"


class UserData:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.amps = root / AMPS_DIR
        self.lock = threading.RLock()

    # --- settings ---------------------------------------------------------------------------

    def read_settings(self) -> str | None:
        """The settings as stored (JSON text), or None before the first save."""
        path = self.root / SETTINGS_FILE
        with self.lock:
            try:
                return path.read_text(encoding="utf-8")
            except FileNotFoundError:
                return None

    def write_settings(self, data: dict) -> None:
        with self.lock:
            self.root.mkdir(parents=True, exist_ok=True)
            _write_json(self.root / SETTINGS_FILE, data, indent=1)

    # --- amps and cabinets ------------------------------------------------------------------

    def _index(self) -> dict[str, dict]:
        try:
            data = json.loads((self.amps / INDEX_FILE).read_text(encoding="utf-8"))
        except (FileNotFoundError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def _write_index(self, index: dict[str, dict]) -> None:
        self.amps.mkdir(parents=True, exist_ok=True)
        _write_json(self.amps / INDEX_FILE, index)

    def list_assets(self) -> list[dict]:
        with self.lock:
            index = self._index()
            return sorted(
                (
                    {"id": asset_id, "name": info["name"], "kind": info["kind"], "addedAt": info["addedAt"]}
                    for asset_id, info in index.items()
                    if (self.amps / info.get("file", "")).is_file()
                ),
                key=lambda a: a["addedAt"],
            )

    def asset_path(self, asset_id: str) -> tuple[Path, dict]:
        with self.lock:
            info = self._index().get(asset_id)
            path = (self.amps / str(info.get("file", ""))).resolve() if info else None
            # index.json is a file a person can edit: nothing outside Amps/ is ever served.
            inside = path is not None and path.parent == self.amps.resolve()
            if not info or path is None or not inside or not path.is_file():
                raise AssetNotFound(asset_id)
            return path, info

    def put_asset(self, asset_id: str, name: str, kind: str, added_at: float, data: bytes) -> None:
        """Stores (or replaces) one file. Its name follows the user's file, with « (2)» on a clash."""
        if not ASSET_ID_RE.match(asset_id) or kind not in KINDS:
            raise ValueError(asset_id)
        with self.lock:
            index = self._index()
            taken = {info["file"].lower() for other, info in index.items() if other != asset_id}
            old = index.get(asset_id)
            stem, ext = _safe_stem(name), KINDS[kind]
            file = f"{stem}{ext}"
            n = 2
            while file.lower() in taken:
                file = f"{stem} ({n}){ext}"
                n += 1
            self.amps.mkdir(parents=True, exist_ok=True)
            tmp = self.amps / f".tmp-{asset_id[5:]}"
            tmp.write_bytes(data)
            _replace(tmp, self.amps / file)
            if old and old.get("file") and old["file"] != file:
                (self.amps / old["file"]).unlink(missing_ok=True)
            index[asset_id] = {"name": name[:200], "kind": kind, "addedAt": added_at, "file": file}
            self._write_index(index)

    def delete_asset(self, asset_id: str) -> None:
        with self.lock:
            index = self._index()
            info = index.pop(asset_id, None)
            if info is None:
                return
            path = self.amps / info.get("file", "")
            for attempt in range(30):
                try:
                    path.unlink(missing_ok=True)
                    break
                except PermissionError:
                    if attempt == 29:
                        raise
                    time.sleep(0.1)
            self._write_index(index)
