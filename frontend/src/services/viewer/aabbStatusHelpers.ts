/**
 * Pure helpers for consuming the `/api/ifc/aabb/*` cache surface.
 *
 * Kept side-effect-free so vitest can cover the decision logic without
 * mocking fetch, the store, or the viewer.
 */

import type { AabbCacheStatusDto, AabbCacheState, AabbSource } from '../api';

/** Reasonable polling cadence for the AABB warm-up status - fast while
 *  computing, slow once steady. Returns milliseconds. */
export function aabbStatusPollIntervalMs(state: AabbCacheState): number {
  switch (state) {
    case 'computing':
      return 750;
    case 'idle':
      return 1500;
    case 'failed':
      return 5000;
    case 'ready':
      return 30_000;
  }
}

/** A short, human-readable label for the cache state.  */
export function aabbStatusLabel(status: AabbCacheStatusDto | null): string {
  if (!status) return 'AABB cache: unknown';
  switch (status.state) {
    case 'idle':
      return 'AABB cache: idle';
    case 'computing':
      return status.total_expected > 0
        ? `AABB cache: computing (${status.count}/${status.total_expected})`
        : `AABB cache: computing (${status.count})`;
    case 'ready':
      return `AABB cache: ready (${status.count})`;
    case 'failed':
      return `AABB cache: failed${status.error ? ` - ${status.error}` : ''}`;
  }
}

/** Provenance badge text matching the splitter's `aabb_source` tag.  */
export function aabbSourceLabel(source: AabbSource): string {
  switch (source) {
    case 'real':
      return 'Real AABBs';
    case 'mixed':
      return 'Real + placement (mixed)';
    case 'placement':
      return 'Placement-origin (warming…)';
  }
}

/** True when the cache holds enough entries for the frontend to trust the
 *  AABBs for frustum culling. Threshold defaults to "any ready state with
 *  ≥ 1 cached AABB"; callers can pass `minCount` for a stricter bar. */
export function isAabbCacheWarmEnough(
  status: AabbCacheStatusDto | null,
  minCount: number = 1,
): boolean {
  if (!status) return false;
  if (status.state !== 'ready') return false;
  return status.count >= minCount;
}

/** True when the source string is "real" or "mixed" - i.e. at least one
 *  element resolved to a real AABB. */
export function isAabbSourceTrustworthy(source: AabbSource): boolean {
  return source !== 'placement';
}

/** Compute a stable diff between a previous and current status - used by
 *  the polling hook to decide whether to re-emit. */
export function aabbStatusChanged(
  prev: AabbCacheStatusDto | null,
  next: AabbCacheStatusDto | null,
): boolean {
  if (prev === next) return false;
  if (!prev || !next) return true;
  return (
    prev.state !== next.state ||
    prev.count !== next.count ||
    prev.error !== next.error ||
    prev.sha !== next.sha
  );
}
