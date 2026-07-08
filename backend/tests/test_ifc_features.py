from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


def _client() -> TestClient:
    from app.main import app

    return TestClient(app, raise_server_exceptions=False)


def test_features_returns_recoverable_response_when_probe_raises(monkeypatch):
    from app.api import ifc_routes

    async def fail_capabilities():
        raise RuntimeError("sidecar health crashed")

    monkeypatch.setattr(ifc_routes.sidecar_manager, "capabilities", fail_capabilities)

    resp = _client().get("/api/ifc/features")

    assert resp.status_code == 200
    body = resp.json()
    assert body["server_convert"] is False
    assert body["available"] is False
    assert body["recoverable"] is True
    assert "sidecar health crashed" in body["reason"]


@pytest.mark.asyncio
async def test_sidecar_capabilities_marks_health_failure_recoverable(monkeypatch):
    from app.services.sidecar_manager import sidecar_manager

    async def fake_health():
        return {"ok": False, "reason": "ConnectError: connection refused"}

    monkeypatch.setattr(sidecar_manager, "health", fake_health)

    caps = await sidecar_manager.capabilities()

    assert caps["server_convert"] is False
    assert caps["available"] is False
    assert caps["recoverable"] is True
    assert "ConnectError" in caps["reason"]


@pytest.mark.asyncio
async def test_sidecar_capabilities_marks_missing_dependencies_hard_unavailable(
    monkeypatch,
):
    from app.services.sidecar_manager import sidecar_manager

    async def fake_health():
        return {
            "ok": False,
            "reason": "sidecar node_modules missing - run npm install first",
        }

    monkeypatch.setattr(sidecar_manager, "health", fake_health)

    caps = await sidecar_manager.capabilities()

    assert caps["server_convert"] is False
    assert caps["available"] is False
    assert caps["recoverable"] is False
    assert "node_modules" in caps["reason"]
