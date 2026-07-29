"""COBie-style data handover export over the loaded model.

A pragmatic, dependency-free COBie-lite: it pulls the handover-relevant sheets a
viewer can reliably produce - Facility, Floor, Space, Type, Component - straight
from IfcOpenShell, plus a completeness summary (how much asset data is actually
present). It deliberately does NOT depend on a specific ifccobie version; the
extraction is direct and defensive.

Following the cost/carbon pattern, the model-aware extractor (:func:`extract_cobie`)
is exercised live, while the summary and CSV serializers (:func:`summarize_cobie`,
:func:`cobie_to_csv`) are pure and unit-tested.
"""

from __future__ import annotations

import csv
import io
import logging
from typing import Any

import ifcopenshell
import ifcopenshell.util.element as element_util

logger = logging.getLogger(__name__)

# COBie-lite sheets we emit, in order, with their columns.
SHEETS: dict[str, tuple[str, ...]] = {
    "Facility": ("name", "project", "site", "building"),
    "Floor": ("name", "elevation", "global_id"),
    "Space": ("name", "floor", "category", "area", "global_id"),
    "Type": ("name", "ifc_class", "category", "manufacturer", "model", "global_id"),
    "Component": ("name", "type", "space", "ifc_class", "global_id"),
}

_SPATIAL_SKIP = ("IfcSpatialStructureElement", "IfcOpeningElement", "IfcGrid", "IfcAnnotation")


def _s(value: Any) -> str:
    """Stringify an attribute, mapping None/blank to ''."""
    if value is None:
        return ""
    text = str(value).strip()
    return text


def _pset_value(entity, pset: str, prop: str) -> str:
    try:
        psets = element_util.get_psets(entity) or {}
        return _s(psets.get(pset, {}).get(prop))
    except Exception:
        return ""


def _type_handover(type_obj) -> tuple[str, str]:
    """(manufacturer, model) from Pset_ManufacturerTypeInformation if present."""
    if type_obj is None:
        return "", ""
    manufacturer = _pset_value(type_obj, "Pset_ManufacturerTypeInformation", "Manufacturer")
    model = _pset_value(type_obj, "Pset_ManufacturerTypeInformation", "ModelLabel") or _pset_value(
        type_obj, "Pset_ManufacturerTypeInformation", "ModelReference"
    )
    return manufacturer, model


def extract_cobie(model: ifcopenshell.file) -> dict[str, Any]:
    """Extract COBie-lite sheets from a loaded model. Defensive per entity."""
    project = model.by_type("IfcProject")
    sites = model.by_type("IfcSite")
    buildings = model.by_type("IfcBuilding")
    facility = {
        "name": _s(buildings[0].Name) if buildings else "",
        "project": _s(project[0].Name) if project else "",
        "site": _s(sites[0].Name) if sites else "",
        "building": _s(buildings[0].Name) if buildings else "",
    }

    floors: list[dict[str, Any]] = []
    for storey in model.by_type("IfcBuildingStorey"):
        floors.append(
            {
                "name": _s(getattr(storey, "Name", None)) or "Unnamed storey",
                "elevation": _s(getattr(storey, "Elevation", None)),
                "global_id": _s(getattr(storey, "GlobalId", None)),
            }
        )

    spaces: list[dict[str, Any]] = []
    for space in model.by_type("IfcSpace"):
        floor_name = ""
        try:
            container = element_util.get_aggregate(space) or element_util.get_container(space)
            if container is not None and container.is_a("IfcBuildingStorey"):
                floor_name = _s(getattr(container, "Name", None))
        except Exception:
            pass
        spaces.append(
            {
                "name": _s(getattr(space, "LongName", None)) or _s(getattr(space, "Name", None)),
                "floor": floor_name,
                "category": _s(getattr(space, "ObjectType", None)),
                "area": _pset_value(space, "Qto_SpaceBaseQuantities", "NetFloorArea"),
                "global_id": _s(getattr(space, "GlobalId", None)),
            }
        )

    types: list[dict[str, Any]] = []
    for type_obj in model.by_type("IfcTypeObject"):
        manufacturer, model_label = _type_handover(type_obj)
        types.append(
            {
                "name": _s(getattr(type_obj, "Name", None)) or type_obj.is_a(),
                "ifc_class": type_obj.is_a(),
                "category": _s(getattr(type_obj, "ApplicableOccurrence", None)),
                "manufacturer": manufacturer,
                "model": model_label,
                "global_id": _s(getattr(type_obj, "GlobalId", None)),
            }
        )

    components: list[dict[str, Any]] = []
    for element in model.by_type("IfcElement"):
        if any(element.is_a(cls) for cls in _SPATIAL_SKIP):
            continue
        type_name = ""
        space_name = ""
        try:
            type_obj = element_util.get_type(element)
            if type_obj is not None:
                type_name = _s(getattr(type_obj, "Name", None)) or type_obj.is_a()
        except Exception:
            pass
        try:
            container = element_util.get_container(element)
            if container is not None and container.is_a("IfcSpace"):
                space_name = _s(getattr(container, "LongName", None)) or _s(
                    getattr(container, "Name", None)
                )
        except Exception:
            pass
        components.append(
            {
                "name": _s(getattr(element, "Name", None)) or element.is_a(),
                "type": type_name,
                "space": space_name,
                "ifc_class": element.is_a(),
                "global_id": _s(getattr(element, "GlobalId", None)),
            }
        )

    return {
        "facility": facility,
        "floors": floors,
        "spaces": spaces,
        "types": types,
        "components": components,
    }


def _pct(part: int, whole: int) -> float:
    return round(100.0 * part / whole, 1) if whole else 0.0


def summarize_cobie(cobie: dict[str, Any]) -> dict[str, Any]:
    """Counts per sheet + handover completeness metrics. Pure."""
    floors = cobie.get("floors", [])
    spaces = cobie.get("spaces", [])
    types = cobie.get("types", [])
    components = cobie.get("components", [])

    components_with_type = sum(1 for c in components if c.get("type"))
    types_with_manufacturer = sum(1 for t in types if t.get("manufacturer"))
    types_with_model = sum(1 for t in types if t.get("model"))
    spaces_with_name = sum(1 for s in spaces if s.get("name"))

    return {
        "counts": {
            "floors": len(floors),
            "spaces": len(spaces),
            "types": len(types),
            "components": len(components),
        },
        "completeness": [
            {
                "label": "Components linked to a Type",
                "present": components_with_type,
                "total": len(components),
                "pct": _pct(components_with_type, len(components)),
            },
            {
                "label": "Types with Manufacturer",
                "present": types_with_manufacturer,
                "total": len(types),
                "pct": _pct(types_with_manufacturer, len(types)),
            },
            {
                "label": "Types with Model",
                "present": types_with_model,
                "total": len(types),
                "pct": _pct(types_with_model, len(types)),
            },
            {
                "label": "Spaces named",
                "present": spaces_with_name,
                "total": len(spaces),
                "pct": _pct(spaces_with_name, len(spaces)),
            },
        ],
    }


def cobie_to_csv(cobie: dict[str, Any]) -> str:
    """Serialize the COBie-lite sheets into one multi-section CSV. Pure.

    Each sheet is a ``# <Sheet>`` marker line, a header row, its rows, then a
    blank line. Excel and Sheets open it cleanly.
    """
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")

    facility = cobie.get("facility", {})
    writer.writerow(["# Facility"])
    writer.writerow(list(SHEETS["Facility"]))
    writer.writerow([facility.get(col, "") for col in SHEETS["Facility"]])
    writer.writerow([])

    for sheet, key in (("Floor", "floors"), ("Space", "spaces"), ("Type", "types"), ("Component", "components")):
        columns = SHEETS[sheet]
        writer.writerow([f"# {sheet}"])
        writer.writerow(list(columns))
        for row in cobie.get(key, []):
            writer.writerow([row.get(col, "") for col in columns])
        writer.writerow([])

    return buffer.getvalue()


def extract_summary(model: ifcopenshell.file) -> dict[str, Any]:
    """Convenience: extract then summarize (used by the summary route)."""
    return summarize_cobie(extract_cobie(model))


def extract_csv(model: ifcopenshell.file) -> str:
    """Convenience: extract then serialize to CSV (used by the export route)."""
    return cobie_to_csv(extract_cobie(model))
