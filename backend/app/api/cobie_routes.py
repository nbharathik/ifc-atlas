"""FastAPI routes for COBie-style data handover (summary + CSV export).

Extraction is CPU-bound IfcOpenShell work, so both routes run it through
``asyncio.to_thread``.
"""

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from app.services.cobie_service import extract_csv, extract_summary
from app.services.ifc_service import ifc_service

router = APIRouter(prefix="/api/cobie", tags=["cobie"])


class CobieCompletenessItem(BaseModel):
    label: str
    present: int
    total: int
    pct: float


class CobieSummaryResponse(BaseModel):
    counts: dict[str, int]
    completeness: list[CobieCompletenessItem]


def _check_loaded() -> None:
    if not ifc_service.is_loaded:
        raise HTTPException(400, "No IFC model loaded")


@router.get("/summary", response_model=CobieSummaryResponse)
async def cobie_summary() -> dict[str, Any]:
    """Sheet counts + handover completeness for the loaded model."""
    _check_loaded()
    return await asyncio.to_thread(extract_summary, ifc_service.model)


@router.get("/export.csv")
async def cobie_export_csv():
    """Download the COBie-lite sheets as a single multi-section CSV."""
    _check_loaded()
    csv_text = await asyncio.to_thread(extract_csv, ifc_service.model)
    return Response(
        content=csv_text,
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="cobie.csv"'},
    )
