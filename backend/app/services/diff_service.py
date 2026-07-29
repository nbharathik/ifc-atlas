"""Working-vs-original model diff: what changed since the file was uploaded.

The working file is a byte copy of the pristine upload, so express ids are
preserved for unchanged elements - which means the existing express-id diff
(:func:`app.services.sandbox_service._compute_diff`) is exactly the right engine
here. We reuse it rather than re-derive a second diff.

Per the cost/carbon/cobie pattern, the model-aware entry point
(:func:`working_vs_original`) runs live, while the bucketing
(:func:`summarize_changes`) and CSV serializer (:func:`diff_to_csv`) are pure and
unit-tested.

This module also hosts the semantic history compare via ifcdiff (plan C3).
It diffs two git checkpoints (or a checkpoint against the CURRENT working
model) with buildingSMART-community ``ifcdiff`` - element-level
added/deleted/changed including property/pset changes, which the legacy
Name/Description/ObjectType checkpoint diff was blind to. CPU-bound: callers
run :func:`compute_diff` off the event loop (``asyncio.to_thread``). Results
are memoized in a tiny LRU keyed by the two content identities - a sha pair
never changes meaning, and "current" is keyed by the working file's
fingerprint so an edit naturally invalidates it.
"""

from __future__ import annotations

import csv
import io
import logging
import os
import tempfile
from collections import OrderedDict
from typing import Any, Optional

import ifcopenshell

from app.models.ifc_models import PendingEditElement
from app.services.sandbox_service import _compute_diff

logger = logging.getLogger(__name__)

# Result cache keyed by the caller's model-contract fingerprint (mirrors
# qto_service._RESULT_CACHE). The diff re-opens the pristine upload from disk
# on every call - expensive on large models - and the panel re-fetches on every
# mount while the CSV export repeats the same work. Edits bump the fingerprint,
# so stale entries simply age out of the tiny LRU.
_RESULT_CACHE: OrderedDict[tuple[str, int], dict[str, Any]] = OrderedDict()
_RESULT_CACHE_MAX = 4


def summarize_changes(
    changes: list[PendingEditElement], max_items: int = 1000
) -> dict[str, Any]:
    """Bucket raw diff changes into added / removed / changed. Pure.

    Counts reflect the full diff; each list is capped at ``max_items`` for
    payload size and ``truncated`` flags any cap.
    """
    added: list[dict[str, Any]] = []
    removed: list[dict[str, Any]] = []
    changed: list[dict[str, Any]] = []

    for c in changes:
        if c.change == "created":
            added.append({"express_id": c.express_id, "ifc_type": c.ifc_type, "name": c.name_after})
        elif c.change == "deleted":
            removed.append(
                {"express_id": c.express_id, "ifc_type": c.ifc_type, "name": c.name_before}
            )
        else:
            changed.append(
                {
                    "express_id": c.express_id,
                    "ifc_type": c.ifc_type,
                    "change": c.change,
                    "name_before": c.name_before,
                    "name_after": c.name_after,
                    "property_changes": c.property_changes,
                }
            )

    counts = {"added": len(added), "removed": len(removed), "changed": len(changed)}
    truncated = any(len(b) > max_items for b in (added, removed, changed))
    return {
        "added": added[:max_items],
        "removed": removed[:max_items],
        "changed": changed[:max_items],
        "counts": counts,
        "truncated": truncated,
    }


def working_vs_original(
    working: ifcopenshell.file,
    original_path: str,
    max_items: int = 1000,
    fingerprint: Optional[str] = None,
) -> dict[str, Any]:
    """Diff the live working model against the pristine uploaded file.

    ``working`` is the in-memory working model (so it reflects unsaved edits);
    ``original_path`` is the untouched upload on disk. Pass ``fingerprint``
    (the model-contract fingerprint) to serve repeat calls from the result
    cache instead of re-opening the original file. Always returns a fresh
    top-level dict, so callers may add keys without contaminating the cache.
    """
    cache_key: Optional[tuple[str, int]] = None
    if fingerprint is not None:
        cache_key = (fingerprint, max_items)
        cached = _RESULT_CACHE.get(cache_key)
        if cached is not None:
            _RESULT_CACHE.move_to_end(cache_key)
            return dict(cached)

    original = ifcopenshell.open(original_path)
    changes = _compute_diff(original, working)
    summary = summarize_changes(changes, max_items=max_items)

    if cache_key is not None:
        while len(_RESULT_CACHE) >= _RESULT_CACHE_MAX:
            _RESULT_CACHE.popitem(last=False)
        _RESULT_CACHE[cache_key] = summary
        return dict(summary)
    return summary


def diff_to_csv(summary: dict[str, Any]) -> str:
    """Flat change report CSV: change, express_id, ifc_type, name/before, after, detail."""
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerow(["change", "express_id", "ifc_type", "before", "after", "detail"])
    for row in summary.get("added", []):
        writer.writerow(["added", row["express_id"], row["ifc_type"], "", row.get("name") or "", ""])
    for row in summary.get("removed", []):
        writer.writerow(["removed", row["express_id"], row["ifc_type"], row.get("name") or "", "", ""])
    for row in summary.get("changed", []):
        detail = "; ".join(
            f"{p.get('property_set', '')}.{p.get('property_name', '')}: "
            f"{p.get('before')} -> {p.get('after')}"
            for p in row.get("property_changes", [])
        )
        writer.writerow(
            [
                row["change"],
                row["express_id"],
                row["ifc_type"],
                row.get("name_before") or "",
                row.get("name_after") or "",
                detail,
            ]
        )
    return buffer.getvalue()


# ---------------------------------------------------------------------------
# Semantic history compare via ifcdiff (plan C3)
# ---------------------------------------------------------------------------

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
