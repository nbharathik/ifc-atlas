"""FastAPI routes for embodied-carbon estimates.

Carbon builds on the quantity takeoff (grouped by material), so the routes run
the CPU-bound takeoff through ``asyncio.to_thread`` and reuse QTO's model-contract
fingerprint cache. The factor-library routes are plain file IO.
"""

import asyncio
from typing import Any, Optional

from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel

from app.services.carbon_service import (
    carbon_to_csv,
    compute_carbon,
    load_factors,
    sanitize_factors,
    save_factors,
)
from app.services.ifc_service import ifc_service
from app.services.qto_service import GROUP_FIELDS

router = APIRouter(prefix="/api/carbon", tags=["carbon"])

# Extra dimensions allowed after the implicit material grouping.
_EXTRA_FIELDS = tuple(f for f in GROUP_FIELDS if f != "material")


class CarbonRow(BaseModel):
    key: dict[str, str]
    label: str
    material: str
    count: int
    basis: str
    unit: str
    quantity: float
    factor: float
    carbon_kg: float
    factored: bool
    element_ids: Optional[list[int]] = None


class CarbonResponse(BaseModel):
    group_by: list[str]
    rows: list[CarbonRow]
    total_kg: float
    total_tonnes: float
    factored_rows: int
    total_rows: int
    truncated: bool


def _check_loaded() -> None:
    if not ifc_service.is_loaded:
        raise HTTPException(400, "No IFC model loaded")


def _parse_extra(raw: str) -> list[str]:
    fields: list[str] = []
    for part in raw.split(","):
        name = part.strip()
        if not name or name in fields or name == "material":
            continue
        if name not in _EXTRA_FIELDS:
            raise HTTPException(422, f"Unknown group_by value '{name}'. Allowed: {', '.join(_EXTRA_FIELDS)}")
        fields.append(name)
    return fields


def _model_cache_fingerprint() -> str:
    contract = ifc_service.get_model_contract()
    return f"{contract['model_fingerprint']}:{contract['model_version']}:{contract['edit_id']}"


@router.get("/factors")
async def get_factors() -> dict[str, Any]:
    """Return the persisted user factor library (empty means keyword defaults apply)."""
    return {"factors": load_factors()}


@router.put("/factors")
async def put_factors(factors: dict[str, Any] = Body(..., embed=True)) -> dict[str, Any]:
    """Replace the factor library (sanitized). Body: ``{"factors": {...}}``.

    An empty body legitimately clears the library (keyword defaults apply
    again); a non-empty body where no entry survives sanitization is a 422 so
    a malformed payload can never silently wipe the user's factors.
    """
    if factors and not sanitize_factors(factors):
        raise HTTPException(422, "No valid factor entries (need {basis, factor} per material)")
    return {"factors": save_factors(factors)}


@router.get("/estimate", response_model=CarbonResponse, response_model_exclude_none=True)
async def carbon_estimate(
    group_by: str = Query("", description=f"Extra dimensions after material: {', '.join(_EXTRA_FIELDS)}"),
    include_ids: bool = Query(False, description="Attach element_ids per row."),
):
    """Embodied-carbon estimate for the loaded model (grouped by material + extras)."""
    _check_loaded()
    extra = _parse_extra(group_by)
    return await asyncio.to_thread(
        compute_carbon,
        ifc_service.model,
        extra,
        include_ids,
        _model_cache_fingerprint(),
    )


@router.get("/estimate.csv")
async def carbon_estimate_csv(group_by: str = Query("", description="Extra dimensions after material.")):
    """Download the carbon estimate as a CSV attachment."""
    _check_loaded()
    extra = _parse_extra(group_by)
    result = await asyncio.to_thread(
        compute_carbon,
        ifc_service.model,
        extra,
        False,
        _model_cache_fingerprint(),
    )
    suffix = "-".join(["material", *extra])
    return Response(
        content=carbon_to_csv(result),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="carbon-{suffix}.csv"'},
    )
