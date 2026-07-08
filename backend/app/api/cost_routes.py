"""FastAPI routes for 5D cost / bill-of-quantities.

Pricing builds on the quantity takeoff, so the BoQ routes run the CPU-bound
takeoff through ``asyncio.to_thread`` and reuse the same model-contract
fingerprint for QTO's result cache. The rate-library routes are plain file IO.
"""

import asyncio
from typing import Any, Optional

from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel

from app.services.cost_service import (
    DEFAULT_CURRENCY,
    boq_to_csv,
    compute_boq,
    load_rates,
    sanitize_rates,
    save_rates,
)
from app.services.ifc_service import ifc_service
from app.services.qto_service import GROUP_FIELDS

router = APIRouter(prefix="/api/cost", tags=["cost"])

# Extra grouping dimensions allowed after the implicit ifc_class (which is
# always first so rows map to a rate). ifc_class itself is not selectable here.
_EXTRA_FIELDS = tuple(f for f in GROUP_FIELDS if f != "ifc_class")


class RateEntry(BaseModel):
    basis: str
    rate: float


class CostBoqRow(BaseModel):
    key: dict[str, str]
    label: str
    ifc_class: str
    count: int
    basis: str
    unit: str
    quantity: float
    rate: float
    amount: float
    priced: bool
    element_ids: Optional[list[int]] = None


class CostBoqResponse(BaseModel):
    currency: str
    group_by: list[str]
    rows: list[CostBoqRow]
    total: float
    priced_rows: int
    total_rows: int
    truncated: bool


def _check_loaded() -> None:
    if not ifc_service.is_loaded:
        raise HTTPException(400, "No IFC model loaded")


def _parse_extra(raw: str) -> list[str]:
    """Parse the optional extra group_by (after ifc_class). Empty is allowed."""
    fields: list[str] = []
    for part in raw.split(","):
        name = part.strip()
        if not name or name in fields:
            continue
        if name == "ifc_class":
            continue  # always implied first; ignore if passed
        if name not in _EXTRA_FIELDS:
            raise HTTPException(
                422,
                f"Unknown group_by value '{name}'. Allowed: {', '.join(_EXTRA_FIELDS)}",
            )
        fields.append(name)
    return fields


def _model_cache_fingerprint() -> str:
    contract = ifc_service.get_model_contract()
    return f"{contract['model_fingerprint']}:{contract['model_version']}:{contract['edit_id']}"


@router.get("/rates")
async def get_rates() -> dict[str, Any]:
    """Return the editable rate library and the default currency."""
    return {"currency": DEFAULT_CURRENCY, "rates": load_rates()}


@router.put("/rates")
async def put_rates(rates: dict[str, Any] = Body(..., embed=True)) -> dict[str, Any]:
    """Replace the rate library (sanitized). Body: ``{"rates": {...}}``."""
    if not sanitize_rates(rates):
        raise HTTPException(422, "No valid rate entries (need {basis, rate} per ifc_class)")
    return {"currency": DEFAULT_CURRENCY, "rates": save_rates(rates)}


@router.get("/boq", response_model=CostBoqResponse, response_model_exclude_none=True)
async def cost_boq(
    group_by: str = Query("", description=f"Extra dimensions after ifc_class: {', '.join(_EXTRA_FIELDS)}"),
    include_ids: bool = Query(False, description="Attach element_ids per row."),
):
    """Priced bill of quantities for the loaded model (grouped by ifc_class + extras)."""
    _check_loaded()
    extra = _parse_extra(group_by)
    return await asyncio.to_thread(
        compute_boq,
        ifc_service.model,
        extra,
        DEFAULT_CURRENCY,
        include_ids,
        _model_cache_fingerprint(),
    )


@router.get("/boq.csv")
async def cost_boq_csv(
    group_by: str = Query("", description="Extra dimensions after ifc_class."),
):
    """Download the priced BoQ as a CSV attachment."""
    _check_loaded()
    extra = _parse_extra(group_by)
    boq = await asyncio.to_thread(
        compute_boq,
        ifc_service.model,
        extra,
        DEFAULT_CURRENCY,
        False,
        _model_cache_fingerprint(),
    )
    csv_text = boq_to_csv(boq)
    suffix = "-".join(["ifc_class", *extra])
    return Response(
        content=csv_text,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="boq-{suffix}.csv"'},
    )
