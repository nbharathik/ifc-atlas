"""
IFC entity dependency graph.

Tracks lightweight relationship edges between IFC entities so that after an
AI edit we can compute the *dirty set* - the minimal set of entity IDs that
downstream consumers (fragment delta loader, property panels) should refresh.

Design principles:
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
from typing import Iterable

logger = logging.getLogger(__name__)


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
