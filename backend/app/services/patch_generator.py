"""Patch generator - converts sandbox diffs to typed IfcPatch payloads.

Part of the typed edit-patch protocol described in
`docs/architecture/AI_NATIVE_ENGINE.md`.

Input:  a list of ``PendingEditElement`` produced by ``sandbox_service``'s
        ``_compute_diff`` after an Apply.
Output: an ``IfcPatchBatch`` (from ``app/models/patch.py``) suitable for
        broadcasting over the ``ifc_patch`` WebSocket event.

Design notes
------------
- Each ``PendingEditElement`` maps to one or more typed patches.
  A ``property_changed`` element with a name change AND pset edits
  yields BOTH an ``AttributeChanged`` (for Name) AND one ``PsetChanged``
  per affected property set - batched atomically so the frontend applies
  them without an intermediate inconsistent state.
- Sequence numbers are session-scoped and monotonically increasing.
  They let the frontend detect and drop duplicate or out-of-order
  delivery without any extra bookkeeping on the server side.
- ``source_sha256`` comes from the live model fingerprint *after*
  the sandbox has been promoted, so it matches what the frontend will
  see on the next metadata-patch / rebuild event.
- No geometry is inlined here. ``ElementAdded`` and ``GeometryChanged``
  carry a ``frag_delta_url`` that a future release will populate via the
  sidecar; for now they are ``None`` / absent, which is valid per the schema.
"""

from __future__ import annotations

import time
import threading
from collections import defaultdict
from typing import List, Optional

from app.models.ifc_models import PendingEditElement
from app.models.patch import (
    AttributeChanged,
    ElementAdded,
    ElementRemoved,
    IfcPatchBatch,
    PsetChanged,
)

# Sentinel used by _read_properties_by_pset for pset binding churn.
# Must match the value in sandbox_service.
_PSET_BINDING_KEY = "<pset binding>"


class PatchGenerator:
    """Convert sandbox diffs into ``IfcPatchBatch`` objects.

    A single instance is shared for the lifetime of the server process.
    The sequence counter is protected by a lock so concurrent coroutines
    (two browser tabs applying edits simultaneously) never emit the same
    seq number.
    """

    def __init__(self) -> None:
        self._seq = 0
        self._lock = threading.Lock()

    def _next_seq(self) -> int:
        with self._lock:
            self._seq += 1
            return self._seq

    def generate(
        self,
        changes: List[PendingEditElement],
        *,
        source_sha256: str,
        actor: str = "agent",
        agent_id: Optional[str] = None,
        edit_id: Optional[str] = None,
    ) -> IfcPatchBatch:
        """Convert a list of PendingEditElement changes to an IfcPatchBatch.

        One PendingEditElement may expand to multiple typed patches when
        both a name rename AND property changes are present on the same
        element.  All patches share the same ``source_sha256`` and are
        delivered as a single atomic batch.

        Args:
            changes:      Output of ``sandbox_service._compute_diff``.
            source_sha256: SHA-256 of the authoritative IFC *after* the
                           sandbox was promoted (i.e. the live fingerprint
                           returned by ``ifc_service.model_fingerprint``
                           immediately after ``reload_after_sandbox``).
            actor:        ``"user"``, ``"agent"``, or ``"system"``.
            agent_id:     Agent preset ID (only when actor == "agent").
        """
        now_ms = int(time.time() * 1000)
        patches = []

        for element in changes:
            base_kwargs = dict(
                source_sha256=source_sha256,
                timestamp_ms=now_ms,
                actor=actor,
                agent_id=agent_id,
            )

            change = element.change

            if change == "renamed":
                patches.append(
                    AttributeChanged(
                        seq=self._next_seq(),
                        express_id=element.express_id,
                        attribute="Name",
                        old_value=element.name_before,
                        new_value=element.name_after,
                        **base_kwargs,
                    )
                )

            elif change == "property_changed":
                # Name may have changed alongside property edits.
                if element.name_before != element.name_after:
                    patches.append(
                        AttributeChanged(
                            seq=self._next_seq(),
                            express_id=element.express_id,
                            attribute="Name",
                            old_value=element.name_before,
                            new_value=element.name_after,
                            **base_kwargs,
                        )
                    )

                # Group property changes by pset, skip the binding sentinel.
                pset_buckets: dict[str, dict[str, object]] = defaultdict(dict)
                for pc in element.property_changes:
                    pset_name = pc.get("property_set", "")
                    prop_name = pc.get("property_name", "")
                    if prop_name == _PSET_BINDING_KEY:
                        # Pset attach/detach - no explicit patch needed;
                        # the presence of the pset bucket covers this.
                        continue
                    new_val = pc.get("after")
                    pset_buckets[pset_name][prop_name] = new_val

                for pset_name, prop_changes in pset_buckets.items():
                    if not prop_changes:
                        continue
                    patches.append(
                        PsetChanged(
                            seq=self._next_seq(),
                            express_id=element.express_id,
                            pset_name=pset_name,
                            changes=prop_changes,
                            **base_kwargs,
                        )
                    )

            elif change == "deleted":
                patches.append(
                    ElementRemoved(
                        seq=self._next_seq(),
                        express_id=element.express_id,
                        ifc_type=element.ifc_type,
                        **base_kwargs,
                    )
                )

            elif change == "created":
                # Point at the frag-delta endpoint when the caller
                # provided an edit_id. The frontend's fragmentDeltaLoader
                # fetches geometry per-element from this URL. The v1.1.0 endpoint
                # returns an empty representations map so the frontend falls
                # back to the rebuild_started full-reload; a future release will
                # populate real RawRepresentation blobs.
                frag_url = (
                    f"/api/ifc/frag-delta/{edit_id}" if edit_id else None
                )
                patches.append(
                    ElementAdded(
                        seq=self._next_seq(),
                        express_id=element.express_id,
                        ifc_type=element.ifc_type,
                        frag_delta_url=frag_url,
                        **base_kwargs,
                    )
                )

            elif change == "retyped":
                # Represent type change as a special AttributeChanged on
                # the synthetic "ifc_type" attribute - no IFC schema field
                # matches, but it keeps the patch protocol uniform.
                patches.append(
                    AttributeChanged(
                        seq=self._next_seq(),
                        express_id=element.express_id,
                        attribute="ifc_type",
                        old_value=element.ifc_type_before,
                        new_value=element.ifc_type_after,
                        **base_kwargs,
                    )
                )
                # Name may also differ after retype.
                if element.name_before != element.name_after:
                    patches.append(
                        AttributeChanged(
                            seq=self._next_seq(),
                            express_id=element.express_id,
                            attribute="Name",
                            old_value=element.name_before,
                            new_value=element.name_after,
                            **base_kwargs,
                        )
                    )

        return IfcPatchBatch(patches=patches)  # type: ignore[arg-type]


# Module-level singleton - the route layer uses this directly.
patch_generator = PatchGenerator()
