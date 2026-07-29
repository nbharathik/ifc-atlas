"""Tests for the AABB-backed find_nearby_elements upgrade.

Covers the pure geometry helpers in app.services.aabb_service plus the
tool-router path selection: real-box surface distances when the AABB cache is
warm (geometry: "aabb"), and the legacy placement-origin fallback flagged as
approximate (geometry: "placement_origin") when it is cold.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from app.services.aabb_service import (
    aabb_center_distance,
    aabb_surface_distance,
    find_nearby_via_aabbs,
)

# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------

UNIT_BOX = ((0.0, 0.0, 0.0), (1.0, 1.0, 1.0))


def test_surface_distance_zero_for_overlap():
    other = ((0.5, 0.5, 0.5), (2.0, 2.0, 2.0))
    assert aabb_surface_distance(UNIT_BOX, other) == 0.0


def test_surface_distance_zero_for_touching():
    other = ((1.0, 0.0, 0.0), (2.0, 1.0, 1.0))
    assert aabb_surface_distance(UNIT_BOX, other) == 0.0


def test_surface_distance_single_axis_gap():
    other = ((3.0, 0.0, 0.0), (4.0, 1.0, 1.0))
    assert aabb_surface_distance(UNIT_BOX, other) == pytest.approx(2.0)
    # symmetric
    assert aabb_surface_distance(other, UNIT_BOX) == pytest.approx(2.0)


def test_surface_distance_diagonal_gap():
    other = ((4.0, 5.0, 0.0), (5.0, 6.0, 1.0))
    # gaps: x=3, y=4, z=0 -> 5
    assert aabb_surface_distance(UNIT_BOX, other) == pytest.approx(5.0)


def test_center_distance():
    other = ((2.0, 0.0, 0.0), (3.0, 1.0, 1.0))
    assert aabb_center_distance(UNIT_BOX, other) == pytest.approx(2.0)


# ---------------------------------------------------------------------------
# find_nearby_via_aabbs
# ---------------------------------------------------------------------------


def _entity(eid: int, name: str, ifc_type: str) -> MagicMock:
    e = MagicMock()
    e.id.return_value = eid
    e.Name = name
    e.is_a.side_effect = lambda t=None: ifc_type if t is None else ifc_type == t
    return e


def _model(entities: dict[int, MagicMock]) -> MagicMock:
    model = MagicMock()
    model.by_id.side_effect = lambda eid: entities.get(eid)
    return model


BOXES = {
    1: UNIT_BOX,  # reference
    2: ((1.5, 0.0, 0.0), (2.5, 1.0, 1.0)),  # 0.5 m gap
    3: ((50.0, 0.0, 0.0), (51.0, 1.0, 1.0)),  # far away
    4: ((0.2, 0.2, 0.2), (0.8, 0.8, 0.8)),  # inside the reference (overlap)
}


def _entities() -> dict[int, MagicMock]:
    return {
        1: _entity(1, "Ref-Wall", "IfcWall"),
        2: _entity(2, "Near-Column", "IfcColumn"),
        3: _entity(3, "Far-Slab", "IfcSlab"),
        4: _entity(4, "Inside-Door", "IfcDoor"),
    }


def test_aabb_query_finds_near_and_overlapping():
    result = find_nearby_via_aabbs(_model(_entities()), BOXES, 1, radius_m=2.0)
    assert result is not None
    assert result["geometry"] == "aabb"
    ids = [e["id"] for e in result["elements"]]
    assert ids == [4, 2]  # overlap (0.0) sorts before the 0.5 m gap
    assert result["elements"][0]["distance_m"] == 0.0
    assert result["elements"][1]["distance_m"] == pytest.approx(0.5)
    assert 3 not in ids
    assert 1 not in ids  # reference excluded
    assert result["boxes_cached"] == len(BOXES)


def test_aabb_query_ifc_type_filter():
    result = find_nearby_via_aabbs(
        _model(_entities()), BOXES, 1, radius_m=2.0, ifc_types=["IfcColumn"]
    )
    assert [e["id"] for e in result["elements"]] == [2]


def test_aabb_query_limit():
    result = find_nearby_via_aabbs(_model(_entities()), BOXES, 1, radius_m=2.0, limit=1)
    assert result["count"] == 1


def test_aabb_query_skips_openings():
    entities = _entities()
    entities[4] = _entity(4, "Opening", "IfcOpeningElement")
    result = find_nearby_via_aabbs(_model(entities), BOXES, 1, radius_m=2.0)
    assert [e["id"] for e in result["elements"]] == [2]


def test_aabb_query_storey_resolver_used():
    result = find_nearby_via_aabbs(
        _model(_entities()), BOXES, 1, radius_m=2.0, storey_resolver=lambda e: "Level 1"
    )
    assert all(e["storey"] == "Level 1" for e in result["elements"])


def test_aabb_query_returns_none_when_ref_not_cached():
    boxes = {k: v for k, v in BOXES.items() if k != 1}
    assert find_nearby_via_aabbs(_model(_entities()), boxes, 1, radius_m=2.0) is None


def test_aabb_query_invalid_radius_raises():
    with pytest.raises(ValueError, match="radius_m must be positive"):
        find_nearby_via_aabbs(_model(_entities()), BOXES, 1, radius_m=0.0)


# ---------------------------------------------------------------------------
# Tool-router path selection
# ---------------------------------------------------------------------------


def test_execute_tool_uses_aabb_path_when_cache_warm():
    from app.services.tools import execute_tool

    entities = _entities()
    with patch("app.services.tools.ifc_service") as svc, patch(
        "app.services.tools.aabb_service"
    ) as aabb:
        svc.is_loaded = True
        svc.model_fingerprint = "sha-test"
        svc.model = _model(entities)
        svc._get_storey = lambda e: "Level 1"
        aabb.get_all_aabbs.return_value = BOXES
        result = execute_tool(
            "query_elements", {"mode": "near", "element_id": 1, "radius_m": 2.0}
        )

    assert result["geometry"] == "aabb"
    assert result["count"] == 2
    aabb.get_all_aabbs.assert_called_once_with("sha-test")
    # The legacy placement-origin service path must NOT run.
    svc.find_nearby_elements.assert_not_called()


def test_execute_tool_falls_back_when_cache_cold():
    from app.services.tools import execute_tool

    with patch("app.services.tools.ifc_service") as svc, patch(
        "app.services.tools.aabb_service"
    ) as aabb:
        svc.is_loaded = True
        svc.model_fingerprint = "sha-test"
        aabb.get_all_aabbs.return_value = {}
        svc.find_nearby_elements.return_value = {
            "element_id": 1,
            "radius_m": 2.0,
            "count": 1,
            "elements": [{"id": 2}],
        }
        result = execute_tool(
            "query_elements", {"mode": "near", "element_id": 1, "radius_m": 2.0}
        )

    assert result["geometry"] == "placement_origin"
    assert "approximate" in result["geometry_note"]
    assert result["count"] == 1


def test_execute_tool_falls_back_when_ref_element_uncached():
    from app.services.tools import execute_tool

    boxes = {k: v for k, v in BOXES.items() if k != 1}
    with patch("app.services.tools.ifc_service") as svc, patch(
        "app.services.tools.aabb_service"
    ) as aabb:
        svc.is_loaded = True
        svc.model_fingerprint = "sha-test"
        svc.model = _model(_entities())
        aabb.get_all_aabbs.return_value = boxes
        svc.find_nearby_elements.return_value = {
            "element_id": 1,
            "radius_m": 2.0,
            "count": 0,
            "elements": [],
        }
        result = execute_tool(
            "query_elements", {"mode": "near", "element_id": 1, "radius_m": 2.0}
        )

    assert result["geometry"] == "placement_origin"
    svc.find_nearby_elements.assert_called_once()


def test_execute_tool_non_string_fingerprint_skips_aabb_probe():
    """A mocked/absent fingerprint must never reach the AABB cache."""
    from app.services.tools import execute_tool

    with patch("app.services.tools.ifc_service") as svc, patch(
        "app.services.tools.aabb_service"
    ) as aabb:
        svc.is_loaded = True  # model_fingerprint stays a MagicMock (not a str)
        svc.find_nearby_elements.return_value = {
            "element_id": 1,
            "radius_m": 5.0,
            "count": 0,
            "elements": [],
        }
        result = execute_tool("query_elements", {"mode": "near", "element_id": 1})

    aabb.get_all_aabbs.assert_not_called()
    assert result["geometry"] == "placement_origin"


def test_execute_tool_missing_element_id_still_errors():
    from app.services.tools import execute_tool

    with patch("app.services.tools.ifc_service") as svc:
        svc.is_loaded = True
        result = execute_tool("query_elements", {"mode": "near"})
    assert "error" in result
