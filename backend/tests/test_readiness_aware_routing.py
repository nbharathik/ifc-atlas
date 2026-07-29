"""Readiness-aware tool routing.

While the IfcOpenShell readiness service reports warming, read
tools with a metadata_index_service fast path should serve queries
via the native index instead of returning a "warming" envelope. The
result is annotated with ``_source: "native_index"`` + ``_complete:
false`` so the agent + UI know the payload is partial relative to the
eventual IfcOpenShell-served full payload.

These tests pin the routing contract - adding a tool to
``_NATIVE_INDEX_ELIGIBLE_TOOLS`` without also wiring its body branch
should surface here, not in production.
"""

from __future__ import annotations

import pytest

from app.services.readiness_service import readiness_service
from app.services.tools import (
    _NATIVE_INDEX_ELIGIBLE_TOOLS,
    _native_index_ready,
    warming_envelope,
)


# ---------------------------------------------------------------------------
# Fixture - force IfcOpenShell to "warming" + leave native-index off by default
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def warming_state(monkeypatch):
    """Pin readiness to ``warming`` so the gate is testable. The repo-wide
    conftest's autouse fixture marks IfcOpenShell ready + monkeypatches
    the live probes; we override both."""
    from app.services import readiness_service as _rs

    monkeypatch.setattr(_rs, "_safe_ifc_service_is_loaded", lambda: False)
    monkeypatch.setattr(_rs, "_safe_native_index_is_loaded", lambda: False)
    readiness_service.reset(model_id="test")
    readiness_service.mark_ifcopenshell_warming()
    yield
    readiness_service.reset(model_id=None)


# ---------------------------------------------------------------------------
# _NATIVE_INDEX_ELIGIBLE_TOOLS - the routing allowlist
# ---------------------------------------------------------------------------


class TestNativeIndexEligibleTools:
    def test_contains_the_eligible_tool_set(self):
        """Pin the explicit eligible-subtool list. Each entry needs a matching
        `if _mi:` branch in ``_run_subtool``. These are INTERNAL subtool
        names; the public gate maps merged (tool, arguments) calls onto them
        via ``_native_index_eligible``."""
        assert _NATIVE_INDEX_ELIGIBLE_TOOLS == frozenset({
            "get_project_info",
            "get_model_stats",
            "search_elements",
            "get_elements_by_type",
            "get_elements_by_storey",
            "get_storeys",
        })

    def test_write_tools_excluded(self):
        for tool in ("edit_semantic", "edit_structural", "execute_ifc_code"):
            assert tool not in _NATIVE_INDEX_ELIGIBLE_TOOLS

    def test_get_element_details_excluded(self):
        """``get_element_details`` is NOT in the eligible set - its
        ifcopenshell path returns the full property detail; the native
        path only enriches with ``_native_psets``."""
        assert "get_element_details" not in _NATIVE_INDEX_ELIGIBLE_TOOLS


# ---------------------------------------------------------------------------
# warming_envelope - native-index bypass behaviour
# ---------------------------------------------------------------------------


class TestWarmingEnvelopeNativeBypass:
    def test_eligible_tool_gated_when_native_index_NOT_ready(self, monkeypatch):
        """Without the native index, the warming envelope still fires for
        read_model tools - the warming gate is preserved."""
        monkeypatch.setattr(
            "app.services.tools._native_index_ready", lambda: False
        )
        envelope = warming_envelope("describe_model", {"part": "project"})
        assert envelope is not None
        assert envelope["warming"] is True

    def test_eligible_tool_passes_when_native_index_ready(self, monkeypatch):
        """With the native index loaded, an eligible tool bypasses the
        gate so it can serve from the native fast path."""
        monkeypatch.setattr(
            "app.services.tools._native_index_ready", lambda: True
        )
        for tool, args in (
            ("describe_model", {"part": "project"}),
            ("describe_model", {"part": "stats"}),
            ("describe_model", {"part": "storeys"}),
            ("query_elements", {"mode": "text", "query": "x"}),
            ("query_elements", {"mode": "type", "ifc_type": "IfcWall"}),
            ("query_elements", {"mode": "storey", "storey_id": 1}),
        ):
            envelope = warming_envelope(tool, args)
            assert envelope is None, f"{tool!r} {args} should bypass gate when native_index ready"

    def test_non_eligible_read_tool_still_gated_with_native_index_ready(
        self, monkeypatch
    ):
        """A non-eligible read_model call (e.g. ``get_element``, whose
        ifcopenshell path returns the full property detail) still gets the
        envelope even with native_index ready - the bypass is opt-in
        per-mode."""
        monkeypatch.setattr(
            "app.services.tools._native_index_ready", lambda: True
        )
        envelope = warming_envelope("get_element", {"element_id": 1})
        assert envelope is not None
        assert envelope["warming"] is True

    def test_write_tool_always_gated_regardless_of_native_index(self, monkeypatch):
        """Write tools never benefit from native_index bypass - the
        write path needs the live IfcOpenShell model."""
        monkeypatch.setattr(
            "app.services.tools._native_index_ready", lambda: True
        )
        envelope = warming_envelope(
            "edit_semantic",
            {"ops": [{"op": "set_name", "element_id": 1, "new_name": "x"}]},
        )
        assert envelope is not None
        assert envelope["warming"] is True

    def test_viewer_tool_exempt_regardless(self, monkeypatch):
        """``read_viewer`` tier was already exempt before readiness-aware
        routing; verify the new check doesn't regress that."""
        monkeypatch.setattr(
            "app.services.tools._native_index_ready", lambda: False
        )
        envelope = warming_envelope(
            "viewer_control", {"action": "highlight", "element_ids": [1]}
        )
        assert envelope is None


# ---------------------------------------------------------------------------
# _native_index_ready - defensive probe
# ---------------------------------------------------------------------------


class TestNativeIndexReadyProbe:
    def test_returns_bool(self):
        """The probe always returns a bool - never raises, never None."""
        result = _native_index_ready()
        assert isinstance(result, bool)

    def test_returns_false_when_service_raises(self, monkeypatch):
        """If metadata_index_service.is_loaded raises (import cycle /
        attr error), the probe must return False, not propagate."""
        class _Boom:
            @property
            def is_loaded(self):
                raise RuntimeError("simulated import-time failure")

        monkeypatch.setattr("app.services.tools.metadata_index_service", _Boom())
        assert _native_index_ready() is False
