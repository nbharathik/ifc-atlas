"""AABB-based proximity queries for the ``find_nearby_elements`` tool.

The chat tool historically measured Euclidean distance between
IfcLocalPlacement ORIGINS across all IfcProduct entities. That is fast but
misleading on real models: large elements (slabs, roofs, long walls) have
origins far away from most of their body, so "within 3 m" answers were often
wrong. When :mod:`app.services.aabb_service` holds a warm cache of real
geometry-derived boxes for the loaded model, the tool routes through this
module instead and measures box-to-box distances.

Pure and IfcOpenShell-free at import time: the caller passes the box map and
the loaded model handle, so everything here unit-tests with plain dicts and
mocks. Distance semantics:

* ``distance_m`` - surface (gap) distance between the two AABBs. 0.0 means
  the boxes touch or overlap.
* ``center_distance_m`` - Euclidean distance between the box centers, kept
  as a secondary signal for ranking/narration.
"""

from __future__ import annotations

from typing import Any, Callable, Mapping, Optional

# ((min_x, min_y, min_z), (max_x, max_y, max_z)) - mirrors aabb_service.AABBTuple.
AABBTuple = tuple[tuple[float, float, float], tuple[float, float, float]]


def aabb_center(box: AABBTuple) -> tuple[float, float, float]:
    """Return the center point of an AABB."""
    mn, mx = box
    return (
        (mn[0] + mx[0]) / 2.0,
        (mn[1] + mx[1]) / 2.0,
        (mn[2] + mx[2]) / 2.0,
    )


def aabb_center_distance(a: AABBTuple, b: AABBTuple) -> float:
    """Euclidean distance between the centers of two AABBs."""
    ca = aabb_center(a)
    cb = aabb_center(b)
    return (
        (ca[0] - cb[0]) ** 2 + (ca[1] - cb[1]) ** 2 + (ca[2] - cb[2]) ** 2
    ) ** 0.5


def aabb_surface_distance(a: AABBTuple, b: AABBTuple) -> float:
    """Surface (gap) distance between two AABBs.

    Per axis the gap is ``max(0, b_min - a_max, a_min - b_max)``; the result
    is the Euclidean norm of the three gaps. Overlapping or touching boxes
    return 0.0.
    """
    gap_sq = 0.0
    for axis in range(3):
        gap = max(0.0, b[0][axis] - a[1][axis], a[0][axis] - b[1][axis])
        gap_sq += gap * gap
    return gap_sq ** 0.5


def find_nearby_via_aabbs(
    model: Any,
    boxes: Mapping[int, AABBTuple],
    element_id: int,
    radius_m: float = 5.0,
    ifc_types: Optional[list[str]] = None,
    limit: int = 20,
    storey_resolver: Optional[Callable[[Any], Optional[str]]] = None,
) -> Optional[dict[str, Any]]:
    """Find elements whose AABB lies within ``radius_m`` of the reference box.

    Returns ``None`` when the reference element has no cached box, so the
    caller can fall back to the placement-origin heuristic. The result dict
    mirrors ``IfcService.find_nearby_elements`` (id/name/ifc_type/storey/
    distance_m per element, sorted ascending) plus ``geometry: "aabb"``.

    ``storey_resolver`` is an optional ``entity -> storey name`` callable
    (the IfcService storey lookup); failures resolve to ``None`` rather than
    aborting the query.
    """
    if radius_m <= 0:
        raise ValueError("radius_m must be positive")
    ref_id = int(element_id)
    ref_box = boxes.get(ref_id)
    if ref_box is None:
        return None

    ifc_types_lower = [t.lower() for t in ifc_types] if ifc_types else None

    hits: list[tuple[float, float, int]] = []
    for eid, box in boxes.items():
        if eid == ref_id:
            continue
        dist = aabb_surface_distance(ref_box, box)
        if dist > radius_m:
            continue
        hits.append((dist, aabb_center_distance(ref_box, box), eid))
    hits.sort()

    elements: list[dict[str, Any]] = []
    for dist, center_dist, eid in hits:
        try:
            entity = model.by_id(eid)
        except Exception:  # noqa: BLE001 - stale cache entries must not abort
            entity = None
        if entity is None:
            continue
        try:
            if entity.is_a("IfcOpeningElement"):
                continue
            entity_type = entity.is_a()
        except Exception:  # noqa: BLE001
            continue
        if ifc_types_lower and entity_type.lower() not in ifc_types_lower:
            continue
        storey = None
        if storey_resolver is not None:
            try:
                storey = storey_resolver(entity)
            except Exception:  # noqa: BLE001
                storey = None
        elements.append(
            {
                "id": eid,
                "name": getattr(entity, "Name", None) or f"#{eid}",
                "ifc_type": entity_type,
                "storey": storey,
                "distance_m": round(dist, 3),
                "center_distance_m": round(center_dist, 3),
            }
        )
        if len(elements) >= limit:
            break

    return {
        "element_id": ref_id,
        "radius_m": radius_m,
        "count": len(elements),
        "elements": elements,
        "geometry": "aabb",
        "boxes_cached": len(boxes),
        "note": (
            "Distances are box-to-box surface distances from real geometry "
            "AABBs; 0.0 means the elements touch or overlap."
        ),
    }
