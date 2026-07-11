"""Semantic history compare via ifcdiff (plan C3).

Diffs two git checkpoints (or a checkpoint against the CURRENT working model)
with buildingSMART-community ``ifcdiff`` - element-level added/deleted/changed
including property/pset changes, which the legacy Name/Description/ObjectType
checkpoint diff was blind to. CPU-bound: callers run :func:`compute_diff` off
the event loop (``asyncio.to_thread``).

Results are memoized in a tiny LRU keyed by the two content identities - a
sha pair never changes meaning, and "current" is keyed by the working file's
fingerprint so an edit naturally invalidates it.
"""

from __future__ import annotations

import logging
import os
import tempfile
from collections import OrderedDict
from typing import Any, Optional

logger = logging.getLogger(__name__)

_MAX_CACHE_ENTRIES = 8
_cache: OrderedDict[tuple[str, str], dict[str, Any]] = OrderedDict()


def is_available() -> bool:
    try:
        import ifcdiff  # noqa: F401

        return True
    except ImportError:
        return False


def compute_diff(
    old_bytes: bytes,
    new_bytes: bytes,
    *,
    old_key: str,
    new_key: str,
    max_entries: int = 200,
) -> dict[str, Any]:
    """Return a structured semantic diff between two IFC byte payloads.

    Shape: ``{added, deleted, changed, total, truncated, entries: [{global_id,
    express_id, ifc_type, name, change, detail}]}``. Raises RuntimeError when
    ifcdiff is unavailable and ValueError when either payload fails to parse.
    """
    cache_key = (old_key, new_key)
    hit = _cache.get(cache_key)
    if hit is not None:
        _cache.move_to_end(cache_key)
        return hit

    import ifcopenshell
    from ifcdiff import IfcDiff

    old_model = _open_bytes(old_bytes, ifcopenshell)
    new_model = _open_bytes(new_bytes, ifcopenshell)

    # relationships must be explicit: without it ifcdiff only reports
    # added/deleted elements and misses attribute/property/geometry changes
    # (verified against 0.8.5 - a bare IfcDiff().diff() returned an empty
    # change register for a renamed wall).
    d = IfcDiff(
        old_model,
        new_model,
        relationships=["geometry", "attributes", "property", "type", "container", "classification"],
        is_shallow=False,
    )
    d.diff()

    entries: list[dict[str, Any]] = []

    def _describe(model: Any, gid: str, change: str, detail: Any = None) -> dict[str, Any]:
        express_id: Optional[int] = None
        ifc_type: Optional[str] = None
        name: Optional[str] = None
        try:
            e = model.by_guid(gid)
            express_id = e.id()
            ifc_type = e.is_a()
            name = getattr(e, "Name", None)
        except Exception:
            pass
        out: dict[str, Any] = {
            "global_id": gid,
            "express_id": express_id,
            "ifc_type": ifc_type,
            "name": name,
            "change": change,
        }
        if detail is not None:
            out["detail"] = _compact_detail(detail)
        return out

    for gid in sorted(d.added_elements):
        entries.append(_describe(new_model, gid, "added"))
    for gid in sorted(d.deleted_elements):
        entries.append(_describe(old_model, gid, "deleted"))
    for gid, changes in sorted((d.change_register or {}).items()):
        entries.append(_describe(new_model, gid, "changed", detail=changes))

    added = len(d.added_elements)
    deleted = len(d.deleted_elements)
    changed = len(d.change_register or {})
    truncated = len(entries) > max_entries

    result = {
        "added": added,
        "deleted": deleted,
        "changed": changed,
        "total": added + deleted + changed,
        "truncated": truncated,
        "entries": entries[:max_entries],
    }

    _cache[cache_key] = result
    _cache.move_to_end(cache_key)
    while len(_cache) > _MAX_CACHE_ENTRIES:
        _cache.popitem(last=False)
    return result


def _open_bytes(data: bytes, ifcopenshell: Any) -> Any:
    fd, path = tempfile.mkstemp(suffix=".ifc")
    try:
        os.write(fd, data)
        os.close(fd)
        return ifcopenshell.open(path)
    except Exception as exc:
        raise ValueError(f"Could not parse IFC payload for diff: {exc}") from exc
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def _compact_detail(changes: Any, max_chars: int = 2000) -> Any:
    """deepdiff change dictionaries can be enormous; keep a bounded, JSON-safe
    summary (the UI shows headline keys, not full payloads)."""
    import json

    try:
        blob = json.dumps(changes, default=str)
    except (TypeError, ValueError):
        return {"summary": str(changes)[:max_chars]}
    if len(blob) <= max_chars:
        return json.loads(blob)
    keys = sorted(changes.keys()) if isinstance(changes, dict) else []
    return {"_truncated": True, "keys": keys[:50]}


def clear_cache() -> None:
    _cache.clear()
