"""
Tests for SandboxService (Invariant-4 pending-edit machinery).

Anchored element IDs from BasicHouse.ifc (matches test_edit_tools.py):
  Wall #361  name='Basic Wall:Yttervägg Paroc:1298028'
             pset 'Pset_WallCommon' → 'Reference' = 'Yttervägg Paroc'
"""

from __future__ import annotations

import shutil
from pathlib import Path

import ifcopenshell
import pytest

from app.services.ifc_service import IfcService
from app.services.sandbox_service import (
    PSET_BINDING_KEY,
    SandboxService,
    _compute_diff,
    _default_summary,
    _read_properties_by_pset,
)

# Opens the shared BasicHouse fixture directly via IfcOpenShell at module scope.
# Skipped by the fast pre-flight: pytest -m "not requires_ifc_load".
pytestmark = pytest.mark.requires_ifc_load

REPO_ROOT = Path(__file__).parent.parent.parent
BASICHOUSE = REPO_ROOT / "data" / "fixtures" / "BasicHouse.ifc"

WALL_ID = 361
WALL_ORIG_NAME = "Basic Wall:Yttervägg Paroc:1298028"
PROP_PSET = "Pset_WallCommon"
PROP_NAME = "Reference"
PROP_ORIG = "Yttervägg Paroc"


@pytest.fixture
def svc(tmp_path):
    """Per-test IfcService with its own fresh BasicHouse copy.

    Apply tests swap the sandbox into ``ifc_service._file_path`` via
    ``shutil.move``, which would corrupt a session-shared fixture file.
    Give every test its own copy so isolation is guaranteed.
    """
    dst = tmp_path / "BasicHouse.ifc"
    shutil.copy(BASICHOUSE, dst)
    service = IfcService()
    service.load(dst)
    return service


@pytest.fixture
def sandbox():
    """A fresh SandboxService per test. Singleton isn't safe to share."""
    svc = SandboxService()
    yield svc
    svc.clear_all()


class TestProposeEdit:
    def test_rename_produces_renamed_change(self, svc, sandbox):
        envelope = sandbox.propose_edit(
            ifc_service=svc,
            operations=[
                {"op": "set_name", "element_id": WALL_ID, "new_name": "ProposedName"}
            ],
            summary="rename wall",
        )
        assert envelope is not None
        assert envelope.counts.get("renamed") == 1
        assert envelope.counts.get("total") == 1

        change = next(c for c in envelope.changes if c.express_id == WALL_ID)
        assert change.change == "renamed"
        assert change.name_before == WALL_ORIG_NAME
        assert change.name_after == "ProposedName"

    def test_property_change_produces_property_changed(self, svc, sandbox):
        envelope = sandbox.propose_edit(
            ifc_service=svc,
            operations=[
                {
                    "op": "set_property",
                    "element_id": WALL_ID,
                    "pset_name": PROP_PSET,
                    "property_name": PROP_NAME,
                    "new_value": "NewRef",
                }
            ],
        )
        assert envelope is not None
        # NOTE: the 'Reference' property on WALL_ID is shared (via IFC
        # reference identity) with 3 other walls AND appears in two psets
        # (Pset_WallCommon + Pset_QuantityTakeOff), so mutating it here
        # legitimately surfaces multiple property_changed rows in the diff.
        assert envelope.counts.get("property_changed", 0) >= 1
        change = next(c for c in envelope.changes if c.express_id == WALL_ID)
        assert change.change == "property_changed"
        matching = [
            pc for pc in change.property_changes
            if pc["property_name"] == PROP_NAME
            and pc["property_set"] == PROP_PSET
        ]
        assert matching, "expected Pset_WallCommon.Reference change in diff"
        assert matching[0]["before"] == PROP_ORIG
        assert matching[0]["after"] == "NewRef"

    def test_no_op_returns_none_when_same_value(self, svc, sandbox):
        envelope = sandbox.propose_edit(
            ifc_service=svc,
            operations=[
                {"op": "set_name", "element_id": WALL_ID, "new_name": WALL_ORIG_NAME}
            ],
        )
        # Assigning the same Name may or may not change the on-disk bytes
        # depending on IfcOpenShell's write ordering. The interesting invariant
        # is that the diff does NOT report a rename. Any envelope must have
        # renamed=0.
        if envelope is not None:
            assert envelope.counts.get("renamed", 0) == 0

    def test_live_model_unchanged_by_proposal(self, svc, sandbox):
        sandbox.propose_edit(
            ifc_service=svc,
            operations=[
                {"op": "set_name", "element_id": WALL_ID, "new_name": "ShouldNotLeak"}
            ],
        )
        # The live model must remain on the original name - sandbox is sandboxed.
        entity = svc.model.by_id(WALL_ID)
        assert entity.Name == WALL_ORIG_NAME

    def test_missing_element_raises(self, svc, sandbox):
        with pytest.raises(ValueError, match="99999"):
            sandbox.propose_edit(
                ifc_service=svc,
                operations=[
                    {"op": "set_name", "element_id": 99999, "new_name": "Ghost"}
                ],
            )

    def test_unsupported_op_raises(self, svc, sandbox):
        with pytest.raises(ValueError, match="unsupported"):
            sandbox.propose_edit(
                ifc_service=svc,
                operations=[{"op": "explode", "element_id": WALL_ID}],
            )

    def test_empty_ops_raises(self, svc, sandbox):
        with pytest.raises(ValueError, match="non-empty"):
            sandbox.propose_edit(ifc_service=svc, operations=[])


class TestApplyPending:
    def test_apply_mutates_live_model(self, svc, sandbox):
        envelope = sandbox.propose_edit(
            ifc_service=svc,
            operations=[
                {"op": "set_name", "element_id": WALL_ID, "new_name": "AppliedName"}
            ],
        )
        assert envelope is not None
        sandbox.apply_pending(edit_id=envelope.edit_id, ifc_service=svc)
        entity = svc.model.by_id(WALL_ID)
        assert entity.Name == "AppliedName"

    def test_apply_bumps_model_version(self, svc, sandbox):
        v0 = svc.model_version
        envelope = sandbox.propose_edit(
            ifc_service=svc,
            operations=[
                {"op": "set_name", "element_id": WALL_ID, "new_name": "Bumped"}
            ],
        )
        assert envelope is not None
        sandbox.apply_pending(edit_id=envelope.edit_id, ifc_service=svc)
        assert svc.model_version == v0 + 1

    def test_apply_removes_from_pending_list(self, svc, sandbox):
        envelope = sandbox.propose_edit(
            ifc_service=svc,
            operations=[
                {"op": "set_name", "element_id": WALL_ID, "new_name": "GoneFromList"}
            ],
        )
        assert envelope is not None
        assert sandbox.get_pending(envelope.edit_id) is not None
        sandbox.apply_pending(edit_id=envelope.edit_id, ifc_service=svc)
        assert sandbox.get_pending(envelope.edit_id) is None

    def test_apply_refuses_stale_proposal(self, svc, sandbox):
        envelope = sandbox.propose_edit(
            ifc_service=svc,
            operations=[
                {"op": "set_name", "element_id": WALL_ID, "new_name": "FirstProposal"}
            ],
        )
        assert envelope is not None

        # Simulate an out-of-band mutation by forcibly drifting the live
        # fingerprint. Using rename_element here would require a real
        # on-disk rewrite to bump the file-derived fingerprint; forcing it
        # directly is the tightest way to exercise the stale-check branch.
        svc._model_fingerprint = "deadbeef_stale_fingerprint"  # noqa: SLF001

        with pytest.raises(ValueError, match="stale"):
            sandbox.apply_pending(edit_id=envelope.edit_id, ifc_service=svc)


class TestDiscardPending:
    def test_discard_removes_from_list(self, svc, sandbox):
        envelope = sandbox.propose_edit(
            ifc_service=svc,
            operations=[
                {"op": "set_name", "element_id": WALL_ID, "new_name": "Throwaway"}
            ],
        )
        assert envelope is not None
        sandbox.discard_pending(envelope.edit_id)
        assert sandbox.get_pending(envelope.edit_id) is None

    def test_discard_does_not_mutate_live_model(self, svc, sandbox):
        envelope = sandbox.propose_edit(
            ifc_service=svc,
            operations=[
                {"op": "set_name", "element_id": WALL_ID, "new_name": "WillDiscard"}
            ],
        )
        assert envelope is not None
        sandbox.discard_pending(envelope.edit_id)
        entity = svc.model.by_id(WALL_ID)
        assert entity.Name == WALL_ORIG_NAME

    def test_discard_unknown_id_raises(self, svc, sandbox):
        with pytest.raises(ValueError, match="No pending"):
            sandbox.discard_pending("does-not-exist")


class TestDiffWidening:
    """Coverage for the IfcRelDefinesByProperties churn fix.

    Mutations the SUPPORTED_OPS can't produce today (pset attach / detach,
    non-single-value property edits) must still surface a non-empty diff
    when execute_ifc_code lands - otherwise Apply stays disabled and the
    user can't commit a genuine change. We exercise ``_compute_diff`` /
    ``_read_properties_by_pset`` directly here rather than going through
    ``propose_edit`` so we can simulate those mutations with the raw
    ifcopenshell API.
    """

    def test_read_properties_adds_binding_sentinel_per_pset(self):
        f = ifcopenshell.open(str(BASICHOUSE))
        entity = f.by_id(WALL_ID)
        out = _read_properties_by_pset(entity)
        assert out, "wall should have at least one pset"
        for pset_name, bucket in out.items():
            assert bucket.get(PSET_BINDING_KEY) == "attached", (
                f"pset {pset_name!r} is missing the attach sentinel - "
                "attach/detach churn will be invisible in the diff"
            )

    def test_compute_diff_surfaces_pset_detach(self, tmp_path):
        """Detaching a pset from a wall (without touching any single-value
        property) must surface as a property_changed row with the binding
        sentinel flipping ``attached → None``."""
        base_path = tmp_path / "base.ifc"
        sandbox_path = tmp_path / "sandbox.ifc"
        shutil.copy(BASICHOUSE, base_path)
        shutil.copy(BASICHOUSE, sandbox_path)

        base_model = ifcopenshell.open(str(base_path))
        sandbox_model = ifcopenshell.open(str(sandbox_path))

        # Find the IfcRelDefinesByProperties that wires Pset_WallCommon to
        # the wall and drop the wall from its RelatedObjects - detach.
        wall = sandbox_model.by_id(WALL_ID)
        target_rel = None
        for rel in wall.IsDefinedBy:
            if not rel.is_a("IfcRelDefinesByProperties"):
                continue
            pset = rel.RelatingPropertyDefinition
            if pset.is_a("IfcPropertySet") and pset.Name == PROP_PSET:
                target_rel = rel
                break
        assert target_rel is not None, "expected Pset_WallCommon rel on wall"
        target_rel.RelatedObjects = tuple(
            o for o in target_rel.RelatedObjects if o.id() != WALL_ID
        )

        changes = _compute_diff(base_model, sandbox_model)
        wall_change = next((c for c in changes if c.express_id == WALL_ID), None)
        assert wall_change is not None, "detach must surface in the diff"
        assert wall_change.change == "property_changed"

        bindings = [
            pc for pc in wall_change.property_changes
            if pc["property_name"] == PSET_BINDING_KEY
            and pc["property_set"] == PROP_PSET
        ]
        assert bindings, (
            "detach should emit a <pset binding> row for Pset_WallCommon"
        )
        assert bindings[0]["before"] == "attached"
        assert bindings[0]["after"] is None

    def test_compute_diff_surfaces_pset_attach(self, tmp_path):
        """Attaching a pset to an element that didn't have it before
        surfaces as a ``None → attached`` binding row. BasicHouse happens
        to share most wall psets across all walls, so we instead pick a
        wall-only pset and a non-wall IfcProduct (slab) that doesn't have
        it - any (target element, unused pset) pair exercises the same
        branch."""
        base_path = tmp_path / "base.ifc"
        sandbox_path = tmp_path / "sandbox.ifc"
        shutil.copy(BASICHOUSE, base_path)
        shutil.copy(BASICHOUSE, sandbox_path)

        base_model = ifcopenshell.open(str(base_path))
        sandbox_model = ifcopenshell.open(str(sandbox_path))

        def psets_of(entity) -> set[str]:
            return {
                rel.RelatingPropertyDefinition.Name
                for rel in (getattr(entity, "IsDefinedBy", []) or [])
                if rel.is_a("IfcRelDefinesByProperties")
                and rel.RelatingPropertyDefinition.is_a("IfcPropertySet")
            }

        # Find ANY (IfcProduct, IfcPropertySet) pair where the product
        # does not currently have that pset attached.
        target_id = None
        pset_name = None
        products = list(base_model.by_type("IfcProduct"))
        psets = list(base_model.by_type("IfcPropertySet"))
        for product in products:
            have = psets_of(product)
            for ps in psets:
                if ps.Name and ps.Name not in have:
                    target_id = product.id()
                    pset_name = ps.Name
                    break
            if target_id is not None:
                break
        assert target_id is not None and pset_name is not None, (
            "BasicHouse should have at least one (product, pset) pair where "
            "the pset isn't already attached"
        )

        sandbox_target = sandbox_model.by_id(target_id)
        target_rel = None
        for rel in sandbox_model.by_type("IfcRelDefinesByProperties"):
            ps = rel.RelatingPropertyDefinition
            if ps.is_a("IfcPropertySet") and ps.Name == pset_name:
                target_rel = rel
                break
        assert target_rel is not None
        target_rel.RelatedObjects = tuple(target_rel.RelatedObjects) + (sandbox_target,)

        changes = _compute_diff(base_model, sandbox_model)
        touched = next((c for c in changes if c.express_id == target_id), None)
        assert touched is not None, "attach must surface on the newly-wired element"
        bindings = [
            pc for pc in touched.property_changes
            if pc["property_name"] == PSET_BINDING_KEY
            and pc["property_set"] == pset_name
        ]
        assert bindings, "attach should emit a <pset binding> row"
        assert bindings[0]["before"] is None
        assert bindings[0]["after"] == "attached"

    def test_non_single_value_property_change_surfaces(self):
        """Reading enumerated / list / bounded properties via their formatter
        helpers must produce a stable string - two reads of the same value
        compare equal, two reads of different values differ."""
        from app.services.sandbox_service import _fmt_bounded, _fmt_enumerated, _fmt_list

        class _Wrapped:
            def __init__(self, v): self.wrappedValue = v

        class _Enum:
            EnumerationValues = [_Wrapped("A"), _Wrapped("B")]

        class _Enum2:
            EnumerationValues = [_Wrapped("A"), _Wrapped("C")]

        assert _fmt_enumerated(_Enum()) == _fmt_enumerated(_Enum())
        assert _fmt_enumerated(_Enum()) != _fmt_enumerated(_Enum2())

        class _List:
            ListValues = [_Wrapped(1.0), _Wrapped(2.0)]

        class _List2:
            ListValues = [_Wrapped(1.0), _Wrapped(3.0)]

        assert _fmt_list(_List()) != _fmt_list(_List2())

        class _Bounded:
            LowerBoundValue = _Wrapped(0.0)
            UpperBoundValue = _Wrapped(10.0)

        class _Bounded2:
            LowerBoundValue = _Wrapped(0.0)
            UpperBoundValue = _Wrapped(20.0)

        assert _fmt_bounded(_Bounded()) != _fmt_bounded(_Bounded2())


class TestListPending:
    def test_accumulates_multiple_proposals(self, svc, sandbox):
        e1 = sandbox.propose_edit(
            ifc_service=svc,
            operations=[
                {"op": "set_name", "element_id": WALL_ID, "new_name": "One"}
            ],
        )
        e2 = sandbox.propose_edit(
            ifc_service=svc,
            operations=[
                {"op": "set_name", "element_id": WALL_ID, "new_name": "Two"}
            ],
        )
        assert e1 is not None and e2 is not None
        listed = {e.edit_id for e in sandbox.list_pending()}
        assert {e1.edit_id, e2.edit_id} <= listed


# ──────────────────────────────────────────────────────────────────────
# _default_summary - pluralisation + script-prefix tuning
#
# Pure function; no fixtures, no subprocess, no IFC I/O. Fast unit tests.
# ──────────────────────────────────────────────────────────────────────


class TestDefaultSummary:
    def test_single_rename_counts_label(self):
        out = _default_summary(
            [{"op": "set_name", "element_id": 1, "new_name": "X"}],
            {"renamed": 1, "total": 1},
        )
        assert out == "1 renamed"

    def test_multi_bucket_is_joined_in_stable_order(self):
        out = _default_summary(
            [{"op": "set_name", "element_id": 1, "new_name": "X"}],
            {"renamed": 3, "property_changed": 500, "deleted": 2, "total": 505},
        )
        # Stable order: renamed, property_changed, deleted, created, retyped.
        assert out == "3 renamed, 500 property changed, 2 deleted"

    def test_noop_single_op_uses_singular(self):
        # An earlier implementation said "1 op(s)"; the fix says "1 op".
        out = _default_summary(
            [{"op": "set_name", "element_id": 1, "new_name": "X"}],
            {"total": 0},
        )
        assert out == "1 op, no structural change"

    def test_noop_multi_op_uses_plural(self):
        out = _default_summary(
            [
                {"op": "set_name", "element_id": 1, "new_name": "X"},
                {"op": "set_name", "element_id": 2, "new_name": "Y"},
            ],
            {"total": 0},
        )
        assert out == "2 ops, no structural change"

    def test_execute_ifc_code_prefixes_with_script(self):
        out = _default_summary(
            [{"op": "execute_ifc_code", "code_chars": 300, "elapsed_ms": 150}],
            {"renamed": 1, "property_changed": 4, "total": 5},
        )
        assert out == "script: 1 renamed, 4 property changed"

    def test_execute_ifc_code_noop_is_distinct(self):
        out = _default_summary(
            [{"op": "execute_ifc_code", "code_chars": 100, "elapsed_ms": 10}],
            {"total": 0},
        )
        assert out == "script ran, no structural change"

    def test_large_batch_stays_single_bit(self):
        # 1000-element property churn - we still want one clean phrase, not
        # an enumeration of every affected element.
        out = _default_summary(
            [{"op": "execute_ifc_code", "code_chars": 9000, "elapsed_ms": 4000}],
            {"property_changed": 1000, "total": 1000},
        )
        assert out == "script: 1000 property changed"
