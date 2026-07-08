"""GET /api/ifc/native-index status-envelope contract.

The route reports transient states (index not built yet, index belongs to a
different model than the caller pinned) with 200 status envelopes instead of
error codes: the frontend polls this route during the upload -> parse window,
and browsers auto-log every non-2xx fetch to the console.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models.metadata_index_models import MetadataIndex
from app.services.metadata_index_service import metadata_index_service

SHA_A = "a" * 64
SHA_B = "b" * 64


def _tiny_index(sha: str) -> MetadataIndex:
    return MetadataIndex.model_validate(
        {
            "index_version": 1,
            "producer_version": "test",
            "source_sha256": sha,
            "source_bytes": 10,
            "header": {},
            "stats": {"element_count": 1},
            "elements": {
                "5": {"id": 5, "global_id": "2aaaaaaaaaaaaaaaaaaaaa", "type": "IFCWALL"},
            },
            "id_by_global_id": {"2aaaaaaaaaaaaaaaaaaaaa": 5},
        }
    )


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture(autouse=True)
def _clean_index_singleton():
    """The conftest autouse fixture resets readiness but not this singleton."""
    metadata_index_service.unload()
    yield
    metadata_index_service.unload()


def _load_current(sha: str) -> None:
    """Make ``sha`` the loaded index via the public disk-cache surface."""
    metadata_index_service.write_to_disk(sha, _tiny_index(sha))
    assert metadata_index_service.hydrate_from_disk(sha) is True


def test_pending_when_no_index_loaded(client):
    resp = client.get("/api/ifc/native-index")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "pending"
    assert body["sha256"] is None
    assert body["index"] is None


def test_pending_when_pinned_and_no_index_loaded(client):
    resp = client.get(f"/api/ifc/native-index?fingerprint={SHA_A}")
    assert resp.status_code == 200
    assert resp.json()["status"] == "pending"


def test_mismatch_when_pinned_fingerprint_differs(client):
    _load_current(SHA_A)
    resp = client.get(f"/api/ifc/native-index?fingerprint={SHA_B}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "mismatch"
    assert body["sha256"] == SHA_A
    assert body["index"] is None


def test_ready_when_pinned_fingerprint_matches(client):
    _load_current(SHA_A)
    resp = client.get(f"/api/ifc/native-index?fingerprint={SHA_A}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ready"
    assert body["sha256"] == SHA_A
    assert body["index"]["source_sha256"] == SHA_A
    assert body["index"]["id_by_global_id"] == {"2aaaaaaaaaaaaaaaaaaaaa": 5}


def test_ready_when_unpinned(client):
    _load_current(SHA_A)
    resp = client.get("/api/ifc/native-index")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ready"


def test_hydrate_from_disk_returns_false_on_cache_miss():
    assert metadata_index_service.hydrate_from_disk(SHA_B) is False
    assert metadata_index_service.is_loaded is False
