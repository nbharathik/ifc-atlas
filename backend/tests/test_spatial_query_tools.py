"""Tests for the spatial query paths of the merged catalog.

get_element(include=connections|material|openings) and
query_elements(mode='type_name') absorb the four pre-merge spatial query
tools. Pure unit tests - no IfcOpenShell / file-system dependency.
We mock ifc_service to verify that execute_tool calls the right service
method with the right arguments and surfaces errors cleanly.
"""

from __future__ import annotations

from unittest.mock import patch


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_INCLUDE_METHOD = {
    "connections": "get_connected_elements",
    "material": "get_element_material",
    "openings": "get_openings_for_element",
}


def _run_element(include: str, arguments: dict, svc_return: dict) -> dict:
    """Execute get_element with one include aspect and a mocked ifc_service."""
    from app.services.tools import execute_tool

    with patch("app.services.tools.ifc_service") as mock_svc:
        mock_svc.is_loaded = True
        getattr(mock_svc, _INCLUDE_METHOD[include]).return_value = svc_return
        return execute_tool(
            "get_element", {**arguments, "include": [include]}
        )


def _run_type_name(arguments: dict, svc_return: dict) -> dict:
    """Execute query_elements mode='type_name' with a mocked ifc_service."""
    from app.services.tools import execute_tool

    with patch("app.services.tools.ifc_service") as mock_svc:
        mock_svc.is_loaded = True
        mock_svc.find_elements_by_type_name.return_value = svc_return
        return execute_tool(
            "query_elements", {"mode": "type_name", **arguments}
        )


# ---------------------------------------------------------------------------
# get_element include=connections
# ---------------------------------------------------------------------------

class TestGetConnectedElements:
    def test_returns_service_result(self):
        expected = {"element_id": 42, "count": 2, "connected_elements": [
            {"id": 10, "name": "Wall A", "ifc_type": "IfcWallStandardCase", "connection_type": "ATSTART"},
        ]}
        result = _run_element("connections", {"element_id": 42}, expected)
        assert result["count"] == 2
        assert result["connected_elements"][0]["id"] == 10

    def test_missing_element_id_returns_error(self):
        from app.services.tools import execute_tool
        with patch("app.services.tools.ifc_service") as mock_svc:
            mock_svc.is_loaded = True
            result = execute_tool("get_element", {"include": ["connections"]})
        assert "error" in result
        assert "element_id" in result["error"]

    def test_no_model_loaded_returns_error(self):
        from app.services.tools import execute_tool
        with patch("app.services.tools.ifc_service") as mock_svc:
            mock_svc.is_loaded = False
            result = execute_tool(
                "get_element", {"element_id": 1, "include": ["connections"]}
            )
        assert "error" in result

    def test_service_raises_value_error(self):
        from app.services.tools import execute_tool
        with patch("app.services.tools.ifc_service") as mock_svc:
            mock_svc.is_loaded = True
            mock_svc.get_connected_elements.side_effect = ValueError("Element 999 not found")
            result = execute_tool(
                "get_element", {"element_id": 999, "include": ["connections"]}
            )
        assert "error" in result
        assert "999" in result["error"]

    def test_element_id_coerced_to_int(self):
        from app.services.tools import execute_tool
        with patch("app.services.tools.ifc_service") as mock_svc:
            mock_svc.is_loaded = True
            mock_svc.get_connected_elements.return_value = {"element_id": 7, "count": 0, "connected_elements": []}
            execute_tool("get_element", {"element_id": "7", "include": ["connections"]})
            mock_svc.get_connected_elements.assert_called_once_with(7)

    def test_zero_connections_returns_empty_list(self):
        result = _run_element("connections", {"element_id": 5},
                              {"element_id": 5, "count": 0, "connected_elements": []})
        assert result["count"] == 0
        assert result["connected_elements"] == []


# ---------------------------------------------------------------------------
# get_element include=material
# ---------------------------------------------------------------------------

class TestGetElementMaterial:
    def test_layer_set_result(self):
        expected = {
            "element_id": 10,
            "material_type": "layer_set",
            "layer_set_name": "Exterior Wall",
            "layers": [{"name": "Concrete", "thickness_mm": 200.0}],
            "total_thickness_mm": 200.0,
        }
        result = _run_element("material", {"element_id": 10}, expected)
        assert result["material_type"] == "layer_set"
        assert result["total_thickness_mm"] == 200.0

    def test_single_material_result(self):
        expected = {"element_id": 3, "material_type": "single", "name": "Wood", "layers": []}
        result = _run_element("material", {"element_id": 3}, expected)
        assert result["name"] == "Wood"

    def test_none_material(self):
        expected = {"element_id": 99, "material_type": "none", "layers": []}
        result = _run_element("material", {"element_id": 99}, expected)
        assert result["material_type"] == "none"

    def test_missing_element_id_returns_error(self):
        from app.services.tools import execute_tool
        with patch("app.services.tools.ifc_service") as mock_svc:
            mock_svc.is_loaded = True
            result = execute_tool("get_element", {"include": ["material"]})
        assert "error" in result

    def test_element_id_coerced_to_int(self):
        from app.services.tools import execute_tool
        with patch("app.services.tools.ifc_service") as mock_svc:
            mock_svc.is_loaded = True
            mock_svc.get_element_material.return_value = {"element_id": 5, "material_type": "none", "layers": []}
            execute_tool("get_element", {"element_id": "5", "include": ["material"]})
            mock_svc.get_element_material.assert_called_once_with(5)


# ---------------------------------------------------------------------------
# get_element include=openings
# ---------------------------------------------------------------------------

class TestGetOpeningsForElement:
    def test_returns_hosted_doors_windows(self):
        expected = {
            "element_id": 20,
            "count": 2,
            "openings": [
                {"id": 30, "name": "Window 01", "ifc_type": "IfcWindow"},
                {"id": 31, "name": "Door 01", "ifc_type": "IfcDoor"},
            ],
        }
        result = _run_element("openings", {"element_id": 20}, expected)
        assert result["count"] == 2
        types = {o["ifc_type"] for o in result["openings"]}
        assert "IfcWindow" in types

    def test_no_openings(self):
        expected = {"element_id": 8, "count": 0, "openings": []}
        result = _run_element("openings", {"element_id": 8}, expected)
        assert result["openings"] == []

    def test_missing_element_id_returns_error(self):
        from app.services.tools import execute_tool
        with patch("app.services.tools.ifc_service") as mock_svc:
            mock_svc.is_loaded = True
            result = execute_tool("get_element", {"include": ["openings"]})
        assert "error" in result

    def test_element_id_coerced_to_int(self):
        from app.services.tools import execute_tool
        with patch("app.services.tools.ifc_service") as mock_svc:
            mock_svc.is_loaded = True
            mock_svc.get_openings_for_element.return_value = {"element_id": 20, "count": 0, "openings": []}
            execute_tool("get_element", {"element_id": "20", "include": ["openings"]})
            mock_svc.get_openings_for_element.assert_called_once_with(20)

    def test_service_raises_value_error(self):
        from app.services.tools import execute_tool
        with patch("app.services.tools.ifc_service") as mock_svc:
            mock_svc.is_loaded = True
            mock_svc.get_openings_for_element.side_effect = ValueError("Element 0 not found")
            result = execute_tool(
                "get_element", {"element_id": 0, "include": ["openings"]}
            )
        assert "error" in result


# ---------------------------------------------------------------------------
# get_element multi-include composition
# ---------------------------------------------------------------------------

class TestGetElementMultiInclude:
    def test_combines_aspects_under_keys(self):
        from app.services.tools import execute_tool
        with patch("app.services.tools.ifc_service") as mock_svc:
            mock_svc.is_loaded = True
            mock_svc.get_element_material.return_value = {"element_id": 5, "material_type": "none", "layers": []}
            mock_svc.get_openings_for_element.return_value = {"element_id": 5, "count": 0, "openings": []}
            result = execute_tool(
                "get_element", {"element_id": 5, "include": ["material", "openings"]}
            )
        assert result["element_id"] == 5
        assert result["material"]["material_type"] == "none"
        assert result["openings"]["count"] == 0

    def test_unknown_include_returns_error(self):
        from app.services.tools import execute_tool
        with patch("app.services.tools.ifc_service") as mock_svc:
            mock_svc.is_loaded = True
            result = execute_tool(
                "get_element", {"element_id": 5, "include": ["bogus"]}
            )
        assert "error" in result
        assert "bogus" in result["error"]


# ---------------------------------------------------------------------------
# query_elements mode=type_name
# ---------------------------------------------------------------------------

class TestFindElementsByTypeName:
    def test_returns_matching_elements(self):
        expected = {
            "query": "Paroc",
            "count": 3,
            "elements": [
                {"id": 1, "name": "Wall-01", "ifc_type": "IfcWallStandardCase",
                 "type_name": "Basic Wall:Yttervägg Paroc", "storey": "Floor 0"},
            ],
        }
        result = _run_type_name({"query": "Paroc"}, expected)
        assert result["count"] == 3
        assert "Paroc" in result["elements"][0]["type_name"]

    def test_empty_query_returns_error(self):
        from app.services.tools import execute_tool
        with patch("app.services.tools.ifc_service") as mock_svc:
            mock_svc.is_loaded = True
            result = execute_tool("query_elements", {"mode": "type_name", "query": "   "})
        assert "error" in result

    def test_missing_query_returns_error(self):
        from app.services.tools import execute_tool
        with patch("app.services.tools.ifc_service") as mock_svc:
            mock_svc.is_loaded = True
            result = execute_tool("query_elements", {"mode": "type_name"})
        assert "error" in result

    def test_limit_capped_at_200(self):
        from app.services.tools import execute_tool
        with patch("app.services.tools.ifc_service") as mock_svc:
            mock_svc.is_loaded = True
            mock_svc.find_elements_by_type_name.return_value = {"query": "x", "count": 0, "elements": []}
            execute_tool("query_elements", {"mode": "type_name", "query": "x", "limit": 9999})
            mock_svc.find_elements_by_type_name.assert_called_once_with("x", limit=200)

    def test_default_limit_50(self):
        from app.services.tools import execute_tool
        with patch("app.services.tools.ifc_service") as mock_svc:
            mock_svc.is_loaded = True
            mock_svc.find_elements_by_type_name.return_value = {"query": "door", "count": 0, "elements": []}
            execute_tool("query_elements", {"mode": "type_name", "query": "door"})
            mock_svc.find_elements_by_type_name.assert_called_once_with("door", limit=50)

    def test_empty_results(self):
        expected = {"query": "nonexistent", "count": 0, "elements": []}
        result = _run_type_name({"query": "nonexistent"}, expected)
        assert result["count"] == 0
        assert result["elements"] == []

    def test_no_model_loaded_returns_error(self):
        from app.services.tools import execute_tool
        with patch("app.services.tools.ifc_service") as mock_svc:
            mock_svc.is_loaded = False
            result = execute_tool("query_elements", {"mode": "type_name", "query": "wall"})
        assert "error" in result


# ---------------------------------------------------------------------------
# Tool catalog completeness
# ---------------------------------------------------------------------------

class TestToolCatalogRegistration:
    MERGED_TOOLS = ["get_element", "query_elements"]

    def test_merged_tools_in_catalog(self):
        from app.services.tools import get_tool_catalog
        names = {t["name"] for t in get_tool_catalog()}
        for tool in self.MERGED_TOOLS:
            assert tool in names, f"{tool} missing from tool catalog"

    def test_legacy_names_absent_from_catalog(self):
        from app.services.tools import get_tool_catalog
        names = {t["name"] for t in get_tool_catalog()}
        for legacy in (
            "get_connected_elements",
            "get_element_material",
            "get_openings_for_element",
            "find_elements_by_type_name",
        ):
            assert legacy not in names

    def test_merged_tools_have_read_model_tier(self):
        from app.services.tools import tool_tier
        for tool in self.MERGED_TOOLS:
            tier_id, _ = tool_tier(tool)
            assert tier_id == "read_model", f"{tool} has wrong tier"

    def test_openai_tools_include_merged_tools(self):
        from app.services.tools import get_openai_tools
        names = {t["function"]["name"] for t in get_openai_tools()}
        for tool in self.MERGED_TOOLS:
            assert tool in names

    def test_anthropic_tools_include_merged_tools(self):
        from app.services.tools import get_anthropic_tools
        names = {t["name"] for t in get_anthropic_tools()}
        for tool in self.MERGED_TOOLS:
            assert tool in names
