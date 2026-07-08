"""Tests for the IFC entity dependency graph."""
import pytest
from app.services.entity_dependency_graph import (
    EntityDependencyGraph,
    build_from_ifc,
    get_graph,
    rebuild_graph,
)


# ---------------------------------------------------------------------------
# EntityDependencyGraph unit tests
# ---------------------------------------------------------------------------

class TestEntityDependencyGraphBasics:
    def test_empty_graph(self):
        g = EntityDependencyGraph()
        assert g.node_count == 0
        assert g.edge_count == 0

    def test_add_edge_bidirectional(self):
        g = EntityDependencyGraph()
        g.add_edge(1, 2, "spatial")
        assert 2 in g.neighbours(1)
        assert 1 in g.neighbours(2)

    def test_add_edge_no_self_loops(self):
        g = EntityDependencyGraph()
        g.add_edge(5, 5, "type_instance")
        assert g.edge_count == 0

    def test_add_edge_no_duplicates(self):
        g = EntityDependencyGraph()
        g.add_edge(1, 2, "spatial")
        g.add_edge(1, 2, "spatial")  # second call is a no-op
        assert g.edge_count == 1

    def test_add_group_connects_all_pairs(self):
        g = EntityDependencyGraph()
        g.add_group([10, 20, 30], "shared_pset")
        # 3 nodes → 3 edges in a clique
        assert g.edge_count == 3
        assert 20 in g.neighbours(10)
        assert 30 in g.neighbours(10)
        assert 30 in g.neighbours(20)

    def test_contains(self):
        g = EntityDependencyGraph()
        g.add_edge(7, 8, "aggregate")
        assert 7 in g
        assert 9 not in g

    def test_node_count(self):
        g = EntityDependencyGraph()
        g.add_edge(1, 2, "spatial")
        g.add_edge(2, 3, "spatial")
        # nodes: 1, 2, 3
        assert g.node_count == 3


class TestComputeDirtySet:
    def _chain_graph(self) -> EntityDependencyGraph:
        """A → B → C → D (linear chain)."""
        g = EntityDependencyGraph()
        g.add_edge(1, 2, "spatial")
        g.add_edge(2, 3, "spatial")
        g.add_edge(3, 4, "spatial")
        return g

    def test_seeds_always_included(self):
        g = self._chain_graph()
        dirty = g.compute_dirty_set([1])
        assert 1 in dirty

    def test_depth_0_returns_only_seeds(self):
        g = self._chain_graph()
        dirty = g.compute_dirty_set([1], max_depth=0)
        assert dirty == frozenset({1})

    def test_depth_1_returns_direct_neighbours(self):
        g = self._chain_graph()
        dirty = g.compute_dirty_set([1], max_depth=1)
        assert 1 in dirty
        assert 2 in dirty
        assert 3 not in dirty  # two hops away

    def test_depth_2_returns_two_hops(self):
        g = self._chain_graph()
        dirty = g.compute_dirty_set([1], max_depth=2)
        assert 3 in dirty
        assert 4 not in dirty

    def test_multiple_seeds(self):
        g = EntityDependencyGraph()
        g.add_edge(10, 11, "type_instance")
        g.add_edge(20, 21, "type_instance")
        dirty = g.compute_dirty_set([10, 20], max_depth=1)
        assert {10, 11, 20, 21}.issubset(dirty)

    def test_empty_seeds(self):
        g = self._chain_graph()
        assert g.compute_dirty_set([]) == frozenset()

    def test_rel_type_filter(self):
        g = EntityDependencyGraph()
        g.add_edge(1, 2, "spatial")
        g.add_edge(1, 3, "type_instance")
        dirty_spatial = g.compute_dirty_set([1], rel_types=frozenset({"spatial"}))
        assert 2 in dirty_spatial
        assert 3 not in dirty_spatial

    def test_returns_frozenset(self):
        g = self._chain_graph()
        result = g.compute_dirty_set([1])
        assert isinstance(result, frozenset)


# ---------------------------------------------------------------------------
# build_from_ifc with mock model
# ---------------------------------------------------------------------------

class _MockEntity:
    """Minimal stand-in for an IfcOpenShell entity."""
    def __init__(self, entity_id: int):
        self._id = entity_id

    def id(self) -> int:
        return self._id


class _MockRel:
    def __init__(self, **attrs):
        for k, v in attrs.items():
            setattr(self, k, v)


class _MockModel:
    def __init__(self, relations: dict[str, list]):
        self._relations = relations

    def by_type(self, ifc_type: str):
        return self._relations.get(ifc_type, [])


class TestBuildFromIfc:
    def _make_type_instance_model(self):
        """One type linked to two instances."""
        type_entity = _MockEntity(100)
        inst1 = _MockEntity(101)
        inst2 = _MockEntity(102)
        rel = _MockRel(RelatingType=type_entity, RelatedObjects=[inst1, inst2])
        return _MockModel({"IfcRelDefinesByType": [rel]})

    def test_type_instance_edges(self):
        model = self._make_type_instance_model()
        g = build_from_ifc(model)
        # type ↔ each instance
        assert 101 in g.neighbours(100)
        assert 102 in g.neighbours(100)
        # instances are related to each other (same type)
        assert 102 in g.neighbours(101)

    def test_shared_pset_edges(self):
        pset = _MockEntity(200)
        elem1 = _MockEntity(201)
        elem2 = _MockEntity(202)
        rel = _MockRel(RelatingPropertyDefinition=pset, RelatedObjects=[elem1, elem2])
        model = _MockModel({"IfcRelDefinesByProperties": [rel]})
        g = build_from_ifc(model)
        assert 201 in g.neighbours(200)
        assert 202 in g.neighbours(200)
        # shared pset → elements related to each other
        assert 202 in g.neighbours(201)

    def test_spatial_containment_edges(self):
        storey = _MockEntity(300)
        wall = _MockEntity(301)
        slab = _MockEntity(302)
        rel = _MockRel(RelatingStructure=storey, RelatedElements=[wall, slab])
        model = _MockModel({"IfcRelContainedInSpatialStructure": [rel]})
        g = build_from_ifc(model)
        assert 301 in g.neighbours(300)
        assert 302 in g.neighbours(300)

    def test_aggregate_edges(self):
        parent = _MockEntity(400)
        child1 = _MockEntity(401)
        child2 = _MockEntity(402)
        rel = _MockRel(RelatingObject=parent, RelatedObjects=[child1, child2])
        model = _MockModel({"IfcRelAggregates": [rel]})
        g = build_from_ifc(model)
        assert 401 in g.neighbours(400)
        assert 402 in g.neighbours(400)

    def test_none_model_returns_empty_graph(self):
        g = build_from_ifc(None)
        assert g.node_count == 0

    def test_missing_relation_type_skipped_gracefully(self):
        """If a relation type doesn't exist in the model, no error raised."""
        model = _MockModel({})  # empty
        g = build_from_ifc(model)
        assert g.node_count == 0


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

class TestModuleSingleton:
    def test_rebuild_graph_returns_new_graph(self):
        model = _MockModel({})
        g1 = rebuild_graph(model)
        g2 = get_graph()
        assert g1 is g2

    def test_rebuild_graph_with_data(self):
        storey = _MockEntity(500)
        wall = _MockEntity(501)
        rel = _MockRel(RelatingStructure=storey, RelatedElements=[wall])
        model = _MockModel({"IfcRelContainedInSpatialStructure": [rel]})
        rebuild_graph(model)
        g = get_graph()
        assert 501 in g.neighbours(500)


# ---------------------------------------------------------------------------
# _ui_action_events emits entity_delta when graph has data
# ---------------------------------------------------------------------------

class TestEntityDeltaInUiActionEvents:
    def test_entity_delta_emitted_when_graph_populated(self, monkeypatch):
        from app.services.entity_dependency_graph import EntityDependencyGraph
        mock_graph = EntityDependencyGraph()
        mock_graph.add_edge(10, 11, "spatial")

        monkeypatch.setattr(
            "app.services.entity_dependency_graph._graph", mock_graph
        )

        from app.services.llm_service import _ui_action_events
        result = {"action": "metadata_changed", "changed_ids": [10], "description": "Test"}
        events = _ui_action_events(result)

        types = [e["type"] for e in events]
        assert "metadata_changed" in types
        assert "entity_delta" in types

        delta = next(e for e in events if e["type"] == "entity_delta")
        assert 10 in delta["changed_ids"]
        assert 11 in delta["dirty_ids"]

    def test_no_entity_delta_when_graph_empty(self):
        from app.services.llm_service import _ui_action_events
        # Empty graph (default): no entity_delta should be emitted
        # (We rely on the module-level graph being empty in test context)
        result = {"action": "metadata_changed", "changed_ids": [], "description": "noop"}
        events = _ui_action_events(result)
        types = [e["type"] for e in events]
        assert "metadata_changed" in types
        # With no changed_ids, entity_delta is skipped
        assert "entity_delta" not in types


# ---------------------------------------------------------------------------
# Real edit-scenario coverage (opening / door / wall-type)
#
# These pin the production guarantee that the graph's max_depth=1 BFS
# surfaces the right host elements after common edit operations:
#   (a) move an IfcOpening    → host IfcWall in dirty_set
#   (b) delete an IfcDoor     → host IfcWall in dirty_set (transitive)
#   (c) change wall type      → all openings + connected slabs in dirty_set
# ---------------------------------------------------------------------------

class TestVoidsAndFillsRelations:
    """Direct edges from IfcRelVoidsElement + IfcRelFillsElement."""

    def test_voids_element_edge(self):
        wall = _MockEntity(700)
        opening = _MockEntity(701)
        rel = _MockRel(RelatingBuildingElement=wall, RelatedOpeningElement=opening)
        model = _MockModel({"IfcRelVoidsElement": [rel]})
        g = build_from_ifc(model)
        assert 701 in g.neighbours(700)
        assert 700 in g.neighbours(701)

    def test_fills_element_edge(self):
        opening = _MockEntity(800)
        door = _MockEntity(801)
        rel = _MockRel(RelatingOpeningElement=opening, RelatedBuildingElement=door)
        model = _MockModel({"IfcRelFillsElement": [rel]})
        g = build_from_ifc(model)
        assert 801 in g.neighbours(800)

    def test_fills_void_transitive_edge(self):
        """Door → opening → wall should produce a direct door ↔ wall edge."""
        wall = _MockEntity(900)
        opening = _MockEntity(901)
        door = _MockEntity(902)
        voids_rel = _MockRel(RelatingBuildingElement=wall, RelatedOpeningElement=opening)
        fills_rel = _MockRel(RelatingOpeningElement=opening, RelatedBuildingElement=door)
        model = _MockModel({
            "IfcRelVoidsElement": [voids_rel],
            "IfcRelFillsElement": [fills_rel],
        })
        g = build_from_ifc(model)
        # Direct door ↔ wall edge (fills_void closure)
        assert 900 in g.neighbours(902)
        assert 902 in g.neighbours(900)


class TestConnectsElementsRelation:
    """IfcRelConnectsElements (and the path-element fallback)."""

    def test_connects_elements_edge(self):
        wall = _MockEntity(1000)
        slab = _MockEntity(1001)
        rel = _MockRel(RelatingElement=wall, RelatedElement=slab)
        model = _MockModel({"IfcRelConnectsElements": [rel]})
        g = build_from_ifc(model)
        assert 1001 in g.neighbours(1000)

    def test_connects_path_elements_fallback(self):
        """Older schemas only have IfcRelConnectsPathElements."""
        wall_a = _MockEntity(1100)
        wall_b = _MockEntity(1101)
        rel = _MockRel(RelatingElement=wall_a, RelatedElement=wall_b)
        model = _MockModel({"IfcRelConnectsPathElements": [rel]})
        g = build_from_ifc(model)
        assert 1101 in g.neighbours(1100)


class TestV1EditScenarios:
    """Real edit-scenario coverage: opening / door / wall-type changes."""

    def test_move_opening_surfaces_host_wall(self):
        """Edit case (a): move an IfcOpening → host wall in depth-1 dirty set."""
        wall = _MockEntity(2000)
        opening = _MockEntity(2001)
        voids_rel = _MockRel(RelatingBuildingElement=wall, RelatedOpeningElement=opening)
        model = _MockModel({"IfcRelVoidsElement": [voids_rel]})
        g = build_from_ifc(model)
        # Production calls compute_dirty_set with max_depth=1
        dirty = g.compute_dirty_set([2001], max_depth=1)
        assert 2000 in dirty, "host wall must be in dirty set after opening moves"

    def test_delete_door_surfaces_host_wall(self):
        """Edit case (b): delete an IfcDoor → host wall in depth-1 dirty set.

        Requires the fills_void transitive edge so a door rename surfaces
        the host wall without bumping max_depth to 2.
        """
        wall = _MockEntity(2100)
        opening = _MockEntity(2101)
        door = _MockEntity(2102)
        voids_rel = _MockRel(RelatingBuildingElement=wall, RelatedOpeningElement=opening)
        fills_rel = _MockRel(RelatingOpeningElement=opening, RelatedBuildingElement=door)
        model = _MockModel({
            "IfcRelVoidsElement": [voids_rel],
            "IfcRelFillsElement": [fills_rel],
        })
        g = build_from_ifc(model)
        dirty = g.compute_dirty_set([2102], max_depth=1)
        assert 2100 in dirty, "host wall must be in dirty set after door delete"

    def test_change_wall_type_surfaces_openings_and_slabs(self):
        """Edit case (c): change wall type → all openings + connected slabs.

        The wall participates in:
          - IfcRelDefinesByType (instance ↔ type)
          - IfcRelVoidsElement (openings)
          - IfcRelConnectsElements (slabs at boundary)
        After a property change on the wall itself, depth-1 BFS should reach
        the type, both openings, and the connected slab.
        """
        wall_type = _MockEntity(3000)
        wall = _MockEntity(3001)
        opening_a = _MockEntity(3002)
        opening_b = _MockEntity(3003)
        slab = _MockEntity(3004)

        type_rel = _MockRel(RelatingType=wall_type, RelatedObjects=[wall])
        voids_a = _MockRel(RelatingBuildingElement=wall, RelatedOpeningElement=opening_a)
        voids_b = _MockRel(RelatingBuildingElement=wall, RelatedOpeningElement=opening_b)
        connect_rel = _MockRel(RelatingElement=wall, RelatedElement=slab)

        model = _MockModel({
            "IfcRelDefinesByType": [type_rel],
            "IfcRelVoidsElement": [voids_a, voids_b],
            "IfcRelConnectsElements": [connect_rel],
        })
        g = build_from_ifc(model)
        dirty = g.compute_dirty_set([wall.id()], max_depth=1)
        assert wall_type.id() in dirty, "wall type must be in dirty set"
        assert opening_a.id() in dirty, "opening A must be in dirty set"
        assert opening_b.id() in dirty, "opening B must be in dirty set"
        assert slab.id() in dirty, "connected slab must be in dirty set"
