"""End-to-end readiness gate coverage.

The readiness state machine + warming envelope already
ship the core mechanism: while IfcOpenShell is still warming, ``execute_tool``
returns a synthetic ``warming`` envelope for any tier outside ``read_viewer``.

These tests pin that contract so a future refactor cannot silently regress
the gate. They cover the three tiers:

* ``read_viewer``   - never gated (highlight, isolate, select, etc.)
* ``read_model``    - gated until ready
* ``write_edit``    - gated until ready

The full async-return upload refactor (return ``ModelMeta`` before
IfcOpenShell finishes loading) is deferred to v1.1: it requires Pydantic
schema changes (``ModelMeta.project`` becomes optional) plus matching
frontend handling, and the user-visible win - preventing the LLM from
calling tier-2 tools during warmup - is already delivered by the gate
below.
"""

from __future__ import annotations

import pytest

from app.services.readiness_service import readiness_service
from app.services.tools import execute_tool, tool_tier, warming_envelope


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def reset_readiness(monkeypatch):
    """Ensure each test starts from a clean readiness state.

    The repo-wide conftest autouse fixture monkeypatches both probes to
    ``True`` and marks readiness ready so legacy tests reach the tool
    bodies. For these tests we WANT the warming gate to fire, so we
    re-pin both probes to ``False`` and reset state to cold; the
    reconcile-up branch in ``readiness_service.get_state()`` then leaves
    our explicit ``mark_*`` calls intact.
    """
    from app.services import readiness_service as _rs

    monkeypatch.setattr(_rs, "_safe_ifc_service_is_loaded", lambda: False)
    monkeypatch.setattr(_rs, "_safe_native_index_is_loaded", lambda: False)
    readiness_service.reset(model_id="test")
    yield
    readiness_service.reset(model_id=None)


# ---------------------------------------------------------------------------
# warming_envelope tier behaviour
# ---------------------------------------------------------------------------


class TestWarmingEnvelopeTiers:
    def test_viewer_tool_exempt_when_warming(self):
        readiness_service.mark_ifcopenshell_warming()
        # viewer_control is read_viewer - runs without IfcOpenShell
        assert tool_tier("viewer_control")[0] == "read_viewer"
        assert warming_envelope("viewer_control") is None

    def test_viewer_tool_exempt_when_cold(self):
        # Default state is 'cold' (right after reset, never warmed)
        assert readiness_service.get_state().ifcopenshell == "cold"
        assert warming_envelope("viewer_control") is None

    def test_read_model_tool_gated_when_warming(self):
        readiness_service.mark_ifcopenshell_warming()
        envelope = warming_envelope("describe_model")
        assert envelope is not None
        assert envelope["warming"] is True
        assert envelope["ifcopenshell"] == "warming"
        assert envelope["tool"] == "describe_model"
        assert envelope["retry_after_ms"] == 2000

    def test_write_edit_tool_gated_when_warming(self):
        readiness_service.mark_ifcopenshell_warming()
        envelope = warming_envelope("edit_semantic")
        assert envelope is not None
        assert envelope["warming"] is True
        # tier label includes a Unicode em-dash; just check the prefix
        assert envelope["tier"].startswith("Write")

    def test_gate_clears_on_ready(self, monkeypatch):
        from app.services import readiness_service as _rs

        readiness_service.mark_ifcopenshell_warming()
        assert warming_envelope("edit_semantic") is not None
        # Flip the live probe to True so the reconcile-down branch in
        # get_state() doesn't drop us back to cold immediately after we
        # call mark_ifcopenshell_ready() with no real service loaded.
        monkeypatch.setattr(_rs, "_safe_ifc_service_is_loaded", lambda: True)
        readiness_service.mark_ifcopenshell_ready()
        # After ready, the gate should be clear for ALL tiers
        assert warming_envelope("edit_semantic") is None
        assert warming_envelope("describe_model") is None
        assert warming_envelope("viewer_control") is None

    def test_gate_clears_on_error(self):
        """An error state lets through so the tool surfaces a concrete failure."""
        readiness_service.mark_ifcopenshell_warming()
        readiness_service.mark_ifcopenshell_error("test failure")
        # Error is treated as 'done warming' so the tool runs and surfaces
        # its own error instead of an opaque 'still warming' message.
        assert warming_envelope("edit_semantic") is None


# ---------------------------------------------------------------------------
# execute_tool integration - full gate path
# ---------------------------------------------------------------------------


class TestExecuteToolGate:
    def test_execute_tool_returns_envelope_for_gated_tier(self):
        """``execute_tool`` MUST short-circuit through ``warming_envelope``
        before touching IfcOpenShell. This is what protects the LLM from
        crashing on tier-2 calls during the upload warmup window."""
        readiness_service.mark_ifcopenshell_warming()
        result = execute_tool(
            "edit_semantic",
            {"ops": [{"op": "set_name", "element_id": 1, "new_name": "x"}]},
        )
        assert result.get("warming") is True
        assert result.get("ifcopenshell") == "warming"
        # The synthetic envelope must NOT be memoised - the next call after
        # readiness flips to ready must re-run the real tool.
        assert "_memo" not in result

    def test_execute_tool_envelope_not_memoised(self):
        """Second call during warming gets a fresh envelope, not _memo."""
        readiness_service.mark_ifcopenshell_warming()
        first = execute_tool("describe_model", {"part": "stats"})
        second = execute_tool("describe_model", {"part": "stats"})
        assert first.get("warming") is True
        assert second.get("warming") is True
        assert "_memo" not in second

    def test_execute_tool_skips_envelope_for_viewer_tier(self):
        """Viewer tools must never hit the warming gate, even during warmup.

        The tool itself may still fail (e.g. 'No IFC model loaded') but the
        ``warming`` envelope must NOT be returned - that's what proves the
        gate is bypassed for ``read_viewer`` tier.
        """
        readiness_service.mark_ifcopenshell_warming()
        result = execute_tool(
            "viewer_control", {"action": "highlight", "element_ids": [1, 2, 3]}
        )
        assert result.get("warming") is not True
        assert "retry_after_ms" not in result
