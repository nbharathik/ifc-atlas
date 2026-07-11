"""Native-IFC ID-stability contract (Invariant 12 / ADR 003, 004).

The editor promises the ifcmerge "Native IFC" contract so that git diff/merge on
IFC stays viable:
  1. numeric entity IDs are preserved across saves,
  2. attribute changes are written in place (same id keeps its identity),
  3. deleted IDs are not immediately reused.

If any of these break, `ifcmerge`/`ifcdiff` history (ADR 004) silently corrupts.
These tests are the CI guard. They load a real model, so they carry the
requires_ifc_load marker and run in the full (Python 3.12) lane.
"""

import ifcopenshell
import pytest

pytestmark = pytest.mark.requires_ifc_load

WALL_ID = 361


class TestIdStabilityContract:
    def test_express_ids_preserved_across_save_reload(self, svc, tmp_path):
        """Every product keeps its express id AND its GlobalId through a
        write/reload round-trip."""
        original = {e.id(): e.GlobalId for e in svc.model.by_type("IfcProduct")}
        assert original, "fixture model has no products"

        out = tmp_path / "roundtrip.ifc"
        svc.save_as(out)
        reloaded = ifcopenshell.open(str(out))

        for express_id, global_id in original.items():
            ent = reloaded.by_id(express_id)
            assert ent is not None, f"express id {express_id} vanished on reload"
            assert ent.GlobalId == global_id, (
                f"id {express_id} changed identity: {global_id} -> {ent.GlobalId}"
            )

    def test_attribute_edit_is_in_place(self, svc, tmp_path):
        """A rename mutates the entity at the same express id, preserving its
        GlobalId, and survives a save/reload."""
        wall = svc.model.by_id(WALL_ID)
        gid = wall.GlobalId

        svc.rename_element(WALL_ID, "ContractWall")
        after = svc.model.by_id(WALL_ID)
        assert after.GlobalId == gid, "attribute edit changed entity identity"
        assert after.Name == "ContractWall"

        out = tmp_path / "edited.ifc"
        svc.save_as(out)
        reloaded = ifcopenshell.open(str(out))
        assert reloaded.by_id(WALL_ID).GlobalId == gid
        assert reloaded.by_id(WALL_ID).Name == "ContractWall"

    def test_deleted_ids_not_immediately_reused(self, svc):
        """A freed express id is not handed straight back to the next new
        entity (the property ifcmerge relies on)."""
        model = svc.model
        ids_before = {e.id() for e in model}

        probe = model.create_entity("IfcPropertySingleValue", Name="ContractProbe1")
        fresh_id = probe.id()
        assert fresh_id not in ids_before, "new entity reused an existing id"

        model.remove(probe)
        probe2 = model.create_entity("IfcPropertySingleValue", Name="ContractProbe2")
        assert probe2.id() != fresh_id, (
            "freed id was immediately reused, breaks the ifcmerge ID contract"
        )
        assert probe2.id() not in ids_before

    def test_new_entity_ids_are_fresh_monotonic(self, svc):
        """New entities take ids above the current maximum, never filling gaps."""
        model = svc.model
        max_before = max(e.id() for e in model)
        e1 = model.create_entity("IfcPropertySingleValue", Name="Mono1")
        e2 = model.create_entity("IfcPropertySingleValue", Name="Mono2")
        assert e1.id() > max_before
        assert e2.id() > e1.id()
