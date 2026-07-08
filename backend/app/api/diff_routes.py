"""FastAPI routes for the working-vs-original model diff.

Opening the pristine upload and diffing it is CPU-bound, so both routes run
through ``asyncio.to_thread`` and share the diff service's result cache via
the model-contract fingerprint (same pattern as the cost/carbon routes) - the
panel fetches on every mount and the CSV export repeats the same diff.
"""

import asyncio
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from app.services.diff_service import diff_to_csv, working_vs_original
from app.services.ifc_service import ifc_service

router = APIRouter(prefix="/api/diff", tags=["diff"])


class DiffAddedRow(BaseModel):
    express_id: int
    ifc_type: str
    name: Optional[str] = None


class DiffChangedRow(BaseModel):
    express_id: int
    ifc_type: str
    change: str
    name_before: Optional[str] = None
    name_after: Optional[str] = None
    property_changes: list[dict[str, Any]] = []


class DiffResponse(BaseModel):
    added: list[DiffAddedRow]
    removed: list[DiffAddedRow]
    changed: list[DiffChangedRow]
    counts: dict[str, int]
    truncated: bool
    has_working_copy: bool


def _check_loaded() -> None:
    if not ifc_service.is_loaded:
        raise HTTPException(400, "No IFC model loaded")
    if ifc_service.original_path is None:
        raise HTTPException(400, "No original upload on record for this model")


def _has_working_copy() -> bool:
    # noqa: SLF001 - internal path access mirrors sandbox_service usage
    return ifc_service.original_path != ifc_service._file_path


def _model_cache_fingerprint() -> str:
    contract = ifc_service.get_model_contract()
    return f"{contract['model_fingerprint']}:{contract['model_version']}:{contract['edit_id']}"


@router.get("/working-vs-original", response_model=DiffResponse)
async def diff_working_vs_original() -> dict[str, Any]:
    """Structural diff (added / removed / changed) of the working model vs the upload."""
    _check_loaded()
    summary = await asyncio.to_thread(
        working_vs_original,
        ifc_service.model,
        str(ifc_service.original_path),
        fingerprint=_model_cache_fingerprint(),
    )
    summary["has_working_copy"] = _has_working_copy()
    return summary


@router.get("/working-vs-original.csv")
async def diff_working_vs_original_csv():
    """Download the change report as CSV."""
    _check_loaded()
    summary = await asyncio.to_thread(
        working_vs_original,
        ifc_service.model,
        str(ifc_service.original_path),
        fingerprint=_model_cache_fingerprint(),
    )
    return Response(
        content=diff_to_csv(summary),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="changes.csv"'},
    )
