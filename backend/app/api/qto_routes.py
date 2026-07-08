"""FastAPI routes for quantity takeoff (QTO) summaries and CSV export.

The aggregation itself (``compute_qto``) is CPU-bound IfcOpenShell work, so
both routes run it through ``asyncio.to_thread``. Result caching happens
inside ``app.services.qto_service``, keyed by a fingerprint string this module
derives from ``ifc_service.get_model_contract()`` (fingerprint + version +
edit id, so an in-place edit invalidates cached takeoffs).
"""

import asyncio
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel

from app.services.ifc_service import ifc_service
from app.services.qto_service import GROUP_FIELDS, compute_qto, qto_to_csv

router = APIRouter(prefix="/api/qto", tags=["qto"])

_GROUP_BY_DESCRIPTION = (
    "Comma-separated grouping fields, order preserved. Allowed values: "
    + ", ".join(GROUP_FIELDS)
)


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


def _check_loaded() -> None:
    if not ifc_service.is_loaded:
        raise HTTPException(400, "No IFC model loaded")


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


def _model_cache_fingerprint() -> str:
    contract = ifc_service.get_model_contract()
    return (
        f"{contract['model_fingerprint']}:{contract['model_version']}:{contract['edit_id']}"
    )


@router.get("/summary", response_model=QtoSummaryResponse, response_model_exclude_none=True)
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


@router.get("/export.csv")
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
