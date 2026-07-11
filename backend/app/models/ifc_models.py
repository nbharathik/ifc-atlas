from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


class ProjectInfo(BaseModel):
    name: str
    description: Optional[str] = None
    schema_version: str
    author: Optional[str] = None
    organization: Optional[str] = None


class SpatialNode(BaseModel):
    id: int
    global_id: str
    name: str
    ifc_type: str
    storey: Optional[str] = None
    children: list["SpatialNode"] = Field(default_factory=list)


class ElementSummary(BaseModel):
    id: int
    global_id: str
    name: Optional[str] = None
    ifc_type: str
    storey: Optional[str] = None


class PropertySet(BaseModel):
    name: str
    properties: dict[str, str | int | float | bool | None]


class ElementDetail(BaseModel):
    id: int
    global_id: str
    name: Optional[str] = None
    ifc_type: str
    storey: Optional[str] = None
    material: Optional[str] = None
    property_sets: list[PropertySet] = Field(default_factory=list)
    quantities: dict[str, float] = Field(default_factory=dict)
    relating_type: Optional[str] = None
    # Direct IFC attributes the old extractor silently dropped:
    #   description    - IfcRoot.Description
    #   object_type    - IfcObject.ObjectType (author-defined sub-classification)
    #   tag            - IfcElement.Tag (author's external ID, e.g. Revit element id)
    #   predefined_type - subclass-specific enum (IfcWall.PredefinedType etc.)
    description: Optional[str] = None
    object_type: Optional[str] = None
    tag: Optional[str] = None
    predefined_type: Optional[str] = None


class ModelStats(BaseModel):
    total_elements: int
    by_type: dict[str, int]
    storeys: list[str]
    materials: list[str]


class SearchResult(BaseModel):
    elements: list[ElementSummary]
    total: int
    query: str


class ModelContract(BaseModel):
    """Versioned model contract shared by backend and frontend."""

    model_version: int
    model_fingerprint: str
    edit_id: Optional[str] = None


class ReadinessTimingsModel(BaseModel):
    """Wall-clock timings (ms) for AI backend warm-up steps."""

    native_index_built_ms: Optional[int] = None
    ifcopenshell_loaded_ms: Optional[int] = None


class ReadinessStatus(BaseModel):
    """Surface the AI backend warm-up state to the chat panel."""

    model_id: Optional[str] = None
    native_index: Literal["absent", "building", "ready", "error"]
    ifcopenshell: Literal["cold", "warming", "ready", "error"]
    timings_ms: ReadinessTimingsModel = Field(default_factory=ReadinessTimingsModel)
    native_index_error: Optional[str] = None
    ifcopenshell_error: Optional[str] = None


class TileInfo(BaseModel):
    """One spatial tile in the XY grid per storey."""

    tile_id: str
    storey_idx: int
    cell_x: int
    cell_y: int
    aabb_min: tuple[float, float, float]
    aabb_max: tuple[float, float, float]
    element_ids: list[int] = Field(default_factory=list)
    element_count: int


class TileManifest(BaseModel):
    """All spatial tiles for one IFC model at one grid resolution."""

    source_sha256: str
    grid_resolution: int
    world_aabb_min: tuple[float, float, float]
    world_aabb_max: tuple[float, float, float]
    total_elements: int
    total_tiles: int
    tiles: list[TileInfo] = Field(default_factory=list)
    # Provenance: did we read from the AABB cache or fall
    # back to placement-origin point AABBs?
    aabb_source: Literal["real", "placement", "mixed"] = "placement"


class AABBResponse(BaseModel):
    """One element's world-space axis-aligned bounding box."""

    express_id: int
    aabb_min: tuple[float, float, float]
    aabb_max: tuple[float, float, float]


class AABBBulkRequest(BaseModel):
    """Request body for `POST /api/ifc/aabb/bulk`."""

    express_ids: list[int] = Field(default_factory=list, max_length=10000)


class AABBBulkResponse(BaseModel):
    """Bulk-AABB response - only cached elements appear; missing IDs are silently dropped."""

    sha: str
    aabbs: list[AABBResponse] = Field(default_factory=list)
    missing: list[int] = Field(default_factory=list)


class AABBCacheStatus(BaseModel):
    """Live compute status for the AABB background warm-up."""

    sha: str
    state: Literal["idle", "computing", "ready", "failed"]
    count: int = 0
    total_expected: int = 0
    total_ms: float = 0.0
    error: Optional[str] = None


class ModelMeta(BaseModel):
    """Bundled metadata returned by /api/ifc/meta (and /api/ifc/upload).

    Combining project info, spatial tree, and stats into a single response
    lets the frontend hydrate in one round-trip instead of three - big
    win on upload (saves 1-2 s) and on page refresh.
    """
    project: ProjectInfo
    tree: Optional[SpatialNode] = None
    stats: Optional[ModelStats] = None
    model_version: int
    model_fingerprint: str
    edit_id: Optional[str] = None


class EditOperation(BaseModel):
    """Logical edit operation sent by the frontend for incremental sync."""

    op: Literal[
        "set_name",
        "set_description",
        "set_property",
        "set_visibility",
        "set_transform",
        "create",
        "delete",
    ]
    express_id: Optional[int] = None
    ifc_type: Optional[str] = None
    property_set: Optional[str] = None
    property_name: Optional[str] = None
    value: Optional[str | int | float | bool] = None
    visible: Optional[bool] = None
    payload: dict[str, Any] = Field(default_factory=dict)


class EditApplyRequest(BaseModel):
    operations: list[EditOperation] = Field(default_factory=list)
    base_model_version: Optional[int] = None
    consistency_mode: Literal["hybrid", "strong", "frontend_first"] = "hybrid"


class MetadataPatch(BaseModel):
    updated_elements: list[ElementSummary] = Field(default_factory=list)
    removed_element_ids: list[int] = Field(default_factory=list)
    touched_storeys: list[str] = Field(default_factory=list)
    stats_delta: dict[str, int] = Field(default_factory=dict)


class EditApplyResponse(BaseModel):
    edit_id: str
    model_version: int
    model_fingerprint: str
    changed_express_ids: list[int] = Field(default_factory=list)
    metadata_patch: MetadataPatch = Field(default_factory=MetadataPatch)
    status: Literal["accepted", "rejected"]
    requires_rebuild: bool = False
    message: Optional[str] = None


class ModelSyncEvent(BaseModel):
    type: Literal[
        "edit_accepted",
        "edit_rejected",
        "geometry_patch",
        "metadata_patch",
        "metadata_changed",
        "rebuild_started",
        "rebuild_ready",
        "pending_edit",
        "pending_applied",
        "pending_discarded",
        "ifc_patch",
        "native_index_ready",
        "readiness_changed",
        "viewer_command",
    ]
    model_version: int
    model_fingerprint: str
    edit_id: Optional[str] = None
    payload: dict[str, Any] = Field(default_factory=dict)


class PendingEditElement(BaseModel):
    """One element touched by a pending edit. Express id is stable across
    the sandbox and live model because we operate on a deep copy by path."""

    express_id: int
    ifc_type: str
    change: Literal["renamed", "retyped", "property_changed", "deleted", "created"]
    name_before: Optional[str] = None
    name_after: Optional[str] = None
    ifc_type_before: Optional[str] = None
    ifc_type_after: Optional[str] = None
    property_changes: list[dict[str, Any]] = Field(default_factory=list)


class PendingEditEnvelope(BaseModel):
    """Hash-gated sandbox diff - frontend renders as Apply/Discard preview.

    The sandbox is persisted to a throwaway `.ifc` on disk; applying moves
    that file into the live path and reloads the authoritative handle.
    """

    edit_id: str
    created_at: float
    base_model_version: int
    base_model_fingerprint: str
    sandbox_fingerprint: str
    # Human-oriented tagline for the chat/LLM
    summary: str
    # What the LLM asked for, preserved for the UI
    operations: list[dict[str, Any]] = Field(default_factory=list)
    # Structural diff - one entry per touched express id
    changes: list[PendingEditElement] = Field(default_factory=list)
    # Counts for the badge
    counts: dict[str, int] = Field(default_factory=dict)
    # D4 verifier: health-check delta vs the live baseline + geometry sanity
    # for created elements, computed on the sandbox BEFORE presenting the
    # edit. {status: 'pass'|'warn'|'fail', new_errors, new_warnings,
    # geometry: {checked, failures: [...]}, note}. None = verifier skipped.
    verifier_verdict: Optional[dict[str, Any]] = None


class AggregateRequest(BaseModel):
    """Request body for /api/ifc/aggregate."""
    express_ids: list[int]


class AggregateResult(BaseModel):
    """Aggregated quantities + histograms for a set of IFC elements."""
    count: int
    # ΣArea and ΣVolume from IfcElementQuantity - None when no qty data found
    total_area: Optional[float] = None
    total_volume: Optional[float] = None
    # area / volume quantity name that was summed (e.g. "GrossArea")
    area_quantity_name: Optional[str] = None
    volume_quantity_name: Optional[str] = None
    # material → element count
    material_histogram: dict[str, int] = Field(default_factory=dict)
    # ifc_type (without Ifc prefix) → element count
    type_histogram: dict[str, int] = Field(default_factory=dict)
    # express IDs that had no quantity data
    missing_quantity_ids: list[int] = Field(default_factory=list)


class IdsFailingElement(BaseModel):
    """Single element that failed an IDS requirement."""
    id: int
    global_id: Optional[str] = None
    ifc_type: str
    name: Optional[str] = None
    facet_type: str
    reason: str


class IdsSpecResult(BaseModel):
    """Per-specification result from an IDS validation run."""
    name: str
    status: Literal["passed", "failed", "no_applicable"]
    applied_to: int
    passed: int
    failed: int
    description: str = ""
    ifc_type: Optional[str] = None
    predefined_type: Optional[str] = None
    applicability: list[dict] = Field(default_factory=list)
    requirements: list[dict] = Field(default_factory=list)
    failing_elements: list[IdsFailingElement] = Field(default_factory=list)
    failing_truncated: bool = False
    ifc_versions: list[str] = Field(default_factory=list)
    min_occurs: Optional[int] = None
    max_occurs: Optional[int] = None


class IdsValidationResult(BaseModel):
    """Full result returned by validate_ids / ids_validate tool."""
    total_specifications: int
    passed: int
    failed: int
    no_applicable: int
    specifications: list[IdsSpecResult] = Field(default_factory=list)
    ids_title: str = ""
    ids_version: str = ""
    ids_description: str = ""
    engine: str
    all_failing_ids: list[int] = Field(default_factory=list)


class ChatAttachment(BaseModel):
    """File the user attached to a chat turn.

    kind:
      - image → forwarded to vision-capable models as a base64 image block.
      - text  → inlined into the user message as a fenced block.
      - ids   → buildingSMART IDS XML; triggers ids_validate implicitly.
      - other → metadata only.
    """

    kind: Literal["image", "text", "ids", "other"] = "other"
    name: str
    mime: Optional[str] = None
    data_base64: str
    size: Optional[int] = None


class ChatMessage(BaseModel):
    role: str  # "user" or "assistant"
    content: str
    attachments: list[ChatAttachment] = Field(default_factory=list)


class IFCCheckpoint(BaseModel):
    sha: str
    message: str
    timestamp: str  # ISO-8601
    edit_count: int
    is_initial: bool = False


class RollbackRequest(BaseModel):
    sha: str


class CheckpointStatus(BaseModel):
    available: bool
    count: int
    checkpoints: list[IFCCheckpoint]


class DiffAttributeChange(BaseModel):
    """A single attribute that changed between snapshot and current model."""
    attribute: str
    before: Optional[str] = None
    after: Optional[str] = None


class CheckpointDiffEntry(BaseModel):
    """One entity in a checkpoint diff result."""
    global_id: str
    ifc_type: str
    name: Optional[str] = None
    change: Literal["added", "removed", "changed"]
    attribute_changes: list[DiffAttributeChange] = Field(default_factory=list)
    express_id: Optional[int] = None


class CheckpointDiffResult(BaseModel):
    """Result of comparing a checkpoint snapshot against the current model."""
    sha: str
    added: int
    removed: int
    changed: int
    total: int
    truncated: bool = False
    entries: list[CheckpointDiffEntry] = Field(default_factory=list)


class ChatRequest(BaseModel):
    message: str
    history: list[ChatMessage] = Field(default_factory=list)
    provider: str = "openai"
    model: Optional[str] = None
    temperature: Optional[float] = None
    tool_mode: Literal["server", "client", "hybrid"] = "server"
    agent_id: Optional[str] = None
    attachments: list[ChatAttachment] = Field(default_factory=list)
    # Express ids currently selected in the 3D viewer (client-authoritative -
    # works in BROWSER_ONLY too). Injected per-turn as a "Current selection"
    # context block so "rename the selected wall" just works without the agent
    # polling /api/viewer/state (plan D6).
    selected_ids: list[int] = Field(default_factory=list)
    # Optional global tool-set filter. When set, the LLM only sees tools whose
    # name appears in tool_set_registry.get(tool_set_id).tools - applied on
    # top of any per-agent allowed_tools restriction. None = no filter.
    tool_set_id: Optional[str] = None
    # Optional system-prompt override fetched from prompt_library.get(prompt_id).
    # When set, replaces the agent's system_prompt for this turn only.
    prompt_id: Optional[str] = None
    # Optional Model Registry entry id. When set, the backend resolves the
    # provider, model_id, and sampling settings (temperature, top_p, max output
    # tokens, reasoning) from model_registry.get(model_registry_id). The registry
    # entry id (not model_id) is used because two entries may share a model_id
    # with different presets. None = legacy provider/model/temperature path.
    model_registry_id: Optional[str] = None
    # LangGraph graph-mode: when True the handler saves a checkpoint after
    # each turn so sessions survive client reconnects.
    use_graph: bool = False
    # Stable client-assigned ID for graph checkpointing.  Generate a UUID
    # once on session start and pass it with every turn.
    thread_id: Optional[str] = None
