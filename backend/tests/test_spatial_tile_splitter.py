"""Tests for SpatialTileSplitter.

All tests are pure (no IfcOpenShell file I/O): partition logic is exercised
with synthetic ElementAABB lists, and the extraction wrapper is exercised
with MagicMock IFC model objects. Safe on Windows / Python 3.13.
"""

from unittest.mock import MagicMock

import pytest

from app.services.spatial_tile_splitter import (
    ElementAABB,
    SpatialTileSplitter,
    TileInfo,
    TileManifest,
    _cell_index,
    _placement_point,
    compute_world_aabb,
    extract_element_aabbs,
    extract_element_aabbs_from_cache,
    partition_by_grid,
)


# ── Pure helpers ────────────────────────────────────────────────────────────


def test_cell_index_clamps_to_grid():
    """_cell_index never returns out-of-range indices."""
    assert _cell_index(0.0, 0.0, 10.0, 4) == 0
    assert _cell_index(2.4, 0.0, 10.0, 4) == 0
    assert _cell_index(2.5, 0.0, 10.0, 4) == 1
    assert _cell_index(10.0, 0.0, 10.0, 4) == 3  # max clamped to grid-1
    assert _cell_index(-5.0, 0.0, 10.0, 4) == 0  # negative clamped to 0


def test_cell_index_zero_size_returns_zero():
    """Degenerate axis (size=0) always returns cell 0."""
    assert _cell_index(5.0, 0.0, 0.0, 4) == 0
    assert _cell_index(-5.0, 0.0, 0.0, 4) == 0


def test_compute_world_aabb_empty():
    assert compute_world_aabb([]) == ((0.0, 0.0, 0.0), (0.0, 0.0, 0.0))


def test_compute_world_aabb_single_element():
    el = ElementAABB(element_id=1, aabb_min=(1.0, 2.0, 3.0), aabb_max=(4.0, 5.0, 6.0))
    assert compute_world_aabb([el]) == ((1.0, 2.0, 3.0), (4.0, 5.0, 6.0))


def test_compute_world_aabb_multiple_elements():
    elements = [
        ElementAABB(element_id=1, aabb_min=(0.0, 0.0, 0.0), aabb_max=(2.0, 2.0, 2.0)),
        ElementAABB(element_id=2, aabb_min=(-1.0, 5.0, 1.0), aabb_max=(3.0, 8.0, 4.0)),
    ]
    assert compute_world_aabb(elements) == ((-1.0, 0.0, 0.0), (3.0, 8.0, 4.0))


# ── partition_by_grid ───────────────────────────────────────────────────────


def test_partition_empty_input():
    manifest = partition_by_grid([], grid_resolution=2)
    assert manifest.tiles == []
    assert manifest.total_elements == 0
    assert manifest.total_tiles == 0
    assert manifest.world_aabb_min == (0.0, 0.0, 0.0)


def test_partition_rejects_invalid_grid():
    with pytest.raises(ValueError):
        partition_by_grid([], grid_resolution=0)
    with pytest.raises(ValueError):
        partition_by_grid([], grid_resolution=-1)


def test_partition_single_point_element():
    el = ElementAABB(element_id=42, aabb_min=(5.0, 5.0, 0.0), aabb_max=(5.0, 5.0, 0.0))
    manifest = partition_by_grid([el], grid_resolution=2)
    assert manifest.total_tiles == 1
    assert manifest.total_elements == 1
    assert manifest.tiles[0].element_ids == [42]


def test_partition_grid_resolution_1_collapses_to_one_tile():
    """grid=1 means everything in one bucket."""
    elements = [
        ElementAABB(element_id=i, aabb_min=(float(i), 0.0, 0.0), aabb_max=(float(i), 0.0, 0.0))
        for i in range(5)
    ]
    manifest = partition_by_grid(elements, grid_resolution=1)
    assert manifest.total_tiles == 1
    assert sorted(manifest.tiles[0].element_ids) == [0, 1, 2, 3, 4]


def test_partition_splits_two_distant_elements():
    """Two elements at opposite corners of the world AABB land in different cells."""
    elements = [
        ElementAABB(element_id=1, aabb_min=(0.0, 0.0, 0.0), aabb_max=(0.0, 0.0, 0.0)),
        ElementAABB(element_id=2, aabb_min=(10.0, 10.0, 0.0), aabb_max=(10.0, 10.0, 0.0)),
    ]
    manifest = partition_by_grid(elements, grid_resolution=2)
    assert manifest.total_tiles == 2
    tile_ids = sorted(t.tile_id for t in manifest.tiles)
    # Element 1 at min corner → cell (0,0); element 2 at max corner clamped to (1,1).
    assert tile_ids == ["0-0-0", "0-1-1"]


def test_partition_storey_assignment_separates_tiles():
    """Same XY but different storey_idx → different tiles."""
    elements = [
        ElementAABB(
            element_id=1, aabb_min=(0.0, 0.0, 0.0), aabb_max=(0.0, 0.0, 0.0), storey_idx=0
        ),
        ElementAABB(
            element_id=2, aabb_min=(0.0, 0.0, 3.0), aabb_max=(0.0, 0.0, 3.0), storey_idx=1
        ),
    ]
    manifest = partition_by_grid(elements, grid_resolution=2)
    assert manifest.total_tiles == 2
    tile_ids = sorted(t.tile_id for t in manifest.tiles)
    assert tile_ids == ["0-0-0", "1-0-0"]


def test_partition_tile_aabbs_are_local_to_bucket():
    """A tile's AABB covers only the elements in that tile, not the whole world."""
    elements = [
        ElementAABB(element_id=1, aabb_min=(1.0, 1.0, 0.0), aabb_max=(2.0, 2.0, 0.0)),
        ElementAABB(element_id=2, aabb_min=(9.0, 9.0, 0.0), aabb_max=(10.0, 10.0, 0.0)),
    ]
    manifest = partition_by_grid(elements, grid_resolution=2)
    by_id = {t.tile_id: t for t in manifest.tiles}
    assert by_id["0-0-0"].aabb_min == (1.0, 1.0, 0.0)
    assert by_id["0-0-0"].aabb_max == (2.0, 2.0, 0.0)
    assert by_id["0-1-1"].aabb_min == (9.0, 9.0, 0.0)
    assert by_id["0-1-1"].aabb_max == (10.0, 10.0, 0.0)


def test_partition_records_sha_on_manifest():
    manifest = partition_by_grid([], grid_resolution=2, source_sha256="abc123")
    assert manifest.source_sha256 == "abc123"
    assert manifest.grid_resolution == 2


def test_partition_element_ids_sorted_within_tile():
    """Within a single tile, element_ids should be returned sorted ascending."""
    elements = [
        ElementAABB(element_id=eid, aabb_min=(0.0, 0.0, 0.0), aabb_max=(0.0, 0.0, 0.0))
        for eid in [42, 7, 19, 3, 100]
    ]
    manifest = partition_by_grid(elements, grid_resolution=1)
    assert manifest.tiles[0].element_ids == [3, 7, 19, 42, 100]


# ── _placement_point extractor (best-effort heuristic) ──────────────────────


def test_placement_point_reads_relative_placement_location():
    el = MagicMock()
    el.ObjectPlacement.RelativePlacement.Location.Coordinates = (1.5, 2.5, 3.5)
    assert _placement_point(el) == (1.5, 2.5, 3.5)


def test_placement_point_returns_none_when_placement_missing():
    el = MagicMock()
    el.ObjectPlacement = None
    assert _placement_point(el) is None


def test_placement_point_returns_none_on_short_coords():
    el = MagicMock()
    el.ObjectPlacement.RelativePlacement.Location.Coordinates = (1.0, 2.0)  # 2-tuple
    assert _placement_point(el) is None


def test_placement_point_returns_none_on_malformed():
    el = MagicMock()
    # AttributeError path: missing Coordinates attr.
    type(el.ObjectPlacement.RelativePlacement.Location).Coordinates = property(
        lambda self: (_ for _ in ()).throw(AttributeError("no coords"))
    )
    assert _placement_point(el) is None


# ── extract_element_aabbs wrapper ───────────────────────────────────────────


def _mock_element(eid: int, coords: tuple[float, float, float] | None):
    """Build a mock IfcElement with optional placement coords."""
    el = MagicMock()
    el.id.return_value = eid
    if coords is None:
        el.ObjectPlacement = None
    else:
        el.ObjectPlacement.RelativePlacement.Location.Coordinates = coords
    return el


def test_extract_element_aabbs_skips_placement_less_elements():
    model = MagicMock()
    model.by_type.return_value = [
        _mock_element(1, (0.0, 0.0, 0.0)),
        _mock_element(2, None),
        _mock_element(3, (5.0, 5.0, 0.0)),
    ]
    manifest = MagicMock()
    manifest.storeys = []
    out = extract_element_aabbs(model, manifest)
    eids = sorted(a.element_id for a in out)
    assert eids == [1, 3]


def test_extract_element_aabbs_assigns_storey_from_manifest():
    model = MagicMock()
    model.by_type.return_value = [
        _mock_element(10, (0.0, 0.0, 0.0)),
        _mock_element(20, (1.0, 1.0, 3.0)),
    ]
    manifest = MagicMock()
    storey_a = MagicMock()
    storey_a.idx = 0
    storey_a.element_ids = [10]
    storey_b = MagicMock()
    storey_b.idx = 1
    storey_b.element_ids = [20]
    manifest.storeys = [storey_a, storey_b]
    out = extract_element_aabbs(model, manifest)
    by_id = {a.element_id: a for a in out}
    assert by_id[10].storey_idx == 0
    assert by_id[20].storey_idx == 1


def test_extract_element_aabbs_handles_by_type_failure():
    """If model.by_type raises, return [] gracefully."""
    model = MagicMock()
    model.by_type.side_effect = RuntimeError("model not loaded")
    manifest = MagicMock()
    manifest.storeys = []
    assert extract_element_aabbs(model, manifest) == []


# ── SpatialTileSplitter caching ─────────────────────────────────────────────


def test_splitter_cache_hit_returns_same_instance(monkeypatch):
    """Calling get_manifest twice with the same key returns the same object."""
    splitter = SpatialTileSplitter()
    elements = [
        ElementAABB(element_id=1, aabb_min=(0.0, 0.0, 0.0), aabb_max=(0.0, 0.0, 0.0)),
    ]
    monkeypatch.setattr(
        "app.services.spatial_tile_splitter.extract_element_aabbs",
        lambda m, s: elements,
    )

    a = splitter.get_manifest(MagicMock(), MagicMock(), sha="deadbeef", grid_resolution=2)
    b = splitter.get_manifest(MagicMock(), MagicMock(), sha="deadbeef", grid_resolution=2)
    assert a is b


def test_splitter_different_grid_resolutions_cache_separately(monkeypatch):
    splitter = SpatialTileSplitter()
    monkeypatch.setattr(
        "app.services.spatial_tile_splitter.extract_element_aabbs",
        lambda m, s: [
            ElementAABB(element_id=i, aabb_min=(float(i), 0.0, 0.0), aabb_max=(float(i), 0.0, 0.0))
            for i in range(4)
        ],
    )
    g2 = splitter.get_manifest(MagicMock(), MagicMock(), sha="abc", grid_resolution=2)
    g4 = splitter.get_manifest(MagicMock(), MagicMock(), sha="abc", grid_resolution=4)
    assert g2 is not g4
    assert g2.grid_resolution == 2
    assert g4.grid_resolution == 4
    assert splitter.cache_size() == 2


def test_splitter_clear_cache_one_sha(monkeypatch):
    splitter = SpatialTileSplitter()
    monkeypatch.setattr(
        "app.services.spatial_tile_splitter.extract_element_aabbs",
        lambda m, s: [],
    )
    splitter.get_manifest(MagicMock(), MagicMock(), sha="aaa", grid_resolution=2)
    splitter.get_manifest(MagicMock(), MagicMock(), sha="bbb", grid_resolution=2)
    assert splitter.cache_size() == 2

    splitter.clear_cache("aaa")
    assert splitter.cache_size() == 1


def test_splitter_clear_cache_all(monkeypatch):
    splitter = SpatialTileSplitter()
    monkeypatch.setattr(
        "app.services.spatial_tile_splitter.extract_element_aabbs",
        lambda m, s: [],
    )
    splitter.get_manifest(MagicMock(), MagicMock(), sha="aaa", grid_resolution=2)
    splitter.get_manifest(MagicMock(), MagicMock(), sha="bbb", grid_resolution=4)
    splitter.clear_cache()
    assert splitter.cache_size() == 0


def test_splitter_empty_sha_bypasses_cache(monkeypatch):
    """An empty SHA opt-out (used by tests) doesn't populate the cache."""
    splitter = SpatialTileSplitter()
    monkeypatch.setattr(
        "app.services.spatial_tile_splitter.extract_element_aabbs",
        lambda m, s: [],
    )
    a = splitter.get_manifest(MagicMock(), MagicMock(), sha="", grid_resolution=2)
    b = splitter.get_manifest(MagicMock(), MagicMock(), sha="", grid_resolution=2)
    assert a is not b
    assert splitter.cache_size() == 0


# ── extract_element_aabbs_from_cache ─────────────────────────────────────────


def _model_with_elements(express_ids: list[int], placement_origin=(0.0, 0.0, 0.0)):
    """Build a MagicMock IFC model whose by_type('IfcElement') returns mocks
    with given express IDs and a placement at `placement_origin`."""
    elements = []
    for eid in express_ids:
        el = MagicMock()
        el.id.return_value = eid
        # Wire ObjectPlacement.RelativePlacement.Location.Coordinates
        el.ObjectPlacement.RelativePlacement.Location.Coordinates = placement_origin
        elements.append(el)
    model = MagicMock()
    model.by_type.return_value = elements
    return model


def _patched_ifcopenshell(monkeypatch):
    """Stub sys.modules so the lazy `import ifcopenshell` inside the helper succeeds."""
    import sys
    if "ifcopenshell" not in sys.modules:
        monkeypatch.setitem(sys.modules, "ifcopenshell", MagicMock())


def test_extract_from_cache_all_real(monkeypatch):
    _patched_ifcopenshell(monkeypatch)
    model = _model_with_elements([1, 2, 3], placement_origin=(0.0, 0.0, 0.0))
    cache = {
        1: ((0.0, 0.0, 0.0), (1.0, 1.0, 1.0)),
        2: ((2.0, 2.0, 2.0), (3.0, 3.0, 3.0)),
        3: ((4.0, 4.0, 4.0), (5.0, 5.0, 5.0)),
    }
    elements, source = extract_element_aabbs_from_cache(model, MagicMock(), cache)
    assert source == "real"
    assert len(elements) == 3
    # Real AABBs - extents differ from origin.
    assert any(e.aabb_max == (5.0, 5.0, 5.0) for e in elements)


def test_extract_from_cache_mixed(monkeypatch):
    _patched_ifcopenshell(monkeypatch)
    model = _model_with_elements([1, 2, 3], placement_origin=(7.0, 7.0, 7.0))
    cache = {1: ((0.0, 0.0, 0.0), (1.0, 1.0, 1.0))}
    elements, source = extract_element_aabbs_from_cache(model, MagicMock(), cache)
    assert source == "mixed"
    # eid=1 → real AABB, eids 2 and 3 → placement-origin point AABB.
    by_id = {e.element_id: e for e in elements}
    assert by_id[1].aabb_max == (1.0, 1.0, 1.0)
    assert by_id[2].aabb_min == by_id[2].aabb_max == (7.0, 7.0, 7.0)
    assert by_id[3].aabb_min == by_id[3].aabb_max == (7.0, 7.0, 7.0)


def test_extract_from_cache_empty_cache_returns_placement_source(monkeypatch):
    _patched_ifcopenshell(monkeypatch)
    model = _model_with_elements([1], placement_origin=(0.0, 0.0, 0.0))
    elements, source = extract_element_aabbs_from_cache(model, MagicMock(), {})
    assert source == "placement"
    assert len(elements) == 1


def test_extract_from_cache_skips_elements_with_no_placement_and_no_cache(monkeypatch):
    _patched_ifcopenshell(monkeypatch)
    # element with broken placement → placement_point() returns None
    el = MagicMock()
    el.id.return_value = 9
    el.ObjectPlacement = None
    model = MagicMock()
    model.by_type.return_value = [el]

    elements, source = extract_element_aabbs_from_cache(model, MagicMock(), {})
    assert elements == []
    assert source == "placement"


def test_splitter_consumes_aabb_lookup(monkeypatch):
    """When passed an aabb_lookup, splitter calls the cache-aware extractor."""
    _patched_ifcopenshell(monkeypatch)
    splitter = SpatialTileSplitter()
    model = _model_with_elements([1, 2])

    # Real AABBs spread across two tiles in a 2x2 grid.
    cache = {
        1: ((0.0, 0.0, 0.0), (1.0, 1.0, 1.0)),
        2: ((100.0, 100.0, 0.0), (101.0, 101.0, 1.0)),
    }
    manifest = splitter.get_manifest(
        model, MagicMock(), sha="sha-real", grid_resolution=2, aabb_lookup=cache
    )
    assert manifest.total_elements == 2
    assert splitter.aabb_source("sha-real", 2) == "real"


def test_splitter_records_placement_source_when_no_lookup(monkeypatch):
    monkeypatch.setattr(
        "app.services.spatial_tile_splitter.extract_element_aabbs",
        lambda m, s: [
            ElementAABB(element_id=1, aabb_min=(0, 0, 0), aabb_max=(0, 0, 0))
        ],
    )
    splitter = SpatialTileSplitter()
    splitter.get_manifest(MagicMock(), MagicMock(), sha="sha-pl", grid_resolution=2)
    assert splitter.aabb_source("sha-pl", 2) == "placement"


def test_splitter_clear_cache_drops_source_too(monkeypatch):
    _patched_ifcopenshell(monkeypatch)
    splitter = SpatialTileSplitter()
    model = _model_with_elements([1])
    splitter.get_manifest(
        model,
        MagicMock(),
        sha="sha-clr",
        grid_resolution=2,
        aabb_lookup={1: ((0, 0, 0), (1, 1, 1))},
    )
    assert splitter.aabb_source("sha-clr", 2) == "real"
    splitter.clear_cache("sha-clr")
    # After eviction, fallback to default 'placement'.
    assert splitter.aabb_source("sha-clr", 2) == "placement"
