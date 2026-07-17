/**
 * Resolve the element set used by viewer-wide actions such as hide, isolate,
 * and frame. Keeping this policy outside React prevents individual command
 * surfaces from silently disagreeing about what "the current selection"
 * means.
 *
 * Priority is intentional:
 *   1. A non-empty Shift-click multi-selection (`selectedIds`).
 *   2. The primary single selection (`selectedElementId`).
 *   3. Search / filter / AI result highlights (`highlightedIds`).
 *
 * Every result is a fresh, finite, duplicate-free array. If a non-empty
 * multi-selection contains only invalid IDs, it still owns the action and
 * resolves to an empty result; an unrelated highlight set must not be acted
 * on instead.
 */

export interface ViewerActionTargetState {
  selectedIds: readonly number[];
  selectedElementId: number | null;
  highlightedIds: readonly number[];
}

function normaliseIds(ids: readonly number[]): number[] {
  const seen = new Set<number>();
  const result: number[] = [];
  for (const id of ids) {
    if (!Number.isFinite(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

export function resolveViewerActionTargets(
  state: ViewerActionTargetState,
): number[] {
  if (state.selectedIds.length > 0) {
    return normaliseIds(state.selectedIds);
  }

  if (
    state.selectedElementId !== null
    && Number.isFinite(state.selectedElementId)
  ) {
    return [state.selectedElementId];
  }

  return normaliseIds(state.highlightedIds);
}
