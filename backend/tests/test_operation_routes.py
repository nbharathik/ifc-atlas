"""Route tests for the editor operation endpoints (/api/ifc/operations/*).

The router is mounted on a fresh FastAPI app (app.main is never imported). The
IfcService global is replaced with a small fake, the operation log is redirected
to a temp dir, and the shared edit lock + sync broker are stubbed so TestClient's
per-request event loop can't trip over loop-bound asyncio objects. The REAL
operation_service runs, so these exercise route -> operation layer -> response
end to end.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import ifc_routes
from app.api.ifc_routes import router


class _FakeIfc:
    """Minimal IfcService stand-in supporting the ops the routes drive."""

    def __init__(self) -> None:
        self._el = {361: {"Name": "Wall-A"}}
        self._undo: list[tuple[int, str, str]] = []
        self._v = 1
        self._n = 0

    @property
    def is_loaded(self) -> bool:
        return True

    @property
    def original_fingerprint(self) -> str:
        return "route-test-fp"

    @property
    def original_filename(self) -> str:
        return "Fake.ifc"

    def get_model_contract(self) -> dict:
        return {"model_version": self._v, "model_fingerprint": "fp", "edit_id": None}

    def rename_element(self, element_id: int, new_name: str) -> dict:
        el = self._el[element_id]
        old = el["Name"]
        el["Name"] = new_name
        self._n += 1
        eid = f"e{self._n}"
        self._v += 1
        self._undo.append((element_id, old, eid))
        return {"changed": True, "element_id": element_id, "old_name": old,
                "new_name": new_name, "edit_id": eid, "action": "metadata_changed",
                "changed_ids": [element_id], "description": f"Renamed to {new_name}"}

    def undo_last_edit(self) -> dict:
        if not self._undo:
            return {"undone": False, "reason": "Undo stack is empty"}
        element_id, old, eid = self._undo.pop()
        self._el[element_id]["Name"] = old
        self._v += 1
        return {"undone": True, "reverted_edit_id": eid, "action": "metadata_changed",
                "changed_ids": [element_id], "description": "Undo"}


class _NullLock:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr("app.services.operation_service.DATA_DIR", tmp_path / "data")
    fake = _FakeIfc()
    monkeypatch.setattr(ifc_routes, "ifc_service", fake)
    monkeypatch.setattr(ifc_routes, "_apply_lock", _NullLock())

    async def _noop_publish(_event):
        return None

    monkeypatch.setattr(ifc_routes.model_sync_broker, "publish", _noop_publish)
    app = FastAPI()
    app.include_router(router)
    return TestClient(app), fake, monkeypatch


def _edit_mode(monkeypatch, on: bool) -> None:
    monkeypatch.setattr(ifc_routes.app_config, "EDIT_MODE_ENABLED", on)


def test_execute_gated_off_returns_403(env):
    client, _, mp = env
    _edit_mode(mp, False)
    r = client.post("/api/ifc/operations/execute",
                    json={"operation": "set_name", "params": {"element_id": 361, "new_name": "X"}})
    assert r.status_code == 403


def test_execute_success(env):
    client, fake, mp = env
    _edit_mode(mp, True)
    r = client.post("/api/ifc/operations/execute",
                    json={"operation": "set_name", "params": {"element_id": 361, "new_name": "NewName"}})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and body["changed"] is True
    assert body["operation"] == "set_name"
    assert body["actor"] == "user"
    assert body["patch_tier"] == "metadata"
    assert 361 in body["changed_ids"]
    assert fake._el[361]["Name"] == "NewName"


def test_execute_unknown_op_is_ok_false(env):
    client, _, mp = env
    _edit_mode(mp, True)
    r = client.post("/api/ifc/operations/execute", json={"operation": "nope", "params": {}})
    assert r.status_code == 200
    assert r.json()["ok"] is False


def test_undo_redo_cycle(env):
    client, fake, mp = env
    _edit_mode(mp, True)
    client.post("/api/ifc/operations/execute",
                json={"operation": "set_name", "params": {"element_id": 361, "new_name": "Edited"}})
    assert fake._el[361]["Name"] == "Edited"

    r_undo = client.post("/api/ifc/operations/undo")
    assert r_undo.status_code == 200 and r_undo.json()["changed"] is True
    assert fake._el[361]["Name"] == "Wall-A"

    r_redo = client.post("/api/ifc/operations/redo")
    assert r_redo.status_code == 200
    assert fake._el[361]["Name"] == "Edited"


def test_catalogue_is_ungated(env):
    client, _, mp = env
    _edit_mode(mp, False)  # still reachable
    r = client.get("/api/ifc/operations/catalogue")
    assert r.status_code == 200
    names = {o["name"] for o in r.json()["operations"]}
    assert "set_name" in names and "set_property" in names


def test_history_is_actor_attributed(env):
    client, _, mp = env
    _edit_mode(mp, True)
    client.post("/api/ifc/operations/execute",
                json={"operation": "set_name", "params": {"element_id": 361, "new_name": "H"}})
    r = client.get("/api/ifc/operations/history")
    assert r.status_code == 200
    ops = r.json()["operations"]
    assert ops and ops[0]["actor"] == "user" and ops[0]["name"] == "set_name"


def test_execute_requires_loaded_model(tmp_path, monkeypatch):
    monkeypatch.setattr("app.services.operation_service.DATA_DIR", tmp_path / "d")
    monkeypatch.setattr(ifc_routes, "_apply_lock", _NullLock())

    class _Unloaded:
        is_loaded = False

    monkeypatch.setattr(ifc_routes, "ifc_service", _Unloaded())
    monkeypatch.setattr(ifc_routes.app_config, "EDIT_MODE_ENABLED", True)
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    r = client.post("/api/ifc/operations/execute",
                    json={"operation": "set_name", "params": {"element_id": 1, "new_name": "X"}})
    assert r.status_code == 400
