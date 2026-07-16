"""ID-preserving spatial/storey fragment subset preprocessing.

The service consumes a validated full fragment and asks the Node sidecar to
copy selected fragment items plus their shared geometry/material dependencies.
Unlike sub-IFC reconstruction, this keeps the original local-ID/GUID bridge.
Every sidecar result carries identity and content parity proofs before it is
published through the versioned fragment cache.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

from app.core.config import FRAGMENT_CACHE_DIR
from app.services.fragment_cache import (
    atomic_write_fragment_cache,
    full_fragment_cache_entry,
    read_fragment_cache,
    subset_fragment_cache_entry,
)
from app.services.sidecar_manager import sidecar_manager

logger = logging.getLogger(__name__)


class SpatialSubsetUnavailable(Exception):
    """A verified subset could not be produced; callers should fall back."""


_build_locks: dict[tuple[int, str], asyncio.Lock] = {}
# One lock per (loop, subset filename) is tiny, but tile-heavy sessions mint
# thousands of filenames; drop idle locks once the map grows past this bound.
_BUILD_LOCKS_MAX = 512


def _lock_for(key: str) -> asyncio.Lock:
    loop_key = (id(asyncio.get_running_loop()), key)
    lock = _build_locks.get(loop_key)
    if lock is None:
        if len(_build_locks) >= _BUILD_LOCKS_MAX:
            for stale_key in [
                k for k, held in _build_locks.items() if not held.locked()
            ]:
                del _build_locks[stale_key]
        lock = asyncio.Lock()
        _build_locks[loop_key] = lock
    return lock


# Mirror of the category drop sets in backend/sidecar/src/profiles.ts
# (configureImporter). THIS TABLE MUST STAY IN SYNC WITH THAT FILE: the cached
# full fragment physically lacks these categories, so requesting one from the
# sidecar subset builder can only fail the fail-closed identity proof. The
# check is deliberately fail-open - an unmapped class stays in the request and
# at worst reproduces today's explicit SpatialSubsetUnavailable, never a
# silently wrong subset.
_NON_QUALITY_DROPPED_UPPER = frozenset(
    {
        "IFCSPACE",
        "IFCOPENINGELEMENT",
        "IFCOPENINGSTANDARDCASE",
        "IFCANNOTATION",
        "IFCGRID",
    }
)
_ULTRA_FAST_DROPPED_UPPER = frozenset(
    {
        "IFCFASTENER",
        "IFCMECHANICALFASTENER",
        "IFCREINFORCINGBAR",
        "IFCREINFORCINGMESH",
        "IFCTENDON",
        "IFCTENDONANCHOR",
        "IFCVIRTUALELEMENT",
        "IFCSURFACEFEATURE",
        "IFCBUILDINGELEMENTPART",
        "IFCFURNISHINGELEMENT",
        "IFCFURNITURE",
        "IFCSYSTEMFURNITUREELEMENT",
        "IFCDISTRIBUTIONELEMENT",
        "IFCDISTRIBUTIONCONTROLELEMENT",
        "IFCDISTRIBUTIONFLOWELEMENT",
        "IFCFLOWTERMINAL",
        "IFCFLOWCONTROLLER",
        "IFCFLOWFITTING",
        "IFCFLOWSEGMENT",
    }
)
_ULTRA_FAST_DROPPED_TOKENS = (
    "FITTING",
    "TERMINAL",
    "ACCESSORY",
    "REINFORCING",
    "FASTENER",
)


def _profile_drops_class(entity_class: str, profile: str) -> bool:
    if profile == "quality":
        return False
    upper = entity_class.upper()
    if upper in _NON_QUALITY_DROPPED_UPPER:
        return True
    if profile != "ultra_fast":
        return False
    if upper in _ULTRA_FAST_DROPPED_UPPER:
        return True
    return any(token in upper for token in _ULTRA_FAST_DROPPED_TOKENS)


def filter_convertible_element_ids(
    model: object,
    element_ids: list[int],
    profile: str,
) -> list[int]:
    """Drop express IDs whose category the conversion profile removed.

    Tile/storey membership is computed from the authoritative IFC model, but
    the cached fragment only contains the categories the profile kept. Asking
    the subset builder for a dropped category (an opening under ``balanced``,
    furnishing under ``ultra_fast``) is guaranteed to fail its identity proof.
    Unresolvable entities and non-string classes are kept - the fail-closed
    subset proof remains the authority on what actually exists.
    """

    if profile == "quality":
        return list(element_ids)
    kept: list[int] = []
    dropped = 0
    for element_id in element_ids:
        entity_class: object = None
        try:
            entity = model.by_id(element_id)  # type: ignore[union-attr]
            is_a = getattr(entity, "is_a", None)
            if callable(is_a):
                entity_class = is_a()
        except (AttributeError, RuntimeError, TypeError, ValueError):
            entity_class = None
        if isinstance(entity_class, str) and _profile_drops_class(
            entity_class, profile
        ):
            dropped += 1
            continue
        kept.append(element_id)
    if dropped:
        logger.debug(
            "spatial subset: filtered %d element(s) the '%s' profile drops",
            dropped,
            profile,
        )
    return kept


def element_identity_requests(
    model: object,
    element_ids: list[int],
) -> list[tuple[int, Optional[str]]]:
    """Resolve IFC EXPRESS IDs to GUID hints for sidecar-local-ID mapping."""

    requests: list[tuple[int, Optional[str]]] = []
    for element_id in sorted(set(int(value) for value in element_ids)):
        guid: Optional[str] = None
        try:
            entity = model.by_id(element_id)  # type: ignore[union-attr]
            candidate = getattr(entity, "GlobalId", None)
            if isinstance(candidate, str) and candidate:
                guid = candidate
        except (AttributeError, RuntimeError, TypeError, ValueError):
            pass
        requests.append((element_id, guid))
    return requests


async def get_or_build_spatial_fragment(
    *,
    model: object,
    fingerprint: str,
    profile: str,
    subset_kind: str,
    subset_id: str,
    element_ids: list[int],
) -> tuple[bytes, str]:
    """Return ``(fragment_bytes, source)`` for a verified spatial subset."""

    normalized_ids = sorted(set(int(value) for value in element_ids))
    if not normalized_ids:
        raise SpatialSubsetUnavailable("spatial subset has no elements")
    # Filter before the cache key is computed so the artifact identity
    # describes the ids that were actually requested from the sidecar.
    normalized_ids = filter_convertible_element_ids(model, normalized_ids, profile)
    if not normalized_ids:
        raise SpatialSubsetUnavailable(
            f"spatial subset has no elements the '{profile}' profile converts"
        )
    FRAGMENT_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    subset_entry = subset_fragment_cache_entry(
        FRAGMENT_CACHE_DIR,
        fingerprint,
        profile,
        subset_kind=subset_kind,
        subset_id=subset_id,
        element_ids=normalized_ids,
    )
    cached = await asyncio.to_thread(read_fragment_cache, subset_entry)
    if cached is not None:
        return cached, "cache"

    async with _lock_for(subset_entry.path.name):
        cached = await asyncio.to_thread(read_fragment_cache, subset_entry)
        if cached is not None:
            return cached, "cache"

        full_entry = full_fragment_cache_entry(
            FRAGMENT_CACHE_DIR, fingerprint, profile
        )
        # Reading + checksum-verifying the full artifact can touch hundreds
        # of megabytes; keep it off the event loop.
        full_bytes = await asyncio.to_thread(read_fragment_cache, full_entry)
        if full_bytes is None:
            raise SpatialSubsetUnavailable(
                f"full fragment not cached for fingerprint {fingerprint[:16]}... "
                f"profile={profile}"
            )
        identities = element_identity_requests(model, normalized_ids)
        try:
            subset_bytes, meta = await sidecar_manager.subset(
                frag_bytes=full_bytes,
                items=identities,
                model_id=f"{fingerprint[:12]}-{subset_kind}-{subset_id}",
            )
        except (RuntimeError, ValueError) as exc:
            raise SpatialSubsetUnavailable(f"subset sidecar error: {exc}") from exc

        if not subset_bytes:
            raise SpatialSubsetUnavailable("sidecar produced an empty spatial fragment")
        if (
            meta.get("identityVerified") is not True
            or meta.get("contentVerified") is not True
            or meta.get("resolvedCount") != len(normalized_ids)
            or meta.get("identityCount") != len(normalized_ids)
        ):
            raise SpatialSubsetUnavailable(
                "sidecar spatial fragment parity proof did not match the request"
            )

        preprocessing = {
            "pipeline": "fragments-get-subset-buffer-v1",
            "source_cache_key": full_entry.key.digest,
            "subset": {
                "kind": subset_kind,
                "id": subset_id,
                "requested_count": len(normalized_ids),
                "resolved_count": meta.get("resolvedCount"),
                "guid_remap_count": meta.get("guidRemapCount"),
            },
            "identity": {
                "verified": True,
                "item_count": meta.get("identityCount"),
                "sha256": meta.get("identitySha256"),
            },
            "content": {
                "verified": True,
                "sha256": meta.get("contentSha256"),
            },
            "timing_ms": meta.get("elapsedMs"),
        }
        try:
            atomic_write_fragment_cache(
                subset_entry,
                subset_bytes,
                preprocessing=preprocessing,
            )
        except (OSError, TypeError, ValueError):
            logger.warning(
                "Failed to persist spatial fragment cache at %s", subset_entry.path
            )
        return subset_bytes, "sidecar"


__all__ = [
    "SpatialSubsetUnavailable",
    "element_identity_requests",
    "filter_convertible_element_ids",
    "get_or_build_spatial_fragment",
]
