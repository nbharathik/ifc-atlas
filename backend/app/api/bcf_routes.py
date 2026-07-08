"""FastAPI routes for BCF 2.1 topic management and .bcfzip import/export.

Topics are stored per model fingerprint, so every route requires a loaded IFC
model. Store CRUD is tiny JSON I/O and runs inline; the archive import/export
paths walk the IfcOpenShell model (express id <-> IfcGuid mapping) and are
CPU-bound, so they run through ``asyncio.to_thread``.
"""

import asyncio
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.services.bcf_service import bcf_service
from app.services.ifc_service import ifc_service

router = APIRouter(prefix="/api/bcf", tags=["bcf"])

TopicType = Literal["Issue", "Comment", "Request", "Clash"]
TopicStatus = Literal["Open", "In Progress", "Resolved", "Closed"]
TopicPriority = Literal["Low", "Normal", "High", "Critical"]


class ViewpointCamera(BaseModel):
    pos: list[float] = Field(..., min_length=3, max_length=3)
    target: list[float] = Field(..., min_length=3, max_length=3)


class ViewpointPayload(BaseModel):
    camera: ViewpointCamera
    isolated_ids: list[int] = Field(default_factory=list)
    hidden_ids: list[int] = Field(default_factory=list)
    selected_id: Optional[int] = None
    highlighted_ids: list[int] = Field(default_factory=list)


class TopicCreateRequest(BaseModel):
    title: str = Field(..., min_length=1)
    description: str = ""
    status: TopicStatus = "Open"
    priority: TopicPriority = "Normal"
    topic_type: TopicType = "Issue"
    assigned_to: str = ""
    labels: list[str] = Field(default_factory=list)
    viewpoint: Optional[ViewpointPayload] = None
    snapshot_data_url: Optional[str] = None


class TopicPatchRequest(BaseModel):
    title: Optional[str] = Field(None, min_length=1)
    description: Optional[str] = None
    status: Optional[TopicStatus] = None
    priority: Optional[TopicPriority] = None
    assigned_to: Optional[str] = None
    labels: Optional[list[str]] = None


class CommentCreateRequest(BaseModel):
    comment: str = Field(..., min_length=1)
    author: Optional[str] = None


def _require_fingerprint() -> str:
    """400 when no model is loaded; otherwise the store key for this model."""
    if not ifc_service.is_loaded:
        raise HTTPException(400, "No IFC model loaded")
    return ifc_service.get_model_contract()["model_fingerprint"] or "default"


@router.get("/topics")
async def list_topics():
    """List every BCF topic stored for the loaded model."""
    fingerprint = _require_fingerprint()
    return {"topics": bcf_service.list_topics(fingerprint)}


@router.post("/topics")
async def create_topic(req: TopicCreateRequest):
    """Create a topic; an optional snapshot arrives as a data:image/jpeg URL."""
    fingerprint = _require_fingerprint()
    try:
        return bcf_service.create_topic(
            fingerprint,
            title=req.title,
            description=req.description,
            status=req.status,
            priority=req.priority,
            topic_type=req.topic_type,
            assigned_to=req.assigned_to,
            labels=req.labels,
            viewpoint=req.viewpoint.model_dump() if req.viewpoint else None,
            snapshot_data_url=req.snapshot_data_url,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.patch("/topics/{guid}")
async def update_topic(guid: str, req: TopicPatchRequest):
    """Partially update a topic's editable fields."""
    fingerprint = _require_fingerprint()
    topic = bcf_service.update_topic(fingerprint, guid, req.model_dump(exclude_unset=True))
    if topic is None:
        raise HTTPException(404, "Topic not found")
    return topic


@router.delete("/topics/{guid}")
async def delete_topic(guid: str):
    """Delete a topic and its stored snapshot."""
    fingerprint = _require_fingerprint()
    if not bcf_service.delete_topic(fingerprint, guid):
        raise HTTPException(404, "Topic not found")
    return {"deleted": True}


@router.post("/topics/{guid}/comments")
async def add_comment(guid: str, req: CommentCreateRequest):
    """Append a comment; returns the full topic with the new comment."""
    fingerprint = _require_fingerprint()
    topic = bcf_service.add_comment(fingerprint, guid, req.comment, author=req.author)
    if topic is None:
        raise HTTPException(404, "Topic not found")
    return topic


@router.get("/topics/{guid}/snapshot")
async def get_topic_snapshot(guid: str):
    """Serve the topic's snapshot JPEG; 404 when the topic has none."""
    fingerprint = _require_fingerprint()
    if bcf_service.get_topic(fingerprint, guid) is None:
        raise HTTPException(404, "Topic not found")
    data = bcf_service.get_snapshot(guid)
    if data is None:
        raise HTTPException(404, "Topic has no snapshot")
    return Response(content=data, media_type="image/jpeg")


@router.get("/export")
async def export_bcf():
    """Download every topic for the loaded model as a BCF 2.1 .bcfzip."""
    fingerprint = _require_fingerprint()
    model = ifc_service.model
    data = await asyncio.to_thread(bcf_service.export_bcfzip, fingerprint, model)
    name = (
        Path(ifc_service.original_filename).stem
        if ifc_service.original_filename
        else "model"
    )
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{name}.bcfzip"'},
    )


@router.post("/import")
async def import_bcf(file: UploadFile = File(...)):
    """Import a .bcfzip, merging topics by guid (incoming wins)."""
    fingerprint = _require_fingerprint()
    if not file.filename or not file.filename.lower().endswith(".bcfzip"):
        raise HTTPException(400, "Only .bcfzip files are accepted")
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "Empty file body")
    model = ifc_service.model
    try:
        return await asyncio.to_thread(bcf_service.import_bcfzip, fingerprint, model, raw)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
