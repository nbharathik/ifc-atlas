"""
Structural route checks for the FastAPI app assembled in app.main.

Follows the route-inspection style of test_mcp_server.py: no HTTP traffic -
import the app object and assert the expected paths are registered. This
catches the failure mode where a router module exists but was never wired
into app.main via include_router.
"""

from __future__ import annotations

import pytest

from app.main import app

# One representative path per feature router. Each router carries its own
# prefix, so the presence of these paths proves the include_router call landed.
EXPECTED_PATHS = [
    "/api/qto/summary",
    "/api/ids/library",
    "/api/bcf/topics",
    "/api/plugins",
    "/api/viewer/state",
    "/api/viewer/command",
]


def _registered_paths() -> set[str]:
    """All route paths on the app (APIRoute, WebSocketRoute, and Mount alike)."""
    return {getattr(r, "path", "") for r in app.routes}


class TestFeatureRoutersRegistered:
    @pytest.mark.parametrize("path", EXPECTED_PATHS)
    def test_path_registered(self, path: str):
        paths = _registered_paths()
        assert path in paths, (
            f"Expected route {path} to be registered in app.main; "
            f"registered paths: {sorted(p for p in paths if p)}"
        )

    def test_all_expected_paths_present(self):
        """Aggregate check so a wiring regression reports every missing path at once."""
        missing = [p for p in EXPECTED_PATHS if p not in _registered_paths()]
        assert not missing, f"Routes missing from app.main: {missing}"


class TestRouteMethods:
    """The representative paths must expose the verbs the frontend/CLI call."""

    def _methods_for(self, path: str) -> set[str]:
        methods: set[str] = set()
        for r in app.routes:
            if getattr(r, "path", "") == path:
                methods |= set(getattr(r, "methods", None) or ())
        return methods

    def test_qto_summary_is_get(self):
        assert "GET" in self._methods_for("/api/qto/summary")

    def test_ids_library_supports_get_and_post(self):
        methods = self._methods_for("/api/ids/library")
        assert {"GET", "POST"} <= methods

    def test_bcf_topics_supports_get_and_post(self):
        methods = self._methods_for("/api/bcf/topics")
        assert {"GET", "POST"} <= methods

    def test_plugins_supports_get_and_post(self):
        methods = self._methods_for("/api/plugins")
        assert {"GET", "POST"} <= methods

    def test_viewer_state_supports_get_and_post(self):
        methods = self._methods_for("/api/viewer/state")
        assert {"GET", "POST"} <= methods

    def test_viewer_command_is_post(self):
        assert "POST" in self._methods_for("/api/viewer/command")


class TestExistingRoutesStillPresent:
    """Adding the new routers must not displace the long-standing core routes."""

    def test_health_route_present(self):
        assert "/api/health" in _registered_paths()

    def test_mcp_mount_present(self):
        assert "/mcp" in _registered_paths()
