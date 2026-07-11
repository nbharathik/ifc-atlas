"""Tests for create_wall_from_ends and delete_element tool execution paths.

Pure unit tests - no IfcOpenShell / file-system dependency.
We mock ifc_service + sandbox_service.propose_edit to verify the ops
constructed by execute_tool match the expected shapes.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_envelope(edit_id: str = "abc123") -> MagicMock:
    env = MagicMock()
    env.edit_id = edit_id
    env.summary = "1 created"
    env.counts = {"created": 1, "total": 1}
    env.changes = []
    return env


def _run_create(arguments: dict, envelope=None) -> dict:
    """Execute create_wall_from_ends via execute_tool with mocked deps."""
    from app.services.tools import execute_tool

    if envelope is None:
        envelope = _make_envelope()

    with (
        patch("app.services.tools.ifc_service") as mock_svc,
        patch("app.services.tools.sandbox_service") as mock_sb,
    ):
        mock_svc.is_loaded = True
        mock_sb.propose_edit.return_value = envelope
        result = execute_tool("create_wall_from_ends", arguments)
        return result, mock_sb.propose_edit.call_args


def _run_delete(arguments: dict, envelope=None, entity_name="Wall-1", entity_type="IfcWallStandardCase") -> dict:
    """Execute delete_element via execute_tool with mocked deps."""
    from app.services.tools import execute_tool

    if envelope is None:
        envelope = _make_envelope()

    mock_entity = SimpleNamespace(Name=entity_name)
    mock_entity.is_a = lambda: entity_type

    with (
        patch("app.services.tools.ifc_service") as mock_svc,
        patch("app.services.tools.sandbox_service") as mock_sb,
    ):
        mock_svc.is_loaded = True
        mock_svc.model = MagicMock()
        mock_svc.model.by_id.return_value = mock_entity
        mock_sb.propose_edit.return_value = envelope
        result = execute_tool("delete_element", arguments)
        return result, mock_sb.propose_edit.call_args


# ---------------------------------------------------------------------------
# create_wall_from_ends - happy path
# ---------------------------------------------------------------------------

def test_create_wall_returns_pending_edit():
    result, _ = _run_create({"start": [0.0, 0.0], "end": [5.0, 0.0]})
    assert result["action"] == "pending_edit"


def test_create_wall_has_edit_id():
    result, _ = _run_create({"start": [0.0, 0.0], "end": [3.0, 4.0]})
    assert "edit_id" in result
    assert result["edit_id"] == "abc123"


def test_create_wall_passes_create_wall_op():
    _, call = _run_create({"start": [1.0, 2.0], "end": [4.0, 2.0]})
    ops = call.kwargs["operations"]
    assert len(ops) == 1
    assert ops[0]["op"] == "create_wall"


def test_create_wall_passes_start_end():
    _, call = _run_create({"start": [1.0, 0.0], "end": [6.0, 0.0]})
    op = call.kwargs["operations"][0]
    assert op["start"] == [1.0, 0.0]
    assert op["end"] == [6.0, 0.0]


def test_create_wall_default_height_and_thickness():
    _, call = _run_create({"start": [0.0, 0.0], "end": [5.0, 0.0]})
    op = call.kwargs["operations"][0]
    assert op["height"] == 3.0
    assert op["thickness"] == 0.2


def test_create_wall_custom_height_and_thickness():
    _, call = _run_create({"start": [0.0, 0.0], "end": [5.0, 0.0], "height": 4.5, "thickness": 0.3})
    op = call.kwargs["operations"][0]
    assert op["height"] == 4.5
    assert op["thickness"] == 0.3


def test_create_wall_passes_storey_name():
    _, call = _run_create({"start": [0.0, 0.0], "end": [5.0, 0.0], "storey_name": "Ground Floor"})
    op = call.kwargs["operations"][0]
    assert op["storey_name"] == "Ground Floor"


def test_create_wall_default_name():
    _, call = _run_create({"start": [0.0, 0.0], "end": [5.0, 0.0]})
    op = call.kwargs["operations"][0]
    assert op["name"] == "Wall"


def test_create_wall_custom_name():
    _, call = _run_create({"start": [0.0, 0.0], "end": [5.0, 0.0], "name": "Exterior Wall"})
    op = call.kwargs["operations"][0]
    assert op["name"] == "Exterior Wall"


def test_create_wall_summary_contains_coords():
    result, call = _run_create({"start": [0.0, 0.0], "end": [5.0, 0.0]})
    summary = call.kwargs["summary"]
    assert "0.00" in summary
    assert "5.00" in summary


def test_create_wall_note_says_pending():
    result, _ = _run_create({"start": [0.0, 0.0], "end": [5.0, 0.0]})
    assert "PENDING" in result["note"]


def test_create_wall_noop_returns_pending_noop():
    result, _ = _run_create({"start": [0.0, 0.0], "end": [5.0, 0.0]}, envelope=None)
    # When envelope is None, propose_edit returns None → pending_noop
    from app.services.tools import execute_tool
    with (
        patch("app.services.tools.ifc_service") as mock_svc,
        patch("app.services.tools.sandbox_service") as mock_sb,
    ):
        mock_svc.is_loaded = True
        mock_sb.propose_edit.return_value = None
        res = execute_tool("create_wall_from_ends", {"start": [0.0, 0.0], "end": [5.0, 0.0]})
    assert res["action"] == "pending_noop"


# ---------------------------------------------------------------------------
# create_wall_from_ends - error paths
# ---------------------------------------------------------------------------

def test_create_wall_missing_start_returns_error():
    from app.services.tools import execute_tool
    with patch("app.services.tools.ifc_service") as mock_svc:
        mock_svc.is_loaded = True
        result = execute_tool("create_wall_from_ends", {"end": [5.0, 0.0]})
    assert "error" in result


def test_create_wall_missing_end_returns_error():
    from app.services.tools import execute_tool
    with patch("app.services.tools.ifc_service") as mock_svc:
        mock_svc.is_loaded = True
        result = execute_tool("create_wall_from_ends", {"start": [0.0, 0.0]})
    assert "error" in result


def test_create_wall_tool_in_definitions():
    from app.services.tools import TOOL_DEFINITIONS
    names = [t["name"] for t in TOOL_DEFINITIONS]
    assert "create_wall_from_ends" in names


def test_create_wall_where_is_server():
    from app.services.tools import TOOL_DEFINITIONS
    tool = next(t for t in TOOL_DEFINITIONS if t["name"] == "create_wall_from_ends")
    assert tool["where"] == "server"


# ---------------------------------------------------------------------------
# delete_element - happy path
# ---------------------------------------------------------------------------

def test_delete_element_returns_pending_edit():
    result, _ = _run_delete({"element_id": 42})
    assert result["action"] == "pending_edit"


def test_delete_element_has_edit_id():
    result, _ = _run_delete({"element_id": 42})
    assert result["edit_id"] == "abc123"


def test_delete_element_passes_delete_op():
    _, call = _run_delete({"element_id": 42})
    ops = call.kwargs["operations"]
    assert len(ops) == 1
    assert ops[0]["op"] == "delete_element"
    assert ops[0]["element_id"] == 42


def test_delete_element_summary_contains_type_and_name():
    _, call = _run_delete({"element_id": 42}, entity_name="W-101", entity_type="IfcWall")
    summary = call.kwargs["summary"]
    assert "IfcWall" in summary
    assert "W-101" in summary


def test_delete_element_summary_includes_reason():
    _, call = _run_delete({"element_id": 42, "reason": "Obsolete element"})
    summary = call.kwargs["summary"]
    assert "Obsolete element" in summary


def test_delete_element_note_says_pending():
    result, _ = _run_delete({"element_id": 42})
    assert "PENDING" in result["note"]


def test_delete_element_noop_returns_pending_noop():
    from app.services.tools import execute_tool

    mock_entity = SimpleNamespace(Name="Wall")
    mock_entity.is_a = lambda: "IfcWall"

    with (
        patch("app.services.tools.ifc_service") as mock_svc,
        patch("app.services.tools.sandbox_service") as mock_sb,
    ):
        mock_svc.is_loaded = True
        mock_svc.model = MagicMock()
        mock_svc.model.by_id.return_value = mock_entity
        mock_sb.propose_edit.return_value = None
        result = execute_tool("delete_element", {"element_id": 42})
    assert result["action"] == "pending_noop"


# ---------------------------------------------------------------------------
# delete_element - error paths
# ---------------------------------------------------------------------------

def test_delete_element_missing_id_returns_error():
    from app.services.tools import execute_tool
    with patch("app.services.tools.ifc_service") as mock_svc:
        mock_svc.is_loaded = True
        result = execute_tool("delete_element", {})
    assert "error" in result


def test_delete_element_entity_not_found_returns_error():
    from app.services.tools import execute_tool
    with (
        patch("app.services.tools.ifc_service") as mock_svc,
        patch("app.services.tools.sandbox_service"),
    ):
        mock_svc.is_loaded = True
        mock_svc.model = MagicMock()
        mock_svc.model.by_id.side_effect = RuntimeError("not found")
        result = execute_tool("delete_element", {"element_id": 9999})
    assert "error" in result


def test_delete_element_tool_in_definitions():
    from app.services.tools import TOOL_DEFINITIONS
    names = [t["name"] for t in TOOL_DEFINITIONS]
    assert "delete_element" in names


def test_delete_element_where_is_server():
    from app.services.tools import TOOL_DEFINITIONS
    tool = next(t for t in TOOL_DEFINITIONS if t["name"] == "delete_element")
    assert tool["where"] == "server"


# ---------------------------------------------------------------------------
# element_factory.find_storey (pure unit - no IFC file). The sandbox wall /
# delete recipes now delegate to element_factory, the single shared authoring
# code path for AI-staged and human/MCP direct edits.
# ---------------------------------------------------------------------------

def _make_storey(name: str, elevation: float = 0.0) -> SimpleNamespace:
    s = SimpleNamespace(Name=name, Elevation=elevation)
    return s


def test_find_storey_exact_match():
    from app.services.element_factory import find_storey

    storeys = [_make_storey("Ground Floor"), _make_storey("First Floor")]
    model = MagicMock()
    model.by_type.return_value = storeys

    result = find_storey(model, "Ground Floor")
    assert result.Name == "Ground Floor"


def test_find_storey_case_insensitive():
    from app.services.element_factory import find_storey

    storeys = [_make_storey("Ground Floor")]
    model = MagicMock()
    model.by_type.return_value = storeys

    result = find_storey(model, "ground floor")
    assert result.Name == "Ground Floor"


def test_find_storey_fuzzy_contains():
    from app.services.element_factory import find_storey

    storeys = [_make_storey("Level 0 - Ground"), _make_storey("Level 1 - First")]
    model = MagicMock()
    model.by_type.return_value = storeys

    result = find_storey(model, "First")
    assert "First" in result.Name


def test_find_storey_none_returns_lowest_elevation():
    from app.services.element_factory import find_storey

    storeys = [_make_storey("Level 1", 3.0), _make_storey("Level 0", 0.0)]
    model = MagicMock()
    model.by_type.return_value = storeys

    result = find_storey(model, None)
    assert result.Name == "Level 0", "default storey is the lowest elevation, deterministically"


def test_find_storey_no_storeys_raises():
    from app.services.element_factory import find_storey

    model = MagicMock()
    model.by_type.return_value = []

    with pytest.raises(ValueError, match="no IfcBuildingStorey"):
        find_storey(model, None)
