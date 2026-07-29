"""Tests for rename_elements_batch and update_properties_batch.

Pure unit tests - no IfcOpenShell / file-system dependency.
We test both the IfcService methods (via a hand-rolled mock model) and the
execute_tool dispatch path.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from app.services.ifc_service import IfcService


# ---------------------------------------------------------------------------
# Helpers - minimal IfcService with a stubbed model
# ---------------------------------------------------------------------------

def _make_entity(express_id: int, name: str, ifc_type: str = "IfcWall") -> SimpleNamespace:
    entity = SimpleNamespace(Name=name)
    entity.is_a = lambda: ifc_type
    entity.id = lambda: express_id
    return entity


def _make_svc(*entities: SimpleNamespace) -> IfcService:
    """Return an IfcService with a mock model pre-populated with *entities*."""
    svc = IfcService()
    mock_model = MagicMock()
    entity_map: dict[int, SimpleNamespace] = {e.id(): e for e in entities}

    def by_id(eid: int):
        return entity_map.get(int(eid))

    mock_model.by_id.side_effect = by_id
    # _persist_model / _cache_meta_snapshot are stubbed to avoid file I/O
    svc._model = mock_model
    svc._persist_model = MagicMock()
    svc._cache_meta_snapshot = MagicMock()
    # _read_property_value and _apply_property_edit tested separately
    return svc


# ---------------------------------------------------------------------------
# rename_elements_batch - IfcService level
# ---------------------------------------------------------------------------

class TestRenameElementsBatch:
    def test_empty_list_returns_zero_counts(self):
        svc = _make_svc()
        result = svc.rename_elements_batch([])
        assert result["changed_count"] == 0
        assert result["skipped_count"] == 0
        assert result["failed_count"] == 0
        assert result["results"] == []

    def test_single_rename_succeeds(self):
        e = _make_entity(10, "OldName")
        svc = _make_svc(e)
        result = svc.rename_elements_batch([{"element_id": 10, "new_name": "NewName"}])
        assert result["changed_count"] == 1
        assert result["skipped_count"] == 0
        assert result["failed_count"] == 0
        assert e.Name == "NewName"
        assert result["action"] == "metadata_changed"
        assert 10 in result["changed_ids"]
        assert "edit_id" in result

    def test_multiple_renames_share_one_undo_entry(self):
        e1 = _make_entity(1, "Wall A")
        e2 = _make_entity(2, "Wall B")
        svc = _make_svc(e1, e2)
        result = svc.rename_elements_batch([
            {"element_id": 1, "new_name": "Wall A v2"},
            {"element_id": 2, "new_name": "Wall B v2"},
        ])
        assert result["changed_count"] == 2
        assert len(svc._undo_stack) == 1
        entry = svc._undo_stack[0]
        assert len(entry["inverse_ops"]) == 2

    def test_no_op_rename_is_skipped(self):
        e = _make_entity(5, "SameName")
        svc = _make_svc(e)
        result = svc.rename_elements_batch([{"element_id": 5, "new_name": "SameName"}])
        assert result["changed_count"] == 0
        assert result["skipped_count"] == 1
        # No undo entry - nothing changed
        assert len(svc._undo_stack) == 0

    def test_missing_element_is_failed(self):
        svc = _make_svc()  # empty model
        result = svc.rename_elements_batch([{"element_id": 999, "new_name": "X"}])
        assert result["changed_count"] == 0
        assert result["failed_count"] == 1
        assert result["results"][0]["status"] == "failed"
        assert len(svc._undo_stack) == 0

    def test_partial_batch_some_succeed_some_fail(self):
        e = _make_entity(1, "Exists")
        svc = _make_svc(e)
        result = svc.rename_elements_batch([
            {"element_id": 1, "new_name": "NewName"},   # succeeds
            {"element_id": 999, "new_name": "X"},        # fails - not in model
        ])
        assert result["changed_count"] == 1
        assert result["failed_count"] == 1
        assert e.Name == "NewName"
        # Undo entry for the one successful rename
        assert len(svc._undo_stack) == 1

    def test_persist_called_once_for_whole_batch(self):
        e1 = _make_entity(1, "A")
        e2 = _make_entity(2, "B")
        svc = _make_svc(e1, e2)
        svc.rename_elements_batch([
            {"element_id": 1, "new_name": "A2"},
            {"element_id": 2, "new_name": "B2"},
        ])
        svc._persist_model.assert_called_once()

    def test_all_noop_no_persist(self):
        e = _make_entity(1, "Same")
        svc = _make_svc(e)
        svc.rename_elements_batch([{"element_id": 1, "new_name": "Same"}])
        svc._persist_model.assert_not_called()

    def test_result_records_old_and_new_name(self):
        e = _make_entity(7, "OldName")
        svc = _make_svc(e)
        result = svc.rename_elements_batch([{"element_id": 7, "new_name": "NewName"}])
        r = result["results"][0]
        assert r["old_name"] == "OldName"
        assert r["new_name"] == "NewName"
        assert r["status"] == "changed"

    def test_empty_new_name_is_failed(self):
        e = _make_entity(1, "Name")
        svc = _make_svc(e)
        result = svc.rename_elements_batch([{"element_id": 1, "new_name": "  "}])
        assert result["failed_count"] == 1


# ---------------------------------------------------------------------------
# update_properties_batch - IfcService level
# ---------------------------------------------------------------------------

class TestUpdatePropertiesBatch:
    def _svc_with_property(self, express_id: int, prop_name: str, old_value, pset: str = "Pset_Test"):
        """Build an IfcService whose mock model can service one property lookup."""
        e = _make_entity(express_id, "SomeElement")
        svc = _make_svc(e)
        # Stub _read_property_value + _apply_property_edit
        svc._read_property_value = MagicMock(return_value=(old_value, pset))
        svc._apply_property_edit = MagicMock(return_value=(True, None))
        return svc

    def test_empty_list_returns_zero_counts(self):
        svc = _make_svc()
        result = svc.update_properties_batch([])
        assert result["changed_count"] == 0

    def test_single_update_succeeds(self):
        svc = self._svc_with_property(10, "LoadBearing", False)
        result = svc.update_properties_batch([
            {"element_id": 10, "property_name": "LoadBearing", "new_value": True}
        ])
        assert result["changed_count"] == 1
        assert result["action"] == "metadata_changed"
        assert 10 in result["changed_ids"]
        assert "edit_id" in result

    def test_multiple_updates_share_one_undo_entry(self):
        e1 = _make_entity(1, "E1")
        e2 = _make_entity(2, "E2")
        svc = _make_svc(e1, e2)
        svc._read_property_value = MagicMock(return_value=(False, "PsetA"))
        svc._apply_property_edit = MagicMock(return_value=(True, None))
        svc.update_properties_batch([
            {"element_id": 1, "property_name": "P", "new_value": True},
            {"element_id": 2, "property_name": "P", "new_value": True},
        ])
        assert len(svc._undo_stack) == 1
        entry = svc._undo_stack[0]
        assert len(entry["inverse_ops"]) == 2

    def test_no_op_update_is_skipped(self):
        svc = self._svc_with_property(5, "Prop", "same")
        result = svc.update_properties_batch([
            {"element_id": 5, "property_name": "Prop", "new_value": "same"}
        ])
        assert result["changed_count"] == 0
        assert result["skipped_count"] == 1
        assert len(svc._undo_stack) == 0

    def test_property_not_found_is_failed(self):
        e = _make_entity(1, "E")
        svc = _make_svc(e)
        svc._read_property_value = MagicMock(return_value=(None, None))
        svc._apply_property_edit = MagicMock(return_value=(True, None))
        result = svc.update_properties_batch([
            {"element_id": 1, "property_name": "NoSuchProp", "new_value": "x"}
        ])
        assert result["failed_count"] == 1
        assert result["results"][0]["status"] == "failed"

    def test_missing_element_is_failed(self):
        svc = _make_svc()  # empty model
        result = svc.update_properties_batch([
            {"element_id": 999, "property_name": "P", "new_value": "x"}
        ])
        assert result["failed_count"] == 1

    def test_partial_batch_some_succeed_some_fail(self):
        e = _make_entity(1, "E")
        svc = _make_svc(e)
        call_count = [0]

        def _read(entity, prop, pset):
            call_count[0] += 1
            if call_count[0] == 1:
                return ("old", "PsetA")  # first succeeds
            return (None, None)           # second fails - property not found

        svc._read_property_value = MagicMock(side_effect=_read)
        svc._apply_property_edit = MagicMock(return_value=(True, None))
        result = svc.update_properties_batch([
            {"element_id": 1, "property_name": "PropA", "new_value": "new"},
            {"element_id": 1, "property_name": "NoSuch", "new_value": "x"},
        ])
        assert result["changed_count"] == 1
        assert result["failed_count"] == 1
        assert len(svc._undo_stack) == 1

    def test_persist_called_once_for_whole_batch(self):
        e1 = _make_entity(1, "E1")
        e2 = _make_entity(2, "E2")
        svc = _make_svc(e1, e2)
        svc._read_property_value = MagicMock(return_value=("old", "Pset"))
        svc._apply_property_edit = MagicMock(return_value=(True, None))
        svc.update_properties_batch([
            {"element_id": 1, "property_name": "P", "new_value": "v1"},
            {"element_id": 2, "property_name": "P", "new_value": "v2"},
        ])
        svc._persist_model.assert_called_once()

    def test_all_noop_no_persist(self):
        e = _make_entity(1, "E")
        svc = _make_svc(e)
        svc._read_property_value = MagicMock(return_value=("same", "Pset"))
        svc._apply_property_edit = MagicMock(return_value=(True, None))
        svc.update_properties_batch([
            {"element_id": 1, "property_name": "P", "new_value": "same"}
        ])
        svc._persist_model.assert_not_called()

    def test_stats_cache_cleared_after_successful_update(self):
        e = _make_entity(1, "E")
        svc = _make_svc(e)
        svc._stats_cache = object()  # sentinel non-None value
        svc._read_property_value = MagicMock(return_value=("old", "Pset"))
        svc._apply_property_edit = MagicMock(return_value=(True, None))
        svc.update_properties_batch([{"element_id": 1, "property_name": "P", "new_value": "new"}])
        assert svc._stats_cache is None

    def test_stats_cache_not_cleared_when_all_noop(self):
        e = _make_entity(1, "E")
        svc = _make_svc(e)
        sentinel = object()
        svc._stats_cache = sentinel
        svc._read_property_value = MagicMock(return_value=("same", "Pset"))
        svc._apply_property_edit = MagicMock(return_value=(True, None))
        svc.update_properties_batch([{"element_id": 1, "property_name": "P", "new_value": "same"}])
        assert svc._stats_cache is sentinel  # unchanged - no write path triggered


# ---------------------------------------------------------------------------
# Undo integration - undo_last_edit reverses batch operations
# ---------------------------------------------------------------------------

class TestBatchUndoIntegration:
    def test_undo_reverses_rename_elements_batch(self):
        e = _make_entity(1, "OldName")
        svc = _make_svc(e)
        svc._patch_cached_tree_name = MagicMock()

        svc.rename_elements_batch([{"element_id": 1, "new_name": "NewName"}])
        assert e.Name == "NewName"
        assert len(svc._undo_stack) == 1

        result = svc.undo_last_edit()
        assert result["undone"] is True
        assert e.Name == "OldName"
        assert len(svc._undo_stack) == 0

    def test_undo_reverses_update_properties_batch(self):
        e = _make_entity(1, "E")
        svc = _make_svc(e)
        svc._read_property_value = MagicMock(return_value=("old_val", "PsetA"))
        apply_calls: list[dict] = []

        def _apply(entity, op):
            apply_calls.append({"entity": entity, "op": op})
            return (True, None)

        svc._apply_property_edit = MagicMock(side_effect=_apply)

        svc.update_properties_batch([{"element_id": 1, "property_name": "P", "new_value": "new_val"}])
        assert len(svc._undo_stack) == 1

        result = svc.undo_last_edit()
        assert result["undone"] is True
        assert len(svc._undo_stack) == 0
        # The inverse op should have restored the old value
        undo_call = apply_calls[-1]["op"]
        assert undo_call.value == "old_val"

    def test_undo_reverses_two_renames_atomically(self):
        e1 = _make_entity(1, "A")
        e2 = _make_entity(2, "B")
        svc = _make_svc(e1, e2)
        svc._patch_cached_tree_name = MagicMock()

        svc.rename_elements_batch([
            {"element_id": 1, "new_name": "A2"},
            {"element_id": 2, "new_name": "B2"},
        ])
        result = svc.undo_last_edit()

        assert result["undone"] is True
        assert e1.Name == "A"
        assert e2.Name == "B"

    def test_undo_stats_cache_cleared(self):
        e = _make_entity(1, "OldName")
        svc = _make_svc(e)
        svc._patch_cached_tree_name = MagicMock()

        svc.rename_elements_batch([{"element_id": 1, "new_name": "NewName"}])
        svc._stats_cache = object()  # pretend something populated it

        result = svc.undo_last_edit()
        assert result["undone"] is True
        assert svc._stats_cache is None

    def test_undo_empty_stack(self):
        svc = _make_svc()
        result = svc.undo_last_edit()
        assert result["undone"] is False
        assert "empty" in result["reason"].lower()


# ---------------------------------------------------------------------------
# execute_tool dispatch - rename_elements_batch
# ---------------------------------------------------------------------------

def _run_batch_rename(arguments: dict) -> dict:
    from app.services.tools import execute_tool
    from app.services.operation_service import Actor

    mock_result = {
        "changed_count": 1,
        "skipped_count": 0,
        "failed_count": 0,
        "results": [{"element_id": 1, "status": "changed", "old_name": "OldName", "new_name": "NewName"}],
        "edit_id": "abc",
        "description": "Batch rename: 1 element(s)",
        "action": "metadata_changed",
        "changed_ids": [1],
    }
    with patch("app.services.tools.ifc_service") as mock_svc:
        mock_svc.is_loaded = True
        mock_svc.rename_elements_batch.return_value = mock_result
        return execute_tool("edit_semantic", arguments, actor=Actor.MCP)


def _run_batch_update(arguments: dict) -> dict:
    from app.services.tools import execute_tool
    from app.services.operation_service import Actor

    mock_result = {
        "changed_count": 1,
        "skipped_count": 0,
        "failed_count": 0,
        "results": [{"element_id": 1, "status": "changed"}],
        "edit_id": "def",
        "description": "Batch property update: 1 element(s)",
        "action": "metadata_changed",
        "changed_ids": [1],
    }
    with patch("app.services.tools.ifc_service") as mock_svc:
        mock_svc.is_loaded = True
        mock_svc.update_properties_batch.return_value = mock_result
        return execute_tool("edit_semantic", arguments, actor=Actor.MCP)


class TestExecuteToolDispatch:
    def test_rename_batch_dispatched(self):
        # Two set_name ops → the homogeneous batch dispatches to
        # rename_elements_batch (one atomic undo entry).
        result = _run_batch_rename({"ops": [
            {"op": "set_name", "element_id": 1, "new_name": "NewName"},
            {"op": "set_name", "element_id": 2, "new_name": "Other"},
        ]})
        assert result["changed_count"] == 1  # preset mock result

    def test_rename_batch_bad_type_returns_error(self):
        result = _run_batch_rename({"ops": "not-a-list"})
        assert "error" in result

    def test_missing_ops_returns_error(self):
        result = _run_batch_rename({})
        assert "error" in result

    def test_rename_batch_forwards_renames_list(self):
        from app.services.tools import execute_tool
        from app.services.operation_service import Actor
        with patch("app.services.tools.ifc_service") as mock_svc:
            mock_svc.is_loaded = True
            mock_svc.rename_elements_batch.return_value = {"changed_count": 0, "results": []}
            execute_tool("edit_semantic", {"ops": [
                {"op": "set_name", "element_id": 1, "new_name": "A"},
                {"op": "set_name", "element_id": 2, "new_name": "B"},
            ]}, actor=Actor.MCP)
            mock_svc.rename_elements_batch.assert_called_once_with([
                {"element_id": 1, "new_name": "A"},
                {"element_id": 2, "new_name": "B"},
            ])

    def test_update_batch_dispatched(self):
        result = _run_batch_update({"ops": [
            {"op": "set_property", "element_id": 1, "property_name": "P", "new_value": "v"},
            {"op": "set_property", "element_id": 2, "property_name": "P", "new_value": "w"},
        ]})
        assert result["changed_count"] == 1  # preset mock result

    def test_update_batch_bad_type_returns_error(self):
        result = _run_batch_update({"ops": "not-a-list"})
        assert "error" in result

    def test_update_batch_forwards_updates_list(self):
        from app.services.tools import execute_tool
        from app.services.operation_service import Actor
        with patch("app.services.tools.ifc_service") as mock_svc:
            mock_svc.is_loaded = True
            mock_svc.update_properties_batch.return_value = {"changed_count": 0, "results": []}
            execute_tool("edit_semantic", {"ops": [
                {"op": "set_property", "element_id": 1, "property_name": "P", "new_value": "v"},
                {"op": "set_property", "element_id": 2, "property_name": "Q", "new_value": "w"},
            ]}, actor=Actor.MCP)
            mock_svc.update_properties_batch.assert_called_once_with([
                {"element_id": 1, "property_name": "P", "new_value": "v"},
                {"element_id": 2, "property_name": "Q", "new_value": "w"},
            ])

    def test_mixed_batch_stages_sandbox_proposal_even_for_mcp(self):
        """A mixed edit_semantic ops batch has no direct operation-layer
        equivalent, so it falls back to the staged sandbox ceremony."""
        from types import SimpleNamespace
        from app.services.tools import execute_tool
        from app.services.operation_service import Actor
        env = SimpleNamespace(
            edit_id="mix-1", summary="mixed", counts={},
            changes=[], verifier_verdict=None,
        )
        with (
            patch("app.services.tools.ifc_service") as mock_svc,
            patch(
                "app.services.tools.sandbox_service.propose_edit",
                return_value=env,
            ) as propose,
        ):
            mock_svc.is_loaded = True
            result = execute_tool("edit_semantic", {"ops": [
                {"op": "set_name", "element_id": 1, "new_name": "A"},
                {"op": "set_property", "element_id": 2, "property_name": "P", "new_value": "v"},
            ]}, actor=Actor.MCP)
        assert result["action"] == "pending_edit"
        assert propose.call_args.kwargs["operations"][0]["op"] == "set_name"
