"""
Tool definitions and execution for the IFC model query agent.

Each tool maps to an IFC service operation. The LLM can call these tools
to query the loaded model, and the results are fed back for synthesis.
"""

import asyncio
import concurrent.futures
import json
import logging
from typing import Any, Callable, Optional

from app.services.aabb_service import aabb_service, find_nearby_via_aabbs
from app.services.code_runner import DEFAULT_TIMEOUT_S as _CODE_DEFAULT_TIMEOUT_S
from app.services.element_index_service import element_index
from app.services.element_relationships import build_relationship_map, get_graph
from app.services.ids_service import extract_failing_ids, validate_ids_base64
from app.services.ifc_service import ifc_service
from app.services.metadata_index_service import metadata_index_service
from app.services.operation_service import Actor, operation_service
from app.services.qto_service import (
    DEFAULT_CURRENCY,
    GROUP_FIELDS,
    compute_boq,
    compute_carbon,
)
from app.services.sandbox_service import sandbox_service
from app.services.tool_support import tool_memo_cache

logger = logging.getLogger(__name__)

# Names of tools that mutate the model - these invalidate the memo cache.
_WRITE_TOOL_NAMES: frozenset[str] = frozenset(
    {
        "edit_semantic",
        "edit_structural",
        "execute_ifc_code",
        "undo_last_edit",
    }
)

# -- Tool schemas (OpenAI function-calling format, also used for Anthropic) --

# Each tool carries a `"where"` key - internal to the router, stripped
# before the schema leaves the server for the LLM SDKs. Values:
#   - "client": execute in the browser via the metadata worker + store.
#               The LLM call round-trips through the chat WS.
#   - "server": execute here with ifcopenshell. Used for tools that need
#               the full entity graph / psets index that the client
#               metadata worker doesn't pre-build yet.
# When `ChatRequest.tool_mode == "server"` every tool runs server-side
# regardless of "where"; with "client" only client tools are exposed.
# "hybrid" (the default) respects each tool's "where".
# Merged tools are client-capable only for specific modes/parts; the
# per-call routing lives in `_CLIENT_ROUTING` (see `tool_where`), so their
# static "where" below stays "server" (the safe superset).

TOOL_DEFINITIONS = [
    {
        "name": "describe_model",
        "description": (
            "Read one overview aspect of the loaded IFC model. part='project': "
            "metadata (name, schema, author, organization). 'stats': element "
            "counts by IFC type, storey list, materials. 'storeys': storeys "
            "with Express IDs and names. 'property_names': every property-set "
            "and property name in the model - discover these before property "
            "queries."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "part": {
                    "type": "string",
                    "enum": ["project", "stats", "storeys", "property_names"],
                    "description": "Which overview to return.",
                },
            },
            "required": ["part"],
        },
        "where": "server",
    },
    {
        "name": "query_elements",
        "description": (
            "Find IFC elements matching a predicate; returns element summaries "
            "(Express ID, name, type, storey). mode='text': match query against "
            "name/type/GlobalId. 'semantic': natural-language query like "
            "'load-bearing walls'. 'type': all elements of the exact IFC class "
            "in ifc_type. 'storey': all elements on storey_id. 'type_name': "
            "elements whose IfcTypeObject name contains query (e.g. 'Basic "
            "Wall'). 'property': elements by property - give property_name, "
            "plus operator+value to compare, value alone for equality, or "
            "neither to list elements having the property. 'near': elements "
            "within radius_m of element_id, sorted by distance."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "mode": {
                    "type": "string",
                    "enum": [
                        "text", "semantic", "type", "storey",
                        "type_name", "property", "near",
                    ],
                    "description": "Search strategy.",
                },
                "query": {
                    "type": "string",
                    "description": "Search text (modes text, semantic, type_name).",
                },
                "ifc_type": {
                    "type": "string",
                    "description": "IFC class, e.g. 'IfcWall' (required for mode=type; optional filter for text/property).",
                },
                "storey": {
                    "type": "string",
                    "description": "Storey name filter (modes text, property).",
                },
                "storey_id": {
                    "type": "integer",
                    "description": "Storey Express ID (required for mode=storey).",
                },
                "property_name": {
                    "type": "string",
                    "description": "Property to match, e.g. 'FireRating' (mode=property).",
                },
                "operator": {
                    "type": "string",
                    "enum": ["eq", "neq", "contains", "startswith", "gt", "lt", "gte", "lte"],
                    "description": "Comparison operator (mode=property).",
                },
                "value": {
                    "type": "string",
                    "description": "Value to compare against (mode=property).",
                },
                "pset_name": {
                    "type": "string",
                    "description": "Property-set filter, e.g. 'Pset_WallCommon' (mode=property).",
                },
                "element_id": {
                    "type": "integer",
                    "description": "Reference element (mode=near).",
                },
                "radius_m": {
                    "type": "number",
                    "description": "Search radius in metres, default 5.0 (mode=near).",
                },
                "ifc_types": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional IFC class filter list (mode=near).",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max results to return.",
                },
            },
            "required": ["mode"],
        },
        "where": "server",
    },
    {
        "name": "get_element",
        "description": (
            "Read one element by Express ID. include selects aspects: "
            "'details' (default - attributes, property sets, quantities, "
            "type), 'material' (material/layer set with thicknesses), "
            "'openings' (hosted doors/windows), 'connections' "
            "(path-connected neighbours), 'relationships' (full map: spatial "
            "containment chain, aggregation, openings, connections, type "
            "object + pset sharing stats)."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "element_id": {
                    "type": "integer",
                    "description": "The IFC Express ID of the element.",
                },
                "include": {
                    "type": "array",
                    "items": {
                        "type": "string",
                        "enum": ["details", "material", "openings", "connections", "relationships"],
                    },
                    "description": "Aspects to return (default ['details']).",
                },
            },
            "required": ["element_id"],
        },
        "where": "server",
    },
    {
        "name": "viewer_control",
        "description": (
            "Drive the 3D viewer (presentation only - never modifies the "
            "model). action='highlight': colour-mark element_ids. 'select': "
            "select one element_id and open its properties panel. 'isolate': "
            "show only element_ids, hide the rest (empty array clears "
            "isolation). 'show_all': restore full visibility. "
            "'clip_section_box': fit the section-box crop to element_id."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["highlight", "select", "isolate", "show_all", "clip_section_box"],
                    "description": "Viewer action to perform.",
                },
                "element_ids": {
                    "type": "array",
                    "items": {"type": "integer"},
                    "description": "Target Express IDs (actions highlight, isolate).",
                },
                "element_id": {
                    "type": "integer",
                    "description": "Target Express ID (actions select, clip_section_box).",
                },
            },
            "required": ["action"],
        },
        "where": "client",
    },
    {
        "name": "quantity_summary",
        "description": (
            "Aggregate model totals. kind='qto': IfcElementQuantity totals "
            "(areas, volumes, lengths, counts) grouped by ifc_type or storey - "
            "use for 'total wall area' style questions instead of summing "
            "element-by-element. 'cost': priced bill of quantities from the "
            "editable rate library. 'carbon': embodied-carbon estimate from "
            "the editable factor library. Cost/carbon defaults are "
            "illustrative placeholders, NOT market prices or a certified LCA - "
            "present those figures as rough estimates."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "kind": {
                    "type": "string",
                    "enum": ["qto", "cost", "carbon"],
                    "description": "Which summary to compute.",
                },
                "group_by": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "Grouping dimensions. qto: 'ifc_type' or 'storey' "
                        "(first entry, default ifc_type). cost extras beyond "
                        "the implicit ifc_class: storey|material|type_object|"
                        "classification. carbon extras beyond the implicit "
                        "material: ifc_class|storey|type_object|classification."
                    ),
                },
                "ifc_type": {
                    "type": "string",
                    "description": "Optional IFC class filter (kind=qto).",
                },
                "storey": {
                    "type": "string",
                    "description": "Optional storey name filter (kind=qto).",
                },
                "top_rows": {
                    "type": "integer",
                    "description": "Max rows returned, sorted descending (cost/carbon, default 25, max 100). Totals always cover all rows.",
                },
            },
            "required": ["kind"],
        },
        "where": "server",
    },
    {
        "name": "validate_model",
        "description": (
            "Quality-check the model. check='health': deterministic rules "
            "(missing/duplicate GlobalIds, blank names, empty psets, missing "
            "storey assignment, duplicate type names, element count). 'audit': "
            "THE tool for 'audit this model' / 'is it ready?' - chains health, "
            "quantity/cost/carbon coverage and the last cached IDS run into "
            "one report; flag cost/carbon figures as estimates. 'ids': "
            "validate against buildingSMART IDS XML supplied as ids_base64 "
            "(from a chat attachment with kind='ids'); returns per-spec "
            "pass/fail with offending Express IDs. Set highlight_failures=true "
            "to instead highlight the failing elements in the viewer "
            "(optionally only spec_name)."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "check": {
                    "type": "string",
                    "enum": ["health", "audit", "ids"],
                    "description": "Which validation to run.",
                },
                "ids_base64": {
                    "type": "string",
                    "description": "Base64-encoded IDS XML (required for check=ids).",
                },
                "spec_name": {
                    "type": "string",
                    "description": "Restrict highlighting to one specification name (check=ids).",
                },
                "highlight_failures": {
                    "type": "boolean",
                    "description": "Highlight failing elements in the viewer instead of returning the report (check=ids).",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max issues per rule/spec (defaults: health 50, audit 10, ids 25).",
                },
            },
            "required": ["check"],
        },
        "where": "server",
    },
    {
        "name": "get_docs",
        "description": (
            "Unified reference lookup - works WITHOUT a loaded model. "
            "source='ifcopenshell': the installed IfcOpenShell Python API - "
            "consult BEFORE writing execute_ifc_code (pass symbol for an "
            "exact API path). 'bsdd': buildingSMART Data Dictionary - "
            "free-text search for classifications/properties via query, or "
            "pass uri (from a previous search) with detail='class' or "
            "'properties' for one class's definition or its standard property "
            "list. 'user': search documents the user uploaded (specs, "
            "standards, notes). 'ifc-schema': IFC entity/attribute reference. "
            "If a source isn't indexed yet the result says so."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "source": {
                    "type": "string",
                    "enum": ["ifcopenshell", "bsdd", "user", "ifc-schema"],
                    "description": "Which knowledge source to query.",
                },
                "query": {
                    "type": "string",
                    "description": "Natural-language question or keywords.",
                },
                "symbol": {
                    "type": "string",
                    "description": "Exact symbol to prioritise, e.g. 'ifcopenshell.api.pset.edit_pset'.",
                },
                "uri": {
                    "type": "string",
                    "description": "bSDD class URI for a detail lookup (source=bsdd).",
                },
                "detail": {
                    "type": "string",
                    "enum": ["class", "properties"],
                    "description": "With uri: full class definition (default) or its property list.",
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum passages/results (default 5, max 15).",
                },
            },
            "required": ["source"],
        },
        "where": "server",
    },
    # ---- Write tools (edit assistant) ----
    {
        "name": "edit_semantic",
        "description": (
            "Stage metadata-only edits (no geometry change, no viewer reload) "
            "as one atomic batch sharing a single undo entry. Chat-agent calls "
            "are sandboxed into a pending diff the user must Apply. Ops: "
            "{op:'set_name', element_id, new_name}; {op:'set_property', "
            "element_id, property_name, new_value, pset_name?}; "
            "{op:'set_attribute', element_id, attribute: Description|"
            "ObjectType|Tag|LongName, new_value}. Confirm element IDs and "
            "current values with get_element first."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "ops": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "op": {
                                "type": "string",
                                "enum": ["set_name", "set_property", "set_attribute"],
                            },
                            "element_id": {"type": "integer"},
                            "new_name": {"type": "string"},
                            "property_name": {"type": "string"},
                            "new_value": {},
                            "pset_name": {"type": "string"},
                            "attribute": {
                                "type": "string",
                                "enum": ["Description", "ObjectType", "Tag", "LongName"],
                            },
                        },
                        "required": ["op", "element_id"],
                    },
                    "description": "Ordered metadata edit operations.",
                },
                "summary": {
                    "type": "string",
                    "description": "Optional one-line human summary shown in the preview.",
                },
            },
            "required": ["ops"],
        },
        "where": "server",
    },
    {
        "name": "edit_structural",
        "description": (
            "Stage geometry-changing edits; applying reloads the 3D viewer. "
            "Every call returns a pending diff the user must Apply - nothing "
            "mutates until they do. Ops: {op:'create_wall', start:[x,y], "
            "end:[x,y], height?, thickness?, storey_name?, name?} - new "
            "IfcWallStandardCase between two points (metres); "
            "{op:'delete_element', element_id, reason?} - delete an "
            "IfcProduct; NOT undoable after Apply, warn the user before "
            "large deletions."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "ops": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "op": {
                                "type": "string",
                                "enum": ["create_wall", "delete_element"],
                            },
                            "start": {
                                "type": "array",
                                "items": {"type": "number"},
                                "minItems": 2,
                                "maxItems": 3,
                            },
                            "end": {
                                "type": "array",
                                "items": {"type": "number"},
                                "minItems": 2,
                                "maxItems": 3,
                            },
                            "height": {"type": "number"},
                            "thickness": {"type": "number"},
                            "storey_name": {"type": "string"},
                            "name": {"type": "string"},
                            "element_id": {"type": "integer"},
                            "reason": {"type": "string"},
                        },
                        "required": ["op"],
                    },
                    "description": "Ordered structural operations.",
                },
                "summary": {
                    "type": "string",
                    "description": "Optional one-line human summary shown in the preview.",
                },
            },
            "required": ["ops"],
        },
        "where": "server",
    },
    {
        "name": "execute_ifc_query_code",
        "description": (
            "Run read-only Python against a sandboxed COPY of the IFC model "
            "for analysis and question answering - use when the structured "
            "read tools are not expressive enough. Available names: `model` / "
            "`ifc` (the open ifcopenshell.file handle), `ifcopenshell`, "
            "`ifcopenshell.api`, `ifcopenshell.util.element`, plus `math`, "
            "`statistics`, `re`, `json`, `collections`, `uuid`. Assign to a "
            "`result` variable for a value back in the chat summary; print "
            "output is also captured. If the code produces structural model "
            "changes, the sandbox is discarded and an error returned - use "
            "execute_ifc_code when you intend to stage edits."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "code": {
                    "type": "string",
                    "description": (
                        "Python source to execute read-only. See the tool "
                        "description for the names available in scope. Max "
                        "100000 chars."
                    ),
                },
                "timeout_s": {
                    "type": "number",
                    "description": (
                        "Wall-clock budget in seconds. Default 240, min 1, "
                        "max 240."
                    ),
                },
            },
            "required": ["code"],
        },
        "where": "server",
    },
    {
        "name": "execute_ifc_code",
        "description": (
            "Run edit-capable Python against a sandboxed COPY of the IFC "
            "model - the full sandbox-then-apply edit path. Use when the "
            "change doesn't fit edit_semantic/edit_structural ops (batch "
            "geometry moves, custom algorithms, relationship rewiring, psets "
            "created/deleted programmatically). Available names: `model` / "
            "`ifc` (the open ifcopenshell.file handle), `ifcopenshell`, "
            "`ifcopenshell.api`, `ifcopenshell.util.element`, plus `math`, "
            "`statistics`, `re`, `json`, `collections`, `uuid`. Assign to "
            "`result` for a value back in the summary; print output is "
            "captured. Runs in a subprocess with a timeout and no network / "
            "filesystem access outside the sandbox file. If the code mutates "
            "the model, a diff envelope is returned and the user must click "
            "Apply - nothing touches the live model until they do; if the "
            "hash is unchanged the call is treated as read-only."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "code": {
                    "type": "string",
                    "description": (
                        "Python source to execute. See the tool description "
                        "for the names available in scope. Max 100000 chars."
                    ),
                },
                "summary": {
                    "type": "string",
                    "description": (
                        "Optional one-line human summary shown in the Apply "
                        "preview (ignored for pure reads)."
                    ),
                },
                "timeout_s": {
                    "type": "number",
                    "description": (
                        "Wall-clock budget in seconds. Default 240, min 1, "
                        "max 240."
                    ),
                },
            },
            "required": ["code"],
        },
        "where": "server",
    },
    {
        "name": "undo_last_edit",
        "description": (
            "Undo the most recently applied edit (edit_semantic batches share "
            "one undo entry, so a batch rolls back atomically). Can be called "
            "repeatedly to walk back through the edit history (up to 20 "
            "edits). Structural deletions applied via edit_structural are NOT "
            "undoable."
        ),
        "parameters": {
            "type": "object",
            "properties": {},
            "required": [],
        },
        "where": "server",
    },
    {
        "name": "get_edit_history",
        "description": (
            "List recent edits that can be undone, newest first. "
            "Shows up to 20 entries with edit_id, description, and timestamp."
        ),
        "parameters": {
            "type": "object",
            "properties": {},
            "required": [],
        },
        "where": "server",
    },
]

TOOL_BY_NAME: dict[str, dict[str, Any]] = {t["name"]: t for t in TOOL_DEFINITIONS}


# Merged tools whose execution site depends on their arguments. Each entry
# maps the tool name to a predicate over the call arguments that is True when
# the call can run in the browser (metadata-worker fast path). Anything not
# matched runs server-side (the server can execute everything; the client
# cannot).
_CLIENT_ROUTING: dict[str, "Callable[[dict[str, Any]], bool]"] = {
    "viewer_control": lambda a: True,
    "describe_model": lambda a: a.get("part") in ("project", "stats", "storeys"),
    "query_elements": lambda a: a.get("mode") in ("text", "type", "storey"),
    "get_element": lambda a: (
        not a.get("include") or list(a.get("include") or []) == ["details"]
    ),
}


def tool_where(name: str, arguments: Optional[dict[str, Any]] = None) -> str:
    """Where should this call run? Returns "client" or "server".

    Merged tools are client-capable only for specific modes/parts (the
    browser metadata worker covers text/type/storey queries, the model
    overview parts, and details-only element reads); ``arguments`` selects
    the effective site per call. Without arguments the answer is the
    definition's static ``where`` (server for the conditional tools)."""
    predicate = _CLIENT_ROUTING.get(name)
    if predicate is not None and arguments is not None:
        try:
            return "client" if predicate(arguments) else "server"
        except Exception:  # noqa: BLE001 - malformed args never break routing
            return "server"
    return TOOL_BY_NAME.get(name, {}).get("where", "server")


# Tier classification for the Agent Manager UI.
# A merged tool's tier is the max-privilege tier of every absorbed tool
# (which is why the edit surface is split into edit_semantic and
# edit_structural instead of one merged edit tool).
_TOOL_TIERS: dict[str, tuple[str, str]] = {
    # name → (tier_id, tier_label)
    "describe_model":          ("read_model",  "Read - Model"),
    "query_elements":          ("read_model",  "Read - Model"),
    "get_element":             ("read_model",  "Read - Model"),
    "quantity_summary":        ("read_model",  "Read - Model"),
    "get_edit_history":        ("read_model",  "Read - Model"),
    "execute_ifc_query_code":  ("read_model",  "Read - Model"),
    "viewer_control":          ("read_viewer", "Read - Viewer"),
    "validate_model":          ("validate",    "Validate"),
    "get_docs":                ("read_knowledge", "Read - Knowledge"),
    "edit_semantic":           ("write_edit",  "Write - Edit"),
    "edit_structural":         ("write_edit",  "Write - Edit"),
    "execute_ifc_code":        ("write_edit",  "Write - Edit"),
    "undo_last_edit":          ("write_edit",  "Write - Edit"),
}


def tool_tier(name: str) -> tuple[str, str]:
    """Return (tier_id, tier_label) for the Agent Manager UI."""
    return _TOOL_TIERS.get(name, ("read_model", "Read - Model"))


def all_tool_names() -> frozenset[str]:
    """Every registered tool name (from ``TOOL_DEFINITIONS``)."""
    return frozenset(t["name"] for t in TOOL_DEFINITIONS)


def write_edit_tool_names() -> frozenset[str]:
    """All tool names in the ``write_edit`` tier - i.e. the mutating tools.

    Used to gate the LLM "Edit" surface off for v1 (see
    ``config.EDIT_MODE_ENABLED``). Kept tier-driven so it stays in lock-step
    with the frontend Tools-registry filter (``tier === 'write_edit'``).
    """
    return frozenset(
        name for name, (tier, _label) in _TOOL_TIERS.items() if tier == "write_edit"
    )


# ── Edit scope: semantic (no viewer reload) vs structural (reloads) ──────────
# Semantic write tools change only metadata (names, property/pset values) and
# update the viewer IN PLACE - no 3D reload. Structural write tools change
# geometry (create/delete elements) or run arbitrary code that can, so applying
# them reloads the 3D viewer. The Edit surface's default "semantic" scope strips
# the structural set, so property/classification editing never reloads and the
# LLM stays constrained to safe, fast edits. See dev/docs/EDIT_SCOPES.md.
STRUCTURAL_WRITE_TOOLS: frozenset[str] = frozenset({
    "edit_structural",   # create_wall / delete_element ops - changes geometry
    "execute_ifc_code",  # arbitrary code - may create/delete geometry
})


def structural_write_tool_names() -> frozenset[str]:
    """Write tools whose edits change geometry and therefore reload the viewer."""
    return STRUCTURAL_WRITE_TOOLS & write_edit_tool_names()


def semantic_write_tool_names() -> frozenset[str]:
    """Write tools whose edits are metadata-only (no viewer reload)."""
    return write_edit_tool_names() - STRUCTURAL_WRITE_TOOLS


def tool_activity_kind(name: str) -> str:
    """User-facing effect classification for chat progress/tool cards.

    This is deliberately more specific than the permission tier: code
    execution and geometry changes deserve distinct warnings even though both
    may share the same write gate.
    """
    if name == "execute_ifc_query_code":
        return "code_read"
    if name == "execute_ifc_code":
        return "code_edit"
    if name == "undo_last_edit":
        return "model_edit"
    if name in STRUCTURAL_WRITE_TOOLS:
        return "geometry_edit"
    tier, _ = tool_tier(name)
    if tier == "write_edit":
        return "semantic_edit"
    if tier == "validate":
        return "validation"
    if tier == "read_viewer":
        return "viewer_action"
    return "read_only"


# Tools that DON'T need IfcOpenShell can run during warm-up.
# Everything else gets a synthetic "warming up" envelope instead of failing.
# Native-fast-path tools are also exempt - they read the
# TypeScript metadata index, not ifcopenshell.
# read_viewer runs in the browser; read_knowledge (bSDD, get_docs) reads
# external/reference knowledge, not the model - neither needs IfcOpenShell, so
# both run during warm-up and without a model loaded.
_WARMING_EXEMPT_TIERS: frozenset[str] = frozenset({"read_viewer", "read_knowledge"})

# Read tools that have a metadata_index_service fast path. When the
# native index is loaded AND IfcOpenShell is still warming, these tools
# return partial (but useful) results from the index instead of a warming
# envelope. The full payload still ships via the IfcOpenShell branch once
# the semantic layer is ready; ``_complete: false`` annotates "partial" so
# the agent + UI know.
#
# Keep in lock-step with the ``if _mi:`` branches in ``_run_subtool``.
# Adding a subtool to this set without also adding the branch will surface as
# a "No IFC model loaded" error, not a routing bug. Names here are INTERNAL
# subtool names (the legacy handler branches the merged catalog dispatches
# to); ``_native_index_eligible`` maps a public (tool, arguments) call onto
# this set.
_NATIVE_INDEX_ELIGIBLE_TOOLS: frozenset[str] = frozenset({
    "get_project_info",
    "get_model_stats",
    "search_elements",
    "get_elements_by_type",
    "get_elements_by_storey",
    "get_storeys",
})


def _native_index_eligible(name: str, arguments: Optional[dict[str, Any]]) -> bool:
    """True iff this public tool call resolves to a native-index-backed
    subtool (``describe_model`` overview parts, ``query_elements`` text/type/
    storey modes)."""
    args = arguments or {}
    if name == "describe_model":
        return args.get("part") in ("project", "stats", "storeys")
    if name == "query_elements":
        return args.get("mode") in ("text", "type", "storey")
    return False


def _native_index_ready() -> bool:
    """True iff metadata_index_service holds a loaded index. Defensive against
    import cycles + import-time failure (returns False if the service can't
    be imported)."""
    try:
        return bool(metadata_index_service.is_loaded)
    except Exception:
        return False


def warming_envelope(
    name: str, arguments: Optional[dict[str, Any]] = None
) -> Optional[dict[str, Any]]:
    """Return a structured 'still warming' envelope if the AI backend isn't
    ready for this tool yet, else ``None``.

    Replaces the silent black-hole when a user submits a deep
    query while ``ifcopenshell`` is still warming. The LLM sees a clear
    ``warming: True`` result with ``retry_after_ms`` so it can pause and
    retry instead of guessing.

    Viewer tools (``viewer_control``) don't need the semantic backend and
    are exempt.

    Calls that resolve to a native-index fast path
    (``_native_index_eligible``) are also exempt when the native
    index is loaded, so the agent can serve queries via the fast path
    while IfcOpenShell warms up. The tool body then annotates ``_complete:
    false`` so callers know the payload is partial.
    """
    tier_id, tier_label = tool_tier(name)
    if tier_id in _WARMING_EXEMPT_TIERS:
        return None
    # Native-index fast path bypass.
    if _native_index_eligible(name, arguments) and _native_index_ready():
        return None
    try:
        from app.services.readiness_service import readiness_service  # local - avoid cycles
        state = readiness_service.get_state().ifcopenshell
    except Exception:
        return None
    if state == "ready" or state == "error":
        # "error" we let through so the tool surfaces a concrete failure.
        return None
    return {
        "warming": True,
        "ifcopenshell": state,
        "tool": name,
        "tier": tier_label,
        "message": (
            "The AI backend is still warming up. The semantic IFC layer "
            "(IfcOpenShell) isn't ready yet - please retry in a few seconds."
        ),
        "retry_after_ms": 2000,
    }


def get_tool_catalog() -> list[dict]:
    """Return all tool definitions enriched with tier metadata for the UI.

    Includes name, description, parameters, where, tier, tier_label.
    Does NOT strip internal keys - this is for the management UI, not LLM SDKs.
    """
    catalog = []
    for tool in TOOL_DEFINITIONS:
        tid, tlabel = tool_tier(tool["name"])
        catalog.append({
            "name": tool["name"],
            "description": tool["description"],
            "parameters": tool.get("parameters", {}),
            "where": tool.get("where", "server"),
            "tier": tid,
            "tier_label": tlabel,
        })
    return catalog


def _schema_only(tool: dict) -> dict:
    """Strip router-internal keys (like ``where``) before the tool
    definition goes to an LLM SDK - OpenAI / Anthropic reject unknown
    properties on function schemas."""
    return {k: v for k, v in tool.items() if k not in {"where"}}


def get_openai_tools() -> list[dict]:
    """Return tool definitions in OpenAI function-calling format."""
    return [
        {"type": "function", "function": _schema_only(tool)}
        for tool in TOOL_DEFINITIONS
    ]


def get_anthropic_tools() -> list[dict]:
    """Return tool definitions in Anthropic tool-use format."""
    return [
        {
            "name": tool["name"],
            "description": tool["description"],
            "input_schema": tool["parameters"],
        }
        for tool in TOOL_DEFINITIONS
    ]


# Guidance appended to every truncation marker so the model knows how to get
# at the data that was dropped instead of presenting a prefix as complete.
_TRUNCATION_HINT = (
    "narrow the query (filters, storey, type) or ask for a specific element"
)

# Cap on how many entries the element-listing tools inline into one tool
# result. Totals are always reported alongside so the model can say
# "showing N of M" instead of silently receiving a prefix.
_ELEMENT_LIST_CAP = 100


def _capped_element_list(elements: list[Any], cap: int = _ELEMENT_LIST_CAP) -> dict[str, Any]:
    """Envelope for a capped element list.

    Always carries ``count``/``total_count`` (the full size) and ``truncated``;
    when the cap bites, ``shown`` and an explicit ``truncation_note`` are added
    so the LLM never mistakes the prefix for the full set.
    """
    shown = elements[:cap]
    payload: dict[str, Any] = {
        "count": len(elements),
        "total_count": len(elements),
        "truncated": len(elements) > len(shown),
        "elements": [e.model_dump() for e in shown],
    }
    if payload["truncated"]:
        payload["shown"] = len(shown)
        payload["truncation_note"] = (
            f"[TRUNCATED: showing first {len(shown)} of {len(elements)} elements - "
            f"{_TRUNCATION_HINT}]"
        )
    return payload


def _model_cache_fingerprint() -> Optional[str]:
    """QTO-cache fingerprint string, mirroring the cost/carbon routes.

    Returns None when the contract can't be read (e.g. mocked service in
    tests) - compute_qto then simply bypasses its result cache.
    """
    try:
        contract = ifc_service.get_model_contract()
        return (
            f"{contract['model_fingerprint']}:"
            f"{contract['model_version']}:{contract['edit_id']}"
        )
    except Exception:  # noqa: BLE001
        return None


def _validate_extra_group_by(
    raw: Any, reserved: str
) -> tuple[list[str], Optional[str]]:
    """Validate the optional extra ``group_by`` dimensions for cost/carbon.

    ``reserved`` is the implicit first grouping field (ifc_class for cost,
    material for carbon) - it is silently skipped when passed, mirroring the
    REST routes. Returns ``(fields, error)``; ``error`` is a message string
    when an unknown field was requested.
    """
    if raw in (None, ""):
        return [], None
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list):
        return [], "'group_by' must be a list of field names"
    allowed = [f for f in GROUP_FIELDS if f != reserved]
    fields: list[str] = []
    for part in raw:
        name = str(part).strip()
        if not name or name == reserved or name in fields:
            continue
        if name not in allowed:
            return [], (
                f"Unknown group_by value '{name}'. Allowed: {', '.join(allowed)}"
            )
        fields.append(name)
    return fields, None


def _clamp_top_rows(value: Any, default: int = 25, maximum: int = 100) -> int:
    try:
        top = int(value) if value is not None else default
    except (TypeError, ValueError):
        return default
    return max(1, min(top, maximum))


def _run_coro_sync(coro: "Any") -> Any:
    """Run an async coroutine to completion from sync code, whether or not an
    event loop is already running on this thread.

    ``execute_tool`` is sync but is called inside the chat WebSocket event loop
    (``chat_routes.py``), where ``asyncio.run`` would raise "loop already
    running". Async network tools (bSDD, docs) therefore run in a dedicated
    worker thread with its own loop. The calling thread blocks until the
    coroutine finishes - the same synchronous model every other tool already
    uses - but these calls are cached and touch no shared IfcOpenShell state, so
    the worker thread is safe.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)  # no loop here (tests / worker threads)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
        return ex.submit(asyncio.run, coro).result()


def _get_docs(arguments: dict[str, Any]) -> dict[str, Any]:
    """Router for the ``get_docs`` tool - one entry point over every knowledge
    source (IfcOpenShell API, bSDD search + class detail, user uploads, IFC
    schema)."""
    source = str(arguments.get("source") or "").strip().lower()
    query = str(arguments.get("query") or "").strip()
    symbol = arguments.get("symbol")
    uri = str(arguments.get("uri") or "").strip()
    limit = min(int(arguments.get("limit") or 5), 15)
    if not query and not symbol and not uri:
        return {"error": "get_docs: provide a 'query' (or a 'symbol' / bSDD 'uri')."}
    effective_query = f"{symbol} {query}".strip() if symbol else query

    if source == "bsdd":
        from app.services import bsdd_service
        # Class-detail lookup: explicit uri, or a symbol that looks like one.
        if not uri and symbol and "://" in str(symbol):
            uri = str(symbol)
        if uri:
            detail = str(arguments.get("detail") or "class").strip().lower()
            if detail == "properties":
                return {"source": source, "uri": uri, "detail": detail,
                        "result": _run_coro_sync(bsdd_service.get_class_properties(uri))}
            return {"source": source, "uri": uri, "detail": "class",
                    "result": _run_coro_sync(bsdd_service.get_class(uri))}
        res = _run_coro_sync(bsdd_service.search(effective_query, limit=limit))
        out = {"source": source, "query": effective_query,
               "results": res.get("results", []), "count": res.get("count", 0)}
        if res.get("error"):
            out["error"] = res["error"]
        return out

    if source == "user":
        from app.services.document_index_service import document_index_service
        passages = document_index_service.search(effective_query, top_k=limit)
        return {"source": source, "query": effective_query,
                "result_count": len(passages), "passages": passages}

    if source == "ifc-schema":
        # Honesty over aliasing: no IFC entity/attribute schema source is
        # indexed yet (plan E2 remainder). Returning ifcopenshell.api passages
        # mislabelled as schema documentation misleads the model.
        return {
            "source": source, "query": effective_query, "passages": [], "result_count": 0,
            "error": "source_unavailable",
            "hint": (
                "The IFC entity/attribute schema source is not indexed yet. "
                "For IfcOpenShell API usage use source='ifcopenshell'; for "
                "classification/property definitions use source='bsdd'."
            ),
        }

    if source == "ifcopenshell":
        from app.services.document_index_service import reference_docs_service
        if not reference_docs_service.status().get("indexed"):
            return {
                "source": source, "query": effective_query, "passages": [], "result_count": 0,
                "error": "not_indexed",
                "hint": (
                    "Reference docs aren't indexed yet. Run "
                    "`python scripts/fetch_reference_docs.py`, or click 'Fetch "
                    "IfcOpenShell API docs' in the Chat Manager Knowledge tab."
                ),
            }
        passages = reference_docs_service.search(effective_query, top_k=limit)
        return {"source": source, "query": effective_query,
                "result_count": len(passages), "passages": passages}

    return {"error": f"get_docs: unknown source '{source}'. "
                     "Use one of: ifcopenshell, bsdd, user, ifc-schema."}


def _pending_edit_result(envelope: Any) -> dict[str, Any]:
    if envelope is None:
        return {
            "action": "pending_noop",
            "message": "Sandbox ran cleanly but produced no model change - nothing to review.",
        }
    return {
        "action": "pending_edit",
        "edit_id": envelope.edit_id,
        "summary": envelope.summary,
        "counts": envelope.counts,
        "change_preview": [c.model_dump() for c in envelope.changes[:10]],
        "total_changes": len(envelope.changes),
        "preview_truncated": len(envelope.changes) > 10,
        "verifier_verdict": envelope.verifier_verdict,
        "note": (
            "Edit is PENDING - review it in chat before applying. Nothing mutates yet."
            + _verdict_suffix(envelope.verifier_verdict)
        ),
    }


def _stage_agent_edit(
    actor: Actor,
    operations: list[dict[str, Any]],
    summary: str,
) -> Optional[dict[str, Any]]:
    """Stage chat-agent writes while preserving direct human/MCP operations."""
    if actor is not Actor.AGENT:
        return None
    envelope = sandbox_service.propose_edit(
        ifc_service=ifc_service,
        operations=operations,
        summary=summary,
    )
    return _pending_edit_result(envelope)


def _verdict_suffix(verdict: Optional[dict[str, Any]]) -> str:
    """LLM-facing one-liner for a pending edit's verifier verdict (D4): a
    FAIL/WARN in the tool result lets the agent self-repair in the same turn
    instead of presenting a broken edit for Apply."""
    from app.services.sandbox_service import _verifier_note

    return _verifier_note(verdict)


# ── Public → internal subtool translation ────────────────────────────────────
# The public catalog is 13 merged, parameterized tools. Each merged tool
# dispatches onto the pre-merge handler branches in ``_run_subtool`` (the
# domain logic is unchanged); the tables below map a public call onto the
# internal subtool + argument shape.

_DESCRIBE_PARTS: dict[str, str] = {
    "project": "get_project_info",
    "stats": "get_model_stats",
    "storeys": "get_storeys",
    "property_names": "get_all_property_names",
}

_ELEMENT_INCLUDES: dict[str, str] = {
    "details": "get_element_details",
    "material": "get_element_material",
    "openings": "get_openings_for_element",
    "connections": "get_connected_elements",
    "relationships": "get_element_relationships",
}

_VIEWER_ACTIONS: dict[str, str] = {
    "highlight": "highlight_elements",
    "select": "select_element",
    "isolate": "isolate_elements",
    "show_all": "show_all_elements",
    "clip_section_box": "clip_section_box_to_element",
}

_SEMANTIC_OPS: frozenset[str] = frozenset({"set_name", "set_property", "set_attribute"})
_STRUCTURAL_OPS: frozenset[str] = frozenset({"create_wall", "delete_element"})


def _compact(args: dict[str, Any]) -> dict[str, Any]:
    """Drop None-valued keys so subtool defaults apply."""
    return {k: v for k, v in args.items() if v is not None}


def _translate_query(arguments: dict[str, Any]) -> tuple[str, dict[str, Any]] | dict[str, Any]:
    """Map a ``query_elements`` call onto (subtool, subargs), or an error dict."""
    mode = str(arguments.get("mode") or "").strip()
    limit = arguments.get("limit")
    if mode == "text":
        if not str(arguments.get("query") or "").strip():
            return {"error": "query_elements: mode='text' requires 'query'."}
        return "search_elements", _compact({
            "query": arguments.get("query"),
            "ifc_type": arguments.get("ifc_type"),
            "storey": arguments.get("storey"),
            "limit": limit,
        })
    if mode == "semantic":
        if not str(arguments.get("query") or "").strip():
            return {"error": "query_elements: mode='semantic' requires 'query'."}
        return "search_elements_semantic", _compact({
            "query": arguments.get("query"),
            "top_k": limit,
        })
    if mode == "type":
        if not str(arguments.get("ifc_type") or "").strip():
            return {"error": "query_elements: mode='type' requires 'ifc_type'."}
        return "get_elements_by_type", {"ifc_type": arguments["ifc_type"]}
    if mode == "storey":
        if arguments.get("storey_id") is None:
            return {"error": "query_elements: mode='storey' requires 'storey_id'."}
        return "get_elements_by_storey", {"storey_id": arguments["storey_id"]}
    if mode == "type_name":
        if not str(arguments.get("query") or "").strip():
            return {"error": "query_elements: mode='type_name' requires 'query'."}
        return "find_elements_by_type_name", _compact({
            "substring": arguments.get("query"),
            "limit": limit,
        })
    if mode == "property":
        if not str(arguments.get("property_name") or "").strip():
            return {"error": "query_elements: mode='property' requires 'property_name'."}
        if str(arguments.get("operator") or "").strip():
            return "filter_by_property_value", _compact({
                "property_name": arguments.get("property_name"),
                "operator": arguments.get("operator"),
                "value": arguments.get("value", ""),
                "ifc_type": arguments.get("ifc_type"),
                "storey": arguments.get("storey"),
                "pset_name": arguments.get("pset_name"),
                "limit": limit,
            })
        return "search_by_property", _compact({
            "property_name": arguments.get("property_name"),
            "property_value": arguments.get("value"),
            "pset_name": arguments.get("pset_name"),
            "limit": limit,
        })
    if mode == "near":
        if arguments.get("element_id") is None:
            return {"error": "query_elements: mode='near' requires 'element_id'."}
        return "find_nearby_elements", _compact({
            "element_id": arguments.get("element_id"),
            "radius_m": arguments.get("radius_m"),
            "ifc_types": arguments.get("ifc_types"),
            "limit": limit,
        })
    return {"error": (
        f"query_elements: unknown mode '{mode}'. Use one of: "
        "text, semantic, type, storey, type_name, property, near."
    )}


def _validate_ops(
    name: str, arguments: dict[str, Any], allowed: frozenset[str]
) -> list[dict[str, Any]] | dict[str, Any]:
    """Shared ops-list validation for the edit tools. Returns the ops list or
    an error dict. Op kinds outside ``allowed`` are rejected so the
    semantic/structural scope gate cannot be bypassed via the op payload."""
    ops = arguments.get("ops")
    if not isinstance(ops, list) or not ops:
        return {"error": f"{name}: 'ops' must be a non-empty list"}
    for idx, op in enumerate(ops):
        if not isinstance(op, dict):
            return {"error": f"{name}: op #{idx} must be an object"}
        kind = op.get("op")
        if kind not in allowed:
            return {"error": (
                f"{name}: op #{idx} uses unsupported kind '{kind}'. "
                f"Allowed: {', '.join(sorted(allowed))}."
            )}
    return ops


def _edit_semantic(
    arguments: dict[str, Any], *, actor: Actor
) -> dict[str, Any]:
    """Metadata-only edit batch. Single ops and homogeneous batches dispatch
    to the pre-merge handler branches (preserving their staged-vs-direct
    actor semantics); mixed batches stage one sandboxed proposal."""
    ops = _validate_ops("edit_semantic", arguments, _SEMANTIC_OPS)
    if isinstance(ops, dict):
        return ops
    if not ifc_service.is_loaded:
        return {"error": "No IFC model is currently loaded."}
    if len(ops) == 1:
        op = ops[0]
        kind = op.get("op")
        if kind == "set_name":
            return _run_subtool("rename_element", {
                "element_id": op.get("element_id"),
                "new_name": op.get("new_name"),
            }, actor=actor)
        if kind == "set_property":
            return _run_subtool("update_property_value", _compact({
                "element_id": op.get("element_id"),
                "property_name": op.get("property_name"),
                "new_value": op.get("new_value"),
                "pset_name": op.get("pset_name"),
            }), actor=actor)
        return _run_subtool("update_element_attribute", {
            "element_id": op.get("element_id"),
            "attribute": op.get("attribute"),
            "new_value": op.get("new_value"),
        }, actor=actor)
    kinds = {op.get("op") for op in ops}
    if kinds == {"set_name"}:
        renames = [
            {"element_id": op.get("element_id"), "new_name": op.get("new_name")}
            for op in ops
        ]
        return _run_subtool("rename_elements_batch", {"renames": renames}, actor=actor)
    if kinds == {"set_property"}:
        updates = [
            _compact({
                "element_id": op.get("element_id"),
                "property_name": op.get("property_name"),
                "new_value": op.get("new_value"),
                "pset_name": op.get("pset_name"),
            })
            for op in ops
        ]
        return _run_subtool("update_properties_batch", {"updates": updates}, actor=actor)
    # Mixed batch (or multiple set_attribute ops): stage one sandboxed
    # proposal - atomic, one undo entry, user approves via the diff preview.
    envelope = sandbox_service.propose_edit(
        ifc_service=ifc_service,
        operations=ops,
        summary=arguments.get("summary") or f"Edit {len(ops)} elements",
    )
    return _pending_edit_result(envelope)


def _edit_structural(
    arguments: dict[str, Any], *, actor: Actor
) -> dict[str, Any]:
    """Geometry-changing edit batch. Always staged through the sandbox →
    diff-preview ceremony regardless of actor."""
    ops = _validate_ops("edit_structural", arguments, _STRUCTURAL_OPS)
    if isinstance(ops, dict):
        return ops
    if not ifc_service.is_loaded:
        return {"error": "No IFC model is currently loaded."}
    if len(ops) == 1:
        op = ops[0]
        if op.get("op") == "create_wall":
            return _run_subtool("create_wall_from_ends", _compact({
                "start": op.get("start"),
                "end": op.get("end"),
                "height": op.get("height"),
                "thickness": op.get("thickness"),
                "storey_name": op.get("storey_name"),
                "name": op.get("name"),
            }), actor=actor)
        return _run_subtool("delete_element", _compact({
            "element_id": op.get("element_id"),
            "reason": op.get("reason"),
        }), actor=actor)
    envelope = sandbox_service.propose_edit(
        ifc_service=ifc_service,
        operations=ops,
        summary=arguments.get("summary") or f"{len(ops)} structural operations",
    )
    return _pending_edit_result(envelope)


def _get_element(
    arguments: dict[str, Any], *, actor: Actor
) -> dict[str, Any]:
    """Single-element read; ``include`` selects the aspect subtools."""
    element_id = arguments.get("element_id")
    if element_id is None:
        return {"error": "get_element: 'element_id' is required"}
    include = arguments.get("include") or ["details"]
    if not isinstance(include, list):
        include = [include]
    aspects: list[str] = []
    for aspect in include:
        key = str(aspect).strip()
        if key not in _ELEMENT_INCLUDES:
            return {"error": (
                f"get_element: unknown include '{key}'. Use one of: "
                f"{', '.join(_ELEMENT_INCLUDES)}."
            )}
        if key not in aspects:
            aspects.append(key)
    if len(aspects) == 1:
        return _run_subtool(
            _ELEMENT_INCLUDES[aspects[0]], {"element_id": element_id}, actor=actor
        )
    out: dict[str, Any] = {"element_id": element_id}
    errors = 0
    for key in aspects:
        res = _run_subtool(
            _ELEMENT_INCLUDES[key], {"element_id": element_id}, actor=actor
        )
        if isinstance(res, dict) and "error" in res:
            errors += 1
        out[key] = res
    if errors == len(aspects):
        # Every aspect failed (element missing) - surface the first error.
        return out[aspects[0]]
    return out


def _execute_tool_raw(
    name: str, arguments: dict[str, Any], *, actor: Actor = Actor.AGENT
) -> dict[str, Any]:
    """
    Execute a public-catalog tool by name with the given arguments.
    Returns a dict with the result or error.
    Internal implementation - callers should use execute_tool() which applies
    the per-turn memo cache.

    Merged tools translate their mode/part/action/ops arguments onto the
    pre-merge subtool handlers in ``_run_subtool``; only public catalog
    names are accepted here (internal subtool names are NOT callable, so
    the name-keyed write/tier gates cannot be bypassed).

    *actor* is stamped onto operation-layer writes so the op log's "who
    changed what" stays truthful across surfaces: the chat agent (default),
    or an external MCP client passing Actor.MCP.
    """
    if name not in TOOL_BY_NAME:
        return {"error": f"Unknown tool: {name}"}
    arguments = arguments or {}
    try:
        if name == "describe_model":
            part = str(arguments.get("part") or "").strip()
            sub = _DESCRIBE_PARTS.get(part)
            if sub is None:
                return {"error": (
                    f"describe_model: unknown part '{part}'. Use one of: "
                    f"{', '.join(_DESCRIBE_PARTS)}."
                )}
            return _run_subtool(sub, {}, actor=actor)

        if name == "query_elements":
            translated = _translate_query(arguments)
            if isinstance(translated, dict):
                return translated
            sub, subargs = translated
            return _run_subtool(sub, subargs, actor=actor)

        if name == "get_element":
            return _get_element(arguments, actor=actor)

        if name == "viewer_control":
            action = str(arguments.get("action") or "").strip()
            sub = _VIEWER_ACTIONS.get(action)
            if sub is None:
                return {"error": (
                    f"viewer_control: unknown action '{action}'. Use one of: "
                    f"{', '.join(_VIEWER_ACTIONS)}."
                )}
            subargs: dict[str, Any] = {}
            if action in ("highlight", "isolate"):
                subargs["element_ids"] = arguments.get("element_ids") or []
            elif action in ("select", "clip_section_box"):
                if arguments.get("element_id") is None:
                    return {"error": f"viewer_control: action='{action}' requires 'element_id'."}
                subargs["element_id"] = arguments["element_id"]
            return _run_subtool(sub, subargs, actor=actor)

        if name == "quantity_summary":
            kind = str(arguments.get("kind") or "").strip()
            group_by = arguments.get("group_by")
            if isinstance(group_by, str):
                group_by = [group_by]
            if kind == "qto":
                return _run_subtool("get_quantities_summary", _compact({
                    "group_by": (group_by or ["ifc_type"])[0],
                    "ifc_type": arguments.get("ifc_type"),
                    "storey": arguments.get("storey"),
                }), actor=actor)
            if kind in ("cost", "carbon"):
                return _run_subtool(
                    "get_cost_summary" if kind == "cost" else "get_carbon_summary",
                    _compact({
                        "group_by": group_by,
                        "top_rows": arguments.get("top_rows"),
                    }),
                    actor=actor,
                )
            return {"error": (
                f"quantity_summary: unknown kind '{kind}'. Use one of: qto, cost, carbon."
            )}

        if name == "validate_model":
            check = str(arguments.get("check") or "").strip()
            limit = arguments.get("limit")
            if check == "health":
                return _run_subtool(
                    "run_model_health_check",
                    _compact({"limit_per_rule": limit}),
                    actor=actor,
                )
            if check == "audit":
                return _run_subtool(
                    "run_model_audit",
                    _compact({"limit_per_rule": limit}),
                    actor=actor,
                )
            if check == "ids":
                if not arguments.get("ids_base64"):
                    return {"error": "validate_model: check='ids' requires 'ids_base64'."}
                if arguments.get("highlight_failures"):
                    return _run_subtool("highlight_ids_failures", _compact({
                        "ids_base64": arguments.get("ids_base64"),
                        "spec_name": arguments.get("spec_name"),
                        "limit_per_spec": limit,
                    }), actor=actor)
                return _run_subtool("ids_validate", _compact({
                    "ids_base64": arguments.get("ids_base64"),
                    "limit_per_spec": limit,
                }), actor=actor)
            return {"error": (
                f"validate_model: unknown check '{check}'. Use one of: health, audit, ids."
            )}

        if name == "edit_semantic":
            return _edit_semantic(arguments, actor=actor)

        if name == "edit_structural":
            return _edit_structural(arguments, actor=actor)

        # Kept-as-is tools pass straight through to their handler branch.
        return _run_subtool(name, arguments, actor=actor)

    except ValueError as e:
        return {"error": str(e)}
    except Exception as e:
        logger.error("Tool execution error for %s: %s", name, e, exc_info=True)
        return {"error": f"Tool execution failed: {e}"}


def _run_subtool(
    name: str, arguments: dict[str, Any], *, actor: Actor = Actor.AGENT
) -> dict[str, Any]:
    """
    Execute an internal subtool (pre-merge handler branch) by name.
    Returns a dict with the result or error. Reached only through
    ``_execute_tool_raw``'s public-name translation - the domain logic for
    every branch is unchanged from the pre-consolidation catalog.
    """
    try:
        # Allow native-index fast-path tools to run even when
        # IfcOpenShell isn't loaded yet, as long as the metadata index is.
        # The body's ``if _mi:`` branch returns ``_source: "native_index"``
        # with ``_complete: false`` so the caller knows the payload is
        # partial. Non-eligible tools still hard-require ifc_service.
        _native_ready = _native_index_ready()
        if not ifc_service.is_loaded:
            # Knowledge tools (bSDD, get_docs) answer without a model.
            _tier_id, _ = tool_tier(name)
            if _tier_id != "read_knowledge" and not (
                _native_ready and name in _NATIVE_INDEX_ELIGIBLE_TOOLS
            ):
                return {"error": "No IFC model is currently loaded."}

        # Fast path - prefer the native metadata index for
        # read-only queries. Falls back to IfcOpenShell for anything the
        # index doesn't cover yet (e.g. full property detail from IfcOpenShell).
        _mi = metadata_index_service if _native_ready else None
        # When IfcOpenShell is still warming, the native path is the
        # only path, so its result is "partial" relative to the eventual
        # full payload. When IfcOpenShell is loaded, the native path is
        # still a fast path but the data matches (complete).
        _native_is_partial = not ifc_service.is_loaded

        if name == "get_project_info":
            if _mi:
                proj = _mi.get_project_info()
                if proj:
                    return {
                        **proj,
                        "_source": "native_index",
                        "_complete": not _native_is_partial,
                    }
            info = ifc_service.get_project_info()
            return {**info.model_dump(), "_source": "ifcopenshell", "_complete": True}

        elif name == "get_model_stats":
            if _mi:
                return {
                    **_mi.get_model_stats(),
                    "_source": "native_index",
                    "_complete": not _native_is_partial,
                }
            stats = ifc_service.get_model_stats()
            return {**stats.model_dump(), "_source": "ifcopenshell", "_complete": True}

        elif name == "search_elements":
            if _mi:
                search_limit = arguments.get("limit", 50)
                hits = _mi.search(
                    query=arguments["query"],
                    ifc_type=arguments.get("ifc_type"),
                    storey=arguments.get("storey"),
                    limit=search_limit,
                )
                out = {
                    "elements": [e.model_dump() for e in hits],
                    "total": len(hits),
                    "query": arguments["query"],
                    "_source": "native_index",
                    "_complete": not _native_is_partial,
                }
                # The index stops at `limit`, so a full page means the real
                # match count may be higher - tell the model instead of
                # letting it report the page size as the total.
                if isinstance(search_limit, int) and 0 < search_limit <= len(hits):
                    out["may_have_more"] = True
                    out["note"] = (
                        f"Result list hit the requested limit ({search_limit}); "
                        "more matches may exist - raise 'limit' or add filters "
                        "(ifc_type, storey)."
                    )
                return out
            result = ifc_service.search(
                query=arguments["query"],
                ifc_type=arguments.get("ifc_type"),
                storey=arguments.get("storey"),
                limit=arguments.get("limit", 50),
            )
            return {**result.model_dump(), "_source": "ifcopenshell", "_complete": True}

        elif name == "get_element_details":
            detail = ifc_service.get_element(arguments["element_id"])
            result = detail.model_dump()
            if _mi:
                fast_psets = _mi.get_element_psets(arguments["element_id"])
                if fast_psets:
                    result["_native_psets"] = fast_psets
            return result

        elif name == "get_elements_by_type":
            if _mi:
                elements = _mi.get_elements_by_type(arguments["ifc_type"])
                return {
                    "ifc_type": arguments["ifc_type"],
                    **_capped_element_list(elements),
                    "_source": "native_index",
                    "_complete": not _native_is_partial,
                }
            elements = ifc_service.get_elements_by_type(arguments["ifc_type"])
            return {
                "ifc_type": arguments["ifc_type"],
                **_capped_element_list(elements),
                "_source": "ifcopenshell",
                "_complete": True,
            }

        elif name == "get_elements_by_storey":
            if _mi:
                elements = _mi.get_elements_by_storey(arguments["storey_id"])
                return {
                    "storey_id": arguments["storey_id"],
                    "count": len(elements),
                    "elements": [e.model_dump() for e in elements],
                    "_source": "native_index",
                    "_complete": not _native_is_partial,
                }
            elements = ifc_service.get_elements_by_storey(arguments["storey_id"])
            return {
                "storey_id": arguments["storey_id"],
                "count": len(elements),
                "elements": [e.model_dump() for e in elements],
                "_source": "ifcopenshell",
                "_complete": True,
            }

        elif name == "get_storeys":
            if _mi:
                storeys = _mi.get_storeys()
                return {
                    "storeys": [s.model_dump() for s in storeys],
                    "_source": "native_index",
                    "_complete": not _native_is_partial,
                }
            storeys = ifc_service.get_storeys()
            return {
                "storeys": [s.model_dump() for s in storeys],
                "_source": "ifcopenshell",
                "_complete": True,
            }

        elif name == "search_by_property":
            if _mi and _mi.current and _mi.current.element_psets:
                results = _mi.search_by_property(
                    property_name=arguments["property_name"],
                    property_value=arguments.get("property_value"),
                    pset_name=arguments.get("pset_name"),
                    limit=arguments.get("limit", 50),
                )
                if results:  # non-empty → the index answered it
                    return {
                        "property_name": arguments["property_name"],
                        "count": len(results),
                        "elements": results,
                        "_source": "native_index",
                    }
            results = ifc_service.search_by_property(
                property_name=arguments["property_name"],
                property_value=arguments.get("property_value"),
                pset_name=arguments.get("pset_name"),
                limit=arguments.get("limit", 50),
            )
            return {
                "property_name": arguments["property_name"],
                "count": len(results),
                "elements": results,
            }

        elif name == "search_elements_semantic":
            top_k = min(int(arguments.get("top_k") or 10), 50)
            hits = element_index.search(
                query=arguments["query"],
                ifc_model=ifc_service.model,
                top_k=top_k,
            )
            return {
                "query": arguments["query"],
                "count": len(hits),
                "elements": hits,
                "note": "Results ranked by BM25 + optional cosine rerank.",
            }

        elif name == "get_all_property_names":
            if _mi and _mi.current and _mi.current.all_pset_names:
                pset_props = _mi.get_all_property_names()
                return {
                    "property_sets": pset_props,
                    "total_psets": len(pset_props),
                    "_source": "native_index",
                }
            pset_props = ifc_service.get_all_property_names()
            return {
                "property_sets": pset_props,
                "total_psets": len(pset_props),
            }

        elif name == "highlight_elements":
            # This is a UI action - return the IDs to be sent to the frontend
            ids = arguments["element_ids"]
            return {
                "action": "highlight",
                "element_ids": ids,
                "count": len(ids),
            }

        elif name == "select_element":
            # UI action: focus a single element + open its properties.
            element_id = arguments["element_id"]
            # Validate the element exists; raises ValueError if not
            ifc_service.get_element(element_id)
            return {
                "action": "select",
                "element_id": element_id,
            }

        elif name == "isolate_elements":
            ids = arguments.get("element_ids") or []
            return {
                "action": "isolate",
                "element_ids": ids,
                "count": len(ids),
            }

        elif name == "show_all_elements":
            return {"action": "show_all"}

        elif name == "clip_section_box_to_element":
            element_id = int(arguments["element_id"])
            # Validate element exists before sending to frontend.
            ifc_service.get_element(element_id)
            return {
                "action": "clip_section_box",
                "element_id": element_id,
            }

        elif name == "get_quantities_summary":
            return ifc_service.get_quantities_summary(
                group_by=arguments.get("group_by", "ifc_type"),
                ifc_type=arguments.get("ifc_type"),
                storey=arguments.get("storey"),
            )

        elif name == "run_model_health_check":
            from app.services.model_health import run_health_check as _run_hc
            limit = int(arguments.get("limit_per_rule", 50) or 50)
            return _run_hc(ifc_service.model, limit_per_rule=limit)

        elif name == "ids_validate":
            limit = int(arguments.get("limit_per_spec", 25) or 25)
            report = validate_ids_base64(
                ifc_service.model,
                arguments["ids_base64"],
                limit_per_spec=limit,
            )
            failing_ids = extract_failing_ids(report)
            result_out = {**report, "all_failing_ids": failing_ids}
            if failing_ids:
                result_out["action"] = "ids_highlight"
                result_out["element_ids"] = failing_ids
            return result_out

        elif name == "highlight_ids_failures":
            limit = int(arguments.get("limit_per_spec", 100) or 100)
            report = validate_ids_base64(
                ifc_service.model,
                arguments["ids_base64"],
                limit_per_spec=limit,
            )
            spec_name = arguments.get("spec_name")
            failing_ids = extract_failing_ids(report, spec_name=spec_name)
            return {
                "action": "highlight",
                "element_ids": failing_ids,
                "count": len(failing_ids),
                "spec": spec_name or "all",
            }

        # Write tools route through the operation layer (Invariant 12): every
        # AI-originated mutation is validated, tiered, and appended to the
        # per-model operation log with actor=AGENT. to_public_dict() is a
        # superset of the legacy IfcService return (same `action`/`changed_ids`
        # /`edit_id`, plus op_id/actor/patch_tier), so downstream WS-sync and
        # LLM-facing code is unchanged.
        elif name == "rename_element":
            element_id = int(arguments["element_id"])
            new_name = str(arguments["new_name"])
            pending = _stage_agent_edit(
                actor,
                [{"op": "set_name", "element_id": element_id, "new_name": new_name}],
                f"Rename element #{element_id} to '{new_name}'",
            )
            if pending is not None:
                return pending
            return operation_service.execute(
                "set_name",
                {"element_id": element_id, "new_name": new_name},
                actor=actor, ifc_service=ifc_service,
            ).to_public_dict()

        elif name == "update_property_value":
            params = {
                "element_id": int(arguments["element_id"]),
                "property_name": str(arguments["property_name"]),
                "new_value": arguments["new_value"],
                "pset_name": arguments.get("pset_name"),
            }
            pending = _stage_agent_edit(
                actor,
                [{"op": "set_property", **params}],
                f"Update {params.get('pset_name') or 'property set'}.{params['property_name']} on #{params['element_id']}",
            )
            if pending is not None:
                return pending
            return operation_service.execute(
                "set_property",
                params,
                actor=actor, ifc_service=ifc_service,
            ).to_public_dict()

        elif name == "update_element_attribute":
            params = {
                "element_id": int(arguments["element_id"]),
                "attribute": str(arguments["attribute"]),
                "new_value": str(arguments.get("new_value") or ""),
            }
            pending = _stage_agent_edit(
                actor,
                [{"op": "set_attribute", **params}],
                f"Update {params['attribute']} on element #{params['element_id']}",
            )
            if pending is not None:
                return pending
            return operation_service.execute(
                "set_attribute",
                params,
                actor=actor, ifc_service=ifc_service,
            ).to_public_dict()

        elif name == "rename_elements_batch":
            renames = arguments.get("renames") or []
            if not isinstance(renames, list):
                return {"error": "rename_elements_batch: 'renames' must be a list"}
            pending = _stage_agent_edit(
                actor,
                [{"op": "set_name", **item} for item in renames],
                f"Rename {len(renames)} elements",
            )
            if pending is not None:
                return pending
            return operation_service.execute(
                "set_names_batch", {"renames": renames},
                actor=actor, ifc_service=ifc_service,
            ).to_public_dict()

        elif name == "update_properties_batch":
            updates = arguments.get("updates") or []
            if not isinstance(updates, list):
                return {"error": "update_properties_batch: 'updates' must be a list"}
            pending = _stage_agent_edit(
                actor,
                [{"op": "set_property", **item} for item in updates],
                f"Update properties on {len(updates)} elements",
            )
            if pending is not None:
                return pending
            return operation_service.execute(
                "set_properties_batch", {"updates": updates},
                actor=actor, ifc_service=ifc_service,
            ).to_public_dict()

        elif name == "undo_last_edit":
            return operation_service.undo(ifc_service, actor=actor).to_public_dict()

        elif name == "get_edit_history":
            history = ifc_service.get_edit_history()
            return {"count": len(history), "edits": history}

        elif name in {"execute_ifc_query_code", "execute_ifc_code"}:
            code = arguments.get("code")
            if not isinstance(code, str) or not code.strip():
                return {"error": f"{name}: 'code' must be a non-empty string"}
            timeout_s = arguments.get("timeout_s")
            try:
                timeout_val = (
                    float(timeout_s)
                    if timeout_s is not None
                    else _CODE_DEFAULT_TIMEOUT_S
                )
            except (TypeError, ValueError):
                return {"error": f"{name}: 'timeout_s' must be numeric"}
            return sandbox_service.execute_python(
                ifc_service=ifc_service,
                code=code,
                summary=arguments.get("summary"),
                timeout_s=timeout_val,
                read_only=name == "execute_ifc_query_code",
            )

        elif name == "create_wall_from_ends":
            start = arguments.get("start")
            end = arguments.get("end")
            if not start or not end:
                return {"error": "create_wall_from_ends: 'start' and 'end' are required"}
            ops = [
                {
                    "op": "create_wall",
                    "start": start,
                    "end": end,
                    "height": arguments.get("height", 3.0),
                    "thickness": arguments.get("thickness", 0.2),
                    "storey_name": arguments.get("storey_name"),
                    "name": arguments.get("name", "Wall"),
                }
            ]
            summary = arguments.get("name", "Wall")
            sx, sy = float(start[0]), float(start[1])
            ex, ey = float(end[0]), float(end[1])
            summary = (
                f"Create wall '{arguments.get('name', 'Wall')}' "
                f"({sx:.2f},{sy:.2f})→({ex:.2f},{ey:.2f}) "
                f"h={arguments.get('height', 3.0):.1f}m"
            )
            envelope = sandbox_service.propose_edit(
                ifc_service=ifc_service,
                operations=ops,
                summary=summary,
            )
            if envelope is None:
                return {"action": "pending_noop", "message": "Wall creation produced no structural change."}
            return {
                "action": "pending_edit",
                "edit_id": envelope.edit_id,
                "summary": envelope.summary,
                "counts": envelope.counts,
                "change_preview": [c.model_dump() for c in envelope.changes[:10]],
                "total_changes": len(envelope.changes),
                "preview_truncated": len(envelope.changes) > 10,
                "verifier_verdict": envelope.verifier_verdict,
                "note": (
                    "New wall is PENDING - the user must click Apply in the "
                    "Diff Preview panel. Nothing changes until then."
                    + _verdict_suffix(envelope.verifier_verdict)
                ),
            }

        elif name == "delete_element":
            element_id = arguments.get("element_id")
            if element_id is None:
                return {"error": "delete_element: 'element_id' is required"}
            reason = arguments.get("reason", "")
            ops = [{"op": "delete_element", "element_id": int(element_id)}]
            try:
                entity = ifc_service.model.by_id(int(element_id))
                entity_name = getattr(entity, "Name", None) or f"#{element_id}"
                entity_type = entity.is_a()
            except Exception:
                return {"error": f"delete_element: element {element_id} not found in the live model"}
            summary = f"Delete {entity_type} '{entity_name}' (#{element_id})"
            if reason:
                summary += f" - {reason}"
            envelope = sandbox_service.propose_edit(
                ifc_service=ifc_service,
                operations=ops,
                summary=summary,
            )
            if envelope is None:
                return {"action": "pending_noop", "message": "Deletion produced no structural change."}
            return {
                "action": "pending_edit",
                "edit_id": envelope.edit_id,
                "summary": envelope.summary,
                "counts": envelope.counts,
                "change_preview": [c.model_dump() for c in envelope.changes[:10]],
                "total_changes": len(envelope.changes),
                "preview_truncated": len(envelope.changes) > 10,
                "verifier_verdict": envelope.verifier_verdict,
                "note": (
                    "Deletion is PENDING - the user must click Apply in the "
                    "Diff Preview panel. This cannot be undone after Apply."
                    + _verdict_suffix(envelope.verifier_verdict)
                ),
            }

        # Knowledge tool (read_knowledge tier): no model needed, warm-up
        # exempt. bSDD calls are async; _run_coro_sync bridges them into this
        # sync path inside _get_docs.
        elif name == "get_docs":
            return _get_docs(arguments)

        elif name == "get_connected_elements":
            element_id = arguments.get("element_id")
            if element_id is None:
                return {"error": "get_connected_elements: 'element_id' is required"}
            return ifc_service.get_connected_elements(int(element_id))

        elif name == "get_element_material":
            element_id = arguments.get("element_id")
            if element_id is None:
                return {"error": "get_element_material: 'element_id' is required"}
            return ifc_service.get_element_material(int(element_id))

        elif name == "get_openings_for_element":
            element_id = arguments.get("element_id")
            if element_id is None:
                return {"error": "get_openings_for_element: 'element_id' is required"}
            return ifc_service.get_openings_for_element(int(element_id))

        elif name == "find_elements_by_type_name":
            substring = arguments.get("substring", "")
            if not substring.strip():
                return {"error": "find_elements_by_type_name: 'substring' must be non-empty"}
            limit = min(int(arguments.get("limit") or 50), 200)
            return ifc_service.find_elements_by_type_name(substring, limit=limit)

        elif name == "find_nearby_elements":
            element_id = arguments.get("element_id")
            if element_id is None:
                return {"error": "find_nearby_elements: 'element_id' is required"}
            radius_m = float(arguments.get("radius_m") or 5.0)
            ifc_types = arguments.get("ifc_types") or None
            limit = min(int(arguments.get("limit") or 20), 100)
            # Prefer real geometry AABBs when the per-model cache is warm
            # (surface distance between boxes); fall back to the legacy
            # placement-origin heuristic otherwise, flagged as approximate.
            boxes: dict[int, Any] = {}
            try:
                sha = ifc_service.model_fingerprint
                if isinstance(sha, str) and sha:
                    boxes = aabb_service.get_all_aabbs(sha)
            except Exception:  # noqa: BLE001 - cache probe must never break the tool
                boxes = {}
            if boxes:
                aabb_result = find_nearby_via_aabbs(
                    model=ifc_service.model,
                    boxes=boxes,
                    element_id=int(element_id),
                    radius_m=radius_m,
                    ifc_types=ifc_types,
                    limit=limit,
                    storey_resolver=getattr(ifc_service, "_get_storey", None),
                )
                if aabb_result is not None:
                    return aabb_result
            result = ifc_service.find_nearby_elements(
                element_id=int(element_id),
                radius_m=radius_m,
                ifc_types=ifc_types,
                limit=limit,
            )
            result["geometry"] = "placement_origin"
            result["geometry_note"] = (
                "Real-geometry AABBs are not cached for this model (or this "
                "element) yet, so distances are measured between "
                "IfcLocalPlacement origins - approximate for large or "
                "off-origin elements. Treat results as indicative."
            )
            return result

        elif name == "filter_by_property_value":
            property_name = arguments.get("property_name", "")
            operator = arguments.get("operator", "")
            value = arguments.get("value", "")
            if not property_name.strip():
                return {"error": "filter_by_property_value: 'property_name' is required"}
            if not operator.strip():
                return {"error": "filter_by_property_value: 'operator' is required"}
            limit = min(int(arguments.get("limit") or 100), 500)
            result = ifc_service.filter_by_property_value(
                property_name=property_name,
                operator=operator,
                value=str(value),
                ifc_type=arguments.get("ifc_type"),
                storey=arguments.get("storey"),
                pset_name=arguments.get("pset_name"),
                limit=limit,
            )
            # Auto-attach highlight action so the LLM can chain to highlight_elements
            if result.get("element_ids"):
                result["action"] = "highlight"
                result["note"] = (
                    f"Found {result['count']} element(s). "
                    "element_ids are ready for highlight_elements."
                )
            return result

        elif name == "get_cost_summary":
            extra, group_err = _validate_extra_group_by(
                arguments.get("group_by"), reserved="ifc_class"
            )
            if group_err:
                return {"error": f"get_cost_summary: {group_err}"}
            top_rows = _clamp_top_rows(arguments.get("top_rows"))
            boq = compute_boq(
                ifc_service.model,
                extra,
                DEFAULT_CURRENCY,
                False,
                _model_cache_fingerprint(),
            )
            rows = [
                {k: v for k, v in row.items() if k != "element_ids"}
                for row in boq["rows"]
            ]
            unpriced = [row["label"] for row in rows if not row["priced"]]
            total_rows = boq["total_rows"]
            out: dict[str, Any] = {
                "currency": boq["currency"],
                "group_by": boq["group_by"],
                "total": boq["total"],
                "total_rows": total_rows,
                "priced_rows": boq["priced_rows"],
                "priced_coverage_pct": (
                    round(100.0 * boq["priced_rows"] / total_rows, 1)
                    if total_rows
                    else 0.0
                ),
                "rows_shown": min(top_rows, len(rows)),
                "rows": rows[:top_rows],
                "note": (
                    "Rates come from the editable cost rate library; the shipped "
                    "defaults are illustrative placeholders, not market prices - "
                    "present amounts as estimates."
                ),
            }
            if unpriced:
                out["unpriced_row_labels"] = unpriced[:10]
            if len(rows) > top_rows:
                out["rows_note"] = (
                    f"Showing top {top_rows} of {len(rows)} rows by amount - "
                    "raise 'top_rows' for more. Totals cover all rows."
                )
            if boq.get("truncated"):
                out["truncated"] = True
            return out

        elif name == "get_carbon_summary":
            extra, group_err = _validate_extra_group_by(
                arguments.get("group_by"), reserved="material"
            )
            if group_err:
                return {"error": f"get_carbon_summary: {group_err}"}
            top_rows = _clamp_top_rows(arguments.get("top_rows"))
            carbon = compute_carbon(
                ifc_service.model,
                extra,
                False,
                _model_cache_fingerprint(),
            )
            rows = [
                {k: v for k, v in row.items() if k != "element_ids"}
                for row in carbon["rows"]
            ]
            unfactored = [row["label"] for row in rows if not row["factored"]]
            total_rows = carbon["total_rows"]
            out = {
                "group_by": carbon["group_by"],
                "total_kg": carbon["total_kg"],
                "total_tonnes": carbon["total_tonnes"],
                "total_rows": total_rows,
                "factored_rows": carbon["factored_rows"],
                "factored_coverage_pct": (
                    round(100.0 * carbon["factored_rows"] / total_rows, 1)
                    if total_rows
                    else 0.0
                ),
                "rows_shown": min(top_rows, len(rows)),
                "rows": rows[:top_rows],
                "note": (
                    "Factors come from the editable carbon factor library (with "
                    "keyword fallbacks for common materials); the defaults are "
                    "illustrative cradle-to-gate placeholders, not a certified "
                    "LCA - present figures as rough estimates."
                ),
            }
            if unfactored:
                out["unfactored_row_labels"] = unfactored[:10]
            if len(rows) > top_rows:
                out["rows_note"] = (
                    f"Showing top {top_rows} of {len(rows)} rows by carbon - "
                    "raise 'top_rows' for more. Totals cover all rows."
                )
            if carbon.get("truncated"):
                out["truncated"] = True
            return out

        elif name == "get_element_relationships":
            element_id = arguments.get("element_id")
            if element_id is None:
                return {"error": "get_element_relationships: 'element_id' is required"}
            return build_relationship_map(
                ifc_service.model, int(element_id), graph=get_graph()
            )

        elif name == "run_model_audit":
            from app.services.model_health import run_model_audit as _run_audit

            limit = int(arguments.get("limit_per_rule", 10) or 10)
            return _run_audit(
                ifc_service.model,
                fingerprint=_model_cache_fingerprint(),
                limit_per_rule=limit,
            )

        else:
            return {"error": f"Unknown tool: {name}"}

    except ValueError as e:
        return {"error": str(e)}
    except Exception as e:
        logger.error("Tool execution error for %s: %s", name, e, exc_info=True)
        return {"error": f"Tool execution failed: {e}"}


def execute_tool(
    name: str, arguments: dict[str, Any], *, actor: Actor = Actor.AGENT
) -> dict[str, Any]:
    """
    Execute a tool with per-turn memoization for read-only calls.

    Read-only tools called with identical arguments within the same LLM turn
    return the cached result (tagged ``_memo: True``) instead of re-running.
    Write tools invalidate the entire cache so stale reads are never served
    after a mutation.

    If the AI backend is still warming up, deep-tier tools get a
    synthetic ``warming`` envelope instead of being run; the result is NOT
    memoized so the next attempt (after IfcOpenShell finishes loading) gets
    fresh data.

    *actor* attributes operation-layer writes (chat agent by default; the MCP
    server passes ``Actor.MCP``). Reads are actor-agnostic, so memoization
    stays keyed by (name, arguments) alone.
    """
    # Warm-up gate: refuse semantic tools until ifcopenshell is ready.
    envelope = warming_envelope(name, arguments)
    if envelope is not None:
        return envelope

    # Fast path: return cached result for repeated read-only calls.
    cached = tool_memo_cache.get(name, arguments)
    if cached is not None:
        return {**cached, "_memo": True}

    result = _execute_tool_raw(name, arguments, actor=actor)

    # Post-execution: write tools evict the cache; reads populate it.
    if name in _WRITE_TOOL_NAMES:
        tool_memo_cache.invalidate()
    else:
        tool_memo_cache.put(name, arguments, result)

    return result


async def execute_tool_off_loop(
    name: str, arguments: dict[str, Any], *, actor: Actor = Actor.AGENT
) -> dict[str, Any]:
    """Run :func:`execute_tool` on a worker thread.

    Slow tool bodies (bSDD WAN calls up to their 15 s timeout, health checks,
    sandbox runs) used to execute synchronously ON the chat event loop,
    freezing every WebSocket for their duration. Off-loop execution fixes
    that; write-tier tools additionally hold the shared edit lock, because
    leaving the loop also leaves the loop's implicit serialization against
    the REST editor routes (single-writer invariant, same treatment as the
    MCP write path).
    """
    import asyncio

    from app.services.edit_lock import edit_lock

    if tool_tier(name)[0] == "write_edit":
        async with edit_lock:
            return await asyncio.to_thread(execute_tool, name, arguments, actor=actor)
    return await asyncio.to_thread(execute_tool, name, arguments, actor=actor)


def _truncate_list_tail(result: dict[str, Any], max_length: int) -> Optional[str]:
    """Drop tail entries from the largest top-level list until the serialized
    envelope fits within ``max_length``.

    Returns the serialized envelope (valid JSON, with ``truncated``/``shown``/
    ``total`` fields and an explicit ``truncation_note``), or ``None`` when the
    payload has no shrinkable list or even a single-entry prefix will not fit
    (the caller then falls back to a character cut).
    """
    candidates = {
        k: v for k, v in result.items() if isinstance(v, list) and len(v) > 1
    }
    if not candidates:
        return None
    # The list with the largest serialized footprint is the one worth shrinking.
    key = max(candidates, key=lambda k: len(json.dumps(candidates[k], default=str)))
    items = result[key]
    total = len(items)

    def _serialize(n: int) -> str:
        return json.dumps(
            {
                **result,
                key: items[:n],
                "truncated": True,
                "shown": n,
                "total": total,
                "truncation_note": (
                    f"[TRUNCATED: showing first {n} of {total} '{key}' entries - "
                    f"{_TRUNCATION_HINT}]"
                ),
            },
            indent=2,
            default=str,
        )

    # Binary-search the largest prefix that fits. The full list already failed
    # the length check, so the search space is [1, total - 1].
    lo, hi = 1, total - 1
    best: Optional[str] = None
    while lo <= hi:
        mid = (lo + hi) // 2
        candidate = _serialize(mid)
        if len(candidate) <= max_length:
            best = candidate
            lo = mid + 1
        else:
            hi = mid - 1
    return best


def format_tool_result(result: dict[str, Any], max_length: int = 8000) -> str:
    """Format a tool result as a JSON string the LLM can trust.

    Results that fit within ``max_length`` are returned verbatim. Oversized
    results are truncated HONESTLY - the model always receives an explicit
    marker describing what was dropped (the old behaviour chopped the JSON
    mid-token with no signal, so the model presented partial data as
    complete):

    * When the result contains a top-level list (elements, storeys, hits...),
      tail entries are dropped so the payload stays valid JSON and the
      envelope gains ``truncated: true``, ``shown``/``total`` counts, and a
      ``truncation_note`` marker.
    * Otherwise the serialized text is cut at ``max_length`` and an explicit
      ``[TRUNCATED: showing first N of M chars - ...]`` marker is appended.
    """
    text = json.dumps(result, indent=2, default=str)
    if len(text) <= max_length:
        return text

    tail_truncated = _truncate_list_tail(result, max_length)
    if tail_truncated is not None:
        return tail_truncated

    cut = text[:max_length]
    return (
        cut
        + f"\n[TRUNCATED: showing first {len(cut)} of {len(text)} chars - "
        + _TRUNCATION_HINT + "]"
    )
