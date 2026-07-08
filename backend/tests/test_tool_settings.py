"""Global tool enable/disable persistence + routing gate.

The Tools registry tab lets users globally disable a tool -
regardless of any agent's per-allowlist. This suite pins:

- ``ToolSettingsService`` persistence (load / save / mutate / round-trip)
- ``check_global_disable_block`` returns the right envelope shape
- GET / PUT ``/api/chat/tools/settings`` endpoints

The service is constructed with an explicit ``path=`` so the tests
don't touch the singleton's on-disk file.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from app.api.chat_routes import check_global_disable_block
from app.main import app
from app.services.tool_settings_service import (
    ToolSettingsService,
    tool_settings_service,
)


# ---------------------------------------------------------------------------
# ToolSettingsService unit tests
# ---------------------------------------------------------------------------


def _make_service(tmp_path: Path) -> ToolSettingsService:
    return ToolSettingsService(path=tmp_path / "tool_settings.json")


class TestToolSettingsService:
    def test_empty_default(self, tmp_path: Path):
        svc = _make_service(tmp_path)
        assert svc.get_disabled() == frozenset()
        assert svc.is_disabled("rename_element") is False

    def test_set_disabled_overwrites(self, tmp_path: Path):
        svc = _make_service(tmp_path)
        svc.set_disabled(["rename_element", "execute_ifc_code"])
        assert svc.get_disabled() == frozenset({"rename_element", "execute_ifc_code"})
        svc.set_disabled(["execute_ifc_code"])
        assert svc.get_disabled() == frozenset({"execute_ifc_code"})

    def test_add_disabled(self, tmp_path: Path):
        svc = _make_service(tmp_path)
        svc.add_disabled("rename_element")
        svc.add_disabled("update_property_value")
        assert svc.get_disabled() == frozenset({"rename_element", "update_property_value"})

    def test_add_disabled_idempotent(self, tmp_path: Path):
        svc = _make_service(tmp_path)
        svc.add_disabled("rename_element")
        svc.add_disabled("rename_element")
        assert svc.get_disabled() == frozenset({"rename_element"})

    def test_remove_disabled(self, tmp_path: Path):
        svc = _make_service(tmp_path)
        svc.add_disabled("rename_element")
        svc.add_disabled("execute_ifc_code")
        svc.remove_disabled("rename_element")
        assert svc.get_disabled() == frozenset({"execute_ifc_code"})

    def test_remove_disabled_unknown_is_noop(self, tmp_path: Path):
        svc = _make_service(tmp_path)
        svc.remove_disabled("nonexistent")
        assert svc.get_disabled() == frozenset()

    def test_clear(self, tmp_path: Path):
        svc = _make_service(tmp_path)
        svc.set_disabled(["a", "b", "c"])
        svc.clear()
        assert svc.get_disabled() == frozenset()

    def test_persists_to_disk(self, tmp_path: Path):
        svc = _make_service(tmp_path)
        svc.set_disabled(["rename_element"])
        # File written on save
        path = tmp_path / "tool_settings.json"
        assert path.exists()
        data = json.loads(path.read_text())
        assert "rename_element" in data["disabled_tools"]

    def test_reloads_from_disk(self, tmp_path: Path):
        svc1 = _make_service(tmp_path)
        svc1.set_disabled(["a", "b"])
        # New instance pointed at same path
        svc2 = _make_service(tmp_path)
        assert svc2.get_disabled() == frozenset({"a", "b"})

    def test_corrupt_json_defaults_to_empty(self, tmp_path: Path):
        """A corrupt or unreadable file must NOT crash the backend on
        startup - fall through to empty disabled set."""
        path = tmp_path / "tool_settings.json"
        path.write_text("{not valid json")
        svc = ToolSettingsService(path=path)
        assert svc.get_disabled() == frozenset()

    def test_disk_format_is_sorted(self, tmp_path: Path):
        """JSON on disk has names sorted alphabetically so diffs are
        stable across re-saves."""
        svc = _make_service(tmp_path)
        svc.set_disabled(["c", "a", "b"])
        data = json.loads((tmp_path / "tool_settings.json").read_text())
        assert data["disabled_tools"] == ["a", "b", "c"]


# ---------------------------------------------------------------------------
# check_global_disable_block - routing gate
# ---------------------------------------------------------------------------


@pytest.fixture
def reset_singleton():
    """Snapshot + restore the module-level singleton so test mutations
    don't leak into other suites."""
    before = tool_settings_service.get_disabled()
    yield
    tool_settings_service.set_disabled(before)


class TestGlobalDisableBlock:
    def test_returns_none_when_not_disabled(self, reset_singleton):
        tool_settings_service.set_disabled([])
        assert check_global_disable_block("rename_element") is None

    def test_returns_envelope_when_disabled(self, reset_singleton):
        tool_settings_service.set_disabled(["rename_element"])
        block = check_global_disable_block("rename_element")
        assert block is not None
        assert block["blocked_by_global_disable"] is True
        assert block["tool"] == "rename_element"
        assert "rename_element" in block["error"]
        assert "Chat Manager" in block["error"]

    def test_other_tools_not_affected(self, reset_singleton):
        tool_settings_service.set_disabled(["execute_ifc_code"])
        assert check_global_disable_block("rename_element") is None
        assert check_global_disable_block("execute_ifc_code") is not None


# ---------------------------------------------------------------------------
# GET / PUT /api/chat/tools/settings
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_returns_empty_by_default(reset_singleton):
    tool_settings_service.set_disabled([])
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        r = await client.get("/api/chat/tools/settings")
        assert r.status_code == 200
        assert r.json() == {"disabled_tools": []}


@pytest.mark.asyncio
async def test_put_persists_and_get_reads_back(reset_singleton):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        r = await client.put(
            "/api/chat/tools/settings",
            json={"disabled_tools": ["rename_element", "execute_ifc_code"]},
        )
        assert r.status_code == 200
        # Response is the canonical sorted set
        assert r.json() == {"disabled_tools": ["execute_ifc_code", "rename_element"]}
        # Round-trip via GET
        r2 = await client.get("/api/chat/tools/settings")
        assert r2.json() == {
            "disabled_tools": ["execute_ifc_code", "rename_element"],
        }


@pytest.mark.asyncio
async def test_put_with_empty_list_clears_disabled(reset_singleton):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # First disable something
        await client.put(
            "/api/chat/tools/settings", json={"disabled_tools": ["rename_element"]},
        )
        # Then clear by putting empty list
        r = await client.put(
            "/api/chat/tools/settings", json={"disabled_tools": []},
        )
        assert r.status_code == 200
        assert r.json() == {"disabled_tools": []}
