"""Quantity takeoff (QTO) aggregation over a loaded IfcOpenShell model.

:func:`compute_qto` is pure and synchronous - the route layer wraps it in
``asyncio.to_thread``. Result caching lives in THIS module (module-level dict,
max 8 entries, oldest insertion evicted first): the route derives a fingerprint
string from ``ifc_service.get_model_contract()`` and passes it in. Calls
without a fingerprint bypass the cache entirely, which keeps the function pure
for direct unit-test use. Cached callers must keep ``max_groups`` /
``max_ids_per_group`` at their defaults because the caps are not part of the
cache key.
"""

from __future__ import annotations

import csv
import io
import logging
import time
from collections import OrderedDict
from typing import Any, Optional

import ifcopenshell
import ifcopenshell.util.element as element_util
import ifcopenshell.util.unit as unit_util

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
