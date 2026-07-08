"""5D cost / bill-of-quantities over the loaded model.

This layers a priced bill of quantities on top of the existing quantity takeoff
(:mod:`app.services.qto_service`). The pricing itself is a pure function
(:func:`apply_rates`) over a QTO summary dict, so it unit-tests without a model;
:func:`compute_boq` is the model-aware wrapper that runs the takeoff first.

A rate library maps each IFC class to a measurement *basis* (volume / area /
length / count) and a unit rate. It ships with editable defaults and persists to
``<BASE_DIR>/cost/rates.json`` so a user's rates survive restarts. The defaults
are illustrative placeholders, NOT real-world prices - the UI makes that clear
and every rate is editable.
"""

from __future__ import annotations

import csv
import io
import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Any, Optional

import ifcopenshell

from app.core.config import BASE_DIR
from app.services.qto_service import compute_qto

logger = logging.getLogger(__name__)


def _atomic_write_json(path: Path, data: Any) -> None:
    """Write JSON via tempfile + ``os.replace`` (same-dir, so the swap is
    atomic) - a crash mid-write can never corrupt or truncate the library."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.stem}-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, sort_keys=True)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise

# Measurement basis -> the field in a QTO group's "quantities" block. "count"
# is special-cased (it reads the group count, not a quantity).
_BASIS_FIELD: dict[str, str] = {
    "volume": "volume_m3",
    "area": "area_m2",
    "length": "length_m",
}
_BASIS_UNIT: dict[str, str] = {
    "volume": "m3",
    "area": "m2",
    "length": "m",
    "count": "nr",
}
VALID_BASES: tuple[str, ...] = ("volume", "area", "length", "count")

# Default rate library: ifc_class -> {basis, rate}. Illustrative placeholders.
DEFAULT_CURRENCY = "USD"
DEFAULT_RATES: dict[str, dict[str, Any]] = {
    "IfcWall": {"basis": "area", "rate": 45.0},
    "IfcWallStandardCase": {"basis": "area", "rate": 45.0},
    "IfcSlab": {"basis": "volume", "rate": 150.0},
    "IfcRoof": {"basis": "area", "rate": 90.0},
    "IfcBeam": {"basis": "length", "rate": 40.0},
    "IfcColumn": {"basis": "length", "rate": 55.0},
    "IfcFooting": {"basis": "volume", "rate": 180.0},
    "IfcPlate": {"basis": "area", "rate": 30.0},
    "IfcMember": {"basis": "length", "rate": 35.0},
    "IfcCovering": {"basis": "area", "rate": 25.0},
    "IfcRailing": {"basis": "length", "rate": 60.0},
    "IfcStair": {"basis": "count", "rate": 1200.0},
    "IfcStairFlight": {"basis": "count", "rate": 600.0},
    "IfcWindow": {"basis": "count", "rate": 350.0},
    "IfcDoor": {"basis": "count", "rate": 250.0},
    "IfcFurnishingElement": {"basis": "count", "rate": 200.0},
    "IfcSpace": {"basis": "area", "rate": 0.0},
}

_RATES_PATH = BASE_DIR / "cost" / "rates.json"


def _coerce_rate_entry(value: Any) -> Optional[dict[str, Any]]:
    """Validate one rate-library entry; return a clean dict or None to skip it."""
    if not isinstance(value, dict):
        return None
    basis = value.get("basis")
    rate = value.get("rate")
    if basis not in VALID_BASES:
        return None
    if isinstance(rate, bool) or not isinstance(rate, (int, float)):
        return None
    return {"basis": basis, "rate": float(rate)}


def sanitize_rates(raw: Any) -> dict[str, dict[str, Any]]:
    """Keep only well-formed ``{ifc_class: {basis, rate}}`` entries."""
    if not isinstance(raw, dict):
        return {}
    clean: dict[str, dict[str, Any]] = {}
    for key, value in raw.items():
        if not isinstance(key, str) or not key.strip():
            continue
        entry = _coerce_rate_entry(value)
        if entry is not None:
            clean[key.strip()] = entry
    return clean


def load_rates() -> dict[str, dict[str, Any]]:
    """Return the persisted rate library, seeded with defaults on first use.

    A corrupt or missing file falls back to (and rewrites) the defaults so the
    feature is always usable.
    """
    try:
        if _RATES_PATH.exists():
            data = json.loads(_RATES_PATH.read_text(encoding="utf-8"))
            clean = sanitize_rates(data)
            if clean:
                return clean
    except Exception:
        logger.warning("Cost rate library unreadable; using defaults", exc_info=True)
    save_rates(dict(DEFAULT_RATES))
    return dict(DEFAULT_RATES)


def save_rates(rates: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Persist a sanitized rate library; return what was actually written."""
    clean = sanitize_rates(rates)
    try:
        _atomic_write_json(_RATES_PATH, clean)
    except Exception:
        logger.warning("Failed to persist cost rate library", exc_info=True)
    return clean


def apply_rates(
    qto_summary: dict[str, Any],
    rates: dict[str, dict[str, Any]],
    currency: str = DEFAULT_CURRENCY,
) -> dict[str, Any]:
    """Price a QTO summary into a bill of quantities. Pure - no model needed.

    The summary's ``group_by`` must start with ``ifc_class`` so each row can be
    matched to a rate. A row is *priced* when the rate's basis has coverage
    (count always has coverage); otherwise its amount is 0 and ``priced`` is
    False so the UI can flag "no quantity for this basis".
    """
    group_by: list[str] = list(qto_summary.get("group_by", []))
    rows: list[dict[str, Any]] = []
    total = 0.0
    priced_total = 0
    for group in qto_summary.get("groups", []):
        key = group.get("key", {})
        ifc_class = key.get("ifc_class") or (group.get("label", "").split(" / ")[0]) or "Unknown"
        entry = rates.get(ifc_class)
        basis = entry["basis"] if entry else "count"
        rate = float(entry["rate"]) if entry else 0.0

        if basis == "count":
            quantity = float(group.get("count", 0))
            has_quantity = True
        else:
            field = _BASIS_FIELD[basis]
            quantity = float(group.get("quantities", {}).get(field, 0.0))
            has_quantity = group.get("coverage", {}).get(basis, 0) > 0

        amount = round(quantity * rate, 2) if has_quantity else 0.0
        priced = bool(entry) and has_quantity and rate > 0
        if priced:
            priced_total += 1
        total += amount
        rows.append(
            {
                "key": key,
                "label": group.get("label", ifc_class),
                "ifc_class": ifc_class,
                "count": group.get("count", 0),
                "basis": basis,
                "unit": _BASIS_UNIT[basis],
                "quantity": round(quantity, 3),
                "rate": rate,
                "amount": amount,
                "priced": priced,
                "element_ids": group.get("element_ids"),
            }
        )

    rows.sort(key=lambda r: (-r["amount"], r["label"]))
    return {
        "currency": currency,
        "group_by": group_by,
        "rows": rows,
        "total": round(total, 2),
        "priced_rows": priced_total,
        "total_rows": len(rows),
        "truncated": bool(qto_summary.get("truncated")),
    }


def compute_boq(
    model: ifcopenshell.file,
    extra_group_by: Optional[list[str]] = None,
    currency: str = DEFAULT_CURRENCY,
    include_ids: bool = False,
    fingerprint: Optional[str] = None,
) -> dict[str, Any]:
    """Run the takeoff (grouped by ifc_class + extras) and price it.

    ``extra_group_by`` adds dimensions after ``ifc_class`` (e.g. ``["storey"]``)
    so the BoQ can break a class down further. ``ifc_class`` is always the first
    grouping field and never duplicated.
    """
    group_by = ["ifc_class"]
    for field in extra_group_by or []:
        if field != "ifc_class" and field not in group_by:
            group_by.append(field)
    summary = compute_qto(
        model, group_by, include_ids=include_ids, fingerprint=fingerprint
    )
    return apply_rates(summary, load_rates(), currency)


def boq_to_csv(boq: dict[str, Any]) -> str:
    """Render a :func:`apply_rates` result as CSV.

    Header: group fields, then count, basis, quantity, unit, rate, amount.
    The currency is in the rate/amount header labels.
    """
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    fields: list[str] = boq["group_by"]
    currency = boq.get("currency", DEFAULT_CURRENCY)
    writer.writerow(
        [*fields, "count", "basis", "quantity", "unit", f"rate_{currency}", f"amount_{currency}"]
    )
    for row in boq["rows"]:
        writer.writerow(
            [
                *[row["key"].get(field, "") for field in fields],
                row["count"],
                row["basis"],
                row["quantity"],
                row["unit"],
                row["rate"],
                row["amount"],
            ]
        )
    writer.writerow([*([""] * len(fields)), "", "", "", "", "TOTAL", boq["total"]])
    return buffer.getvalue()
