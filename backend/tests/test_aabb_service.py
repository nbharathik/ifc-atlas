"""Tests for `aabb_service`.

Strategy mirrors `test_spatial_tile_splitter.py`: every IfcOpenShell call site
is replaced by a monkeypatch on the module-level helper
`_compute_aabbs_via_ifcopenshell`. Disk persistence is verified by routing
`DATA_DIR` to a `tmp_path` via a fixture - the on-disk JSON layout is plain,
no IfcOpenShell needed.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from app.services import aabb_service as aabb_mod
from app.services.aabb_service import (
    AABBService,
    AABBTuple,
    _aabb_from_verts,
    _atomic_write_json,
    _deserialize_cache,
    _serialize_cache,
)


# ── Pure-helper tests ────────────────────────────────────────────────────────


def test_aabb_from_verts_basic_box():
    """Standard cube → min and max are the extents along each axis."""
    verts = [
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        0.0, 2.0, 0.0,
        0.0, 0.0, 3.0,
        1.0, 2.0, 3.0,
    ]
    assert _aabb_from_verts(verts) == ((0.0, 0.0, 0.0), (1.0, 2.0, 3.0))


def test_aabb_from_verts_negative_coords():
    """Negative coordinates work (no implicit clamping at zero)."""
    verts = [-5.0, -10.0, -1.0, 5.0, 10.0, 1.0]
    assert _aabb_from_verts(verts) == ((-5.0, -10.0, -1.0), (5.0, 10.0, 1.0))


def test_aabb_from_verts_empty_returns_none():
    assert _aabb_from_verts([]) is None


def test_aabb_from_verts_single_point():
    """One vertex collapses to a degenerate point AABB."""
    assert _aabb_from_verts([1.0, 2.0, 3.0]) == ((1.0, 2.0, 3.0), (1.0, 2.0, 3.0))


def test_aabb_from_verts_truncates_partial_triplet():
    """Trailing partial triplets are dropped, the rest still parses."""
    verts = [0.0, 0.0, 0.0, 1.0, 1.0]  # 5 floats - one full triplet
    assert _aabb_from_verts(verts) == ((0.0, 0.0, 0.0), (0.0, 0.0, 0.0))


def test_aabb_from_verts_handles_floats_passed_as_strings():
    """Defensive: caller might pass numpy.float64; float() should coerce."""
    verts = ["1.5", "2.5", "3.5"]
    assert _aabb_from_verts(verts) == ((1.5, 2.5, 3.5), (1.5, 2.5, 3.5))


# ── Serialise / deserialise round-trip ───────────────────────────────────────


def test_serialize_deserialize_roundtrip():
    aabbs: dict[int, AABBTuple] = {
        1: ((0.0, 0.0, 0.0), (1.0, 1.0, 1.0)),
        42: ((-5.0, -5.0, -5.0), (5.0, 5.0, 5.0)),
    }
    payload = _serialize_cache("deadbeef", aabbs, total_ms=1234.5)

    # Round-trip through JSON to assert it's serialisable.
    blob = json.loads(json.dumps(payload))
    decoded = _deserialize_cache(blob)
    assert decoded == aabbs


def test_deserialize_rejects_unknown_schema():
    """Old schema → empty dict so service falls back to recompute."""
    blob = {"schema": 999, "aabbs": {"1": [[0, 0, 0], [1, 1, 1]]}}
    assert _deserialize_cache(blob) == {}


def test_deserialize_skips_malformed_entries():
    blob = {
        "schema": aabb_mod.SCHEMA_VERSION,
        "aabbs": {
            "1": [[0, 0, 0], [1, 1, 1]],   # valid
            "two": [[0, 0, 0], [1, 1, 1]],  # non-int key → skipped
            "3": "garbage",                 # malformed value → skipped
            "4": [[0, 0]],                  # incomplete → skipped
        },
    }
    decoded = _deserialize_cache(blob)
    assert decoded == {1: ((0.0, 0.0, 0.0), (1.0, 1.0, 1.0))}


def test_deserialize_handles_non_dict():
    assert _deserialize_cache([]) == {}  # type: ignore[arg-type]
    assert _deserialize_cache(None) == {}  # type: ignore[arg-type]


# ── Atomic write ─────────────────────────────────────────────────────────────


def test_atomic_write_creates_file(tmp_path: Path):
    target = tmp_path / "x.json"
    _atomic_write_json(target, {"a": 1})
    assert json.loads(target.read_text()) == {"a": 1}


def test_atomic_write_overwrites_atomically(tmp_path: Path):
    target = tmp_path / "x.json"
    _atomic_write_json(target, {"v": 1})
    _atomic_write_json(target, {"v": 2})
    assert json.loads(target.read_text()) == {"v": 2}


def test_atomic_write_creates_parent_dir(tmp_path: Path):
    nested = tmp_path / "a" / "b" / "x.json"
    _atomic_write_json(nested, {"ok": True})
    assert nested.exists()


# ── Service: in-memory cache ─────────────────────────────────────────────────


@pytest.fixture
def isolated_cache(tmp_path: Path, monkeypatch):
    """Point AABB_CACHE_DIR at a tmp dir per test → no cross-test bleed."""
    monkeypatch.setattr(aabb_mod, "AABB_CACHE_DIR", tmp_path / "aabb-cache")
    return tmp_path / "aabb-cache"


def _fake_ifc(aabbs: dict[int, AABBTuple]):
    """Return a fake `_compute_aabbs_via_ifcopenshell` that yields `aabbs`."""
    return lambda model: dict(aabbs)


def test_compute_sync_populates_memory_and_disk(isolated_cache, monkeypatch):
    aabbs = {1: ((0.0, 0.0, 0.0), (1.0, 1.0, 1.0))}
    monkeypatch.setattr(aabb_mod, "_compute_aabbs_via_ifcopenshell", _fake_ifc(aabbs))

    svc = AABBService()
    out = svc.compute_sync(MagicMock(), "sha1")

    assert out == aabbs
    assert svc.get_aabb("sha1", 1) == aabbs[1]
    # Disk cache file was created.
    assert (isolated_cache / "sha1.json").exists()


def test_compute_sync_disk_hit_skips_recompute(isolated_cache, monkeypatch):
    """Second compute_sync with the same SHA reads disk, never re-invokes IfcOpenShell."""
    aabbs = {1: ((0.0, 0.0, 0.0), (1.0, 1.0, 1.0))}
    monkeypatch.setattr(aabb_mod, "_compute_aabbs_via_ifcopenshell", _fake_ifc(aabbs))

    svc1 = AABBService()
    svc1.compute_sync(MagicMock(), "sha2")

    # Swap the helper out for one that would crash - proves we don't call it.
    def boom(model):
        raise RuntimeError("should not run")

    monkeypatch.setattr(aabb_mod, "_compute_aabbs_via_ifcopenshell", boom)

    svc2 = AABBService()  # fresh memory → forces disk path
    out = svc2.compute_sync(MagicMock(), "sha2")
    assert out == aabbs


def test_compute_sync_failure_surfaces_in_status(isolated_cache, monkeypatch):
    def boom(model):
        raise RuntimeError("ifc parse exploded")

    monkeypatch.setattr(aabb_mod, "_compute_aabbs_via_ifcopenshell", boom)

    svc = AABBService()
    out = svc.compute_sync(MagicMock(), "sha3")
    assert out == {}
    st = svc.status("sha3")
    assert st.state == "failed"
    assert "ifc parse exploded" in (st.error or "")


def test_get_aabb_returns_none_when_missing(isolated_cache):
    svc = AABBService()
    assert svc.get_aabb("never-uploaded", 99) is None


def test_get_aabbs_bulk_filters_missing(isolated_cache, monkeypatch):
    aabbs = {1: ((0, 0, 0), (1, 1, 1)), 2: ((2, 2, 2), (3, 3, 3))}
    monkeypatch.setattr(aabb_mod, "_compute_aabbs_via_ifcopenshell", _fake_ifc(aabbs))

    svc = AABBService()
    svc.compute_sync(MagicMock(), "sha4")

    got = svc.get_aabbs_bulk("sha4", [1, 2, 99, 100])
    assert set(got.keys()) == {1, 2}


def test_get_aabbs_bulk_ignores_non_int_inputs(isolated_cache, monkeypatch):
    """Defensive: pass strings + None alongside valid ints."""
    aabbs = {7: ((0, 0, 0), (1, 1, 1))}
    monkeypatch.setattr(aabb_mod, "_compute_aabbs_via_ifcopenshell", _fake_ifc(aabbs))

    svc = AABBService()
    svc.compute_sync(MagicMock(), "sha5")

    # mix int + string-int + garbage
    got = svc.get_aabbs_bulk("sha5", [7, "7", None, "abc", 3.14])
    # 7 and "7" both resolve to 7; garbage skipped silently.
    assert 7 in got


# ── Service: status reporting ────────────────────────────────────────────────


def test_status_idle_on_unknown_sha(isolated_cache):
    svc = AABBService()
    st = svc.status("missing-sha")
    assert st.state == "idle"
    assert st.count == 0


def test_status_ready_after_compute(isolated_cache, monkeypatch):
    aabbs = {i: ((0, 0, 0), (1, 1, 1)) for i in range(5)}
    monkeypatch.setattr(aabb_mod, "_compute_aabbs_via_ifcopenshell", _fake_ifc(aabbs))

    svc = AABBService()
    svc.compute_sync(MagicMock(), "shaR")
    st = svc.status("shaR")
    assert st.state == "ready"
    assert st.count == 5


def test_status_ready_after_disk_only_hydrate(isolated_cache, monkeypatch):
    """Disk cache + fresh service → status('ready') without an explicit compute."""
    # Seed disk directly.
    aabbs = {3: ((0, 0, 0), (1, 1, 1))}
    isolated_cache.mkdir(parents=True, exist_ok=True)
    (isolated_cache / "shaD.json").write_text(
        json.dumps(_serialize_cache("shaD", aabbs, 0.0))
    )

    svc = AABBService()
    # Touching get_aabb triggers the lazy disk hydrate.
    assert svc.get_aabb("shaD", 3) == aabbs[3]
    st = svc.status("shaD")
    assert st.state == "ready"
    assert st.count == 1


# ── Service: clearing ────────────────────────────────────────────────────────


def test_clear_one_sha_leaves_others(isolated_cache, monkeypatch):
    aabbs = {1: ((0, 0, 0), (1, 1, 1))}
    monkeypatch.setattr(aabb_mod, "_compute_aabbs_via_ifcopenshell", _fake_ifc(aabbs))

    svc = AABBService()
    svc.compute_sync(MagicMock(), "shaA")
    svc.compute_sync(MagicMock(), "shaB")
    assert svc.cache_size_memory() == 2

    svc.clear("shaA")
    assert svc.cache_size_memory() == 1


def test_clear_all_wipes_memory(isolated_cache, monkeypatch):
    aabbs = {1: ((0, 0, 0), (1, 1, 1))}
    monkeypatch.setattr(aabb_mod, "_compute_aabbs_via_ifcopenshell", _fake_ifc(aabbs))

    svc = AABBService()
    svc.compute_sync(MagicMock(), "shaA")
    svc.compute_sync(MagicMock(), "shaB")
    svc.clear()
    assert svc.cache_size_memory() == 0


def test_clear_disk_removes_files(isolated_cache, monkeypatch):
    aabbs = {1: ((0, 0, 0), (1, 1, 1))}
    monkeypatch.setattr(aabb_mod, "_compute_aabbs_via_ifcopenshell", _fake_ifc(aabbs))

    svc = AABBService()
    svc.compute_sync(MagicMock(), "shaA")
    svc.compute_sync(MagicMock(), "shaB")

    removed = svc.clear_disk()  # all
    assert removed == 2
    assert not any(isolated_cache.glob("*.json"))


def test_clear_disk_one_sha(isolated_cache, monkeypatch):
    aabbs = {1: ((0, 0, 0), (1, 1, 1))}
    monkeypatch.setattr(aabb_mod, "_compute_aabbs_via_ifcopenshell", _fake_ifc(aabbs))

    svc = AABBService()
    svc.compute_sync(MagicMock(), "shaA")
    svc.compute_sync(MagicMock(), "shaB")

    assert svc.clear_disk("shaA") == 1
    assert (isolated_cache / "shaB.json").exists()
    assert not (isolated_cache / "shaA.json").exists()


# ── Service: empty SHA bypasses cache (test convenience) ─────────────────────


def test_empty_sha_bypasses_cache(isolated_cache, monkeypatch):
    """An empty SHA opt-out: compute runs, results returned, nothing persisted."""
    aabbs = {1: ((0, 0, 0), (1, 1, 1))}
    monkeypatch.setattr(aabb_mod, "_compute_aabbs_via_ifcopenshell", _fake_ifc(aabbs))

    svc = AABBService()
    out = svc.compute_sync(MagicMock(), "")
    assert out == aabbs
    assert svc.cache_size_memory() == 0  # no SHA → no memory entry
    assert not any(isolated_cache.glob("*.json"))


# ── Compute_async wraps compute_sync via to_thread ───────────────────────────


@pytest.mark.asyncio
async def test_compute_async_returns_same_as_sync(isolated_cache, monkeypatch):
    aabbs = {1: ((0, 0, 0), (1, 1, 1))}
    monkeypatch.setattr(aabb_mod, "_compute_aabbs_via_ifcopenshell", _fake_ifc(aabbs))

    svc = AABBService()
    out = await svc.compute_async(MagicMock(), "shaAsync")
    assert out == aabbs
    # And the SHA is now warm in memory + on disk.
    assert svc.get_aabb("shaAsync", 1) == aabbs[1]
    assert (isolated_cache / "shaAsync.json").exists()
