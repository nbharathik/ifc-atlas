"""apply_pending_edit serialisation gate.

When two ``/edits/pending/{edit_id}/apply`` calls arrive concurrently, the
second one MUST receive HTTP 409 with a structured
``{detail: {status: "edit_in_progress", retry_after_ms: 1500}}`` payload so
the client can show a toast + auto-retry. This avoids racing the
IfcOpenShell model mutation + the WS broadcast pair that follow.

The test mocks the heavy moving parts (sandbox_service.apply_pending,
ifc_service mutations, model_sync_broker.publish) and just exercises the
``_apply_lock`` mechanic in ``ifc_routes.apply_pending_edit``.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest
from httpx import ASGITransport

from app.main import app


@pytest.fixture(autouse=True)
def reset_apply_lock():
    """Make sure no stuck lock from a prior test leaks into this one."""
    from app.api import ifc_routes

    # Replace with a fresh lock so any leaked locked() state is wiped.
    ifc_routes._apply_lock = asyncio.Lock()
    yield
    ifc_routes._apply_lock = asyncio.Lock()


@pytest.fixture
def mock_apply_pending(monkeypatch):
    """Slow no-op ``sandbox_service.apply_pending`` so two concurrent
    requests have a chance to overlap inside the lock."""
    from app.api import ifc_routes
    from app.models.ifc_models import PendingEditEnvelope

    # Bypass _check_loaded so we don't need a real IFC.
    monkeypatch.setattr(ifc_routes, "_check_loaded", lambda: None)

    async def _slow_publish(*args: Any, **kwargs: Any) -> None:
        await asyncio.sleep(0)  # yield control once so the second req can race

    monkeypatch.setattr(ifc_routes.model_sync_broker, "publish", _slow_publish)
    monkeypatch.setattr(ifc_routes, "_snapshot_after_edit", lambda *_a, **_kw: None)

    # ifc_service stubs - avoid any IfcOpenShell touch.
    monkeypatch.setattr(
        ifc_routes.ifc_service,
        "get_model_contract",
        lambda: {"model_version": 1, "model_fingerprint": "deadbeef", "edit_id": None},
    )

    # sandbox_service.apply_pending stub - small sleep so the lock is
    # held long enough for the second concurrent request to hit it.
    def _stub_apply_pending(*, edit_id: str, ifc_service: Any) -> PendingEditEnvelope:
        # We can't yield to the event loop inside a sync fn called from
        # within `async with _apply_lock`, so we make the lock contention
        # window via the publish() await above (which is awaited AFTER
        # apply_pending returns but still inside the locked region).
        import time as _t
        return PendingEditEnvelope(
            edit_id=edit_id,
            created_at=_t.time(),
            base_model_version=1,
            base_model_fingerprint="deadbeef",
            sandbox_fingerprint="cafef00d",
            summary="stub",
            counts={"renamed": 1},
            changes=[],
        )

    monkeypatch.setattr(
        ifc_routes.sandbox_service, "apply_pending", _stub_apply_pending
    )

    # patch_generator stub - generates an empty batch so the ifc_patch
    # event branch doesn't need a real generator.
    class _StubBatch:
        def __init__(self): self.patches = []

    monkeypatch.setattr(
        ifc_routes.patch_generator,
        "generate",
        lambda *args, **kwargs: _StubBatch(),
    )


@pytest.mark.asyncio
async def test_concurrent_apply_returns_409(mock_apply_pending):
    """Two concurrent /apply calls: one succeeds, one gets 409."""
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        # Fire two requests in parallel. The second one hits while the
        # first is still inside `async with _apply_lock`, so it gets 409.
        results = await asyncio.gather(
            client.post("/api/ifc/edits/pending/edit-1/apply"),
            client.post("/api/ifc/edits/pending/edit-2/apply"),
            return_exceptions=False,
        )
        status_codes = sorted(r.status_code for r in results)
        # Exactly one should succeed (200) and one should be 409.
        assert status_codes == [200, 409], f"got status codes {status_codes}"

        # The 409 must carry the structured retry envelope.
        rejected = next(r for r in results if r.status_code == 409)
        body = rejected.json()
        assert body["detail"]["status"] == "edit_in_progress"
        assert body["detail"]["retry_after_ms"] == 1500
        assert "message" in body["detail"]


@pytest.mark.asyncio
async def test_sequential_applies_both_succeed(mock_apply_pending):
    """After the first /apply completes, a subsequent /apply must succeed
    (the lock releases on return)."""
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        r1 = await client.post("/api/ifc/edits/pending/edit-A/apply")
        assert r1.status_code == 200, f"first failed: {r1.status_code} {r1.text}"
        r2 = await client.post("/api/ifc/edits/pending/edit-B/apply")
        assert r2.status_code == 200, f"second failed: {r2.status_code} {r2.text}"


@pytest.mark.asyncio
async def test_lock_released_on_value_error(monkeypatch, mock_apply_pending):
    """If sandbox_service.apply_pending raises ValueError (e.g. unknown
    edit_id), the 409 is raised but the lock must release so the next
    request isn't stuck."""
    from app.api import ifc_routes

    def _raises(*args, **kwargs):
        raise ValueError("unknown edit_id")

    monkeypatch.setattr(ifc_routes.sandbox_service, "apply_pending", _raises)

    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        r1 = await client.post("/api/ifc/edits/pending/bogus/apply")
        assert r1.status_code == 409
        # The lock must have released - second call shouldn't get
        # "edit_in_progress", it should get the same "unknown edit_id"
        # ValueError 409 (different code path).
        r2 = await client.post("/api/ifc/edits/pending/bogus2/apply")
        assert r2.status_code == 409
        # The structured "edit_in_progress" detail is what we DON'T want.
        assert not isinstance(r2.json().get("detail"), dict) or \
            r2.json()["detail"].get("status") != "edit_in_progress"
