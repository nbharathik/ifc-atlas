"""Global tool enable/disable persistence.

The Tools registry tab lets users globally disable a tool:
"don't let any agent call ``execute_ifc_code``, regardless of the
agent's per-allowlist." This service stores that set in JSON on disk
so the choice survives a restart.

Wire model:
- Singleton-ish ``tool_settings_service`` mirrors the pattern used by
  ``sandbox_service`` / ``patch_generator`` etc.
- Disk path: ``~/.ifc-atlas/data/tool_settings.json`` (``DATA_DIR``).
  Created lazily on first write; an absent file means "no disabled
  tools" (default).
- API surface: ``get_disabled()`` returns ``frozenset[str]``;
  ``set_disabled(names)`` overwrites the full set;
  ``add_disabled(name)`` / ``remove_disabled(name)`` are convenience
  mutators. All persist immediately.
- Routing gate: ``chat_routes.router_tool_executor`` calls
  ``is_disabled(name)`` after the per-agent allowlist; a disabled
  tool returns ``{blocked_by_global_disable: true, error: "..."}``.

Thread-safe reads; writes serialised through a single lock so two
concurrent UI toggles can't corrupt the JSON.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path
from typing import Iterable

logger = logging.getLogger(__name__)


def _default_storage_path() -> Path:
    """Pick the storage path. Honours ``TOOL_SETTINGS_PATH`` env var so
    tests can override + future Tauri runs can point at the user-data
    dir without code changes."""
    override = os.environ.get("TOOL_SETTINGS_PATH")
    if override:
        return Path(override)
    # Default sits alongside the other DATA_DIR/*.json singletons. Imported
    # lazily so this module can be loaded by tests without triggering the
    # user-home setup in app.core.config.
    from app.core.config import DATA_DIR

    return Path(DATA_DIR) / "tool_settings.json"


class ToolSettingsService:
    """Tiny JSON-backed registry of globally-disabled tool names."""

    def __init__(self, path: Path | None = None) -> None:
        self._path = path or _default_storage_path()
        self._lock = threading.Lock()
        self._disabled: set[str] = set()
        self._load()

    # ──────────────────────────────────────────────────────────────────
    # Persistence
    # ──────────────────────────────────────────────────────────────────

    def _load(self) -> None:
        try:
            if not self._path.exists():
                return
            raw = self._path.read_text(encoding="utf-8")
            data = json.loads(raw)
            disabled = data.get("disabled_tools", [])
            if isinstance(disabled, list):
                self._disabled = {str(name) for name in disabled if isinstance(name, str)}
        except (OSError, ValueError) as exc:  # corrupt JSON / read failure
            logger.warning("tool_settings load failed; defaulting empty: %s", exc)
            self._disabled = set()

    def _save(self) -> None:
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            payload = {"disabled_tools": sorted(self._disabled)}
            self._path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        except OSError as exc:
            logger.warning("tool_settings save failed: %s", exc)

    # ──────────────────────────────────────────────────────────────────
    # Read API
    # ──────────────────────────────────────────────────────────────────

    def get_disabled(self) -> frozenset[str]:
        """Snapshot of the currently-disabled tool names. Thread-safe."""
        with self._lock:
            return frozenset(self._disabled)

    def is_disabled(self, name: str) -> bool:
        """True iff ``name`` is in the disabled set."""
        with self._lock:
            return name in self._disabled

    # ──────────────────────────────────────────────────────────────────
    # Write API
    # ──────────────────────────────────────────────────────────────────

    def set_disabled(self, names: Iterable[str]) -> frozenset[str]:
        """Overwrite the disabled set with ``names``. Returns the new set."""
        with self._lock:
            self._disabled = {str(n) for n in names}
            self._save()
            return frozenset(self._disabled)

    def add_disabled(self, name: str) -> frozenset[str]:
        with self._lock:
            self._disabled.add(name)
            self._save()
            return frozenset(self._disabled)

    def remove_disabled(self, name: str) -> frozenset[str]:
        with self._lock:
            self._disabled.discard(name)
            self._save()
            return frozenset(self._disabled)

    def clear(self) -> None:
        """Drop everything. Persists an empty set."""
        with self._lock:
            self._disabled.clear()
            self._save()


# Module-level singleton. Tests that need isolation construct their own
# ``ToolSettingsService(path=tmp_path / 'x.json')`` and pass it in.
tool_settings_service = ToolSettingsService()
