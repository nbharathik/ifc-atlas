"""Viewer state/command bridge routes.

The browser viewer is the source of truth for presentation state. These
routes let headless clients (CLI, MCP server) read the last state the viewer
reported and drive the viewer by broadcasting ``viewer_command`` events over
the existing model-sync WebSocket (``/api/ifc/sync/ws``).

Commands intentionally do NOT require a loaded backend model: camera presets
and snapshots are meaningful without one, and for element-addressed actions
the frontend executor decides applicability against whatever model it has
loaded. When a model is loaded, the event carries its version/fingerprint so
the executor can detect staleness.
"""

from __future__ import annotations

import base64
import binascii
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from app.services.viewer_state_service import (
    broadcast_viewer_command,
    subscriber_count,
    viewer_state_service,
)

router = APIRouter(prefix="/api/viewer", tags=["viewer"])

ViewerAction = Literal[
    "select",
    "isolate",
    "highlight",
    "show_all",
    "camera_preset",
    "zoom_to_element",
    "snapshot",
    "clear_selection",
    "clip_to_element",
    "set_section_box",
    "set_colour_layer",
    "clear_colour_layers",
]
CameraPreset = Literal["front", "back", "left", "right", "top", "iso", "fit"]


class ViewerCameraState(BaseModel):
    pos: list[float] = Field(min_length=3, max_length=3)
    target: list[float] = Field(min_length=3, max_length=3)


# Bounds on client-supplied payloads. The browser reporter sends small
# payloads by construction; the caps only exist so a misbehaving client
# cannot exhaust backend memory (state and snapshots are held in-process).
MAX_REPORTED_IDS = 10_000
MAX_COMMAND_IDS = 10_000
# Snapshots are <=1024px JPEGs from the viewer (well under 1 MB); 8 MB of
# base64 (~6 MB decoded) is a generous ceiling.
MAX_SNAPSHOT_BASE64_CHARS = 8_000_000


class ViewerModelState(BaseModel):
    file_name: Optional[str] = Field(default=None, max_length=512)
    fingerprint: Optional[str] = Field(default=None, max_length=512)
    element_count: Optional[int] = None


class ViewerStateReport(BaseModel):
    camera: Optional[ViewerCameraState] = None
    selected_id: Optional[int] = None
    selected_ids: list[int] = Field(default_factory=list, max_length=MAX_REPORTED_IDS)
    isolated_count: int = 0
    hidden_count: int = 0
    highlighted_count: int = 0
    model: ViewerModelState = Field(default_factory=ViewerModelState)
    tab_visible: bool = True


class ColourLayerEntry(BaseModel):
    """One colour bucket of a set_colour_layer command."""

    color: str = Field(max_length=32, description="CSS hex colour, e.g. #ff8800")
    element_ids: list[int] = Field(max_length=MAX_COMMAND_IDS)
    label: Optional[str] = Field(default=None, max_length=128)


MAX_COLOUR_ENTRIES = 16


class ViewerCommandRequest(BaseModel):
    action: ViewerAction
    element_ids: Optional[list[int]] = Field(default=None, max_length=MAX_COMMAND_IDS)
    element_id: Optional[int] = None
    preset: Optional[CameraPreset] = None
    request_id: Optional[str] = Field(default=None, max_length=128)
    # set_section_box
    enabled: Optional[bool] = None
    # set_colour_layer (rides the frontend colour-layer store API)
    layer_id: Optional[str] = Field(default=None, max_length=64)
    entries: Optional[list[ColourLayerEntry]] = Field(default=None, max_length=MAX_COLOUR_ENTRIES)


class SnapshotUpload(BaseModel):
    request_id: str = Field(max_length=128)
    image_base64: str = Field(max_length=MAX_SNAPSHOT_BASE64_CHARS)
    mime: Literal["image/jpeg", "image/png"] = "image/jpeg"


@router.post("/state")
async def report_viewer_state(report: ViewerStateReport) -> dict[str, bool]:
    viewer_state_service.report_state(report.model_dump())
    return {"ok": True}


@router.get("/state")
async def get_viewer_state() -> dict[str, Any]:
    return {
        "connected_clients": subscriber_count(),
        "state": viewer_state_service.state,
    }


@router.post("/command")
async def send_viewer_command(command: ViewerCommandRequest) -> dict[str, Any]:
    payload: dict[str, Any] = {"action": command.action}
    if command.action in ("select", "isolate", "highlight"):
        if command.element_ids is None:
            raise HTTPException(422, f"{command.action} requires element_ids")
        payload["element_ids"] = command.element_ids
    elif command.action == "zoom_to_element":
        if command.element_id is None:
            raise HTTPException(422, "zoom_to_element requires element_id")
        payload["element_id"] = command.element_id
    elif command.action == "camera_preset":
        if command.preset is None:
            raise HTTPException(422, "camera_preset requires preset")
        payload["preset"] = command.preset
    elif command.action == "clip_to_element":
        if command.element_id is None:
            raise HTTPException(422, "clip_to_element requires element_id")
        payload["element_id"] = command.element_id
    elif command.action == "set_section_box":
        if command.enabled is None:
            raise HTTPException(422, "set_section_box requires enabled")
        payload["enabled"] = command.enabled
    elif command.action == "set_colour_layer":
        if not command.entries:
            raise HTTPException(422, "set_colour_layer requires entries")
        total_ids = sum(len(e.element_ids) for e in command.entries)
        if total_ids == 0:
            raise HTTPException(422, "set_colour_layer entries contain no element_ids")
        if total_ids > MAX_COMMAND_IDS:
            raise HTTPException(422, f"set_colour_layer exceeds {MAX_COMMAND_IDS} total element_ids")
        payload["layer_id"] = command.layer_id or "ai"
        payload["entries"] = [e.model_dump(exclude_none=True) for e in command.entries]

    response: dict[str, Any] = {}
    if command.action == "snapshot":
        # A generated id is registered with the rendezvous so the browser's
        # later upload is claimable; a caller-provided id passes through
        # untouched because the caller owns its lifecycle (GET /snapshot
        # registers its own before publishing).
        request_id = command.request_id or viewer_state_service.create_snapshot_request()
        payload["request_id"] = request_id
        response["request_id"] = request_id

    response["delivered_to"] = await broadcast_viewer_command(payload)
    return response


@router.post("/state/snapshot")
async def upload_snapshot(upload: SnapshotUpload) -> dict[str, bool]:
    try:
        base64.b64decode(upload.image_base64, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(422, "image_base64 is not valid base64")
    fulfilled = viewer_state_service.fulfill(
        upload.request_id, upload.image_base64, upload.mime
    )
    return {"ok": fulfilled}


@router.get("/snapshot")
async def capture_snapshot(timeout_s: float = Query(6.0)) -> dict[str, str]:
    timeout = min(max(timeout_s, 1.0), 30.0)
    if subscriber_count() == 0:
        raise HTTPException(409, "No viewer connected")
    request_id = viewer_state_service.create_snapshot_request()
    await broadcast_viewer_command({"action": "snapshot", "request_id": request_id})
    result = await viewer_state_service.await_snapshot(request_id, timeout)
    if result is None:
        raise HTTPException(504, "No viewer answered")
    return result
