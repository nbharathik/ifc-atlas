import { describe, it, expect } from 'vitest';
import {
  computeVisibilityMode,
  decideVisibilityWork,
  countVisibilityChurn,
  planInvisibleSetTransition,
  tallyVisibilityActions,
  type VisibilitySnapshot,
} from '../visibilityRebuildHelpers';

const snap = (
  isolatedIds: number[],
  hiddenIds: number[],
  ghostModeOn = false,
): VisibilitySnapshot => ({ isolatedIds, hiddenIds, ghostModeOn });

describe('computeVisibilityMode', () => {
  it('returns "isolate" when isolatedIds is non-empty (regardless of hiddenIds)', () => {
    expect(computeVisibilityMode(snap([1], []))).toBe('isolate');
    expect(computeVisibilityMode(snap([1], [2]))).toBe('isolate');
    expect(computeVisibilityMode(snap([1], [2], true))).toBe('isolate');
  });

  it('returns "hide" when isolatedIds is empty AND hiddenIds is non-empty', () => {
    expect(computeVisibilityMode(snap([], [3]))).toBe('hide');
    expect(computeVisibilityMode(snap([], [3, 4]))).toBe('hide');
  });

  it('returns "reset" when both lists are empty', () => {
    expect(computeVisibilityMode(snap([], []))).toBe('reset');
    // Ghost flag does NOT change the mode - it only modulates 'isolate'.
    expect(computeVisibilityMode(snap([], [], true))).toBe('reset');
  });

  it('treats 0 as a real express ID (not coerced to empty)', () => {
    expect(computeVisibilityMode(snap([0], []))).toBe('isolate');
    expect(computeVisibilityMode(snap([], [0]))).toBe('hide');
  });
});

describe('decideVisibilityWork', () => {
  it('skips when both id sets and ghost flag are identical', () => {
    const a = snap([1, 2], [3, 4], false);
    const b = snap([1, 2], [3, 4], false);
    expect(decideVisibilityWork(a, b).skip).toBe(true);
  });

  it('skips when isolated set is reordered (set equality, not array equality)', () => {
    const a = snap([1, 2, 3], [], false);
    const b = snap([3, 1, 2], [], false);
    expect(decideVisibilityWork(a, b).skip).toBe(true);
  });

  it('skips when hidden set is reordered', () => {
    const a = snap([], [7, 8, 9], false);
    const b = snap([], [9, 7, 8], false);
    expect(decideVisibilityWork(a, b).skip).toBe(true);
  });

  it('does NOT skip when isolated set membership changes', () => {
    expect(decideVisibilityWork(snap([1, 2], []), snap([1, 3], [])).skip).toBe(false);
  });

  it('does NOT skip when hidden set membership changes', () => {
    expect(decideVisibilityWork(snap([], [1, 2]), snap([], [1, 3])).skip).toBe(false);
  });

  it('does NOT skip when ghost flag flips even if id sets are equal', () => {
    const a = snap([1, 2], [], false);
    const b = snap([1, 2], [], true);
    expect(decideVisibilityWork(a, b).skip).toBe(false);
  });

  it('does NOT skip on length change (single-side add)', () => {
    expect(decideVisibilityWork(snap([1], []), snap([1, 2], [])).skip).toBe(false);
    expect(decideVisibilityWork(snap([1, 2], []), snap([1], [])).skip).toBe(false);
  });

  it('mode field tracks the NEXT snapshot, not prev', () => {
    expect(decideVisibilityWork(snap([1], []), snap([], [])).mode).toBe('reset');
    expect(decideVisibilityWork(snap([], []), snap([], [3])).mode).toBe('hide');
    expect(decideVisibilityWork(snap([], [3]), snap([5], [])).mode).toBe('isolate');
  });

  it('returns ReadonlySet views of prev + next for both isolated and hidden', () => {
    const d = decideVisibilityWork(snap([1, 2], [3]), snap([2, 1], [3, 4]));
    expect(d.prevIsolated).toEqual(new Set([1, 2]));
    expect(d.nextIsolated).toEqual(new Set([1, 2]));
    expect(d.prevHidden).toEqual(new Set([3]));
    expect(d.nextHidden).toEqual(new Set([3, 4]));
  });

  it('treats 0 as a real express ID', () => {
    expect(decideVisibilityWork(snap([0], []), snap([0], [])).skip).toBe(true);
    expect(decideVisibilityWork(snap([], []), snap([0], [])).skip).toBe(false);
  });

  it('initial empty → empty snapshot is a skip (no spurious first-tick rebuild)', () => {
    expect(decideVisibilityWork(snap([], []), snap([], [])).skip).toBe(true);
  });
});

describe('planInvisibleSetTransition', () => {
  it('writes nothing when the invisible set is unchanged', () => {
    const plan = planInvisibleSetTransition(new Set([1, 2, 3]), new Set([1, 2, 3]));
    expect(plan.toShow).toEqual([]);
    expect(plan.toHide).toEqual([]);
  });

  it('writes only the symmetric difference on isolate-to-isolate transitions', () => {
    // isolate A hid {2,3}; isolate B hides {1,3}: show 2, hide 1; 3 untouched.
    const plan = planInvisibleSetTransition(new Set([2, 3]), new Set([1, 3]));
    expect(plan.toShow).toEqual([2]);
    expect(plan.toHide).toEqual([1]);
  });

  it('handles empty-to-hidden and hidden-to-empty transitions', () => {
    const enter = planInvisibleSetTransition(new Set(), new Set([5, 6]));
    expect(enter.toShow).toEqual([]);
    expect(enter.toHide).toEqual([5, 6]);

    const leave = planInvisibleSetTransition(new Set([5, 6]), new Set());
    expect(leave.toShow).toEqual([5, 6]);
    expect(leave.toHide).toEqual([]);
  });

  it('treats 0 as a real local id', () => {
    const plan = planInvisibleSetTransition(new Set([0]), new Set([1]));
    expect(plan.toShow).toEqual([0]);
    expect(plan.toHide).toEqual([1]);
  });
});

describe('countVisibilityChurn', () => {
  it('counts a single rebuild for one membership change after the empty baseline', () => {
    const c = countVisibilityChurn([
      snap([1, 2], [], false),
    ]);
    expect(c.rebuildCalls).toBe(1);
    expect(c.coreUpdateCalls).toBe(1);
    expect(c.skippedTicks).toBe(0);
  });

  it('dedups a reordered id list (matches the selection set-equality contract)', () => {
    const c = countVisibilityChurn([
      snap([1, 2, 3], [], false),
      snap([3, 1, 2], [], false), // skip
      snap([2, 3, 1], [], false), // skip
    ]);
    expect(c.rebuildCalls).toBe(1);
    expect(c.skippedTicks).toBe(2);
  });

  it('counts a rebuild when only the ghost flag flips', () => {
    const c = countVisibilityChurn([
      snap([1, 2], [], false),
      snap([1, 2], [], true),  // rebuild - ghost flip
      snap([1, 2], [], true),  // skip
    ]);
    expect(c.rebuildCalls).toBe(2);
    expect(c.skippedTicks).toBe(1);
  });

  it('coreUpdateCalls === rebuildCalls (one fm.core.update per rebuild)', () => {
    const c = countVisibilityChurn([
      snap([1], [], false),
      snap([1, 2], [], false),
      snap([1, 2, 3], [], false),
      snap([], [], false),
      snap([], [9], false),
    ]);
    expect(c.coreUpdateCalls).toBe(c.rebuildCalls);
    expect(c.rebuildCalls).toBe(5);
  });

  it('resetTicks counts only "reset" rebuilds', () => {
    const c = countVisibilityChurn([
      snap([1], [], false),    // isolate rebuild
      snap([], [], false),     // reset rebuild
      snap([], [2], false),    // hide rebuild
      snap([], [], false),     // reset rebuild
    ]);
    expect(c.rebuildCalls).toBe(4);
    expect(c.resetTicks).toBe(2);
  });

  it('a long identical stream produces 1 rebuild + (n-1) skips', () => {
    const stream = Array.from({ length: 50 }, () => snap([7, 8, 9], [], false));
    const c = countVisibilityChurn(stream);
    expect(c.rebuildCalls).toBe(1);
    expect(c.skippedTicks).toBe(49);
  });

  it('empty input stream yields all zero counters', () => {
    const c = countVisibilityChurn([]);
    expect(c).toEqual({
      rebuildCalls: 0,
      skippedTicks: 0,
      resetTicks: 0,
      coreUpdateCalls: 0,
    });
  });
});

describe('tallyVisibilityActions - current vs coalesced rebuild counts', () => {
  it('setIsolatedIds-style action (both keys change) yields 2 sync rebuilds currently → 1 once coalesced', () => {
    // Pin the smoking-gun pattern in useStore.ts:
    //   setIsolatedIds: (ids) => set({ isolatedIds: ids, hiddenIds: [] })
    // Starting from a state where hiddenIds is non-empty, both keys mutate.
    const effects = tallyVisibilityActions(
      snap([], [3, 4], false),
      [snap([1, 2], [], false)],
    );
    expect(effects).toHaveLength(1);
    expect(effects[0].isolatedChanged).toBe(true);
    expect(effects[0].hiddenChanged).toBe(true);
    expect(effects[0].syncRebuildsCurrent).toBe(2);
    expect(effects[0].syncRebuildsCoalesced).toBe(1);
  });

  it('clearVisibility-style action collapses 2 sync rebuilds → 1', () => {
    // Pin the second smoking-gun pattern:
    //   clearVisibility: () => set({ isolatedIds: [], hiddenIds: [], ... })
    const effects = tallyVisibilityActions(
      snap([1, 2], [3, 4], false),
      [snap([], [], false)],
    );
    expect(effects[0].syncRebuildsCurrent).toBe(2);
    expect(effects[0].syncRebuildsCoalesced).toBe(1);
  });

  it('addHiddenIds-style action collapses 2 sync rebuilds → 1 even if isolatedIds was already empty before merge', () => {
    // addHiddenIds writes both keys when isolatedIds was non-empty before;
    // the from-empty case still mutates the isolatedIds key (same array
    // identity replaced with []), and our audit counts it as changed only
    // if membership differs. Pin both branches.
    const fromIsolated = tallyVisibilityActions(
      snap([1, 2], [], false),
      [snap([], [5, 6], false)],
    );
    expect(fromIsolated[0].syncRebuildsCurrent).toBe(2);
    expect(fromIsolated[0].syncRebuildsCoalesced).toBe(1);

    const fromEmpty = tallyVisibilityActions(
      snap([], [], false),
      [snap([], [5, 6], false)],
    );
    // isolatedIds: [] → [] (no membership change), only hidden changed.
    expect(fromEmpty[0].isolatedChanged).toBe(false);
    expect(fromEmpty[0].hiddenChanged).toBe(true);
    expect(fromEmpty[0].syncRebuildsCurrent).toBe(1);
    expect(fromEmpty[0].syncRebuildsCoalesced).toBe(1);
  });

  it('a single-key change (setHiddenIds-style) emits exactly 1 sync rebuild either way', () => {
    const effects = tallyVisibilityActions(
      snap([], [1], false),
      [snap([], [2], false)],
    );
    expect(effects[0].syncRebuildsCurrent).toBe(1);
    expect(effects[0].syncRebuildsCoalesced).toBe(1);
  });

  it('a no-op action (snapshot identical) emits 0 sync rebuilds', () => {
    const effects = tallyVisibilityActions(
      snap([1], [], false),
      [snap([1], [], false)],
    );
    expect(effects[0].isolatedChanged).toBe(false);
    expect(effects[0].hiddenChanged).toBe(false);
    expect(effects[0].syncRebuildsCurrent).toBe(0);
    expect(effects[0].syncRebuildsCoalesced).toBe(0);
  });

  it('ghost-only flip counts as a coalesced rebuild but neither id key changed', () => {
    const effects = tallyVisibilityActions(
      snap([1, 2], [], false),
      [snap([1, 2], [], true)],
    );
    // Neither isolatedIds nor hiddenIds membership changed → current
    // subscribers wouldn't fire from those two store keys at all.
    // The coalesced count is 1 because ghost flag is part of the
    // snapshot the rebuild must observe. ViewerPanel wires ghostModeOn
    // into the same coalesced visibility scheduler as isolate/hide.
    expect(effects[0].isolatedChanged).toBe(false);
    expect(effects[0].hiddenChanged).toBe(false);
    expect(effects[0].syncRebuildsCurrent).toBe(0);
    expect(effects[0].syncRebuildsCoalesced).toBe(1);
  });

  it('aggregate savings across a typical session - 3 actions cut 4 sync rebuilds → 3', () => {
    // Starting from an all-empty baseline. The savings come from the
    // dual-mutating actions in the middle of the session (when both
    // isolatedIds *and* hiddenIds have non-empty starting state).
    const effects = tallyVisibilityActions(
      snap([], [], false),
      [
        snap([1, 2], [], false),    // isolated:[]→[1,2], hidden:[]→[]      → current 1
        snap([], [3, 4], false),    // isolated:[1,2]→[], hidden:[]→[3,4]   → current 2
        snap([], [], false),        // isolated:[]→[], hidden:[3,4]→[]      → current 1
      ],
    );
    const totalCurrent = effects.reduce((s, e) => s + e.syncRebuildsCurrent, 0);
    const totalCoalesced = effects.reduce((s, e) => s + e.syncRebuildsCoalesced, 0);
    expect(totalCurrent).toBe(4);
    expect(totalCoalesced).toBe(3);
    // The dual-mutating middle action is the one the rAF coalesce buys.
    expect(effects[1].syncRebuildsCurrent).toBe(2);
    expect(effects[1].syncRebuildsCoalesced).toBe(1);
  });

  it('worst-case session - 3 dual-mutating actions cut 6 → 3', () => {
    // Construct a session where every action mutates *both* keys.
    const effects = tallyVisibilityActions(
      snap([], [9], false),
      [
        snap([1], [], false),       // both keys change → current 2
        snap([], [2], false),       // both keys change → current 2
        snap([3], [], false),       // both keys change → current 2
      ],
    );
    const totalCurrent = effects.reduce((s, e) => s + e.syncRebuildsCurrent, 0);
    const totalCoalesced = effects.reduce((s, e) => s + e.syncRebuildsCoalesced, 0);
    expect(totalCurrent).toBe(6);
    expect(totalCoalesced).toBe(3);
  });
});
