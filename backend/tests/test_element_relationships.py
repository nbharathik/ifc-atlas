"""Tests for the get_element_relationships tool + its helper module.

The model is authored in memory with ifcopenshell.api (no disk IFC load), so
the suite stays fast and avoids the loader-crash markers. Fixture: a wall on
Level 1 hosting an opening filled by a window, path-connected to a second
wall, typed, and sharing one property set with that second wall.
"""

from __future__ import annotations

from unittest.mock import patch

import ifcopenshell
import ifcopenshell.api
import ifcopenshell.guid
import pytest

from app.services.element_relationships import build_relationship_map
from app.services.entity_dependency_graph import build_from_ifc


def _api(verb: str, model, **kwargs):
    return ifcopenshell.api.run(verb, model, **kwargs)


@pytest.fixture(scope="module")
def rel_model():
    model = ifcopenshell.file(schema="IFC4")
    project = _api("root.create_entity", model, ifc_class="IfcProject", name="Proj")
    site = _api("root.create_entity", model, ifc_class="IfcSite", name="Site")
    building = _api("root.create_entity", model, ifc_class="IfcBuilding", name="Building")
    storey = _api(
        "root.create_entity", model, ifc_class="IfcBuildingStorey", name="Level 1"
    )
    _api("aggregate.assign_object", model, products=[site], relating_object=project)
    _api("aggregate.assign_object", model, products=[building], relating_object=site)
    _api("aggregate.assign_object", model, products=[storey], relating_object=building)

    wall = _api("root.create_entity", model, ifc_class="IfcWall", name="Wall-A")
    wall2 = _api("root.create_entity", model, ifc_class="IfcWall", name="Wall-B")
    _api(
        "spatial.assign_container",
        model,
        products=[wall, wall2],
        relating_structure=storey,
    )

    # Opening in Wall-A, filled by a window.
    opening = _api(
        "root.create_entity", model, ifc_class="IfcOpeningElement", name="Opening-1"
    )
    _api("feature.add_feature", model, feature=opening, element=wall)
    window = _api("root.create_entity", model, ifc_class="IfcWindow", name="Window-1")
    _api("feature.add_filling", model, opening=opening, element=window)

    # Wall-A path-connects to Wall-B.
    model.create_entity(
        "IfcRelConnectsPathElements",
        GlobalId=ifcopenshell.guid.new(),
        RelatingElement=wall,
        RelatedElement=wall2,
        RelatingPriorities=[],
        RelatedPriorities=[],
        RelatedConnectionType="ATSTART",
        RelatingConnectionType="ATEND",
    )

    # Type object for both walls.
    wall_type = _api(
        "root.create_entity", model, ifc_class="IfcWallType", name="WT-200"
    )
    _api(
        "type.assign_type", model, related_objects=[wall, wall2], relating_type=wall_type
    )

    # One property set shared by both walls.
    pset = model.create_entity(
        "IfcPropertySet",
        GlobalId=ifcopenshell.guid.new(),
        Name="Pset_Shared",
        HasProperties=[],
    )
    model.create_entity(
        "IfcRelDefinesByProperties",
        GlobalId=ifcopenshell.guid.new(),
        RelatedObjects=[wall, wall2],
        RelatingPropertyDefinition=pset,
    )

    return {
        "model": model,
        "wall": wall,
        "wall2": wall2,
        "opening": opening,
        "window": window,
        "storey": storey,
        "building": building,
        "wall_type": wall_type,
    }


# ---------------------------------------------------------------------------
# build_relationship_map - direct helper tests
# ---------------------------------------------------------------------------


def test_wall_containment_chain(rel_model):
    result = build_relationship_map(rel_model["model"], rel_model["wall"].id())
    assert result["element"]["name"] == "Wall-A"
    assert result["element"]["ifc_type"] == "IfcWall"
    assert result["element"]["global_id"]
    chain_names = [c["name"] for c in result["contained_in"]]
    assert chain_names == ["Level 1", "Building", "Site", "Proj"]
    chain_types = [c["ifc_type"] for c in result["contained_in"]]
    assert chain_types[0] == "IfcBuildingStorey"
    assert chain_types[-1] == "IfcProject"


def test_wall_openings_and_fillers(rel_model):
    result = build_relationship_map(rel_model["model"], rel_model["wall"].id())
    assert len(result["openings"]) == 1
    entry = result["openings"][0]
    assert entry["opening"]["name"] == "Opening-1"
    assert [f["name"] for f in entry["filled_by"]] == ["Window-1"]
    assert entry["filled_by"][0]["ifc_type"] == "IfcWindow"


def test_window_fills_back_to_host_wall(rel_model):
    result = build_relationship_map(rel_model["model"], rel_model["window"].id())
    assert len(result["fills"]) == 1
    fill = result["fills"][0]
    assert fill["opening"]["name"] == "Opening-1"
    assert fill["host"]["id"] == rel_model["wall"].id()
    assert fill["host"]["name"] == "Wall-A"
    # The window hosts no openings of its own.
    assert result["openings"] == []


def test_wall_connections_both_directions(rel_model):
    a = build_relationship_map(rel_model["model"], rel_model["wall"].id())
    to_ids = [(c["id"], c["direction"]) for c in a["connected_to"]]
    assert (rel_model["wall2"].id(), "to") in to_ids

    b = build_relationship_map(rel_model["model"], rel_model["wall2"].id())
    from_ids = [(c["id"], c["direction"]) for c in b["connected_to"]]
    assert (rel_model["wall"].id(), "from") in from_ids
    assert all(c["via"] == "IfcRelConnectsPathElements" for c in b["connected_to"])


def test_wall_type_object_and_instance_count(rel_model):
    result = build_relationship_map(rel_model["model"], rel_model["wall"].id())
    t = result["type_object"]
    assert t is not None
    assert t["name"] == "WT-200"
    assert t["ifc_type"] == "IfcWallType"
    assert t["instances_of_type"] == 2


def test_wall_shared_pset_stats(rel_model):
    result = build_relationship_map(rel_model["model"], rel_model["wall"].id())
    psets = result["property_sets"]
    assert psets["total"] >= 1
    assert psets["shared_instances"] >= 1
    assert psets["shared_with_element_count"] == 1  # Wall-B


def test_storey_aggregation_fields(rel_model):
    result = build_relationship_map(rel_model["model"], rel_model["storey"].id())
    assert result["aggregated_by"]["name"] == "Building"
    # The storey aggregates nothing (walls are CONTAINED, not aggregated).
    assert result["aggregates"] == []

    building = build_relationship_map(rel_model["model"], rel_model["building"].id())
    assert [c["name"] for c in building["aggregates"]] == ["Level 1"]


def test_graph_neighbour_counts_when_graph_warm(rel_model):
    graph = build_from_ifc(rel_model["model"])
    result = build_relationship_map(
        rel_model["model"], rel_model["wall"].id(), graph=graph
    )
    counts = result["dependency_graph_neighbours"]
    assert counts.get("voids") == 1
    assert counts.get("fills_void") == 1
    assert counts.get("connects") == 1
    assert counts.get("spatial") == 1
    assert counts.get("type_instance", 0) >= 1


def test_graph_counts_empty_when_graph_cold(rel_model):
    result = build_relationship_map(
        rel_model["model"], rel_model["wall"].id(), graph=None
    )
    assert result["dependency_graph_neighbours"] == {}


def test_missing_element_raises_value_error(rel_model):
    with pytest.raises(ValueError, match="not found"):
        build_relationship_map(rel_model["model"], 999999)


# ---------------------------------------------------------------------------
# execute_tool routing
# ---------------------------------------------------------------------------


def test_execute_tool_relationships(rel_model):
    from app.services.tools import execute_tool

    with patch("app.services.tools.ifc_service") as svc:
        svc.is_loaded = True
        svc.model = rel_model["model"]
        result = execute_tool(
            "get_element_relationships", {"element_id": rel_model["wall"].id()}
        )
    assert result["element"]["name"] == "Wall-A"
    assert result["contained_in"][0]["name"] == "Level 1"
    assert "error" not in result


def test_execute_tool_relationships_missing_arg():
    from app.services.tools import execute_tool

    with patch("app.services.tools.ifc_service") as svc:
        svc.is_loaded = True
        result = execute_tool("get_element_relationships", {})
    assert "error" in result
    assert "element_id" in result["error"]


def test_execute_tool_relationships_unknown_element(rel_model):
    from app.services.tools import execute_tool

    with patch("app.services.tools.ifc_service") as svc:
        svc.is_loaded = True
        svc.model = rel_model["model"]
        result = execute_tool("get_element_relationships", {"element_id": 999999})
    assert "error" in result
    assert "not found" in result["error"]


def test_execute_tool_relationships_no_model():
    from app.services.tools import execute_tool

    with patch("app.services.tools.ifc_service") as svc:
        svc.is_loaded = False
        result = execute_tool("get_element_relationships", {"element_id": 1})
    assert result == {"error": "No IFC model is currently loaded."}
