"""
Tests for IfcService structured write tools:
  rename_element, update_property_value, undo_last_edit, get_edit_history

All tests use a fresh per-test copy of BasicHouse.ifc (via conftest.svc fixture)
so mutations never bleed between tests or corrupt the source file.

Anchored element IDs from BasicHouse.ifc:
  Wall #361  name='Basic Wall:Yttervägg Paroc:1298028'
             pset 'Pset_WallCommon' → 'Reference' = 'Yttervägg Paroc'
             pset 'Structural'      → 'Structural' = False (bool)
             pset 'Dimensions'      → 'Length'     = 22060.0 (float)
"""

import pytest

# Uses the conftest `svc` fixture which loads BasicHouse.ifc via IfcOpenShell.
# Skipped by the fast pre-flight: pytest -m "not requires_ifc_load".
pytestmark = pytest.mark.requires_ifc_load

WALL_ID = 361
WALL_ORIG_NAME = "Basic Wall:Yttervägg Paroc:1298028"
PROP_PSET = "Pset_WallCommon"
PROP_NAME = "Reference"
PROP_ORIG = "Yttervägg Paroc"

BOOL_PSET = "Structural"
BOOL_PROP = "Structural"

MISSING_ID = 99999


# ──────────────────────────────────────────────────────────────────────────────
# rename_element
# ──────────────────────────────────────────────────────────────────────────────

class TestRenameElement:
    def test_round_trip(self, svc):
        result = svc.rename_element(WALL_ID, "TestWall")
        assert result["changed"] is True
        assert result["old_name"] == WALL_ORIG_NAME
        assert result["new_name"] == "TestWall"
        assert result["element_id"] == WALL_ID
        assert result["action"] == "metadata_changed"
        assert WALL_ID in result["changed_ids"]
        assert "edit_id" in result

    def test_entity_name_mutated(self, svc):
        svc.rename_element(WALL_ID, "MutatedName")
        entity = svc.model.by_id(WALL_ID)
        assert entity.Name == "MutatedName"

    def test_undo_restores_name(self, svc):
        svc.rename_element(WALL_ID, "TempName")
        undo = svc.undo_last_edit()
        assert undo["undone"] is True
        entity = svc.model.by_id(WALL_ID)
        assert entity.Name == WALL_ORIG_NAME

    def test_already_same_name_no_change(self, svc):
        result = svc.rename_element(WALL_ID, WALL_ORIG_NAME)
        assert result["changed"] is False

    def test_empty_name_raises(self, svc):
        with pytest.raises(ValueError, match="non-empty"):
            svc.rename_element(WALL_ID, "   ")

    def test_missing_element_raises(self, svc):
        with pytest.raises(ValueError, match=str(MISSING_ID)):
            svc.rename_element(MISSING_ID, "X")

    def test_model_version_increments(self, svc):
        v0 = svc.model_version
        svc.rename_element(WALL_ID, "VersionTest")
        assert svc.model_version == v0 + 1

    def test_undo_stack_grows_by_one(self, svc):
        before = len(svc.get_edit_history())
        svc.rename_element(WALL_ID, "StackTest")
        assert len(svc.get_edit_history()) == before + 1


# ──────────────────────────────────────────────────────────────────────────────
# update_property_value
# ──────────────────────────────────────────────────────────────────────────────

class TestUpdatePropertyValue:
    def test_round_trip_string(self, svc):
        result = svc.update_property_value(WALL_ID, PROP_NAME, "NewRef", pset_name=PROP_PSET)
        assert result["changed"] is True
        assert result["old_value"] == PROP_ORIG
        assert result["new_value"] == "NewRef"
        assert result["property_set"] == PROP_PSET
        assert result["property_name"] == PROP_NAME
        assert result["action"] == "metadata_changed"

    def test_value_persisted_in_model(self, svc):
        svc.update_property_value(WALL_ID, PROP_NAME, "PersistCheck", pset_name=PROP_PSET)
        val, _ = svc._read_property_value(svc.model.by_id(WALL_ID), PROP_NAME, PROP_PSET)
        assert val == "PersistCheck"

    def test_undo_restores_string(self, svc):
        svc.update_property_value(WALL_ID, PROP_NAME, "Temporary", pset_name=PROP_PSET)
        svc.undo_last_edit()
        val, _ = svc._read_property_value(svc.model.by_id(WALL_ID), PROP_NAME, PROP_PSET)
        assert val == PROP_ORIG

    def test_round_trip_bool(self, svc):
        result = svc.update_property_value(WALL_ID, BOOL_PROP, True, pset_name=BOOL_PSET)
        assert result["changed"] is True
        assert result["old_value"] is False

    def test_undo_restores_bool(self, svc):
        svc.update_property_value(WALL_ID, BOOL_PROP, True, pset_name=BOOL_PSET)
        svc.undo_last_edit()
        val, _ = svc._read_property_value(svc.model.by_id(WALL_ID), BOOL_PROP, BOOL_PSET)
        assert val is False

    def test_missing_element_raises(self, svc):
        with pytest.raises(ValueError, match=str(MISSING_ID)):
            svc.update_property_value(MISSING_ID, PROP_NAME, "X")

    def test_property_not_found_raises(self, svc):
        with pytest.raises(ValueError, match="NoSuchProp"):
            svc.update_property_value(WALL_ID, "NoSuchProp", "val")

    def test_model_version_increments(self, svc):
        v0 = svc.model_version
        svc.update_property_value(WALL_ID, PROP_NAME, "V", pset_name=PROP_PSET)
        assert svc.model_version == v0 + 1

    def test_without_pset_hint_still_finds_property(self, svc):
        # should resolve without an explicit pset_name
        result = svc.update_property_value(WALL_ID, PROP_NAME, "NoPsetHint")
        assert result["changed"] is True


# ──────────────────────────────────────────────────────────────────────────────
# undo_last_edit
# ──────────────────────────────────────────────────────────────────────────────

class TestUndoLastEdit:
    def test_empty_stack(self, svc):
        result = svc.undo_last_edit()
        assert result["undone"] is False
        assert "empty" in result["reason"].lower()

    def test_undo_after_rename(self, svc):
        svc.rename_element(WALL_ID, "BeforeUndo")
        result = svc.undo_last_edit()
        assert result["undone"] is True
        assert WALL_ID in result["changed_ids"]
        assert result["action"] == "metadata_changed"

    def test_undo_after_property_update(self, svc):
        svc.update_property_value(WALL_ID, PROP_NAME, "Before", pset_name=PROP_PSET)
        result = svc.undo_last_edit()
        assert result["undone"] is True

    def test_sequential_undos(self, svc):
        svc.rename_element(WALL_ID, "First")
        svc.rename_element(WALL_ID, "Second")
        svc.undo_last_edit()  # undoes "Second" → restores "First"
        assert svc.model.by_id(WALL_ID).Name == "First"
        svc.undo_last_edit()  # undoes "First" → restores original
        assert svc.model.by_id(WALL_ID).Name == WALL_ORIG_NAME

    def test_undo_reduces_stack(self, svc):
        svc.rename_element(WALL_ID, "A")
        svc.rename_element(WALL_ID, "B")
        before = len(svc.get_edit_history())
        svc.undo_last_edit()
        assert len(svc.get_edit_history()) == before - 1

    def test_undo_increments_model_version(self, svc):
        svc.rename_element(WALL_ID, "VersionCheck")
        v1 = svc.model_version
        svc.undo_last_edit()
        assert svc.model_version == v1 + 1

    def test_undo_twice_on_empty_second(self, svc):
        svc.rename_element(WALL_ID, "OnlyOne")
        svc.undo_last_edit()
        result = svc.undo_last_edit()
        assert result["undone"] is False


# ──────────────────────────────────────────────────────────────────────────────
# get_edit_history
# ──────────────────────────────────────────────────────────────────────────────

class TestGetEditHistory:
    def test_empty_initially(self, svc):
        assert svc.get_edit_history() == []

    def test_grows_after_edit(self, svc):
        svc.rename_element(WALL_ID, "HistoryTest")
        history = svc.get_edit_history()
        assert len(history) == 1

    def test_newest_first_order(self, svc):
        svc.rename_element(WALL_ID, "HistA")
        svc.rename_element(WALL_ID, "HistB")
        history = svc.get_edit_history()
        assert len(history) == 2
        assert "HistB" in history[0]["description"]
        assert "HistA" in history[1]["description"]

    def test_no_inverse_ops_in_entries(self, svc):
        svc.rename_element(WALL_ID, "NoInverse")
        for entry in svc.get_edit_history():
            assert "inverse_ops" not in entry

    def test_entry_has_required_fields(self, svc):
        svc.rename_element(WALL_ID, "FieldsCheck")
        entry = svc.get_edit_history()[0]
        assert "edit_id" in entry
        assert "description" in entry
        assert "timestamp" in entry

    def test_shrinks_after_undo(self, svc):
        svc.rename_element(WALL_ID, "WillUndo")
        svc.undo_last_edit()
        assert svc.get_edit_history() == []

    def test_multi_edit_mixed_ops(self, svc):
        svc.rename_element(WALL_ID, "Mixed1")
        svc.update_property_value(WALL_ID, PROP_NAME, "Mixed2", pset_name=PROP_PSET)
        history = svc.get_edit_history()
        assert len(history) == 2
        descriptions = [h["description"] for h in history]
        assert any(PROP_NAME in d for d in descriptions)
        assert any("Mixed1" in d for d in descriptions)
