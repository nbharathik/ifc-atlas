"""Spatial tile partitioning for the IFC viewer.

Goal: split a loaded IFC model into a regular NxN XY grid per storey so the
frontend can stream only the tiles whose AABB intersects the camera frustum.
Targets 500 MB+ IFC models that don't fit in browser memory all at once.

This file provides:
  - Pure partition math takes plain dataclasses (no IfcOpenShell at import time).
  - Element-to-tile assignment by AABB centroid (or single point if min == max).
  - IfcOpenShell wrapper class that extracts placement-origin "AABBs" (point
    AABBs at `ObjectPlacement.RelativePlacement.Location.Coordinates`). This is
    a best-effort fallback heuristic; real geometry-derived AABBs (via
    `ifcopenshell.geom.create_shape`, cached on disk) take over when the
    AABB cache is warm.
  - Tile manifest cached by SHA + grid resolution.

Pattern mirrors `model_health.py` - fully mock-testable, no IfcOpenShell at
import time. Tests run against synthetic ElementAABB lists, side-stepping the
Windows / Python 3.13 IfcOpenShell SIGSEGV.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Iterable, Optional

logger = logging.getLogger(__name__)


# ── Pure data types ─────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ElementAABB:
    """One element's axis-aligned bounding box.

    `aabb_min` / `aabb_max` are world-space (x, y, z). For point elements
    (the placement-origin heuristic) both are equal.
    """

    element_id: int
    aabb_min: tuple[float, float, float]
    aabb_max: tuple[float, float, float]
    storey_idx: int = 0

    @property
    def centroid(self) -> tuple[float, float, float]:
        return (
            0.5 * (self.aabb_min[0] + self.aabb_max[0]),
            0.5 * (self.aabb_min[1] + self.aabb_max[1]),
            0.5 * (self.aabb_min[2] + self.aabb_max[2]),
        )


@dataclass
class TileInfo:
    """One spatial tile - a cell in the per-storey XY grid."""

    tile_id: str  # "{storey_idx}-{cell_x}-{cell_y}"
    storey_idx: int
    cell_x: int
    cell_y: int
    aabb_min: tuple[float, float, float]
    aabb_max: tuple[float, float, float]
    element_ids: list[int]
    element_count: int


@dataclass
class TileManifest:
    """All spatial tiles for one IFC model at one grid resolution."""

    source_sha256: str
    grid_resolution: int
    world_aabb_min: tuple[float, float, float]
    world_aabb_max: tuple[float, float, float]
    tiles: list[TileInfo] = field(default_factory=list)

    @property
    def total_elements(self) -> int:
        return sum(t.element_count for t in self.tiles)

    @property
    def total_tiles(self) -> int:
        return len(self.tiles)


# ── Pure partition function (load-bearing - fully testable) ──────────────────


def compute_world_aabb(
    elements: Iterable[ElementAABB],
) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    """Return (min_xyz, max_xyz) over all element AABBs.

    Empty input returns ((0, 0, 0), (0, 0, 0)).
    """
    elements = list(elements)
    if not elements:
        return ((0.0, 0.0, 0.0), (0.0, 0.0, 0.0))

    min_x = min(e.aabb_min[0] for e in elements)
    min_y = min(e.aabb_min[1] for e in elements)
    min_z = min(e.aabb_min[2] for e in elements)
    max_x = max(e.aabb_max[0] for e in elements)
    max_y = max(e.aabb_max[1] for e in elements)
    max_z = max(e.aabb_max[2] for e in elements)
    return ((min_x, min_y, min_z), (max_x, max_y, max_z))


def _cell_index(coord: float, axis_min: float, axis_size: float, grid_resolution: int) -> int:
    """Bucket a world-space coordinate into a cell index in [0, grid_resolution-1]."""
    if axis_size <= 0:
        return 0
    raw = math.floor(((coord - axis_min) / axis_size) * grid_resolution)
    return max(0, min(grid_resolution - 1, int(raw)))


def partition_by_grid(
    elements: list[ElementAABB],
    grid_resolution: int,
    source_sha256: str = "",
) -> TileManifest:
    """Partition elements into a per-storey NxN XY grid.

    Elements are assigned to the tile containing their centroid. The world
    AABB drives the grid extent so empty cells are skipped. Tiles with no
    elements are omitted from the manifest.

    Parameters
    ----------
    elements:
        Element AABBs. `storey_idx` field selects the per-storey grid; pass
        zero for all elements to get a single XY grid covering the whole model.
    grid_resolution:
        N - the grid is NxN per storey. Must be ≥ 1.
    source_sha256:
        Cache fingerprint; stored on the manifest but not used here.
    """
    if grid_resolution < 1:
        raise ValueError(f"grid_resolution must be ≥ 1, got {grid_resolution}")

    if not elements:
        return TileManifest(
            source_sha256=source_sha256,
            grid_resolution=grid_resolution,
            world_aabb_min=(0.0, 0.0, 0.0),
            world_aabb_max=(0.0, 0.0, 0.0),
            tiles=[],
        )

    world_min, world_max = compute_world_aabb(elements)
    size_x = world_max[0] - world_min[0]
    size_y = world_max[1] - world_min[1]

    # Bucket - keyed by (storey_idx, cell_x, cell_y).
    buckets: dict[tuple[int, int, int], list[ElementAABB]] = {}
    for el in elements:
        cx, cy, _ = el.centroid
        cell_x = _cell_index(cx, world_min[0], size_x, grid_resolution)
        cell_y = _cell_index(cy, world_min[1], size_y, grid_resolution)
        key = (el.storey_idx, cell_x, cell_y)
        buckets.setdefault(key, []).append(el)

    tiles: list[TileInfo] = []
    for (storey_idx, cell_x, cell_y), bucket in sorted(buckets.items()):
        tile_min, tile_max = compute_world_aabb(bucket)
        tile_id = f"{storey_idx}-{cell_x}-{cell_y}"
        tiles.append(
            TileInfo(
                tile_id=tile_id,
                storey_idx=storey_idx,
                cell_x=cell_x,
                cell_y=cell_y,
                aabb_min=tile_min,
                aabb_max=tile_max,
                element_ids=sorted(e.element_id for e in bucket),
                element_count=len(bucket),
            )
        )

    return TileManifest(
        source_sha256=source_sha256,
        grid_resolution=grid_resolution,
        world_aabb_min=world_min,
        world_aabb_max=world_max,
        tiles=tiles,
    )


# ── IfcOpenShell extraction wrapper (best-effort placement heuristic) ────────


def _placement_point(element: object) -> Optional[tuple[float, float, float]]:
    """Best-effort placement-origin extraction.

    Reads `ObjectPlacement.RelativePlacement.Location.Coordinates`. Does NOT
    walk the placement chain (a known limitation - the parent placements may
    be at non-zero origin); real geometry AABBs from the cache replace this
    heuristic when available.
    Returns None when placement is unavailable / malformed.
    """
    try:
        placement = getattr(element, "ObjectPlacement", None)
        if placement is None:
            return None
        rel = getattr(placement, "RelativePlacement", None)
        if rel is None:
            return None
        location = getattr(rel, "Location", None)
        if location is None:
            return None
        coords = getattr(location, "Coordinates", None)
        if coords is None or len(coords) < 3:
            return None
        return (float(coords[0]), float(coords[1]), float(coords[2]))
    except (AttributeError, TypeError, IndexError, ValueError):
        return None


def _build_storey_lookup(storey_manifest: object) -> dict[int, int]:
    """Build {express_id: storey_idx} from a StoreyManifest. Empty when missing."""
    storey_lookup: dict[int, int] = {}
    storeys = getattr(storey_manifest, "storeys", None) or []
    for s in storeys:
        idx = getattr(s, "idx", 0)
        for eid in getattr(s, "element_ids", []) or []:
            storey_lookup[int(eid)] = idx
    return storey_lookup


def extract_element_aabbs(model: object, storey_manifest: object) -> list[ElementAABB]:
    """Pull placement-origin point-AABBs for every element in the storey manifest.

    `storey_manifest` is a `StoreyManifest` instance - used to map element IDs
    to their storey index. Elements absent from the manifest get storey_idx=0.

    Heuristic: AABB min == max == placement origin. Elements with no
    readable placement are skipped (logged at debug level).
    """
    try:
        # Defer ifcopenshell import (test environments may not have it).
        import ifcopenshell  # noqa: F401  type: ignore[import]
    except ImportError:
        return []

    storey_lookup = _build_storey_lookup(storey_manifest)

    out: list[ElementAABB] = []
    skipped = 0
    try:
        elements = model.by_type("IfcElement")  # type: ignore[union-attr]
    except (AttributeError, RuntimeError):
        return []

    for el in elements:
        try:
            eid = int(el.id())
        except (AttributeError, TypeError, ValueError):
            continue
        pt = _placement_point(el)
        if pt is None:
            skipped += 1
            continue
        storey_idx = storey_lookup.get(eid, 0)
        out.append(
            ElementAABB(
                element_id=eid,
                aabb_min=pt,
                aabb_max=pt,
                storey_idx=storey_idx,
            )
        )

    if skipped:
        logger.debug("spatial_tile_splitter: skipped %d elements with no placement", skipped)
    return out


def extract_element_aabbs_from_cache(
    model: object,
    storey_manifest: object,
    aabb_lookup: dict[int, tuple[tuple[float, float, float], tuple[float, float, float]]],
) -> tuple[list[ElementAABB], str]:
    """Build per-element AABBs from a pre-computed cache.

    For each `IfcElement`:
        - if its express ID is in `aabb_lookup` → use the real AABB.
        - otherwise fall back to the placement-origin point AABB.

    Returns `(elements, source)` where `source` is one of:
        - `"real"`     - every element resolved from the cache.
        - `"placement"` - cache was empty / no hits, all placement-origin.
        - `"mixed"`    - some real, some placement.

    Elements with neither cache entry nor readable placement are skipped.
    """
    try:
        import ifcopenshell  # noqa: F401  type: ignore[import]
    except ImportError:
        return [], "placement"

    storey_lookup = _build_storey_lookup(storey_manifest)

    try:
        elements = model.by_type("IfcElement")  # type: ignore[union-attr]
    except (AttributeError, RuntimeError):
        return [], "placement"

    out: list[ElementAABB] = []
    n_real = 0
    n_placement = 0
    n_skipped = 0
    for el in elements:
        try:
            eid = int(el.id())
        except (AttributeError, TypeError, ValueError):
            continue
        storey_idx = storey_lookup.get(eid, 0)
        real = aabb_lookup.get(eid)
        if real is not None:
            mn, mx = real
            out.append(
                ElementAABB(
                    element_id=eid, aabb_min=mn, aabb_max=mx, storey_idx=storey_idx
                )
            )
            n_real += 1
            continue
        pt = _placement_point(el)
        if pt is None:
            n_skipped += 1
            continue
        out.append(
            ElementAABB(
                element_id=eid, aabb_min=pt, aabb_max=pt, storey_idx=storey_idx
            )
        )
        n_placement += 1

    if n_skipped:
        logger.debug(
            "spatial_tile_splitter: %d elements skipped (no cache + no placement)",
            n_skipped,
        )

    if n_real and not n_placement:
        source = "real"
    elif n_real and n_placement:
        source = "mixed"
    else:
        source = "placement"
    return out, source


# ── Cached service singleton (mirrors storey_splitter.py pattern) ────────────


class SpatialTileSplitter:
    """Cached spatial tile manifest builder.

    Cache key: (sha, grid_resolution). Re-call with the same key returns the
    same `TileManifest` object instance.

    When `aabb_service` has a warm cache for this SHA, the
    splitter consumes real geometry-derived AABBs and falls back to
    placement-origin point AABBs for any element missing from the cache.
    """

    def __init__(self) -> None:
        self._cache: dict[tuple[str, int], TileManifest] = {}
        self._aabb_source: dict[tuple[str, int], str] = {}

    def get_manifest(
        self,
        model: object,
        storey_manifest: object,
        sha: str,
        grid_resolution: int = 2,
        aabb_lookup: Optional[dict[int, tuple[tuple[float, float, float], tuple[float, float, float]]]] = None,
    ) -> TileManifest:
        """Return the (possibly cached) tile manifest for `model`.

        Parameters
        ----------
        model : ifcopenshell.file
            The currently-loaded IFC model.
        storey_manifest : StoreyManifest
            Output of `storey_splitter.get_manifest()` for the same model.
            Used to map element IDs to storey indices.
        sha : str
            Source IFC SHA-256 - cache key.
        grid_resolution : int
            N for NxN grid per storey. Default 2 (4 tiles per storey).
        aabb_lookup : optional dict
            Pre-computed `{express_id: (min_xyz, max_xyz)}` from
            `aabb_service`. When non-empty, the splitter uses real AABBs and
            only falls back to placement-origin for missing IDs.
        """
        key = (sha, grid_resolution)
        # Invalidate a stale "placement" cache when a warm AABB lookup is now
        # available - otherwise the first /tile-manifest request issued during
        # the AABB warm-up window pins a placement-origin manifest forever and
        # later requests never pick up the real geometry AABBs.
        if (
            sha
            and aabb_lookup
            and key in self._cache
            and self._aabb_source.get(key) == "placement"
        ):
            logger.debug(
                "tile manifest cache evicted (AABB cache warmed): sha=%s grid=%d",
                sha[:16], grid_resolution,
            )
            del self._cache[key]
            self._aabb_source.pop(key, None)

        if sha and key in self._cache:
            logger.debug("tile manifest cache hit: sha=%s grid=%d", sha[:16], grid_resolution)
            return self._cache[key]

        if aabb_lookup:
            elements, source = extract_element_aabbs_from_cache(
                model, storey_manifest, aabb_lookup
            )
        else:
            elements = extract_element_aabbs(model, storey_manifest)
            source = "placement"
        manifest = partition_by_grid(elements, grid_resolution, source_sha256=sha)
        if sha:
            self._cache[key] = manifest
            self._aabb_source[key] = source
        return manifest

    def aabb_source(self, sha: str, grid_resolution: int) -> str:
        """Provenance of a cached manifest: 'real' | 'mixed' | 'placement'."""
        return self._aabb_source.get((sha, grid_resolution), "placement")

    def clear_cache(self, sha: Optional[str] = None) -> None:
        """Evict tile manifests for one SHA or all."""
        if sha is None:
            self._cache.clear()
            self._aabb_source.clear()
        else:
            for key in list(self._cache):
                if key[0] == sha:
                    del self._cache[key]
                    self._aabb_source.pop(key, None)

    def cache_size(self) -> int:
        return len(self._cache)


# Module-level singleton - imported by ifc_routes.
spatial_tile_splitter = SpatialTileSplitter()
