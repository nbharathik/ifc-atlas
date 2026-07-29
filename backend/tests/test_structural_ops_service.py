"""Structural operations end-to-end through IfcService + the operation layer.

Real IfcOpenShell models (tiny generated templates - fast), real writes, real
undo. Covers the R5 vertical: create_wall/create_slab/create_storey/
assign_to_storey/set_storey_elevation/delete_element registered as ops,
BULK-tier classification, inverse-op undo for creations, snapshot undo for
deletions (express-id preservation = the native-IFC ID contract).
"""

from __future__ import annotations


import pytest

ifcopenshell = pytest.importorskip("ifcopenshell")

from app.services.ifc_service import IfcService
from app.services.operation_service import Actor, OperationService, PatchTier, _register_builtins
from app.services.project_template_service import create_blank_project


@pytest.fixture()
def svc(tmp_path, monkeypatch) -> IfcService:
    """A real IfcService with a freshly generated single-storey template."""
    monkeypatch.setattr("app.services.operation_service.DATA_DIR", tmp_path / "data")
    path = tmp_path / "template.ifc"
    path.write_bytes(create_blank_project("single_storey"))
    service = IfcService()
    service.load(path)
    return service


@pytest.fixture()
def ops(tmp_path, monkeypatch) -> OperationService:
    monkeypatch.setattr("app.services.operation_service.DATA_DIR", tmp_path / "data")
    service = OperationService()
    _register_builtins(service)
    return service


def _wall_count(svc: IfcService) -> int:
    return len(svc.model.by_type("IfcWall"))


# ---------------------------------------------------------------------------
# create_wall through the op layer
# ---------------------------------------------------------------------------


def test_create_wall_op_end_to_end(svc, ops):
    res = ops.execute(
        "create_wall",
        {"start": [0.0, 0.0], "end": [5.0, 0.0], "height": 3.0, "thickness": 0.2, "name": "Op Wall"},
        actor=Actor.USER,
        ifc_service=svc,
    )
    assert res.ok and res.changed
    assert res.patch_tier == PatchTier.BULK, "creation must classify as BULK (viewers reload)"
    assert res.detail["action"] == "model_refresh"
    wall_id = res.detail["element_id"]
    wall = svc.model.by_id(wall_id)
    assert wall.is_a("IfcWall") and wall.Name == "Op Wall"
    assert _wall_count(svc) == 1


def test_create_wall_undo_removes_and_breaks_redo(svc, ops):
    res = ops.execute(
        "create_wall", {"start": [0, 0], "end": [3, 0]}, actor=Actor.USER, ifc_service=svc,
    )
    wall_id = res.detail["element_id"]
    undo = ops.undo(svc)
    assert undo.ok and undo.changed
    assert undo.patch_tier == PatchTier.BULK, "undoing a creation is a structural change"
    with pytest.raises(RuntimeError):
        svc.model.by_id(wall_id)
    assert _wall_count(svc) == 0
    # Creations mint express ids → replay would produce a different entity;
    # the redo chain must be broken, not silently wrong.
    assert ops.can_redo() is False


def test_create_wall_validation_errors_are_structured(svc, ops):
    res = ops.execute(
        "create_wall", {"start": [0, 0], "end": [0, 0]}, actor=Actor.USER, ifc_service=svc,
    )
    assert res.ok is False
    assert "too close" in (res.error or "")
    assert _wall_count(svc) == 0


# ---------------------------------------------------------------------------
# create_slab / create_storey / assign_to_storey / set_storey_elevation
# ---------------------------------------------------------------------------


def test_create_slab_op(svc, ops):
    res = ops.execute(
        "create_slab",
        {"outline": [[0, 0], [4, 0], [4, 3], [0, 3]], "depth": 0.2},
        actor=Actor.USER,
        ifc_service=svc,
    )
    assert res.ok and res.changed and res.patch_tier == PatchTier.BULK
    slab = svc.model.by_id(res.detail["element_id"])
    assert slab.is_a("IfcSlab")


def test_storey_lifecycle_ops(svc, ops):
    created = ops.execute(
        "create_storey", {"name": "Level 2", "elevation": 6.0}, actor=Actor.USER, ifc_service=svc,
    )
    assert created.ok and created.changed
    storey_id = created.detail["element_id"]

    wall = ops.execute(
        "create_wall", {"start": [0, 0], "end": [2, 0]}, actor=Actor.USER, ifc_service=svc,
    )
    wall_id = wall.detail["element_id"]

    moved = ops.execute(
        "assign_to_storey", {"element_id": wall_id, "storey_id": storey_id},
        actor=Actor.USER, ifc_service=svc,
    )
    assert moved.ok and moved.changed

    import ifcopenshell.util.element as ue

    assert ue.get_container(svc.model.by_id(wall_id)).id() == storey_id

    # Undo the move: the wall returns to its original storey.
    undo = ops.undo(svc)
    assert undo.ok and undo.changed
    assert ue.get_container(svc.model.by_id(wall_id)).id() != storey_id

    # Elevation edit + undo round-trip.
    elev = ops.execute(
        "set_storey_elevation", {"storey_id": storey_id, "elevation": 7.5},
        actor=Actor.USER, ifc_service=svc,
    )
    assert elev.ok and elev.changed
    assert elev.patch_tier == PatchTier.METADATA
    assert float(svc.model.by_id(storey_id).Elevation) == pytest.approx(7.5)
    ops.undo(svc)
    assert float(svc.model.by_id(storey_id).Elevation) == pytest.approx(6.0)


# ---------------------------------------------------------------------------
# delete_element with snapshot undo (the ID contract must hold)
# ---------------------------------------------------------------------------


def test_delete_element_op_and_snapshot_undo(svc, ops):
    created = ops.execute(
        "create_wall", {"start": [0, 0], "end": [4, 0], "name": "Doomed"},
        actor=Actor.USER, ifc_service=svc,
    )
    wall_id = created.detail["element_id"]
    global_id = svc.model.by_id(wall_id).GlobalId

    deleted = ops.execute(
        "delete_element", {"element_id": wall_id}, actor=Actor.USER, ifc_service=svc,
    )
    assert deleted.ok and deleted.changed and deleted.patch_tier == PatchTier.BULK
    with pytest.raises(RuntimeError):
        svc.model.by_id(wall_id)

    undo = ops.undo(svc)
    assert undo.ok and undo.changed, f"snapshot undo failed: {undo.error}"
    restored = svc.model.by_id(wall_id)
    # Express id AND GlobalId identical - the snapshot restore preserves the
    # native-IFC ID contract byte-for-byte.
    assert restored.is_a("IfcWall")
    assert restored.GlobalId == global_id
    assert restored.Name == "Doomed"


def test_delete_undo_snapshot_files_are_cleaned_up(svc):
    res = svc.create_wall(start=[0, 0], end=[2, 0])
    svc.delete_element(res["element_id"])
    snap_dir = svc._file_path.parent / ".undo_snapshots"  # noqa: SLF001
    assert snap_dir.exists() and any(snap_dir.iterdir()), "snapshot written on delete"
    out = svc.undo_last_edit()
    assert out["undone"] is True
    assert not any(snap_dir.iterdir()), "snapshot consumed by undo"


def test_save_to_original_resets_dirty_without_rekeying_history(svc):
    """A7 Save: working copy → original path; dirty clears; the history key
    (original_fingerprint) must NOT change (it keys the op log + checkpoints)."""
    history_key = svc.original_fingerprint
    res = svc.create_wall(start=[0, 0], end=[3, 0], name="Saved Wall")
    assert svc.dirty is True

    target = svc.save_to_original()
    assert svc.dirty is False
    assert svc.original_fingerprint == history_key

    saved = ifcopenshell.open(str(target))
    wall = saved.by_id(res["element_id"])
    assert wall.is_a("IfcWall") and wall.Name == "Saved Wall"

    # A fresh edit after saving re-flags dirty against the NEW baseline.
    svc.rename_element(res["element_id"], "Renamed After Save")
    assert svc.dirty is True
    # And undoing back to the saved state clears it again.
    svc.undo_last_edit()
    assert svc.dirty is False


def test_operations_survive_save_reload_id_stability(svc, ops, tmp_path):
    """Create → save-as → reload: the created wall keeps its express id
    (extends the C5 contract to authored elements)."""
    res = ops.execute(
        "create_wall", {"start": [1, 1], "end": [6, 1], "name": "Stable"},
        actor=Actor.USER, ifc_service=svc,
    )
    wall_id = res.detail["element_id"]
    gid = svc.model.by_id(wall_id).GlobalId

    target = tmp_path / "roundtrip.ifc"
    svc.save_as(target)
    reloaded = ifcopenshell.open(str(target))
    again = reloaded.by_id(wall_id)
    assert again.is_a("IfcWall")
    assert again.GlobalId == gid
    assert again.Name == "Stable"
