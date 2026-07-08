/**
 * Vitest unit tests for ghostModeHelpers.
 * Pure functions - no Three.js, no DOM.
 */

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
} from '../ghostModeHelpers';
import { createRebuildScheduler } from '../rebuildScheduler';

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

// ── Opacity-slider drag throttle contract ────────────────────────────────────
//
// Profiling measured up to ~60 `selectionGhostOpacity` writes/second
// during a continuous slider drag, each one firing a fresh fire-and-forget
// `apply()` in `ViewerPanel.tsx` that raced worker round-trips. ViewerPanel
// wraps the selection-focus useEffect in `createRebuildScheduler` so N
// schedule() calls within one frame collapse to one apply that reads the
// latest opacity from `useStore.getState()`. These tests pin the
// scheduler + decideGhostWork combination at the contract level - the
// production wiring just plugs the same pieces together with
// `window.requestAnimationFrame` instead of the fake driver below.

function makeFakeRaf() {
  const queue: Array<{ handle: number; cb: () => void; cancelled: boolean }> = [];
  let nextHandle = 1;
  const raf = vi.fn((cb: () => void) => {
    const handle = nextHandle++;
    queue.push({ handle, cb, cancelled: false });
    return handle;
  });
  const cancelRaf = vi.fn((handle: number) => {
    const entry = queue.find((e) => e.handle === handle);
    if (entry) entry.cancelled = true;
  });
  const flush = () => {
    const pending = queue.splice(0, queue.length);
    for (const entry of pending) {
      if (!entry.cancelled) entry.cb();
    }
  };
  return { raf, cancelRaf, flush };
}

describe('opacity-slider drag throttle', () => {
  it('60 slider ticks within one frame collapse to one effective setOpacity at the final opacity', () => {
    // Models a continuous drag where the user moves the range input 60
    // times before the next animation frame. Each tick mutates a fake
    // store; the scheduler should observe one rAF and the apply() should
    // see the FINAL opacity, not the first or any intermediate value.
    const fake = makeFakeRaf();
    let storeOpacity = 0.15;
    const ghostSet = new Set([1, 2, 3]);
    // Start in the steady ghost-applied state (after a prior first-apply).
    let appliedOpacity = 0.15;
    let ghostApplied = true;
    const ops: Array<{ kind: string; opacity: number; ids: number }> = [];

    const run = () => {
      const plan = decideGhostWork({
        shouldGhost: true,
        ghostApplied,
        prevGhostSet: ghostSet,
        nextGhostSet: ghostSet,
        prevOpacity: appliedOpacity,
        nextOpacity: storeOpacity,
      });
      if (plan.kind === 'opacity-only-change') {
        ops.push({ kind: plan.kind, opacity: plan.opacity, ids: plan.ids.length });
        appliedOpacity = plan.opacity;
      } else if (plan.kind === 'first-apply') {
        ops.push({ kind: plan.kind, opacity: plan.opacity, ids: plan.idsToGhost.length });
        appliedOpacity = plan.opacity;
        ghostApplied = true;
      }
    };
    const scheduler = createRebuildScheduler({
      raf: fake.raf,
      cancelRaf: fake.cancelRaf,
      run,
    });

    // 60 slider ticks: opacity walks 0.15 → 0.60 in 0.0075 steps.
    for (let i = 0; i < 60; i++) {
      storeOpacity = 0.15 + (i + 1) * 0.0075;
      scheduler.schedule();
    }
    // Only ONE rAF queued for the entire burst - the scheduler is
    // single-flight per frame.
    expect(fake.raf).toHaveBeenCalledTimes(1);
    fake.flush();

    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe('opacity-only-change');
    expect(ops[0].opacity).toBeCloseTo(0.6);
    expect(ops[0].ids).toBe(3);
  });

  it('60 ticks spread across 4 frames produce 4 effective ops, each at its frame final opacity', () => {
    // Demonstrates the scheduler doesn't *suppress* work across frames;
    // it only collapses within one. A slow continuous drag that lasts
    // multiple frames still produces a write per frame, at the latest
    // value at that frame's end.
    const fake = makeFakeRaf();
    let storeOpacity = 0.15;
    const ghostSet = new Set([1, 2]);
    let appliedOpacity = 0.15;
    const opacities: number[] = [];

    const run = () => {
      const plan = decideGhostWork({
        shouldGhost: true,
        ghostApplied: true,
        prevGhostSet: ghostSet,
        nextGhostSet: ghostSet,
        prevOpacity: appliedOpacity,
        nextOpacity: storeOpacity,
      });
      if (plan.kind === 'opacity-only-change') {
        opacities.push(plan.opacity);
        appliedOpacity = plan.opacity;
      }
    };
    const scheduler = createRebuildScheduler({
      raf: fake.raf,
      cancelRaf: fake.cancelRaf,
      run,
    });

    for (let frame = 0; frame < 4; frame++) {
      for (let tick = 0; tick < 15; tick++) {
        storeOpacity = 0.20 + frame * 0.10 + tick * 0.001;
        scheduler.schedule();
      }
      fake.flush();
    }

    expect(opacities).toHaveLength(4);
    expect(opacities[0]).toBeCloseTo(0.20 + 14 * 0.001);
    expect(opacities[1]).toBeCloseTo(0.30 + 14 * 0.001);
    expect(opacities[2]).toBeCloseTo(0.40 + 14 * 0.001);
    expect(opacities[3]).toBeCloseTo(0.50 + 14 * 0.001);
  });

  it('same-opacity re-fire within one frame produces zero renderer ops (noop)', () => {
    // Subscriber notifications that don't actually move the slider
    // (e.g. React's StrictMode double-invoke, or an unrelated dep ref
    // changing identity) must NOT round-trip the worker. The noop
    // branch of decideGhostWork is the regression oracle.
    const fake = makeFakeRaf();
    const ghostSet = new Set([10, 20, 30]);
    const ops: string[] = [];

    const run = () => {
      const plan = decideGhostWork({
        shouldGhost: true,
        ghostApplied: true,
        prevGhostSet: ghostSet,
        nextGhostSet: ghostSet,
        prevOpacity: 0.22,
        nextOpacity: 0.22,
      });
      if (plan.kind === 'opacity-only-change' || plan.kind === 'first-apply' || plan.kind === 'delta') {
        ops.push(plan.kind);
      }
    };
    const scheduler = createRebuildScheduler({
      raf: fake.raf,
      cancelRaf: fake.cancelRaf,
      run,
    });

    for (let i = 0; i < 10; i++) scheduler.schedule();
    expect(fake.raf).toHaveBeenCalledTimes(1);
    fake.flush();

    // Zero effective renderer ops - the apply ran once but decided noop.
    expect(ops).toHaveLength(0);
  });

  it('mixed burst within one frame - opacity changes AND set changes - produces one delta-or-opacity op', () => {
    // Worst-case slider drag: opacity moves AND the focus set changes
    // (user wiggles selection while dragging). Both should collapse to
    // a single frame-end op that reflects the FINAL state.
    const fake = makeFakeRaf();
    let storeOpacity = 0.15;
    let nextSetIds: number[] = [1, 2, 3];
    let appliedOpacity = 0.15;
    let prevSet: Set<number> = new Set([1, 2, 3]);
    const ops: Array<{ kind: string; opacity: number }> = [];

    const run = () => {
      const nextSet = new Set(nextSetIds);
      const plan = decideGhostWork({
        shouldGhost: true,
        ghostApplied: true,
        prevGhostSet: prevSet,
        nextGhostSet: nextSet,
        prevOpacity: appliedOpacity,
        nextOpacity: storeOpacity,
      });
      if (plan.kind === 'delta' || plan.kind === 'opacity-only-change') {
        ops.push({ kind: plan.kind, opacity: plan.opacity });
        prevSet = nextSet;
        appliedOpacity = plan.opacity;
      }
    };
    const scheduler = createRebuildScheduler({
      raf: fake.raf,
      cancelRaf: fake.cancelRaf,
      run,
    });

    // 5 ticks: opacity changes each tick, set grows on tick 3.
    storeOpacity = 0.20; scheduler.schedule();
    storeOpacity = 0.25; scheduler.schedule();
    nextSetIds = [1, 2, 3, 4]; storeOpacity = 0.30; scheduler.schedule();
    storeOpacity = 0.35; scheduler.schedule();
    storeOpacity = 0.40; scheduler.schedule();

    expect(fake.raf).toHaveBeenCalledTimes(1);
    fake.flush();

    expect(ops).toHaveLength(1);
    // Final state: set differs from prev (+id 4) → delta plan.
    expect(ops[0].kind).toBe('delta');
    expect(ops[0].opacity).toBeCloseTo(0.40);
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
