"""
Tool definitions and execution for the IFC model query agent.

Each tool maps to an IFC service operation. The LLM can call these tools
to query the loaded model, and the results are fed back for synthesis.
"""

import asyncio
import concurrent.futures
import json
import logging
from typing import Any, Optional

from app.services.aabb_service import aabb_service
from app.services.carbon_service import compute_carbon
from app.services.code_runner import DEFAULT_TIMEOUT_S as _CODE_DEFAULT_TIMEOUT_S
from app.services.cost_service import DEFAULT_CURRENCY, compute_boq
from app.services.element_index_service import element_index
from app.services.element_relationships import build_relationship_map
from app.services.entity_dependency_graph import get_graph
from app.services.ids_service import extract_failing_ids, validate_ids_base64
from app.services.ifc_service import ifc_service
from app.services.metadata_index_service import metadata_index_service
from app.services.operation_service import Actor, operation_service
from app.services.qto_service import GROUP_FIELDS
from app.services.sandbox_service import sandbox_service
from app.services.spatial_proximity import find_nearby_via_aabbs
from app.services.tool_memo import tool_memo_cache

logger = logging.getLogger(__name__)

# Names of tools that mutate the model - these invalidate the memo cache.
_WRITE_TOOL_NAMES: frozenset[str] = frozenset(
    {
        "rename_element",
        "update_property_value",
        "rename_elements_batch",
        "update_properties_batch",
        "propose_edit",
        "execute_ifc_code",
        "create_wall_from_ends",
        "delete_element",
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

TOOL_DEFINITIONS = [
    {
        "name": "get_project_info",
        "description": "Get metadata about the loaded IFC project including name, schema version, author, and organization.",
        "parameters": {
            "type": "object",
            "properties": {},
            "required": [],
        },
        "where": "client",
    },
    {
        "name": "get_model_stats",
        "description": "Get statistics about the loaded IFC model: total element count, elements grouped by IFC type, list of storeys, and list of materials.",
        "parameters": {
            "type": "object",
            "properties": {},
            "required": [],
        },
        "where": "client",
    },
    {
        "name": "search_elements",
        "description": "Search for IFC elements by name, type, or GlobalId. Returns matching elements with their Express ID, name, type, and storey.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search text to match against element name, IFC type, or GlobalId.",
                },
                "ifc_type": {
                    "type": "string",
                    "description": "Optional IFC type filter (e.g. 'IfcWall', 'IfcDoor', 'IfcWindow').",
                },
                "storey": {
                    "type": "string",
                    "description": "Optional storey name filter.",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max results to return (default 50).",
                },
            },
            "required": ["query"],
        },
        "where": "client",
    },
    {
        "name": "get_element_details",
        "description": "Get full details for a specific IFC element by its Express ID, including properties, materials, quantities, and type information.",
        "parameters": {
            "type": "object",
            "properties": {
                "element_id": {
                    "type": "integer",
                    "description": "The IFC Express ID of the element.",
                },
            },
            "required": ["element_id"],
        },
        "where": "client",
    },
    {
        "name": "get_elements_by_type",
        "description": "Get all elements of a specific IFC type (e.g. IfcWall, IfcDoor, IfcSlab, IfcBeam, IfcColumn, IfcWindow, IfcStair, etc.).",
        "parameters": {
            "type": "object",
            "properties": {
                "ifc_type": {
                    "type": "string",
                    "description": "The IFC type to filter by (e.g. 'IfcWall', 'IfcDoor').",
                },
            },
            "required": ["ifc_type"],
        },
        "where": "client",
    },
    {
        "name": "get_elements_by_storey",
        "description": "Get all elements contained in a specific building storey by storey Express ID.",
        "parameters": {
            "type": "object",
            "properties": {
                "storey_id": {
                    "type": "integer",
                    "description": "The Express ID of the building storey.",
                },
            },
            "required": ["storey_id"],
        },
        "where": "client",
    },
    {
        "name": "get_storeys",
        "description": "List all building storeys in the model with their Express IDs and names.",
        "parameters": {
            "type": "object",
            "properties": {},
            "required": [],
        },
        "where": "client",
    },
    {
        "name": "search_by_property",
        "description": "Search for IFC elements that have a specific property name and optionally a specific value. Useful for finding elements by their custom properties like FireRating, IsExternal, LoadBearing, etc.",
        "parameters": {
            "type": "object",
            "properties": {
                "property_name": {
                    "type": "string",
                    "description": "Name of the property to search for (e.g. 'FireRating', 'IsExternal', 'LoadBearing').",
                },
                "property_value": {
                    "type": "string",
                    "description": "Optional value to match (e.g. 'True', '60', 'REI90'). If omitted, returns all elements with that property.",
                },
                "pset_name": {
                    "type": "string",
                    "description": "Optional property set name to narrow the search (e.g. 'Pset_WallCommon').",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max results to return (default 50).",
                },
            },
            "required": ["property_name"],
        },
        "where": "server",
    },
    {
        "name": "search_elements_semantic",
        "description": (
            "Semantic search for IFC elements using natural-language descriptions. "
            "More powerful than search_elements for intent-based queries like "
            "'load-bearing walls', 'fire-rated partitions', or 'elements on the ground floor'. "
            "Falls back to BM25 keyword search if the model index is not yet built. "
            "Returns the same shape as search_elements."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Natural-language query describing the elements to find.",
                },
                "top_k": {
                    "type": "integer",
                    "description": "Maximum number of results to return (default 10, max 50).",
                },
            },
            "required": ["query"],
        },
        "where": "server",
    },
    {
        "name": "get_all_property_names",
        "description": "Get a list of all property set names and their property names available in the model. Useful for discovering what properties exist before searching.",
        "parameters": {
            "type": "object",
            "properties": {},
            "required": [],
        },
        "where": "server",
    },
    {
        "name": "highlight_elements",
        "description": "Highlight specific elements in the 3D viewer by their Express IDs. Use this when the user asks to show, highlight, or point out elements.",
        "parameters": {
            "type": "object",
            "properties": {
                "element_ids": {
                    "type": "array",
                    "items": {"type": "integer"},
                    "description": "List of Express IDs to highlight in the viewer.",
                },
            },
            "required": ["element_ids"],
        },
        "where": "client",
    },
    {
        "name": "select_element",
        "description": "Select a single element in the 3D viewer and open its properties panel. Use when the user asks to focus on, inspect, or open one specific element.",
        "parameters": {
            "type": "object",
            "properties": {
                "element_id": {
                    "type": "integer",
                    "description": "The IFC Express ID of the element to select.",
                },
            },
            "required": ["element_id"],
        },
        "where": "client",
    },
    {
        "name": "isolate_elements",
        "description": "Isolate specific elements in the 3D viewer (hide everything else). Useful when the user asks to focus on a subset, e.g. 'isolate level 2' or 'show me only doors'.",
        "parameters": {
            "type": "object",
            "properties": {
                "element_ids": {
                    "type": "array",
                    "items": {"type": "integer"},
                    "description": "List of Express IDs to keep visible. Pass an empty array to clear isolation.",
                },
            },
            "required": ["element_ids"],
        },
        "where": "client",
    },
    {
        "name": "show_all_elements",
        "description": "Restore full visibility in the 3D viewer (clear any isolation/hiding). Use when the user asks to see everything again.",
        "parameters": {
            "type": "object",
            "properties": {},
            "required": [],
        },
        "where": "client",
    },
    {
        "name": "clip_section_box_to_element",
        "description": "Fit the 3D section-box crop to a single element's bounding box (AABB) with 10 % padding. Useful when the user asks to 'zoom into', 'section', 'cut to', or 'focus the section box on' a specific element. Combines a section-box enable with an element-centred crop in one step.",
        "parameters": {
            "type": "object",
            "properties": {
                "element_id": {
                    "type": "integer",
                    "description": "Express ID of the element to clip the section box to.",
                },
            },
            "required": ["element_id"],
        },
        "where": "client",
    },
    {
        "name": "get_quantities_summary",
        "description": "Aggregate IfcElementQuantity values (lengths, areas, volumes, weights, counts) across the model. Use this for totals like 'total wall area', 'concrete volume per storey', 'gross floor area', or 'total length of pipes'.",
        "parameters": {
            "type": "object",
            "properties": {
                "group_by": {
                    "type": "string",
                    "enum": ["ifc_type", "storey"],
                    "description": "How to group the totals. Defaults to 'ifc_type'.",
                },
                "ifc_type": {
                    "type": "string",
                    "description": "Optional IFC type filter (e.g. 'IfcWall'). When set, only that type contributes.",
                },
                "storey": {
                    "type": "string",
                    "description": "Optional storey name filter. When set, only elements on that storey contribute.",
                },
            },
            "required": [],
        },
        "where": "server",
    },
    {
        "name": "run_model_health_check",
        "description": (
            "Run a set of deterministic IFC model quality rules and return a structured "
            "JSON report including total issue counts, per-severity breakdown, and "
            "per-rule issue records with element names and Express IDs. "
            "Seven rules are checked: (1) missing_global_id - elements without a GUID "
            "(severity: error); (2) duplicate_global_id - elements sharing a GUID "
            "(severity: error); (3) missing_name - structural elements with blank Name "
            "(severity: warning); (4) empty_property_sets - IfcPropertySet with no "
            "properties (severity: warning); (5) no_storey_assignment - walls/slabs/"
            "columns/beams not assigned to any building storey (severity: warning); "
            "(6) duplicate_name_in_type - same Name used for multiple instances of the "
            "same door/window/space type (severity: info); (7) large_element_count - "
            "informational flag when the model has more than 10 000 elements. "
            "Use this tool when the user asks about model quality, data integrity, "
            "BIM health, QA/QC audits, or missing data issues. The response includes "
            "duration_ms so you can report how long the check took."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "limit_per_rule": {
                    "type": "integer",
                    "description": "Max issue records to return per rule (default 50). Use 10-20 for a quick summary, 100+ for deep audits.",
                    "default": 50,
                },
            },
            "required": [],
        },
        "where": "server",
    },
    {
        "name": "ids_validate",
        "description": (
            "Validate the loaded IFC model against a buildingSMART IDS "
            "(Information Delivery Specification) XML document. The IDS "
            "payload is supplied as base64 (typically from a chat file "
            "attachment with kind='ids'). Returns per-specification pass/"
            "fail counts and a list of offending Express IDs with reasons. "
            "Prefer this over manual property searches when the user asks "
            "to audit the model against a spec."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "ids_base64": {
                    "type": "string",
                    "description": (
                        "Base64-encoded IDS XML. The chat attachment "
                        "pipeline exposes one as {kind:'ids', data_base64}; "
                        "pass that data_base64 through unchanged."
                    ),
                },
                "limit_per_spec": {
                    "type": "integer",
                    "description": "Max failing elements to enumerate per spec (default 25).",
                },
            },
            "required": ["ids_base64"],
        },
        "where": "server",
    },
    {
        "name": "highlight_ids_failures",
        "description": (
            "Highlight in the 3D viewer all IFC elements that failed an IDS "
            "specification. Re-runs the IDS validation and highlights only the "
            "failing elements for the given spec (or all specs if spec_name is "
            "omitted). Call after ids_validate when the user asks to see "
            "non-compliant elements in the model."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "ids_base64": {
                    "type": "string",
                    "description": "Same base64-encoded IDS XML used in ids_validate.",
                },
                "spec_name": {
                    "type": "string",
                    "description": (
                        "Name of a single specification to highlight (from "
                        "the 'name' field in ids_validate results). "
                        "If omitted, all failing elements across all specs "
                        "are highlighted."
                    ),
                },
            },
            "required": ["ids_base64"],
        },
        "where": "server",
    },
    # ---- Write tools (edit assistant) ----
    {
        "name": "rename_element",
        "description": (
            "Rename an IFC element by changing its Name attribute. "
            "This is a reversible edit - use undo_last_edit to roll back. "
            "Always confirm the element_id with get_element_details first."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "element_id": {
                    "type": "integer",
                    "description": "The IFC Express ID of the element to rename.",
                },
                "new_name": {
                    "type": "string",
                    "description": "The new name string. Must be non-empty.",
                },
            },
            "required": ["element_id", "new_name"],
        },
        "where": "server",
    },
    {
        "name": "update_property_value",
        "description": (
            "Update a single property value on an IFC element's property set. "
            "This is a reversible edit - use undo_last_edit to roll back. "
            "Use get_element_details first to confirm the property set and property name."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "element_id": {
                    "type": "integer",
                    "description": "The IFC Express ID of the element.",
                },
                "property_name": {
                    "type": "string",
                    "description": "Exact name of the IfcPropertySingleValue to update.",
                },
                "new_value": {
                    "description": "New value. Provide as a string, number, or boolean to match the existing property type.",
                },
                "pset_name": {
                    "type": "string",
                    "description": "Optional: name of the IfcPropertySet that contains the property. Required if multiple psets share the same property name.",
                },
            },
            "required": ["element_id", "property_name", "new_value"],
        },
        "where": "server",
    },
    {
        "name": "rename_elements_batch",
        "description": (
            "Rename multiple IFC elements in a single atomic operation. "
            "All renames share ONE undo entry, so undo_last_edit rolls back the whole batch at once. "
            "Partial failures (element not found, missing Name) are recorded in 'results' "
            "but don't abort the remaining renames. "
            "Prefer this over looping rename_element when renaming more than one element."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "renames": {
                    "type": "array",
                    "description": "List of {element_id, new_name} rename operations.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "element_id": {
                                "type": "integer",
                                "description": "The IFC Express ID of the element to rename.",
                            },
                            "new_name": {
                                "type": "string",
                                "description": "New name string. Must be non-empty.",
                            },
                        },
                        "required": ["element_id", "new_name"],
                    },
                    "minItems": 1,
                },
            },
            "required": ["renames"],
        },
        "where": "server",
    },
    {
        "name": "update_properties_batch",
        "description": (
            "Update property values on multiple IFC elements in a single atomic operation. "
            "All updates share ONE undo entry, so undo_last_edit rolls back the whole batch at once. "
            "Items where the property is not found or fails are recorded in 'results' "
            "but don't abort the remaining updates. "
            "Prefer this over looping update_property_value when changing more than one element."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "updates": {
                    "type": "array",
                    "description": "List of property update operations.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "element_id": {
                                "type": "integer",
                                "description": "The IFC Express ID of the element.",
                            },
                            "property_name": {
                                "type": "string",
                                "description": "Exact name of the IfcPropertySingleValue to update.",
                            },
                            "new_value": {
                                "description": "New value. Provide as a string, number, or boolean.",
                            },
                            "pset_name": {
                                "type": "string",
                                "description": "Optional: name of the IfcPropertySet. Required when multiple psets share the property name.",
                            },
                        },
                        "required": ["element_id", "property_name", "new_value"],
                    },
                    "minItems": 1,
                },
            },
            "required": ["updates"],
        },
        "where": "server",
    },
    {
        "name": "undo_last_edit",
        "description": (
            "Undo the most recent rename_element, update_property_value, rename_elements_batch, "
            "or update_properties_batch operation. "
            "Can be called repeatedly to walk back through the edit history (up to 20 edits)."
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
    {
        "name": "propose_edit",
        "description": (
            "Propose a batch of edits for USER APPROVAL before they touch "
            "the live model. The backend runs the ops in an isolated "
            "sandbox, computes a structural diff (renamed / property-"
            "changed / deleted), and returns a pending-edit envelope. The "
            "user clicks Apply or Discard in the UI - nothing mutates "
            "until they do. Prefer this over rename_element / "
            "update_property_value when the change is larger than one "
            "element or when the user asked you to 'preview' / 'show me "
            "the diff'. Supports ops: "
            "{'op':'set_name','element_id':int,'new_name':str}, "
            "{'op':'set_property','element_id':int,'property_name':str,"
            "'new_value':any,'pset_name':str?}."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "ops": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "op": {"type": "string", "enum": ["set_name", "set_property"]},
                            "element_id": {"type": "integer"},
                            "new_name": {"type": "string"},
                            "property_name": {"type": "string"},
                            "new_value": {},
                            "pset_name": {"type": "string"},
                        },
                        "required": ["op", "element_id"],
                    },
                    "description": "Ordered list of edit ops to stage.",
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
            "for analysis and question answering. Use this in Ask mode when "
            "the structured read tools are not expressive enough. Available "
            "names in the sandbox: `model` / `ifc` (the open ifcopenshell.file "
            "handle), `ifcopenshell`, `ifcopenshell.api`, "
            "`ifcopenshell.util.element`, plus `math`, `statistics`, `re`, "
            "`json`, `collections`, `uuid`. Assign to a `result` variable "
            "if you want a value back in the chat summary; print output is "
            "also captured. If the code produces structural model changes, "
            "the sandbox is discarded and the call returns an error. Use "
            "`execute_ifc_code` in Edit mode when you intend to stage edits."
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
            "model - the full sandbox-then-apply edit path. Use this "
            "from Edit mode when the change doesn't fit the enumerable op vocabulary "
            "of propose_edit (e.g. batch geometry moves, custom algorithms, "
            "relationship rewiring, psets created/deleted programmatically). "
            "Available names in the sandbox: `model` / `ifc` (the open "
            "ifcopenshell.file handle), `ifcopenshell`, `ifcopenshell.api`, "
            "`ifcopenshell.util.element`, plus `math`, `statistics`, `re`, "
            "`json`, `collections`, `uuid`. Assign to a `result` variable "
            "if you want a value back in the chat summary (its repr is "
            "returned, capped at 2 KB). Any `print(...)` output is also "
            "captured. The code runs in a subprocess with a wall-clock "
            "timeout and no network / filesystem access outside the "
            "sandbox file. If the code mutates the model, a diff envelope "
            "is returned and the user must click Apply in the UI - nothing "
            "touches the live handle until they do. If the hash is "
            "unchanged, the call is treated as read-only and returns the "
            "captured stdout + `result` repr."
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
        "name": "create_wall_from_ends",
        "description": (
            "Create a new IfcWallStandardCase between two XY endpoint "
            "coordinates on a given building storey. The wall geometry is "
            "built from a swept rectangular profile using IfcOpenShell's "
            "ShapeBuilder. The result goes through the standard "
            "sandbox → diff-preview envelope: the user sees a 'New element' "
            "row in the Diff Preview panel and must click Apply before the "
            "wall is committed to the live model."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "start": {
                    "type": "array",
                    "items": {"type": "number"},
                    "minItems": 2,
                    "maxItems": 3,
                    "description": "Start point [x, y] or [x, y, z] in metres.",
                },
                "end": {
                    "type": "array",
                    "items": {"type": "number"},
                    "minItems": 2,
                    "maxItems": 3,
                    "description": "End point [x, y] or [x, y, z] in metres.",
                },
                "height": {
                    "type": "number",
                    "description": "Wall height in metres (default 3.0).",
                },
                "thickness": {
                    "type": "number",
                    "description": "Wall thickness in metres (default 0.2).",
                },
                "storey_name": {
                    "type": "string",
                    "description": (
                        "Name of the target building storey (e.g. 'Ground Floor'). "
                        "Omit to use the first storey in the model."
                    ),
                },
                "name": {
                    "type": "string",
                    "description": "Name for the new wall element (default 'Wall').",
                },
            },
            "required": ["start", "end"],
        },
        "where": "server",
    },
    {
        "name": "delete_element",
        "description": (
            "Delete an IfcProduct element from the model by its Express ID. "
            "Only IfcProduct subclasses (walls, slabs, doors, windows, columns, "
            "beams, spaces, etc.) can be deleted via this tool. The deletion "
            "goes through the sandbox → diff-preview envelope: the user sees a "
            "'Deleted element' row in the Diff Preview panel and must click Apply "
            "to commit the deletion. This is irreversible after Apply - the undo "
            "stack covers simple property edits but not structural deletions. "
            "Warn the user before proposing large-scale deletions."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "element_id": {
                    "type": "integer",
                    "description": "Express ID of the IfcProduct to delete.",
                },
                "reason": {
                    "type": "string",
                    "description": "Optional short reason for the deletion (shown in the diff summary).",
                },
            },
            "required": ["element_id"],
        },
        "where": "server",
    },
    {
        "name": "search_document_index",
        "description": (
            "Search the user's uploaded document index (PDFs, Markdown specs, "
            "standards, notes) using BM25 keyword matching. Returns the top "
            "matching passages with source document names and relevance scores. "
            "Use this when the user asks a question that might be answered by "
            "an uploaded specification or standard, e.g. 'does this model "
            "comply with the uploaded BIM standard?' or 'what does the spec "
            "say about fire ratings?'. Returns empty results when no documents "
            "have been indexed yet."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Natural-language or keyword query to search the document index.",
                },
                "top_k": {
                    "type": "integer",
                    "description": "Maximum number of passages to return (default 5, max 20).",
                },
            },
            "required": ["query"],
        },
        "where": "server",
    },
    {
        "name": "bsdd_search",
        "description": (
            "Search the buildingSMART Data Dictionary (bSDD) for IFC "
            "classifications and properties by free text. bSDD is the "
            "authoritative online dictionary of building classification systems "
            "(Uniclass, IFC, DIN, etc.). Use it to find the right classification "
            "for an element, discover standard property definitions, or answer "
            "'what classification/property should this have?'. Works WITHOUT a "
            "loaded model. Returns matching classes/properties with their bSDD "
            "URIs - pass a URI to bsdd_get_class / bsdd_get_properties."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Free-text search, e.g. 'exterior wall' or 'fire rating'.",
                },
                "dictionary_uri": {
                    "type": "string",
                    "description": "Optional bSDD dictionary URI to scope the search.",
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum results (default 20, max 50).",
                },
            },
            "required": ["query"],
        },
        "where": "server",
    },
    {
        "name": "bsdd_get_class",
        "description": (
            "Fetch the full bSDD definition of one classification by its URI - "
            "definition, parent class, and associated properties. Get the URI "
            "from bsdd_search first. Works WITHOUT a loaded model."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "uri": {
                    "type": "string",
                    "description": "The bSDD class URI (from bsdd_search results).",
                },
            },
            "required": ["uri"],
        },
        "where": "server",
    },
    {
        "name": "bsdd_get_properties",
        "description": (
            "List the standard properties a bSDD classification defines, by "
            "class URI - the correct property set + property names and datatypes "
            "the classification expects. Get the URI from bsdd_search. No model "
            "needed."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "uri": {
                    "type": "string",
                    "description": "The bSDD class URI whose properties to list.",
                },
            },
            "required": ["uri"],
        },
        "where": "server",
    },
    {
        "name": "get_docs",
        "description": (
            "Look up reference documentation. Sources: 'ifcopenshell' (the "
            "IfcOpenShell Python API - consult BEFORE writing execute_ifc_code so "
            "the calls are correct), 'bsdd' (buildingSMART classifications / "
            "properties), 'user' (documents the user uploaded), 'ifc-schema' (IFC "
            "entity / attribute reference). Returns the most relevant passages "
            "with their source. Works WITHOUT a loaded model. If a source isn't "
            "indexed yet the result says so and how to index it."
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
                    "description": (
                        "Optional exact symbol to prioritise, e.g. "
                        "'ifcopenshell.api.geometry.edit_object_placement' or a bSDD class URI."
                    ),
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum passages to return (default 5, max 15).",
                },
            },
            "required": ["source", "query"],
        },
        "where": "server",
    },
    {
        "name": "get_connected_elements",
        "description": (
            "Return the wall or slab neighbours that are path-connected to a given "
            "element via IfcRelConnectsPathElements. Useful for questions like 'which "
            "walls meet at this corner?' or 'what does this wall connect to?'. "
            "Returns a list of connected elements with their IFC type and connection type."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "element_id": {
                    "type": "integer",
                    "description": "Express ID of the element to find connections for.",
                },
            },
            "required": ["element_id"],
        },
        "where": "server",
    },
    {
        "name": "get_element_material",
        "description": (
            "Return the material assignment of an IFC element - material name, "
            "layer set, layer thicknesses (in mm), and total wall thickness. "
            "Useful for questions like 'what material is this wall made of?' or "
            "'how thick is the insulation layer?'."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "element_id": {
                    "type": "integer",
                    "description": "Express ID of the element.",
                },
            },
            "required": ["element_id"],
        },
        "where": "server",
    },
    {
        "name": "get_openings_for_element",
        "description": (
            "Return the doors and windows that are hosted by (cut into) a given "
            "element. Uses IfcRelVoidsElement to find openings and IfcRelFillsElement "
            "to find the door/window that fills each opening. Useful for questions "
            "like 'which windows are in the north wall?' or 'does this slab have "
            "any openings?'."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "element_id": {
                    "type": "integer",
                    "description": "Express ID of the host element (typically a wall or slab).",
                },
            },
            "required": ["element_id"],
        },
        "where": "server",
    },
    {
        "name": "find_elements_by_type_name",
        "description": (
            "Search for elements whose IfcTypeObject name contains a given substring "
            "(case-insensitive). Complements get_elements_by_type (which matches exact "
            "IFC class names) with human-friendly type names like 'Exterior Wall', "
            "'Double Door', or 'Paroc'. Returns matching elements with their storey. "
            "Useful for questions like 'find all Paroc walls' or 'show Basic Wall type'."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "substring": {
                    "type": "string",
                    "description": "Substring to match against IfcTypeObject.Name (case-insensitive).",
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum results to return (default 50).",
                },
            },
            "required": ["substring"],
        },
        "where": "server",
    },
    {
        "name": "find_nearby_elements",
        "description": (
            "Find IFC elements within a given radius (in metres) of a reference "
            "element, sorted by distance ascending. When the model's real-geometry "
            "AABB cache is warm, distances are box-to-box surface distances "
            "(result carries geometry: 'aabb'; 0.0 means the elements touch or "
            "overlap). Before that cache finishes computing, the tool falls back "
            "to Euclidean distance between IfcLocalPlacement origins (result "
            "carries geometry: 'placement_origin' plus a note) - origin distances "
            "are approximate for large or off-origin elements, so mention that "
            "caveat when it applies. "
            "Useful for questions like 'what elements are near door #123?', "
            "'find all elements within 3 m of this column', or "
            "'which walls are adjacent to this room?'. "
            "Filter by ifc_types to limit to specific element categories."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "element_id": {
                    "type": "integer",
                    "description": "Express ID of the reference element.",
                },
                "radius_m": {
                    "type": "number",
                    "description": "Search radius in metres (default 5.0).",
                },
                "ifc_types": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "Optional IFC class filter, e.g. ['IfcWall', 'IfcColumn']. "
                        "Omit to include all element types."
                    ),
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum results to return (default 20).",
                },
            },
            "required": ["element_id"],
        },
        "where": "server",
    },
    {
        "name": "filter_by_property_value",
        "description": (
            "Filter elements by a property value condition. Supports string and numeric "
            "comparisons. Operators: eq (equals), neq (not equals), contains (substring), "
            "startswith, gt (greater than), lt (less than), gte (>=), lte (<=). "
            "Returns matching element IDs for highlight + detailed element list. "
            "Useful for questions like 'find all walls with FireRating = 2h', "
            "'show rooms with area > 20 m²', or 'which doors have IsExternal = true'. "
            "After calling this, call highlight_elements with the returned element_ids."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "property_name": {
                    "type": "string",
                    "description": "Name of the IFC property (e.g. 'FireRating', 'IsExternal', 'Area').",
                },
                "operator": {
                    "type": "string",
                    "enum": ["eq", "neq", "contains", "startswith", "gt", "lt", "gte", "lte"],
                    "description": "Comparison operator.",
                },
                "value": {
                    "type": "string",
                    "description": "Value to compare against (always a string; numeric operators coerce both sides).",
                },
                "ifc_type": {
                    "type": "string",
                    "description": "Optional IFC class filter (e.g. 'IfcWall'). Omit for all types.",
                },
                "storey": {
                    "type": "string",
                    "description": "Optional storey name filter. Omit for all storeys.",
                },
                "pset_name": {
                    "type": "string",
                    "description": "Optional property set name filter (e.g. 'Pset_WallCommon'). Omit to search all psets.",
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum results to return (default 100).",
                },
            },
            "required": ["property_name", "operator", "value"],
        },
        "where": "server",
    },
    {
        "name": "get_cost_summary",
        "description": (
            "Priced bill of quantities (5D cost estimate) for the loaded model. "
            "Runs the quantity takeoff grouped by IFC class (plus optional extra "
            "dimensions), prices each row from the editable rate library, and "
            "returns rows sorted by amount descending with the grand total and "
            "priced/unpriced coverage. IMPORTANT: rates come from the user-editable "
            "cost rate library and the shipped defaults are illustrative "
            "placeholders, NOT market prices - always present amounts as estimates "
            "and mention that rates are editable in the Cost panel. Use for "
            "questions like 'what does this building cost?', 'cost breakdown per "
            "storey', or 'which element types drive the cost?'."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "group_by": {
                    "type": "array",
                    "items": {
                        "type": "string",
                        "enum": ["storey", "material", "type_object", "classification"],
                    },
                    "description": (
                        "Optional extra grouping dimensions applied after the "
                        "implicit ifc_class (e.g. ['storey'] for a per-storey "
                        "cost breakdown)."
                    ),
                },
                "top_rows": {
                    "type": "integer",
                    "description": (
                        "Maximum rows to return, sorted by amount descending "
                        "(default 25, max 100). Totals always cover ALL rows."
                    ),
                },
            },
            "required": [],
        },
        "where": "server",
    },
    {
        "name": "get_carbon_summary",
        "description": (
            "Embodied-carbon estimate for the loaded model, grouped by material "
            "(plus optional extra dimensions). Multiplies quantity takeoff values "
            "by emission factors (kgCO2e per unit) from the editable factor "
            "library, with keyword fallbacks for common materials (concrete, "
            "steel, timber, glass, ...). Returns rows sorted by carbon descending "
            "with totals in kg and tonnes plus factored/unfactored coverage. "
            "IMPORTANT: the default factors are illustrative cradle-to-gate "
            "placeholders, NOT a certified LCA - always present figures as rough "
            "estimates and mention that factors are editable in the Carbon panel. "
            "Use for questions like 'what is the embodied carbon of this "
            "building?' or 'which material drives the CO2 footprint?'."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "group_by": {
                    "type": "array",
                    "items": {
                        "type": "string",
                        "enum": ["ifc_class", "storey", "type_object", "classification"],
                    },
                    "description": (
                        "Optional extra grouping dimensions applied after the "
                        "implicit material (e.g. ['storey'] for a per-storey "
                        "carbon breakdown)."
                    ),
                },
                "top_rows": {
                    "type": "integer",
                    "description": (
                        "Maximum rows to return, sorted by carbon descending "
                        "(default 25, max 100). Totals always cover ALL rows."
                    ),
                },
            },
            "required": [],
        },
        "where": "server",
    },
    {
        "name": "get_element_relationships",
        "description": (
            "Full relationship map for one element: spatial containment chain "
            "(storey / building / site / project), aggregation parent and "
            "children, openings the element hosts and what fills them (doors / "
            "windows), the opening + host the element itself fills, path-"
            "connected neighbours, its type object with the instance count, and "
            "property-set sharing stats. Every reference includes the Express ID, "
            "GlobalId, name and IFC type so you can narrate the context. Use for "
            "questions like 'where is this element?', 'which wall hosts this "
            "door?', 'what belongs to this wall?', or 'how is this element "
            "related to the rest of the model?'."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "element_id": {
                    "type": "integer",
                    "description": "Express ID of the element to map relationships for.",
                },
            },
            "required": ["element_id"],
        },
        "where": "server",
    },
    {
        "name": "run_model_audit",
        "description": (
            "THE tool for 'audit this model', 'is this model ready?', or any "
            "overall quality-and-readiness question. One call chains five checks "
            "into a structured report: (1) rule-based model health (GUIDs, names, "
            "storey assignment, empty psets), (2) quantity-takeoff coverage (how "
            "many elements carry base quantities), (3) 5D cost pricing coverage, "
            "(4) embodied-carbon factor coverage, and (5) a summary of the last "
            "cached IDS validation run for this model when one exists. Returns "
            "{sections: [{name, status: ok|warnings|issues, findings, stats}], "
            "summary} - narrate it section by section, leading with the overall "
            "summary status and any 'issues' sections. Cost and carbon figures "
            "rely on the editable placeholder rate/factor libraries, so flag them "
            "as estimates."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "limit_per_rule": {
                    "type": "integer",
                    "description": (
                        "Max issue examples per health rule (default 10). "
                        "Raise for deep audits."
                    ),
                },
            },
            "required": [],
        },
        "where": "server",
    },
]


TOOL_BY_NAME: dict[str, dict[str, Any]] = {t["name"]: t for t in TOOL_DEFINITIONS}


def tool_where(name: str) -> str:
    """Where should this tool run by default? Returns "client" or "server"."""
    return TOOL_BY_NAME.get(name, {}).get("where", "server")


# Tier classification for the Agent Manager UI.
_TOOL_TIERS: dict[str, tuple[str, str]] = {
    # name → (tier_id, tier_label)
    "get_project_info":        ("read_model",  "Read - Model"),
    "get_model_stats":         ("read_model",  "Read - Model"),
    "search_elements":         ("read_model",  "Read - Model"),
    "get_element_details":     ("read_model",  "Read - Model"),
    "get_elements_by_type":    ("read_model",  "Read - Model"),
    "get_elements_by_storey":  ("read_model",  "Read - Model"),
    "get_storeys":             ("read_model",  "Read - Model"),
    "search_by_property":      ("read_model",  "Read - Model"),
    "get_all_property_names":  ("read_model",  "Read - Model"),
    "get_quantities_summary":  ("read_model",  "Read - Model"),
    "run_model_health_check":  ("read_model",  "Read - Model"),
    "highlight_elements":      ("read_viewer", "Read - Viewer"),
    "select_element":          ("read_viewer", "Read - Viewer"),
    "isolate_elements":        ("read_viewer", "Read - Viewer"),
    "show_all_elements":           ("read_viewer", "Read - Viewer"),
    "clip_section_box_to_element": ("read_viewer", "Read - Viewer"),
    "ids_validate":                ("validate",    "Validate"),
    "highlight_ids_failures":      ("validate",    "Validate"),
    "rename_element":          ("write_edit",  "Write - Edit"),
    "rename_elements_batch":   ("write_edit",  "Write - Edit"),
    "update_property_value":   ("write_edit",  "Write - Edit"),
    "update_properties_batch": ("write_edit",  "Write - Edit"),
    "undo_last_edit":          ("write_edit",  "Write - Edit"),
    "get_edit_history":        ("write_edit",  "Write - Edit"),
    "propose_edit":            ("write_edit",  "Write - Edit"),
    "execute_ifc_query_code":  ("read_model",  "Read - Model"),
    "execute_ifc_code":        ("write_edit",  "Write - Edit"),
    "create_wall_from_ends":   ("write_edit",  "Write - Edit"),
    "delete_element":          ("write_edit",  "Write - Edit"),
    "search_document_index":       ("read_model",  "Read - Model"),
    "bsdd_search":                 ("read_knowledge", "Read - Knowledge"),
    "bsdd_get_class":              ("read_knowledge", "Read - Knowledge"),
    "bsdd_get_properties":         ("read_knowledge", "Read - Knowledge"),
    "get_docs":                    ("read_knowledge", "Read - Knowledge"),
    "search_elements_semantic":    ("read_model",  "Read - Model"),
    "get_connected_elements":      ("read_model",  "Read - Model"),
    "get_element_material":        ("read_model",  "Read - Model"),
    "get_openings_for_element":    ("read_model",  "Read - Model"),
    "find_elements_by_type_name":  ("read_model",  "Read - Model"),
    "find_nearby_elements":        ("read_model",  "Read - Model"),
    "filter_by_property_value":    ("read_model",  "Read - Model"),
    "get_cost_summary":            ("read_model",  "Read - Model"),
    "get_carbon_summary":          ("read_model",  "Read - Model"),
    "get_element_relationships":   ("read_model",  "Read - Model"),
    "run_model_audit":             ("read_model",  "Read - Model"),
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
# Keep in lock-step with the ``if _mi:`` branches in ``_execute_tool_raw``.
# Adding a tool to this set without also adding the branch will surface as
# a "No IFC model loaded" error, not a routing bug.
_NATIVE_INDEX_ELIGIBLE_TOOLS: frozenset[str] = frozenset({
    "get_project_info",
    "get_model_stats",
    "search_elements",
    "get_elements_by_type",
    "get_elements_by_storey",
    "get_storeys",
})


def _native_index_ready() -> bool:
    """True iff metadata_index_service holds a loaded index. Defensive against
    import cycles + import-time failure (returns False if the service can't
    be imported)."""
    try:
        return bool(metadata_index_service.is_loaded)
    except Exception:
        return False


def warming_envelope(name: str) -> Optional[dict[str, Any]]:
    """Return a structured 'still warming' envelope if the AI backend isn't
    ready for this tool yet, else ``None``.

    Replaces the silent black-hole when a user submits a deep
    query while ``ifcopenshell`` is still warming. The LLM sees a clear
    ``warming: True`` result with ``retry_after_ms`` so it can pause and
    retry instead of guessing.

    Viewer-only tools (highlight, isolate, select, show_all, clip_section_box)
    don't need the semantic backend and are exempt.

    Read tools with a native_index fast path
    (``_NATIVE_INDEX_ELIGIBLE_TOOLS``) are also exempt when the native
    index is loaded, so the agent can serve queries via the fast path
    while IfcOpenShell warms up. The tool body then annotates ``_complete:
    false`` so callers know the payload is partial.
    """
    tier_id, tier_label = tool_tier(name)
    if tier_id in _WARMING_EXEMPT_TIERS:
        return None
    # Native-index fast path bypass.
    if name in _NATIVE_INDEX_ELIGIBLE_TOOLS and _native_index_ready():
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
    source (IfcOpenShell API, bSDD, user uploads, IFC schema)."""
    source = str(arguments.get("source") or "").strip().lower()
    query = str(arguments.get("query") or "").strip()
    symbol = arguments.get("symbol")
    limit = min(int(arguments.get("limit") or 5), 15)
    if not query and not symbol:
        return {"error": "get_docs: provide a 'query' (or a 'symbol')."}
    effective_query = f"{symbol} {query}".strip() if symbol else query

    if source == "bsdd":
        from app.services import bsdd_service
        if symbol and "://" in str(symbol):
            return {"source": source, "symbol": symbol,
                    "result": _run_coro_sync(bsdd_service.get_class(str(symbol)))}
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
                "classification/property definitions use the bsdd_* tools."
            ),
        }

    if source == "ifcopenshell":
        from app.services.reference_docs_service import reference_docs_service
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


def _verdict_suffix(verdict: Optional[dict[str, Any]]) -> str:
    """LLM-facing one-liner for a pending edit's verifier verdict (D4): a
    FAIL/WARN in the tool result lets the agent self-repair in the same turn
    instead of presenting a broken edit for Apply."""
    from app.services.sandbox_service import _verifier_note

    return _verifier_note(verdict)


def _execute_tool_raw(
    name: str, arguments: dict[str, Any], *, actor: Actor = Actor.AGENT
) -> dict[str, Any]:
    """
    Execute a tool by name with the given arguments.
    Returns a dict with the result or error.
    Internal implementation - callers should use execute_tool() which applies
    the per-turn memo cache.

    *actor* is stamped onto operation-layer writes so the op log's "who
    changed what" stays truthful across surfaces: the chat agent (default),
    or an external MCP client passing Actor.MCP.
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
            return operation_service.execute(
                "set_name",
                {"element_id": int(arguments["element_id"]), "new_name": str(arguments["new_name"])},
                actor=actor, ifc_service=ifc_service,
            ).to_public_dict()

        elif name == "update_property_value":
            return operation_service.execute(
                "set_property",
                {
                    "element_id": int(arguments["element_id"]),
                    "property_name": str(arguments["property_name"]),
                    "new_value": arguments["new_value"],
                    "pset_name": arguments.get("pset_name"),
                },
                actor=actor, ifc_service=ifc_service,
            ).to_public_dict()

        elif name == "rename_elements_batch":
            renames = arguments.get("renames") or []
            if not isinstance(renames, list):
                return {"error": "rename_elements_batch: 'renames' must be a list"}
            return operation_service.execute(
                "set_names_batch", {"renames": renames},
                actor=actor, ifc_service=ifc_service,
            ).to_public_dict()

        elif name == "update_properties_batch":
            updates = arguments.get("updates") or []
            if not isinstance(updates, list):
                return {"error": "update_properties_batch: 'updates' must be a list"}
            return operation_service.execute(
                "set_properties_batch", {"updates": updates},
                actor=actor, ifc_service=ifc_service,
            ).to_public_dict()

        elif name == "undo_last_edit":
            return operation_service.undo(ifc_service, actor=actor).to_public_dict()

        elif name == "get_edit_history":
            history = ifc_service.get_edit_history()
            return {"count": len(history), "edits": history}

        elif name == "propose_edit":
            ops = arguments.get("ops") or []
            if not isinstance(ops, list):
                return {"error": "propose_edit: 'ops' must be a list"}
            envelope = sandbox_service.propose_edit(
                ifc_service=ifc_service,
                operations=ops,
                summary=arguments.get("summary"),
            )
            if envelope is None:
                return {
                    "action": "pending_noop",
                    "message": (
                        "Sandbox ran cleanly but produced no structural "
                        "change - nothing to review."
                    ),
                }
            return {
                "action": "pending_edit",
                "edit_id": envelope.edit_id,
                "summary": envelope.summary,
                "counts": envelope.counts,
                "change_preview": [
                    c.model_dump() for c in envelope.changes[:10]
                ],
                "total_changes": len(envelope.changes),
                "preview_truncated": len(envelope.changes) > 10,
                "verifier_verdict": envelope.verifier_verdict,
                "note": (
                    "Edit is PENDING - the user must click Apply in the "
                    "Diff Preview panel. Nothing mutates yet."
                    + _verdict_suffix(envelope.verifier_verdict)
                ),
            }

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

        elif name == "search_document_index":
            from app.services.document_index_service import document_index_service
            query = arguments.get("query", "")
            if not query.strip():
                return {"error": "search_document_index: 'query' must be non-empty"}
            top_k = min(int(arguments.get("top_k") or 5), 20)
            passages = document_index_service.search(query, top_k=top_k)
            return {
                "query": query,
                "result_count": len(passages),
                "passages": passages,
            }

        # Knowledge tools (read_knowledge tier): no model needed, warm-up exempt.
        # bSDD calls are async; _run_coro_sync bridges them into this sync path.
        elif name == "bsdd_search":
            from app.services import bsdd_service
            query = str(arguments.get("query") or "").strip()
            if not query:
                return {"error": "bsdd_search: 'query' must be non-empty"}
            limit = min(int(arguments.get("limit") or 20), 50)
            return _run_coro_sync(bsdd_service.search(
                query, dictionary_uri=arguments.get("dictionary_uri"), limit=limit,
            ))

        elif name == "bsdd_get_class":
            from app.services import bsdd_service
            uri = str(arguments.get("uri") or "").strip()
            if not uri:
                return {"error": "bsdd_get_class: 'uri' must be non-empty"}
            return _run_coro_sync(bsdd_service.get_class(uri))

        elif name == "bsdd_get_properties":
            from app.services import bsdd_service
            uri = str(arguments.get("uri") or "").strip()
            if not uri:
                return {"error": "bsdd_get_properties: 'uri' must be non-empty"}
            return _run_coro_sync(bsdd_service.get_class_properties(uri))

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
            from app.services.model_audit import run_model_audit as _run_audit

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
    envelope = warming_envelope(name)
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
