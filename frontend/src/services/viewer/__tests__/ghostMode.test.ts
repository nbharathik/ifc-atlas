import { describe, expect, it, vi } from 'vitest';
import {
  GHOST_ISOLATION_OPACITY,
  buildGhostIsolateUpdate,
  buildNormalIsolateUpdate,
  computeGhostDelta,
  decideGhostWork,
  isGhostModeEligible,
  tallyGhostChurn,
  type GhostStreamStep,
  applyGhostPostproductionState,
} from '../ghostMode';

/**
 * Vitest unit tests for ghostModeHelpers.
 * Pure functions - no Three.js, no DOM.
 */


// ── isGhostModeEligible ────────────────────────────────────────────────────────

describe('isGhostModeEligible', () => {
  it('returns false for empty array', () => {
    expect(isGhostModeEligible([])).toBe(false);
  });

  it('returns true when at least one element is isolated', () => {
    expect(isGhostModeEligible([1])).toBe(true);
  });

  it('returns true for multiple isolated ids', () => {
    expect(isGhostModeEligible([1, 2, 3])).toBe(true);
  });
});

// ── GHOST_ISOLATION_OPACITY ────────────────────────────────────────────────────

describe('GHOST_ISOLATION_OPACITY', () => {
  it('is a positive number less than 1', () => {
    expect(GHOST_ISOLATION_OPACITY).toBeGreaterThan(0);
    expect(GHOST_ISOLATION_OPACITY).toBeLessThan(1);
  });

  it('is 0.15 (visible but clearly subordinate)', () => {
    expect(GHOST_ISOLATION_OPACITY).toBe(0.15);
  });
});

// ── buildGhostIsolateUpdate ────────────────────────────────────────────────────

describe('buildGhostIsolateUpdate', () => {
  it('shows all elements', () => {
    const all = [1, 2, 3, 4];
    const iso = [2, 4];
    const result = buildGhostIsolateUpdate(all, iso);
    expect(result.showAll).toEqual(all);
  });

  it('ghosts non-isolated elements', () => {
    const all = [1, 2, 3, 4];
    const iso = [2, 4];
    const result = buildGhostIsolateUpdate(all, iso);
    expect(result.ghostIds.sort()).toEqual([1, 3]);
  });

  it('uses GHOST_ISOLATION_OPACITY', () => {
    const result = buildGhostIsolateUpdate([1, 2], [1]);
    expect(result.opacity).toBe(GHOST_ISOLATION_OPACITY);
  });

  it('ghostIds is empty when all elements are isolated', () => {
    const ids = [10, 20, 30];
    const result = buildGhostIsolateUpdate(ids, ids);
    expect(result.ghostIds).toHaveLength(0);
  });

  it('ghostIds equals all when nothing is isolated', () => {
    const all = [1, 2, 3];
    const result = buildGhostIsolateUpdate(all, []);
    expect(result.ghostIds.sort()).toEqual(all);
  });

  it('handles single-element isolation', () => {
    const all = [1, 2, 3];
    const result = buildGhostIsolateUpdate(all, [2]);
    expect(result.ghostIds.sort()).toEqual([1, 3]);
  });

  it('handles empty all-list', () => {
    const result = buildGhostIsolateUpdate([], []);
    expect(result.showAll).toHaveLength(0);
    expect(result.ghostIds).toHaveLength(0);
  });

  it('does not mutate input arrays', () => {
    const all = [1, 2, 3];
    const iso = [1];
    const allCopy = [...all];
    const isoCopy = [...iso];
    buildGhostIsolateUpdate(all, iso);
    expect(all).toEqual(allCopy);
    expect(iso).toEqual(isoCopy);
  });
});

// ── buildNormalIsolateUpdate ───────────────────────────────────────────────────

describe('buildNormalIsolateUpdate', () => {
  it('shows isolated elements', () => {
    const all = [1, 2, 3, 4];
    const iso = [2, 4];
    const result = buildNormalIsolateUpdate(all, iso);
    expect(result.showIds).toEqual(iso);
  });

  it('hides non-isolated elements', () => {
    const all = [1, 2, 3, 4];
    const iso = [2, 4];
    const result = buildNormalIsolateUpdate(all, iso);
    expect(result.hideIds.sort()).toEqual([1, 3]);
  });

  it('hideIds is empty when all elements are isolated', () => {
    const ids = [5, 6, 7];
    const result = buildNormalIsolateUpdate(ids, ids);
    expect(result.hideIds).toHaveLength(0);
  });

  it('showIds is empty when nothing is isolated', () => {
    const result = buildNormalIsolateUpdate([1, 2, 3], []);
    expect(result.showIds).toHaveLength(0);
  });

  it('does not mutate input arrays', () => {
    const all = [1, 2, 3];
    const iso = [1];
    const allCopy = [...all];
    buildNormalIsolateUpdate(all, iso);
    expect(all).toEqual(allCopy);
  });
});

// ── computeGhostDelta ──────────────────────────────────────────────────────────

describe('computeGhostDelta', () => {
  it('returns empty arrays when sets are identical', () => {
    const s = new Set([1, 2, 3]);
    const delta = computeGhostDelta(s, s);
    expect(delta.newlyGhosted).toHaveLength(0);
    expect(delta.newlyRestored).toHaveLength(0);
  });

  it('detects newly ghosted ids', () => {
    const prev = new Set([1]);
    const next = new Set([1, 2, 3]);
    const delta = computeGhostDelta(prev, next);
    expect(delta.newlyGhosted.sort()).toEqual([2, 3]);
    expect(delta.newlyRestored).toHaveLength(0);
  });

  it('detects newly restored ids', () => {
    const prev = new Set([1, 2, 3]);
    const next = new Set([1]);
    const delta = computeGhostDelta(prev, next);
    expect(delta.newlyGhosted).toHaveLength(0);
    expect(delta.newlyRestored.sort()).toEqual([2, 3]);
  });

  it('handles completely different sets', () => {
    const prev = new Set([1, 2]);
    const next = new Set([3, 4]);
    const delta = computeGhostDelta(prev, next);
    expect(delta.newlyGhosted.sort()).toEqual([3, 4]);
    expect(delta.newlyRestored.sort()).toEqual([1, 2]);
  });

  it('handles empty prev set', () => {
    const delta = computeGhostDelta(new Set(), new Set([1, 2]));
    expect(delta.newlyGhosted.sort()).toEqual([1, 2]);
    expect(delta.newlyRestored).toHaveLength(0);
  });

  it('handles empty next set', () => {
    const delta = computeGhostDelta(new Set([1, 2]), new Set());
    expect(delta.newlyGhosted).toHaveLength(0);
    expect(delta.newlyRestored.sort()).toEqual([1, 2]);
  });

  it('handles both empty sets', () => {
    const delta = computeGhostDelta(new Set(), new Set());
    expect(delta.newlyGhosted).toHaveLength(0);
    expect(delta.newlyRestored).toHaveLength(0);
  });
});

// ── decideGhostWork ────────────────────────────────────────────────────────────

describe('decideGhostWork', () => {
  const empty = new Set<number>();

  it('returns skip when ghost-off and never applied', () => {
    const plan = decideGhostWork({
      shouldGhost: false,
      ghostApplied: false,
      prevGhostSet: empty,
      nextGhostSet: new Set([1, 2]),
      prevOpacity: 0,
      nextOpacity: 0.15,
    });
    expect(plan.kind).toBe('skip');
  });

  it('returns tear-down when ghost flips off after being applied', () => {
    const plan = decideGhostWork({
      shouldGhost: false,
      ghostApplied: true,
      prevGhostSet: new Set([1, 2, 3]),
      nextGhostSet: empty,
      prevOpacity: 0.15,
      nextOpacity: 0.15,
    });
    expect(plan.kind).toBe('tear-down');
    if (plan.kind === 'tear-down') {
      expect(plan.idsToRestore.sort()).toEqual([1, 2, 3]);
    }
  });

  it('tear-down clones the prev set (does not leak ReadonlySet)', () => {
    const prev = new Set([7, 8]);
    const plan = decideGhostWork({
      shouldGhost: false,
      ghostApplied: true,
      prevGhostSet: prev,
      nextGhostSet: empty,
      prevOpacity: 0.15,
      nextOpacity: 0.15,
    });
    if (plan.kind === 'tear-down') {
      // Mutating the returned array must not mutate the source set.
      plan.idsToRestore.push(999);
      expect(prev.has(999)).toBe(false);
    }
  });

  it('returns first-apply on initial activation', () => {
    const plan = decideGhostWork({
      shouldGhost: true,
      ghostApplied: false,
      prevGhostSet: empty,
      nextGhostSet: new Set([1, 2, 3]),
      prevOpacity: 0,
      nextOpacity: 0.15,
    });
    expect(plan.kind).toBe('first-apply');
    if (plan.kind === 'first-apply') {
      expect(plan.idsToGhost.sort()).toEqual([1, 2, 3]);
      expect(plan.opacity).toBe(0.15);
    }
  });

  it('first-apply with empty next set is still first-apply (no opacity write needed)', () => {
    // Caller skips the actual setOpacity when idsToGhost is empty;
    // the plan still records the transition.
    const plan = decideGhostWork({
      shouldGhost: true,
      ghostApplied: false,
      prevGhostSet: empty,
      nextGhostSet: empty,
      prevOpacity: 0,
      nextOpacity: 0.15,
    });
    expect(plan.kind).toBe('first-apply');
  });

  it('returns delta when set membership changes', () => {
    const plan = decideGhostWork({
      shouldGhost: true,
      ghostApplied: true,
      prevGhostSet: new Set([1, 2, 3]),
      nextGhostSet: new Set([2, 3, 4]),
      prevOpacity: 0.15,
      nextOpacity: 0.15,
    });
    expect(plan.kind).toBe('delta');
    if (plan.kind === 'delta') {
      expect(plan.newlyGhosted).toEqual([4]);
      expect(plan.newlyRestored).toEqual([1]);
      expect(plan.opacity).toBe(0.15);
    }
  });

  it('delta path matches computeGhostDelta math (parity with ViewerPanel inline)', () => {
    const prev = new Set([10, 20, 30]);
    const next = new Set([20, 30, 40, 50]);
    const inline = computeGhostDelta(prev, next);
    const plan = decideGhostWork({
      shouldGhost: true,
      ghostApplied: true,
      prevGhostSet: prev,
      nextGhostSet: next,
      prevOpacity: 0.2,
      nextOpacity: 0.2,
    });
    if (plan.kind === 'delta') {
      expect(plan.newlyGhosted.sort()).toEqual(inline.newlyGhosted.sort());
      expect(plan.newlyRestored.sort()).toEqual(inline.newlyRestored.sort());
    } else {
      throw new Error(`expected delta, got ${plan.kind}`);
    }
  });

  it('returns opacity-only-change when sets are equal but opacity differs', () => {
    const same = new Set([1, 2, 3]);
    const plan = decideGhostWork({
      shouldGhost: true,
      ghostApplied: true,
      prevGhostSet: same,
      nextGhostSet: new Set([3, 1, 2]), // reordered - same membership
      prevOpacity: 0.15,
      nextOpacity: 0.4,
    });
    expect(plan.kind).toBe('opacity-only-change');
    if (plan.kind === 'opacity-only-change') {
      expect(plan.ids.sort()).toEqual([1, 2, 3]);
      expect(plan.opacity).toBe(0.4);
    }
  });

  it('opacity-only-change with empty set degenerates to noop', () => {
    // If nothing is ghosted, an opacity slider change has no surface to apply to.
    const plan = decideGhostWork({
      shouldGhost: true,
      ghostApplied: true,
      prevGhostSet: empty,
      nextGhostSet: empty,
      prevOpacity: 0.1,
      nextOpacity: 0.5,
    });
    expect(plan.kind).toBe('noop');
  });

  it('returns noop when sets and opacity are identical', () => {
    const same = new Set([5, 6, 7]);
    const plan = decideGhostWork({
      shouldGhost: true,
      ghostApplied: true,
      prevGhostSet: same,
      nextGhostSet: same,
      prevOpacity: 0.15,
      nextOpacity: 0.15,
    });
    expect(plan.kind).toBe('noop');
  });

  it('skip vs noop - both produce no work but signal different lifecycle states', () => {
    const skipPlan = decideGhostWork({
      shouldGhost: false,
      ghostApplied: false,
      prevGhostSet: empty,
      nextGhostSet: empty,
      prevOpacity: 0,
      nextOpacity: 0,
    });
    const noopPlan = decideGhostWork({
      shouldGhost: true,
      ghostApplied: true,
      prevGhostSet: new Set([1]),
      nextGhostSet: new Set([1]),
      prevOpacity: 0.15,
      nextOpacity: 0.15,
    });
    expect(skipPlan.kind).toBe('skip');
    expect(noopPlan.kind).toBe('noop');
  });

  it('does not mutate input sets', () => {
    const prev = new Set([1, 2]);
    const next = new Set([2, 3]);
    decideGhostWork({
      shouldGhost: true,
      ghostApplied: true,
      prevGhostSet: prev,
      nextGhostSet: next,
      prevOpacity: 0.15,
      nextOpacity: 0.15,
    });
    expect([...prev].sort()).toEqual([1, 2]);
    expect([...next].sort()).toEqual([2, 3]);
  });
});

// ── tallyGhostChurn (churn telemetry) ──────────────────────────────────────────

describe('tallyGhostChurn', () => {
  const ghosted = (ids: number[], op = 0.15): GhostStreamStep => ({
    shouldGhost: true,
    nextGhostSet: new Set(ids),
    nextOpacity: op,
  });

  it('counts 1 first-apply + 99 noops for a 100-step stationary ghost', () => {
    const stream: GhostStreamStep[] = Array.from({ length: 100 }, () =>
      ghosted([1, 2, 3]),
    );
    const tally = tallyGhostChurn(stream);
    expect(tally.totalSteps).toBe(100);
    expect(tally.effectiveSetOpacity).toBe(1); // first-apply only
    expect(tally.effectiveResetOpacity).toBe(0);
    expect(tally.redundantOpsAvoided).toBe(99);
  });

  it('counts every skip step when ghost never activates', () => {
    const stream: GhostStreamStep[] = Array.from({ length: 5 }, () => ({
      shouldGhost: false,
      nextGhostSet: new Set([1, 2]),
      nextOpacity: 0.15,
    }));
    const tally = tallyGhostChurn(stream);
    expect(tally.effectiveSetOpacity).toBe(0);
    expect(tally.effectiveResetOpacity).toBe(0);
    expect(tally.redundantOpsAvoided).toBe(5);
  });

  it('toggling ghost on/off n times produces n effective writes per side', () => {
    const stream: GhostStreamStep[] = [
      ghosted([1, 2]),
      { shouldGhost: false, nextGhostSet: new Set(), nextOpacity: 0.15 },
      ghosted([1, 2]),
      { shouldGhost: false, nextGhostSet: new Set(), nextOpacity: 0.15 },
    ];
    const tally = tallyGhostChurn(stream);
    expect(tally.effectiveSetOpacity).toBe(2); // 2 first-applies
    expect(tally.effectiveResetOpacity).toBe(2); // 2 tear-downs
    expect(tally.redundantOpsAvoided).toBe(0);
  });

  it('opacity-slider drag (10 ticks) produces 1 first-apply + 9 opacity-only writes', () => {
    const same = [4, 5, 6];
    const stream: GhostStreamStep[] = Array.from({ length: 10 }, (_v, i) =>
      ghosted(same, 0.1 + i * 0.05),
    );
    const tally = tallyGhostChurn(stream);
    expect(tally.effectiveSetOpacity).toBe(10); // 1 first-apply + 9 opacity-only
    expect(tally.effectiveResetOpacity).toBe(0);
    expect(tally.redundantOpsAvoided).toBe(0);
  });

  it('membership add then remove counts both sides of the delta', () => {
    const stream: GhostStreamStep[] = [
      ghosted([1, 2]),
      ghosted([1, 2, 3]), // delta: add 3 → +1 setOpacity
      ghosted([1, 2]), // delta: remove 3 → +1 resetOpacity
    ];
    const tally = tallyGhostChurn(stream);
    expect(tally.effectiveSetOpacity).toBe(2); // first-apply + 1 delta-add
    expect(tally.effectiveResetOpacity).toBe(1); // 1 delta-remove
    expect(tally.redundantOpsAvoided).toBe(0);
  });

  it('empty stream produces zero counts', () => {
    const tally = tallyGhostChurn([]);
    expect(tally.totalSteps).toBe(0);
    expect(tally.effectiveSetOpacity).toBe(0);
    expect(tally.effectiveResetOpacity).toBe(0);
    expect(tally.redundantOpsAvoided).toBe(0);
  });
});

// ── Isolate-ghost path contract ────────────────────────────────────────────────
//
// The isolate-ghost path in ViewerPanel.tsx (visibility useEffect,
// `if (isolatedIds.length > 0) → if (ghostOn)` branch) calls
// `decideGhostWork(...)` with inputs that differ from the selection-focus
// path. These tests pin the helper's behaviour for inputs the isolate
// path produces:
//   - `nextGhostSet = allLocalIds − isolatedLocal` (the non-isolated set)
//   - `nextOpacity = constant GHOST_ISOLATION_OPACITY` (0.15)
//   - `ghostApplied = isolateGhostAppliedLocalSetRef.current.size > 0`
//
// Selection-focus opacity can vary via the slider (covered by the
// `opacity-only-change` tests above); the isolate path uses a fixed
// constant so its opacity-only-change case is defensive-only today.
// These pins are the regression oracle for the isolate-ghost wire-up - a
// regression in any of them would silently re-introduce the model-wide
// reset that the wire-up was added to remove.

describe('decideGhostWork - isolate-path contract', () => {
  // Simulated model of 10 local ids. Isolate-path "non-isolated" set
  // = `ALL − isolated`. New Set returned each call so referential
  // equality cannot accidentally satisfy a noop assertion.
  const ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
  const ISO_GHOST_OP = 0.15;
  const nonIso = (isolated: number[]): Set<number> => {
    const isoSet = new Set(isolated);
    return new Set(ALL.filter((id) => !isoSet.has(id)));
  };

  it('first isolate while ghost-on: first-apply on every non-isolated id', () => {
    const plan = decideGhostWork({
      shouldGhost: true,
      ghostApplied: false,
      prevGhostSet: new Set<number>(),
      nextGhostSet: nonIso([5]),
      prevOpacity: 0,
      nextOpacity: ISO_GHOST_OP,
    });
    expect(plan.kind).toBe('first-apply');
    if (plan.kind === 'first-apply') {
      expect(plan.idsToGhost.sort((a, b) => a - b)).toEqual([
        1, 2, 3, 4, 6, 7, 8, 9, 10,
      ]);
      expect(plan.opacity).toBe(ISO_GHOST_OP);
    }
  });

  it('identical isolate re-fire (brand-new Set, same membership) → noop', () => {
    // Hot-path budget assertion: zero extra renderer round-trips on a
    // same-set re-fire. The wire-up's noop branch is the only branch
    // that satisfies this - a regression to the old model-wide reset
    // would surface here as `first-apply` or `delta`.
    const plan = decideGhostWork({
      shouldGhost: true,
      ghostApplied: true,
      prevGhostSet: nonIso([5]),
      nextGhostSet: nonIso([5]),
      prevOpacity: ISO_GHOST_OP,
      nextOpacity: ISO_GHOST_OP,
    });
    expect(plan.kind).toBe('noop');
  });

  it('isolation grows ([5] → [5,6]): delta restores 6 (newlyRestored only)', () => {
    // User adds element 6 to the isolated set. Element 6 was previously
    // ghosted (non-isolated); now it should be restored to full opacity.
    // No new elements become ghosted, so `newlyGhosted` is empty.
    const plan = decideGhostWork({
      shouldGhost: true,
      ghostApplied: true,
      prevGhostSet: nonIso([5]),
      nextGhostSet: nonIso([5, 6]),
      prevOpacity: ISO_GHOST_OP,
      nextOpacity: ISO_GHOST_OP,
    });
    expect(plan.kind).toBe('delta');
    if (plan.kind === 'delta') {
      expect(plan.newlyRestored).toEqual([6]);
      expect(plan.newlyGhosted).toEqual([]);
      expect(plan.opacity).toBe(ISO_GHOST_OP);
    }
  });

  it('isolation shrinks ([5,6] → [5]): delta ghosts 6 (newlyGhosted only)', () => {
    // User removes element 6 from the isolated set. Element 6 becomes
    // non-isolated, so it should be ghosted. No previously-ghosted
    // elements become isolated, so `newlyRestored` is empty.
    const plan = decideGhostWork({
      shouldGhost: true,
      ghostApplied: true,
      prevGhostSet: nonIso([5, 6]),
      nextGhostSet: nonIso([5]),
      prevOpacity: ISO_GHOST_OP,
      nextOpacity: ISO_GHOST_OP,
    });
    expect(plan.kind).toBe('delta');
    if (plan.kind === 'delta') {
      expect(plan.newlyGhosted).toEqual([6]);
      expect(plan.newlyRestored).toEqual([]);
      expect(plan.opacity).toBe(ISO_GHOST_OP);
    }
  });

  it('100-step identical isolate re-fire: 1 first-apply + 99 noops via tallyGhostChurn', () => {
    // The exact stream-churn assertion called out in the wire-up brief.
    // Each step constructs a brand-new Set with the same membership -
    // referential equality cannot mask a regression.
    const stream: GhostStreamStep[] = Array.from({ length: 100 }, () => ({
      shouldGhost: true,
      nextGhostSet: nonIso([3, 4]),
      nextOpacity: ISO_GHOST_OP,
    }));
    const tally = tallyGhostChurn(stream);
    expect(tally.totalSteps).toBe(100);
    expect(tally.effectiveSetOpacity).toBe(1);
    expect(tally.effectiveResetOpacity).toBe(0);
    expect(tally.redundantOpsAvoided).toBe(99);
  });

  it('ghost flip-off mid-isolate: tear-down restores every previously-ghosted id', () => {
    // ViewerPanel.tsx's normal-isolate branch clears the isolate-ghost
    // refs after firing `resetOpacity(undefined)` - this is the helper-
    // level view of the same transition. shouldGhost=false +
    // ghostApplied=true ⇒ tear-down with the prev ghost set as
    // idsToRestore.
    const prev = nonIso([5]);
    const plan = decideGhostWork({
      shouldGhost: false,
      ghostApplied: true,
      prevGhostSet: prev,
      nextGhostSet: new Set<number>(),
      prevOpacity: ISO_GHOST_OP,
      nextOpacity: ISO_GHOST_OP,
    });
    expect(plan.kind).toBe('tear-down');
    if (plan.kind === 'tear-down') {
      expect(plan.idsToRestore.sort((a, b) => a - b)).toEqual([
        1, 2, 3, 4, 6, 7, 8, 9, 10,
      ]);
    }
  });

  it('toggle-isolation churn ([5] → [5,6] → [5,6,7] → [5,6] → [5]) sums to balanced delta ops', () => {
    // Four delta transitions: two grow (newlyRestored), two shrink
    // (newlyGhosted). Each delta with a non-empty newlyGhosted increments
    // effectiveSetOpacity; each with non-empty newlyRestored increments
    // effectiveResetOpacity. Plus the leading first-apply.
    const stream: GhostStreamStep[] = [
      { shouldGhost: true, nextGhostSet: nonIso([5]), nextOpacity: ISO_GHOST_OP },
      { shouldGhost: true, nextGhostSet: nonIso([5, 6]), nextOpacity: ISO_GHOST_OP },
      { shouldGhost: true, nextGhostSet: nonIso([5, 6, 7]), nextOpacity: ISO_GHOST_OP },
      { shouldGhost: true, nextGhostSet: nonIso([5, 6]), nextOpacity: ISO_GHOST_OP },
      { shouldGhost: true, nextGhostSet: nonIso([5]), nextOpacity: ISO_GHOST_OP },
    ];
    const tally = tallyGhostChurn(stream);
    expect(tally.totalSteps).toBe(5);
    // first-apply (1) + 2 shrinks each producing newlyGhosted = 3 setOpacity calls
    expect(tally.effectiveSetOpacity).toBe(3);
    // 2 grows each producing newlyRestored = 2 resetOpacity calls
    expect(tally.effectiveResetOpacity).toBe(2);
    // All steps produced work; none redundant.
    expect(tally.redundantOpsAvoided).toBe(0);
  });
});

describe('Shift+G ghost-toggle useEffect contract', () => {
  // The secondary ghost-toggle useEffect in ViewerPanel.tsx (~L3592)
  // previously called `model.resetOpacity(undefined)` on every Shift+G
  // flip when isolation was active. It now narrows the ghost-OFF branch
  // to dispatch through `decideGhostWork`, reusing the same refs
  // (`isolateGhostAppliedLocalSetRef` / `isolateGhostAppliedOpacityRef`)
  // that the L778 visibility useEffect maintains. The contract pinned
  // below is the exact decision the new branch makes - it must always
  // resolve to either `tear-down` (when refs were populated by a prior
  // ghost application) or `skip` (when refs were empty). Anything else
  // would mean the wire-up has drifted.

  const ISO = [5, 6, 7]; // express ids the user isolated
  const NON_ISO_LOCAL = [10, 11, 12, 13, 14]; // local ids of the rest

  it('ghost-on then ghost-off → tear-down restores opacity on the exact previously-ghosted ids', () => {
    // Simulate L778's ghost-on isolate branch populating the refs first.
    let appliedSet: ReadonlySet<number> = new Set(NON_ISO_LOCAL);
    let appliedOpacity = 0.15; // GHOST_ISOLATION_OPACITY

    // Now the user presses Shift+G OFF. L3592 fires the ghost-off branch.
    const plan = decideGhostWork({
      shouldGhost: false,
      ghostApplied: appliedSet.size > 0,
      prevGhostSet: appliedSet,
      nextGhostSet: new Set<number>(),
      prevOpacity: appliedOpacity,
      nextOpacity: 0,
    });

    expect(plan.kind).toBe('tear-down');
    if (plan.kind === 'tear-down') {
      // The only opacity work done is on the exact previously-ghosted set
      // - NOT model-wide. This is the headline savings vs the previous
      // `model.resetOpacity(undefined)` (which would have scrubbed every
      // id in the model, including iso elements and any hidden ids).
      expect(plan.idsToRestore.sort((a, b) => a - b)).toEqual([...NON_ISO_LOCAL]);
      expect(plan.idsToRestore).not.toContain(ISO[0]);
    }

    // After the L3592 branch executes, it clears the refs to keep them in
    // sync with the renderer (no opacity applied anywhere from this path).
    appliedSet = new Set();
    appliedOpacity = 0;
    expect(appliedSet.size).toBe(0);
    expect(appliedOpacity).toBe(0);
  });

  it('ghost-off with no prior ghost (refs empty) → skip; no opacity op fires', () => {
    // Defensive case: the refs are empty (e.g. user toggles Shift+G off
    // when ghost was never on for the current iso, or model just loaded).
    // The previous code unconditionally called
    // `model.resetOpacity(undefined)` here - a worker round-trip with
    // nothing to undo. The new dispatch resolves to `skip` and emits no
    // op at all.
    const plan = decideGhostWork({
      shouldGhost: false,
      ghostApplied: false, // refs are empty
      prevGhostSet: new Set(),
      nextGhostSet: new Set(),
      prevOpacity: 0,
      nextOpacity: 0,
    });

    expect(plan.kind).toBe('skip');
  });

  it('L778-ghost-on → L3592-ghost-off → L778-iso-cleared keeps refs in sync (no drift)', () => {
    // Cross-useEffect invariant: after the full ghost+iso lifecycle, the
    // shared refs must end up empty so a fresh iso+ghost cycle re-enters
    // first-apply rather than mis-computing a delta against a stale set.
    // This sequence is exactly what a user does: isolate, Shift+G ON,
    // Shift+G OFF, clear isolation.

    // Step 1: L778 ghost-on isolate branch (simulated).
    let appliedSet: Set<number> = new Set();
    let appliedOpacity = 0;
    let p = decideGhostWork({
      shouldGhost: true,
      ghostApplied: false,
      prevGhostSet: appliedSet,
      nextGhostSet: new Set(NON_ISO_LOCAL),
      prevOpacity: 0,
      nextOpacity: 0.15,
    });
    expect(p.kind).toBe('first-apply');
    if (p.kind === 'first-apply') {
      appliedSet = new Set(p.idsToGhost);
      appliedOpacity = p.opacity;
    }
    expect(appliedSet.size).toBe(NON_ISO_LOCAL.length);

    // Step 2: L3592 ghost-off branch (the dispatch under test).
    p = decideGhostWork({
      shouldGhost: false,
      ghostApplied: appliedSet.size > 0,
      prevGhostSet: appliedSet,
      nextGhostSet: new Set(),
      prevOpacity: appliedOpacity,
      nextOpacity: 0,
    });
    expect(p.kind).toBe('tear-down');
    appliedSet = new Set();
    appliedOpacity = 0;

    // Step 3: L778 fires again when the user clears iso (iso=[]). With
    // the refs cleared correctly in step 2, the next isolate+ghost cycle
    // would correctly re-enter first-apply. Verify by simulating one.
    p = decideGhostWork({
      shouldGhost: true,
      ghostApplied: appliedSet.size > 0,
      prevGhostSet: appliedSet,
      nextGhostSet: new Set([20, 21, 22]), // different nonIso this time
      prevOpacity: appliedOpacity,
      nextOpacity: 0.15,
    });
    expect(p.kind).toBe('first-apply');
    if (p.kind === 'first-apply') {
      expect(p.idsToGhost.sort((a, b) => a - b)).toEqual([20, 21, 22]);
    }
  });
});

describe('applyGhostPostproductionState', () => {
  it('disables postproduction and xray when ghost mode is off', () => {
    const pp = { enabled: true, edgesPass: { xray: true, mode: 'quality' } };

    const snapshot = applyGhostPostproductionState(pp, {
      ghostModeOn: false,
      navigating: false,
      fastEdgeMode: 'fast',
    });

    expect(snapshot).toEqual({ enabled: false, xray: false, mode: 'quality' });
    expect(pp.enabled).toBe(false);
    expect(pp.edgesPass.xray).toBe(false);
  });

  it('uses fast edge mode and disables postproduction while navigating', () => {
    const pp = { enabled: true, edgesPass: { xray: false, mode: 'quality' } };

    const snapshot = applyGhostPostproductionState(pp, {
      ghostModeOn: true,
      navigating: true,
      fastEdgeMode: 'fast',
    });

    expect(snapshot).toEqual({ enabled: false, xray: true, mode: 'fast' });
    expect(pp.enabled).toBe(false);
    expect(pp.edgesPass.xray).toBe(true);
    expect(pp.edgesPass.mode).toBe('fast');
  });

  it('keeps the composer disabled at rest (edges never render in the COLOR style chain)', () => {
    const pp = { enabled: false, edgesPass: { xray: true, mode: 'fast' } };

    const snapshot = applyGhostPostproductionState(pp, {
      ghostModeOn: true,
      navigating: false,
      fastEdgeMode: 'fast',
    });

    // Enabling the composer paid a second full scene pass for output
    // identical to the plain render (the edges pass is only in PEN-family
    // style chains, which the app never sets). Edge state is still staged
    // for a future PEN-style edges feature.
    expect(snapshot).toEqual({ enabled: false, xray: true, mode: 'fast' });
    expect(pp.enabled).toBe(false);
    expect(pp.edgesPass.xray).toBe(true);
  });

  it('turns the composer off when ghost mode was on and pp was somehow enabled', () => {
    const pp = { enabled: true, edgesPass: { xray: false, mode: 'quality' } };

    const snapshot = applyGhostPostproductionState(pp, {
      ghostModeOn: true,
      navigating: false,
      fastEdgeMode: 'fast',
    });

    expect(snapshot?.enabled).toBe(false);
    expect(pp.enabled).toBe(false);
  });
});
