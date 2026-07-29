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

This module also hosts the IFC entity dependency graph. It tracks lightweight
relationship edges between IFC entities so that after an AI edit we can
compute the *dirty set* - the minimal set of entity IDs that downstream
consumers (fragment delta loader, property panels) should refresh.

Graph design principles:
- No IfcOpenShell at import time: the graph is built lazily via
  ``build_from_ifc(model)`` so the module is testable without a real IFC file.
- Bidirectional: if A → B then B is also marked as depending on A (shared
  property-set members, type-instance pairs, storey siblings).
- Shallow BFS: dirty-set expansion stops at depth ``max_depth`` (default 1)
  to avoid fanning out the whole model on a single rename.
- Thread-safe reads: the graph is rebuilt from scratch on upload; writes only
  happen during build, never during query.

Relationship types tracked
--------------------------
``type_instance``   IfcRelDefinesByType   - instance shares type with others
``shared_pset``     IfcRelDefinesByProperties - elements sharing one pset
``spatial``         IfcRelContainedInSpatialStructure - storey ↔ element
``aggregate``       IfcRelAggregates      - parent ↔ child in spatial tree
``voids``           IfcRelVoidsElement    - opening ↔ host (wall/slab)
``fills``           IfcRelFillsElement    - filling (door/window) ↔ opening
``fills_void``      transitive            - filling ↔ host (e.g. door ↔ wall)
``connects``        IfcRelConnectsElements - element ↔ element (wall ↔ slab boundary)
"""

from __future__ import annotations

import logging
from collections import defaultdict, deque
from typing import Any, Iterable, Optional

logger = logging.getLogger(__name__)

# Upper bound on the upward containment walk so a malformed model with a
# cyclic spatial graph cannot hang the request (mirrors qto_service).
_MAX_CHAIN_HOPS = 64

# Edge kinds tracked by the entity dependency graph below.
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


class EntityDependencyGraph:
    """Lightweight bidirectional adjacency graph over IFC express IDs."""

    def __init__(self) -> None:
        # adjacency: express_id -> set of (neighbour_id, rel_type)
        self._adj: dict[int, set[tuple[int, str]]] = defaultdict(set)
        self._edge_count = 0

    # ------------------------------------------------------------------
    # Construction helpers (called only during build_from_ifc)
    # ------------------------------------------------------------------

    def add_edge(self, a: int, b: int, rel_type: str) -> None:
        """Add a bidirectional edge between express IDs a and b."""
        if a == b:
            return
        if (b, rel_type) not in self._adj[a]:
            self._adj[a].add((b, rel_type))
            self._adj[b].add((a, rel_type))
            self._edge_count += 1

    def add_group(self, ids: Iterable[int], rel_type: str) -> None:
        """Connect every pair in *ids* with *rel_type* edges (clique)."""
        id_list = list(ids)
        for i, a in enumerate(id_list):
            for b in id_list[i + 1:]:
                self.add_edge(a, b, rel_type)

    # ------------------------------------------------------------------
    # Query
    # ------------------------------------------------------------------

    def compute_dirty_set(
        self,
        changed_ids: Iterable[int],
        max_depth: int = 1,
        rel_types: frozenset[str] | None = None,
    ) -> frozenset[int]:
        """Return the set of entity IDs that may need refreshing.

        Performs BFS from each element in *changed_ids*, stopping at
        *max_depth*.  The seed IDs themselves are always included.

        Parameters
        ----------
        changed_ids:
            Express IDs of entities that were directly modified.
        max_depth:
            How many hops to traverse.  1 (default) returns direct
            neighbours; 0 returns only the seeds.
        rel_types:
            If given, only follow edges whose type is in this set.
        """
        seeds = set(changed_ids)
        if not seeds:
            return frozenset()

        visited: set[int] = set(seeds)
        queue: deque[tuple[int, int]] = deque((s, 0) for s in seeds)

        while queue:
            node, depth = queue.popleft()
            if depth >= max_depth:
                continue
            for neighbour, rel_type in self._adj.get(node, ()):
                if rel_types is not None and rel_type not in rel_types:
                    continue
                if neighbour not in visited:
                    visited.add(neighbour)
                    queue.append((neighbour, depth + 1))

        return frozenset(visited)

    def neighbours(self, entity_id: int) -> frozenset[int]:
        """Return direct neighbour IDs regardless of relationship type."""
        return frozenset(n for n, _ in self._adj.get(entity_id, ()))

    @property
    def node_count(self) -> int:
        return len(self._adj)

    @property
    def edge_count(self) -> int:
        return self._edge_count

    def __contains__(self, entity_id: int) -> bool:
        return entity_id in self._adj


# ---------------------------------------------------------------------------
# IFC model builder
# ---------------------------------------------------------------------------

def build_from_ifc(ifc_model) -> EntityDependencyGraph:  # type: ignore[return]
    """Build a dependency graph from a loaded IfcOpenShell model.

    Relationships covered:
    - IfcRelDefinesByType     → type_instance  (instances share a type)
    - IfcRelDefinesByProperties → shared_pset (elements share a property set)
    - IfcRelContainedInSpatialStructure → spatial (storey ↔ elements)
    - IfcRelAggregates          → aggregate    (spatial tree parent ↔ children)

    Falls back gracefully if ``ifc_model`` is None or the schema doesn't have
    a particular relation type (e.g., older IFC 2x3 files may lack some).
    """
    graph = EntityDependencyGraph()
    if ifc_model is None:
        return graph

    # IfcRelDefinesByType - all instances of the same type are related
    try:
        for rel in ifc_model.by_type("IfcRelDefinesByType"):
            relating = getattr(rel, "RelatingType", None)
            related = getattr(rel, "RelatedObjects", None) or []
            if relating is None:
                continue
            type_id = relating.id()
            instance_ids = [o.id() for o in related]
            # type ↔ each instance
            for iid in instance_ids:
                graph.add_edge(type_id, iid, "type_instance")
            # all instances of same type are related to each other
            graph.add_group(instance_ids, "type_instance")
    except Exception as exc:  # best-effort: tolerate IFC schema variance
        logger.debug("entity_dependency_graph: relationship traversal skipped: %s", exc)

    # IfcRelDefinesByProperties - elements sharing a property set
    try:
        for rel in ifc_model.by_type("IfcRelDefinesByProperties"):
            related = getattr(rel, "RelatedObjects", None) or []
            pdef = getattr(rel, "RelatingPropertyDefinition", None)
            if pdef is None:
                continue
            pset_id = pdef.id()
            element_ids = [o.id() for o in related]
            # pset ↔ each element
            for eid in element_ids:
                graph.add_edge(pset_id, eid, "shared_pset")
            # elements that share the exact same pset instance
            if len(element_ids) > 1:
                graph.add_group(element_ids, "shared_pset")
    except Exception as exc:  # best-effort: tolerate IFC schema variance
        logger.debug("entity_dependency_graph: relationship traversal skipped: %s", exc)

    # IfcRelContainedInSpatialStructure - storey ↔ elements
    try:
        for rel in ifc_model.by_type("IfcRelContainedInSpatialStructure"):
            structure = getattr(rel, "RelatingStructure", None)
            elements = getattr(rel, "RelatedElements", None) or []
            if structure is None:
                continue
            storey_id = structure.id()
            for elem in elements:
                graph.add_edge(storey_id, elem.id(), "spatial")
    except Exception as exc:  # best-effort: tolerate IFC schema variance
        logger.debug("entity_dependency_graph: relationship traversal skipped: %s", exc)

    # IfcRelAggregates - parent ↔ children in the spatial hierarchy
    try:
        for rel in ifc_model.by_type("IfcRelAggregates"):
            parent = getattr(rel, "RelatingObject", None)
            children = getattr(rel, "RelatedObjects", None) or []
            if parent is None:
                continue
            parent_id = parent.id()
            for child in children:
                graph.add_edge(parent_id, child.id(), "aggregate")
    except Exception as exc:  # best-effort: tolerate IFC schema variance
        logger.debug("entity_dependency_graph: relationship traversal skipped: %s", exc)

    # IfcRelVoidsElement - opening ↔ host element (wall/slab)
    # Build opening→host map first so we can add transitive fills_void edges.
    opening_to_host: dict[int, int] = {}
    try:
        for rel in ifc_model.by_type("IfcRelVoidsElement"):
            host = getattr(rel, "RelatingBuildingElement", None)
            opening = getattr(rel, "RelatedOpeningElement", None)
            if host is None or opening is None:
                continue
            host_id = host.id()
            opening_id = opening.id()
            graph.add_edge(host_id, opening_id, "voids")
            opening_to_host[opening_id] = host_id
    except Exception as exc:  # best-effort: tolerate IFC schema variance
        logger.debug("entity_dependency_graph: relationship traversal skipped: %s", exc)

    # IfcRelFillsElement - filling (door/window) ↔ opening
    # Transitive closure: also add a direct filling ↔ host edge so a door
    # rename surfaces the host wall at max_depth=1 (production default).
    try:
        for rel in ifc_model.by_type("IfcRelFillsElement"):
            opening = getattr(rel, "RelatingOpeningElement", None)
            filling = getattr(rel, "RelatedBuildingElement", None)
            if opening is None or filling is None:
                continue
            opening_id = opening.id()
            filling_id = filling.id()
            graph.add_edge(opening_id, filling_id, "fills")
            host_id = opening_to_host.get(opening_id)
            if host_id is not None:
                graph.add_edge(filling_id, host_id, "fills_void")
    except Exception as exc:  # best-effort: tolerate IFC schema variance
        logger.debug("entity_dependency_graph: relationship traversal skipped: %s", exc)

    # IfcRelConnectsElements - element ↔ element (e.g. wall ↔ slab boundary).
    # Schema-friendly: try ConnectsElements first (covers IFC4+), then fall
    # back to IfcRelConnectsPathElements for older path-only schemas.
    for rel_class in ("IfcRelConnectsElements", "IfcRelConnectsPathElements"):
        try:
            for rel in ifc_model.by_type(rel_class):
                a = getattr(rel, "RelatingElement", None)
                b = getattr(rel, "RelatedElement", None)
                if a is None or b is None:
                    continue
                graph.add_edge(a.id(), b.id(), "connects")
        except Exception as exc:  # best-effort: tolerate IFC schema variance
            logger.debug("entity_dependency_graph: connects traversal skipped: %s", exc)

    return graph


# ---------------------------------------------------------------------------
# Module-level singleton - rebuilt on each IFC upload
# ---------------------------------------------------------------------------

_graph: EntityDependencyGraph = EntityDependencyGraph()


def get_graph() -> EntityDependencyGraph:
    """Return the current module-level graph (may be empty before first upload)."""
    return _graph


def rebuild_graph(ifc_model) -> EntityDependencyGraph:
    """Rebuild the module-level graph from *ifc_model* and return it."""
    global _graph
    _graph = build_from_ifc(ifc_model)
    return _graph
