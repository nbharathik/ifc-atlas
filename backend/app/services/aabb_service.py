"""Real per-element AABB cache.

Replaces the placement-origin point-AABB heuristic (every element collapses
to its `ObjectPlacement.RelativePlacement.Location.Coordinates`) with real
geometry-derived AABBs from `ifcopenshell.geom.create_shape`.

Cache schema
============
- In-memory: `self._memory_cache[sha] = {express_id: ((xmin,ymin,zmin), (xmax,ymax,zmax))}`
- On-disk:   `DATA_DIR / "aabb-cache" / "{sha}.json"` - single JSON per IFC
  fingerprint. Format: `{"sha":"…","computed_ms":…,"count":N,"aabbs":{"123":[[…],[…]]}}`
- Atomic disk write via tempfile + replace (no torn JSON on crash).

Background warming
==================
`compute_async(model, sha)` is `asyncio.ensure_future`-able from the upload
handler. The compute itself is CPU-bound (IfcOpenShell geometry) so we
offload it to a thread via `asyncio.to_thread`, leaving the FastAPI event
loop free.

Pure / testable shape
=====================
Mirrors `spatial_tile_splitter.py`: no `ifcopenshell` import at module load
time, all heavy lifting goes through a helper function that tests
monkeypatch. The disk format is plain JSON so pytest can write a fake
cache file and verify the service picks it up after a restart.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional

from app.core.config import DATA_DIR

logger = logging.getLogger(__name__)


# ── Constants ────────────────────────────────────────────────────────────────

AABBTuple = tuple[tuple[float, float, float], tuple[float, float, float]]
"""((min_x, min_y, min_z), (max_x, max_y, max_z))"""

AABB_CACHE_DIR = DATA_DIR / "aabb-cache"

# Schema version - bump when on-disk layout changes (forces recompute).
SCHEMA_VERSION = 1


# ── Status helpers ───────────────────────────────────────────────────────────


@dataclass
class AABBComputeStatus:
    """Live status of the background AABB build for one SHA."""

    sha: str
    state: str  # "idle" | "computing" | "ready" | "failed"
    count: int = 0
    total_expected: int = 0
    total_ms: float = 0.0
    error: Optional[str] = None


# ── Pure helpers (testable, IfcOpenShell-free) ───────────────────────────────


def _aabb_from_verts(verts: Iterable[float]) -> Optional[AABBTuple]:
    """Reduce a flat [x0,y0,z0,x1,y1,z1,…] vertex list to a world-space AABB.

    Returns None when `verts` is empty or its length is not a multiple of 3.
    """
    xs: list[float] = []
    ys: list[float] = []
    zs: list[float] = []
    it = iter(verts)
    try:
        while True:
            x = next(it)
            y = next(it)
            z = next(it)
            xs.append(float(x))
            ys.append(float(y))
            zs.append(float(z))
    except StopIteration:
        pass
    if not xs:
        return None
    return (
        (min(xs), min(ys), min(zs)),
        (max(xs), max(ys), max(zs)),
    )


def _cache_path(sha: str) -> Path:
    """Return the on-disk JSON path for one IFC fingerprint."""
    return AABB_CACHE_DIR / f"{sha}.json"


def _serialize_cache(sha: str, aabbs: dict[int, AABBTuple], total_ms: float) -> dict:
    """Build the JSON-safe dict that gets written to disk."""
    return {
        "schema": SCHEMA_VERSION,
        "sha": sha,
        "count": len(aabbs),
        "total_ms": total_ms,
        "aabbs": {
            str(eid): [list(mn), list(mx)] for eid, (mn, mx) in aabbs.items()
        },
    }


def _deserialize_cache(blob: dict) -> dict[int, AABBTuple]:
    """Inverse of `_serialize_cache`: load disk JSON back into the AABB map.

    Tolerant of a missing or older schema version → returns an empty dict so
    the service can recompute.
    """
    if not isinstance(blob, dict):
        return {}
    if blob.get("schema") != SCHEMA_VERSION:
        return {}
    raw = blob.get("aabbs") or {}
    out: dict[int, AABBTuple] = {}
    for k, v in raw.items():
        try:
            eid = int(k)
            mn = tuple(float(x) for x in v[0])
            mx = tuple(float(x) for x in v[1])
            if len(mn) == 3 and len(mx) == 3:
                out[eid] = (mn, mx)  # type: ignore[assignment]
        except (KeyError, TypeError, ValueError, IndexError):
            continue
    return out


def _atomic_write_json(path: Path, payload: dict) -> None:
    """Write JSON atomically - tempfile in same dir + os.replace."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(
        prefix=f".{path.stem}-", suffix=".tmp", dir=path.parent
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, separators=(",", ":"))
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# ── IfcOpenShell-touching helper (mocked by tests) ───────────────────────────


def _compute_aabbs_via_ifcopenshell(model: object) -> dict[int, AABBTuple]:
    """Pull world-coord AABBs for every IfcElement in `model`.

    Imports `ifcopenshell` lazily so test environments without the wheel can
    monkeypatch this entire function. Skips elements that have no geometric
    representation (a `RuntimeError` from `create_shape`) without aborting
    the whole batch.
    """
    try:
        import ifcopenshell  # noqa: F401  type: ignore[import]
        import ifcopenshell.geom as _geom  # type: ignore[import]
    except ImportError:
        return {}

    settings = _geom.settings()
    try:
        settings.set(settings.USE_WORLD_COORDS, True)
    except AttributeError:
        # Some IfcOpenShell builds expose the flag by string instead.
        try:
            settings.set("use-world-coords", True)
        except Exception:  # noqa: BLE001
            pass

    try:
        elements = model.by_type("IfcElement")  # type: ignore[union-attr]
    except (AttributeError, RuntimeError):
        return {}

    out: dict[int, AABBTuple] = {}
    skipped = 0
    for el in elements:
        try:
            eid = int(el.id())
        except (AttributeError, TypeError, ValueError):
            continue
        try:
            shape = _geom.create_shape(settings, el)
        except (RuntimeError, AttributeError):
            skipped += 1
            continue
        if shape is None:
            skipped += 1
            continue
        try:
            verts = shape.geometry.verts  # type: ignore[attr-defined]
        except AttributeError:
            skipped += 1
            continue
        aabb = _aabb_from_verts(verts)
        if aabb is not None:
            out[eid] = aabb
        else:
            skipped += 1

    if skipped:
        logger.debug("aabb_service: skipped %d elements w/o readable geometry", skipped)
    return out


# ── Service singleton ────────────────────────────────────────────────────────


class AABBService:
    """In-memory + on-disk AABB cache, one map per IFC SHA-256 fingerprint.

    Lifecycle for a given SHA:

    1. Upload arrives → `_bg_tasks` calls `compute_async(model, sha)` (fire-
       and-forget).
    2. `compute_async` checks the disk cache first. If present, loads into
       memory and returns instantly.
    3. Otherwise spawns a thread (`asyncio.to_thread`) that runs
       `_compute_aabbs_via_ifcopenshell` + writes the disk cache.
    4. REST endpoints (`get_aabb`, `get_aabbs_bulk`) read from memory. If
       memory is cold but disk is warm, they hydrate lazily.
    """

    def __init__(self) -> None:
        self._memory_cache: dict[str, dict[int, AABBTuple]] = {}
        self._status: dict[str, AABBComputeStatus] = {}

    # ─── Read API ────────────────────────────────────────────────────────

    def get_aabb(self, sha: str, express_id: int) -> Optional[AABBTuple]:
        """Return one element's AABB or None when not in cache."""
        cache = self._ensure_loaded(sha)
        return cache.get(int(express_id))

    def get_aabbs_bulk(
        self, sha: str, express_ids: Iterable[int]
    ) -> dict[int, AABBTuple]:
        """Return the subset of `express_ids` whose AABBs are cached."""
        cache = self._ensure_loaded(sha)
        out: dict[int, AABBTuple] = {}
        for eid in express_ids:
            try:
                eid_int = int(eid)
            except (TypeError, ValueError):
                continue
            v = cache.get(eid_int)
            if v is not None:
                out[eid_int] = v
        return out

    def get_all_aabbs(self, sha: str) -> dict[int, AABBTuple]:
        """Return a *copy* of the full AABB map for one SHA."""
        return dict(self._ensure_loaded(sha))

    def status(self, sha: str) -> AABBComputeStatus:
        """Live compute status for one SHA."""
        st = self._status.get(sha)
        if st is not None:
            return st
        # No active build → infer from disk / memory.
        cache = self._ensure_loaded(sha)
        if cache:
            return AABBComputeStatus(sha=sha, state="ready", count=len(cache))
        return AABBComputeStatus(sha=sha, state="idle", count=0)

    # ─── Write / compute API ─────────────────────────────────────────────

    def compute_sync(self, model: object, sha: str) -> dict[int, AABBTuple]:
        """Blocking compute (used by tests + the async wrapper).

        Re-uses disk cache when present - does NOT re-do the IfcOpenShell
        pass on a warm SHA.
        """
        if not sha:
            return _compute_aabbs_via_ifcopenshell(model)

        # Disk hit?
        loaded = self._load_disk(sha)
        if loaded:
            self._memory_cache[sha] = loaded
            self._status[sha] = AABBComputeStatus(
                sha=sha, state="ready", count=len(loaded)
            )
            return loaded

        # Cold compute.
        self._status[sha] = AABBComputeStatus(sha=sha, state="computing")
        started = time.monotonic()
        try:
            aabbs = _compute_aabbs_via_ifcopenshell(model)
        except Exception as exc:  # noqa: BLE001
            self._status[sha] = AABBComputeStatus(
                sha=sha, state="failed", count=0, error=str(exc)
            )
            logger.warning("aabb_service: compute failed for sha=%s: %s", sha[:12], exc)
            return {}

        elapsed_ms = (time.monotonic() - started) * 1000.0
        self._memory_cache[sha] = aabbs
        self._status[sha] = AABBComputeStatus(
            sha=sha, state="ready", count=len(aabbs), total_ms=elapsed_ms
        )
        # Persist asynchronously to disk (best-effort).
        try:
            _atomic_write_json(_cache_path(sha), _serialize_cache(sha, aabbs, elapsed_ms))
        except OSError as exc:
            logger.warning("aabb_service: disk persist failed for sha=%s: %s", sha[:12], exc)
        return aabbs

    async def compute_async(self, model: object, sha: str) -> dict[int, AABBTuple]:
        """Background-friendly compute - offloads to a worker thread."""
        import asyncio as _asyncio

        return await _asyncio.to_thread(self.compute_sync, model, sha)

    # ─── Cache management ────────────────────────────────────────────────

    def clear(self, sha: Optional[str] = None) -> None:
        """Evict one or all SHAs from in-memory cache. Disk untouched."""
        if sha is None:
            self._memory_cache.clear()
            self._status.clear()
        else:
            self._memory_cache.pop(sha, None)
            self._status.pop(sha, None)

    def clear_disk(self, sha: Optional[str] = None) -> int:
        """Delete one or all on-disk cache files. Returns count removed."""
        if not AABB_CACHE_DIR.exists():
            return 0
        if sha:
            p = _cache_path(sha)
            if p.exists():
                p.unlink()
                return 1
            return 0
        n = 0
        for p in AABB_CACHE_DIR.glob("*.json"):
            try:
                p.unlink()
                n += 1
            except OSError:
                continue
        return n

    def cache_size_memory(self) -> int:
        return len(self._memory_cache)

    # ─── Internal ────────────────────────────────────────────────────────

    def _ensure_loaded(self, sha: str) -> dict[int, AABBTuple]:
        """Lazy disk → memory hydrate. Returns the in-memory map (may be empty)."""
        if not sha:
            return {}
        if sha in self._memory_cache:
            return self._memory_cache[sha]
        loaded = self._load_disk(sha)
        if loaded:
            self._memory_cache[sha] = loaded
        else:
            self._memory_cache[sha] = {}
        return self._memory_cache[sha]

    def _load_disk(self, sha: str) -> dict[int, AABBTuple]:
        """Read + parse the on-disk JSON. Returns empty on miss / corruption."""
        path = _cache_path(sha)
        if not path.exists():
            return {}
        try:
            with path.open("r", encoding="utf-8") as f:
                blob = json.load(f)
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("aabb_service: disk load failed for sha=%s: %s", sha[:12], exc)
            return {}
        return _deserialize_cache(blob)


# Module-level singleton - imported by ifc_routes + spatial_tile_splitter.
aabb_service = AABBService()
