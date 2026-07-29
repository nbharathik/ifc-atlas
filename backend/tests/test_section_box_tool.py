"""Tests for viewer_control action='clip_section_box' and its WS event routing.

Pure unit tests - no IfcOpenShell / file-system dependency.
"""

from __future__ import annotations

from unittest.mock import patch


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run(arguments: dict, element_exists: bool = True) -> dict:
    """Execute viewer_control clip_section_box with a mocked ifc_service."""
    from app.services.tools import execute_tool

    with patch("app.services.tools.ifc_service") as mock_svc:
        mock_svc.is_loaded = True
        if element_exists:
            mock_svc.get_element.return_value = {"element_id": arguments.get("element_id"), "name": "Wall"}
        else:
            mock_svc.get_element.side_effect = ValueError("element not found")
        return execute_tool(
            "viewer_control", {"action": "clip_section_box", **arguments}
        )


# ---------------------------------------------------------------------------
# viewer_control action=clip_section_box - execute_tool
# ---------------------------------------------------------------------------

class TestClipSectionBoxTool:
    def test_happy_path_returns_clip_action(self):
        result = _run({"element_id": 42})
        assert result["action"] == "clip_section_box"
        assert result["element_id"] == 42

    def test_integer_coercion(self):
        result = _run({"element_id": "99"})
        assert isinstance(result["element_id"], int)
        assert result["element_id"] == 99

    def test_validates_element_exists(self):
        result = _run({"element_id": 9999}, element_exists=False)
        assert "error" in result

    def test_no_model_loaded_returns_error(self):
        from app.services.tools import execute_tool
        with patch("app.services.tools.ifc_service") as mock_svc:
            mock_svc.is_loaded = False
            result = execute_tool(
                "viewer_control", {"action": "clip_section_box", "element_id": 1}
            )
        assert "error" in result

    def test_missing_element_id_returns_error(self):
        from app.services.tools import execute_tool
        with patch("app.services.tools.ifc_service") as mock_svc:
            mock_svc.is_loaded = True
            result = execute_tool("viewer_control", {"action": "clip_section_box"})
        assert "error" in result


# ---------------------------------------------------------------------------
# llm_service - _map_tool_result_to_events
# ---------------------------------------------------------------------------

class TestMapClipSectionBoxEvent:
    def _map(self, result: dict) -> list:
        from app.services.llm_service import _ui_action_events
        return _ui_action_events(result)

    def test_clip_section_box_event_emitted(self):
        events = self._map({"action": "clip_section_box", "element_id": 42})
        assert len(events) == 1
        assert events[0]["type"] == "clip_section_box"
        assert events[0]["element_id"] == 42

    def test_other_actions_not_affected(self):
        events = self._map({"action": "highlight", "element_ids": [1, 2, 3]})
        assert events[0]["type"] == "highlight"


# ---------------------------------------------------------------------------
# TOOL_DEFINITIONS introspection
# ---------------------------------------------------------------------------

class TestToolCatalog:
    def test_viewer_control_in_definitions(self):
        from app.services.tools import TOOL_DEFINITIONS
        names = [t["name"] for t in TOOL_DEFINITIONS]
        assert "viewer_control" in names

    def test_viewer_control_in_tool_by_name(self):
        from app.services.tools import TOOL_BY_NAME
        assert "viewer_control" in TOOL_BY_NAME

    def test_viewer_control_tier_is_read_viewer(self):
        from app.services.tools import tool_tier
        tier_id, tier_label = tool_tier("viewer_control")
        assert tier_id == "read_viewer"
        assert "Viewer" in tier_label

    def test_viewer_control_where_is_client(self):
        from app.services.tools import TOOL_BY_NAME, tool_where
        assert TOOL_BY_NAME["viewer_control"]["where"] == "client"
        assert tool_where("viewer_control", {"action": "clip_section_box"}) == "client"

    def test_viewer_control_has_clip_action_in_enum(self):
        from app.services.tools import TOOL_BY_NAME
        params = TOOL_BY_NAME["viewer_control"]["parameters"]
        assert "clip_section_box" in params["properties"]["action"]["enum"]
        assert params["properties"]["element_id"]["type"] == "integer"
        assert "action" in params["required"]
