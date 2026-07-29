"""Quantity takeoff (QTO) aggregation over a loaded IfcOpenShell model.

:func:`compute_qto` is pure and synchronous - the route layer wraps it in
``asyncio.to_thread``. Result caching lives in THIS module (module-level dict,
max 8 entries, oldest insertion evicted first): the route derives a fingerprint
string from ``ifc_service.get_model_contract()`` and passes it in. Calls
without a fingerprint bypass the cache entirely, which keeps the function pure
for direct unit-test use. Cached callers must keep ``max_groups`` /
``max_ids_per_group`` at their defaults because the caps are not part of the
cache key.

5D cost / bill-of-quantities layers a priced bill of quantities on top of the
takeoff. The pricing itself is a pure function (:func:`apply_rates`) over a QTO
summary dict, so it unit-tests without a model; :func:`compute_boq` is the
model-aware wrapper that runs the takeoff first. A rate library maps each IFC
class to a measurement *basis* (volume / area / length / count) and a unit
rate. It ships with editable defaults and persists to
``<BASE_DIR>/cost/rates.json`` so a user's rates survive restarts. The defaults
are illustrative placeholders, NOT real-world prices - the UI makes that clear
and every rate is editable.

The embodied-carbon estimate mirrors the cost path: a pure pricing-style
function (:func:`apply_factors`) multiplies quantity takeoff values by emission
factors (kgCO2e per unit), and :func:`compute_carbon` is the model-aware
wrapper that runs the takeoff first. Carbon is material-driven, so the takeoff
is grouped by material; a factor is resolved per material from an editable
library, falling back to keyword matching against common materials. The
default factors are illustrative cradle-to-gate placeholders (loosely based on
the ICE / open EPD ranges), NOT a certified LCA - the UI says so and every
factor is editable. Persisted to ``<BASE_DIR>/carbon/factors.json``.
"""

from __future__ import annotations

import csv
import io
import json
import logging
import os
import tempfile
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any, Optional

import ifcopenshell
import ifcopenshell.util.element as element_util
import ifcopenshell.util.unit as unit_util

from app.core.config import BASE_DIR

logger = logging.getLogger(__name__)

# Supported group_by fields, in canonical order (used for error messages).
GROUP_FIELDS: tuple[str, ...] = (
    "ifc_class",
    "storey",
    "material",
    "type_object",
    "classification",
)

# Quantity name priority lists - the first name found in any IfcElementQuantity
# on the element wins.
_AREA_PRIORITY: tuple[str, ...] = (
    "GrossArea",
    "NetArea",
    "GrossSideArea",
    "NetSideArea",
    "GrossFloorArea",
    "NetFloorArea",
    "GrossSurfaceArea",
    "OuterSurfaceArea",
    "Area",
)
# Net first: NetVolume is the canonical takeoff value (volume minus openings),
# and real-world exports are likelier to write a wrong GrossVolume than a wrong
# NetVolume (observed: Revit IFC2X3 slab GrossVolume off by x1000 vs NetVolume).
_VOLUME_PRIORITY: tuple[str, ...] = ("NetVolume", "GrossVolume", "GrossBodyVolume", "Volume")
_LENGTH_PRIORITY: tuple[str, ...] = ("Length", "Height", "Perimeter")

# IfcProduct subtypes that never contribute to a takeoff. Spatial structure
# elements are excluded separately (except IfcSpace, which carries useful
# area/volume quantities).
_EXCLUDED_PRODUCT_CLASSES: tuple[str, ...] = (
    "IfcOpeningElement",
    "IfcAnnotation",
    "IfcGrid",
    "IfcVirtualElement",
)

_RESULT_CACHE: OrderedDict[tuple[str, tuple[str, ...], bool], dict[str, Any]] = OrderedDict()
_RESULT_CACHE_MAX = 8

# Upper bound on the container-to-storey upward walk, so a malformed model
# with a cyclic spatial graph cannot hang the request.
_MAX_CONTAINER_HOPS = 64


def _nonempty(value: Any) -> Optional[str]:
    """Return ``value`` as a stripped string when it is a non-blank str, else None."""
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _iter_population(model: ifcopenshell.file):
    """Yield every IfcProduct that participates in the takeoff.

    Keeps IfcSpace, drops all other spatial structure elements plus openings,
    annotations, grids, and virtual elements.
    """
    for entity in model.by_type("IfcProduct"):
        if entity.is_a("IfcSpatialStructureElement") and not entity.is_a("IfcSpace"):
            continue
        if any(entity.is_a(cls) for cls in _EXCLUDED_PRODUCT_CLASSES):
            continue
        yield entity


def _resolve_storey_label(entity, memo: dict[int, str]) -> str:
    """Walk the spatial containment upward until an IfcBuildingStorey is found.

    ``memo`` caches the walk per starting container entity id so sibling
    elements in the same container resolve in O(1).
    """
    try:
        node = element_util.get_container(entity)
        if node is None:
            # Spatial elements (e.g. IfcSpace) hang off the tree via
            # IfcRelAggregates, not IfcRelContainedInSpatialStructure.
            node = element_util.get_aggregate(entity)
    except Exception:
        logger.debug("Container lookup failed for entity #%s", entity.id(), exc_info=True)
        return "No storey"
    if node is None:
        return "No storey"
    start_id = node.id()
    cached = memo.get(start_id)
    if cached is not None:
        return cached
    label = "No storey"
    current = node
    for _ in range(_MAX_CONTAINER_HOPS):
        if current is None:
            break
        if current.is_a("IfcBuildingStorey"):
            label = _nonempty(getattr(current, "Name", None)) or "Unnamed storey"
            break
        try:
            current = element_util.get_aggregate(current) or element_util.get_container(current)
        except Exception:
            break
    memo[start_id] = label
    return label


def _material_display_name(material) -> Optional[str]:
    """Resolve a human-readable name across the IfcMaterial* select types."""
    if material is None:
        return None
    try:
        if material.is_a("IfcMaterial"):
            return _nonempty(material.Name)
        if material.is_a("IfcMaterialLayerSetUsage"):
            return _material_display_name(material.ForLayerSet)
        if material.is_a("IfcMaterialLayerSet"):
            name = _nonempty(getattr(material, "LayerSetName", None))
            if name:
                return name
            for layer in material.MaterialLayers or ():
                name = _material_display_name(getattr(layer, "Material", None))
                if name:
                    return name
            return None
        if material.is_a("IfcMaterialProfileSetUsage"):
            return _material_display_name(material.ForProfileSet)
        if material.is_a("IfcMaterialProfileSet"):
            name = _nonempty(getattr(material, "Name", None))
            if name:
                return name
            for profile in material.MaterialProfiles or ():
                name = _material_display_name(getattr(profile, "Material", None))
                if name:
                    return name
            return None
        if material.is_a("IfcMaterialConstituentSet"):
            name = _nonempty(getattr(material, "Name", None))
            if name:
                return name
            for constituent in material.MaterialConstituents or ():
                name = _material_display_name(getattr(constituent, "Material", None))
                if name:
                    return name
            return None
        if material.is_a("IfcMaterialList"):
            for item in material.Materials or ():
                name = _material_display_name(item)
                if name:
                    return name
            return None
    except Exception:
        logger.debug("Material name resolution failed", exc_info=True)
    return None


def _resolve_material_label(entity) -> str:
    try:
        material = element_util.get_material(entity)
    except Exception:
        logger.debug("get_material failed for entity #%s", entity.id(), exc_info=True)
        return "No material"
    return _material_display_name(material) or "No material"


def _resolve_type_label(entity) -> str:
    try:
        type_object = element_util.get_type(entity)
    except Exception:
        logger.debug("get_type failed for entity #%s", entity.id(), exc_info=True)
        return "No type"
    if type_object is None:
        return "No type"
    return _nonempty(getattr(type_object, "Name", None)) or type_object.is_a()


def _resolve_classification_label(entity) -> str:
    """Label from the first IfcRelAssociatesClassification on the element.

    Prefers "System.Identification" (classification system name + reference
    identification), then the reference Name, then either part alone.
    """
    try:
        associations = getattr(entity, "HasAssociations", None) or ()
        for rel in associations:
            if not rel.is_a("IfcRelAssociatesClassification"):
                continue
            ref = rel.RelatingClassification
            if ref is None:
                continue
            if ref.is_a("IfcClassification"):
                return _nonempty(getattr(ref, "Name", None)) or "Unclassified"
            # IFC4 uses Identification; IFC2X3 used ItemReference.
            identification = _nonempty(getattr(ref, "Identification", None)) or _nonempty(
                getattr(ref, "ItemReference", None)
            )
            system = ref
            for _ in range(_MAX_CONTAINER_HOPS):
                if system is None or system.is_a("IfcClassification"):
                    break
                system = getattr(system, "ReferencedSource", None)
            system_name = (
                _nonempty(getattr(system, "Name", None)) if system is not None else None
            )
            if system_name and identification:
                return f"{system_name}.{identification}"
            name = _nonempty(getattr(ref, "Name", None))
            if name:
                return name
            if identification:
                return identification
            if system_name:
                return system_name
    except Exception:
        logger.debug(
            "Classification resolution failed for entity #%s", entity.id(), exc_info=True
        )
    return "Unclassified"


def _resolve_field_label(field: str, entity, storey_memo: dict[int, str]) -> str:
    if field == "ifc_class":
        return entity.is_a()
    if field == "storey":
        return _resolve_storey_label(entity, storey_memo)
    if field == "material":
        return _resolve_material_label(entity)
    if field == "type_object":
        return _resolve_type_label(entity)
    return _resolve_classification_label(entity)


def _extract_quantities(
    entity, scales: tuple[float, float, float]
) -> tuple[Optional[float], Optional[float], Optional[float]]:
    """Return (volume_m3, area_m2, length_m) for one element, or None per axis.

    Values come from IfcElementQuantity sets only (``qtos_only=True``) and are
    converted to SI with the project's DECLARED unit per measure type
    (``scales`` is (volume_scale, area_scale, length_scale)). Deriving area and
    volume scales from the length unit is wrong for the common authoring style
    that pairs millimetre lengths with square/cubic-metre area and volume units
    (e.g. the BasicHouse fixture declares LENGTHUNIT=mm but AREAUNIT=m2 and
    VOLUMEUNIT=m3).
    """
    try:
        quantity_sets = element_util.get_psets(entity, qtos_only=True) or {}
    except Exception:
        logger.debug("get_psets failed for entity #%s", entity.id(), exc_info=True)
        return None, None, None
    merged: dict[str, float] = {}
    for quantity_set in quantity_sets.values():
        if not isinstance(quantity_set, dict):
            continue
        for name, value in quantity_set.items():
            # get_psets injects the owning entity's step id under "id"; bools
            # are ints in Python, so reject them explicitly.
            if name == "id" or isinstance(value, bool) or not isinstance(value, (int, float)):
                continue
            merged.setdefault(name, float(value))

    def pick(priority: tuple[str, ...]) -> Optional[float]:
        for name in priority:
            if name in merged:
                return merged[name]
        return None

    volume = pick(_VOLUME_PRIORITY)
    area = pick(_AREA_PRIORITY)
    length = pick(_LENGTH_PRIORITY)
    volume_scale, area_scale, length_scale = scales
    return (
        volume * volume_scale if volume is not None else None,
        area * area_scale if area is not None else None,
        length * length_scale if length is not None else None,
    )


def _unit_scales(model: ifcopenshell.file) -> tuple[float, float, float]:
    """Return (volume_scale, area_scale, length_scale) to SI from declared units.

    Each measure type falls back to 1.0 (already SI) when the project declares
    no unit for it, matching ifcopenshell's own interpretation.
    """
    scales = []
    for unit_type in ("VOLUMEUNIT", "AREAUNIT", "LENGTHUNIT"):
        try:
            scales.append(float(unit_util.calculate_unit_scale(model, unit_type)))
        except Exception:
            logger.debug(
                "calculate_unit_scale failed for %s; assuming SI", unit_type, exc_info=True
            )
            scales.append(1.0)
    return scales[0], scales[1], scales[2]


def compute_qto(
    model: ifcopenshell.file,
    group_by: list[str],
    include_ids: bool = False,
    max_groups: int = 500,
    max_ids_per_group: int = 5000,
    fingerprint: Optional[str] = None,
) -> dict[str, Any]:
    """Aggregate element counts and base quantities, grouped by ``group_by``.

    Args:
        model: A loaded ifcopenshell file.
        group_by: Ordered, duplicate-free subset of :data:`GROUP_FIELDS`.
        include_ids: When True each group carries ``element_ids`` (express ids),
            capped at ``max_ids_per_group``.
        max_groups: Groups beyond this cap (after sorting by count descending)
            are dropped and ``truncated`` is set.
        max_ids_per_group: Per-group cap for ``element_ids``.
        fingerprint: Opaque model-identity string supplied by the route layer.
            When given, results are memoized in the module cache; when None the
            cache is bypassed.

    Raises:
        ValueError: empty, duplicated, or unknown ``group_by`` entries.
    """
    fields = list(group_by)
    if not fields or len(set(fields)) != len(fields) or any(f not in GROUP_FIELDS for f in fields):
        raise ValueError(
            "group_by must be a non-empty, duplicate-free subset of: " + ", ".join(GROUP_FIELDS)
        )

    cache_key: Optional[tuple[str, tuple[str, ...], bool]] = None
    if fingerprint is not None:
        cache_key = (fingerprint, tuple(fields), bool(include_ids))
        cached = _RESULT_CACHE.get(cache_key)
        if cached is not None:
            return cached

    started = time.perf_counter()
    scales = _unit_scales(model)

    storey_memo: dict[int, str] = {}
    buckets: dict[tuple[str, ...], dict[str, Any]] = {}
    total_count = 0
    overall_sums = {"volume": 0.0, "area": 0.0, "length": 0.0}

    for entity in _iter_population(model):
        total_count += 1
        labels = tuple(_resolve_field_label(field, entity, storey_memo) for field in fields)
        bucket = buckets.get(labels)
        if bucket is None:
            bucket = {
                "count": 0,
                "volume": 0.0,
                "area": 0.0,
                "length": 0.0,
                "cov_volume": 0,
                "cov_area": 0,
                "cov_length": 0,
                "ids": [],
            }
            buckets[labels] = bucket
        bucket["count"] += 1
        if include_ids and len(bucket["ids"]) < max_ids_per_group:
            bucket["ids"].append(entity.id())

        volume, area, length = _extract_quantities(entity, scales)
        if volume is not None:
            bucket["volume"] += volume
            bucket["cov_volume"] += 1
            overall_sums["volume"] += volume
        if area is not None:
            bucket["area"] += area
            bucket["cov_area"] += 1
            overall_sums["area"] += area
        if length is not None:
            bucket["length"] += length
            bucket["cov_length"] += 1
            overall_sums["length"] += length

    # Count descending; label ascending as a deterministic tie-break.
    ordered = sorted(buckets.items(), key=lambda kv: (-kv[1]["count"], " / ".join(kv[0])))
    truncated = len(ordered) > max_groups

    groups: list[dict[str, Any]] = []
    for labels, bucket in ordered[:max_groups]:
        group: dict[str, Any] = {
            "key": dict(zip(fields, labels)),
            "label": " / ".join(labels),
            "count": bucket["count"],
            "quantities": {
                "volume_m3": round(bucket["volume"], 3),
                "area_m2": round(bucket["area"], 3),
                "length_m": round(bucket["length"], 3),
            },
            "coverage": {
                "volume": bucket["cov_volume"],
                "area": bucket["cov_area"],
                "length": bucket["cov_length"],
            },
        }
        if include_ids:
            group["element_ids"] = bucket["ids"]
        groups.append(group)

    result: dict[str, Any] = {
        "group_by": fields,
        "groups": groups,
        "overall": {
            "count": total_count,
            "quantities": {
                "volume_m3": round(overall_sums["volume"], 3),
                "area_m2": round(overall_sums["area"], 3),
                "length_m": round(overall_sums["length"], 3),
            },
        },
        "truncated": truncated,
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 1),
    }

    if cache_key is not None:
        while len(_RESULT_CACHE) >= _RESULT_CACHE_MAX:
            _RESULT_CACHE.popitem(last=False)
        _RESULT_CACHE[cache_key] = result
    return result


def qto_to_csv(result: dict[str, Any]) -> str:
    """Render a :func:`compute_qto` result as CSV.

    Header: one column per group field, then count,volume_m3,area_m2,length_m.
    A quantity cell is left empty when its group coverage is 0 (unknown for
    the whole group), mirroring the "-" the UI renders.
    """
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    fields: list[str] = result["group_by"]
    writer.writerow([*fields, "count", "volume_m3", "area_m2", "length_m"])
    for group in result["groups"]:
        row: list[Any] = [group["key"][field] for field in fields]
        row.append(group["count"])
        quantities = group["quantities"]
        coverage = group["coverage"]
        for quantity_key, coverage_key in (
            ("volume_m3", "volume"),
            ("area_m2", "area"),
            ("length_m", "length"),
        ):
            row.append(quantities[quantity_key] if coverage[coverage_key] > 0 else "")
        writer.writerow(row)
    return buffer.getvalue()


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
