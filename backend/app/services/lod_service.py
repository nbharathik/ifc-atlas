"""Server-side geometry decimation (LOD) service.

Serves a decimated model during navigation and the full model at rest. Given a
full ``.frag`` already sitting in ``FRAGMENT_CACHE_DIR``
(written by the ``POST /api/ifc/convert`` path as ``{sha}-{profile}.frag``), this
service POSTs those bytes to the Node sidecar's ``/decimate`` endpoint, caches the
smaller result as ``{sha}-{profile}-lod.frag``, and returns the bytes.

Everything degrades gracefully: if the full frag is not cached or the sidecar
cannot produce a LOD, ``LodUnavailable`` is raised and the route maps it to a 503
so the frontend just keeps using the full model. The decimated frag preserves
element identity (localIds + GUIDs + spatial structure), so the render, id-bridge,
and picking paths are unchanged.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Optional

from app.core.config import FRAGMENT_CACHE_DIR
from app.services.sidecar_manager import sidecar_manager

logger = logging.getLogger(__name__)


class LodUnavailable(Exception):
    """A LOD frag could not be produced; the caller should degrade to full."""


def _safe_fingerprint(fingerprint: str) -> str:
    """Strip path-traversal characters, mirroring the ifc_routes fingerprint rules."""
    return fingerprint.replace("/", "").replace("\\", "").replace("..", "")[:128]


def full_frag_cache_path(fingerprint: str, profile: str) -> Path:
    """Disk path of the full (non-decimated) fragment for ``(sha, profile)``."""
    return FRAGMENT_CACHE_DIR / f"{_safe_fingerprint(fingerprint)}-{profile}.frag"


def lod_frag_cache_path(fingerprint: str, profile: str) -> Path:
    """Disk path of the decimated LOD fragment for ``(sha, profile)``."""
    return FRAGMENT_CACHE_DIR / f"{_safe_fingerprint(fingerprint)}-{profile}-lod.frag"


# Per-key locks so two concurrent first-calls for the same model do not both run
# the (multi-second) sidecar decimation. Keyed by (running-loop id, LOD cache
# filename): a plain asyncio.Lock binds to the loop it was created on, so keying
# by loop id keeps production (one loop) deduped while staying correct across the
# fresh event loops a TestClient spins per request.
_build_locks: dict[tuple[int, str], asyncio.Lock] = {}


def _lock_for(key: str) -> asyncio.Lock:
    loop_key = (id(asyncio.get_running_loop()), key)
    lock = _build_locks.get(loop_key)
    if lock is None:
        lock = asyncio.Lock()
        _build_locks[loop_key] = lock
    return lock


async def get_or_build_lod_fragment(
    fingerprint: str,
    profile: str,
    ratio: Optional[float] = None,
    error: Optional[float] = None,
) -> bytes:
    """Return decimated LOD ``.frag`` bytes, building + caching on first call.

    Serves an existing ``{sha}-{profile}-lod.frag`` from cache when present.
    Otherwise reads the full ``{sha}-{profile}.frag``, POSTs it to the sidecar
    ``/decimate`` endpoint, writes the result to cache, and returns it.

    Raises:
        LodUnavailable: the full frag is not cached, the sidecar is unavailable,
            or decimation produced no usable output. The route turns this into a
            503 with the message so the frontend falls back to the full model.
    """
    safe_fp = _safe_fingerprint(fingerprint)
    FRAGMENT_CACHE_DIR.mkdir(parents=True, exist_ok=True)

    lod_path = lod_frag_cache_path(safe_fp, profile)
    if lod_path.exists():
        return lod_path.read_bytes()

    async with _lock_for(lod_path.name):
        # Re-check under the lock: a concurrent caller may have just built it.
        if lod_path.exists():
            return lod_path.read_bytes()

        full_path = full_frag_cache_path(safe_fp, profile)
        if not full_path.exists():
            raise LodUnavailable(
                f"full fragment not cached for fingerprint {safe_fp[:16]}… "
                f"profile={profile}; convert the model first"
            )

        full_bytes = full_path.read_bytes()
        try:
            lod_bytes, meta = await sidecar_manager.decimate(
                frag_bytes=full_bytes,
                model_id=f"{safe_fp[:12]}-{profile}-lod",
                ratio=ratio,
                error=error,
            )
        except RuntimeError as exc:
            raise LodUnavailable(f"decimation sidecar error: {exc}") from exc

        # Refuse to cache an empty / suspiciously tiny result - a real LOD frag
        # for any non-trivial model is far larger than a zlib stub.
        if not lod_bytes:
            raise LodUnavailable("sidecar produced an empty LOD fragment")

        # Best-effort cache write; a write failure is not fatal (we still return
        # the bytes, the next call simply rebuilds).
        try:
            lod_path.write_bytes(lod_bytes)
        except OSError:
            logger.warning("Failed to persist LOD fragment cache at %s", lod_path)

        logger.info(
            "LOD fragment built: sha=%s profile=%s full=%.2fMB lod=%.2fMB tris=%s->%s",
            safe_fp[:12],
            profile,
            len(full_bytes) / (1024 * 1024),
            len(lod_bytes) / (1024 * 1024),
            meta.get("trisBefore", 0),
            meta.get("trisAfter", 0),
        )
        return lod_bytes


__all__ = [
    "LodUnavailable",
    "get_or_build_lod_fragment",
    "full_frag_cache_path",
    "lod_frag_cache_path",
]
