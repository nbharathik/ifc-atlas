"""
MCP server (viewer-as-server).

Always active: read-only tools from the read_model + validate tiers, plus
the viewer bridge tools (observe and drive the 3D viewer, including live
viewport snapshots - presentation only, the model is never modified).
Gated behind the MCP_ALLOW_WRITES=1 env var: five write tools + three
management tools.

Viewer bridge tools (always exposed):
  get_viewer_state, viewer_select_elements, viewer_isolate_elements,
  viewer_highlight_elements, viewer_show_all, viewer_set_camera,
  get_viewer_snapshot, viewer_clip_to_element, viewer_set_section_box,
  viewer_colour_elements, viewer_clear_colours.
  Commands are broadcast to connected browser viewers as viewer_command
  events over the model-sync WebSocket; get_viewer_snapshot additionally
  waits for the browser to upload the captured image and returns it as
  MCP image content.

Write tools (gated):
  rename_element, update_property_value, create_wall_from_ends,
  delete_element, execute_ifc_code.

Management tools (gated):
  apply_pending_edit  - commit a staged edit to the live model.
  discard_pending_edit - abandon a staged edit.
  list_pending_edits  - list all staged edit envelopes.

Two-call diff-preview pattern:
  1. Call a write tool → returns a pending_edit envelope (edit_id + diff).
  2. Call apply_pending_edit(edit_id) to commit, or discard_pending_edit(edit_id)
     to abandon the staged change.
  The pending_edit envelope is published on the model-sync WebSocket so any open
  DiffPreviewPanel in the viewer lights up and can override the decision in real time.

Transports:
  - HTTP/SSE:  build_sse_app() → Starlette sub-app; mount at /mcp in main.py.
  - stdio:     python -m app.mcp_server  (see __main__.py).

Auth:
  Set MCP_SERVER_TOKEN env var for HTTP/SSE bearer-token protection.
  stdio inherits process trust.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any

from mcp import types
from mcp.server import Server
from mcp.server.sse import SseServerTransport
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Mount, Route

from app.services.tools import TOOL_DEFINITIONS, tool_tier, execute_tool

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Read-only tool selection (always exposed)
# ---------------------------------------------------------------------------

_EXPOSED_TIERS: frozenset[str] = frozenset({"read_model", "validate"})

_read_tools: list[dict[str, Any]] = [
    t for t in TOOL_DEFINITIONS if tool_tier(t["name"])[0] in _EXPOSED_TIERS
]
_tool_names: frozenset[str] = frozenset(t["name"] for t in _read_tools)

# All TOOL_DEFINITIONS names - used to distinguish "not permitted" from "unknown".
_all_tool_names: frozenset[str] = frozenset(t["name"] for t in TOOL_DEFINITIONS)


# ---------------------------------------------------------------------------
# Write tool allowlist (gated behind MCP_ALLOW_WRITES=1)
# ---------------------------------------------------------------------------

_WRITE_ALLOWLIST: frozenset[str] = frozenset({
    "rename_element",
    "update_property_value",
    "create_wall_from_ends",
    "delete_element",
    "execute_ifc_code",
})

_write_tools: list[dict[str, Any]] = [
    t for t in TOOL_DEFINITIONS if t["name"] in _WRITE_ALLOWLIST
]
_write_tool_names: frozenset[str] = frozenset(t["name"] for t in _write_tools)


# ---------------------------------------------------------------------------
# Management tools (MCP-specific - not in TOOL_DEFINITIONS; same write gate)
# ---------------------------------------------------------------------------

_MGMT_TOOL_NAMES: frozenset[str] = frozenset({
    "apply_pending_edit",
    "discard_pending_edit",
    "list_pending_edits",
})

_mgmt_tools: list[types.Tool] = [
    types.Tool(
        name="apply_pending_edit",
        description=(
            "Commit a staged edit to the live model. Call this after a write tool "
            "returns a pending_edit envelope. Fires viewer sync events so any open "
            "session automatically reflects the change. Returns the applied envelope."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "edit_id": {
                    "type": "string",
                    "description": (
                        "The edit_id from the write tool's pending_edit response."
                    ),
                }
            },
            "required": ["edit_id"],
        },
    ),
    types.Tool(
        name="discard_pending_edit",
        description=(
            "Discard a staged edit without applying it. The sandbox copy is deleted "
            "and the live model is unchanged."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "edit_id": {
                    "type": "string",
                    "description": (
                        "The edit_id from the write tool's pending_edit response."
                    ),
                }
            },
            "required": ["edit_id"],
        },
    ),
    types.Tool(
        name="list_pending_edits",
        description="List all staged edit envelopes currently awaiting apply or discard.",
        inputSchema={"type": "object", "properties": {}},
    ),
]


# ---------------------------------------------------------------------------
# Viewer bridge tools (always exposed - presentation only, never the model)
# ---------------------------------------------------------------------------

_CAMERA_PRESETS: tuple[str, ...] = (
    "front", "back", "left", "right", "top", "iso", "fit",
)

# Maps element-list command tools to the viewer_command action they broadcast.
_VIEWER_ELEMENT_ACTIONS: dict[str, str] = {
    "viewer_select_elements": "select",
    "viewer_isolate_elements": "isolate",
    "viewer_highlight_elements": "highlight",
}


def _validate_colour_entries(entries: Any) -> str | None:
    """Validate viewer_colour_elements entries; returns a problem string or None.

    Mirrors the caps enforced by POST /api/viewer/command (16 buckets,
    10k total ids) so both entry points reject the same payloads.
    """
    if not isinstance(entries, list) or not entries:
        return "entries must be a non-empty array of {color, element_ids} objects"
    if len(entries) > 16:
        return "entries: at most 16 colour buckets"
    total = 0
    for entry in entries:
        if not isinstance(entry, dict):
            return "each entry must be an object with color and element_ids"
        color = entry.get("color")
        ids = entry.get("element_ids")
        if not isinstance(color, str) or not color.strip():
            return "each entry needs a non-empty string color (e.g. #ff8800)"
        if not isinstance(ids, list) or not ids or any(
            not isinstance(i, int) or isinstance(i, bool) for i in ids
        ):
            return "each entry needs element_ids (a non-empty array of integer ids)"
        label = entry.get("label")
        if label is not None and not isinstance(label, str):
            return "entry label must be a string"
        total += len(ids)
    if total > 10_000:
        return "entries exceed 10000 total element_ids"
    return None

_ELEMENT_IDS_SCHEMA: dict[str, Any] = {
    "type": "array",
    "items": {"type": "integer"},
    "description": (
        "Numeric element ids (express ids, as returned by search_elements "
        "and the other model query tools)."
    ),
}

_viewer_tools: list[types.Tool] = [
    types.Tool(
        name="get_viewer_state",
        description=(
            "Read what the user currently has open in the IFC Atlas 3D viewer: "
            "camera position, selected element ids, isolated/hidden/highlighted "
            "counts, and the loaded model. Returns connected_clients (0 means no "
            "viewer is open) and the last state the viewer reported (null before "
            "the first report). Call this before viewer commands to check that a "
            "viewer is connected and to see what the user is looking at."
        ),
        inputSchema={"type": "object", "properties": {}},
    ),
    types.Tool(
        name="viewer_select_elements",
        description=(
            "Select elements in the user's 3D viewer by element id. The viewer "
            "highlights the selection and shows its properties, exactly as if "
            "the user clicked them. Affects presentation only - the model is "
            "never modified. Requires the IFC Atlas browser viewer to be open."
        ),
        inputSchema={
            "type": "object",
            "properties": {"element_ids": _ELEMENT_IDS_SCHEMA},
            "required": ["element_ids"],
        },
    ),
    types.Tool(
        name="viewer_isolate_elements",
        description=(
            "Isolate elements in the user's 3D viewer: hide everything except "
            "the given element ids so they stand out. Use viewer_show_all to "
            "undo. Affects presentation only - the model is never modified. "
            "Requires the IFC Atlas browser viewer to be open."
        ),
        inputSchema={
            "type": "object",
            "properties": {"element_ids": _ELEMENT_IDS_SCHEMA},
            "required": ["element_ids"],
        },
    ),
    types.Tool(
        name="viewer_highlight_elements",
        description=(
            "Highlight (color-mark) elements in the user's 3D viewer by element "
            "id, keeping the rest of the model visible. Good for pointing the "
            "user at query or validation results. Affects presentation only - "
            "the model is never modified. Requires the IFC Atlas browser viewer "
            "to be open."
        ),
        inputSchema={
            "type": "object",
            "properties": {"element_ids": _ELEMENT_IDS_SCHEMA},
            "required": ["element_ids"],
        },
    ),
    types.Tool(
        name="viewer_show_all",
        description=(
            "Reset visibility in the user's 3D viewer: clear isolation and "
            "highlighting and show every element again. Use after "
            "viewer_isolate_elements or viewer_highlight_elements. Requires "
            "the IFC Atlas browser viewer to be open."
        ),
        inputSchema={"type": "object", "properties": {}},
    ),
    types.Tool(
        name="viewer_set_camera",
        description=(
            "Move the camera in the user's 3D viewer. Pass exactly one of: "
            "'preset' for a standard view (front, back, left, right, top, iso, "
            "or fit to frame the whole model), or 'element_id' to fly the "
            "camera to a specific element. Requires the IFC Atlas browser "
            "viewer to be open."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "preset": {
                    "type": "string",
                    "enum": list(_CAMERA_PRESETS),
                    "description": "Standard camera view to apply.",
                },
                "element_id": {
                    "type": "integer",
                    "description": "Element id to zoom the camera to.",
                },
            },
        },
    ),
    types.Tool(
        name="get_viewer_snapshot",
        description=(
            "Capture what the user currently sees in the 3D viewer as an image. "
            "Requires the IFC Atlas browser viewer to be open. Use this to "
            "verify the result of viewer commands visually, or whenever you "
            "need to see the model from the user's point of view."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "timeout_s": {
                    "type": "number",
                    "minimum": 1,
                    "maximum": 30,
                    "default": 6,
                    "description": (
                        "How long to wait for the viewer to answer, in seconds "
                        "(1-30, default 6)."
                    ),
                },
            },
        },
    ),
    types.Tool(
        name="viewer_clip_to_element",
        description=(
            "Cut the user's 3D view open around one element: fits the section "
            "box to it so surrounding geometry is clipped away and the element "
            "is visible in context. Presentation only - the model is never "
            "modified. Use viewer_set_section_box with enabled=false to undo. "
            "Requires the IFC Atlas browser viewer to be open."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "element_id": {
                    "type": "integer",
                    "description": "Element id to clip the view to.",
                },
            },
            "required": ["element_id"],
        },
    ),
    types.Tool(
        name="viewer_set_section_box",
        description=(
            "Enable or disable the section box in the user's 3D viewer. "
            "Disabling it also undoes viewer_clip_to_element. Presentation "
            "only. Requires the IFC Atlas browser viewer to be open."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "enabled": {"type": "boolean", "description": "Section box on/off."},
            },
            "required": ["enabled"],
        },
    ),
    types.Tool(
        name="viewer_colour_elements",
        description=(
            "Colour groups of elements in the user's 3D viewer, each group with "
            "its own colour and optional legend label - use for heatmaps, "
            "category comparisons, or pointing out multiple result sets at "
            "once. Replaces the previous AI colour layer. Presentation only. "
            "Use viewer_clear_colours to undo. Requires the IFC Atlas browser "
            "viewer to be open."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "entries": {
                    "type": "array",
                    "maxItems": 16,
                    "items": {
                        "type": "object",
                        "properties": {
                            "color": {
                                "type": "string",
                                "description": "CSS hex colour, e.g. #ff8800.",
                            },
                            "element_ids": {
                                "type": "array",
                                "items": {"type": "integer"},
                                "description": "Element ids painted this colour.",
                            },
                            "label": {
                                "type": "string",
                                "description": "Optional legend label for this colour.",
                            },
                        },
                        "required": ["color", "element_ids"],
                    },
                    "description": "Colour buckets (max 16).",
                },
            },
            "required": ["entries"],
        },
    ),
    types.Tool(
        name="viewer_clear_colours",
        description=(
            "Remove every AI-applied colour layer from the user's 3D viewer "
            "(undoes viewer_colour_elements; the user's own colour-by setting "
            "is unaffected). Requires the IFC Atlas browser viewer to be open."
        ),
        inputSchema={"type": "object", "properties": {}},
    ),
]

_VIEWER_TOOL_NAMES: frozenset[str] = frozenset(t.name for t in _viewer_tools)


def _writes_enabled() -> bool:
    """Return True when MCP_ALLOW_WRITES is set to '1', 'true', or 'yes'."""
    return os.environ.get("MCP_ALLOW_WRITES", "0").strip().lower() in {"1", "true", "yes"}


# ---------------------------------------------------------------------------
# MCP Server instance
# ---------------------------------------------------------------------------

server = Server("ifc-viewer")


@server.list_tools()
async def _list_tools() -> list[types.Tool]:
    """Return the list of tools exposed via MCP.

    Always exposed: read_model + validate tier tools, plus the viewer bridge
    tools (presentation only - independent of the write gate).
    MCP_ALLOW_WRITES=1 adds write tools + management tools.
    """
    tools: list[types.Tool] = [
        types.Tool(
            name=t["name"],
            description=t.get("description", ""),
            inputSchema=t.get("parameters", {"type": "object", "properties": {}}),
        )
        for t in _read_tools
    ]

    tools += _viewer_tools

    if _writes_enabled():
        tools += [
            types.Tool(
                name=t["name"],
                description=t.get("description", ""),
                inputSchema=t.get("parameters", {"type": "object", "properties": {}}),
            )
            for t in _write_tools
        ]
        tools += _mgmt_tools

    return tools


@server.call_tool()
async def _call_tool(
    name: str, arguments: dict[str, Any]
) -> list[types.TextContent | types.ImageContent]:
    """Route a tool call to the appropriate handler.

    Viewer bridge tools are always dispatched first (never gated).
    When MCP_ALLOW_WRITES=1: write tools and management tools are dispatched
    before falling through to the read path.
    """
    args = arguments or {}

    # Viewer bridge path (always available - presentation only)
    if name in _VIEWER_TOOL_NAMES:
        return await _handle_viewer_tool(name, args)

    # Write and management tool paths (gated)
    if _writes_enabled():
        if name in _write_tool_names:
            return await _handle_write_tool(name, args)
        if name in _MGMT_TOOL_NAMES:
            return await _handle_mgmt_tool(name, args)

    # Read tool path
    if name not in _tool_names:
        all_known = _all_tool_names | _MGMT_TOOL_NAMES
        if name in all_known:
            msg = (
                f"Tool '{name}' exists but is not permitted via MCP "
                "in the current configuration. "
                "Write tools and management tools require MCP_ALLOW_WRITES=1."
            )
        else:
            msg = f"Unknown tool: {name}"
        return [types.TextContent(type="text", text=json.dumps({"error": msg}))]

    result = await asyncio.get_running_loop().run_in_executor(
        None, execute_tool, name, args
    )
    return [types.TextContent(type="text", text=json.dumps(result, indent=2))]


# ---------------------------------------------------------------------------
# Write-tool handler (gated behind MCP_ALLOW_WRITES=1)
# ---------------------------------------------------------------------------

async def _handle_write_tool(
    name: str, args: dict[str, Any]
) -> list[types.TextContent]:
    """Execute a write tool and publish a pending_edit WS event if a diff was staged."""
    from app.services.model_sync import model_sync_broker
    from app.services.ifc_service import ifc_service
    from app.models.ifc_models import ModelSyncEvent
    from app.services.sandbox_service import sandbox_service

    result: dict[str, Any] = await asyncio.get_running_loop().run_in_executor(
        None, execute_tool, name, args
    )

    # Mirror chat_routes: publish pending_edit so any open DiffPreviewPanel lights up.
    if result.get("action") == "pending_edit":
        edit_id = result.get("edit_id")
        envelope = sandbox_service.get_pending(edit_id) if edit_id else None
        if envelope is not None:
            try:
                contract = ifc_service.get_model_contract()
                await model_sync_broker.publish(
                    ModelSyncEvent(
                        type="pending_edit",
                        model_version=contract["model_version"],
                        model_fingerprint=contract["model_fingerprint"],
                        edit_id=envelope.edit_id,
                        payload=envelope.model_dump(),
                    )
                )
            except Exception:  # noqa: BLE001
                pass  # WS publish is best-effort; the MCP response is authoritative

    return [types.TextContent(type="text", text=json.dumps(result, indent=2))]


# ---------------------------------------------------------------------------
# Management-tool handler (gated behind MCP_ALLOW_WRITES=1)
# ---------------------------------------------------------------------------

async def _handle_mgmt_tool(
    name: str, args: dict[str, Any]
) -> list[types.TextContent]:
    """Handle apply_pending_edit / discard_pending_edit / list_pending_edits."""
    from app.services.model_sync import model_sync_broker
    from app.services.ifc_service import ifc_service
    from app.services.sandbox_service import sandbox_service
    from app.services.patch_generator import patch_generator
    from app.models.ifc_models import ModelSyncEvent

    # ---- list_pending_edits ------------------------------------------------
    if name == "list_pending_edits":
        pending = await asyncio.get_running_loop().run_in_executor(
            None, sandbox_service.list_pending
        )
        result = [e.model_dump() for e in pending]
        return [types.TextContent(type="text", text=json.dumps(result, indent=2))]

    # ---- shared: edit_id required -----------------------------------------
    edit_id: str = args.get("edit_id", "")
    if not edit_id:
        return [types.TextContent(
            type="text",
            text=json.dumps({"error": "edit_id is required"}),
        )]

    # ---- discard_pending_edit ---------------------------------------------
    if name == "discard_pending_edit":
        try:
            envelope = await asyncio.get_running_loop().run_in_executor(
                None, sandbox_service.discard_pending, edit_id
            )
        except ValueError as exc:
            return [types.TextContent(
                type="text", text=json.dumps({"error": str(exc)})
            )]

        # Notify viewers that this edit is gone.
        try:
            contract = ifc_service.get_model_contract()
            await model_sync_broker.publish(
                ModelSyncEvent(
                    type="pending_discarded",
                    model_version=contract["model_version"],
                    model_fingerprint=contract["model_fingerprint"],
                    edit_id=edit_id,
                    payload={"summary": envelope.summary},
                )
            )
        except Exception:  # noqa: BLE001
            pass

        return [types.TextContent(
            type="text", text=json.dumps(envelope.model_dump(), indent=2)
        )]

    # ---- apply_pending_edit -----------------------------------------------
    if name != "apply_pending_edit":
        # Unreachable in normal operation; guards against future mgmt tool additions
        # that forget to add a dispatch branch above.
        return [types.TextContent(
            type="text",
            text=json.dumps({"error": f"Unknown management tool: {name}"}),
        )]

    # apply_pending is synchronous (file swap + IfcOpenShell reload).
    def _apply_sync() -> Any:
        return sandbox_service.apply_pending(
            edit_id=edit_id, ifc_service=ifc_service
        )

    try:
        envelope = await asyncio.get_running_loop().run_in_executor(None, _apply_sync)
    except ValueError as exc:
        return [types.TextContent(
            type="text", text=json.dumps({"error": str(exc)})
        )]

    # Fire WS sync events - mirrors ifc_routes.apply_pending_edit exactly.
    try:
        contract = ifc_service.get_model_contract()
        counts = envelope.counts or {}
        has_geometry = bool(
            counts.get("deleted", 0)
            or counts.get("created", 0)
            or counts.get("retyped", 0)
        )

        await model_sync_broker.publish(
            ModelSyncEvent(
                type="pending_applied",
                model_version=contract["model_version"],
                model_fingerprint=contract["model_fingerprint"],
                edit_id=envelope.edit_id,
                payload={"summary": envelope.summary, "counts": envelope.counts},
            )
        )

        if envelope.changes:
            patch_batch = patch_generator.generate(
                envelope.changes,
                source_sha256=contract["model_fingerprint"],
                actor="mcp_client",
                agent_id=None,
            )
            await model_sync_broker.publish(
                ModelSyncEvent(
                    type="ifc_patch",
                    model_version=contract["model_version"],
                    model_fingerprint=contract["model_fingerprint"],
                    edit_id=envelope.edit_id,
                    payload={"patches": [p.model_dump() for p in patch_batch.patches]},
                )
            )

        if has_geometry:
            await model_sync_broker.publish(
                ModelSyncEvent(
                    type="rebuild_started",
                    model_version=contract["model_version"],
                    model_fingerprint=contract["model_fingerprint"],
                    edit_id=envelope.edit_id,
                    payload={"reason": "mcp write: geometry change"},
                )
            )
        else:
            changed_ids = [c.express_id for c in envelope.changes]
            updated_elements: list[dict[str, Any]] = []
            for cid in changed_ids:
                try:
                    entity = ifc_service.model.by_id(cid)
                except (RuntimeError, AttributeError):
                    continue
                if entity is None or entity.is_a("IfcOpeningElement"):
                    continue
                if not hasattr(entity, "GlobalId"):
                    continue
                updated_elements.append(
                    ifc_service._entity_to_summary(entity).model_dump()  # noqa: SLF001
                )

            await model_sync_broker.publish(
                ModelSyncEvent(
                    type="metadata_patch",
                    model_version=contract["model_version"],
                    model_fingerprint=contract["model_fingerprint"],
                    edit_id=envelope.edit_id,
                    payload={
                        "updated_elements": updated_elements,
                        "removed_element_ids": [
                            c.express_id
                            for c in envelope.changes
                            if c.change == "deleted"
                        ],
                        "touched_storeys": [],
                        "stats_delta": {},
                    },
                )
            )
    except Exception:  # noqa: BLE001
        pass  # WS publish is best-effort; apply itself succeeded

    return [types.TextContent(
        type="text", text=json.dumps(envelope.model_dump(), indent=2)
    )]


# ---------------------------------------------------------------------------
# Viewer-tool handler (always available - never touches the model)
# ---------------------------------------------------------------------------

def _viewer_json(result: Any) -> list[types.TextContent | types.ImageContent]:
    return [types.TextContent(type="text", text=json.dumps(result, indent=2))]


def _delivered(count: int) -> list[types.TextContent | types.ImageContent]:
    """Standard command-tool response: delivery count + hint when no viewer."""
    result: dict[str, Any] = {"delivered_to": count}
    if count == 0:
        result["note"] = "no viewer connected - open IFC Atlas in a browser"
    return _viewer_json(result)


async def _handle_viewer_tool(
    name: str, args: dict[str, Any]
) -> list[types.TextContent | types.ImageContent]:
    """Handle the viewer bridge tools.

    Commands are broadcast as viewer_command events over the model-sync
    WebSocket; the browser viewer executes them against whatever model it
    has loaded. Snapshots additionally wait on the rendezvous in
    viewer_state_service for the browser's image upload.
    """
    from app.services.viewer_state_service import (
        broadcast_viewer_command,
        subscriber_count,
        viewer_state_service,
    )

    # ---- get_viewer_state ---------------------------------------------------
    if name == "get_viewer_state":
        return _viewer_json({
            "connected_clients": subscriber_count(),
            "state": viewer_state_service.state,
        })

    # ---- select / isolate / highlight ----------------------------------------
    if name in _VIEWER_ELEMENT_ACTIONS:
        element_ids = args.get("element_ids")
        if not isinstance(element_ids, list) or any(
            not isinstance(i, int) or isinstance(i, bool) for i in element_ids
        ):
            return _viewer_json({
                "error": f"{name} requires element_ids (an array of integer element ids)"
            })
        count = await broadcast_viewer_command({
            "action": _VIEWER_ELEMENT_ACTIONS[name],
            "element_ids": element_ids,
        })
        return _delivered(count)

    # ---- viewer_show_all ------------------------------------------------------
    if name == "viewer_show_all":
        count = await broadcast_viewer_command({"action": "show_all"})
        return _delivered(count)

    # ---- viewer_clip_to_element ------------------------------------------------
    if name == "viewer_clip_to_element":
        element_id = args.get("element_id")
        if not isinstance(element_id, int) or isinstance(element_id, bool):
            return _viewer_json({"error": "element_id must be an integer element id"})
        count = await broadcast_viewer_command({
            "action": "clip_to_element",
            "element_id": element_id,
        })
        return _delivered(count)

    # ---- viewer_set_section_box --------------------------------------------------
    if name == "viewer_set_section_box":
        enabled = args.get("enabled")
        if not isinstance(enabled, bool):
            return _viewer_json({"error": "enabled must be a boolean"})
        count = await broadcast_viewer_command({
            "action": "set_section_box",
            "enabled": enabled,
        })
        return _delivered(count)

    # ---- viewer_colour_elements ---------------------------------------------------
    if name == "viewer_colour_elements":
        entries = args.get("entries")
        problem = _validate_colour_entries(entries)
        if problem is not None:
            return _viewer_json({"error": problem})
        count = await broadcast_viewer_command({
            "action": "set_colour_layer",
            "layer_id": "ai",
            "entries": entries,
        })
        return _delivered(count)

    # ---- viewer_clear_colours -------------------------------------------------------
    if name == "viewer_clear_colours":
        count = await broadcast_viewer_command({"action": "clear_colour_layers"})
        return _delivered(count)

    # ---- viewer_set_camera ----------------------------------------------------
    if name == "viewer_set_camera":
        preset = args.get("preset")
        element_id = args.get("element_id")
        if (preset is None) == (element_id is None):
            return _viewer_json({
                "error": (
                    "viewer_set_camera requires exactly one of 'preset' or "
                    "'element_id'"
                )
            })
        if preset is not None:
            if preset not in _CAMERA_PRESETS:
                return _viewer_json({
                    "error": (
                        f"Unknown preset {preset!r}; expected one of: "
                        + ", ".join(_CAMERA_PRESETS)
                    )
                })
            payload: dict[str, Any] = {"action": "camera_preset", "preset": preset}
        else:
            if not isinstance(element_id, int) or isinstance(element_id, bool):
                return _viewer_json({
                    "error": "element_id must be an integer element id"
                })
            payload = {"action": "zoom_to_element", "element_id": element_id}
        count = await broadcast_viewer_command(payload)
        return _delivered(count)

    # ---- get_viewer_snapshot ----------------------------------------------------
    if name != "get_viewer_snapshot":
        # Unreachable in normal operation; guards against future viewer tool
        # additions that forget to add a dispatch branch above.
        return _viewer_json({"error": f"Unknown viewer tool: {name}"})

    try:
        timeout = float(args.get("timeout_s", 6.0))
    except (TypeError, ValueError):
        timeout = 6.0
    timeout = min(max(timeout, 1.0), 30.0)

    if subscriber_count() == 0:
        return _viewer_json({"error": "No viewer connected"})

    # Register the rendezvous BEFORE broadcasting so the browser's upload is
    # always claimable, then carry the request id in the command payload.
    request_id = viewer_state_service.create_snapshot_request()
    await broadcast_viewer_command({"action": "snapshot", "request_id": request_id})
    result = await viewer_state_service.await_snapshot(request_id, timeout)
    if result is None:
        return _viewer_json({
            "error": f"Viewer did not answer within {timeout:g}s"
        })
    return [
        types.ImageContent(
            type="image",
            data=result["image_base64"],
            mimeType=result["mime"],
        )
    ]


# ---------------------------------------------------------------------------
# SSE app builder - returns a Starlette sub-app for mounting in FastAPI
# ---------------------------------------------------------------------------

def build_sse_app(token: str | None = None) -> Starlette:
    """Build and return the Starlette SSE sub-app.

    Mount this at '/mcp' in the FastAPI app so the SSE endpoint lives at
    '/mcp/sse' and the message post endpoint at '/mcp/messages/'.

    If *token* is provided, all requests must carry:
        Authorization: Bearer <token>
    Requests without a valid token receive HTTP 401.
    """
    sse = SseServerTransport("/mcp/messages/")

    async def handle_sse(scope: Any, receive: Any, send: Any) -> None:
        async with sse.connect_sse(scope, receive, send) as (read_s, write_s):
            await server.run(
                read_s,
                write_s,
                server.create_initialization_options(),
            )

    def _check_bearer(request: Request) -> bool:
        if not token:
            return True
        auth = request.headers.get("Authorization", "")
        return auth == f"Bearer {token}"

    async def sse_endpoint(request: Request) -> Response:
        if not _check_bearer(request):
            return JSONResponse({"error": "Unauthorized"}, status_code=401)
        await handle_sse(request.scope, request.receive, request._send)  # type: ignore[attr-defined]
        return Response()

    async def messages_endpoint(scope: Any, receive: Any, send: Any) -> None:
        if token:
            req = Request(scope, receive)
            auth = req.headers.get("Authorization", "")
            if auth != f"Bearer {token}":
                resp = JSONResponse({"error": "Unauthorized"}, status_code=401)
                await resp(scope, receive, send)
                return
        await sse.handle_post_message(scope, receive, send)

    routes: list[Any] = [
        Route("/sse", endpoint=sse_endpoint, methods=["GET"]),
        Mount("/messages", app=messages_endpoint),
    ]

    return Starlette(routes=routes)


# ---------------------------------------------------------------------------
# Public helpers - for tests and docs
# ---------------------------------------------------------------------------

def list_exposed_tools() -> list[dict[str, Any]]:
    """Return a copy of the read-tool TOOL_DEFINITIONS entries (always exposed)."""
    return list(_read_tools)


def list_exposed_write_tools() -> list[dict[str, Any]]:
    """Return a copy of the write-tool TOOL_DEFINITIONS entries (write-gated)."""
    return list(_write_tools)


def list_exposed_mgmt_tools() -> list[types.Tool]:
    """Return a copy of the management-tool (MCP-only, write-gated) descriptors."""
    return list(_mgmt_tools)


def list_exposed_viewer_tools() -> list[types.Tool]:
    """Return a copy of the viewer bridge tool descriptors (always exposed)."""
    return list(_viewer_tools)


def list_all_tool_names() -> frozenset[str]:
    """Return the frozenset of all TOOL_DEFINITIONS names (exposed + blocked)."""
    return _all_tool_names
