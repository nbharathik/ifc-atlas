"""Structured relationship map for a single IFC element.

Backs the ``get_element_relationships`` chat tool. Direct IfcOpenShell
inverse-attribute walks provide direction and labels (the entity dependency
graph is bidirectional and unlabeled per node, so it cannot say "this wall is
CONTAINED IN that storey"); the graph contributes cheap per-kind neighbour
counts as a summary when it is warm.

Every reference carries ``id`` (express), ``global_id``, ``name`` and
``ifc_type`` so the LLM can narrate the context without extra lookups. All
walks are schema-tolerant: a missing inverse attribute or an exotic schema
degrades that one field, never the whole map.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Upper bound on the upward containment walk so a malformed model with a
# cyclic spatial graph cannot hang the request (mirrors qto_service).
_MAX_CHAIN_HOPS = 64

# Edge kinds tracked by app.services.entity_dependency_graph.
_GRAPH_REL_KINDS: tuple[str, ...] = (
    "type_instance",
    "shared_pset",
    "spatial",
    "aggregate",
    "voids",
    "fills",
    "fills_void",
    "connects",
)


def _safe_id(entity: Any) -> Optional[int]:
    try:
        return int(entity.id())
    except Exception:  # noqa: BLE001
        return None


def _safe_is_a(entity: Any, ifc_class: str) -> bool:
    try:
        return bool(entity.is_a(ifc_class))
    except Exception:  # noqa: BLE001
        return False


def _ref(entity: Any) -> dict[str, Any]:
    """JSON-safe reference block for one entity."""
    try:
        ifc_type = entity.is_a()
    except Exception:  # noqa: BLE001
        ifc_type = None
    return {
        "id": _safe_id(entity),
        "global_id": getattr(entity, "GlobalId", None),
        "name": getattr(entity, "Name", None),
        "ifc_type": ifc_type,
    }


def _inverse(entity: Any, attr: str) -> tuple:
    """Read an inverse attribute defensively; missing/None becomes ()."""
    try:
        return tuple(getattr(entity, attr, None) or ())
    except Exception:  # noqa: BLE001
        return ()


def _spatial_parent(node: Any) -> Any:
    """One hop up the spatial tree: containment first, then aggregation."""
    for rel in _inverse(node, "ContainedInStructure"):
        parent = getattr(rel, "RelatingStructure", None)
        if parent is not None:
            return parent
    for rel in _inverse(node, "Decomposes"):
        parent = getattr(rel, "RelatingObject", None)
        if parent is not None:
            return parent
    return None


def _containment_chain(entity: Any) -> list[dict[str, Any]]:
    """Spatial parent chain from the immediate container up to the project."""
    chain: list[dict[str, Any]] = []
    seen: set[int] = set()
    eid = _safe_id(entity)
    if eid is not None:
        seen.add(eid)
    node = entity
    for _ in range(_MAX_CHAIN_HOPS):
        try:
            parent = _spatial_parent(node)
        except Exception:  # noqa: BLE001
            break
        if parent is None:
            break
        pid = _safe_id(parent)
        if pid is not None:
            if pid in seen:
                break  # cycle guard
            seen.add(pid)
        chain.append(_ref(parent))
        node = parent
    return chain


def _graph_neighbour_counts(graph: Any, element_id: int) -> dict[str, int]:
    """Per-relationship-kind neighbour counts from the dependency graph."""
    counts: dict[str, int] = {}
    if graph is None:
        return counts
    try:
        if element_id not in graph:
            return counts
        for kind in _GRAPH_REL_KINDS:
            n = len(
                graph.compute_dirty_set(
                    [element_id], max_depth=1, rel_types=frozenset({kind})
                )
            ) - 1  # the seed itself is always included
            if n > 0:
                counts[kind] = n
    except Exception:  # noqa: BLE001
        logger.debug("dependency-graph neighbour count failed", exc_info=True)
        return {}
    return counts


def build_relationship_map(
    model: Any, element_id: int, graph: Any = None
) -> dict[str, Any]:
    """Return the full relationship map for one element.

    Raises ``ValueError`` when the element id is unknown (normalised from
    ifcopenshell's RuntimeError / None return, matching IfcService).
    """
    element_id = int(element_id)
    try:
        entity = model.by_id(element_id)
    except Exception:  # noqa: BLE001 - by_id raises RuntimeError on miss
        entity = None
    if entity is None:
        raise ValueError(f"Element {element_id} not found")

    result: dict[str, Any] = {"element": _ref(entity)}

    # -- Spatial containment (nearest container first, up to IfcProject) --
    result["contained_in"] = _containment_chain(entity)

    # -- Aggregation (IfcRelAggregates) --
    aggregated_by = None
    for rel in _inverse(entity, "Decomposes"):
        parent = getattr(rel, "RelatingObject", None)
        if parent is not None:
            aggregated_by = _ref(parent)
            break
    result["aggregated_by"] = aggregated_by

    aggregates: list[dict[str, Any]] = []
    for rel in _inverse(entity, "IsDecomposedBy"):
        for child in getattr(rel, "RelatedObjects", None) or ():
            aggregates.append(_ref(child))
    result["aggregates"] = aggregates

    # -- Openings this element hosts (IfcRelVoidsElement -> IfcRelFillsElement) --
    openings: list[dict[str, Any]] = []
    for rel in _inverse(entity, "HasOpenings"):
        opening = getattr(rel, "RelatedOpeningElement", None)
        if opening is None:
            continue
        filled_by = [
            _ref(filler)
            for fill in _inverse(opening, "HasFillings")
            if (filler := getattr(fill, "RelatedBuildingElement", None)) is not None
        ]
        openings.append({"opening": _ref(opening), "filled_by": filled_by})
    result["openings"] = openings

    # -- Openings this element fills (door/window -> host wall/slab) --
    fills: list[dict[str, Any]] = []
    for rel in _inverse(entity, "FillsVoids"):
        opening = getattr(rel, "RelatingOpeningElement", None)
        if opening is None:
            continue
        host = None
        for void in _inverse(opening, "VoidsElements"):
            h = getattr(void, "RelatingBuildingElement", None)
            if h is not None:
                host = _ref(h)
                break
        fills.append({"opening": _ref(opening), "host": host})
    result["fills"] = fills

    # -- Path/element connections (IfcRelConnects*Elements) --
    connected: list[dict[str, Any]] = []
    for rel in _inverse(entity, "ConnectedTo"):
        other = getattr(rel, "RelatedElement", None)
        if other is not None:
            try:
                via = rel.is_a()
            except Exception:  # noqa: BLE001
                via = None
            connected.append({**_ref(other), "via": via, "direction": "to"})
    for rel in _inverse(entity, "ConnectedFrom"):
        other = getattr(rel, "RelatingElement", None)
        if other is not None:
            try:
                via = rel.is_a()
            except Exception:  # noqa: BLE001
                via = None
            connected.append({**_ref(other), "via": via, "direction": "from"})
    result["connected_to"] = connected

    # -- Type object (IfcRelDefinesByType; IFC2X3 routes it via IsDefinedBy) --
    type_object = None
    type_rels = list(_inverse(entity, "IsTypedBy")) or [
        rel
        for rel in _inverse(entity, "IsDefinedBy")
        if _safe_is_a(rel, "IfcRelDefinesByType")
    ]
    for rel in type_rels:
        t = getattr(rel, "RelatingType", None)
        if t is None:
            continue
        siblings = getattr(rel, "RelatedObjects", None) or ()
        type_object = {**_ref(t), "instances_of_type": len(siblings)}
        break
    result["type_object"] = type_object

    # -- Property-set sharing stats --
    total_psets = 0
    shared_instances = 0
    sharing_elements: set[int] = set()
    for rel in _inverse(entity, "IsDefinedBy"):
        if not _safe_is_a(rel, "IfcRelDefinesByProperties"):
            continue
        total_psets += 1
        related = getattr(rel, "RelatedObjects", None) or ()
        if len(related) > 1:
            shared_instances += 1
            for other in related:
                oid = _safe_id(other)
                if oid is not None and oid != element_id:
                    sharing_elements.add(oid)
    result["property_sets"] = {
        "total": total_psets,
        "shared_instances": shared_instances,
        "shared_with_element_count": len(sharing_elements),
    }

    # -- Dependency-graph neighbour counts (summary; empty when graph cold) --
    result["dependency_graph_neighbours"] = _graph_neighbour_counts(
        graph, element_id
    )

    return result
