/**
 * Visibility-rebuild decision + churn audit helpers.
 *
 * Audits which Zustand store changes drive
 * a synchronous `applyVisibility(...)` call in `ViewerPanel.tsx`, and
 * extracts a pure decision helper so the same set-equality dedup that
 * `selectionHighlightHelpers.ts` added for the amber-selection
 * path also covers the isolate / hide path.
 *
 * The current `ViewerPanel.tsx` subscribes to two store keys -
 * `isolatedIds` and `hiddenIds` - and each subscriber fires
 * `applyVisibility(...)` synchronously. Three store actions (`setIsolatedIds`,
 * `addHiddenIds`, `clearVisibility`) write *both* keys in a single
 * `set({ ... })` call, so a single user action produces two synchronous
 * `applyVisibility(...)` invocations - each of which ends with
 * `await fm.core.update(true)` (a 15-25 ms @thatopen/fragments worker
 * round-trip). `ViewerPanel.tsx` wires `createRebuildScheduler` into
 * this path to coalesce those calls; this module holds the
 * pure decision contract so the behaviour stays test-covered.
 *
 * Companion to:
 *   - `hoverHighlightHelpers.ts`
 *   - `selectionHighlightHelpers.ts`
 *   - `rebuildScheduler.ts`
 *
 * Same shape: framework-free pure functions so vitest can pin the
 * contract without mounting a renderer or @thatopen/fragments.
 */

/**
 * Plain-old-data snapshot of the visibility-related Zustand keys read
 * by `applyVisibility(...)`. Matches the `useStore.getState()` shape
 * exactly so the audit pin doesn't drift when the store grows new
 * unrelated fields.
 */
export type VisibilitySnapshot = {
  readonly isolatedIds: readonly number[];
  readonly hiddenIds: readonly number[];
  readonly ghostModeOn: boolean;
};

/**
 * What `applyVisibility(...)` actually does depending on the snapshot:
 *   - `'isolate'` - `isolatedIds.length > 0`. Non-isolated elements are
 *     either hidden (normal mode) or ghosted (when `ghostModeOn`).
 *   - `'hide'`    - `isolatedIds.length === 0` AND `hiddenIds.length > 0`.
 *     The hidden set is hidden; everything else is shown.
 *   - `'reset'`   - both lists empty. Show all, reset opacity.
 *
 * Centralising the branch keeps the contract pinned by vitest and
 * documents the precedence rule for any future writer: isolate wins
 * over hide.
 */
export type VisibilityMode = 'isolate' | 'hide' | 'reset';

export function computeVisibilityMode(snapshot: VisibilitySnapshot): VisibilityMode {
  if (snapshot.isolatedIds.length > 0) return 'isolate';
  if (snapshot.hiddenIds.length > 0) return 'hide';
  return 'reset';
}

/**
 * Decision returned by `decideVisibilityWork`. Same shape as
 * `SelectionWorkDecision` so a future helper that fuses both audits can
 * reuse it.
 */
export type VisibilityWorkDecision = {
  skip: boolean;
  mode: VisibilityMode;
  prevIsolated: ReadonlySet<number>;
  nextIsolated: ReadonlySet<number>;
  prevHidden: ReadonlySet<number>;
  nextHidden: ReadonlySet<number>;
};

/**
 * Given the previous + new visibility snapshots, decide whether the
 * underlying `applyVisibility(...)` rebuild can be skipped. Skip rules:
 *   - The isolated-id set is order-INsensitive: `[1, 2]` == `[2, 1]`.
 *   - The hidden-id set is order-INsensitive: `[3, 4]` == `[4, 3]`.
 *   - `ghostModeOn` must match - ghost-on vs ghost-off changes the
 *     opacity branch even if the id sets are identical.
 *   - `0` is a real express ID; it is never coerced to "empty".
 *
 * If any of the above differs, `skip === false` and the caller must
 * rebuild.
 */
export function decideVisibilityWork(
  prev: VisibilitySnapshot,
  next: VisibilitySnapshot,
): VisibilityWorkDecision {
  const prevIsolated = new Set(prev.isolatedIds);
  const nextIsolated = new Set(next.isolatedIds);
  const prevHidden = new Set(prev.hiddenIds);
  const nextHidden = new Set(next.hiddenIds);

  let skip = (
    prev.ghostModeOn === next.ghostModeOn &&
    prevIsolated.size === nextIsolated.size &&
    prevHidden.size === nextHidden.size
  );
  if (skip) {
    for (const id of prevIsolated) {
      if (!nextIsolated.has(id)) { skip = false; break; }
    }
  }
  if (skip) {
    for (const id of prevHidden) {
      if (!nextHidden.has(id)) { skip = false; break; }
    }
  }

  return {
    skip,
    mode: computeVisibilityMode(next),
    prevIsolated,
    nextIsolated,
    prevHidden,
    nextHidden,
  };
}

/** Symmetric difference between the previously-applied invisible local-id
 *  set and the next one. */
export interface VisibilityDeltaPlan {
  /** Previously invisible, now visible - write setVisible(ids, true). */
  toShow: number[];
  /** Newly invisible - write setVisible(ids, false). */
  toHide: number[];
}

/**
 * Delta discipline for isolate/hide/reset transitions (mirrors
 * decideGhostWork): every visibility state reduces to "the set of local ids
 * that should be invisible now", so a transition only needs to write the
 * symmetric difference against the set last written. Full-model writes
 * shipped N-length id arrays to the worker per isolate/hide/reset, and the
 * worker re-evaluated visibility for all of them.
 */
export function planInvisibleSetTransition(
  prev: ReadonlySet<number>,
  next: ReadonlySet<number>,
): VisibilityDeltaPlan {
  const toShow: number[] = [];
  const toHide: number[] = [];
  for (const id of next) {
    if (!prev.has(id)) toHide.push(id);
  }
  for (const id of prev) {
    if (!next.has(id)) toShow.push(id);
  }
  return { toShow, toHide };
}

/**
 * Counts of visibility-rebuild side-effects across a synthetic stream
 * of snapshots. Mirrors `SelectionChurnCounts` / `HoverChurnCounts`.
 *
 * The audit asserts:
 *   - `rebuildCalls === number of distinct adjacent snapshots`
 *   - `skippedTicks` covers identical-snapshot ticks (the core dedup)
 *   - `coreUpdateCalls === rebuildCalls` - every rebuild ends with one
 *     `fm.core.update(true)`, so the count exactly mirrors `rebuildCalls`.
 *     With `createRebuildScheduler` wired into this
 *     path, the same input stream produces *fewer* `coreUpdateCalls`
 *     than a naïve double-subscriber arrangement; this counter is the
 *     regression guard.
 */
export type VisibilityChurnCounts = {
  rebuildCalls: number;
  skippedTicks: number;
  resetTicks: number;
  coreUpdateCalls: number;
};

/**
 * Run a synthetic stream of visibility snapshots through
 * `decideVisibilityWork` and tally the resulting fragment-API call
 * counts without touching THREE.js / @thatopen/fragments.
 *
 * Use it in vitest by writing a stream like
 *   [
 *     { isolatedIds: [],    hiddenIds: [], ghostModeOn: false },
 *     { isolatedIds: [1,2], hiddenIds: [], ghostModeOn: false }, // rebuild
 *     { isolatedIds: [2,1], hiddenIds: [], ghostModeOn: false }, // SKIP
 *     { isolatedIds: [2,1], hiddenIds: [], ghostModeOn: true  }, // rebuild (ghost flip)
 *   ]
 * and asserting `rebuildCalls === 2`, `skippedTicks === 1`.
 */
export function countVisibilityChurn(
  stream: ReadonlyArray<VisibilitySnapshot>,
): VisibilityChurnCounts {
  let prev: VisibilitySnapshot = {
    isolatedIds: [],
    hiddenIds: [],
    ghostModeOn: false,
  };
  const counts: VisibilityChurnCounts = {
    rebuildCalls: 0,
    skippedTicks: 0,
    resetTicks: 0,
    coreUpdateCalls: 0,
  };
  for (const next of stream) {
    const { skip, mode } = decideVisibilityWork(prev, next);
    if (skip) {
      counts.skippedTicks += 1;
      continue;
    }
    counts.rebuildCalls += 1;
    counts.coreUpdateCalls += 1;
    if (mode === 'reset') counts.resetTicks += 1;
    prev = next;
  }
  return counts;
}

/**
 * Audit-time helper that models the unscheduled ViewerPanel
 * behaviour: two separate Zustand subscribers each call
 * `applyVisibility(...)` synchronously. A single store action that
 * writes both `isolatedIds` and `hiddenIds` therefore fires the rebuild
 * *twice*. This counter is the "before" baseline against the
 * `createRebuildScheduler`-coalesced path.
 *
 * `actions` is a list of action snapshots - one per Zustand `set(...)`
 * call. For each action, the function returns how many synchronous
 * `applyVisibility(...)` calls the two-subscriber arrangement would
 * emit (1 if exactly one of `isolatedIds` / `hiddenIds` changed, 2 if
 * both changed in the same action, 0 if neither changed).
 */
export type VisibilityActionEffect = {
  /** Did `isolatedIds` differ from the prior snapshot? */
  isolatedChanged: boolean;
  /** Did `hiddenIds` differ from the prior snapshot? */
  hiddenChanged: boolean;
  /** Synchronous `applyVisibility` invocations under the current arrangement. */
  syncRebuildsCurrent: number;
  /** Synchronous `applyVisibility` invocations once rAF-coalesced (always ≤ 1). */
  syncRebuildsCoalesced: number;
};

export function tallyVisibilityActions(
  initial: VisibilitySnapshot,
  actions: ReadonlyArray<VisibilitySnapshot>,
): VisibilityActionEffect[] {
  let prev: VisibilitySnapshot = initial;
  const out: VisibilityActionEffect[] = [];
  for (const next of actions) {
    const isolatedChanged = !sameSet(prev.isolatedIds, next.isolatedIds);
    const hiddenChanged = !sameSet(prev.hiddenIds, next.hiddenIds);
    const ghostChanged = prev.ghostModeOn !== next.ghostModeOn;
    const anyChanged = isolatedChanged || hiddenChanged || ghostChanged;
    const syncRebuildsCurrent =
      (isolatedChanged ? 1 : 0) + (hiddenChanged ? 1 : 0);
    out.push({
      isolatedChanged,
      hiddenChanged,
      syncRebuildsCurrent,
      syncRebuildsCoalesced: anyChanged ? 1 : 0,
    });
    prev = next;
  }
  return out;
}

function sameSet(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  for (const v of b) if (!set.has(v)) return false;
  return true;
}
