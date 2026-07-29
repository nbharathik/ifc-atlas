from __future__ import annotations

import pytest
from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient

from app.core.security import ApiTokenMiddleware, SecurityMode, SecuritySettings


TOKEN = "phase-zero-test-token-that-is-at-least-32-characters"


def _protected_app(settings: SecuritySettings) -> FastAPI:
    app = FastAPI()
    app.add_middleware(ApiTokenMiddleware, settings=settings)

    @app.get("/api/health")
    async def health():
        return {"status": "ok"}

    @app.get("/api/security")
    async def security():
        return {"mode": settings.mode.value, "auth_required": settings.auth_required}

    @app.get("/api/private")
    async def private():
        return {"ok": True}

    @app.websocket("/api/ws")
    async def websocket(websocket: WebSocket):
        await websocket.accept()
        await websocket.send_text("ready")
        await websocket.close()

    return app


def test_security_settings_default_to_local_without_auth():
    settings = SecuritySettings.from_env({})
    assert settings.mode is SecurityMode.LOCAL
    assert settings.api_token is None
    settings.validate_for_host("127.0.0.1")


@pytest.mark.parametrize("api_token", [None, TOKEN])
def test_local_mode_refuses_public_bind_with_or_without_token(api_token):
    settings = SecuritySettings(SecurityMode.LOCAL, api_token)
    with pytest.raises(RuntimeError, match="only to loopback"):
        settings.validate_for_host("0.0.0.0")


def test_server_mode_requires_a_strong_token():
    with pytest.raises(RuntimeError, match="requires IFC_ATLAS_API_TOKEN"):
        SecuritySettings.from_env(
            {"IFC_ATLAS_SECURITY_MODE": "server"}
        ).validate_for_host("0.0.0.0")

    with pytest.raises(RuntimeError, match="at least 32"):
        SecuritySettings.from_env(
            {
                "IFC_ATLAS_SECURITY_MODE": "server",
                "IFC_ATLAS_API_TOKEN": "short",
            }
        ).validate_for_host("0.0.0.0")


def test_http_api_requires_matching_bearer_but_public_routes_remain_available():
    settings = SecuritySettings(SecurityMode.SERVER, TOKEN)
    client = TestClient(_protected_app(settings))

    assert client.get("/api/health").status_code == 200
    assert client.get("/api/security").status_code == 200

    missing = client.get("/api/private")
    assert missing.status_code == 401
    assert missing.json()["error"] == "authentication_required"
    assert missing.headers["WWW-Authenticate"] == "Bearer"

    wrong = client.get(
        "/api/private", headers={"Authorization": "Bearer definitely-wrong"}
    )
    assert wrong.status_code == 401

    allowed = client.get(
        "/api/private", headers={"Authorization": f"Bearer {TOKEN}"}
    )
    assert allowed.status_code == 200
    assert allowed.json() == {"ok": True}


def test_websocket_accepts_browser_query_token():
    settings = SecuritySettings(SecurityMode.SERVER, TOKEN)
    client = TestClient(_protected_app(settings))

    with pytest.raises(Exception):
        with client.websocket_connect("/api/ws"):
            pass

    with client.websocket_connect(f"/api/ws?access_token={TOKEN}") as websocket:
        assert websocket.receive_text() == "ready"


def test_local_mode_without_token_preserves_development_workflow():
    client = TestClient(
        _protected_app(SecuritySettings(SecurityMode.LOCAL, api_token=None))
    )
    assert client.get("/api/private").status_code == 200
    with client.websocket_connect("/api/ws") as websocket:
        assert websocket.receive_text() == "ready"
