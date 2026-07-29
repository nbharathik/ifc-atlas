"""Tests for the AI backend readiness state machine.

A smoke set that exercises the public transitions + the live-service
reconcile path, plus WS-broadcast and warming-envelope coverage below.
"""

from __future__ import annotations


from app.services import readiness_service as rs_module
from app.services.readiness_service import ReadinessService


def _fresh() -> ReadinessService:
    """Each test gets its own service so the singleton isn't polluted."""
    return ReadinessService()


def test_initial_state_is_cold_and_absent(monkeypatch):
    # Pin the live probes off so the reconcile logic doesn't promote our
    # fresh instance based on a singleton ifc_service.is_loaded that a
    # prior test in the full suite may have set to True.
    monkeypatch.setattr(rs_module, "_safe_ifc_service_is_loaded", lambda: False)
    monkeypatch.setattr(rs_module, "_safe_native_index_is_loaded", lambda: False)
    svc = _fresh()
    snap = svc.get_state()
    assert snap.native_index == "absent"
    assert snap.ifcopenshell == "cold"
    assert snap.model_id is None
    assert snap.timings_ms.native_index_built_ms is None
    assert snap.timings_ms.ifcopenshell_loaded_ms is None


def test_ifcopenshell_warming_then_ready_records_timing(monkeypatch):
    svc = _fresh()
    # Force both live-service probes to return False so the reconcile
    # path doesn't pre-empt our explicit transitions.
    monkeypatch.setattr(rs_module, "_safe_ifc_service_is_loaded", lambda: False)
    monkeypatch.setattr(rs_module, "_safe_native_index_is_loaded", lambda: False)

    svc.mark_ifcopenshell_warming()
    assert svc.get_state().ifcopenshell == "warming"

    svc.mark_ifcopenshell_ready()
    # After mark_ready, live probe is False so reconcile drops it back
    # to cold - that's exactly the lying-chip guard. Verify by re-enabling
    # the live probe and re-reading.
    monkeypatch.setattr(rs_module, "_safe_ifc_service_is_loaded", lambda: True)
    snap = svc.get_state()
    assert snap.ifcopenshell == "ready"
    assert snap.timings_ms.ifcopenshell_loaded_ms is not None
    assert snap.timings_ms.ifcopenshell_loaded_ms >= 0


def test_native_index_building_then_ready(monkeypatch):
    svc = _fresh()
    monkeypatch.setattr(rs_module, "_safe_ifc_service_is_loaded", lambda: False)
    monkeypatch.setattr(rs_module, "_safe_native_index_is_loaded", lambda: True)

    svc.mark_native_index_building()
    svc.mark_native_index_ready(total_ms=1670)
    snap = svc.get_state()
    assert snap.native_index == "ready"
    assert snap.timings_ms.native_index_built_ms == 1670


def test_error_state_persists(monkeypatch):
    svc = _fresh()
    monkeypatch.setattr(rs_module, "_safe_ifc_service_is_loaded", lambda: False)
    monkeypatch.setattr(rs_module, "_safe_native_index_is_loaded", lambda: False)

    svc.mark_ifcopenshell_warming()
    svc.mark_ifcopenshell_error("boom")
    snap = svc.get_state()
    assert snap.ifcopenshell == "error"
    assert snap.ifcopenshell_error == "boom"


def test_reset_clears_everything(monkeypatch):
    svc = _fresh()
    monkeypatch.setattr(rs_module, "_safe_ifc_service_is_loaded", lambda: False)
    monkeypatch.setattr(rs_module, "_safe_native_index_is_loaded", lambda: False)

    svc.mark_ifcopenshell_warming()
    svc.mark_ifcopenshell_ready()
    svc.mark_native_index_building()
    svc.mark_native_index_ready(total_ms=100)

    svc.reset(model_id="newfile.ifc")
    snap = svc.get_state()
    assert snap.model_id == "newfile.ifc"
    assert snap.ifcopenshell == "cold"
    assert snap.native_index == "absent"
    assert snap.timings_ms.ifcopenshell_loaded_ms is None
    assert snap.timings_ms.native_index_built_ms is None


def test_reconcile_promotes_unmarked_ready(monkeypatch):
    """If the underlying services are loaded but we never saw the mark,
    get_state() self-heals by promoting the state. Guards against a
    crash between mark_warming and mark_ready.
    """
    svc = _fresh()
    monkeypatch.setattr(rs_module, "_safe_ifc_service_is_loaded", lambda: True)
    monkeypatch.setattr(rs_module, "_safe_native_index_is_loaded", lambda: True)

    snap = svc.get_state()
    assert snap.ifcopenshell == "ready"
    assert snap.native_index == "ready"


def test_reconcile_drops_stale_ready(monkeypatch):
    """After an unload, the chip must NOT keep showing ready forever."""
    svc = _fresh()
    monkeypatch.setattr(rs_module, "_safe_ifc_service_is_loaded", lambda: True)
    monkeypatch.setattr(rs_module, "_safe_native_index_is_loaded", lambda: True)
    # First read promotes to ready.
    assert svc.get_state().ifcopenshell == "ready"

    # Services unload - reconcile drops us back to cold/absent.
    monkeypatch.setattr(rs_module, "_safe_ifc_service_is_loaded", lambda: False)
    monkeypatch.setattr(rs_module, "_safe_native_index_is_loaded", lambda: False)
    snap = svc.get_state()
    assert snap.ifcopenshell == "cold"
    assert snap.native_index == "absent"


def test_pydantic_serialisation_roundtrip(monkeypatch):
    """ReadinessStatus must accept what the service emits unchanged."""
    from app.models.ifc_models import ReadinessStatus, ReadinessTimingsModel

    svc = _fresh()
    monkeypatch.setattr(rs_module, "_safe_ifc_service_is_loaded", lambda: True)
    monkeypatch.setattr(rs_module, "_safe_native_index_is_loaded", lambda: False)
    svc.mark_ifcopenshell_warming()
    svc.mark_ifcopenshell_ready()
    snap = svc.get_state()

    model = ReadinessStatus(
        model_id=snap.model_id,
        native_index=snap.native_index,
        ifcopenshell=snap.ifcopenshell,
        timings_ms=ReadinessTimingsModel(
            native_index_built_ms=snap.timings_ms.native_index_built_ms,
            ifcopenshell_loaded_ms=snap.timings_ms.ifcopenshell_loaded_ms,
        ),
        native_index_error=snap.native_index_error,
        ifcopenshell_error=snap.ifcopenshell_error,
    )
    assert model.ifcopenshell == "ready"
    assert model.native_index == "absent"


# ───────────────────────────────────────────────────────────────────────────
# broadcast_readiness_changed pushes the current snapshot over
# the model_sync_broker so the chat-panel chip never has to poll.
# ───────────────────────────────────────────────────────────────────────────


def test_broadcast_readiness_changed_publishes_event(monkeypatch):
    """broadcast_readiness_changed() emits a readiness_changed ModelSyncEvent
    carrying the current snapshot in payload['readiness']."""
    import asyncio

    from app.services.readiness_service import broadcast_readiness_changed
    from app.services import readiness_service as rs_module_local
    from app.services.model_sync import model_sync_broker

    monkeypatch.setattr(rs_module_local, "_safe_ifc_service_is_loaded", lambda: False)
    monkeypatch.setattr(rs_module_local, "_safe_native_index_is_loaded", lambda: False)
    # Force the global singleton into a known state so the broadcast carries it.
    rs_module_local.readiness_service.reset(model_id="probe.ifc")
    rs_module_local.readiness_service.mark_ifcopenshell_warming()

    async def _run() -> None:
        queue = await model_sync_broker.subscribe()
        try:
            await broadcast_readiness_changed()
            event = await asyncio.wait_for(queue.get(), timeout=1.0)
            assert event.type == "readiness_changed"
            # No model loaded -> safe defaults for the contract.
            assert event.model_fingerprint == ""
            assert event.model_version == 0
            r = event.payload["readiness"]
            assert r["model_id"] == "probe.ifc"
            assert r["ifcopenshell"] == "warming"
            assert r["native_index"] == "absent"
        finally:
            await model_sync_broker.unsubscribe(queue)

    asyncio.run(_run())


def test_broadcast_readiness_changed_survives_missing_ifc_service(monkeypatch):
    """If ifc_service import or contract call fails, broadcast still emits
    a safe-default event instead of bubbling the error."""
    import asyncio

    from app.services.readiness_service import broadcast_readiness_changed
    from app.services.model_sync import model_sync_broker

    async def _run() -> None:
        queue = await model_sync_broker.subscribe()
        try:
            await broadcast_readiness_changed()
            event = await asyncio.wait_for(queue.get(), timeout=1.0)
            assert event.type == "readiness_changed"
            assert event.model_version >= 0
            assert "readiness" in event.payload
        finally:
            await model_sync_broker.unsubscribe(queue)

    asyncio.run(_run())


# ───────────────────────────────────────────────────────────────────────────
# warming_envelope gates tier-2 tools while ifcopenshell is
# still warming so the LLM gets a clear retry signal instead of a crash.
# ───────────────────────────────────────────────────────────────────────────


def test_warming_envelope_blocks_read_model_tools_while_warming(monkeypatch):
    from app.services.tools import warming_envelope
    from app.services import readiness_service as rs_module_local

    rs_module_local.readiness_service.reset()
    rs_module_local.readiness_service.mark_ifcopenshell_warming()
    monkeypatch.setattr(rs_module_local, "_safe_ifc_service_is_loaded", lambda: False)

    env = warming_envelope("search_elements")
    assert env is not None
    assert env["warming"] is True
    assert env["ifcopenshell"] == "warming"
    assert env["tool"] == "search_elements"
    assert env["retry_after_ms"] == 2000


def test_warming_envelope_exempts_read_viewer_tools(monkeypatch):
    """Viewer tools (highlight, isolate, ...) don't need IfcOpenShell."""
    from app.services.tools import warming_envelope
    from app.services import readiness_service as rs_module_local

    rs_module_local.readiness_service.reset()
    rs_module_local.readiness_service.mark_ifcopenshell_warming()
    monkeypatch.setattr(rs_module_local, "_safe_ifc_service_is_loaded", lambda: False)

    for name in ("highlight_elements", "isolate_elements", "select_element"):
        assert warming_envelope(name) is None, name


def test_warming_envelope_clears_once_ready(monkeypatch):
    from app.services.tools import warming_envelope
    from app.services import readiness_service as rs_module_local

    rs_module_local.readiness_service.reset()
    rs_module_local.readiness_service.mark_ifcopenshell_warming()
    rs_module_local.readiness_service.mark_ifcopenshell_ready()
    monkeypatch.setattr(rs_module_local, "_safe_ifc_service_is_loaded", lambda: True)

    assert warming_envelope("search_elements") is None


def test_warming_envelope_passthrough_on_error(monkeypatch):
    """When ifcos errored, let the actual tool surface a concrete failure
    instead of masking it behind 'still warming'."""
    from app.services.tools import warming_envelope
    from app.services import readiness_service as rs_module_local

    rs_module_local.readiness_service.reset()
    rs_module_local.readiness_service.mark_ifcopenshell_warming()
    rs_module_local.readiness_service.mark_ifcopenshell_error("boom")
    monkeypatch.setattr(rs_module_local, "_safe_ifc_service_is_loaded", lambda: False)

    assert warming_envelope("search_elements") is None


def test_execute_tool_returns_warming_envelope_without_running(monkeypatch):
    """execute_tool() short-circuits the warming envelope and does NOT
    memoize it, so the next call after warm-up gets fresh data."""
    from app.services import tools as tools_module
    from app.services import readiness_service as rs_module_local

    rs_module_local.readiness_service.reset()
    rs_module_local.readiness_service.mark_ifcopenshell_warming()
    monkeypatch.setattr(rs_module_local, "_safe_ifc_service_is_loaded", lambda: False)

    raw_called = []

    def _raw(name, args, **kwargs):
        raw_called.append(name)
        return {"ok": True}

    monkeypatch.setattr(tools_module, "_execute_tool_raw", _raw)
    # Fresh memo to avoid leakage from earlier tests.
    tools_module.tool_memo_cache.invalidate()

    out = tools_module.execute_tool("search_elements", {"query": "x"})
    assert out["warming"] is True
    assert raw_called == []  # The raw tool was NOT executed.

    # After warm-up, the same call runs through to the raw tool.
    rs_module_local.readiness_service.mark_ifcopenshell_ready()
    monkeypatch.setattr(rs_module_local, "_safe_ifc_service_is_loaded", lambda: True)
    out2 = tools_module.execute_tool("search_elements", {"query": "x"})
    assert out2 == {"ok": True}
    assert raw_called == ["search_elements"]
