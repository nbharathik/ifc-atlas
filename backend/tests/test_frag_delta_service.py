"""Fragment delta service + endpoint coverage.

Tests both the storage service (LRU register/get/clear/eviction) and
the GET /api/ifc/frag-delta/{edit_id} endpoint shape so the protocol
contract is regression-proof. v1.0 ships with an empty
``representations`` payload; v1.1 will fill in real geometry - these
tests pin the wire shape so the v1.1 change is a fill-in, not a
breaking refactor.
"""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.services.fragment_prebuild_service import FragDeltaService, frag_delta_service


# ---------------------------------------------------------------------------
# FragDeltaService unit tests
# ---------------------------------------------------------------------------


class TestFragDeltaService:
    def test_empty_service(self):
        svc = FragDeltaService()
        assert svc.size == 0
        assert svc.get("nonexistent") is None

    def test_register_and_get(self):
        svc = FragDeltaService()
        rec = svc.register(
            edit_id="edit-1",
            express_ids=[1, 2, 3],
            model_fingerprint="abc123",
        )
        assert rec.edit_id == "edit-1"
        assert rec.express_ids == [1, 2, 3]
        assert rec.model_fingerprint == "abc123"
        assert rec.applied_at > 0
        # Retrievable
        again = svc.get("edit-1")
        assert again is rec

    def test_express_ids_defensively_copied(self):
        """The service must not share references with the caller's list."""
        svc = FragDeltaService()
        ids = [1, 2, 3]
        svc.register(edit_id="e1", express_ids=ids, model_fingerprint="x")
        ids.append(4)
        rec = svc.get("e1")
        assert rec is not None
        assert rec.express_ids == [1, 2, 3]

    def test_lru_evicts_oldest(self):
        """Once max_entries is exceeded, FIFO eviction kicks in."""
        svc = FragDeltaService(max_entries=3)
        for i in range(5):
            svc.register(
                edit_id=f"e{i}", express_ids=[i], model_fingerprint="x"
            )
        assert svc.size == 3
        # Oldest two should be gone
        assert svc.get("e0") is None
        assert svc.get("e1") is None
        # Newest three still there
        assert svc.get("e2") is not None
        assert svc.get("e3") is not None
        assert svc.get("e4") is not None

    def test_re_register_moves_to_end_of_lru(self):
        """Re-registering an existing edit_id refreshes its position."""
        svc = FragDeltaService(max_entries=3)
        svc.register(edit_id="e0", express_ids=[0], model_fingerprint="x")
        svc.register(edit_id="e1", express_ids=[1], model_fingerprint="x")
        svc.register(edit_id="e2", express_ids=[2], model_fingerprint="x")
        # Refresh e0 - moves it to most-recent
        svc.register(edit_id="e0", express_ids=[0, 99], model_fingerprint="x")
        # Now adding e3 should evict e1 (oldest), not e0
        svc.register(edit_id="e3", express_ids=[3], model_fingerprint="x")
        assert svc.get("e0") is not None
        assert svc.get("e0").express_ids == [0, 99]  # got the refresh
        assert svc.get("e1") is None  # evicted
        assert svc.get("e2") is not None
        assert svc.get("e3") is not None

    def test_clear_drops_everything(self):
        svc = FragDeltaService()
        svc.register(edit_id="e1", express_ids=[1], model_fingerprint="x")
        svc.register(edit_id="e2", express_ids=[2], model_fingerprint="x")
        assert svc.size == 2
        svc.clear()
        assert svc.size == 0
        assert svc.get("e1") is None


# ---------------------------------------------------------------------------
# GET /api/ifc/frag-delta/{edit_id} endpoint
# ---------------------------------------------------------------------------


@pytest.fixture
def reset_singleton():
    """Clear the module-level singleton between endpoint tests."""
    frag_delta_service.clear()
    yield
    frag_delta_service.clear()


@pytest.mark.asyncio
async def test_endpoint_returns_404_for_unknown_edit(reset_singleton):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        r = await client.get("/api/ifc/frag-delta/bogus-id")
        assert r.status_code == 404
        body = r.json()
        assert "No frag-delta record" in body["detail"]


@pytest.mark.asyncio
async def test_endpoint_returns_registered_record_shape(reset_singleton):
    """v1.0 endpoint returns empty representations + the metadata.

    Pinned shape:
        {
          "edit_id": str,
          "express_ids": list[int],
          "model_fingerprint": str,
          "representations": {}        # empty in v1.0
        }
    """
    frag_delta_service.register(
        edit_id="edit-abc",
        express_ids=[10, 20, 30],
        model_fingerprint="fingerprint-xyz",
    )
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        r = await client.get("/api/ifc/frag-delta/edit-abc")
        assert r.status_code == 200
        body = r.json()
        assert body["edit_id"] == "edit-abc"
        assert body["express_ids"] == [10, 20, 30]
        assert body["model_fingerprint"] == "fingerprint-xyz"
        # v1.0 contract - representations is an empty dict, not absent.
        assert body["representations"] == {}


@pytest.mark.asyncio
async def test_endpoint_404_after_eviction(reset_singleton):
    """When the LRU evicts a record, the endpoint stops serving it."""
    # Force the cap low for this test.
    frag_delta_service.max_entries = 2
    try:
        frag_delta_service.register(
            edit_id="old", express_ids=[1], model_fingerprint="x"
        )
        frag_delta_service.register(
            edit_id="newer", express_ids=[2], model_fingerprint="x"
        )
        frag_delta_service.register(
            edit_id="newest", express_ids=[3], model_fingerprint="x"
        )
        # 'old' was the oldest and should be evicted.
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            r = await client.get("/api/ifc/frag-delta/old")
            assert r.status_code == 404
            r2 = await client.get("/api/ifc/frag-delta/newest")
            assert r2.status_code == 200
    finally:
        frag_delta_service.max_entries = 32  # restore default
