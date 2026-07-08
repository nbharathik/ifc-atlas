"""IDS library + validation routes (/api/ids).

The validation engine lives in ``app.services.ids_service`` and is reused
as-is; these routes add persistent IDS document storage plus a last-run cache
so the frontend can re-open the most recent report (and download its CSV)
without re-running validation.

The legacy one-shot route ``POST /api/ifc/ids-validate`` is unchanged.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from app.services.ids_library_service import ids_library_service, utc_now_iso
from app.services.ids_service import extract_failing_ids, validate_ids, validate_ids_to_csv
from app.services.ifc_service import ifc_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/ids", tags=["ids"])

# Most recent validation run. Serves GET /last and GET /last.csv; only valid
# while the loaded model's fingerprint still matches the one captured at
# validate time, so a model swap silently invalidates it.
_last_run: Optional[dict[str, Any]] = None


class IdsLibraryEntry(BaseModel):
    id: str
    filename: str
    title: str
    description: str
    specifications_count: int
    size_bytes: int
    added_at: str


class IdsLibraryListResponse(BaseModel):
    entries: list[IdsLibraryEntry]


class IdsDeleteResponse(BaseModel):
    deleted: bool


def _cache_is_current() -> bool:
    if _last_run is None or not ifc_service.is_loaded:
        return False
    contract = ifc_service.get_model_contract()
    return _last_run["model_fingerprint"] == contract["model_fingerprint"]


@router.get("/library", response_model=IdsLibraryListResponse)
async def list_ids_library():
    """List all stored IDS documents with their header metadata."""
    return {"entries": ids_library_service.list_entries()}


@router.post("/library", response_model=IdsLibraryEntry)
async def add_ids_to_library(file: UploadFile = File(...)):
    """Store an uploaded .ids/.xml document in the library.

    Identical content dedupes to the existing entry (same id). Returns 422
    when the file does not parse as IDS XML.
    """
    if Path(file.filename or "").suffix.lower() not in {".ids", ".xml"}:
        raise HTTPException(400, "Only .ids or .xml files are accepted")
    raw = await file.read()
    try:
        # XML parse + disk write run off the event loop.
        entry = await asyncio.to_thread(ids_library_service.add_entry, file.filename or "", raw)
    except ValueError as exc:
        raise HTTPException(422, "Not a valid IDS file") from exc
    return entry


@router.delete("/library/{entry_id}", response_model=IdsDeleteResponse)
async def delete_ids_from_library(entry_id: str):
    """Delete a stored IDS document. 404 when the id is unknown."""
    try:
        ids_library_service.delete_entry(entry_id)
    except KeyError as exc:
        raise HTTPException(404, "IDS entry not found") from exc
    return {"deleted": True}


@router.post("/library/{entry_id}/validate")
async def validate_with_library_entry(
    entry_id: str,
    limit_per_spec: int = Query(25, ge=1, description="Max failing elements returned per spec."),
):
    """Validate the loaded model against a stored IDS document.

    Returns the full ``ids_service.validate_ids`` report enriched with
    ``ids_id``, ``ran_at`` and the deduplicated ``all_failing_ids`` (Express
    IDs usable with viewer selection). The run is cached for GET /last and
    GET /last.csv.
    """
    global _last_run
    if not ifc_service.is_loaded:
        raise HTTPException(400, "No IFC model loaded")
    try:
        ids_xml = ids_library_service.get_xml(entry_id)
    except KeyError as exc:
        raise HTTPException(404, "IDS entry not found") from exc

    model = ifc_service.model

    def _run() -> tuple[dict[str, Any], str]:
        # The CSV is built in the same worker pass so GET /last.csv never has
        # to re-run validation later.
        report = validate_ids(model, ids_xml, limit_per_spec=limit_per_spec)
        csv_text = validate_ids_to_csv(model, ids_xml)
        return report, csv_text

    try:
        report, csv_text = await asyncio.to_thread(_run)
    except ValueError as exc:
        raise HTTPException(422, "Not a valid IDS file") from exc

    ran_at = utc_now_iso()
    enriched = {**report, "all_failing_ids": extract_failing_ids(report)}
    _last_run = {
        "model_fingerprint": ifc_service.get_model_contract()["model_fingerprint"],
        "ids_id": entry_id,
        "ran_at": ran_at,
        "report": enriched,
        "csv": csv_text,
    }
    return {"ids_id": entry_id, "ran_at": ran_at, **enriched}


@router.get("/last")
async def get_last_ids_run():
    """Return the cached last validation run for the currently loaded model.

    ``available`` is false when nothing has run yet or the cached run belongs
    to a different model fingerprint.
    """
    if not _cache_is_current():
        return {"available": False, "ids_id": None, "ran_at": None, "report": None}
    assert _last_run is not None  # guarded by _cache_is_current
    return {
        "available": True,
        "ids_id": _last_run["ids_id"],
        "ran_at": _last_run["ran_at"],
        "report": _last_run["report"],
    }


@router.get("/last.csv")
async def get_last_ids_run_csv():
    """Download the cached last run's failures as CSV. 404 when no valid cache."""
    if not _cache_is_current():
        raise HTTPException(404, "No cached IDS run for the current model")
    assert _last_run is not None  # guarded by _cache_is_current
    return Response(
        content=_last_run["csv"],
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="ids_last_run.csv"'},
    )
