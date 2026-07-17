"""Server-side geometry decimation (LOD) service.

Serves a decimated model during navigation and the full model at rest. Given a
full, validated ``.frag`` already sitting in ``FRAGMENT_CACHE_DIR``, this service
POSTs those bytes to the Node sidecar's ``/decimate`` endpoint, then atomically
publishes the smaller result under a versioned cache key.

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
from app.services.fragment_cache import (
    atomic_write_fragment_cache,
    full_fragment_cache_entry,
    inspect_fragment_cache,
    lod_fragment_cache_entry,
    read_fragment_cache,
)
from app.services.sidecar_manager import sidecar_manager

logger = logging.getLogger(__name__)


class LodUnavailable(Exception):
    """A LOD frag could not be produced; the caller should degrade to full."""


def _safe_fingerprint(fingerprint: str) -> str:
    """Strip path-traversal characters, mirroring the ifc_routes fingerprint rules."""
    return fingerprint.replace("/", "").replace("\\", "").replace("..", "")[:128]


def full_frag_cache_path(fingerprint: str, profile: str) -> Path:
    """Disk path of the full (non-decimated) fragment for ``(sha, profile)``."""
    return full_fragment_cache_entry(
        FRAGMENT_CACHE_DIR,
        _safe_fingerprint(fingerprint),
        profile,
    ).path


def lod_frag_cache_path(
    fingerprint: str,
    profile: str,
    *,
    ratio: Optional[float] = None,
    error: Optional[float] = None,
) -> Path:
    """Disk path of the decimated LOD fragment for ``(sha, profile)``."""
    return lod_fragment_cache_entry(
        FRAGMENT_CACHE_DIR,
        _safe_fingerprint(fingerprint),
        profile,
        ratio=ratio,
        error=error,
    ).path


def is_lod_fragment_cached(
    fingerprint: str,
    profile: str,
    *,
    ratio: Optional[float] = None,
    error: Optional[float] = None,
) -> bool:
    """Return whether the requested LOD variant is complete and valid."""

    entry = lod_fragment_cache_entry(
        FRAGMENT_CACHE_DIR,
        _safe_fingerprint(fingerprint),
        profile,
        ratio=ratio,
        error=error,
    )
    return inspect_fragment_cache(entry) is not None


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

    Serves an existing validated LOD artifact from cache when present. Otherwise
    reads the version-matched full artifact, POSTs it to the sidecar
    ``/decimate`` endpoint, writes the result to cache, and returns it.

    Raises:
        LodUnavailable: the full frag is not cached, the sidecar is unavailable,
            or decimation produced no usable output. The route turns this into a
            503 with the message so the frontend falls back to the full model.
    """
    safe_fp = _safe_fingerprint(fingerprint)
    FRAGMENT_CACHE_DIR.mkdir(parents=True, exist_ok=True)

    lod_entry = lod_fragment_cache_entry(
        FRAGMENT_CACHE_DIR,
        safe_fp,
        profile,
        ratio=ratio,
        error=error,
    )
    lod_path = lod_entry.path
    cached_lod = await asyncio.to_thread(read_fragment_cache, lod_entry)
    if cached_lod is not None:
        return cached_lod

    async with _lock_for(lod_path.name):
        # Re-check under the lock: a concurrent caller may have just built it.
        cached_lod = await asyncio.to_thread(read_fragment_cache, lod_entry)
        if cached_lod is not None:
            return cached_lod

        full_entry = full_fragment_cache_entry(FRAGMENT_CACHE_DIR, safe_fp, profile)
        # Full artifacts can be hundreds of megabytes; the read + checksum
        # verification must not stall the event loop.
        full_bytes = await asyncio.to_thread(read_fragment_cache, full_entry)
        if full_bytes is None:
            raise LodUnavailable(
                f"full fragment not cached for fingerprint {safe_fp[:16]}… "
                f"profile={profile}; convert the model first"
            )
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

        identity_verified = meta.get("identityVerified")
        if identity_verified is not True:
            raise LodUnavailable("sidecar did not verify LOD element identity compatibility")
        if (
            not isinstance(meta.get("identitySha256"), str)
            or not isinstance(meta.get("identityCount"), int)
        ):
            raise LodUnavailable("sidecar returned an incomplete LOD identity proof")

        preprocessing = {
            "pipeline": "meshoptimizer-simplify-sloppy",
            "source_cache_key": full_entry.key.digest,
            "identity": {
                "verified": identity_verified,
                "item_count": meta.get("identityCount"),
                "sha256": meta.get("identitySha256"),
            },
            "lod": {
                "target_ratio": meta.get("targetRatio"),
                "target_error": meta.get("targetError"),
                "achieved_max_error": meta.get("achievedMaxError"),
                "achieved_weighted_mean_error": meta.get(
                    "achievedWeightedMeanError"
                ),
                "triangles_before": meta.get("trisBefore"),
                "triangles_after": meta.get("trisAfter"),
            },
            "timing_ms": meta.get("elapsedMs"),
        }

        # Best-effort cache write; a write failure is not fatal (we still return
        # the bytes, the next call simply rebuilds).
        try:
            atomic_write_fragment_cache(
                lod_entry,
                lod_bytes,
                preprocessing=preprocessing,
            )
        except (OSError, TypeError, ValueError):
            logger.warning("Failed to persist LOD fragment cache at %s", lod_path)

        logger.info(
            "LOD fragment built: sha=%s profile=%s full=%.2fMB lod=%.2fMB "
            "tris=%s->%s max_error=%s identity_verified=%s",
            safe_fp[:12],
            profile,
            len(full_bytes) / (1024 * 1024),
            len(lod_bytes) / (1024 * 1024),
            meta.get("trisBefore", 0),
            meta.get("trisAfter", 0),
            meta.get("achievedMaxError"),
            identity_verified,
        )
        return lod_bytes


__all__ = [
    "LodUnavailable",
    "get_or_build_lod_fragment",
    "full_frag_cache_path",
    "is_lod_fragment_cached",
    "lod_frag_cache_path",
]
