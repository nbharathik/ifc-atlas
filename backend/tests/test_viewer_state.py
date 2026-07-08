"""Viewer state/command bridge tests.

Pure-unit: no disk IFC load, no app.main import. The router is mounted on a
fresh FastAPI app per test; the model-sync broker is replaced with a stub so
subscriber counts and published events are deterministic. Broadcast plumbing
lives in app.services.viewer_state_service (shared with the MCP server), so
the stub broker is patched into that module.
"""

from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from httpx import ASGITransport

import app.services.viewer_state_service as viewer_state_service_module
from app.api import viewer_state_routes
from app.models.ifc_models import ModelSyncEvent
from app.services.ifc_service import ifc_service
from app.services.viewer_state_service import ViewerStateService, viewer_state_service


# ---------------------------------------------------------------------------
# Fixtures and helpers
# ---------------------------------------------------------------------------

class StubBroker:
    """Stands in for model_sync_broker: records publishes, fakes subscribers."""

    def __init__(self, subscribers: int = 0):
        self._subscribers = [object() for _ in range(subscribers)]
        self.published: list[ModelSyncEvent] = []

    async def publish(self, event: ModelSyncEvent) -> None:
        self.published.append(event)


@pytest.fixture(autouse=True)
def fresh_viewer_state():
    """Reset the module singleton's state between tests."""
    viewer_state_service._state = None
    viewer_state_service._pending.clear()
    yield
    viewer_state_service._state = None
    viewer_state_service._pending.clear()


@pytest.fixture
def stub_broker(monkeypatch):
    broker = StubBroker(subscribers=1)
    monkeypatch.setattr(viewer_state_service_module, "model_sync_broker", broker)
    return broker


def _make_app() -> FastAPI:
    app = FastAPI()
    app.include_router(viewer_state_routes.router)
    return app


@pytest.fixture
def client():
    return TestClient(_make_app())


FULL_STATE: dict[str, Any] = {
    "camera": {"pos": [1.0, 2.0, 3.0], "target": [0.0, 0.0, 0.0]},
    "selected_id": 42,
    "selected_ids": [42, 43],
    "isolated_count": 2,
    "hidden_count": 5,
    "highlighted_count": 1,
    "model": {"file_name": "House.ifc", "fingerprint": "abc123", "element_count": 149},
    "tab_visible": True,
}


# ---------------------------------------------------------------------------
# State report / read round-trip
# ---------------------------------------------------------------------------

def test_state_round_trip_includes_updated_at(client, stub_broker):
    r = client.post("/api/viewer/state", json=FULL_STATE)
    assert r.status_code == 200
    assert r.json() == {"ok": True}

    r = client.get("/api/viewer/state")
    assert r.status_code == 200
    body = r.json()
    assert body["connected_clients"] == 1
    state = body["state"]
    for key, value in FULL_STATE.items():
        assert state[key] == value, f"state[{key!r}] mismatch"
    # updated_at must be a parseable ISO timestamp added by the backend.
    datetime.fromisoformat(state["updated_at"])


def test_state_is_null_before_any_report(client, monkeypatch):
    monkeypatch.setattr(
        viewer_state_service_module, "model_sync_broker", StubBroker(subscribers=0)
    )
    r = client.get("/api/viewer/state")
    assert r.status_code == 200
    assert r.json() == {"connected_clients": 0, "state": None}


def test_subscriber_count_degrades_to_zero_without_internals(client, monkeypatch):
    """A broker without the private subscriber set must read as 0 clients."""
    monkeypatch.setattr(viewer_state_service_module, "model_sync_broker", object())
    r = client.get("/api/viewer/state")
    assert r.json()["connected_clients"] == 0


# ---------------------------------------------------------------------------
# Command validation matrix
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "body",
    [
        {"action": "select"},
        {"action": "isolate"},
        {"action": "highlight"},
        {"action": "zoom_to_element"},
        {"action": "camera_preset"},
        {"action": "camera_preset", "preset": "diagonal"},
        {"action": "explode"},
        {},
    ],
)
def test_command_validation_422(client, stub_broker, body):
    r = client.post("/api/viewer/command", json=body)
    assert r.status_code == 422, f"{body} should be rejected, got {r.status_code}"
    assert stub_broker.published == [], "invalid command must not be broadcast"


def test_command_rejects_oversized_element_id_list(client, stub_broker):
    """element_ids beyond the documented cap must 422 before any broadcast."""
    from app.api.viewer_state_routes import MAX_COMMAND_IDS

    body = {"action": "select", "element_ids": list(range(MAX_COMMAND_IDS + 1))}
    r = client.post("/api/viewer/command", json=body)
    assert r.status_code == 422
    assert stub_broker.published == []


def test_state_report_rejects_oversized_selected_ids(client):
    from app.api.viewer_state_routes import MAX_REPORTED_IDS

    r = client.post(
        "/api/viewer/state", json={"selected_ids": list(range(MAX_REPORTED_IDS + 1))}
    )
    assert r.status_code == 422


def test_snapshot_upload_rejects_invalid_base64(client):
    r = client.post(
        "/api/viewer/state/snapshot",
        json={"request_id": "abc", "image_base64": "not base64!!!", "mime": "image/jpeg"},
    )
    assert r.status_code == 422


def test_snapshot_upload_rejects_unknown_mime(client):
    r = client.post(
        "/api/viewer/state/snapshot",
        json={"request_id": "abc", "image_base64": "aGk=", "mime": "text/html"},
    )
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# Command publish payloads
# ---------------------------------------------------------------------------

def test_select_publishes_viewer_command_without_model(client, stub_broker, monkeypatch):
    monkeypatch.setattr(ifc_service, "_model", None)
    r = client.post(
        "/api/viewer/command", json={"action": "select", "element_ids": [7, 8]}
    )
    assert r.status_code == 200
    assert r.json() == {"delivered_to": 1}
    [event] = stub_broker.published
    assert event.type == "viewer_command"
    assert event.model_version == 0
    assert event.model_fingerprint == ""
    assert event.payload == {"action": "select", "element_ids": [7, 8]}


def test_command_carries_model_contract_when_loaded(client, stub_broker, monkeypatch):
    import ifcopenshell

    model = ifcopenshell.file(schema="IFC4")
    monkeypatch.setattr(ifc_service, "_model", model)
    monkeypatch.setattr(ifc_service, "_model_version", 3)
    monkeypatch.setattr(ifc_service, "_model_fingerprint", "feedf00d")

    r = client.post(
        "/api/viewer/command", json={"action": "camera_preset", "preset": "iso"}
    )
    assert r.status_code == 200
    [event] = stub_broker.published
    assert event.model_version == 3
    assert event.model_fingerprint == "feedf00d"
    assert event.payload == {"action": "camera_preset", "preset": "iso"}


def test_show_all_delivered_to_matches_subscribers(client, monkeypatch):
    broker = StubBroker(subscribers=3)
    monkeypatch.setattr(viewer_state_service_module, "model_sync_broker", broker)
    monkeypatch.setattr(ifc_service, "_model", None)

    r = client.post("/api/viewer/command", json={"action": "show_all"})
    assert r.status_code == 200
    assert r.json() == {"delivered_to": 3}
    [event] = broker.published
    assert event.payload == {"action": "show_all"}


def test_zoom_to_element_payload(client, stub_broker, monkeypatch):
    monkeypatch.setattr(ifc_service, "_model", None)
    r = client.post(
        "/api/viewer/command", json={"action": "zoom_to_element", "element_id": 99}
    )
    assert r.status_code == 200
    [event] = stub_broker.published
    assert event.payload == {"action": "zoom_to_element", "element_id": 99}


def test_snapshot_command_generates_claimable_request_id(client, stub_broker):
    r = client.post("/api/viewer/command", json={"action": "snapshot"})
    assert r.status_code == 200
    body = r.json()
    assert body["delivered_to"] == 1
    request_id = body["request_id"]
    assert isinstance(request_id, str) and len(request_id) == 32
    [event] = stub_broker.published
    assert event.payload == {"action": "snapshot", "request_id": request_id}
    # The generated id was registered, so a browser upload can claim it.
    assert viewer_state_service.fulfill(request_id, "aW1n", "image/jpeg") is True


def test_snapshot_command_echoes_caller_request_id(client, stub_broker):
    r = client.post(
        "/api/viewer/command", json={"action": "snapshot", "request_id": "caller-1"}
    )
    assert r.status_code == 200
    assert r.json()["request_id"] == "caller-1"
    [event] = stub_broker.published
    assert event.payload == {"action": "snapshot", "request_id": "caller-1"}


# ---------------------------------------------------------------------------
# Snapshot rendezvous (service level)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_rendezvous_fulfilled_from_second_task():
    svc = ViewerStateService()
    request_id = svc.create_snapshot_request()

    async def respond():
        await asyncio.sleep(0.01)
        assert svc.fulfill(request_id, "aW1n", "image/png") is True

    responder = asyncio.create_task(respond())
    result = await svc.await_snapshot(request_id, timeout_s=2)
    await responder
    assert result == {"image_base64": "aW1n", "mime": "image/png"}
    assert svc._pending == {}, "collected entry must be cleaned up"


@pytest.mark.asyncio
async def test_rendezvous_timeout_returns_none_and_cleans_up():
    svc = ViewerStateService()
    request_id = svc.create_snapshot_request()
    result = await svc.await_snapshot(request_id, timeout_s=0.05)
    assert result is None
    assert request_id not in svc._pending


@pytest.mark.asyncio
async def test_fulfill_before_await_still_delivers():
    svc = ViewerStateService()
    request_id = svc.create_snapshot_request()
    assert svc.fulfill(request_id, "ZGF0YQ==", "image/jpeg") is True
    result = await svc.await_snapshot(request_id, timeout_s=1)
    assert result == {"image_base64": "ZGF0YQ==", "mime": "image/jpeg"}
    assert svc._pending == {}


def test_fulfill_unknown_id_returns_false():
    svc = ViewerStateService()
    assert svc.fulfill("nope", "x", "image/jpeg") is False


def test_pending_cap_evicts_oldest():
    svc = ViewerStateService()
    ids = [svc.create_snapshot_request() for _ in range(12)]
    assert len(svc._pending) == ViewerStateService.MAX_PENDING_SNAPSHOTS
    for request_id in ids[:4]:
        assert svc.fulfill(request_id, "x", "image/jpeg") is False
    for request_id in ids[4:]:
        assert request_id in svc._pending


@pytest.mark.asyncio
async def test_evicted_waiter_wakes_with_none():
    svc = ViewerStateService()
    first = svc.create_snapshot_request()
    waiter = asyncio.create_task(svc.await_snapshot(first, timeout_s=5))
    await asyncio.sleep(0.01)  # let the waiter reach event.wait()
    for _ in range(ViewerStateService.MAX_PENDING_SNAPSHOTS):
        svc.create_snapshot_request()
    result = await asyncio.wait_for(waiter, timeout=1)
    assert result is None


# ---------------------------------------------------------------------------
# Snapshot routes
# ---------------------------------------------------------------------------

def test_upload_snapshot_unknown_request_id(client):
    r = client.post(
        "/api/viewer/state/snapshot",
        json={"request_id": "ghost", "image_base64": "aGk=", "mime": "image/jpeg"},
    )
    assert r.status_code == 200
    assert r.json() == {"ok": False}


def test_get_snapshot_no_viewer_409(client, monkeypatch):
    monkeypatch.setattr(
        viewer_state_service_module, "model_sync_broker", StubBroker(subscribers=0)
    )
    r = client.get("/api/viewer/snapshot")
    assert r.status_code == 409
    assert r.json()["detail"] == "No viewer connected"


@pytest.mark.asyncio
async def test_get_snapshot_round_trip(monkeypatch):
    """GET /snapshot publishes the command and returns the browser's upload."""
    broker = StubBroker(subscribers=1)
    monkeypatch.setattr(viewer_state_service_module, "model_sync_broker", broker)
    monkeypatch.setattr(ifc_service, "_model", None)

    transport = ASGITransport(app=_make_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:

        async def browser():
            # Wait for the command to land on the broker, then upload.
            while not broker.published:
                await asyncio.sleep(0.005)
            event = broker.published[0]
            assert event.type == "viewer_command"
            assert event.payload["action"] == "snapshot"
            r = await client.post(
                "/api/viewer/state/snapshot",
                json={
                    "request_id": event.payload["request_id"],
                    "image_base64": "aW1hZ2U=",
                    "mime": "image/jpeg",
                },
            )
            assert r.status_code == 200
            assert r.json() == {"ok": True}

        browser_task = asyncio.create_task(browser())
        r = await client.get("/api/viewer/snapshot", params={"timeout_s": 5})
        await browser_task

    assert r.status_code == 200
    assert r.json() == {"image_base64": "aW1hZ2U=", "mime": "image/jpeg"}


# ---------------------------------------------------------------------------
# broadcast_viewer_command (service level - shared by routes and MCP server)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_broadcast_viewer_command_without_model(monkeypatch):
    broker = StubBroker(subscribers=2)
    monkeypatch.setattr(viewer_state_service_module, "model_sync_broker", broker)
    monkeypatch.setattr(ifc_service, "_model", None)

    delivered = await viewer_state_service_module.broadcast_viewer_command(
        {"action": "show_all"}
    )
    assert delivered == 2
    [event] = broker.published
    assert event.type == "viewer_command"
    assert event.model_version == 0
    assert event.model_fingerprint == ""
    assert event.payload == {"action": "show_all"}


@pytest.mark.asyncio
async def test_broadcast_viewer_command_carries_model_contract(monkeypatch):
    import ifcopenshell

    broker = StubBroker(subscribers=1)
    monkeypatch.setattr(viewer_state_service_module, "model_sync_broker", broker)
    monkeypatch.setattr(ifc_service, "_model", ifcopenshell.file(schema="IFC4"))
    monkeypatch.setattr(ifc_service, "_model_version", 7)
    monkeypatch.setattr(ifc_service, "_model_fingerprint", "cafebabe")

    delivered = await viewer_state_service_module.broadcast_viewer_command(
        {"action": "select", "element_ids": [1]}
    )
    assert delivered == 1
    [event] = broker.published
    assert event.model_version == 7
    assert event.model_fingerprint == "cafebabe"
    assert event.payload == {"action": "select", "element_ids": [1]}


def test_subscriber_count_reads_stub_broker(monkeypatch):
    monkeypatch.setattr(
        viewer_state_service_module, "model_sync_broker", StubBroker(subscribers=4)
    )
    assert viewer_state_service_module.subscriber_count() == 4


@pytest.mark.asyncio
async def test_get_snapshot_timeout_504(monkeypatch):
    """No browser answer: 504 after the clamped minimum timeout (1 s)."""
    broker = StubBroker(subscribers=1)
    monkeypatch.setattr(viewer_state_service_module, "model_sync_broker", broker)
    monkeypatch.setattr(ifc_service, "_model", None)

    transport = ASGITransport(app=_make_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        # timeout_s=0 exercises the lower clamp to 1 second.
        r = await client.get("/api/viewer/snapshot", params={"timeout_s": 0})
    assert r.status_code == 504
    assert r.json()["detail"] == "No viewer answered"
    assert len(broker.published) == 1, "command was still broadcast once"
