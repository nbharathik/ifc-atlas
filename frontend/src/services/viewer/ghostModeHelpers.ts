/**
 * Pure helpers for ghost-mode isolation.
 *
 * Ghost mode shows non-isolated elements as semi-transparent "ghosts" with
 * xray edges instead of hiding them completely. These helpers are pure
 * functions so they can be unit-tested without a live Three.js scene.
 */

/** Opacity applied to non-isolated elements in ghost isolation mode. */
export const GHOST_ISOLATION_OPACITY = 0.15;

/** Returns true when ghost mode makes sense (i.e. some IDs are isolated). */
export function isGhostModeEligible(isolatedIds: number[]): boolean {
  return isolatedIds.length > 0;
}

export interface GhostIsolateUpdate {
  /** IDs to make visible (all elements in ghost mode). */
  showAll: number[];
  /** Non-isolated local IDs that should receive ghost opacity. */
  ghostIds: number[];
  /** Opacity value to apply to ghostIds. */
  opacity: number;
}

/**
 * Compute visibility/opacity changes for ghost isolation mode.
 *
 * All elements are shown; non-isolated ones get GHOST_ISOLATION_OPACITY so
 * the isolated set stands out while context remains visible.
 */
export function buildGhostIsolateUpdate(
  allLocalIds: number[],
  isolatedLocalIds: number[],
): GhostIsolateUpdate {
  const isoSet = new Set(isolatedLocalIds);
  const ghostIds = allLocalIds.filter((id) => !isoSet.has(id));
  return {
    showAll: allLocalIds,
    ghostIds,
    opacity: GHOST_ISOLATION_OPACITY,
  };
}

export interface NormalIsolateUpdate {
  /** IDs that should be visible (isolated elements). */
  showIds: number[];
  /** IDs that should be hidden (non-isolated elements). */
  hideIds: number[];
}

/**
 * Compute visibility changes for normal (non-ghost) isolation mode.
 *
 * Non-isolated elements are hidden; isolated elements are shown.
 */
export function buildNormalIsolateUpdate(
  allLocalIds: number[],
  isolatedLocalIds: number[],
): NormalIsolateUpdate {
  const isoSet = new Set(isolatedLocalIds);
  const hideIds = allLocalIds.filter((id) => !isoSet.has(id));
  return {
    showIds: isolatedLocalIds,
    hideIds,
  };
}

/**
 * Returns the set of IDs that changed between two ghost sets so we can do
 * minimal delta updates instead of resetting every element on each call.
 */
export interface GhostDelta {
  newlyGhosted: number[];
  newlyRestored: number[];
}

export function computeGhostDelta(
  prevGhostSet: ReadonlySet<number>,
  nextGhostSet: ReadonlySet<number>,
): GhostDelta {
  const newlyGhosted: number[] = [];
  const newlyRestored: number[] = [];
  for (const id of nextGhostSet) {
    if (!prevGhostSet.has(id)) newlyGhosted.push(id);
  }
  for (const id of prevGhostSet) {
    if (!nextGhostSet.has(id)) newlyRestored.push(id);
  }
  return { newlyGhosted, newlyRestored };
}

// ── Selection-focus ghost decision helper ────────────────────────────────────
//
// Pins the 6-case contract that `ViewerPanel.tsx` (~L589-674) inlines for the
// selection-focus ghost path. Production currently duplicates the delta math
// (L636-639) instead of using `computeGhostDelta` above; swapping it in would
// be a behaviour-preserving cleanup.
//
// The decision matrix below is regression-proof via the tests in
// `__tests__/ghostModeHelpers.test.ts`. Adding a new case to ViewerPanel's
// inline switch should also add a case here and a vitest pin.

/** Plan kinds, ordered by ascending cost. */
export type GhostWorkKind =
  | 'skip'
  | 'noop'
  | 'tear-down'
  | 'first-apply'
  | 'delta'
  | 'opacity-only-change';

export interface GhostWorkSkip {
  /** Ghost-off and never been on - early-exit; do nothing. */
  kind: 'skip';
}
export interface GhostWorkNoop {
  /** Ghost-on, sets identical, opacity unchanged - work already done. */
  kind: 'noop';
}
export interface GhostWorkTearDown {
  /** Ghost-off but was on - reset opacity on the previously-ghosted ids. */
  kind: 'tear-down';
  idsToRestore: number[];
}
export interface GhostWorkFirstApply {
  /** Ghost-on for the first time - apply opacity to the whole next set. */
  kind: 'first-apply';
  idsToGhost: number[];
  opacity: number;
}
export interface GhostWorkDelta {
  /** Ghost-on, sets differ - apply opacity to newcomers, restore departures. */
  kind: 'delta';
  newlyGhosted: number[];
  newlyRestored: number[];
  opacity: number;
}
export interface GhostWorkOpacityOnly {
  /** Ghost-on, sets identical, opacity changed - reapply on the full set. */
  kind: 'opacity-only-change';
  ids: number[];
  opacity: number;
}

export type GhostWorkPlan =
  | GhostWorkSkip
  | GhostWorkNoop
  | GhostWorkTearDown
  | GhostWorkFirstApply
  | GhostWorkDelta
  | GhostWorkOpacityOnly;

export interface GhostDecisionState {
  /** Selection-focus ghost should be active this tick. */
  shouldGhost: boolean;
  /** Ghost opacity is currently applied to `prevGhostSet`. */
  ghostApplied: boolean;
  prevGhostSet: ReadonlySet<number>;
  nextGhostSet: ReadonlySet<number>;
  prevOpacity: number;
  nextOpacity: number;
}

/**
 * Decide what work is needed for a single selection-focus ghost transition.
 *
 * Returns one of six plans (see `GhostWorkKind`). The caller dispatches
 * `setOpacity` / `resetOpacity` against the renderer; this function is a pure
 * decision over the input state and never touches Three.js. Re-running the
 * decision with the same inputs must always return the same plan (referential
 * stability is not required, but case selection is).
 */
export function decideGhostWork(state: GhostDecisionState): GhostWorkPlan {
  const {
    shouldGhost,
    ghostApplied,
    prevGhostSet,
    nextGhostSet,
    prevOpacity,
    nextOpacity,
  } = state;

  if (!shouldGhost && !ghostApplied) {
    return { kind: 'skip' };
  }
  if (!shouldGhost && ghostApplied) {
    return { kind: 'tear-down', idsToRestore: [...prevGhostSet] };
  }
  if (shouldGhost && !ghostApplied) {
    return {
      kind: 'first-apply',
      idsToGhost: [...nextGhostSet],
      opacity: nextOpacity,
    };
  }
  // shouldGhost && ghostApplied - delta path.
  const delta = computeGhostDelta(prevGhostSet, nextGhostSet);
  if (delta.newlyGhosted.length > 0 || delta.newlyRestored.length > 0) {
    return {
      kind: 'delta',
      newlyGhosted: delta.newlyGhosted,
      newlyRestored: delta.newlyRestored,
      opacity: nextOpacity,
    };
  }
  if (prevOpacity !== nextOpacity && nextGhostSet.size > 0) {
    return {
      kind: 'opacity-only-change',
      ids: [...nextGhostSet],
      opacity: nextOpacity,
    };
  }
  return { kind: 'noop' };
}

// ── Churn tally for synthetic ghost streams (audit telemetry) ────────────────

export interface GhostStreamStep {
  shouldGhost: boolean;
  nextGhostSet: ReadonlySet<number>;
  nextOpacity: number;
}

export interface GhostChurnTally {
  totalSteps: number;
  /** Steps that produced a `setOpacity(...)` call. */
  effectiveSetOpacity: number;
  /** Steps that produced a `resetOpacity(...)` call. */
  effectiveResetOpacity: number;
  /** Steps that produced no renderer write (skip / noop). */
  redundantOpsAvoided: number;
}

/**
 * Replays a stream of ghost-state steps through `decideGhostWork` and counts
 * how many renderer ops the decision helper would actually emit vs how many
 * a naïve "always re-apply" path would emit.
 *
 * Used by audit tests to pin the dedup contract: e.g. a 100-step stream
 * where every step has the same set + opacity should produce
 * `redundantOpsAvoided === 99` (1 first-apply + 99 noops).
 */
export function tallyGhostChurn(
  stream: ReadonlyArray<GhostStreamStep>,
): GhostChurnTally {
  let ghostApplied = false;
  let prevGhostSet: ReadonlySet<number> = new Set();
  let prevOpacity = 0;
  const tally: GhostChurnTally = {
    totalSteps: stream.length,
    effectiveSetOpacity: 0,
    effectiveResetOpacity: 0,
    redundantOpsAvoided: 0,
  };
  for (const step of stream) {
    const plan = decideGhostWork({
      shouldGhost: step.shouldGhost,
      ghostApplied,
      prevGhostSet,
      nextGhostSet: step.nextGhostSet,
      prevOpacity,
      nextOpacity: step.nextOpacity,
    });
    switch (plan.kind) {
      case 'skip':
      case 'noop':
        tally.redundantOpsAvoided += 1;
        break;
      case 'tear-down':
        tally.effectiveResetOpacity += 1;
        ghostApplied = false;
        prevGhostSet = new Set();
        break;
      case 'first-apply':
        tally.effectiveSetOpacity += 1;
        ghostApplied = true;
        prevGhostSet = step.nextGhostSet;
        prevOpacity = step.nextOpacity;
        break;
      case 'delta':
        if (plan.newlyRestored.length > 0) tally.effectiveResetOpacity += 1;
        if (plan.newlyGhosted.length > 0) tally.effectiveSetOpacity += 1;
        prevGhostSet = step.nextGhostSet;
        prevOpacity = step.nextOpacity;
        break;
      case 'opacity-only-change':
        tally.effectiveSetOpacity += 1;
        prevOpacity = step.nextOpacity;
        break;
    }
  }
  return tally;
}
