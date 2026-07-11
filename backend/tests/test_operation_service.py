"""Tests for the operation layer (app.services.operation_service).

Unit tests drive a FakeIfcService so they run in the fast CI lane with no
IfcOpenShell dependency. Integration tests (marked requires_ifc_load) drive the
real IfcService against BasicHouse via the shared `svc` fixture.
"""

import pytest

from app.services.operation_service import (
    Actor,
    OperationService,
    PatchTier,
    _register_builtins,
)


# ──────────────────────────────────────────────────────────────────────
# Fake IfcService, mirrors the write-method return contract the op layer reads
# ──────────────────────────────────────────────────────────────────────


class FakeIfcService:
    def __init__(self, fingerprint: str = "fp-unit"):
        self._fp = fingerprint
        self._elements = {
            361: {"Name": "Wall-A", "props": {"Reference": "old-ref"}},
            362: {"Name": "Wall-B", "props": {"Reference": "old-ref-b"}},
        }
        self._undo: list[dict] = []
        self._counter = 0

    @property
    def original_fingerprint(self) -> str:
        return self._fp

    @property
    def original_filename(self) -> str:
        return "Fake.ifc"

    def _next_edit_id(self) -> str:
        self._counter += 1
        return f"edit-{self._counter}"

    def rename_element(self, element_id: int, new_name: str) -> dict:
        el = self._elements.get(element_id)
        if el is None:
            raise ValueError(f"Element {element_id} not found")
        new_name = str(new_name).strip()
        if not new_name:
            raise ValueError("new_name must be non-empty")
        old = el["Name"]
        if old == new_name:
            return {"changed": False, "element_id": element_id, "reason": "already that name"}
        el["Name"] = new_name
        eid = self._next_edit_id()
        self._undo.append({"edit_id": eid, "inverse": [("name", element_id, None, old)]})
        return {
            "changed": True, "element_id": element_id, "old_name": old,
            "new_name": new_name, "edit_id": eid, "action": "metadata_changed",
            "changed_ids": [element_id], "description": f"Renamed to {new_name}",
        }

    def update_property_value(self, element_id, property_name, new_value, pset_name=None) -> dict:
        el = self._elements.get(element_id)
        if el is None:
            raise ValueError(f"Element {element_id} not found")
        if property_name not in el["props"]:
            raise ValueError(f"Property {property_name} not found on {element_id}")
        old = el["props"][property_name]
        el["props"][property_name] = new_value
        eid = self._next_edit_id()
        self._undo.append({"edit_id": eid, "inverse": [("prop", element_id, property_name, old)]})
        return {
            "changed": True, "element_id": element_id, "property_name": property_name,
            "old_value": old, "new_value": new_value, "edit_id": eid,
            "action": "metadata_changed", "changed_ids": [element_id],
            "description": f"Set {property_name}={new_value!r}",
        }

    def rename_elements_batch(self, renames: list[dict]) -> dict:
        changed_ids, inverse = [], []
        for item in renames:
            eid = int(item["element_id"])
            new_name = str(item["new_name"]).strip()
            el = self._elements.get(eid)
            if el is None or not new_name or el["Name"] == new_name:
                continue
            inverse.append(("name", eid, None, el["Name"]))
            el["Name"] = new_name
            changed_ids.append(eid)
        if not changed_ids:
            return {"changed_count": 0, "action": "metadata_changed", "changed_ids": []}
        edit_id = self._next_edit_id()
        self._undo.append({"edit_id": edit_id, "inverse": inverse})
        return {
            "changed_count": len(changed_ids), "edit_id": edit_id,
            "action": "metadata_changed", "changed_ids": changed_ids,
            "description": f"Batch rename: {len(changed_ids)}",
        }

    def update_properties_batch(self, updates: list[dict]) -> dict:
        changed_ids, inverse = [], []
        for item in updates:
            eid = int(item["element_id"])
            name = str(item["property_name"])
            el = self._elements.get(eid)
            if el is None or name not in el["props"]:
                continue
            inverse.append(("prop", eid, name, el["props"][name]))
            el["props"][name] = item["new_value"]
            changed_ids.append(eid)
        if not changed_ids:
            return {"changed_count": 0, "action": "metadata_changed", "changed_ids": []}
        edit_id = self._next_edit_id()
        self._undo.append({"edit_id": edit_id, "inverse": inverse})
        return {
            "changed_count": len(changed_ids), "edit_id": edit_id,
            "action": "metadata_changed", "changed_ids": changed_ids,
        }

    def undo_last_edit(self) -> dict:
        if not self._undo:
            return {"undone": False, "reason": "Undo stack is empty"}
        entry = self._undo.pop()
        ids = []
        for kind, eid, field, value in entry["inverse"]:
            el = self._elements[eid]
            if kind == "name":
                el["Name"] = value
            else:
                el["props"][field] = value
            ids.append(eid)
        return {
            "undone": True, "reverted_edit_id": entry["edit_id"],
            "description": "Undo", "action": "metadata_changed", "changed_ids": ids,
        }


# ──────────────────────────────────────────────────────────────────────
# Fixtures
# ──────────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _tmp_oplog(tmp_path, monkeypatch):
    """Isolate the operation log to a temp dir so tests never touch ~/.ifc-atlas."""
    monkeypatch.setattr("app.services.operation_service.DATA_DIR", tmp_path / "data")


def make_service() -> OperationService:
    s = OperationService()
    _register_builtins(s)
    return s


@pytest.fixture
def env():
    return make_service(), FakeIfcService()


# ──────────────────────────────────────────────────────────────────────
# Registry + validation
# ──────────────────────────────────────────────────────────────────────


def test_catalogue_lists_builtins(env):
    service, _ = env
    names = {op["name"] for op in service.catalogue()}
    assert {"set_name", "set_property", "set_names_batch", "set_properties_batch"} <= names


def test_unknown_op_returns_structured_error(env):
    service, svc = env
    res = service.execute("does_not_exist", {}, actor=Actor.AGENT, ifc_service=svc)
    assert res.ok is False
    assert "unknown operation" in (res.error or "")
    assert res.changed is False


def test_missing_required_param(env):
    service, svc = env
    res = service.execute("set_name", {"element_id": 361}, actor=Actor.USER, ifc_service=svc)
    assert res.ok is False
    assert "new_name" in (res.error or "")


def test_wrong_param_type(env):
    service, svc = env
    res = service.execute(
        "set_name", {"element_id": "361", "new_name": "X"}, actor=Actor.USER, ifc_service=svc
    )
    assert res.ok is False
    assert "element_id" in (res.error or "")


# ──────────────────────────────────────────────────────────────────────
# Execution, tiers, actor attribution, logging
# ──────────────────────────────────────────────────────────────────────


def test_set_name_success(env):
    service, svc = env
    res = service.execute(
        "set_name", {"element_id": 361, "new_name": "Renamed"}, actor=Actor.USER, ifc_service=svc
    )
    assert res.ok and res.changed
    assert res.patch_tier == PatchTier.METADATA
    assert 361 in res.changed_ids
    assert svc._elements[361]["Name"] == "Renamed"
    pub = res.to_public_dict()
    assert pub["action"] == "metadata_changed"
    assert pub["actor"] == "user"


def test_actor_attribution_recorded_in_log(env):
    service, svc = env
    service.execute("set_name", {"element_id": 361, "new_name": "ByAgent"}, actor=Actor.AGENT, ifc_service=svc)
    hist = service.history(svc)
    assert len(hist) == 1
    assert hist[0]["actor"] == "agent"
    assert hist[0]["name"] == "set_name"
    assert hist[0]["patch_tier"] == "metadata"


def test_mcp_actor(env):
    service, svc = env
    res = service.execute("set_property", {"element_id": 361, "property_name": "Reference", "new_value": "X"},
                          actor=Actor.MCP, ifc_service=svc)
    assert res.actor == Actor.MCP
    assert service.history(svc)[0]["actor"] == "mcp"


def test_noop_is_not_changed(env):
    service, svc = env
    res = service.execute("set_name", {"element_id": 361, "new_name": "Wall-A"}, actor=Actor.USER, ifc_service=svc)
    assert res.ok is True
    assert res.changed is False
    assert res.patch_tier == PatchTier.NONE


def test_executor_error_is_structured_and_logged(env):
    service, svc = env
    res = service.execute("set_name", {"element_id": 99999, "new_name": "X"}, actor=Actor.USER, ifc_service=svc)
    assert res.ok is False
    assert res.changed is False
    assert "99999" in (res.error or "")
    # Failed ops are still recorded for the audit trail.
    hist = service.history(svc)
    assert hist and hist[0]["ok"] is False


def test_property_tier_and_change(env):
    service, svc = env
    res = service.execute(
        "set_property",
        {"element_id": 362, "property_name": "Reference", "new_value": "new-ref"},
        actor=Actor.USER, ifc_service=svc,
    )
    assert res.changed and res.patch_tier == PatchTier.METADATA
    assert svc._elements[362]["props"]["Reference"] == "new-ref"


def test_batch_changed_count_derivation(env):
    service, svc = env
    res = service.execute(
        "set_names_batch",
        {"renames": [{"element_id": 361, "new_name": "P"}, {"element_id": 362, "new_name": "Q"}]},
        actor=Actor.AGENT, ifc_service=svc,
    )
    assert res.changed is True
    assert set(res.changed_ids) == {361, 362}


def test_large_params_truncated_in_log(env):
    service, svc = env
    big = "z" * 6000
    service.execute(
        "set_property",
        {"element_id": 361, "property_name": "Reference", "new_value": big},
        actor=Actor.USER, ifc_service=svc,
    )
    entry = service.history(svc)[0]
    assert entry["params"].get("_truncated") is True


# ──────────────────────────────────────────────────────────────────────
# Undo / redo
# ──────────────────────────────────────────────────────────────────────


def test_undo_reverts_change(env):
    service, svc = env
    service.execute("set_name", {"element_id": 361, "new_name": "Temp"}, actor=Actor.USER, ifc_service=svc)
    res = service.undo(svc)
    assert res.ok and res.changed
    assert svc._elements[361]["Name"] == "Wall-A"


def test_undo_empty_stack(env):
    service, svc = env
    res = service.undo(svc)
    assert res.ok is True
    assert res.changed is False
    assert "nothing to undo" in (res.error or "").lower() or "empty" in (res.error or "").lower()


def test_redo_reapplies(env):
    service, svc = env
    service.execute("set_name", {"element_id": 361, "new_name": "Final"}, actor=Actor.USER, ifc_service=svc)
    service.undo(svc)
    assert svc._elements[361]["Name"] == "Wall-A"
    assert service.can_redo() is True
    res = service.redo(svc)
    assert res.ok and res.changed
    assert svc._elements[361]["Name"] == "Final"


def test_new_forward_op_clears_redo(env):
    service, svc = env
    service.execute("set_name", {"element_id": 361, "new_name": "One"}, actor=Actor.USER, ifc_service=svc)
    service.undo(svc)
    assert service.can_redo() is True
    # A fresh forward edit must break the redo chain.
    service.execute("set_property", {"element_id": 362, "property_name": "Reference", "new_value": "z"},
                    actor=Actor.USER, ifc_service=svc)
    assert service.can_redo() is False


def test_redo_empty(env):
    service, svc = env
    res = service.redo(svc)
    assert res.ok is False
    assert "nothing to redo" in (res.error or "")


def test_undo_redo_undo_cycle(env):
    service, svc = env
    service.execute("set_name", {"element_id": 361, "new_name": "Cycle"}, actor=Actor.USER, ifc_service=svc)
    service.undo(svc)
    service.redo(svc)              # re-applies "Cycle" as a fresh edit
    assert svc._elements[361]["Name"] == "Cycle"
    service.undo(svc)             # undo the redo
    assert svc._elements[361]["Name"] == "Wall-A"


def test_redo_does_not_replay_across_model_switch(env):
    """A redo armed on model A must never replay A's params against a freshly
    loaded model B - redo() rebinds the op log (clearing the stack) BEFORE
    popping, not lazily after the executor has already mutated B."""
    service, svc = env
    service.execute("set_name", {"element_id": 361, "new_name": "ModelA"}, actor=Actor.USER, ifc_service=svc)
    service.undo(svc)
    assert service.can_redo() is True

    other = FakeIfcService(fingerprint="fp-other-model")
    res = service.redo(other)
    assert res.ok is False
    assert "nothing to redo" in (res.error or "")
    # Model B untouched - the stale replay never reached its executor.
    assert other._elements[361]["Name"] == "Wall-A"


def test_can_redo_rebinds_when_given_a_service(env):
    service, svc = env
    service.execute("set_name", {"element_id": 361, "new_name": "X2"}, actor=Actor.USER, ifc_service=svc)
    service.undo(svc)
    assert service.can_redo() is True
    assert service.can_redo(FakeIfcService(fingerprint="fp-two")) is False


# ──────────────────────────────────────────────────────────────────────
# record_external - synthetic entries for out-of-registry mutations (R3)
# ──────────────────────────────────────────────────────────────────────


def test_record_external_appears_in_history(env):
    service, svc = env
    service.record_external(
        name="apply_pending_edit",
        actor=Actor.AGENT,
        description="Applied pending edit abc123",
        ifc_service=svc,
        changed_ids=[361, 362],
        edit_id="abc123",
    )
    entries = service.history(svc, limit=10)
    assert entries, "external mutation must be logged"
    top = entries[0]
    assert top["name"] == "apply_pending_edit"
    assert top["actor"] == "agent"
    assert top["changed_ids"] == [361, 362]
    assert top["edit_id"] == "abc123"


def test_record_external_clears_armed_redo(env):
    """A sandbox apply / rollback changes the model under any armed replay -
    the redo chain must break."""
    service, svc = env
    service.execute("set_name", {"element_id": 361, "new_name": "Armed"}, actor=Actor.USER, ifc_service=svc)
    service.undo(svc)
    assert service.can_redo() is True
    service.record_external(
        name="rollback", actor=Actor.USER, description="Rolled back", ifc_service=svc,
    )
    assert service.can_redo() is False


def test_record_external_never_raises_on_broken_service(env):
    service, _ = env

    class Broken:
        pass

    res = service.record_external(
        name="apply_pending_edit", actor=Actor.AGENT, description="x", ifc_service=Broken(),
    )
    assert res.ok is True


# ──────────────────────────────────────────────────────────────────────
# Auto-checkpoint hook (plan C1): every applied op snapshots to git
# ──────────────────────────────────────────────────────────────────────


def test_applied_op_triggers_auto_checkpoint(env, monkeypatch):
    from app.services import ifc_checkpoint_service as cps_mod

    service, svc = env
    calls: list[str] = []
    monkeypatch.setattr(
        cps_mod.ifc_checkpoint_service, "snapshot",
        lambda data, message="": calls.append(message) or "deadbeef1234",
    )
    # Fake gains read_bytes so the hook has bytes to snapshot.
    svc.read_bytes = lambda: b"ISO-10303-21;"
    service.execute("set_name", {"element_id": 361, "new_name": "Snapshotted"}, actor=Actor.USER, ifc_service=svc)
    assert len(calls) == 1
    assert calls[0].startswith("set_name (user):")


def test_noop_op_does_not_checkpoint(env, monkeypatch):
    from app.services import ifc_checkpoint_service as cps_mod

    service, svc = env
    calls: list[str] = []
    monkeypatch.setattr(
        cps_mod.ifc_checkpoint_service, "snapshot",
        lambda data, message="": calls.append(message) or "deadbeef1234",
    )
    svc.read_bytes = lambda: b"ISO-10303-21;"
    # Renaming to the current name is a no-op (changed=False).
    service.execute("set_name", {"element_id": 361, "new_name": "Wall-A"}, actor=Actor.USER, ifc_service=svc)
    assert calls == []


def test_checkpoint_failure_does_not_fail_the_edit(env, monkeypatch):
    from app.services import ifc_checkpoint_service as cps_mod

    service, svc = env

    def _boom(data, message=""):
        raise RuntimeError("git exploded")

    monkeypatch.setattr(cps_mod.ifc_checkpoint_service, "snapshot", _boom)
    svc.read_bytes = lambda: b"ISO-10303-21;"
    res = service.execute("set_name", {"element_id": 361, "new_name": "StillWorks"}, actor=Actor.USER, ifc_service=svc)
    assert res.ok and res.changed
    assert svc._elements[361]["Name"] == "StillWorks"


# ──────────────────────────────────────────────────────────────────────
# Integration against a real IfcOpenShell model (BasicHouse via `svc` fixture)
# ──────────────────────────────────────────────────────────────────────

WALL_ID = 361


@pytest.mark.requires_ifc_load
class TestOperationServiceIntegration:
    def test_set_name_through_operation_layer(self, svc):
        service = make_service()
        original = svc.model.by_id(WALL_ID).Name
        res = service.execute(
            "set_name", {"element_id": WALL_ID, "new_name": "OpLayerWall"},
            actor=Actor.USER, ifc_service=svc,
        )
        assert res.ok and res.changed
        assert res.patch_tier == PatchTier.METADATA
        assert WALL_ID in res.changed_ids
        assert svc.model.by_id(WALL_ID).Name == "OpLayerWall"
        hist = service.history(svc)
        assert hist and hist[0]["name"] == "set_name" and hist[0]["actor"] == "user"
        assert original != "OpLayerWall"

    def test_undo_redo_through_operation_layer(self, svc):
        service = make_service()
        original = svc.model.by_id(WALL_ID).Name
        service.execute(
            "set_name", {"element_id": WALL_ID, "new_name": "TmpName"},
            actor=Actor.AGENT, ifc_service=svc,
        )
        assert svc.model.by_id(WALL_ID).Name == "TmpName"
        service.undo(svc)
        assert svc.model.by_id(WALL_ID).Name == original
        service.redo(svc)
        assert svc.model.by_id(WALL_ID).Name == "TmpName"
