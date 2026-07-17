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

import hashlib
import json
import logging
import math
import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Optional

from app.core.config import DATA_DIR

logger = logging.getLogger(__name__)


SPATIAL_TILE_ARTIFACT_SCHEMA_VERSION = 1
# v2: feature elements (openings, projections, surface features) are excluded
# from tile membership. They carry void/feature semantics rather than rendered
# content, and every conversion profile except "quality" drops them from the
# fragment - a tile that lists one can therefore never pass the fail-closed
# subset identity proof.
SPATIAL_TILE_ALGORITHM_VERSION = "storey-centroid-grid-v2"
SPATIAL_TILE_CACHE_DIR = DATA_DIR / "spatial-tile-cache"


def _canonical_json(value: object) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode("utf-8")


def _sha256_json(value: object) -> str:
    return hashlib.sha256(_canonical_json(value)).hexdigest()


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


def _storey_assignment_digest(storey_manifest: object) -> str:
    assignments: list[list[int]] = []
    for storey in getattr(storey_manifest, "storeys", None) or []:
        storey_idx = int(getattr(storey, "idx", 0))
        for element_id in getattr(storey, "element_ids", None) or []:
            assignments.append([int(element_id), storey_idx])
    assignments.sort()
    return _sha256_json(assignments)


def _aabb_lookup_digest(
    aabb_lookup: Optional[
        dict[int, tuple[tuple[float, float, float], tuple[float, float, float]]]
    ],
) -> Optional[str]:
    if not aabb_lookup:
        return None
    rows = [
        [int(element_id), list(bounds[0]), list(bounds[1])]
        for element_id, bounds in aabb_lookup.items()
    ]
    rows.sort(key=lambda row: row[0])
    return _sha256_json(rows)


def _spatial_artifact_identity(
    sha: str,
    grid_resolution: int,
    storey_manifest: object,
    aabb_lookup: Optional[
        dict[int, tuple[tuple[float, float, float], tuple[float, float, float]]]
    ],
) -> dict[str, object]:
    return {
        "schema_version": SPATIAL_TILE_ARTIFACT_SCHEMA_VERSION,
        "algorithm": SPATIAL_TILE_ALGORITHM_VERSION,
        "source_sha256": sha,
        "grid_resolution": grid_resolution,
        "storey_assignment_sha256": _storey_assignment_digest(storey_manifest),
        "aabb_mode": "geometry" if aabb_lookup else "placement",
        "aabb_lookup_sha256": _aabb_lookup_digest(aabb_lookup),
    }


def _spatial_cache_path(cache_dir: Path, identity: dict[str, object]) -> Path:
    digest = _sha256_json(identity)
    return cache_dir / f"tiles-v{SPATIAL_TILE_ARTIFACT_SCHEMA_VERSION}-{digest}.json"


def _manifest_payload(manifest: TileManifest, aabb_source: str) -> dict[str, object]:
    return {
        "source_sha256": manifest.source_sha256,
        "grid_resolution": manifest.grid_resolution,
        "world_aabb_min": list(manifest.world_aabb_min),
        "world_aabb_max": list(manifest.world_aabb_max),
        "total_elements": manifest.total_elements,
        "total_tiles": manifest.total_tiles,
        "aabb_source": aabb_source,
        "tiles": [
            {
                "tile_id": tile.tile_id,
                "storey_idx": tile.storey_idx,
                "cell_x": tile.cell_x,
                "cell_y": tile.cell_y,
                "aabb_min": list(tile.aabb_min),
                "aabb_max": list(tile.aabb_max),
                "element_ids": tile.element_ids,
                "element_count": tile.element_count,
            }
            for tile in manifest.tiles
        ],
    }


def _garbage_collect_spatial_artifacts(
    path: Path,
    identity: dict[str, object],
) -> None:
    """Delete superseded tile artifacts for the same model and grid.

    The filename digest covers the complete identity, so every storey/AABB
    transition (placement -> mixed -> real) mints a new file. The sha and grid
    are not recoverable from the filename, so attribution reads each
    candidate's identity block; unreadable or foreign documents are left
    alone, and deletion failures never fail the publish.
    """

    sha = identity.get("source_sha256")
    grid_resolution = identity.get("grid_resolution")
    try:
        candidates = list(path.parent.glob("tiles-v*.json"))
    except OSError:
        return
    for candidate in candidates:
        if candidate.name == path.name:
            continue
        try:
            document = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(document, dict):
            continue
        candidate_identity = document.get("identity")
        if not isinstance(candidate_identity, dict):
            continue
        if candidate_identity.get("source_sha256") != sha:
            continue
        if candidate_identity.get("grid_resolution") != grid_resolution:
            continue
        try:
            os.remove(candidate)
        except OSError:
            continue


def _atomic_write_spatial_artifact(
    path: Path,
    identity: dict[str, object],
    manifest: TileManifest,
    aabb_source: str,
) -> None:
    payload = _manifest_payload(manifest, aabb_source)
    document = {
        "schema_version": SPATIAL_TILE_ARTIFACT_SCHEMA_VERSION,
        "identity": identity,
        "identity_sha256": _sha256_json(identity),
        "payload": payload,
        "payload_sha256": _sha256_json(payload),
    }
    encoded = _canonical_json(document) + b"\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, raw_temp = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    temp_path = Path(raw_temp)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
    finally:
        temp_path.unlink(missing_ok=True)
    _garbage_collect_spatial_artifacts(path, identity)


def _triple(value: object) -> tuple[float, float, float]:
    if not isinstance(value, list) or len(value) != 3:
        raise ValueError("expected a three-coordinate array")
    result = tuple(float(coordinate) for coordinate in value)
    if not all(math.isfinite(coordinate) for coordinate in result):
        raise ValueError("spatial artifact contains a non-finite coordinate")
    return result  # type: ignore[return-value]


def _load_spatial_artifact(
    path: Path,
    identity: dict[str, object],
) -> Optional[tuple[TileManifest, str]]:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(document, dict):
            return None
        if document.get("schema_version") != SPATIAL_TILE_ARTIFACT_SCHEMA_VERSION:
            return None
        if document.get("identity") != identity:
            return None
        if document.get("identity_sha256") != _sha256_json(identity):
            return None
        payload = document.get("payload")
        if not isinstance(payload, dict):
            return None
        if document.get("payload_sha256") != _sha256_json(payload):
            return None
        if payload.get("source_sha256") != identity["source_sha256"]:
            return None
        if payload.get("grid_resolution") != identity["grid_resolution"]:
            return None
        source = payload.get("aabb_source")
        if source not in {"real", "mixed", "placement"}:
            return None

        raw_tiles = payload.get("tiles")
        if not isinstance(raw_tiles, list):
            return None
        tiles: list[TileInfo] = []
        seen_element_ids: set[int] = set()
        for raw_tile in raw_tiles:
            if not isinstance(raw_tile, dict):
                return None
            element_ids = [int(value) for value in raw_tile.get("element_ids", [])]
            if element_ids != sorted(set(element_ids)):
                return None
            if seen_element_ids.intersection(element_ids):
                return None
            seen_element_ids.update(element_ids)
            tile = TileInfo(
                tile_id=str(raw_tile["tile_id"]),
                storey_idx=int(raw_tile["storey_idx"]),
                cell_x=int(raw_tile["cell_x"]),
                cell_y=int(raw_tile["cell_y"]),
                aabb_min=_triple(raw_tile["aabb_min"]),
                aabb_max=_triple(raw_tile["aabb_max"]),
                element_ids=element_ids,
                element_count=int(raw_tile["element_count"]),
            )
            if tile.element_count != len(tile.element_ids):
                return None
            if tile.tile_id != f"{tile.storey_idx}-{tile.cell_x}-{tile.cell_y}":
                return None
            tiles.append(tile)

        manifest = TileManifest(
            source_sha256=str(payload["source_sha256"]),
            grid_resolution=int(payload["grid_resolution"]),
            world_aabb_min=_triple(payload["world_aabb_min"]),
            world_aabb_max=_triple(payload["world_aabb_max"]),
            tiles=tiles,
        )
        if payload.get("total_elements") != manifest.total_elements:
            return None
        if payload.get("total_tiles") != manifest.total_tiles:
            return None
        return manifest, str(source)
    except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError):
        return None


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


def _is_feature_element(el: object) -> bool:
    """True only for confirmed IfcFeatureElement subtypes (openings etc.).

    Uses a strict ``is True`` check so mocked or malformed entities are kept:
    keeping an extra element degrades to the fail-closed subset proof, while
    wrongly excluding one would silently drop real geometry from every tile.
    """
    try:
        return el.is_a("IfcFeatureElement") is True  # type: ignore[union-attr]
    except (AttributeError, RuntimeError, TypeError, ValueError):
        return False


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
        if _is_feature_element(el):
            continue
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
        if _is_feature_element(el):
            continue
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

    def __init__(self, cache_dir: Optional[Path] = None) -> None:
        self._cache: dict[tuple[str, int], TileManifest] = {}
        self._aabb_source: dict[tuple[str, int], str] = {}
        self._artifact_identity: dict[tuple[str, int], str] = {}
        # Tests and one-off callers stay purely in-memory by default.  The
        # application singleton below opts into the durable artifact cache.
        self._cache_dir = cache_dir

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
        if grid_resolution < 1:
            raise ValueError(
                f"grid_resolution must be >= 1, got {grid_resolution}"
            )

        key = (sha, grid_resolution)
        identity = _spatial_artifact_identity(
            sha, grid_resolution, storey_manifest, aabb_lookup
        )
        identity_sha256 = _sha256_json(identity)

        if (
            sha
            and key in self._cache
            and self._artifact_identity.get(key) == identity_sha256
        ):
            logger.debug("tile manifest cache hit: sha=%s grid=%d", sha[:16], grid_resolution)
            return self._cache[key]

        # The AABB lookup can transition placement -> mixed -> real while the
        # background geometry pass is warming.  Identity includes its complete
        # digest, so every transition invalidates both memory and disk safely.
        if sha and key in self._cache:
            self._cache.pop(key, None)
            self._aabb_source.pop(key, None)
            self._artifact_identity.pop(key, None)

        # Single-model sessions never revisit another fingerprint; entries
        # for other models hold full element-ID manifests.
        if sha:
            for stale_key in [k for k in self._cache if k[0] != sha]:
                self._cache.pop(stale_key, None)
                self._aabb_source.pop(stale_key, None)
                self._artifact_identity.pop(stale_key, None)

        if sha and self._cache_dir is not None:
            artifact_path = _spatial_cache_path(self._cache_dir, identity)
            cached = _load_spatial_artifact(artifact_path, identity)
            if cached is not None:
                manifest, source = cached
                self._cache[key] = manifest
                self._aabb_source[key] = source
                self._artifact_identity[key] = identity_sha256
                logger.debug(
                    "tile manifest disk cache hit: sha=%s grid=%d source=%s",
                    sha[:16],
                    grid_resolution,
                    source,
                )
                return manifest

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
            self._artifact_identity[key] = identity_sha256
            if self._cache_dir is not None:
                try:
                    _atomic_write_spatial_artifact(
                        _spatial_cache_path(self._cache_dir, identity),
                        identity,
                        manifest,
                        source,
                    )
                except (OSError, TypeError, ValueError) as exc:
                    logger.warning(
                        "tile manifest disk persist failed for sha=%s grid=%d: %s",
                        sha[:16],
                        grid_resolution,
                        exc,
                    )
        return manifest

    def aabb_source(self, sha: str, grid_resolution: int) -> str:
        """Provenance of a cached manifest: 'real' | 'mixed' | 'placement'."""
        return self._aabb_source.get((sha, grid_resolution), "placement")

    def clear_cache(self, sha: Optional[str] = None) -> None:
        """Evict tile manifests for one SHA or all."""
        if sha is None:
            self._cache.clear()
            self._aabb_source.clear()
            self._artifact_identity.clear()
        else:
            for key in list(self._cache):
                if key[0] == sha:
                    del self._cache[key]
                    self._aabb_source.pop(key, None)
                    self._artifact_identity.pop(key, None)

    def cache_size(self) -> int:
        return len(self._cache)


# Module-level singleton - imported by ifc_routes.
spatial_tile_splitter = SpatialTileSplitter(cache_dir=SPATIAL_TILE_CACHE_DIR)
