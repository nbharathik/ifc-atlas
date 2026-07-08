"""
Endpoint-level tests for /api/plugins.

The router is mounted on a fresh FastAPI app (app.main is never imported),
the route module's plugin_service is swapped for one with a temp user dir,
the ifc_service singleton is monkeypatched with an in-memory ifcopenshell
model, and the sandbox is monkeypatched so no subprocess ever spawns.
"""

from __future__ import annotations

import io
import json
import zipfile

import fastapi
import pytest
from fastapi.testclient import TestClient

from app.api import plugin_routes as pr
from app.services.ifc_service import ifc_service
from app.services.plugin_service import MAX_PLUGIN_ZIP_BYTES, PluginService

# ---------------------------------------------------------------------------
# Helpers / fixtures
# ---------------------------------------------------------------------------

SCRIPT = "result = len(model.by_type('IfcWall'))\n"


def _manifest(**overrides):
    base = {
        "id": "my-plugin",
        "name": "My Plugin",
        "description": "Counts walls.",
        "version": "1.0.0",
        "params": [],
        "requires_write": False,
    }
    base.update(overrides)
    return base


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setattr(
        pr, "plugin_service", PluginService(user_dir=tmp_path / "plugins")
    )
    app = fastapi.FastAPI()
    app.include_router(pr.router)
    return TestClient(app, raise_server_exceptions=False)


@pytest.fixture
def loaded_model(monkeypatch):
    """Pretend a model is loaded: the model property has no setter, so the
    private attribute is patched like other suites do."""
    import ifcopenshell

    model = ifcopenshell.file(schema="IFC4")
    monkeypatch.setattr(ifc_service, "_model", model)
    return model


def _patch_sandbox_run(monkeypatch, result, captured=None):
    """Replace the sandbox executor that plugin_service.run calls."""
    from app.services import plugin_service as ps_mod

    def fake_execute_python(**kwargs):
        if captured is not None:
            captured.update(kwargs)
        return dict(result)

    monkeypatch.setattr(ps_mod.sandbox_service, "execute_python", fake_execute_python)


def _zip_bytes(prefix: str = "") -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(prefix + "manifest.json", json.dumps(_manifest(id="zipped-plugin")))
        zf.writestr(prefix + "script.py", SCRIPT)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# GET /api/plugins + GET /api/plugins/{id}
# ---------------------------------------------------------------------------

def test_list_plugins_includes_builtins(client):
    resp = client.get("/api/plugins")
    assert resp.status_code == 200
    plugins = {p["id"]: p for p in resp.json()["plugins"]}
    for builtin_id in (
        "set_storey_elevations",
        "merge_duplicate_walls",
        "assign_classification",
    ):
        assert plugins[builtin_id]["builtin"] is True


def test_get_builtin_plugin(client):
    resp = client.get("/api/plugins/assign_classification")
    assert resp.status_code == 200
    body = resp.json()
    assert body["builtin"] is True
    assert body["manifest"]["id"] == "assign_classification"
    assert "IfcRelAssociatesClassification" in body["script"]


def test_get_unknown_plugin_404(client):
    resp = client.get("/api/plugins/does-not-exist")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# POST /api/plugins (create)
# ---------------------------------------------------------------------------

def test_create_plugin_201(client):
    resp = client.post(
        "/api/plugins", json={"manifest": _manifest(), "script": SCRIPT}
    )
    assert resp.status_code == 201
    assert resp.json()["builtin"] is False
    assert client.get("/api/plugins/my-plugin").status_code == 200


def test_create_duplicate_409(client):
    payload = {"manifest": _manifest(), "script": SCRIPT}
    assert client.post("/api/plugins", json=payload).status_code == 201
    assert client.post("/api/plugins", json=payload).status_code == 409


def test_create_with_builtin_id_409(client):
    resp = client.post(
        "/api/plugins",
        json={"manifest": _manifest(id="merge_duplicate_walls"), "script": SCRIPT},
    )
    assert resp.status_code == 409


def test_create_invalid_manifest_422_with_error_list(client):
    resp = client.post(
        "/api/plugins", json={"manifest": _manifest(id="BAD ID"), "script": ""}
    )
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert isinstance(detail, list)
    assert any("'id'" in e for e in detail)
    assert any("script" in e for e in detail)


# ---------------------------------------------------------------------------
# POST /api/plugins/install-zip
# ---------------------------------------------------------------------------

def test_install_zip_root_layout(client):
    resp = client.post(
        "/api/plugins/install-zip",
        files={"file": ("plugin.zip", _zip_bytes(), "application/zip")},
    )
    assert resp.status_code == 201
    assert resp.json()["id"] == "zipped-plugin"
    assert client.get("/api/plugins/zipped-plugin").status_code == 200


def test_install_zip_folder_layout(client):
    resp = client.post(
        "/api/plugins/install-zip",
        files={"file": ("plugin.zip", _zip_bytes("inner/"), "application/zip")},
    )
    assert resp.status_code == 201
    assert resp.json()["id"] == "zipped-plugin"


def test_install_zip_invalid_archive_422(client):
    resp = client.post(
        "/api/plugins/install-zip",
        files={"file": ("plugin.zip", b"not a zip", "application/zip")},
    )
    assert resp.status_code == 422


def test_install_zip_oversize_413(client):
    resp = client.post(
        "/api/plugins/install-zip",
        files={
            "file": (
                "plugin.zip",
                b"0" * (MAX_PLUGIN_ZIP_BYTES + 1),
                "application/zip",
            )
        },
    )
    assert resp.status_code == 413


# ---------------------------------------------------------------------------
# PUT / DELETE
# ---------------------------------------------------------------------------

def test_update_user_plugin(client):
    client.post("/api/plugins", json={"manifest": _manifest(), "script": SCRIPT})
    resp = client.put("/api/plugins/my-plugin", json={"script": "result = 1\n"})
    assert resp.status_code == 200
    assert resp.json()["script"] == "result = 1\n"


def test_update_builtin_403(client):
    resp = client.put(
        "/api/plugins/set_storey_elevations", json={"script": "result = 1\n"}
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == "Built-in plugins are read-only"


def test_update_unknown_404(client):
    resp = client.put("/api/plugins/does-not-exist", json={"script": "result = 1\n"})
    assert resp.status_code == 404


def test_delete_user_plugin(client):
    client.post("/api/plugins", json={"manifest": _manifest(), "script": SCRIPT})
    resp = client.delete("/api/plugins/my-plugin")
    assert resp.status_code == 200
    assert resp.json() == {"deleted": True}
    assert client.get("/api/plugins/my-plugin").status_code == 404


def test_delete_builtin_403(client):
    resp = client.delete("/api/plugins/merge_duplicate_walls")
    assert resp.status_code == 403
    assert resp.json()["detail"] == "Built-in plugins are read-only"


def test_delete_unknown_404(client):
    assert client.delete("/api/plugins/does-not-exist").status_code == 404


# ---------------------------------------------------------------------------
# POST /api/plugins/{id}/run
# ---------------------------------------------------------------------------

def test_run_no_model_loaded_400(client, monkeypatch):
    monkeypatch.setattr(ifc_service, "_model", None)
    resp = client.post("/api/plugins/merge_duplicate_walls/run", json={"params": {}})
    assert resp.status_code == 400
    assert "No IFC model loaded" in resp.json()["detail"]


def test_run_unknown_plugin_404(client, loaded_model):
    resp = client.post("/api/plugins/does-not-exist/run", json={"params": {}})
    assert resp.status_code == 404


def test_run_param_validation_422(client, loaded_model):
    resp = client.post(
        "/api/plugins/assign_classification/run",
        json={"params": {"bogus": 1}},
    )
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert "param 'code': required" in detail
    assert "param 'bogus': unknown parameter" in detail


def test_run_read_only_result_passthrough(client, loaded_model, monkeypatch):
    captured: dict = {}
    _patch_sandbox_run(
        monkeypatch,
        {"action": "execute_result", "stdout": "ok\n", "result": "2", "elapsed_ms": 5.0},
        captured,
    )
    client.post(
        "/api/plugins",
        json={"manifest": _manifest(id="counter"), "script": SCRIPT},
    )
    resp = client.post("/api/plugins/counter/run", json={"params": {}})
    assert resp.status_code == 200
    body = resp.json()
    assert body["action"] == "execute_result"
    assert body["stdout"] == "ok\n"
    assert body["result_repr"] == "2"
    assert body["plugin_id"] == "counter"
    assert body["plugin_name"] == "My Plugin"
    assert captured["read_only"] is True
    assert captured["code"].startswith("params = json.loads(")


def test_run_execute_error_passthrough(client, loaded_model, monkeypatch):
    _patch_sandbox_run(
        monkeypatch,
        {"action": "execute_error", "error": "boom", "stdout": "", "elapsed_ms": 2.0},
    )
    resp = client.post(
        "/api/plugins/merge_duplicate_walls/run", json={"params": {}}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["action"] == "execute_error"
    assert body["error"] == "boom"
    assert body["plugin_id"] == "merge_duplicate_walls"


def test_run_pending_edit_publishes_model_sync_event(
    client, loaded_model, monkeypatch
):
    captured: dict = {}
    _patch_sandbox_run(
        monkeypatch,
        {
            "action": "pending_edit",
            "edit_id": "edit-1",
            "summary": "1 deleted",
            "counts": {"deleted": 1, "total": 1},
            "changes": [],
        },
        captured,
    )

    class _FakeEnvelope:
        edit_id = "edit-1"

        def model_dump(self):
            return {"edit_id": "edit-1", "summary": "1 deleted"}

    monkeypatch.setattr(
        pr.sandbox_service,
        "get_pending",
        lambda edit_id: _FakeEnvelope() if edit_id == "edit-1" else None,
    )

    published = []

    async def fake_publish(event):
        published.append(event)

    monkeypatch.setattr(pr.model_sync_broker, "publish", fake_publish)

    resp = client.post(
        "/api/plugins/merge_duplicate_walls/run",
        json={"params": {"tolerance_mm": "2"}},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["action"] == "pending_edit"
    assert body["edit_id"] == "edit-1"
    assert body["plugin_id"] == "merge_duplicate_walls"
    assert body["plugin_name"] == "Merge Duplicate Walls"
    assert captured["read_only"] is False
    # The coerced number param made it into the preamble.
    first_line = captured["code"].split("\n", 1)[0]
    literal = first_line[len("params = json.loads(") : -1]
    assert json.loads(json.loads(literal)) == {"tolerance_mm": 2}

    assert len(published) == 1
    event = published[0]
    assert event.type == "pending_edit"
    assert event.edit_id == "edit-1"
    assert event.payload == {"edit_id": "edit-1", "summary": "1 deleted"}


def test_run_pending_edit_without_envelope_skips_publish(
    client, loaded_model, monkeypatch
):
    _patch_sandbox_run(
        monkeypatch,
        {"action": "pending_edit", "edit_id": "ghost", "summary": "s", "counts": {}},
    )
    monkeypatch.setattr(pr.sandbox_service, "get_pending", lambda edit_id: None)

    published = []

    async def fake_publish(event):
        published.append(event)

    monkeypatch.setattr(pr.model_sync_broker, "publish", fake_publish)

    resp = client.post(
        "/api/plugins/merge_duplicate_walls/run", json={"params": {}}
    )
    assert resp.status_code == 200
    assert published == []


def test_run_sandbox_precondition_value_error_400(client, loaded_model, monkeypatch):
    from app.services import plugin_service as ps_mod

    def raise_value_error(**kwargs):
        raise ValueError("Too many pending edits already in flight")

    monkeypatch.setattr(ps_mod.sandbox_service, "execute_python", raise_value_error)
    resp = client.post(
        "/api/plugins/merge_duplicate_walls/run", json={"params": {}}
    )
    assert resp.status_code == 400
    assert "Too many pending edits" in resp.json()["detail"]
