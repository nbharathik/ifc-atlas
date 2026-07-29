"""Tests for PatchGenerator - the IFC Atlas native engine patch builder.

All tests are pure (no IfcOpenShell / filesystem needed) - they operate on
in-memory PendingEditElement objects and verify the patch payloads produced.
"""

from __future__ import annotations


from app.models.ifc_models import PendingEditElement
from app.models.patch import (
    AttributeChanged,
    ElementAdded,
    ElementRemoved,
    PsetChanged,
)
from app.services.patch_generator import PatchGenerator


# ──────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────

_SHA = "abc123def456" * 4  # 48-char fake fingerprint


def _gen() -> PatchGenerator:
    """Fresh generator for each test - avoids seq-number cross-contamination."""
    return PatchGenerator()


def _make(
    express_id: int,
    change: str,
    ifc_type: str = "IfcWall",
    name_before: str | None = None,
    name_after: str | None = None,
    ifc_type_before: str | None = None,
    ifc_type_after: str | None = None,
    property_changes: list | None = None,
) -> PendingEditElement:
    return PendingEditElement(
        express_id=express_id,
        ifc_type=ifc_type,
        change=change,  # type: ignore[arg-type]
        name_before=name_before,
        name_after=name_after,
        ifc_type_before=ifc_type_before,
        ifc_type_after=ifc_type_after,
        property_changes=property_changes or [],
    )


# ──────────────────────────────────────────────────────────────────────
# Sequence number tests
# ──────────────────────────────────────────────────────────────────────


def test_seq_increments_per_patch():
    """Each patch in a batch gets a strictly increasing seq number."""
    gen = _gen()
    changes = [
        _make(1, "renamed", name_before="A", name_after="B"),
        _make(2, "renamed", name_before="C", name_after="D"),
    ]
    batch = gen.generate(changes, source_sha256=_SHA)
    seqs = [p.seq for p in batch.patches]
    assert seqs == sorted(seqs)
    assert len(set(seqs)) == len(seqs)


def test_seq_is_globally_monotonic_across_calls():
    """Two successive generate() calls produce non-overlapping seqs."""
    gen = _gen()
    b1 = gen.generate([_make(1, "renamed", name_before="X", name_after="Y")], source_sha256=_SHA)
    b2 = gen.generate([_make(2, "renamed", name_before="A", name_after="B")], source_sha256=_SHA)
    assert b2.patches[0].seq > b1.patches[-1].seq


# ──────────────────────────────────────────────────────────────────────
# Empty input
# ──────────────────────────────────────────────────────────────────────


def test_empty_changes_produces_empty_batch():
    batch = _gen().generate([], source_sha256=_SHA)
    assert batch.patches == []


# ──────────────────────────────────────────────────────────────────────
# Renamed
# ──────────────────────────────────────────────────────────────────────


def test_renamed_produces_attribute_changed():
    gen = _gen()
    changes = [_make(42, "renamed", name_before="OldWall", name_after="NewWall")]
    batch = gen.generate(changes, source_sha256=_SHA, actor="user")
    assert len(batch.patches) == 1
    patch = batch.patches[0]
    assert isinstance(patch, AttributeChanged)
    assert patch.express_id == 42
    assert patch.attribute == "Name"
    assert patch.old_value == "OldWall"
    assert patch.new_value == "NewWall"
    assert patch.actor == "user"
    assert patch.source_sha256 == _SHA


def test_renamed_no_name_change():
    """element change=renamed with identical names still produces a patch."""
    batch = _gen().generate(
        [_make(1, "renamed", name_before="Same", name_after="Same")],
        source_sha256=_SHA,
    )
    assert len(batch.patches) == 1
    assert isinstance(batch.patches[0], AttributeChanged)


# ──────────────────────────────────────────────────────────────────────
# Deleted
# ──────────────────────────────────────────────────────────────────────


def test_deleted_produces_element_removed():
    batch = _gen().generate(
        [_make(7, "deleted", ifc_type="IfcSlab")], source_sha256=_SHA
    )
    assert len(batch.patches) == 1
    patch = batch.patches[0]
    assert isinstance(patch, ElementRemoved)
    assert patch.express_id == 7
    assert patch.ifc_type == "IfcSlab"


# ──────────────────────────────────────────────────────────────────────
# Created
# ──────────────────────────────────────────────────────────────────────


def test_created_produces_element_added():
    batch = _gen().generate(
        [_make(99, "created", ifc_type="IfcDoor")], source_sha256=_SHA
    )
    assert len(batch.patches) == 1
    patch = batch.patches[0]
    assert isinstance(patch, ElementAdded)
    assert patch.express_id == 99
    assert patch.ifc_type == "IfcDoor"
    assert patch.frag_delta_url is None  # real fragment-delta payloads will fill this later


# ──────────────────────────────────────────────────────────────────────
# Retyped
# ──────────────────────────────────────────────────────────────────────


def test_retyped_produces_attribute_changed_ifc_type():
    changes = [
        _make(
            5,
            "retyped",
            ifc_type="IfcColumn",
            ifc_type_before="IfcBeam",
            ifc_type_after="IfcColumn",
            name_before="B1",
            name_after="B1",
        )
    ]
    batch = _gen().generate(changes, source_sha256=_SHA)
    assert len(batch.patches) == 1
    patch = batch.patches[0]
    assert isinstance(patch, AttributeChanged)
    assert patch.attribute == "ifc_type"
    assert patch.old_value == "IfcBeam"
    assert patch.new_value == "IfcColumn"


def test_retyped_with_name_change_emits_two_patches():
    changes = [
        _make(
            5,
            "retyped",
            ifc_type="IfcColumn",
            ifc_type_before="IfcBeam",
            ifc_type_after="IfcColumn",
            name_before="Beam1",
            name_after="Col1",
        )
    ]
    batch = _gen().generate(changes, source_sha256=_SHA)
    assert len(batch.patches) == 2
    kinds = {type(p).__name__ for p in batch.patches}
    assert kinds == {"AttributeChanged"}
    attrs = {p.attribute for p in batch.patches}  # type: ignore[union-attr]
    assert attrs == {"ifc_type", "Name"}


# ──────────────────────────────────────────────────────────────────────
# Property changed
# ──────────────────────────────────────────────────────────────────────


def test_property_changed_groups_by_pset():
    changes = [
        _make(
            10,
            "property_changed",
            name_before="Wall A",
            name_after="Wall A",
            property_changes=[
                {"property_set": "Pset_WallCommon", "property_name": "IsExternal", "before": False, "after": True},
                {"property_set": "Pset_WallCommon", "property_name": "ThermalTransmittance", "before": 1.0, "after": 0.8},
                {"property_set": "Custom", "property_name": "Owner", "before": "Alice", "after": "Bob"},
            ],
        )
    ]
    batch = _gen().generate(changes, source_sha256=_SHA)
    # Two PsetChanged: one per pset
    assert len(batch.patches) == 2
    pset_patches = [p for p in batch.patches if isinstance(p, PsetChanged)]
    assert len(pset_patches) == 2
    pset_names = {p.pset_name for p in pset_patches}
    assert pset_names == {"Pset_WallCommon", "Custom"}
    common = next(p for p in pset_patches if p.pset_name == "Pset_WallCommon")
    assert common.changes == {"IsExternal": True, "ThermalTransmittance": 0.8}
    custom = next(p for p in pset_patches if p.pset_name == "Custom")
    assert custom.changes == {"Owner": "Bob"}


def test_property_changed_also_emits_name_change():
    """When property_changed element also has a name change, Name patch first."""
    changes = [
        _make(
            11,
            "property_changed",
            name_before="Old",
            name_after="New",
            property_changes=[
                {"property_set": "Pset_A", "property_name": "Height", "before": 2.4, "after": 3.0},
            ],
        )
    ]
    batch = _gen().generate(changes, source_sha256=_SHA)
    assert len(batch.patches) == 2
    attr_patches = [p for p in batch.patches if isinstance(p, AttributeChanged)]
    assert len(attr_patches) == 1
    assert attr_patches[0].attribute == "Name"
    pset_patches = [p for p in batch.patches if isinstance(p, PsetChanged)]
    assert len(pset_patches) == 1


def test_pset_binding_sentinel_skipped():
    """The '<pset binding>' sentinel should not appear as a property patch."""
    changes = [
        _make(
            20,
            "property_changed",
            name_before="X",
            name_after="X",
            property_changes=[
                {"property_set": "Pset_A", "property_name": "<pset binding>", "before": None, "after": "attached"},
            ],
        )
    ]
    batch = _gen().generate(changes, source_sha256=_SHA)
    # Sentinel-only pset bucket produces no PsetChanged (empty changes dict)
    assert all(
        "<pset binding>" not in (getattr(p, "changes", {}))
        for p in batch.patches
    )


def test_property_changed_no_properties_no_name_change():
    """Edge-case: property_changed with zero usable property diffs."""
    changes = [
        _make(
            21,
            "property_changed",
            name_before="X",
            name_after="X",
            property_changes=[],
        )
    ]
    batch = _gen().generate(changes, source_sha256=_SHA)
    assert batch.patches == []


# ──────────────────────────────────────────────────────────────────────
# Common fields
# ──────────────────────────────────────────────────────────────────────


def test_common_fields_are_propagated():
    gen = _gen()
    batch = gen.generate(
        [_make(1, "deleted", ifc_type="IfcWall")],
        source_sha256=_SHA,
        actor="system",
        agent_id="default",
    )
    patch = batch.patches[0]
    assert patch.source_sha256 == _SHA
    assert patch.actor == "system"
    assert patch.agent_id == "default"
    assert patch.timestamp_ms > 0


def test_mixed_batch():
    """Multiple different change types produce the right patch mix."""
    changes = [
        _make(1, "renamed", name_before="A", name_after="B"),
        _make(2, "deleted", ifc_type="IfcSlab"),
        _make(3, "created", ifc_type="IfcBeam"),
        _make(
            4,
            "property_changed",
            name_before="W",
            name_after="W",
            property_changes=[
                {"property_set": "P", "property_name": "Foo", "before": 1, "after": 2},
            ],
        ),
    ]
    batch = _gen().generate(changes, source_sha256=_SHA)
    types = [type(p).__name__ for p in batch.patches]
    assert "AttributeChanged" in types
    assert "ElementRemoved" in types
    assert "ElementAdded" in types
    assert "PsetChanged" in types


# ──────────────────────────────────────────────────────────────────────
# Additional edge-case + robustness tests
# ──────────────────────────────────────────────────────────────────────


def test_agent_id_defaults_to_none():
    """agent_id defaults to None when not supplied."""
    batch = _gen().generate(
        [_make(1, "deleted")],
        source_sha256=_SHA,
    )
    assert batch.patches[0].agent_id is None


def test_actor_defaults_to_agent():
    """actor defaults to 'agent' when not explicitly supplied."""
    batch = _gen().generate(
        [_make(1, "deleted")],
        source_sha256=_SHA,
    )
    assert batch.patches[0].actor == "agent"


def test_source_sha256_propagates_to_all_patch_types():
    """source_sha256 is set correctly on every patch kind."""
    sha = "deadbeef" * 6
    changes = [
        _make(1, "renamed", name_before="A", name_after="B"),
        _make(2, "deleted"),
        _make(3, "created"),
        _make(
            4,
            "retyped",
            ifc_type_before="IfcWall",
            ifc_type_after="IfcSlab",
            name_before="X",
            name_after="X",
        ),
        _make(
            5,
            "property_changed",
            name_before="Y",
            name_after="Y",
            property_changes=[{"property_set": "P", "property_name": "H", "before": 1, "after": 2}],
        ),
    ]
    batch = _gen().generate(changes, source_sha256=sha)
    for p in batch.patches:
        assert p.source_sha256 == sha


def test_pset_only_sentinel_emits_no_pset_patch():
    """When the only property in a pset is the binding sentinel, no PsetChanged is emitted."""
    changes = [
        _make(
            30,
            "property_changed",
            name_before="Z",
            name_after="Z",
            property_changes=[
                {"property_set": "Pset_A", "property_name": "<pset binding>", "before": None, "after": "attached"},
                {"property_set": "Pset_B", "property_name": "Width", "before": 0.1, "after": 0.2},
            ],
        )
    ]
    batch = _gen().generate(changes, source_sha256=_SHA)
    # Only Pset_B should appear - Pset_A had only the sentinel
    pset_patches = [p for p in batch.patches if isinstance(p, PsetChanged)]
    assert len(pset_patches) == 1
    assert pset_patches[0].pset_name == "Pset_B"


def test_timestamp_ms_is_recent():
    """Timestamps produced are within a 10-second window of now."""
    import time
    before_ms = int(time.time() * 1000)
    batch = _gen().generate([_make(1, "deleted")], source_sha256=_SHA)
    after_ms = int(time.time() * 1000)
    ts = batch.patches[0].timestamp_ms
    assert before_ms <= ts <= after_ms + 100


def test_seq_starts_at_one():
    """The first patch produced by a fresh generator has seq=1."""
    batch = _gen().generate([_make(1, "deleted")], source_sha256=_SHA)
    assert batch.patches[0].seq == 1


def test_concurrent_seq_uniqueness():
    """Patches generated from two threads in parallel get unique seq numbers."""
    import threading

    gen = PatchGenerator()
    results: list[int] = []
    lock = threading.Lock()

    def worker():
        b = gen.generate([_make(1, "deleted"), _make(2, "deleted")], source_sha256=_SHA)
        with lock:
            results.extend(p.seq for p in b.patches)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(results) == 16
    assert len(set(results)) == 16, "seq numbers must be unique across threads"
