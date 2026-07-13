"""
Tests for the MCP server (viewer-as-server) - read-only tools plus the
gated write/management tier.

Uses httpx.AsyncClient + ASGITransport to drive the Starlette SSE app directly.

Note on SSE endpoint tests: the SSE endpoint stays open streaming; auth-rejected
tests (401) return immediately. "endpoint accepts" tests use a short httpx timeout
and treat ReadTimeout as confirmation that the connection was accepted (not 401/404).
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

from app.mcp_server import build_sse_app, list_all_tool_names, list_exposed_tools
from app.mcp_server.server import _EXPOSED_TIERS, _all_tool_names, _tool_names
from app.services.tools import TOOL_DEFINITIONS, tool_tier


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_client(token: str | None = None, timeout: float = 5.0) -> AsyncClient:
    app = build_sse_app(token=token)
    return AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        timeout=timeout,
    )


# ---------------------------------------------------------------------------
# Tool catalog tests (pure Python, no HTTP)
# ---------------------------------------------------------------------------

class TestToolCatalog:
    def test_read_tools_count_at_least_ten(self):
        tools = list_exposed_tools()
        assert len(tools) >= 10, f"Expected ≥10 read tools, got {len(tools)}"

    def test_all_exposed_tools_are_read_tier(self):
        for t in list_exposed_tools():
            tier_id = tool_tier(t["name"])[0]
            assert tier_id in _EXPOSED_TIERS, (
                f"{t['name']} has tier '{tier_id}' which is not in exposed tiers"
            )

    def test_write_tools_not_exposed(self):
        write_names = {
            "rename_element", "update_property_value", "rename_elements_batch",
            "update_properties_batch", "execute_ifc_code", "create_wall_from_ends",
            "delete_element", "undo_last_edit",
        }
        exposed = {t["name"] for t in list_exposed_tools()}
        leaked = write_names & exposed
        assert not leaked, f"Write tools must not be exposed in the read-only catalog: {leaked}"

    def test_viewer_tools_not_exposed(self):
        viewer_names = {
            "highlight_elements", "select_element", "isolate_elements", "show_all_elements"
        }
        exposed = {t["name"] for t in list_exposed_tools()}
        assert not (viewer_names & exposed), "Viewer-tier tools must not be in MCP"

    def test_get_project_info_exposed(self):
        assert "get_project_info" in _tool_names

    def test_search_elements_exposed(self):
        assert "search_elements" in _tool_names

    def test_get_storeys_exposed(self):
        assert "get_storeys" in _tool_names

    def test_tool_names_match_definitions(self):
        """_tool_names must exactly match the read/validate tools in TOOL_DEFINITIONS."""
        expected = {
            t["name"] for t in TOOL_DEFINITIONS
            if tool_tier(t["name"])[0] in _EXPOSED_TIERS
        }
        assert _tool_names == expected

    def test_each_exposed_tool_has_description(self):
        for t in list_exposed_tools():
            assert t.get("description"), f"{t['name']} has no description"

    def test_each_exposed_tool_has_object_schema(self):
        for t in list_exposed_tools():
            schema = t.get("parameters", {})
            assert schema.get("type") == "object", (
                f"{t['name']} inputSchema.type != 'object'"
            )


# ---------------------------------------------------------------------------
# SSE app: auth tests
#
# Auth-rejected requests (no/wrong token) return 401 immediately.
# "Connection accepted" tests use a 1 s timeout; ReadTimeout means the server
# accepted the connection and started streaming (not 401/404).
# ---------------------------------------------------------------------------

class TestSseAuth:
    @pytest.mark.asyncio
    async def test_auth_rejected_without_token_header(self):
        """Token required but no Authorization header → 401."""
        async with _make_client(token="secret123") as client:
            resp = await client.get("/sse")
            assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_auth_rejected_wrong_token(self):
        """Wrong bearer token → 401."""
        async with _make_client(token="correct") as client:
            resp = await client.get(
                "/sse", headers={"Authorization": "Bearer wrong"}
            )
            assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_auth_rejected_wrong_scheme(self):
        """Token with non-Bearer scheme → 401."""
        async with _make_client(token="correct") as client:
            resp = await client.get(
                "/sse", headers={"Authorization": "Token correct"}
            )
            assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_messages_rejected_without_token(self):
        """POST /messages/ also requires auth when token is set."""
        async with _make_client(token="tok") as client:
            resp = await client.post("/messages/", content=b"{}")
            assert resp.status_code == 401

    def test_no_auth_required_when_no_token_configured(self):
        """When token=None, the SSE app has exactly 2 routes (no auth middleware)."""
        app = build_sse_app(token=None)
        route_types = [(type(r).__name__, getattr(r, "path", "")) for r in app.routes]
        # Expect: Route(/sse) + Mount(/messages) - no auth wrapper routes
        assert len(app.routes) == 2, f"Expected 2 routes without token, got: {route_types}"
        # SSE route must be a Route, not a Mount
        sse_routes = [r for r in app.routes if getattr(r, "path", "") == "/sse"]
        assert sse_routes, "Expected /sse Route in app without token"


# ---------------------------------------------------------------------------
# SSE app: structure tests
# ---------------------------------------------------------------------------

class TestSseAppStructure:
    def test_sse_app_has_sse_route(self):
        app = build_sse_app()
        paths = [getattr(r, "path", "") for r in app.routes]
        assert "/sse" in paths, f"Expected /sse route, got: {paths}"

    def test_sse_app_has_messages_mount(self):
        app = build_sse_app()
        paths = [getattr(r, "path", "") for r in app.routes]
        assert "/messages" in paths, f"Expected /messages mount, got: {paths}"

    def test_sse_app_with_token_is_starlette(self):
        from starlette.applications import Starlette
        assert isinstance(build_sse_app(token="tok"), Starlette)

    def test_sse_app_without_token_is_starlette(self):
        from starlette.applications import Starlette
        assert isinstance(build_sse_app(token=None), Starlette)


# ---------------------------------------------------------------------------
# stdio module: smoke tests
# ---------------------------------------------------------------------------

class TestStdioSmoke:
    def test_main_module_importable(self):
        from app.mcp_server import __main__ as m
        assert hasattr(m, "main")

    def test_main_help_exits_zero(self, monkeypatch, capsys):
        import sys
        from app.mcp_server import __main__ as m
        monkeypatch.setattr(sys, "argv", ["app.mcp_server", "--help"])
        with pytest.raises(SystemExit) as exc:
            m.main()
        assert exc.value.code == 0


# ---------------------------------------------------------------------------
# call_tool: error handling (no model, unknown name)
# ---------------------------------------------------------------------------

class TestCallTool:
    @pytest.mark.asyncio
    async def test_unknown_tool_name_returns_error(self):
        from app.mcp_server.server import _call_tool
        result = await _call_tool("nonexistent_tool_xyz", {})
        assert len(result) == 1
        data = json.loads(result[0].text)
        assert "error" in str(data).lower() or "unknown" in str(data).lower()

    @pytest.mark.asyncio
    async def test_read_tool_no_model_returns_error(self, monkeypatch):
        """execute_tool returns {'error': '...'} when no model is loaded.
        is_loaded is a @property - patch the backing _model attribute to None."""
        from app.mcp_server.server import _call_tool
        from app.services.ifc_service import ifc_service as svc
        monkeypatch.setattr(svc, "_model", None)
        result = await _call_tool("get_project_info", {})
        assert len(result) == 1
        data = json.loads(result[0].text)
        assert "error" in data

    @pytest.mark.asyncio
    async def test_call_returns_text_content_list(self, monkeypatch):
        """_call_tool always returns a list of TextContent objects."""
        from mcp.types import TextContent
        from app.mcp_server.server import _call_tool
        from app.services.ifc_service import ifc_service as svc
        monkeypatch.setattr(svc, "_model", None)
        result = await _call_tool("get_model_stats", {})
        assert isinstance(result, list)
        assert all(isinstance(r, TextContent) for r in result)


# ---------------------------------------------------------------------------
# FastAPI integration: /mcp mount present
# ---------------------------------------------------------------------------

class TestFastapiMount:
    def test_mcp_mount_present_in_app(self):
        from app.main import app
        mcp_mounts = [r for r in app.routes if getattr(r, "path", "") == "/mcp"]
        assert mcp_mounts, "Expected /mcp Mount in FastAPI app"

    def test_list_exposed_tools_returns_non_empty_list(self):
        tools = list_exposed_tools()
        assert isinstance(tools, list) and len(tools) > 0


# ---------------------------------------------------------------------------
# Extended coverage for correctness gaps found in review
# ---------------------------------------------------------------------------

class TestToolPermissionErrors:
    """Write / viewer tools return 'not permitted' - not 'unknown tool'."""

    @pytest.mark.asyncio
    async def test_write_tool_returns_not_permitted_error(self, monkeypatch):
        """Calling a known write tool via _call_tool returns a 'not permitted' message."""
        from app.mcp_server.server import _call_tool
        from app.services.ifc_service import ifc_service as svc
        monkeypatch.setattr(svc, "_model", None)
        result = await _call_tool("rename_element", {"express_id": 1, "new_name": "X"})
        assert len(result) == 1
        data = json.loads(result[0].text)
        err = data.get("error", "")
        assert "not permitted" in err, (
            f"Expected 'not permitted' in error, got: {err!r}"
        )

    @pytest.mark.asyncio
    async def test_viewer_tool_returns_not_permitted_error(self, monkeypatch):
        """Viewer-tier tools also return a 'not permitted' error, not 'unknown'."""
        from app.mcp_server.server import _call_tool
        from app.services.ifc_service import ifc_service as svc
        monkeypatch.setattr(svc, "_model", None)
        result = await _call_tool("highlight_elements", {"express_ids": [1]})
        data = json.loads(result[0].text)
        err = data.get("error", "")
        assert "not permitted" in err

    @pytest.mark.asyncio
    async def test_truly_unknown_tool_returns_unknown_error(self):
        """A name that doesn't exist in TOOL_DEFINITIONS gets 'Unknown tool'."""
        from app.mcp_server.server import _call_tool
        result = await _call_tool("this_tool_does_not_exist_at_all", {})
        data = json.loads(result[0].text)
        err = data.get("error", "")
        assert "Unknown tool" in err


class TestCallToolRobustness:
    """Edge cases and robustness for _call_tool."""

    @pytest.mark.asyncio
    async def test_call_tool_with_none_arguments(self, monkeypatch):
        """None arguments should be coerced to {} - no TypeError."""
        from app.mcp_server.server import _call_tool
        from app.services.ifc_service import ifc_service as svc
        monkeypatch.setattr(svc, "_model", None)
        # Should not raise; returns error about no model
        result = await _call_tool("get_project_info", None)  # type: ignore[arg-type]
        assert isinstance(result, list) and len(result) == 1

    @pytest.mark.asyncio
    async def test_call_tool_result_is_valid_json(self, monkeypatch):
        """_call_tool always returns parseable JSON in the TextContent."""
        from app.mcp_server.server import _call_tool
        from app.services.ifc_service import ifc_service as svc
        monkeypatch.setattr(svc, "_model", None)
        result = await _call_tool("get_model_stats", {})
        parsed = json.loads(result[0].text)
        assert isinstance(parsed, dict)


class TestToolCatalogCompleteness:
    """Verify the all-tool-names helper and catalog completeness."""

    def test_all_tool_names_includes_write_tools(self):
        assert "rename_element" in _all_tool_names
        assert "update_property_value" in _all_tool_names
        assert "execute_ifc_code" in _all_tool_names

    def test_all_tool_names_includes_viewer_tools(self):
        assert "highlight_elements" in _all_tool_names
        assert "isolate_elements" in _all_tool_names

    def test_list_all_tool_names_matches_definitions(self):
        from_defs = frozenset(t["name"] for t in TOOL_DEFINITIONS)
        assert list_all_tool_names() == from_defs

    def test_exposed_tools_are_strict_subset_of_all(self):
        assert _tool_names < _all_tool_names, "Exposed names must be a proper subset of all names"

    def test_list_exposed_tools_returns_independent_copy(self):
        """Mutating the returned list must not affect internal state."""
        copy1 = list_exposed_tools()
        copy2 = list_exposed_tools()
        copy1.clear()
        assert len(copy2) > 0, "list_exposed_tools() must return an independent copy"


class TestSseAuthEdgeCases:
    """Additional auth edge cases beyond the basic auth tests."""

    @pytest.mark.asyncio
    async def test_messages_rejected_wrong_token(self):
        """POST /messages/ with wrong bearer token → 401."""
        async with _make_client(token="right") as client:
            resp = await client.post(
                "/messages/",
                content=b"{}",
                headers={"Authorization": "Bearer wrong"},
            )
            assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_token_comparison_is_case_sensitive(self):
        """Token 'Secret' must not match 'secret'."""
        async with _make_client(token="Secret") as client:
            resp = await client.get(
                "/sse", headers={"Authorization": "Bearer secret"}
            )
            assert resp.status_code == 401


class TestServerInstance:
    """Sanity checks on the global server object."""

    def test_server_name_is_ifc_viewer(self):
        from app.mcp_server.server import server as s
        assert s.name == "ifc-viewer"

    def test_server_is_mcp_server_instance(self):
        from mcp.server import Server
        from app.mcp_server.server import server as s
        assert isinstance(s, Server)


# ---------------------------------------------------------------------------
# Write gating: _writes_enabled() helper
# ---------------------------------------------------------------------------

class TestWritesEnabled:
    def test_disabled_by_default(self, monkeypatch):
        monkeypatch.delenv("MCP_ALLOW_WRITES", raising=False)
        from app.mcp_server.server import _writes_enabled
        assert not _writes_enabled()

    def test_enabled_with_1(self, monkeypatch):
        monkeypatch.setenv("MCP_ALLOW_WRITES", "1")
        from app.mcp_server.server import _writes_enabled
        assert _writes_enabled()

    def test_enabled_with_true(self, monkeypatch):
        monkeypatch.setenv("MCP_ALLOW_WRITES", "true")
        from app.mcp_server.server import _writes_enabled
        assert _writes_enabled()

    def test_disabled_with_0(self, monkeypatch):
        monkeypatch.setenv("MCP_ALLOW_WRITES", "0")
        from app.mcp_server.server import _writes_enabled
        assert not _writes_enabled()

    def test_disabled_with_false(self, monkeypatch):
        monkeypatch.setenv("MCP_ALLOW_WRITES", "false")
        from app.mcp_server.server import _writes_enabled
        assert not _writes_enabled()


# ---------------------------------------------------------------------------
# Write tool catalog (gated behind MCP_ALLOW_WRITES)
# ---------------------------------------------------------------------------

class TestWriteToolCatalog:
    def test_write_allowlist_contains_expected_tools(self):
        from app.mcp_server.server import _WRITE_ALLOWLIST
        assert "rename_element" in _WRITE_ALLOWLIST
        assert "update_property_value" in _WRITE_ALLOWLIST
        assert "create_wall_from_ends" in _WRITE_ALLOWLIST
        assert "delete_element" in _WRITE_ALLOWLIST
        assert "execute_ifc_code" in _WRITE_ALLOWLIST

    def test_list_exposed_write_tools_returns_correct_count(self):
        from app.mcp_server import list_exposed_write_tools
        from app.mcp_server.server import _WRITE_ALLOWLIST
        tools = list_exposed_write_tools()
        # Full write parity with the chat surface (R4): staged tools plus
        # direct operations. Read-only history remains in the read catalog.
        assert len(tools) == len(_WRITE_ALLOWLIST) == 10

    def test_list_exposed_write_tools_has_descriptions(self):
        from app.mcp_server import list_exposed_write_tools
        for t in list_exposed_write_tools():
            assert t.get("description"), f"{t['name']} has no description"

    def test_write_tools_not_in_read_catalog(self):
        from app.mcp_server import list_exposed_tools, list_exposed_write_tools
        read_names = {t["name"] for t in list_exposed_tools()}
        for t in list_exposed_write_tools():
            assert t["name"] not in read_names, (
                f"{t['name']} must not appear in the read-only catalog"
            )

    def test_mgmt_tool_names_set(self):
        from app.mcp_server.server import _MGMT_TOOL_NAMES
        assert "apply_pending_edit" in _MGMT_TOOL_NAMES
        assert "discard_pending_edit" in _MGMT_TOOL_NAMES
        assert "list_pending_edits" in _MGMT_TOOL_NAMES

    @pytest.mark.asyncio
    async def test_list_tools_includes_write_tools_when_enabled(self, monkeypatch):
        monkeypatch.setenv("MCP_ALLOW_WRITES", "1")
        from app.mcp_server.server import _list_tools
        tools = await _list_tools()
        names = {t.name for t in tools}
        assert "rename_element" in names
        assert "execute_ifc_code" in names
        assert "apply_pending_edit" in names
        assert "discard_pending_edit" in names
        assert "list_pending_edits" in names

    @pytest.mark.asyncio
    async def test_list_tools_hides_write_tools_when_disabled(self, monkeypatch):
        monkeypatch.delenv("MCP_ALLOW_WRITES", raising=False)
        from app.mcp_server.server import _list_tools
        tools = await _list_tools()
        names = {t.name for t in tools}
        assert "rename_element" not in names
        assert "apply_pending_edit" not in names


# ---------------------------------------------------------------------------
# _call_tool dispatch when writes disabled
# ---------------------------------------------------------------------------

class TestWriteToolGating:
    """Write tools must return 'not permitted' when MCP_ALLOW_WRITES is not set."""

    @pytest.mark.asyncio
    async def test_write_tool_gated_off_when_disabled(self, monkeypatch):
        monkeypatch.delenv("MCP_ALLOW_WRITES", raising=False)
        from app.mcp_server.server import _call_tool
        result = await _call_tool("rename_element", {"express_id": 1, "new_name": "X"})
        data = json.loads(result[0].text)
        err = data.get("error", "")
        assert "not permitted" in err

    @pytest.mark.asyncio
    async def test_mgmt_tool_gated_off_when_disabled(self, monkeypatch):
        monkeypatch.delenv("MCP_ALLOW_WRITES", raising=False)
        from app.mcp_server.server import _call_tool
        result = await _call_tool("apply_pending_edit", {"edit_id": "abc"})
        data = json.loads(result[0].text)
        err = data.get("error", "")
        assert "not permitted" in err

    @pytest.mark.asyncio
    async def test_list_pending_edits_gated_off_when_disabled(self, monkeypatch):
        monkeypatch.delenv("MCP_ALLOW_WRITES", raising=False)
        from app.mcp_server.server import _call_tool
        result = await _call_tool("list_pending_edits", {})
        data = json.loads(result[0].text)
        assert "error" in data


# ---------------------------------------------------------------------------
# Edge-case coverage for management tools + catalog helpers
# ---------------------------------------------------------------------------

class TestMgmtToolMissingEditId:
    """apply_pending_edit / discard_pending_edit must return 'edit_id is required'
    when called without the edit_id argument (writes enabled)."""

    @pytest.mark.asyncio
    async def test_apply_missing_edit_id(self, monkeypatch):
        monkeypatch.setenv("MCP_ALLOW_WRITES", "1")
        from app.mcp_server.server import _call_tool
        result = await _call_tool("apply_pending_edit", {})
        data = json.loads(result[0].text)
        assert "edit_id" in data.get("error", "").lower()

    @pytest.mark.asyncio
    async def test_discard_missing_edit_id(self, monkeypatch):
        monkeypatch.setenv("MCP_ALLOW_WRITES", "1")
        from app.mcp_server.server import _call_tool
        result = await _call_tool("discard_pending_edit", {})
        data = json.loads(result[0].text)
        assert "edit_id" in data.get("error", "").lower()

    @pytest.mark.asyncio
    async def test_apply_nonexistent_edit_id(self, monkeypatch):
        """apply_pending_edit with unknown id → ValueError → {"error": "..."}."""
        monkeypatch.setenv("MCP_ALLOW_WRITES", "1")
        from app.mcp_server.server import _call_tool
        result = await _call_tool("apply_pending_edit", {"edit_id": "does-not-exist"})
        data = json.loads(result[0].text)
        assert "error" in data

    @pytest.mark.asyncio
    async def test_discard_nonexistent_edit_id(self, monkeypatch):
        """discard_pending_edit with unknown id → ValueError → {"error": "..."}."""
        monkeypatch.setenv("MCP_ALLOW_WRITES", "1")
        from app.mcp_server.server import _call_tool
        result = await _call_tool("discard_pending_edit", {"edit_id": "does-not-exist"})
        data = json.loads(result[0].text)
        assert "error" in data


class TestListPendingEdits:
    """list_pending_edits must return a JSON array (possibly empty) when writes enabled."""

    @pytest.mark.asyncio
    async def test_returns_empty_list_when_no_edits(self, monkeypatch):
        monkeypatch.setenv("MCP_ALLOW_WRITES", "1")
        from app.mcp_server.server import _call_tool
        result = await _call_tool("list_pending_edits", {})
        parsed = json.loads(result[0].text)
        assert isinstance(parsed, list)

    @pytest.mark.asyncio
    async def test_returns_list_not_error(self, monkeypatch):
        monkeypatch.setenv("MCP_ALLOW_WRITES", "1")
        from app.mcp_server.server import _call_tool
        result = await _call_tool("list_pending_edits", {})
        data = json.loads(result[0].text)
        # Must not be {"error": ...}
        assert not isinstance(data, dict) or "error" not in data


class TestMgmtToolCatalogHelpers:
    """list_exposed_mgmt_tools() returns the three MCP-only management tools."""

    def test_count_is_three(self):
        from app.mcp_server import list_exposed_mgmt_tools
        tools = list_exposed_mgmt_tools()
        assert len(tools) == 3, f"Expected 3 mgmt tools, got {len(tools)}"

    def test_names_are_correct(self):
        from app.mcp_server import list_exposed_mgmt_tools
        names = {t.name for t in list_exposed_mgmt_tools()}
        assert names == {"apply_pending_edit", "discard_pending_edit", "list_pending_edits"}

    def test_each_has_description(self):
        from app.mcp_server import list_exposed_mgmt_tools
        for t in list_exposed_mgmt_tools():
            assert t.description, f"{t.name} has no description"

    def test_each_has_input_schema(self):
        from app.mcp_server import list_exposed_mgmt_tools
        for t in list_exposed_mgmt_tools():
            assert isinstance(t.inputSchema, dict), f"{t.name} inputSchema is not a dict"

    def test_returns_independent_copy(self):
        from app.mcp_server import list_exposed_mgmt_tools
        copy1 = list_exposed_mgmt_tools()
        copy2 = list_exposed_mgmt_tools()
        copy1.clear()
        assert len(copy2) == 3, "list_exposed_mgmt_tools() must return independent copy"


class TestListToolsCountWithWritesEnabled:
    """Verify list_tools total count with and without writes enabled.

    Viewer bridge tools are always exposed, so they count in both totals.
    """

    @pytest.mark.asyncio
    async def test_total_count_includes_read_viewer_write_and_mgmt(self, monkeypatch):
        monkeypatch.setenv("MCP_ALLOW_WRITES", "1")
        from app.mcp_server.server import _list_tools
        from app.mcp_server import (
            list_exposed_mgmt_tools,
            list_exposed_tools,
            list_exposed_viewer_tools,
            list_exposed_write_tools,
        )
        tools = await _list_tools()
        expected_count = (
            len(list_exposed_tools())
            + len(list_exposed_viewer_tools())
            + len(list_exposed_write_tools())
            + len(list_exposed_mgmt_tools())
        )
        assert len(tools) == expected_count, (
            f"Expected {expected_count} tools with writes enabled, got {len(tools)}"
        )

    @pytest.mark.asyncio
    async def test_total_count_without_writes_equals_read_plus_viewer(self, monkeypatch):
        monkeypatch.delenv("MCP_ALLOW_WRITES", raising=False)
        from app.mcp_server.server import _list_tools
        from app.mcp_server import list_exposed_tools, list_exposed_viewer_tools
        tools = await _list_tools()
        expected_count = len(list_exposed_tools()) + len(list_exposed_viewer_tools())
        assert len(tools) == expected_count


class TestUnknownMgmtToolGuard:
    """The explicit guard at the end of _handle_mgmt_tool blocks unknown tool names."""

    @pytest.mark.asyncio
    async def test_unknown_mgmt_tool_returns_error(self, monkeypatch):
        monkeypatch.setenv("MCP_ALLOW_WRITES", "1")
        # Bypass _MGMT_TOOL_NAMES check by calling _handle_mgmt_tool directly.
        # Must supply an edit_id so the function passes the shared edit_id-required
        # check and reaches the explicit name guard before the apply_pending_edit branch.
        from app.mcp_server.server import _handle_mgmt_tool
        result = await _handle_mgmt_tool(
            "future_unimplemented_mgmt_tool", {"edit_id": "test-guard-sentinel"}
        )
        data = json.loads(result[0].text)
        assert "error" in data
        assert "Unknown management tool" in data["error"]


# ---------------------------------------------------------------------------
# Write-tool happy path (mocked execute_tool + WS broker)
# ---------------------------------------------------------------------------

class TestWriteToolHappyPath:
    """Write tool calls go through execute_tool and return JSON when writes are enabled."""

    @pytest.mark.asyncio
    async def test_write_tool_reaches_execute_tool_when_enabled(self, monkeypatch):
        """When writes are on, a write-tool call returns JSON (not a gating error).

        rename_element is a DIRECT op, so the backend edit-mode flag must be on
        too (R4 dual-gate); with both flags the call reaches execute_tool."""
        monkeypatch.setenv("MCP_ALLOW_WRITES", "1")
        monkeypatch.setattr("app.core.config.EDIT_MODE_ENABLED", True)
        from app.services.ifc_service import ifc_service as svc
        monkeypatch.setattr(svc, "_model", None)
        from app.mcp_server.server import _call_tool
        result = await _call_tool("rename_element", {"express_id": 1, "new_name": "X"})
        assert len(result) == 1
        data = json.loads(result[0].text)
        # Should be an execute_tool error (no model), NOT a gating "not permitted" error.
        # This proves the call reached execute_tool rather than being blocked.
        err = data.get("error", "")
        assert "not permitted" not in err
        assert "MCP_ALLOW_WRITES" not in err

    @pytest.mark.asyncio
    async def test_write_tool_result_is_valid_json_when_enabled(self, monkeypatch):
        """Even on error, a write-tool call always returns valid JSON."""
        monkeypatch.setenv("MCP_ALLOW_WRITES", "1")
        from app.services.ifc_service import ifc_service as svc
        monkeypatch.setattr(svc, "_model", None)
        from app.mcp_server.server import _call_tool
        result = await _call_tool("update_property_value", {})
        parsed = json.loads(result[0].text)
        assert isinstance(parsed, dict)

    @pytest.mark.asyncio
    async def test_delete_element_reaches_execute_tool_when_enabled(self, monkeypatch):
        """delete_element is also a write-tool; verify it routes correctly."""
        monkeypatch.setenv("MCP_ALLOW_WRITES", "1")
        from app.services.ifc_service import ifc_service as svc
        monkeypatch.setattr(svc, "_model", None)
        from app.mcp_server.server import _call_tool
        result = await _call_tool("delete_element", {"express_id": 1})
        data = json.loads(result[0].text)
        assert "not permitted" not in data.get("error", "")


# ---------------------------------------------------------------------------
# list_pending_edits management tool
# ---------------------------------------------------------------------------

class TestMgmtListPendingEdits:
    @pytest.mark.asyncio
    async def test_list_pending_edits_returns_list(self, monkeypatch):
        monkeypatch.setenv("MCP_ALLOW_WRITES", "1")

        class _FakeSandbox:
            def list_pending(self):
                return []

        import sys
        import types as builtin_types
        fake_sb = builtin_types.ModuleType("app.services.sandbox_service")
        fake_sb.sandbox_service = _FakeSandbox()
        monkeypatch.setitem(sys.modules, "app.services.sandbox_service", fake_sb)

        from app.mcp_server.server import _call_tool
        result = await _call_tool("list_pending_edits", {})
        data = json.loads(result[0].text)
        assert isinstance(data, list)


# ---------------------------------------------------------------------------
# discard_pending_edit management tool
# ---------------------------------------------------------------------------

class TestMgmtDiscardPendingEdit:
    @pytest.mark.asyncio
    async def test_discard_missing_edit_id_returns_error(self, monkeypatch):
        monkeypatch.setenv("MCP_ALLOW_WRITES", "1")
        from app.mcp_server.server import _call_tool
        result = await _call_tool("discard_pending_edit", {})
        data = json.loads(result[0].text)
        assert "error" in data
        assert "edit_id" in data["error"]

    @pytest.mark.asyncio
    async def test_discard_nonexistent_edit_id_returns_error(self, monkeypatch):
        monkeypatch.setenv("MCP_ALLOW_WRITES", "1")
        from app.mcp_server.server import _call_tool
        # The real sandbox_service has no pending edit with this id
        result = await _call_tool("discard_pending_edit", {"edit_id": "no-such-id"})
        data = json.loads(result[0].text)
        assert "error" in data


# ---------------------------------------------------------------------------
# apply_pending_edit management tool
# ---------------------------------------------------------------------------

class TestMgmtApplyPendingEdit:
    @pytest.mark.asyncio
    async def test_apply_missing_edit_id_returns_error(self, monkeypatch):
        monkeypatch.setenv("MCP_ALLOW_WRITES", "1")
        from app.mcp_server.server import _call_tool
        result = await _call_tool("apply_pending_edit", {})
        data = json.loads(result[0].text)
        assert "error" in data

    @pytest.mark.asyncio
    async def test_apply_nonexistent_edit_id_returns_error(self, monkeypatch):
        monkeypatch.setenv("MCP_ALLOW_WRITES", "1")
        from app.mcp_server.server import _call_tool
        result = await _call_tool("apply_pending_edit", {"edit_id": "no-such-id"})
        data = json.loads(result[0].text)
        assert "error" in data


# ---------------------------------------------------------------------------
# Viewer bridge tools (always exposed - presentation only, never the model)
# ---------------------------------------------------------------------------

VIEWER_TOOL_NAMES = {
    "get_viewer_state",
    "viewer_select_elements",
    "viewer_isolate_elements",
    "viewer_highlight_elements",
    "viewer_show_all",
    "viewer_set_camera",
    "get_viewer_snapshot",
    "viewer_clip_to_element",
    "viewer_set_section_box",
    "viewer_colour_elements",
    "viewer_clear_colours",
}


class _StubViewerBroker:
    """Stands in for model_sync_broker: records publishes, fakes subscribers."""

    def __init__(self, subscribers: int = 0):
        self._subscribers = [object() for _ in range(subscribers)]
        self.published: list[Any] = []

    async def publish(self, event: Any) -> None:
        self.published.append(event)


@pytest.fixture
def viewer_state():
    """Reset the viewer-state singleton around each test; yields it."""
    from app.services.viewer_state_service import viewer_state_service
    viewer_state_service._state = None
    viewer_state_service._pending.clear()
    yield viewer_state_service
    viewer_state_service._state = None
    viewer_state_service._pending.clear()


@pytest.fixture
def captured_broadcasts(monkeypatch):
    """Replace broadcast_viewer_command with a recorder reporting 2 viewers."""
    import app.services.viewer_state_service as vss

    calls: list[dict[str, Any]] = []

    async def fake_broadcast(payload: dict[str, Any]) -> int:
        calls.append(payload)
        return 2

    monkeypatch.setattr(vss, "broadcast_viewer_command", fake_broadcast)
    return calls


class TestViewerToolCatalog:
    """Viewer tools are always in the catalog, independent of the write gate."""

    @pytest.mark.asyncio
    async def test_listed_with_writes_disabled(self, monkeypatch):
        monkeypatch.delenv("MCP_ALLOW_WRITES", raising=False)
        from app.mcp_server.server import _list_tools
        names = {t.name for t in await _list_tools()}
        missing = VIEWER_TOOL_NAMES - names
        assert not missing, f"Viewer tools missing with writes disabled: {missing}"

    @pytest.mark.asyncio
    async def test_listed_with_writes_enabled(self, monkeypatch):
        monkeypatch.setenv("MCP_ALLOW_WRITES", "1")
        from app.mcp_server.server import _list_tools
        names = {t.name for t in await _list_tools()}
        missing = VIEWER_TOOL_NAMES - names
        assert not missing, f"Viewer tools missing with writes enabled: {missing}"

    def test_list_exposed_viewer_tools_names(self):
        from app.mcp_server import list_exposed_viewer_tools
        names = {t.name for t in list_exposed_viewer_tools()}
        assert names == VIEWER_TOOL_NAMES

    def test_each_viewer_tool_has_description(self):
        from app.mcp_server import list_exposed_viewer_tools
        for t in list_exposed_viewer_tools():
            assert t.description, f"{t.name} has no description"

    def test_each_viewer_tool_has_object_schema(self):
        from app.mcp_server import list_exposed_viewer_tools
        for t in list_exposed_viewer_tools():
            assert t.inputSchema.get("type") == "object", (
                f"{t.name} inputSchema.type != 'object'"
            )

    def test_element_tools_require_element_ids_in_schema(self):
        from app.mcp_server import list_exposed_viewer_tools
        element_tools = {
            "viewer_select_elements",
            "viewer_isolate_elements",
            "viewer_highlight_elements",
        }
        for t in list_exposed_viewer_tools():
            if t.name in element_tools:
                assert t.inputSchema.get("required") == ["element_ids"]

    def test_returns_independent_copy(self):
        from app.mcp_server import list_exposed_viewer_tools
        copy1 = list_exposed_viewer_tools()
        copy2 = list_exposed_viewer_tools()
        copy1.clear()
        assert len(copy2) == len(VIEWER_TOOL_NAMES), (
            "list_exposed_viewer_tools() must return an independent copy"
        )

    def test_viewer_names_disjoint_from_model_and_mgmt_tools(self):
        from app.mcp_server.server import (
            _MGMT_TOOL_NAMES,
            _VIEWER_TOOL_NAMES,
            _all_tool_names,
        )
        overlap = _VIEWER_TOOL_NAMES & (_all_tool_names | _MGMT_TOOL_NAMES)
        assert not overlap, f"Viewer tool names collide with other tools: {overlap}"


class TestGetViewerState:
    @pytest.mark.asyncio
    async def test_returns_reported_state(self, monkeypatch, viewer_state):
        import app.services.viewer_state_service as vss
        monkeypatch.setattr(vss, "model_sync_broker", _StubViewerBroker(subscribers=2))
        viewer_state.report_state({"selected_ids": [42, 43], "isolated_count": 1})

        from app.mcp_server.server import _call_tool
        result = await _call_tool("get_viewer_state", {})
        data = json.loads(result[0].text)
        assert data["connected_clients"] == 2
        assert data["state"]["selected_ids"] == [42, 43]
        assert data["state"]["isolated_count"] == 1
        assert "updated_at" in data["state"]

    @pytest.mark.asyncio
    async def test_state_is_null_before_any_report(self, monkeypatch, viewer_state):
        import app.services.viewer_state_service as vss
        monkeypatch.setattr(vss, "model_sync_broker", _StubViewerBroker(subscribers=0))

        from app.mcp_server.server import _call_tool
        result = await _call_tool("get_viewer_state", {})
        data = json.loads(result[0].text)
        assert data == {"connected_clients": 0, "state": None}


class TestViewerCommandTools:
    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "tool,action",
        [
            ("viewer_select_elements", "select"),
            ("viewer_isolate_elements", "isolate"),
            ("viewer_highlight_elements", "highlight"),
        ],
    )
    async def test_element_tools_broadcast_and_return_delivered(
        self, tool, action, captured_broadcasts
    ):
        from app.mcp_server.server import _call_tool
        result = await _call_tool(tool, {"element_ids": [1, 2]})
        data = json.loads(result[0].text)
        assert data == {"delivered_to": 2}
        assert captured_broadcasts == [{"action": action, "element_ids": [1, 2]}]

    @pytest.mark.asyncio
    async def test_show_all_broadcasts(self, captured_broadcasts):
        from app.mcp_server.server import _call_tool
        result = await _call_tool("viewer_show_all", {})
        data = json.loads(result[0].text)
        assert data == {"delivered_to": 2}
        assert captured_broadcasts == [{"action": "show_all"}]

    @pytest.mark.asyncio
    async def test_dispatched_even_with_writes_disabled(
        self, monkeypatch, captured_broadcasts
    ):
        """Viewer tools must not depend on MCP_ALLOW_WRITES."""
        monkeypatch.delenv("MCP_ALLOW_WRITES", raising=False)
        from app.mcp_server.server import _call_tool
        result = await _call_tool("viewer_select_elements", {"element_ids": [9]})
        data = json.loads(result[0].text)
        assert "not permitted" not in data.get("error", "")
        assert data == {"delivered_to": 2}

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "tool",
        ["viewer_select_elements", "viewer_isolate_elements", "viewer_highlight_elements"],
    )
    async def test_missing_element_ids_is_error_without_broadcast(
        self, tool, captured_broadcasts
    ):
        from app.mcp_server.server import _call_tool
        result = await _call_tool(tool, {})
        data = json.loads(result[0].text)
        assert "element_ids" in data.get("error", "")
        assert captured_broadcasts == []

    @pytest.mark.asyncio
    async def test_non_integer_element_ids_is_error(self, captured_broadcasts):
        from app.mcp_server.server import _call_tool
        result = await _call_tool(
            "viewer_select_elements", {"element_ids": ["wall-1"]}
        )
        data = json.loads(result[0].text)
        assert "element_ids" in data.get("error", "")
        assert captured_broadcasts == []

    @pytest.mark.asyncio
    async def test_note_added_when_no_viewer_connected(self, monkeypatch):
        import app.services.viewer_state_service as vss

        async def no_viewers(payload: dict[str, Any]) -> int:
            return 0

        monkeypatch.setattr(vss, "broadcast_viewer_command", no_viewers)
        from app.mcp_server.server import _call_tool
        result = await _call_tool("viewer_show_all", {})
        data = json.loads(result[0].text)
        assert data["delivered_to"] == 0
        assert "no viewer connected" in data["note"]


class TestViewerSectionAndColourTools:
    @pytest.mark.asyncio
    async def test_clip_to_element_broadcasts(self, captured_broadcasts):
        from app.mcp_server.server import _call_tool
        result = await _call_tool("viewer_clip_to_element", {"element_id": 42})
        data = json.loads(result[0].text)
        assert data == {"delivered_to": 2}
        assert captured_broadcasts == [{"action": "clip_to_element", "element_id": 42}]

    @pytest.mark.asyncio
    async def test_clip_to_element_requires_integer(self, captured_broadcasts):
        from app.mcp_server.server import _call_tool
        result = await _call_tool("viewer_clip_to_element", {"element_id": "wall"})
        data = json.loads(result[0].text)
        assert "element_id" in data.get("error", "")
        assert captured_broadcasts == []

    @pytest.mark.asyncio
    @pytest.mark.parametrize("enabled", [True, False])
    async def test_set_section_box_broadcasts(self, enabled, captured_broadcasts):
        from app.mcp_server.server import _call_tool
        result = await _call_tool("viewer_set_section_box", {"enabled": enabled})
        data = json.loads(result[0].text)
        assert data == {"delivered_to": 2}
        assert captured_broadcasts == [{"action": "set_section_box", "enabled": enabled}]

    @pytest.mark.asyncio
    async def test_colour_elements_broadcasts_layer(self, captured_broadcasts):
        from app.mcp_server.server import _call_tool
        entries = [
            {"color": "#ff0000", "element_ids": [1, 2], "label": "Missing rating"},
            {"color": "#00ff00", "element_ids": [3]},
        ]
        result = await _call_tool("viewer_colour_elements", {"entries": entries})
        data = json.loads(result[0].text)
        assert data == {"delivered_to": 2}
        assert captured_broadcasts == [
            {"action": "set_colour_layer", "layer_id": "ai", "entries": entries}
        ]

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "entries",
        [
            None,
            [],
            [{"color": "", "element_ids": [1]}],
            [{"color": "#fff", "element_ids": []}],
            [{"color": "#fff", "element_ids": ["a"]}],
            [{"color": "#fff", "element_ids": [1], "label": 5}],
        ],
    )
    async def test_colour_elements_rejects_bad_entries(self, entries, captured_broadcasts):
        from app.mcp_server.server import _call_tool
        args = {} if entries is None else {"entries": entries}
        result = await _call_tool("viewer_colour_elements", args)
        data = json.loads(result[0].text)
        assert data.get("error")
        assert captured_broadcasts == []

    @pytest.mark.asyncio
    async def test_clear_colours_broadcasts(self, captured_broadcasts):
        from app.mcp_server.server import _call_tool
        result = await _call_tool("viewer_clear_colours", {})
        data = json.loads(result[0].text)
        assert data == {"delivered_to": 2}
        assert captured_broadcasts == [{"action": "clear_colour_layers"}]


class TestViewerSetCamera:
    @pytest.mark.asyncio
    async def test_preset_maps_to_camera_preset_action(self, captured_broadcasts):
        from app.mcp_server.server import _call_tool
        result = await _call_tool("viewer_set_camera", {"preset": "iso"})
        data = json.loads(result[0].text)
        assert data == {"delivered_to": 2}
        assert captured_broadcasts == [{"action": "camera_preset", "preset": "iso"}]

    @pytest.mark.asyncio
    async def test_element_id_maps_to_zoom_action(self, captured_broadcasts):
        from app.mcp_server.server import _call_tool
        result = await _call_tool("viewer_set_camera", {"element_id": 99})
        data = json.loads(result[0].text)
        assert data == {"delivered_to": 2}
        assert captured_broadcasts == [
            {"action": "zoom_to_element", "element_id": 99}
        ]

    @pytest.mark.asyncio
    async def test_both_args_is_error_without_broadcast(self, captured_broadcasts):
        from app.mcp_server.server import _call_tool
        result = await _call_tool(
            "viewer_set_camera", {"preset": "iso", "element_id": 99}
        )
        data = json.loads(result[0].text)
        assert "exactly one" in data.get("error", "")
        assert captured_broadcasts == []

    @pytest.mark.asyncio
    async def test_neither_arg_is_error_without_broadcast(self, captured_broadcasts):
        from app.mcp_server.server import _call_tool
        result = await _call_tool("viewer_set_camera", {})
        data = json.loads(result[0].text)
        assert "exactly one" in data.get("error", "")
        assert captured_broadcasts == []

    @pytest.mark.asyncio
    async def test_unknown_preset_is_error_without_broadcast(self, captured_broadcasts):
        from app.mcp_server.server import _call_tool
        result = await _call_tool("viewer_set_camera", {"preset": "diagonal"})
        data = json.loads(result[0].text)
        assert "preset" in data.get("error", "").lower()
        assert captured_broadcasts == []


class TestViewerSnapshotTool:
    @pytest.mark.asyncio
    async def test_happy_path_returns_image_content(self, monkeypatch, viewer_state):
        """A second task plays the browser: sees the command, uploads the image."""
        import asyncio

        import app.services.viewer_state_service as vss
        from mcp.types import ImageContent

        broker = _StubViewerBroker(subscribers=1)
        monkeypatch.setattr(vss, "model_sync_broker", broker)
        from app.services.ifc_service import ifc_service as svc
        monkeypatch.setattr(svc, "_model", None)

        async def browser():
            while not broker.published:
                await asyncio.sleep(0.005)
            event = broker.published[0]
            assert event.type == "viewer_command"
            assert event.payload["action"] == "snapshot"
            assert viewer_state.fulfill(
                event.payload["request_id"], "aW1hZ2U=", "image/png"
            ) is True

        from app.mcp_server.server import _call_tool
        browser_task = asyncio.create_task(browser())
        result = await _call_tool("get_viewer_snapshot", {"timeout_s": 5})
        await browser_task

        assert len(result) == 1
        assert isinstance(result[0], ImageContent)
        assert result[0].type == "image"
        assert result[0].data == "aW1hZ2U="
        assert result[0].mimeType == "image/png"
        assert viewer_state._pending == {}, "collected entry must be cleaned up"

    @pytest.mark.asyncio
    async def test_timeout_returns_error_text(self, monkeypatch, viewer_state):
        import app.services.viewer_state_service as vss
        from mcp.types import TextContent

        monkeypatch.setattr(vss, "model_sync_broker", _StubViewerBroker(subscribers=1))
        from app.services.ifc_service import ifc_service as svc
        monkeypatch.setattr(svc, "_model", None)

        from app.mcp_server.server import _call_tool
        result = await _call_tool("get_viewer_snapshot", {"timeout_s": 1})
        assert isinstance(result[0], TextContent)
        data = json.loads(result[0].text)
        assert data == {"error": "Viewer did not answer within 1s"}

    @pytest.mark.asyncio
    async def test_no_viewer_returns_error_without_pending_request(
        self, monkeypatch, viewer_state
    ):
        import app.services.viewer_state_service as vss

        broker = _StubViewerBroker(subscribers=0)
        monkeypatch.setattr(vss, "model_sync_broker", broker)

        from app.mcp_server.server import _call_tool
        result = await _call_tool("get_viewer_snapshot", {})
        data = json.loads(result[0].text)
        assert data == {"error": "No viewer connected"}
        assert broker.published == [], "no command may be broadcast without a viewer"
        assert viewer_state._pending == {}, "no rendezvous entry may be created"

    @pytest.mark.asyncio
    async def test_timeout_clamped_to_minimum_one_second(self, monkeypatch, viewer_state):
        """timeout_s=0 exercises the lower clamp; the error message reflects 1s."""
        import app.services.viewer_state_service as vss

        monkeypatch.setattr(vss, "model_sync_broker", _StubViewerBroker(subscribers=1))
        from app.services.ifc_service import ifc_service as svc
        monkeypatch.setattr(svc, "_model", None)

        from app.mcp_server.server import _call_tool
        result = await _call_tool("get_viewer_snapshot", {"timeout_s": 0})
        data = json.loads(result[0].text)
        assert data == {"error": "Viewer did not answer within 1s"}


# ---------------------------------------------------------------------------
# R4: write safety, attribution, visibility + G5 parity
# ---------------------------------------------------------------------------

class TestTierClosureAndParity:
    """G5: the chat and MCP surfaces must never drift apart silently."""

    def test_every_tool_definition_has_an_explicit_tier(self):
        """tool_tier() fails open (unknown → read_model), which would silently
        auto-expose a future untier'd tool on the MCP read surface. The two
        registries must stay in exact sync."""
        from app.services.tools import _TOOL_TIERS

        def_names = {t["name"] for t in TOOL_DEFINITIONS}
        tier_names = set(_TOOL_TIERS)
        assert def_names == tier_names, (
            f"TOOL_DEFINITIONS vs _TOOL_TIERS drift: "
            f"missing tiers for {sorted(def_names - tier_names)}, "
            f"stale tiers for {sorted(tier_names - def_names)}"
        )

    def test_chat_catalogue_subset_of_mcp_surface(self):
        """Plan G5: chat tool catalogue ⊆ MCP catalogue (minus explicitly
        UI-only tools). read_viewer-tier tools execute inside the browser
        (client-executed) and map to the MCP viewer-bridge tools instead."""
        from app.mcp_server.server import (
            _MGMT_TOOL_NAMES,
            _VIEWER_TOOL_NAMES,
            _tool_names,
            _write_tool_names,
        )

        # Chat tools that are deliberately NOT 1:1 on MCP: client-executed
        # viewer tools (the MCP viewer bridge exposes equivalent commands).
        ui_only = {
            t["name"] for t in TOOL_DEFINITIONS
            if tool_tier(t["name"])[0] == "read_viewer"
        }
        mcp_surface = _tool_names | _write_tool_names | _MGMT_TOOL_NAMES | _VIEWER_TOOL_NAMES
        missing = {
            t["name"] for t in TOOL_DEFINITIONS
        } - ui_only - mcp_surface
        assert missing == set(), (
            f"chat tools invisible to MCP (add to a tier/allowlist or the "
            f"ui_only set with justification): {sorted(missing)}"
        )

    def test_knowledge_tier_exposed_on_mcp(self):
        """G3: get_docs + bSDD tools answer without a model - external clients
        (incl. the stdio process) must see them."""
        assert "read_knowledge" in _EXPOSED_TIERS
        knowledge = [t for t in TOOL_DEFINITIONS if tool_tier(t["name"])[0] == "read_knowledge"]
        assert knowledge, "expected knowledge-tier tools to exist"
        for t in knowledge:
            assert t["name"] in _tool_names, f"{t['name']} not exposed on MCP"


class TestMcpWriteSafety:
    @pytest.mark.asyncio
    async def test_direct_op_requires_edit_mode(self, monkeypatch):
        """MCP_ALLOW_WRITES alone must not unlock immediate live-model
        mutation - direct ops also honour the backend EDIT_MODE gate."""
        import importlib
        srv = importlib.import_module('app.mcp_server.server')

        monkeypatch.setenv("MCP_ALLOW_WRITES", "1")
        monkeypatch.setattr("app.core.config.EDIT_MODE_ENABLED", False)
        result = await srv._call_tool("rename_element", {"element_id": 1, "new_name": "X"})
        data = json.loads(result[0].text)
        assert "error" in data
        assert "EDIT_MODE_ENABLED" in data["error"]

    @pytest.mark.asyncio
    async def test_direct_op_holds_edit_lock_and_publishes(self, monkeypatch):
        """A direct op through MCP runs under the shared edit lock, executes
        with actor=MCP, and broadcasts the op sync events."""
        import importlib
        srv = importlib.import_module('app.mcp_server.server')
        from app.services import edit_lock as lock_mod
        from app.services.operation_service import Actor

        monkeypatch.setenv("MCP_ALLOW_WRITES", "1")
        monkeypatch.setattr("app.core.config.EDIT_MODE_ENABLED", True)

        seen: dict[str, Any] = {}

        def _fake_execute(name, args, *, actor=Actor.AGENT):
            seen["actor"] = actor
            seen["locked_during_execute"] = lock_mod.edit_lock.locked()
            return {
                "op_id": "op-1", "operation": "set_name", "actor": actor.value,
                "ok": True, "changed": True, "changed_ids": [1],
                "patch_tier": "metadata", "description": "Renamed", "action": "metadata_changed",
            }

        published: list[dict] = []

        async def _fake_publish(result, **kwargs):
            published.append(result)

        monkeypatch.setattr(srv, "execute_tool", _fake_execute)
        monkeypatch.setattr(lock_mod, "publish_operation_events", _fake_publish)
        result = await srv._call_tool("rename_element", {"element_id": 1, "new_name": "X"})
        data = json.loads(result[0].text)
        assert data["ok"] is True
        assert seen["actor"] == Actor.MCP
        assert seen["locked_during_execute"] is True, "mutation must run under the edit lock"
        assert published and published[0]["op_id"] == "op-1"

    @pytest.mark.asyncio
    async def test_staged_tool_does_not_require_edit_mode(self, monkeypatch):
        """create_wall_from_ends keeps the pending-edit ceremony and only
        needs MCP_ALLOW_WRITES (the user still applies via diff preview)."""
        import importlib
        srv = importlib.import_module('app.mcp_server.server')
        from app.services.operation_service import Actor

        monkeypatch.setenv("MCP_ALLOW_WRITES", "1")
        monkeypatch.setattr("app.core.config.EDIT_MODE_ENABLED", False)

        def _fake_execute(name, args, *, actor=Actor.AGENT):
            return {"error": "No IFC model is currently loaded."}

        monkeypatch.setattr(srv, "execute_tool", _fake_execute)
        result = await srv._call_tool(
            "create_wall_from_ends", {"start": [0, 0], "end": [1, 0]}
        )
        data = json.loads(result[0].text)
        # It reached the tool body (model error), not the EDIT_MODE gate.
        assert "EDIT_MODE_ENABLED" not in str(data)

    def test_undo_available_on_write_surface(self):
        """A client that just direct-applied a mistake needs a recovery path."""
        from app.mcp_server.server import _write_tool_names
        assert "undo_last_edit" in _write_tool_names


class TestActorThreading:
    def test_execute_tool_defaults_to_agent_actor(self, monkeypatch):
        from app.services import tools as tools_mod
        from app.services.operation_service import Actor

        seen = {}

        def _fake_raw(name, args, *, actor=Actor.AGENT):
            seen["actor"] = actor
            return {"ok": True}

        monkeypatch.setattr(tools_mod, "_execute_tool_raw", _fake_raw)
        monkeypatch.setattr(tools_mod, "warming_envelope", lambda name: None)
        tools_mod.execute_tool("get_project_info", {"fresh": "args-1"})
        assert seen["actor"] == Actor.AGENT

    def test_execute_tool_forwards_mcp_actor(self, monkeypatch):
        from app.services import tools as tools_mod
        from app.services.operation_service import Actor

        seen = {}

        def _fake_raw(name, args, *, actor=Actor.AGENT):
            seen["actor"] = actor
            return {"ok": True}

        monkeypatch.setattr(tools_mod, "_execute_tool_raw", _fake_raw)
        monkeypatch.setattr(tools_mod, "warming_envelope", lambda name: None)
        tools_mod.execute_tool("get_project_info", {"fresh": "args-2"}, actor=Actor.MCP)
        assert seen["actor"] == Actor.MCP
