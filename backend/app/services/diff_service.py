"""Working-vs-original model diff: what changed since the file was uploaded.

The working file is a byte copy of the pristine upload, so express ids are
preserved for unchanged elements - which means the existing express-id diff
(:func:`app.services.sandbox_service._compute_diff`) is exactly the right engine
here. We reuse it rather than re-derive a second diff.

Per the cost/carbon/cobie pattern, the model-aware entry point
(:func:`working_vs_original`) runs live, while the bucketing
(:func:`summarize_changes`) and CSV serializer (:func:`diff_to_csv`) are pure and
unit-tested.
"""

from __future__ import annotations

import csv
import io
import logging
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
