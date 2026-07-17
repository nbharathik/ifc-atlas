"""Shared edit-serialization lock + operation sync-event publisher.

Three surfaces mutate the single IfcOpenShell working copy: the REST editor
routes (``/operations/*``, ``/edits/*``), the chat agent's write tools, and
the MCP server. The REST routes always ran on the FastAPI event loop under one
``asyncio.Lock``; the MCP server used to run writes on a worker thread with NO
lock - a single-writer violation that could interleave mutations from Claude
Desktop with UI edits. Factoring the lock and the sync-event publisher into
this service module lets every surface share them without importing the API
layer (no route imports from services, per the app's layering).

Locking contract (Invariant: one writer at a time, ADR 003):
* Hold ``edit_lock`` across ANY mutation of ``ifc_service``'s working model -
  whether the mutation runs on the event loop (REST routes) or on an executor
  thread (MCP handlers). The lock is async; a thread-based mutation must be
  awaited by its owning coroutine WHILE holding the lock.
* Long read-only work (tessellation, exports) must NOT hold the lock.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

logger = logging.getLogger(__name__)

# The one lock serializing every model mutation across REST / chat / MCP.
edit_lock: asyncio.Lock = asyncio.Lock()


# operation patch tier (str value of operation_service.PatchTier) → the
# ModelSyncEvent wire type that carries it. TRANSFORM/GEOMETRY/BULK gain their
# own wire types with the geometry ops (ADR 005); until an op actually uses a
# tier, mapping it here would be untestable guesswork - unmapped tiers fall
# back to metadata_changed WITH a loud log so under-refresh is diagnosable.
_TIER_TO_SYNC_TYPE: dict[str, str] = {
    "metadata": "metadata_changed",
    "geometry": "geometry_patch",
    "bulk": "rebuild_started",
}


async def publish_operation_events(
    result: dict[str, Any],
    *,
    ifc_service: Any = None,
    broker: Any = None,
) -> None:
    """Broadcast the classified sync events for an applied operation.

    *result* is the public dict shape (``OperationResult.to_public_dict()``,
    optionally enriched by the caller). No-op when the operation changed
    nothing. Ordering matters client-side: the tier event is exempt from the
    client's stale-fingerprint filter and carries the fresh contract; the
    ``metadata_patch`` that follows (for metadata tiers) then matches the
    adopted fingerprint and drives the existing outliner/stats patch path.

    ``ifc_service``/``broker`` are injectable so callers (routes, MCP) can
    pass their own - possibly monkeypatched - references; defaults resolve
    the app singletons lazily (IfcOpenShell must not become an import-time
    dependency of the lock module).
    """
    if not result.get("changed"):
        return

    from app.models.ifc_models import ModelSyncEvent

    if ifc_service is None:
        from app.services.ifc_service import ifc_service as _svc
        ifc_service = _svc
    if broker is None:
        from app.services.model_sync import model_sync_broker
        broker = model_sync_broker
    model_sync_broker = broker

    contract = ifc_service.get_model_contract()
    tier = str(result.get("patch_tier") or "metadata")
    event_type = _TIER_TO_SYNC_TYPE.get(tier)
    if event_type is None:
        logger.warning(
            "no sync wire type for patch tier %s (op %s) - falling back to "
            "metadata_changed; connected viewers may under-refresh",
            tier, result.get("operation"),
        )
        event_type = "metadata_changed"

    changed_ids = list(result.get("changed_ids") or [])
    await model_sync_broker.publish(
        ModelSyncEvent(
            type=event_type,
            model_version=contract["model_version"],
            model_fingerprint=contract["model_fingerprint"],
            edit_id=result.get("edit_id") or "",
            payload={
                "changed_ids": changed_ids,
                "description": result.get("description") or "",
                "operation": result.get("operation") or "",
                "actor": result.get("actor") or "",
                "op_id": result.get("op_id") or "",
            },
        )
    )

    if tier == "metadata" and changed_ids:
        model = getattr(ifc_service, "model", None)
        if model is None:
            return
        updated_elements = []
        for cid in changed_ids[:200]:
            try:
                entity = model.by_id(cid)
            except RuntimeError:
                continue
            if entity is None or entity.is_a("IfcOpeningElement"):
                continue
            if not hasattr(entity, "GlobalId"):
                continue
            updated_elements.append(
                ifc_service._entity_to_summary(entity).model_dump()  # noqa: SLF001
            )
        if updated_elements:
            await model_sync_broker.publish(
                ModelSyncEvent(
                    type="metadata_patch",
                    model_version=contract["model_version"],
                    model_fingerprint=contract["model_fingerprint"],
                    edit_id=result.get("edit_id") or "",
                    payload={
                        "updated_elements": updated_elements,
                        "removed_element_ids": [],
                        "touched_storeys": [],
                        "stats_delta": {},
                    },
                )
            )
