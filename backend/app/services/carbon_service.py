"""Embodied-carbon estimate over the loaded model.

Mirrors the 5D cost service: a pure pricing-style function
(:func:`apply_factors`) multiplies quantity takeoff values by emission factors
(kgCO2e per unit), and :func:`compute_carbon` is the model-aware wrapper that
runs the takeoff first. Carbon is material-driven, so the takeoff is grouped by
material; a factor is resolved per material from an editable library, falling
back to keyword matching against common materials.

The default factors are illustrative cradle-to-gate placeholders (loosely based
on the ICE / open EPD ranges), NOT a certified LCA - the UI says so and every
factor is editable. Persisted to ``<BASE_DIR>/carbon/factors.json``.
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

_BASIS_FIELD: dict[str, str] = {"volume": "volume_m3", "area": "area_m2", "length": "length_m"}
_BASIS_UNIT: dict[str, str] = {"volume": "m3", "area": "m2", "length": "m", "count": "nr"}
VALID_BASES: tuple[str, ...] = ("volume", "area", "length", "count")

# Keyword fallback: (lowercase substring, basis, kgCO2e per unit). Order matters
# (first match wins), so put more specific keywords before generic ones.
DEFAULT_KEYWORD_FACTORS: tuple[tuple[str, str, float], ...] = (
    ("reinforced concrete", "volume", 200.0),
    ("concrete", "volume", 120.0),
    ("steel", "volume", 12000.0),
    ("aluminium", "volume", 31000.0),
    ("aluminum", "volume", 31000.0),
    ("timber", "volume", 250.0),
    ("wood", "volume", 250.0),
    ("brick", "volume", 240.0),
    ("masonry", "volume", 240.0),
    ("block", "volume", 180.0),
    ("glass", "area", 45.0),
    ("insulation", "volume", 50.0),
    ("gypsum", "area", 6.0),
    ("plasterboard", "area", 6.0),
    ("plaster", "area", 5.0),
    ("tile", "area", 20.0),
    ("metal", "volume", 9000.0),
)

_FACTORS_PATH = BASE_DIR / "carbon" / "factors.json"


def _coerce_factor_entry(value: Any) -> Optional[dict[str, Any]]:
    if not isinstance(value, dict):
        return None
    basis = value.get("basis")
    factor = value.get("factor")
    if basis not in VALID_BASES:
        return None
    if isinstance(factor, bool) or not isinstance(factor, (int, float)):
        return None
    return {"basis": basis, "factor": float(factor)}


def sanitize_factors(raw: Any) -> dict[str, dict[str, Any]]:
    """Keep only well-formed ``{material: {basis, factor}}`` entries."""
    if not isinstance(raw, dict):
        return {}
    clean: dict[str, dict[str, Any]] = {}
    for key, value in raw.items():
        if not isinstance(key, str) or not key.strip():
            continue
        entry = _coerce_factor_entry(value)
        if entry is not None:
            clean[key.strip()] = entry
    return clean


def load_factors() -> dict[str, dict[str, Any]]:
    """Return the persisted user factor library (may be empty - defaults are keyword-based)."""
    try:
        if _FACTORS_PATH.exists():
            return sanitize_factors(json.loads(_FACTORS_PATH.read_text(encoding="utf-8")))
    except Exception:
        logger.warning("Carbon factor library unreadable; ignoring", exc_info=True)
    return {}


def save_factors(factors: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    clean = sanitize_factors(factors)
    try:
        _atomic_write_json(_FACTORS_PATH, clean)
    except Exception:
        logger.warning("Failed to persist carbon factor library", exc_info=True)
    return clean


def resolve_factor(
    material: str, library: dict[str, dict[str, Any]]
) -> Optional[dict[str, Any]]:
    """Resolve a factor for a material: exact library hit, else keyword fallback."""
    entry = library.get(material)
    if entry is not None:
        return entry
    lower = material.lower()
    for keyword, basis, factor in DEFAULT_KEYWORD_FACTORS:
        if keyword in lower:
            return {"basis": basis, "factor": factor}
    return None


def apply_factors(
    qto_summary: dict[str, Any],
    library: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    """Estimate embodied carbon per group. Pure - no model needed.

    The summary's ``group_by`` must start with ``material``. A row is *factored*
    when a factor resolves and its basis has coverage; otherwise carbon is 0 and
    ``factored`` is False.
    """
    group_by: list[str] = list(qto_summary.get("group_by", []))
    rows: list[dict[str, Any]] = []
    total = 0.0
    factored_total = 0
    for group in qto_summary.get("groups", []):
        key = group.get("key", {})
        material = key.get("material") or (group.get("label", "").split(" / ")[0]) or "Unknown"
        entry = resolve_factor(material, library)
        basis = entry["basis"] if entry else "volume"
        factor = float(entry["factor"]) if entry else 0.0

        if basis == "count":
            quantity = float(group.get("count", 0))
            has_quantity = True
        else:
            quantity = float(group.get("quantities", {}).get(_BASIS_FIELD[basis], 0.0))
            has_quantity = group.get("coverage", {}).get(basis, 0) > 0

        carbon = round(quantity * factor, 2) if has_quantity else 0.0
        factored = bool(entry) and has_quantity and factor != 0.0
        if factored:
            factored_total += 1
        total += carbon
        rows.append(
            {
                "key": key,
                "label": group.get("label", material),
                "material": material,
                "count": group.get("count", 0),
                "basis": basis,
                "unit": _BASIS_UNIT[basis],
                "quantity": round(quantity, 3),
                "factor": factor,
                "carbon_kg": carbon,
                "factored": factored,
                "element_ids": group.get("element_ids"),
            }
        )

    rows.sort(key=lambda r: (-r["carbon_kg"], r["label"]))
    return {
        "group_by": group_by,
        "rows": rows,
        "total_kg": round(total, 2),
        "total_tonnes": round(total / 1000.0, 3),
        "factored_rows": factored_total,
        "total_rows": len(rows),
        "truncated": bool(qto_summary.get("truncated")),
    }


def compute_carbon(
    model: ifcopenshell.file,
    extra_group_by: Optional[list[str]] = None,
    include_ids: bool = False,
    fingerprint: Optional[str] = None,
) -> dict[str, Any]:
    """Run the takeoff grouped by material (+ extras) and estimate carbon."""
    group_by = ["material"]
    for field in extra_group_by or []:
        if field != "material" and field not in group_by:
            group_by.append(field)
    summary = compute_qto(model, group_by, include_ids=include_ids, fingerprint=fingerprint)
    return apply_factors(summary, load_factors())


def carbon_to_csv(result: dict[str, Any]) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    fields: list[str] = result["group_by"]
    writer.writerow([*fields, "count", "basis", "quantity", "unit", "factor_kgCO2e", "carbon_kgCO2e"])
    for row in result["rows"]:
        writer.writerow(
            [
                *[row["key"].get(field, "") for field in fields],
                row["count"],
                row["basis"],
                row["quantity"],
                row["unit"],
                row["factor"],
                row["carbon_kg"],
            ]
        )
    writer.writerow([*([""] * len(fields)), "", "", "", "", "TOTAL", result["total_kg"]])
    return buffer.getvalue()
