"""Route tests for /api/bcf.

The router is mounted on a fresh FastAPI app (app.main is never imported) and
ifc_service is monkeypatched with an in-memory IFC4 model - no disk IFC load.
"""

from __future__ import annotations

import base64
import io
import uuid
import zipfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.bcf_routes import router
from app.services.ifc_service import ifc_service

SNAPSHOT_BYTES = b"\xff\xd8\xff\xe0fake-jpeg-route"
SNAPSHOT_URL = "data:image/jpeg;base64," + base64.b64encode(SNAPSHOT_BYTES).decode()

TOPIC_KEYS = {
    "guid",
    "title",
    "description",
    "topic_type",
    "status",
    "priority",
    "assigned_to",
    "author",
    "created_at",
    "modified_at",
    "labels",
    "comments",
    "viewpoint",
    "has_snapshot",
}


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    return TestClient(app, raise_server_exceptions=False)


def _model_with_two_walls():
    import ifcopenshell
    import ifcopenshell.guid

    model = ifcopenshell.file(schema="IFC4")
    wall_a = model.createIfcWall(GlobalId=ifcopenshell.guid.new(), Name="Wall A")
    wall_b = model.createIfcWall(GlobalId=ifcopenshell.guid.new(), Name="Wall B")
    return model, wall_a, wall_b


@pytest.fixture
def loaded(monkeypatch):
    """In-memory model + unique fingerprint injected into the ifc_service singleton."""
    model, wall_a, wall_b = _model_with_two_walls()
    monkeypatch.setattr(ifc_service, "_model", model)
    monkeypatch.setattr(ifc_service, "_model_fingerprint", f"route-{uuid.uuid4().hex}")
    return model, wall_a, wall_b


@pytest.fixture
def unloaded(monkeypatch):
    monkeypatch.setattr(ifc_service, "_model", None)


# ---------------------------------------------------------------------------
# 400 guard - every route requires a loaded model
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "method,path,kwargs",
    [
        ("get", "/api/bcf/topics", {}),
        ("post", "/api/bcf/topics", {"json": {"title": "x"}}),
        ("patch", "/api/bcf/topics/abc", {"json": {"title": "y"}}),
        ("delete", "/api/bcf/topics/abc", {}),
        ("post", "/api/bcf/topics/abc/comments", {"json": {"comment": "hi"}}),
        ("get", "/api/bcf/topics/abc/snapshot", {}),
        ("get", "/api/bcf/export", {}),
        (
            "post",
            "/api/bcf/import",
            {"files": {"file": ("t.bcfzip", b"x", "application/zip")}},
        ),
    ],
)
def test_routes_return_400_when_no_model_loaded(unloaded, method, path, kwargs):
    client = _client()
    resp = getattr(client, method)(path, **kwargs)
    assert resp.status_code == 400
    assert resp.json()["detail"] == "No IFC model loaded"


# ---------------------------------------------------------------------------
# Topic CRUD
# ---------------------------------------------------------------------------


def test_create_topic_returns_contract_shape(loaded):
    client = _client()
    resp = client.post(
        "/api/bcf/topics",
        json={
            "title": "Leaky pipe",
            "description": "wet wall",
            "priority": "High",
            "labels": ["mep"],
            "snapshot_data_url": SNAPSHOT_URL,
        },
    )
    assert resp.status_code == 200
    topic = resp.json()
    assert set(topic.keys()) == TOPIC_KEYS
    assert topic["title"] == "Leaky pipe"
    assert topic["priority"] == "High"
    assert topic["has_snapshot"] is True

    listed = client.get("/api/bcf/topics").json()["topics"]
    assert [t["guid"] for t in listed] == [topic["guid"]]


def test_create_topic_requires_title(loaded):
    client = _client()
    assert client.post("/api/bcf/topics", json={}).status_code == 422
    assert client.post("/api/bcf/topics", json={"title": ""}).status_code == 422


def test_create_topic_rejects_bad_snapshot_url(loaded):
    client = _client()
    resp = client.post(
        "/api/bcf/topics", json={"title": "x", "snapshot_data_url": "not-a-data-url"}
    )
    assert resp.status_code == 400


def test_create_topic_with_viewpoint_round_trips(loaded):
    _model, wall_a, _wall_b = loaded
    client = _client()
    resp = client.post(
        "/api/bcf/topics",
        json={
            "title": "With viewpoint",
            "viewpoint": {
                "camera": {"pos": [1, 2, 3], "target": [4, 5, 6]},
                "isolated_ids": [wall_a.id()],
                "hidden_ids": [],
                "selected_id": wall_a.id(),
                "highlighted_ids": [wall_a.id()],
            },
        },
    )
    assert resp.status_code == 200
    viewpoint = resp.json()["viewpoint"]
    assert viewpoint["camera"]["pos"] == [1.0, 2.0, 3.0]
    assert viewpoint["camera"]["target"] == [4.0, 5.0, 6.0]
    assert viewpoint["selected_id"] == wall_a.id()
    assert viewpoint["isolated_ids"] == [wall_a.id()]


def test_patch_topic_updates_fields(loaded):
    client = _client()
    guid = client.post("/api/bcf/topics", json={"title": "Before"}).json()["guid"]
    resp = client.patch(
        f"/api/bcf/topics/{guid}",
        json={"title": "After", "status": "Closed", "assigned_to": "erin"},
    )
    assert resp.status_code == 200
    topic = resp.json()
    assert topic["title"] == "After"
    assert topic["status"] == "Closed"
    assert topic["assigned_to"] == "erin"


def test_patch_unknown_topic_404(loaded):
    client = _client()
    resp = client.patch("/api/bcf/topics/no-such-guid", json={"title": "x"})
    assert resp.status_code == 404


def test_delete_topic(loaded):
    client = _client()
    guid = client.post("/api/bcf/topics", json={"title": "Doomed"}).json()["guid"]
    resp = client.delete(f"/api/bcf/topics/{guid}")
    assert resp.status_code == 200
    assert resp.json() == {"deleted": True}
    assert client.get("/api/bcf/topics").json()["topics"] == []
    assert client.delete(f"/api/bcf/topics/{guid}").status_code == 404


def test_add_comment_returns_topic_with_comment(loaded):
    client = _client()
    guid = client.post("/api/bcf/topics", json={"title": "T"}).json()["guid"]
    resp = client.post(
        f"/api/bcf/topics/{guid}/comments",
        json={"comment": "hello there", "author": "erin"},
    )
    assert resp.status_code == 200
    topic = resp.json()
    assert topic["comments"][-1]["comment"] == "hello there"
    assert topic["comments"][-1]["author"] == "erin"
    assert (
        client.post("/api/bcf/topics/none/comments", json={"comment": "x"}).status_code
        == 404
    )


# ---------------------------------------------------------------------------
# Snapshot route
# ---------------------------------------------------------------------------


def test_snapshot_route_returns_exact_bytes(loaded):
    client = _client()
    guid = client.post(
        "/api/bcf/topics", json={"title": "Snap", "snapshot_data_url": SNAPSHOT_URL}
    ).json()["guid"]
    resp = client.get(f"/api/bcf/topics/{guid}/snapshot")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("image/jpeg")
    assert resp.content == SNAPSHOT_BYTES


def test_snapshot_route_404_when_topic_has_none(loaded):
    client = _client()
    guid = client.post("/api/bcf/topics", json={"title": "No snap"}).json()["guid"]
    assert client.get(f"/api/bcf/topics/{guid}/snapshot").status_code == 404


def test_snapshot_route_404_unknown_topic(loaded):
    client = _client()
    assert client.get("/api/bcf/topics/no-such-guid/snapshot").status_code == 404


# ---------------------------------------------------------------------------
# Export / import
# ---------------------------------------------------------------------------


def test_export_route_returns_bcfzip_attachment(loaded):
    _model, wall_a, _wall_b = loaded
    client = _client()
    guid = client.post(
        "/api/bcf/topics",
        json={
            "title": "Exported",
            "viewpoint": {
                "camera": {"pos": [0, 0, 10], "target": [0, 0, 0]},
                "isolated_ids": [wall_a.id()],
            },
            "snapshot_data_url": SNAPSHOT_URL,
        },
    ).json()["guid"]

    resp = client.get("/api/bcf/export")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/zip"
    disposition = resp.headers["content-disposition"]
    assert "attachment" in disposition
    # No original upload path on the monkeypatched service -> fallback name.
    assert 'filename="model.bcfzip"' in disposition

    with zipfile.ZipFile(io.BytesIO(resp.content)) as archive:
        names = set(archive.namelist())
    assert "bcf.version" in names
    assert f"{guid}/markup.bcf" in names
    assert f"{guid}/viewpoint.bcfv" in names
    assert f"{guid}/snapshot.jpg" in names
    assert f"{guid}/ifc_atlas.json" in names


def test_import_route_round_trip(loaded, monkeypatch):
    client = _client()
    client.post("/api/bcf/topics", json={"title": "One"})
    client.post(
        "/api/bcf/topics", json={"title": "Two", "snapshot_data_url": SNAPSHOT_URL}
    )
    exported = client.get("/api/bcf/export").content

    # Re-key the store (as if a different model were loaded) and import there.
    monkeypatch.setattr(ifc_service, "_model_fingerprint", f"route-{uuid.uuid4().hex}")
    assert client.get("/api/bcf/topics").json()["topics"] == []

    resp = client.post(
        "/api/bcf/import",
        files={"file": ("issues.bcfzip", exported, "application/zip")},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["imported"] == 2
    assert body["skipped"] == 0
    assert sorted(t["title"] for t in body["topics"]) == ["One", "Two"]
    assert client.get("/api/bcf/topics").json()["topics"] == body["topics"]


def test_import_route_rejects_wrong_extension(loaded):
    client = _client()
    resp = client.post(
        "/api/bcf/import", files={"file": ("notes.txt", b"x", "text/plain")}
    )
    assert resp.status_code == 400


def test_import_route_rejects_invalid_zip(loaded):
    client = _client()
    resp = client.post(
        "/api/bcf/import",
        files={"file": ("broken.bcfzip", b"garbage bytes", "application/zip")},
    )
    assert resp.status_code == 400
