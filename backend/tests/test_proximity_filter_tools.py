"""Tests for find_nearby_elements and filter_by_property_value.

Pure unit tests: no real IfcOpenShell model, no file I/O.
IfcService methods are tested directly (mocked ifcopenshell internals).
Tool routing is tested via execute_tool with a patched ifc_service.
"""

from __future__ import annotations

from typing import TYPE_CHECKING
from unittest.mock import MagicMock, patch

import pytest

if TYPE_CHECKING:
    from app.services.ifc_service import IfcService


# ---------------------------------------------------------------------------
# Helpers for ifc_service unit tests
# ---------------------------------------------------------------------------

def _make_entity(
    eid: int,
    name: str = "Wall-1",
    ifc_type: str = "IfcWall",
    coords: tuple | None = (0.0, 0.0, 0.0),
    psets: list | None = None,
) -> MagicMock:
    """Build a minimal mock IfcOpenShell entity with optional placement + psets."""
    entity = MagicMock()
    entity.id.return_value = eid
    entity.GlobalId = f"GUID-{eid}"
    entity.Name = name
    entity.is_a.side_effect = lambda t=None: ifc_type if t is None else (ifc_type == t or ifc_type.startswith(t))

    # Build placement hierarchy
    if coords is not None:
        loc = MagicMock()
        loc.Coordinates = list(coords)
        rel_pl = MagicMock()
        rel_pl.Location = loc
        placement = MagicMock()
        placement.is_a.return_value = True  # is_a("IfcLocalPlacement")
        placement.RelativePlacement = rel_pl
        entity.ObjectPlacement = placement
    else:
        entity.ObjectPlacement = None

    # Build property sets
    entity.IsDefinedBy = []
    if psets:
        for pset_name, props in psets:
            pset = MagicMock()
            pset.Name = pset_name
            pset.is_a.return_value = True  # is_a("IfcPropertySet")
            pset_props = []
            for prop_name, prop_val in props:
                p = MagicMock()
                p.Name = prop_name
                p.is_a.return_value = True  # is_a("IfcPropertySingleValue")
                nom = MagicMock()
                nom.wrappedValue = prop_val
                p.NominalValue = nom
                pset_props.append(p)
            pset.HasProperties = pset_props

            rel = MagicMock()
            rel.is_a.return_value = True  # is_a("IfcRelDefinesByProperties")
            rel.RelatingPropertyDefinition = pset
            entity.IsDefinedBy.append(rel)

    return entity


def _make_service_with_entities(entities: list) -> MagicMock:
    """Build a mock ifc_service with a model containing the given entities."""
    svc = MagicMock()
    svc.is_loaded = True

    model = MagicMock()
    model.by_type.return_value = entities
    model.by_id.side_effect = lambda eid: next((e for e in entities if e.id() == eid), None)
    svc._model = model
    return svc


# ---------------------------------------------------------------------------
# _get_element_origin
# ---------------------------------------------------------------------------

def test_get_element_origin_returns_coords():
    from app.services.ifc_service import IfcService

    svc = IfcService.__new__(IfcService)
    entity = _make_entity(1, coords=(10.0, 20.0, 3.0))
    assert svc._get_element_origin(entity) == (10.0, 20.0, 3.0)


def test_get_element_origin_none_when_no_placement():
    from app.services.ifc_service import IfcService

    svc = IfcService.__new__(IfcService)
    entity = _make_entity(1, coords=None)
    assert svc._get_element_origin(entity) is None


def test_get_element_origin_two_coord_entity():
    from app.services.ifc_service import IfcService

    svc = IfcService.__new__(IfcService)
    entity = _make_entity(1, coords=(5.0, 7.0))
    # coords list has only 2 items - z should default to 0.0
    result = svc._get_element_origin(entity)
    assert result is not None
    assert result[0] == 5.0
    assert result[1] == 7.0
    assert result[2] == 0.0


# ---------------------------------------------------------------------------
# find_nearby_elements - unit tests against IfcService directly
# ---------------------------------------------------------------------------

def _make_nearby_svc() -> "IfcService":
    """Build an IfcService instance with 3 entities at known positions."""
    from app.services.ifc_service import IfcService

    ref = _make_entity(1, name="Ref-Col", ifc_type="IfcColumn", coords=(0.0, 0.0, 0.0))
    near = _make_entity(2, name="Near-Wall", ifc_type="IfcWall", coords=(3.0, 0.0, 0.0))
    far = _make_entity(3, name="Far-Slab", ifc_type="IfcSlab", coords=(100.0, 0.0, 0.0))

    svc = IfcService.__new__(IfcService)
    model = MagicMock()
    model.by_type.return_value = [ref, near, far]
    model.by_id.side_effect = lambda eid: {1: ref, 2: near, 3: far}.get(eid)
    svc._model = model
    svc._storey_cache = {}
    # Stub _get_storey to return None (not needed for proximity)
    svc._get_storey = MagicMock(return_value=None)
    return svc


def test_find_nearby_returns_close_elements():
    svc = _make_nearby_svc()
    result = svc.find_nearby_elements(element_id=1, radius_m=5.0)
    assert result["count"] == 1
    assert result["elements"][0]["id"] == 2
    assert result["elements"][0]["distance_m"] == pytest.approx(3.0)


def test_find_nearby_excludes_far_elements():
    svc = _make_nearby_svc()
    result = svc.find_nearby_elements(element_id=1, radius_m=5.0)
    ids = [e["id"] for e in result["elements"]]
    assert 3 not in ids


def test_find_nearby_with_ifc_type_filter():
    svc = _make_nearby_svc()
    result = svc.find_nearby_elements(element_id=1, radius_m=10.0, ifc_types=["IfcSlab"])
    # Near-Wall (IfcWall) is excluded; Far-Slab too far
    assert result["count"] == 0


def test_find_nearby_excludes_reference_element():
    svc = _make_nearby_svc()
    result = svc.find_nearby_elements(element_id=1, radius_m=1000.0)
    ids = [e["id"] for e in result["elements"]]
    assert 1 not in ids


def test_find_nearby_no_placement_skipped():
    from app.services.ifc_service import IfcService

    ref = _make_entity(1, coords=(0.0, 0.0, 0.0))
    no_placement = _make_entity(2, coords=None)

    svc = IfcService.__new__(IfcService)
    model = MagicMock()
    model.by_type.return_value = [ref, no_placement]
    model.by_id.side_effect = lambda eid: {1: ref, 2: no_placement}.get(eid)
    svc._model = model
    svc._storey_cache = {}
    svc._get_storey = MagicMock(return_value=None)

    result = svc.find_nearby_elements(element_id=1, radius_m=100.0)
    assert result["count"] == 0


def test_find_nearby_invalid_radius_raises():
    svc = _make_nearby_svc()
    with pytest.raises(ValueError, match="radius_m must be positive"):
        svc.find_nearby_elements(element_id=1, radius_m=-1.0)


def test_find_nearby_ref_has_no_placement_returns_note():
    from app.services.ifc_service import IfcService

    ref = _make_entity(1, coords=None)
    svc = IfcService.__new__(IfcService)
    model = MagicMock()
    model.by_type.return_value = [ref]
    model.by_id.side_effect = lambda eid: {1: ref}.get(eid)
    svc._model = model
    svc._storey_cache = {}

    result = svc.find_nearby_elements(element_id=1, radius_m=5.0)
    assert "note" in result
    assert result["count"] == 0


def test_find_nearby_sorted_by_distance():
    from app.services.ifc_service import IfcService

    ref = _make_entity(1, coords=(0.0, 0.0, 0.0))
    e2 = _make_entity(2, coords=(4.0, 0.0, 0.0))
    e3 = _make_entity(3, coords=(2.0, 0.0, 0.0))

    svc = IfcService.__new__(IfcService)
    model = MagicMock()
    model.by_type.return_value = [ref, e2, e3]
    model.by_id.side_effect = lambda eid: {1: ref, 2: e2, 3: e3}.get(eid)
    svc._model = model
    svc._storey_cache = {}
    svc._get_storey = MagicMock(return_value=None)

    result = svc.find_nearby_elements(element_id=1, radius_m=10.0)
    dists = [e["distance_m"] for e in result["elements"]]
    assert dists == sorted(dists)


# ---------------------------------------------------------------------------
# filter_by_property_value - unit tests
# ---------------------------------------------------------------------------

def _make_prop_svc() -> "IfcService":
    """IfcService with two entities with known property sets."""
    from app.services.ifc_service import IfcService

    wall1 = _make_entity(
        10, name="ExtWall", ifc_type="IfcWall",
        psets=[("Pset_WallCommon", [("FireRating", "2h"), ("IsExternal", True)])],
    )
    wall2 = _make_entity(
        11, name="IntWall", ifc_type="IfcWall",
        psets=[("Pset_WallCommon", [("FireRating", "30min"), ("IsExternal", False)])],
    )
    door = _make_entity(
        12, name="Door-1", ifc_type="IfcDoor",
        psets=[("Pset_DoorCommon", [("FireRating", "2h"), ("IsExternal", True)])],
    )
    slab = _make_entity(
        13, name="Slab-1", ifc_type="IfcSlab",
        psets=[("BaseQuantities", [("GrossArea", "45.2")])],
    )

    svc = IfcService.__new__(IfcService)
    model = MagicMock()
    model.by_type.return_value = [wall1, wall2, door, slab]
    svc._model = model
    svc._storey_cache = {}
    svc._get_storey = MagicMock(return_value=None)
    return svc


def test_filter_eq_operator():
    svc = _make_prop_svc()
    result = svc.filter_by_property_value("FireRating", "eq", "2h")
    assert result["count"] == 2
    ids = {e["id"] for e in result["elements"]}
    assert ids == {10, 12}


def test_filter_neq_operator():
    svc = _make_prop_svc()
    result = svc.filter_by_property_value("FireRating", "neq", "2h")
    ids = {e["id"] for e in result["elements"]}
    assert 11 in ids
    assert 10 not in ids


def test_filter_contains_operator():
    svc = _make_prop_svc()
    result = svc.filter_by_property_value("FireRating", "contains", "min")
    assert result["count"] == 1
    assert result["elements"][0]["id"] == 11


def test_filter_startswith_operator():
    svc = _make_prop_svc()
    result = svc.filter_by_property_value("FireRating", "startswith", "2")
    ids = {e["id"] for e in result["elements"]}
    assert ids == {10, 12}


def test_filter_ifc_type_scoping():
    svc = _make_prop_svc()
    result = svc.filter_by_property_value("FireRating", "eq", "2h", ifc_type="IfcWall")
    assert result["count"] == 1
    assert result["elements"][0]["id"] == 10


def test_filter_gt_numeric_operator():
    svc = _make_prop_svc()
    result = svc.filter_by_property_value("GrossArea", "gt", "40.0")
    assert result["count"] == 1
    assert result["elements"][0]["id"] == 13


def test_filter_lt_numeric_operator():
    svc = _make_prop_svc()
    result = svc.filter_by_property_value("GrossArea", "lt", "40.0")
    assert result["count"] == 0


def test_filter_lte_numeric_operator():
    svc = _make_prop_svc()
    result = svc.filter_by_property_value("GrossArea", "lte", "45.2")
    assert result["count"] == 1


def test_filter_invalid_operator_raises():
    svc = _make_prop_svc()
    with pytest.raises(ValueError, match="operator must be one of"):
        svc.filter_by_property_value("Name", "regex", "Wall.*")


def test_filter_invalid_numeric_value_raises():
    svc = _make_prop_svc()
    with pytest.raises(ValueError, match="numeric value"):
        svc.filter_by_property_value("GrossArea", "gt", "not-a-number")


def test_filter_element_ids_returned():
    svc = _make_prop_svc()
    result = svc.filter_by_property_value("FireRating", "eq", "2h")
    assert set(result["element_ids"]) == {10, 12}


def test_filter_no_matches_empty_result():
    svc = _make_prop_svc()
    result = svc.filter_by_property_value("FireRating", "eq", "999h")
    assert result["count"] == 0
    assert result["elements"] == []
    assert result["element_ids"] == []


# ---------------------------------------------------------------------------
# execute_tool routing
# ---------------------------------------------------------------------------

def _run_tool(name: str, arguments: dict, service_return: dict) -> dict:
    from app.services.tools import execute_tool

    with patch("app.services.tools.ifc_service") as mock_svc:
        mock_svc.is_loaded = True
        method_name = name  # find_nearby_elements / filter_by_property_value
        getattr(mock_svc, method_name).return_value = service_return
        return execute_tool(name, arguments)


def test_execute_tool_find_nearby():
    result = _run_tool(
        "find_nearby_elements",
        {"element_id": 1, "radius_m": 3.0},
        {"element_id": 1, "radius_m": 3.0, "count": 1, "elements": [{"id": 2}]},
    )
    assert result["count"] == 1


def test_execute_tool_find_nearby_missing_element_id():
    from app.services.tools import execute_tool

    with patch("app.services.tools.ifc_service") as mock_svc:
        mock_svc.is_loaded = True
        result = execute_tool("find_nearby_elements", {})
    assert "error" in result
    assert "element_id" in result["error"]


def test_execute_tool_filter_by_property():
    result = _run_tool(
        "filter_by_property_value",
        {"property_name": "FireRating", "operator": "eq", "value": "2h"},
        {"count": 2, "element_ids": [10, 12], "elements": [], "property_name": "FireRating", "operator": "eq", "value": "2h", "truncated": False},
    )
    assert result["count"] == 2
    # Auto highlight action should be attached when element_ids non-empty
    assert result.get("action") == "highlight"


def test_execute_tool_filter_missing_property_name():
    from app.services.tools import execute_tool

    with patch("app.services.tools.ifc_service") as mock_svc:
        mock_svc.is_loaded = True
        result = execute_tool("filter_by_property_value", {"operator": "eq", "value": "2h"})
    assert "error" in result


def test_execute_tool_filter_missing_operator():
    from app.services.tools import execute_tool

    with patch("app.services.tools.ifc_service") as mock_svc:
        mock_svc.is_loaded = True
        result = execute_tool("filter_by_property_value", {"property_name": "FireRating", "value": "2h"})
    assert "error" in result


def test_execute_tool_filter_no_matches_no_action():
    result = _run_tool(
        "filter_by_property_value",
        {"property_name": "FireRating", "operator": "eq", "value": "999h"},
        {"count": 0, "element_ids": [], "elements": [], "property_name": "FireRating", "operator": "eq", "value": "999h", "truncated": False},
    )
    # No element_ids → no highlight action
    assert "action" not in result or result.get("action") != "highlight"
