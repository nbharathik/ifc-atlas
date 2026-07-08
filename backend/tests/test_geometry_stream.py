"""Tests for the streaming geometry endpoint.

Covers ``POST /api/ifc/geometry/stream`` (FastAPI) + the underlying
``sidecar_manager.geometry_stream`` async generator. The sidecar HTTP
call is patched out so no live Node process is required.

Scope (this file): happy path NDJSON shape + validation + error
forwarding. A contract test that runs the real sidecar against
``BasicHouse.ifc`` is deferred follow-up work.
"""
from __future__ import annotations

import json
from io import BytesIO
from typing import AsyncIterator
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def client():
    from app.main import app
    return TestClient(app, raise_server_exceptions=False)


async def _stub_events_ok() -> AsyncIterator[dict]:
    """Emit a realistic start/batch/batch/summary sequence."""
    yield {"type": "start", "modelId": "test-model", "batchSize": 2}
    yield {
        "type": "batch",
        "batchIndex": 0,
        "meshes": [
            {"expressId": 100, "ifcType": "IFCWALL", "name": "Wall A",
             "positions": "AA==", "indices": "BB==", "bbox": [0, 0, 0, 1, 1, 1]},
            {"expressId": 101, "ifcType": "IFCWALL", "name": "Wall B",
             "positions": "AA==", "indices": "BB==", "bbox": [0, 0, 0, 1, 1, 1]},
        ],
    }
    yield {
        "type": "batch",
        "batchIndex": 1,
        "meshes": [
            {"expressId": 102, "ifcType": "IFCSLAB", "name": "Slab",
             "positions": "AA==", "indices": "BB==", "bbox": [0, 0, 0, 1, 1, 1]},
        ],
    }
    yield {
        "type": "summary",
        "modelId": "test-model",
        "meshCount": 3,
        "attempted": 3,
        "skipped": 0,
        "batchCount": 2,
        "geoElapsedMs": 11,
        "totalElapsedMs": 22,
    }


async def _stub_events_error_after_start() -> AsyncIterator[dict]:
    yield {"type": "start", "modelId": "test-model", "batchSize": 100}
    raise RuntimeError("sidecar disappeared mid-stream")


def _split_ndjson(body: bytes) -> list[dict]:
    """Parse a chunked NDJSON body into a list of decoded events."""
    out: list[dict] = []
    for raw in body.splitlines():
        line = raw.strip()
        if not line:
            continue
        out.append(json.loads(line))
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Happy path
# ─────────────────────────────────────────────────────────────────────────────


def test_stream_endpoint_happy_path_emits_ordered_ndjson(client):
    """Endpoint forwards sidecar events as NDJSON in original order."""
    with patch(
        "app.services.sidecar_manager.SidecarManager.geometry_stream",
        return_value=_stub_events_ok(),
    ), patch(
        "app.services.sidecar_manager.SidecarManager.ensure_running",
        return_value=True,
    ):
        fake_ifc = b"ISO-10303-21; ... fake ifc content"
        resp = client.post(
            "/api/ifc/geometry/stream",
            files={"file": ("model.ifc", BytesIO(fake_ifc), "application/octet-stream")},
        )

    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("application/x-ndjson")
    assert resp.headers["x-geometry-batch-size"] == "100"

    events = _split_ndjson(resp.content)
    types = [e["type"] for e in events]
    assert types == ["start", "batch", "batch", "summary"], events

    # batch indices preserved
    assert events[1]["batchIndex"] == 0
    assert events[2]["batchIndex"] == 1
    assert len(events[1]["meshes"]) == 2
    assert len(events[2]["meshes"]) == 1

    # summary numbers preserved
    assert events[3]["meshCount"] == 3
    assert events[3]["batchCount"] == 2


def test_stream_endpoint_passes_batch_size_query_param(client):
    """`?batchSize=` query is forwarded to the response header."""
    with patch(
        "app.services.sidecar_manager.SidecarManager.geometry_stream",
        return_value=_stub_events_ok(),
    ), patch(
        "app.services.sidecar_manager.SidecarManager.ensure_running",
        return_value=True,
    ):
        resp = client.post(
            "/api/ifc/geometry/stream?batchSize=25",
            files={"file": ("m.ifc", BytesIO(b"data"), "application/octet-stream")},
        )

    assert resp.status_code == 200
    assert resp.headers["x-geometry-batch-size"] == "25"


# ─────────────────────────────────────────────────────────────────────────────
# Validation
# ─────────────────────────────────────────────────────────────────────────────


def test_stream_endpoint_rejects_non_ifc(client):
    with patch(
        "app.services.sidecar_manager.SidecarManager.geometry_stream",
        return_value=_stub_events_ok(),
    ), patch(
        "app.services.sidecar_manager.SidecarManager.ensure_running",
        return_value=True,
    ):
        resp = client.post(
            "/api/ifc/geometry/stream",
            files={"file": ("model.obj", BytesIO(b"obj"), "application/octet-stream")},
        )
    assert resp.status_code == 400


def test_stream_endpoint_rejects_empty_file(client):
    with patch(
        "app.services.sidecar_manager.SidecarManager.geometry_stream",
        return_value=_stub_events_ok(),
    ), patch(
        "app.services.sidecar_manager.SidecarManager.ensure_running",
        return_value=True,
    ):
        resp = client.post(
            "/api/ifc/geometry/stream",
            files={"file": ("model.ifc", BytesIO(b""), "application/octet-stream")},
        )
    assert resp.status_code == 400


def test_stream_endpoint_rejects_invalid_batch_size(client):
    with patch(
        "app.services.sidecar_manager.SidecarManager.ensure_running",
        return_value=True,
    ):
        resp = client.post(
            "/api/ifc/geometry/stream?batchSize=0",
            files={"file": ("m.ifc", BytesIO(b"x"), "application/octet-stream")},
        )
    # FastAPI Query(ge=1) → 422 for batchSize=0
    assert resp.status_code == 422


# ─────────────────────────────────────────────────────────────────────────────
# Error forwarding
# ─────────────────────────────────────────────────────────────────────────────


def test_stream_endpoint_emits_terminal_error_event_on_runtime_error(client):
    """When the sidecar raises mid-stream, the endpoint still returns 200
    but appends a terminal `error` event (headers were already sent)."""
    with patch(
        "app.services.sidecar_manager.SidecarManager.geometry_stream",
        return_value=_stub_events_error_after_start(),
    ), patch(
        "app.services.sidecar_manager.SidecarManager.ensure_running",
        return_value=True,
    ):
        resp = client.post(
            "/api/ifc/geometry/stream",
            files={"file": ("m.ifc", BytesIO(b"data"), "application/octet-stream")},
        )

    assert resp.status_code == 200
    events = _split_ndjson(resp.content)
    types = [e["type"] for e in events]
    assert types == ["start", "error"], events
    assert "sidecar disappeared" in events[1]["message"]
