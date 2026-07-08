"""Sidecar conversion progress capture + polling endpoint.

The sidecar already emits ``SIDECAR_PROGRESS {modelId, stage, progress}``
events to stderr; the sidecar_manager's stderr-tailing thread
forwards each event to the registered listeners. On top of that sits an always-on
listener that captures the latest snapshot per modelId so HTTP pollers
can read it without subscribing to the listener directly.

These tests pin:
  - ``_capture_progress`` filters non-progress events
  - the snapshot dict is LRU-bounded (64 default; small in test)
  - ``GET /api/ifc/convert/progress/{model_id}`` returns the right shape
  - ``clear_progress(model_id)`` drops the snapshot
"""

from __future__ import annotations

import time

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.services.sidecar_manager import (
    ConvertProgress,
    SidecarManager,
    sidecar_manager,
)


# ---------------------------------------------------------------------------
# _capture_progress unit tests
# ---------------------------------------------------------------------------


class TestCaptureProgress:
    def test_progress_event_stored(self):
        mgr = SidecarManager()
        mgr._capture_progress(
            {"event": "progress", "modelId": "m1", "stage": "parse", "progress": 42.5}
        )
        snap = mgr.get_progress("m1")
        assert snap is not None
        assert snap.model_id == "m1"
        assert snap.stage == "parse"
        assert snap.progress == 42.5
        assert snap.updated_at > 0

    def test_non_progress_event_ignored(self):
        mgr = SidecarManager()
        mgr._capture_progress({"event": "ready", "modelId": "m1"})
        mgr._capture_progress({"event": "done", "modelId": "m1"})
        assert mgr.get_progress("m1") is None

    def test_missing_model_id_ignored(self):
        mgr = SidecarManager()
        mgr._capture_progress({"event": "progress", "stage": "parse", "progress": 10})
        # No modelId → drop
        mgr._capture_progress(
            {"event": "progress", "modelId": "", "stage": "parse", "progress": 10}
        )
        # Empty string also dropped

    def test_malformed_progress_ignored(self):
        mgr = SidecarManager()
        # Non-numeric progress
        mgr._capture_progress(
            {"event": "progress", "modelId": "m1", "stage": "parse", "progress": "fast"}
        )
        # Non-string stage
        mgr._capture_progress(
            {"event": "progress", "modelId": "m1", "stage": 7, "progress": 10}
        )
        assert mgr.get_progress("m1") is None

    def test_re_emit_updates_snapshot(self):
        mgr = SidecarManager()
        mgr._capture_progress(
            {"event": "progress", "modelId": "m1", "stage": "parse", "progress": 10}
        )
        time.sleep(0.005)  # ensure updated_at moves forward
        mgr._capture_progress(
            {"event": "progress", "modelId": "m1", "stage": "geometry", "progress": 80}
        )
        snap = mgr.get_progress("m1")
        assert snap.stage == "geometry"
        assert snap.progress == 80

    def test_lru_eviction(self):
        mgr = SidecarManager()
        mgr._max_progress_entries = 3
        for i in range(5):
            mgr._capture_progress(
                {
                    "event": "progress",
                    "modelId": f"m{i}",
                    "stage": "parse",
                    "progress": i * 10,
                }
            )
        # m0 + m1 evicted
        assert mgr.get_progress("m0") is None
        assert mgr.get_progress("m1") is None
        assert mgr.get_progress("m2") is not None
        assert mgr.get_progress("m4") is not None

    def test_clear_progress_specific_model(self):
        mgr = SidecarManager()
        mgr._capture_progress(
            {"event": "progress", "modelId": "m1", "stage": "x", "progress": 5}
        )
        mgr._capture_progress(
            {"event": "progress", "modelId": "m2", "stage": "y", "progress": 50}
        )
        mgr.clear_progress("m1")
        assert mgr.get_progress("m1") is None
        assert mgr.get_progress("m2") is not None

    def test_clear_progress_all(self):
        mgr = SidecarManager()
        mgr._capture_progress(
            {"event": "progress", "modelId": "m1", "stage": "x", "progress": 5}
        )
        mgr._capture_progress(
            {"event": "progress", "modelId": "m2", "stage": "y", "progress": 50}
        )
        mgr.clear_progress()
        assert mgr.get_progress("m1") is None
        assert mgr.get_progress("m2") is None


# ---------------------------------------------------------------------------
# GET /api/ifc/convert/progress/{model_id} endpoint
# ---------------------------------------------------------------------------


@pytest.fixture
def reset_singleton_progress():
    sidecar_manager.clear_progress()
    yield
    sidecar_manager.clear_progress()


@pytest.mark.asyncio
async def test_endpoint_returns_in_flight_false_when_unknown(reset_singleton_progress):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        r = await client.get("/api/ifc/convert/progress/nonexistent")
        assert r.status_code == 200
        body = r.json()
        assert body == {"model_id": "nonexistent", "in_flight": False}


@pytest.mark.asyncio
async def test_endpoint_returns_snapshot_shape(reset_singleton_progress):
    sidecar_manager._capture_progress(
        {"event": "progress", "modelId": "convert-1", "stage": "parse", "progress": 55.5}
    )
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        r = await client.get("/api/ifc/convert/progress/convert-1")
        assert r.status_code == 200
        body = r.json()
        assert body["model_id"] == "convert-1"
        assert body["stage"] == "parse"
        assert body["progress"] == 55.5
        assert body["in_flight"] is True
        assert body["updated_at"] > 0


@pytest.mark.asyncio
async def test_endpoint_returns_in_flight_false_after_clear(reset_singleton_progress):
    sidecar_manager._capture_progress(
        {"event": "progress", "modelId": "convert-2", "stage": "geometry", "progress": 80}
    )
    sidecar_manager.clear_progress("convert-2")
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        r = await client.get("/api/ifc/convert/progress/convert-2")
        assert r.status_code == 200
        body = r.json()
        assert body["in_flight"] is False


def test_convert_progress_dataclass_fields():
    """ConvertProgress is a stable wire shape - pin its fields."""
    p = ConvertProgress(model_id="m", stage="s", progress=1.0, updated_at=2.0)
    assert p.model_id == "m"
    assert p.stage == "s"
    assert p.progress == 1.0
    assert p.updated_at == 2.0
