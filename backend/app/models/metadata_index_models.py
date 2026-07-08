"""Pydantic models for the read-only metadata index produced by the
native parser sidecar.

These mirror the TypeScript shape in
``backend/sidecar/src/parser/index_types.ts``. Field names use snake_case
on both sides so JSON deserialisation needs no remapping.

This is a separate module from ``ifc_models.py`` so the existing IfcOpenShell
based payloads stay untouched. Tools that want fast access pull in
``MetadataIndex`` and convert to the legacy shape on the way out.
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


class FileNameRecord(BaseModel):
    """FILE_NAME header arguments, lightly typed."""

    name: Optional[str] = None
    timeStamp: Optional[str] = None
    author: list[str] = Field(default_factory=list)
    organization: list[str] = Field(default_factory=list)
    preprocessorVersion: Optional[str] = None
    originatingSystem: Optional[str] = None
    authorization: Optional[str] = None


class HeaderRecord(BaseModel):
    """STEP HEADER section."""

    schema_: Optional[str] = Field(None, alias="schema")
    description: list[str] = Field(default_factory=list)
    implementationLevel: Optional[str] = None
    fileName: FileNameRecord = Field(default_factory=FileNameRecord)
    extras: list[str] = Field(default_factory=list)

    model_config = {
        # The TS side emits `schema` as a JSON key; Pydantic v2 reserves
        # `schema_` so we alias it. ``populate_by_name`` lets internal
        # Python code use either spelling.
        "populate_by_name": True,
    }


class IndexProjectInfo(BaseModel):
    """Project-level summary from IfcProject."""

    id: int
    global_id: Optional[str] = None
    name: Optional[str] = None
    description: Optional[str] = None
    long_name: Optional[str] = None
    phase: Optional[str] = None


class IndexElementSummary(BaseModel):
    """Per-element record in the metadata index."""

    id: int
    global_id: Optional[str] = None
    type: str
    name: Optional[str] = None
    description: Optional[str] = None
    storey_id: Optional[int] = None
    storey_name: Optional[str] = None


class IndexSpatialNode(BaseModel):
    """Spatial-tree node (project / site / building / storey / space)."""

    id: int
    global_id: Optional[str] = None
    type: str
    name: Optional[str] = None
    parent_id: Optional[int] = None
    child_ids: list[int] = Field(default_factory=list)


class IndexPropertyValue(BaseModel):
    """One IfcPropertySingleValue (or quantity)."""
    name: str
    value: Optional[str] = None
    value_type: Optional[str] = None


class IndexPropertySet(BaseModel):
    """One IfcPropertySet flattened."""
    id: int
    name: Optional[str] = None
    description: Optional[str] = None
    properties: list[IndexPropertyValue] = Field(default_factory=list)


class IndexStats(BaseModel):
    """Build statistics - wall-clock + counts."""

    inputBytes: int = 0
    entityCount: int = 0
    byType: dict[str, int] = Field(default_factory=dict)
    parseMs: int = 0
    warningCount: int = 0
    warnings: list[str] = Field(default_factory=list)
    lex_ms: int = 0
    index_ms: int = 0
    total_ms: int = 0
    storey_count: int = 0
    element_count: int = 0


class MetadataIndex(BaseModel):
    """Top-level read-only metadata index - one per IFC SHA-256."""

    index_version: int
    producer_version: str
    source_sha256: str
    source_bytes: int
    schema_: Optional[str] = Field(None, alias="schema")
    header: HeaderRecord
    project: Optional[IndexProjectInfo] = None
    spatial: dict[int, IndexSpatialNode] = Field(default_factory=dict)
    spatial_roots: list[int] = Field(default_factory=list)
    storey_ids: list[int] = Field(default_factory=list)
    elements: dict[int, IndexElementSummary] = Field(default_factory=dict)
    by_type: dict[str, int] = Field(default_factory=dict)
    ids_by_type: dict[str, list[int]] = Field(default_factory=dict)
    ids_by_storey: dict[int, list[int]] = Field(default_factory=dict)
    id_by_global_id: dict[str, int] = Field(default_factory=dict)
    materials: list[str] = Field(default_factory=list)
    # Property sets (empty dict on older cached indexes without pset data)
    element_psets: dict[int, list[IndexPropertySet]] = Field(default_factory=dict)
    # All pset_name → [property_names] across the model
    all_pset_names: dict[str, list[str]] = Field(default_factory=dict)
    stats: IndexStats

    model_config = {
        "populate_by_name": True,
    }


class NativeParseResponse(BaseModel):
    """Wrapper returned by ``POST /api/ifc/native-parse``."""

    cached: bool = Field(
        False,
        description="True if the index was loaded from disk (no re-parse).",
    )
    sidecar_meta: Optional[dict] = Field(
        None,
        description="Sidecar timing meta (elapsedMs, inputBytes, indexBytes).",
    )
    index: MetadataIndex
