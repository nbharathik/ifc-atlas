"""Route tests for /api/carbon/factors.

Contract under test: a malformed PUT body must never silently wipe the user's
persisted factor library (regression: a dead ``is not None`` guard used to
persist ``{}`` for all-invalid bodies). The router is mounted on a fresh
FastAPI app (app.main is never imported) and the factor library is redirected
to a temp path.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.carbon_routes import router
from app.services import carbon_service

_CONCRETE = {"Concrete": {"basis": "volume", "factor": 120.0}}


@pytest.fixture
def client(tmp_path, monkeypatch) -> TestClient:
    monkeypatch.setattr(carbon_service, "_FACTORS_PATH", tmp_path / "factors.json")
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_put_factors_valid_persists(client):
    resp = client.put("/api/carbon/factors", json={"factors": _CONCRETE})
    assert resp.status_code == 200
    assert resp.json()["factors"] == _CONCRETE
    assert carbon_service.load_factors() == _CONCRETE


def test_put_factors_all_invalid_is_422_and_keeps_library(client):
    client.put("/api/carbon/factors", json={"factors": _CONCRETE})
    resp = client.put(
        "/api/carbon/factors",
        json={"factors": {"Steel": {"basis": "bogus", "factor": "not-a-number"}}},
    )
    assert resp.status_code == 422
    # The previously saved library must be untouched.
    assert carbon_service.load_factors() == _CONCRETE


def test_put_factors_empty_clears_library(client):
    client.put("/api/carbon/factors", json={"factors": _CONCRETE})
    resp = client.put("/api/carbon/factors", json={"factors": {}})
    assert resp.status_code == 200
    assert resp.json()["factors"] == {}
    # Deliberate clear is allowed (keyword defaults apply again).
    assert carbon_service.load_factors() == {}


def test_put_factors_partial_valid_keeps_good_entries(client):
    resp = client.put(
        "/api/carbon/factors",
        json={"factors": {**_CONCRETE, "bad": "nope"}},
    )
    assert resp.status_code == 200
    assert resp.json()["factors"] == _CONCRETE


def test_get_factors_returns_persisted(client):
    client.put("/api/carbon/factors", json={"factors": {"Glass": {"basis": "area", "factor": 45.0}}})
    resp = client.get("/api/carbon/factors")
    assert resp.status_code == 200
    assert resp.json()["factors"] == {"Glass": {"basis": "area", "factor": 45.0}}
