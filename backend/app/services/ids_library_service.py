"""Disk-backed library of reusable IDS documents.

Files live under ``BASE_DIR/ids/`` as ``<id>.ids`` next to a ``library.json``
index. ``id`` is the first 12 hex chars of the SHA-256 of the uploaded bytes,
so re-uploading identical content dedupes to the existing entry.

Validation itself stays in ``app.services.ids_service``; this module only
stores the documents and their header metadata.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from app.core.config import BASE_DIR
from app.services.ids_service import parse_ids_info

logger = logging.getLogger(__name__)

_INDEX_FILENAME = "library.json"


def utc_now_iso() -> str:
    """UTC timestamp in the wire format used by the IDS API ("...Z")."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class IdsLibraryService:
    """Stores IDS XML files plus a JSON index of their header metadata.

    The index is re-read from disk on every public call; it is a small file,
    and rereading keeps the in-process view consistent without a cache
    invalidation protocol.
    """

    def __init__(self, root: Optional[Path] = None) -> None:
        self._root = root if root is not None else BASE_DIR / "ids"
        self._lock = threading.Lock()

    @property
    def root(self) -> Path:
        return self._root

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def list_entries(self) -> list[dict[str, Any]]:
        """Return all library entries in the order they were added."""
        with self._lock:
            return self._load_index()

    def add_entry(self, filename: str, content_bytes: bytes) -> dict[str, Any]:
        """Store an IDS document and return its library entry.

        Raises ``ValueError`` when the content does not parse as IDS XML.
        Re-uploading identical bytes returns the existing entry unchanged.
        """
        text = content_bytes.decode("utf-8-sig", errors="replace")
        info = parse_ids_info(text)
        if not info:
            raise ValueError("Not a valid IDS file")

        entry_id = hashlib.sha256(content_bytes).hexdigest()[:12]
        with self._lock:
            entries = self._load_index()
            for existing in entries:
                if existing["id"] == entry_id:
                    return existing

            self._root.mkdir(parents=True, exist_ok=True)
            (self._root / f"{entry_id}.ids").write_bytes(content_bytes)
            entry: dict[str, Any] = {
                "id": entry_id,
                "filename": Path(filename).name if filename else f"{entry_id}.ids",
                "title": info.get("title", ""),
                "description": info.get("description", ""),
                "specifications_count": int(info.get("specifications_count", 0)),
                "size_bytes": len(content_bytes),
                "added_at": utc_now_iso(),
            }
            entries.append(entry)
            self._save_index(entries)
            return entry

    def delete_entry(self, entry_id: str) -> None:
        """Remove an entry and its stored file. Raises ``KeyError`` if unknown."""
        with self._lock:
            entries = self._load_index()
            remaining = [e for e in entries if e["id"] != entry_id]
            if len(remaining) == len(entries):
                raise KeyError(f"IDS entry not found: {entry_id}")
            self._save_index(remaining)
            (self._root / f"{entry_id}.ids").unlink(missing_ok=True)

    def get_xml(self, entry_id: str) -> str:
        """Return the stored IDS XML text. Raises ``KeyError`` if unknown.

        Membership is checked against the index before any path is built, so
        an attacker-controlled id can never read outside the library dir.
        """
        with self._lock:
            entries = self._load_index()
            if not any(e["id"] == entry_id for e in entries):
                raise KeyError(f"IDS entry not found: {entry_id}")
            path = self._root / f"{entry_id}.ids"
            try:
                return path.read_text(encoding="utf-8-sig", errors="replace")
            except OSError as exc:
                raise KeyError(f"IDS entry file missing: {entry_id}") from exc

    # ------------------------------------------------------------------
    # Index persistence
    # ------------------------------------------------------------------

    def _index_path(self) -> Path:
        return self._root / _INDEX_FILENAME

    def _load_index(self) -> list[dict[str, Any]]:
        path = self._index_path()
        if not path.exists():
            return []
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            logger.warning("IDS library index unreadable at %s; treating as empty", path)
            return []
        entries = data.get("entries", []) if isinstance(data, dict) else []
        return [e for e in entries if isinstance(e, dict) and e.get("id")]

    def _save_index(self, entries: list[dict[str, Any]]) -> None:
        self._root.mkdir(parents=True, exist_ok=True)
        self._index_path().write_text(
            json.dumps({"entries": entries}, indent=2), encoding="utf-8"
        )


ids_library_service = IdsLibraryService()
