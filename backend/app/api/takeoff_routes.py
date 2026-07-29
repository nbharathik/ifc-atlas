"""FastAPI routes for model takeoff and handover: QTO, cost, carbon, COBie.

Quantity takeoff (QTO) summaries and CSV export: the aggregation itself
(``compute_qto``) is CPU-bound IfcOpenShell work, so the routes run it through
``asyncio.to_thread``. Result caching happens inside
``app.services.qto_service``, keyed by a fingerprint string this module
derives from ``ifc_service.get_model_contract()`` (fingerprint + version +
edit id, so an in-place edit invalidates cached takeoffs).

5D cost / bill-of-quantities: pricing builds on the quantity takeoff, so the
BoQ routes run the CPU-bound takeoff through ``asyncio.to_thread`` and reuse
the same model-contract fingerprint for QTO's result cache. The rate-library
routes are plain file IO.

Embodied-carbon estimates: carbon builds on the quantity takeoff (grouped by
material) and reuses QTO's model-contract fingerprint cache. The
factor-library routes are plain file IO.

COBie-style data handover (summary + CSV export): extraction is CPU-bound
IfcOpenShell work, so both routes run it through ``asyncio.to_thread``.

Each domain keeps its own ``APIRouter`` (identical prefixes/tags/paths as the
former per-domain modules); ``app.main`` includes all four.
"""

import asyncio
from typing import Any, Optional

from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel

from app.services.cobie_service import extract_csv, extract_summary
from app.services.ifc_service import ifc_service
from app.services.qto_service import (
    DEFAULT_CURRENCY,
    GROUP_FIELDS,
    boq_to_csv,
    carbon_to_csv,
    compute_boq,
    compute_carbon,
    compute_qto,
    load_factors,
    load_rates,
    qto_to_csv,
    sanitize_factors,
    sanitize_rates,
    save_factors,
    save_rates,
)

qto_router = APIRouter(prefix="/api/qto", tags=["qto"])
cost_router = APIRouter(prefix="/api/cost", tags=["cost"])
carbon_router = APIRouter(prefix="/api/carbon", tags=["carbon"])
cobie_router = APIRouter(prefix="/api/cobie", tags=["cobie"])

_GROUP_BY_DESCRIPTION = (
    "Comma-separated grouping fields, order preserved. Allowed values: "
    + ", ".join(GROUP_FIELDS)
)

# Extra grouping dimensions allowed after the implicit ifc_class (which is
# always first so rows map to a rate). ifc_class itself is not selectable here.
_COST_EXTRA_FIELDS = tuple(f for f in GROUP_FIELDS if f != "ifc_class")

# Extra dimensions allowed after the implicit material grouping.
_CARBON_EXTRA_FIELDS = tuple(f for f in GROUP_FIELDS if f != "material")


def _check_loaded() -> None:
    if not ifc_service.is_loaded:
        raise HTTPException(400, "No IFC model loaded")


def _model_cache_fingerprint() -> str:
    contract = ifc_service.get_model_contract()
    return (
        f"{contract['model_fingerprint']}:{contract['model_version']}:{contract['edit_id']}"
    )


# ---------------------------------------------------------------------------
# QTO
# ---------------------------------------------------------------------------


class QtoGroup(BaseModel):
    key: dict[str, str]
    label: str
    count: int
    quantities: dict[str, float]
    coverage: dict[str, int]
    element_ids: Optional[list[int]] = None


class QtoOverall(BaseModel):
    count: int
    quantities: dict[str, float]


class QtoSummaryResponse(BaseModel):
    group_by: list[str]
    groups: list[QtoGroup]
    overall: QtoOverall
    truncated: bool
    elapsed_ms: float


def _parse_group_by(raw: str) -> list[str]:
    """Split, trim, and de-duplicate the group_by query, preserving order.

    Raises 422 on any unknown value or when nothing usable remains.
    """
    fields: list[str] = []
    for part in raw.split(","):
        name = part.strip()
        if not name or name in fields:
            continue
        if name not in GROUP_FIELDS:
            raise HTTPException(
                422,
                f"Unknown group_by value '{name}'. Allowed values: {', '.join(GROUP_FIELDS)}",
            )
        fields.append(name)
    if not fields:
        raise HTTPException(
            422, f"group_by must include at least one of: {', '.join(GROUP_FIELDS)}"
        )
    return fields


@qto_router.get("/summary", response_model=QtoSummaryResponse, response_model_exclude_none=True)
async def qto_summary(
    group_by: str = Query(..., description=_GROUP_BY_DESCRIPTION),
    include_ids: bool = Query(
        False,
        description="Attach element_ids (express ids, capped at 5000) to every group.",
    ),
):
    """Grouped element counts and base quantities for the loaded model.

    Groups are sorted by count descending and capped at 500 (``truncated``
    flags the cap). ``coverage`` reports how many elements in each group
    contributed a value to each quantity; 0 means the quantity is unknown for
    the whole group.
    """
    _check_loaded()
    fields = _parse_group_by(group_by)
    return await asyncio.to_thread(
        compute_qto,
        ifc_service.model,
        fields,
        include_ids,
        fingerprint=_model_cache_fingerprint(),
    )


@qto_router.get("/export.csv")
async def qto_export_csv(
    group_by: str = Query(..., description=_GROUP_BY_DESCRIPTION),
):
    """Download the QTO summary as a CSV attachment.

    Header: one column per group field, then count,volume_m3,area_m2,length_m.
    """
    _check_loaded()
    fields = _parse_group_by(group_by)
    result = await asyncio.to_thread(
        compute_qto,
        ifc_service.model,
        fields,
        False,
        fingerprint=_model_cache_fingerprint(),
    )
    csv_text = qto_to_csv(result)
    filename = "qto-" + "-".join(fields) + ".csv"
    return Response(
        content=csv_text,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ---------------------------------------------------------------------------
# 5D cost / bill-of-quantities
# ---------------------------------------------------------------------------


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


def _parse_cost_extra(raw: str) -> list[str]:
    """Parse the optional extra group_by (after ifc_class). Empty is allowed."""
    fields: list[str] = []
    for part in raw.split(","):
        name = part.strip()
        if not name or name in fields:
            continue
        if name == "ifc_class":
            continue  # always implied first; ignore if passed
        if name not in _COST_EXTRA_FIELDS:
            raise HTTPException(
                422,
                f"Unknown group_by value '{name}'. Allowed: {', '.join(_COST_EXTRA_FIELDS)}",
            )
        fields.append(name)
    return fields


@cost_router.get("/rates")
async def get_rates() -> dict[str, Any]:
    """Return the editable rate library and the default currency."""
    return {"currency": DEFAULT_CURRENCY, "rates": load_rates()}


@cost_router.put("/rates")
async def put_rates(rates: dict[str, Any] = Body(..., embed=True)) -> dict[str, Any]:
    """Replace the rate library (sanitized). Body: ``{"rates": {...}}``."""
    if not sanitize_rates(rates):
        raise HTTPException(422, "No valid rate entries (need {basis, rate} per ifc_class)")
    return {"currency": DEFAULT_CURRENCY, "rates": save_rates(rates)}


@cost_router.get("/boq", response_model=CostBoqResponse, response_model_exclude_none=True)
async def cost_boq(
    group_by: str = Query("", description=f"Extra dimensions after ifc_class: {', '.join(_COST_EXTRA_FIELDS)}"),
    include_ids: bool = Query(False, description="Attach element_ids per row."),
):
    """Priced bill of quantities for the loaded model (grouped by ifc_class + extras)."""
    _check_loaded()
    extra = _parse_cost_extra(group_by)
    return await asyncio.to_thread(
        compute_boq,
        ifc_service.model,
        extra,
        DEFAULT_CURRENCY,
        include_ids,
        _model_cache_fingerprint(),
    )


@cost_router.get("/boq.csv")
async def cost_boq_csv(
    group_by: str = Query("", description="Extra dimensions after ifc_class."),
):
    """Download the priced BoQ as a CSV attachment."""
    _check_loaded()
    extra = _parse_cost_extra(group_by)
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


# ---------------------------------------------------------------------------
# Embodied carbon
# ---------------------------------------------------------------------------


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


def _parse_carbon_extra(raw: str) -> list[str]:
    fields: list[str] = []
    for part in raw.split(","):
        name = part.strip()
        if not name or name in fields or name == "material":
            continue
        if name not in _CARBON_EXTRA_FIELDS:
            raise HTTPException(422, f"Unknown group_by value '{name}'. Allowed: {', '.join(_CARBON_EXTRA_FIELDS)}")
        fields.append(name)
    return fields


@carbon_router.get("/factors")
async def get_factors() -> dict[str, Any]:
    """Return the persisted user factor library (empty means keyword defaults apply)."""
    return {"factors": load_factors()}


@carbon_router.put("/factors")
async def put_factors(factors: dict[str, Any] = Body(..., embed=True)) -> dict[str, Any]:
    """Replace the factor library (sanitized). Body: ``{"factors": {...}}``.

    An empty body legitimately clears the library (keyword defaults apply
    again); a non-empty body where no entry survives sanitization is a 422 so
    a malformed payload can never silently wipe the user's factors.
    """
    if factors and not sanitize_factors(factors):
        raise HTTPException(422, "No valid factor entries (need {basis, factor} per material)")
    return {"factors": save_factors(factors)}


@carbon_router.get("/estimate", response_model=CarbonResponse, response_model_exclude_none=True)
async def carbon_estimate(
    group_by: str = Query("", description=f"Extra dimensions after material: {', '.join(_CARBON_EXTRA_FIELDS)}"),
    include_ids: bool = Query(False, description="Attach element_ids per row."),
):
    """Embodied-carbon estimate for the loaded model (grouped by material + extras)."""
    _check_loaded()
    extra = _parse_carbon_extra(group_by)
    return await asyncio.to_thread(
        compute_carbon,
        ifc_service.model,
        extra,
        include_ids,
        _model_cache_fingerprint(),
    )


@carbon_router.get("/estimate.csv")
async def carbon_estimate_csv(group_by: str = Query("", description="Extra dimensions after material.")):
    """Download the carbon estimate as a CSV attachment."""
    _check_loaded()
    extra = _parse_carbon_extra(group_by)
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


# ---------------------------------------------------------------------------
# COBie handover
# ---------------------------------------------------------------------------


class CobieCompletenessItem(BaseModel):
    label: str
    present: int
    total: int
    pct: float


class CobieSummaryResponse(BaseModel):
    counts: dict[str, int]
    completeness: list[CobieCompletenessItem]


@cobie_router.get("/summary", response_model=CobieSummaryResponse)
async def cobie_summary() -> dict[str, Any]:
    """Sheet counts + handover completeness for the loaded model."""
    _check_loaded()
    return await asyncio.to_thread(extract_summary, ifc_service.model)


@cobie_router.get("/export.csv")
async def cobie_export_csv():
    """Download the COBie-lite sheets as a single multi-section CSV."""
    _check_loaded()
    csv_text = await asyncio.to_thread(extract_csv, ifc_service.model)
    return Response(
        content=csv_text,
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="cobie.csv"'},
    )
