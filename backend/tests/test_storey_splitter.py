"""Tests for StoreyFragmentSplitter - per-storey element-ID manifest.

All tests are pure (no IfcOpenShell file I/O): IFC model objects are
constructed with MagicMock so the suite runs on any platform.
"""

from unittest.mock import MagicMock, patch
import pytest

from app.services.storey_splitter import StoreyFragmentSplitter, StoreyInfo, StoreyManifest


# ──────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────

def _make_element(eid: int, children: list[int] | None = None):
    """Return a mock element with a given express ID and optional decomposed children."""
    el = MagicMock()
    el.id.return_value = eid
    if children:
        child_mocks = [_make_element(cid) for cid in children]
        rel = MagicMock()
        rel.RelatedObjects = child_mocks
        el.IsDecomposedBy = [rel]
    else:
        el.IsDecomposedBy = []
    return el


def _make_storey(name: str, elevation: float, element_ids: list[int]):
    """Return a mock IfcBuildingStorey with ContainsElements."""
    storey = MagicMock()
    storey.Name = name
    storey.Elevation = elevation

    elements = [_make_element(eid) for eid in element_ids]
    rel = MagicMock()
    rel.RelatedElements = elements
    storey.ContainsElements = [rel]
    return storey


def _make_model(storeys: list[object]):
    model = MagicMock()
    model.by_type.return_value = storeys
    return model


# ──────────────────────────────────────────────────────────────────────
# StoreyInfo + StoreyManifest dataclasses
# ──────────────────────────────────────────────────────────────────────

def test_storey_info_defaults():
    s = StoreyInfo(idx=0, name="GF", element_ids=[1, 2], element_count=2)
    assert s.elevation == 0.0
    assert s.element_count == 2


def test_storey_manifest_total_elements():
    m = StoreyManifest(
        source_sha256="abc",
        storeys=[
            StoreyInfo(idx=0, name="GF", element_ids=[1, 2, 3], element_count=3),
            StoreyInfo(idx=1, name="FF", element_ids=[4, 5], element_count=2),
        ],
    )
    assert m.total_elements == 5


def test_storey_manifest_empty():
    m = StoreyManifest(source_sha256="xyz")
    assert m.total_elements == 0
    assert m.storeys == []


# ──────────────────────────────────────────────────────────────────────
# StoreyFragmentSplitter.get_manifest
# ──────────────────────────────────────────────────────────────────────

def test_single_storey_basic():
    spl = StoreyFragmentSplitter()
    model = _make_model([_make_storey("Ground", 0.0, [10, 20, 30])])
    manifest = spl.get_manifest(model, "sha1")

    assert len(manifest.storeys) == 1
    s = manifest.storeys[0]
    assert s.name == "Ground"
    assert s.element_count == 3
    assert sorted(s.element_ids) == [10, 20, 30]


def test_two_storey_sorted_by_elevation():
    """Storeys should be ordered by elevation (ascending)."""
    spl = StoreyFragmentSplitter()
    first = _make_storey("First", 3000.0, [40, 50])
    ground = _make_storey("Ground", 0.0, [10, 20, 30])
    # Feed in reverse order to confirm sorting.
    model = _make_model([first, ground])
    manifest = spl.get_manifest(model, "sha2")

    assert manifest.storeys[0].name == "Ground"
    assert manifest.storeys[0].idx == 0
    assert manifest.storeys[1].name == "First"
    assert manifest.storeys[1].idx == 1


def test_element_ids_are_sorted():
    spl = StoreyFragmentSplitter()
    model = _make_model([_make_storey("GF", 0.0, [30, 10, 20])])
    manifest = spl.get_manifest(model, "sha3")
    assert manifest.storeys[0].element_ids == [10, 20, 30]


def test_decomposed_elements_collected():
    """IsDecomposedBy children should be included in element_ids."""
    spl = StoreyFragmentSplitter()
    wall = _make_element(100, children=[201, 202])
    slab = _make_element(110)

    rel = MagicMock()
    rel.RelatedElements = [wall, slab]
    storey = MagicMock()
    storey.Name = "GF"
    storey.Elevation = 0.0
    storey.ContainsElements = [rel]

    model = _make_model([storey])
    manifest = spl.get_manifest(model, "sha4")
    ids = manifest.storeys[0].element_ids
    assert 100 in ids
    assert 201 in ids
    assert 202 in ids
    assert 110 in ids


def test_empty_storey_zero_elements():
    spl = StoreyFragmentSplitter()
    storey = MagicMock()
    storey.Name = "Roof"
    storey.Elevation = 9000.0
    storey.ContainsElements = []

    model = _make_model([storey])
    manifest = spl.get_manifest(model, "sha5")
    assert manifest.storeys[0].element_count == 0
    assert manifest.storeys[0].element_ids == []


def test_no_storeys_returns_empty_manifest():
    spl = StoreyFragmentSplitter()
    model = _make_model([])
    manifest = spl.get_manifest(model, "sha6")
    assert manifest.storeys == []
    assert manifest.total_elements == 0


def test_storey_name_fallback_when_none():
    spl = StoreyFragmentSplitter()
    storey = MagicMock()
    storey.Name = None
    storey.Elevation = 0.0
    storey.ContainsElements = []
    model = _make_model([storey])
    manifest = spl.get_manifest(model, "sha7")
    assert "Storey" in manifest.storeys[0].name


def test_elevation_fallback_when_none():
    """None Elevation should default to 0.0 without error."""
    spl = StoreyFragmentSplitter()
    s1 = _make_storey("A", None, [1])  # type: ignore[arg-type]
    s2 = _make_storey("B", 500.0, [2])
    model = _make_model([s1, s2])
    manifest = spl.get_manifest(model, "sha8")
    # Both are processed; no exception raised
    assert len(manifest.storeys) == 2


def test_elevation_fallback_invalid_type():
    """Non-numeric Elevation should not crash."""
    spl = StoreyFragmentSplitter()
    storey = MagicMock()
    storey.Name = "Weird"
    storey.Elevation = "not-a-number"
    storey.ContainsElements = []
    model = _make_model([storey])
    manifest = spl.get_manifest(model, "sha9")
    assert manifest.storeys[0].elevation == 0.0


# ──────────────────────────────────────────────────────────────────────
# Caching behaviour
# ──────────────────────────────────────────────────────────────────────

def test_cache_hit_does_not_recompute():
    spl = StoreyFragmentSplitter()
    model = _make_model([_make_storey("GF", 0.0, [1, 2, 3])])
    m1 = spl.get_manifest(model, "sha-cache")
    # Second call: replace model with empty (would return wrong data if re-computed).
    model2 = _make_model([])
    m2 = spl.get_manifest(model2, "sha-cache")
    assert m1 is m2


def test_different_sha_computes_separately():
    spl = StoreyFragmentSplitter()
    m1 = spl.get_manifest(_make_model([_make_storey("GF", 0.0, [1])]), "sha-A")
    m2 = spl.get_manifest(_make_model([_make_storey("FF", 5.0, [2])]), "sha-B")
    assert m1.storeys[0].name == "GF"
    assert m2.storeys[0].name == "FF"


def test_clear_cache_specific_sha():
    spl = StoreyFragmentSplitter()
    spl.get_manifest(_make_model([_make_storey("GF", 0.0, [1])]), "sha-X")
    assert spl.cache_size() == 1
    spl.clear_cache("sha-X")
    assert spl.cache_size() == 0


def test_clear_cache_all():
    spl = StoreyFragmentSplitter()
    spl.get_manifest(_make_model([_make_storey("GF", 0.0, [1])]), "sha-P")
    spl.get_manifest(_make_model([_make_storey("FF", 3.0, [2])]), "sha-Q")
    assert spl.cache_size() == 2
    spl.clear_cache()
    assert spl.cache_size() == 0


def test_empty_sha_not_cached():
    """Empty string SHA should not pollute the cache."""
    spl = StoreyFragmentSplitter()
    spl.get_manifest(_make_model([_make_storey("GF", 0.0, [1])]), "")
    assert spl.cache_size() == 0


def test_source_sha256_in_manifest():
    spl = StoreyFragmentSplitter()
    model = _make_model([_make_storey("GF", 0.0, [1])])
    manifest = spl.get_manifest(model, "deadbeef")
    assert manifest.source_sha256 == "deadbeef"
