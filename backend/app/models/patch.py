"""Typed patch-protocol payloads for the AI-native IFC engine.

Part of the typed edit-patch protocol described in
`docs/architecture/AI_NATIVE_ENGINE.md`.

These Pydantic models define the wire format for the `ifc_patch` WebSocket
event. A future release may replace this file with codegen from a shared
JSON schema; until then, keep these types mirrored by hand with
`frontend/src/types/ifcPatch.ts`.

Design goals:
- Discriminated union keyed on `kind`, so frontend can narrow types by
  one field.
- Every patch carries a monotonic `seq` so clients de-dupe and detect
  out-of-order delivery.
- Every patch carries the source fingerprint (`source_sha256`) of the IFC
  file at the time of emission; clients reject patches whose source does
  not match the loaded model (prevents patches from leaking across
  disconnected sessions).
- No patch carries geometry inline - big geometry deltas go through a
  `frag_delta_url` the client downloads separately.
"""

from __future__ import annotations

from typing import Annotated, Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, Field


class _PatchBase(BaseModel):
    """Common fields every patch carries."""

    seq: int = Field(..., description="Monotonic sequence number within the session.")
    source_sha256: str = Field(
        ..., description="SHA-256 of the authoritative IFC bytes at emission time."
    )
    timestamp_ms: int = Field(..., description="Server wall-clock at emission (ms since epoch).")
    actor: Literal["user", "agent", "system"] = Field(
        ..., description="Who caused the change. Surfaces in activity log."
    )
    agent_id: Optional[str] = Field(
        default=None, description="Which agent preset emitted this (only when actor=agent)."
    )


class AttributeChanged(_PatchBase):
    """One attribute on one element changed (name, description, GlobalId, etc.)."""

    kind: Literal["attribute_changed"] = "attribute_changed"
    express_id: int
    attribute: str
    old_value: Optional[Any] = None
    new_value: Any


class PsetChanged(_PatchBase):
    """One or more property-set values on one element changed."""

    kind: Literal["pset_changed"] = "pset_changed"
    express_id: int
    pset_name: str
    changes: Dict[str, Any] = Field(
        default_factory=dict,
        description="Property name → new value. None deletes the property.",
    )


class ElementAdded(_PatchBase):
    """A new element (wall / door / etc.) was added to the model."""

    kind: Literal["element_added"] = "element_added"
    express_id: int
    ifc_type: str
    storey_express_id: Optional[int] = None
    # Geometry for the new element arrives via `frag_delta_url` - a tiny
    # `.frag` the client loads with `fragmentsManager.core.load(delta,
    # { merge: true })`. If null, the element is metadata-only (e.g. an
    # IfcPropertySet).
    frag_delta_url: Optional[str] = None


class ElementRemoved(_PatchBase):
    """An element was deleted from the model."""

    kind: Literal["element_removed"] = "element_removed"
    express_id: int
    ifc_type: str


class GeometryChanged(_PatchBase):
    """Geometry of existing elements changed (wall moved, opening resized)."""

    kind: Literal["geometry_changed"] = "geometry_changed"
    express_ids: List[int]
    frag_delta_url: str = Field(
        ..., description="URL to the mini-.frag containing replacement geometry for these IDs."
    )


class StoreyChanged(_PatchBase):
    """Spatial hierarchy changed - elements reassigned to different storeys."""

    kind: Literal["storey_changed"] = "storey_changed"
    express_id: int
    old_storey_express_id: Optional[int] = None
    new_storey_express_id: Optional[int] = None


# Discriminated union - frontend narrows on `kind`.
IfcPatch = Annotated[
    Union[
        AttributeChanged,
        PsetChanged,
        ElementAdded,
        ElementRemoved,
        GeometryChanged,
        StoreyChanged,
    ],
    Field(discriminator="kind"),
]


class IfcPatchBatch(BaseModel):
    """Wrapper for multiple patches delivered in one WS message.

    Single edits with multiple side-effects (e.g. "rename wall + move to
    storey 2") should flow as a batch so the frontend applies them
    atomically (no intermediate inconsistent visual state).
    """

    patches: List[IfcPatch]  # type: ignore[valid-type]
    # The WS envelope kind stays `ifc_patch` so routing code is unified;
    # a single patch is a batch of length 1.


__all__ = [
    "AttributeChanged",
    "PsetChanged",
    "ElementAdded",
    "ElementRemoved",
    "GeometryChanged",
    "StoreyChanged",
    "IfcPatch",
    "IfcPatchBatch",
]
