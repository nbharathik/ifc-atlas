/**
 * Selection-aware "frame" target resolution.
 *
 * Compatibility wrapper for callers that need `null` to mean "fit the whole
 * model". Viewer action surfaces should use `resolveViewerActionTargets`
 * directly so hide, isolate, and frame share one target policy.
 *
 *   1. A non-empty multi-selection wins.
 *   2. A single-element selection wins next.
 *   3. Otherwise fall back to the multi-element highlight set.
 *   4. If none is set, return `null` so the caller can fit the whole model.
 *
 * The function is intentionally tiny + dependency-free so it can be exercised
 * by vitest without spinning up the viewer.
 */

import { resolveViewerActionTargets } from './viewerActionTargetHelpers';

export type FrameTargets = number[] | null;

/**
 * Pick the elements that the camera should frame from the current multi-
 * selection, primary selection, and result-highlight list.
 *
 * Returns `null` when there is no target. Always returns a fresh array so
 * downstream consumers can safely sort or mutate without aliasing store state.
 *
 * Non-finite ids (NaN / Infinity) are dropped; duplicate ids in the winning
 * source are deduplicated while preserving first-seen order. An empty result
 * after filtering is treated as "no target" (returns `null`).
 */
export function chooseFrameTargets(
  selectedId: number | null,
  highlightedIds: ReadonlyArray<number>,
  selectedIds: ReadonlyArray<number> = [],
): FrameTargets {
  const targets = resolveViewerActionTargets({
    selectedIds,
    selectedElementId: selectedId,
    highlightedIds,
  });
  return targets.length > 0 ? targets : null;
}
