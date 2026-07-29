/**
 * Culler-coordination decision helpers.
 *
 * `ViewerPanel.tsx` owns three visibility writers that all call
 * `model.setVisible(localIds, boolean)` on the same @thatopen/fragments
 * model:
 *
 *   1. The user isolate / hide policy (rAF-coalesced through the
 *      render-state coordinator).
 *   2. `StoreyFrustumCuller.tick(...)` - coarse AABB cull at the storey
 *      granularity, fires on camera `controlend` settle.
 *   3. `ElementFrustumCuller.tick(...)` - fine AABB cull at the element
 *      granularity, fires on the same `controlend` settle.
 *
 * Without coordination, writers 2 + 3 would be kicked off with
 * `void culler.tick(...)` in the same synchronous block in the settle
 * handler. They share the same gating predicate
 * (`isolatedIds.length === 0 && hiddenIds.length === 0`) but they do NOT
 * await each other - both run in parallel on the JS task queue. That is
 * the co-ownership ambiguity these helpers resolve:
 *
 *   - If `StoreyFrustumCuller` hides storey 1 (local IDs [1, 2, 3]) while
 *     `ElementFrustumCuller` decides element 2 is "in frustum" and was
 *     previously `autoCulled === true`, the element culler races to
 *     `setVisible([2], true)`. The final visibility of element 2 depends
 *     on whichever `setVisible` call resolves last.
 *   - When `StoreyFrustumCuller.tick` later un-culls the storey (storey
 *     re-enters frustum), it calls `setVisible([1, 2, 3], true)`. Element
 *     2 may still be flagged `autoCulled === true` inside the element
 *     culler's record list - so the element culler's `autoCulled` book-
 *     keeping drifts out of sync with the actual model state.
 *
 * The single-owner rule this helper encodes:
 *
 *   ❶ User isolation / hide is the highest-priority owner. When the user
 *     isolates or hides anything, both AABB cullers `clearCull(...)` and
 *     stand down.
 *   ❷ Otherwise, `StoreyFrustumCuller` is the coarse owner: any element
 *     whose storey is currently `autoCulled` is owned by the storey
 *     culler and is **not eligible** for `ElementFrustumCuller`
 *     consideration.
 *   ❸ Within the storey-eligible subset, `ElementFrustumCuller` is the
 *     fine owner.
 *
 * The helpers are wired into the settle handler in `ViewerPanel.tsx` so
 * the storey tick `await`s before the element tick starts, and the
 * element culler's records get partitioned to honor rule ❷.
 *
 * Companion to:
 *   - `hoverHighlightHelpers.ts`
 *   - `selectionHighlightHelpers.ts`
 *
 * Same shape as those helpers: framework-free pure functions so vitest
 * can pin the contract without mounting a renderer or @thatopen/
 * fragments.
 */

/**
 * Plain-old-data snapshot of the culler-relevant state. Mirrors the
 * `useStore.getState()` shape consumed by the settle handler.
 */
export type CullerSnapshot = {
  readonly storeyCullerBuilt: boolean;
  readonly elementCullerBuilt: boolean;
  readonly isolatedCount: number;
  readonly hiddenCount: number;
};

/**
 * The work plan a single `controlend` settle should produce. The order
 * of the plan matters: storey first (await), then element. Today's
 * `ViewerPanel.tsx` produces `'race'` because it fires both `tick(...)`
 * calls without awaiting; `'storey-then-element'` is the awaited alternative.
 *
 *   - `'skip'`                - user has active isolation / hide. Both
 *                               cullers `clearCull(...)` and stand down.
 *   - `'noop'`                - no cullers are built yet.
 *   - `'storey-only'`         - only the storey culler is built.
 *   - `'element-only'`        - only the element culler is built.
 *   - `'storey-then-element'` - both built; the correct sequenced plan.
 *   - `'race'`                - both built but the caller is the current
 *                               un-fixed `void / void` arrangement. The
 *                               helper never returns `'race'`; it is
 *                               surfaced by `tallyCullerCoordination` to
 *                               quantify the current bug.
 */
export type CullerWorkPlan =
  | 'skip'
  | 'noop'
  | 'storey-only'
  | 'element-only'
  | 'storey-then-element';

export function decideCullerWork(snapshot: CullerSnapshot): CullerWorkPlan {
  if (snapshot.isolatedCount > 0 || snapshot.hiddenCount > 0) return 'skip';
  const s = snapshot.storeyCullerBuilt;
  const e = snapshot.elementCullerBuilt;
  if (s && e) return 'storey-then-element';
  if (s) return 'storey-only';
  if (e) return 'element-only';
  return 'noop';
}

/**
 * Partition the element culler's candidate IDs by current single-owner
 * rule. Elements that live in a storey currently `autoCulled` by the
 * storey culler are owned by the storey culler and must be excluded
 * from the element culler's frustum test (and from its `autoCulled`
 * book-keeping). The remainder is eligible for fine-grained
 * consideration.
 *
 *   - `allElementIds`      - every element local ID the element culler
 *                            currently tracks (one entry per record).
 *   - `culledStoreyMembers` - flat list of local IDs whose storey is
 *                             currently `autoCulled` per the storey
 *                             culler.
 *
 * Returns two **disjoint** sets:
 *   - `ownedByStorey`     - element culler should `clearCull(...)` these
 *                            (they are not its responsibility this tick).
 *   - `eligibleForElement` - element culler should consider these.
 *
 * `0` is treated as a real local ID; nothing is coerced to "empty".
 */
export function partitionElementsByOwner(
  allElementIds: ReadonlyArray<number>,
  culledStoreyMembers: ReadonlyArray<number>,
): {
  ownedByStorey: ReadonlySet<number>;
  eligibleForElement: ReadonlySet<number>;
} {
  const storeyOwned = new Set(culledStoreyMembers);
  const ownedByStorey = new Set<number>();
  const eligibleForElement = new Set<number>();
  for (const id of allElementIds) {
    if (storeyOwned.has(id)) ownedByStorey.add(id);
    else eligibleForElement.add(id);
  }
  return { ownedByStorey, eligibleForElement };
}

/**
 * Per-tick frustum verdict for a single element record. The element
 * culler treats `inFrustum` as the camera-relative truth; combined with
 * the storey owner rule + the element's prior `autoCulled` flag, this
 * produces one of four actions.
 *
 * The action vocabulary is shared with the follow-up wire-up so its
 * intent is pinned by tests.
 */
export type ElementCullerAction =
  | 'noop'           // already in the right state - no setVisible needed
  | 'hide'           // toShow → false; sets autoCulled = true
  | 'show'           // toShow → true;  sets autoCulled = false
  | 'cede-to-storey'; // skipped because storey culler owns this element

export function decideElementCullerAction(input: {
  ownedByStorey: boolean;
  autoCulled: boolean;
  inFrustum: boolean;
}): ElementCullerAction {
  if (input.ownedByStorey) return 'cede-to-storey';
  if (input.inFrustum && input.autoCulled) return 'show';
  if (!input.inFrustum && !input.autoCulled) return 'hide';
  return 'noop';
}

/**
 * Synthetic-stream tally for the audit pin. Each "tick" is a snapshot of
 * one `controlend` settle's frustum verdict + storey-ownership state for
 * a fixed element id. The helper counts:
 *
 *   - `racingWrites`     - how many ticks would issue conflicting
 *                          `setVisible(id, *)` calls under the current
 *                          un-sequenced arrangement (both cullers
 *                          racing). A racing write is any tick where the
 *                          storey culler would set visibility AND the
 *                          element culler would also set visibility on
 *                          the same id in the same settle.
 *   - `sequencedWrites`  - same input under the single-owner rule:
 *                          element culler cedes when storey owns, so the
 *                          element culler does not touch the id.
 *   - `staleAutoCulled`  - ticks where the element culler's `autoCulled`
 *                          flag would drift out of sync with the actual
 *                          visibility because the storey culler restored
 *                          the storey while the element culler's record
 *                          still flagged it culled.
 *
 * The sequencing fix is verified by `racingWrites > 0` without it
 * and `racingWrites === 0` with it.
 */
export type CullerTickInput = {
  readonly storeyOwns: boolean;
  readonly storeyJustRestored: boolean;
  readonly elementInFrustum: boolean;
  readonly elementAutoCulled: boolean;
};

export type CullerCoordinationCounts = {
  racingWrites: number;
  sequencedWrites: number;
  staleAutoCulled: number;
};

/**
 * Orchestration runners passed to `runCullerPlan`. Each is a callback the
 * caller (ViewerPanel) supplies. Keeping the orchestrator framework-free
 * lets vitest pin the await-order contract without mounting a renderer.
 *
 *   - `runStoreyTick`   - must resolve AFTER all `model.setVisible(...)`
 *                          writes the storey culler issues have settled.
 *                          Returns the post-tick culled storey count.
 *   - `runElementTick`  - same contract for the element culler.
 *   - `runStoreyClear`  - `clearCull` for the storey culler. Safe to call
 *                          when the storey culler is not built (caller is
 *                          expected to guard / no-op).
 *   - `runElementClear` - same for the element culler.
 *   - `onStoreyCulled`  - perf-metric sink for storey count.
 *   - `onElementCulled` - perf-metric sink for element count.
 *   - `isDisposed`      - optional gate the orchestrator consults after
 *                          every await; if it returns true, no further
 *                          callbacks fire.
 */
export type CullerPlanRunners = {
  runStoreyTick: () => Promise<number>;
  runElementTick: () => Promise<number>;
  runStoreyClear: () => Promise<void>;
  runElementClear: () => Promise<void>;
  onStoreyCulled: (n: number) => void;
  onElementCulled: (n: number) => void;
  isDisposed?: () => boolean;
};

/**
 * Orchestrate a single `controlend` settle into the writers per the
 * sequenced plan. The contract pinned by vitest:
 *
 *   - `'noop'`                - no runner is called.
 *   - `'skip'`                - clears fire concurrently (via Promise.all)
 *                                only for built cullers; perf metric reset
 *                                to 0 on success.
 *   - `'storey-only'`         - storey tick only.
 *   - `'element-only'`        - element tick only.
 *   - `'storey-then-element'` - storey tick is **awaited** before the
 *                                element tick starts. This is the
 *                                key racing-write fix.
 *
 * `isDisposed` is consulted after every await; the orchestrator returns
 * early if it goes true.
 *
 * Each runner may throw - the orchestrator does NOT swallow; callers are
 * expected to wrap their model calls in try/catch or use no-throw
 * patterns. This matches the existing `void culler.tick(...).then(...)`
 * fire-and-forget callsite, which silently dropped errors.
 */
export async function runCullerPlan(
  plan: CullerWorkPlan,
  snapshot: CullerSnapshot,
  runners: CullerPlanRunners,
): Promise<void> {
  const disposed = () => runners.isDisposed?.() === true;

  if (plan === 'noop') return;

  if (plan === 'skip') {
    const tasks: Array<Promise<void>> = [];
    if (snapshot.storeyCullerBuilt) {
      tasks.push(
        runners.runStoreyClear().then(() => {
          if (!disposed()) runners.onStoreyCulled(0);
        }),
      );
    }
    if (snapshot.elementCullerBuilt) {
      tasks.push(
        runners.runElementClear().then(() => {
          if (!disposed()) runners.onElementCulled(0);
        }),
      );
    }
    await Promise.all(tasks);
    return;
  }

  if (plan === 'storey-only') {
    const n = await runners.runStoreyTick();
    if (!disposed()) runners.onStoreyCulled(n);
    return;
  }

  if (plan === 'element-only') {
    const n = await runners.runElementTick();
    if (!disposed()) runners.onElementCulled(n);
    return;
  }

  // 'storey-then-element' - sequenced. Awaiting the storey tick guarantees
  // the storey culler's `await model.setVisible(...)` writes have settled
  // before any element-culler write fires, eliminating racing
  // `setVisible` writes.
  const storeyCulled = await runners.runStoreyTick();
  if (disposed()) return;
  runners.onStoreyCulled(storeyCulled);
  const elementCulled = await runners.runElementTick();
  if (disposed()) return;
  runners.onElementCulled(elementCulled);
}

export function tallyCullerCoordination(
  stream: ReadonlyArray<CullerTickInput>,
): CullerCoordinationCounts {
  const counts: CullerCoordinationCounts = {
    racingWrites: 0,
    sequencedWrites: 0,
    staleAutoCulled: 0,
  };
  for (const tick of stream) {
    const elementActionCurrent = decideElementCullerAction({
      ownedByStorey: false, // current arrangement does NOT cede
      autoCulled: tick.elementAutoCulled,
      inFrustum: tick.elementInFrustum,
    });
    const elementActionSequenced = decideElementCullerAction({
      ownedByStorey: tick.storeyOwns,
      autoCulled: tick.elementAutoCulled,
      inFrustum: tick.elementInFrustum,
    });

    // Racing write: storey culler also touches this id this tick.
    if (
      tick.storeyOwns &&
      (elementActionCurrent === 'hide' || elementActionCurrent === 'show')
    ) {
      counts.racingWrites += 1;
    }

    // Sequenced write: under the single-owner rule, element culler still
    // emits its own visibility write (storey is not the owner).
    if (
      !tick.storeyOwns &&
      (elementActionSequenced === 'hide' || elementActionSequenced === 'show')
    ) {
      counts.sequencedWrites += 1;
    }

    // Stale `autoCulled` flag - storey just un-culled this id, but the
    // element culler's record still says autoCulled. Subsequent
    // element-culler ticks won't try to re-hide the id (decideElement
    // action would be 'noop' or 'show' depending on frustum), so the
    // record's flag stays stale until something else flips it.
    if (
      tick.storeyJustRestored &&
      tick.elementAutoCulled &&
      tick.elementInFrustum === false
    ) {
      counts.staleAutoCulled += 1;
    }
  }
  return counts;
}

// ── shared ownership-ladder passes ───────────────────────────────────────────
//
// The ladder below (tile owns everything when built; storey is the coarse
// fallback; the element culler fills in only while no tile culler exists) was
// hand-written at four ViewerPanel sites and had already drifted: one copy
// skipped the remembered-localId pinning fallback, and each copy had its own
// error discipline. These passes are the single implementation. Interfaces are
// structural so the real culler classes satisfy them without new coupling.

export interface TileViewOptions {
  readonly pinnedLocalIds: ReadonlySet<number>;
  readonly viewportHeightPx: number;
}

export interface TileCullerLike {
  readonly isBuilt: boolean;
  tick(
    camera: unknown,
    target: never,
    view: TileViewOptions,
  ): Promise<{ hiddenElementCount: number }>;
  showPass(
    camera: unknown,
    target: never,
    view: TileViewOptions,
  ): Promise<{ revealedElementCount: number; hiddenElementCount: number }>;
  clearCull(target: never): Promise<unknown>;
}

export interface StoreyCullerLike {
  readonly isBuilt: boolean;
  tick(camera: unknown, model: never, target: never): Promise<number>;
  showPass(camera: unknown, model: never, target: never): Promise<number>;
  clearCull(model: never, target: never): Promise<unknown>;
  getCulledMemberIds(): Iterable<number>;
}

export interface ElementCullerLike {
  readonly isBuilt: boolean;
  tick(
    camera: unknown,
    model: never,
    ownedByStorey: Set<number> | undefined,
    target: never,
  ): Promise<number>;
  showPass(
    camera: unknown,
    model: never,
    ownedByStorey: Set<number> | undefined,
    target: never,
  ): Promise<number>;
  clearCull(model: never, target: never): Promise<unknown>;
}

export interface CullerPassPorts {
  readonly camera: unknown;
  readonly model: never;
  readonly tile: TileCullerLike | null;
  readonly storey: StoreyCullerLike | null;
  readonly element: ElementCullerLike | null;
  readonly tileTarget: never;
  readonly storeyTarget: never;
  readonly elementTarget: never;
  readonly viewOptions: () => TileViewOptions;
}

export interface CullerPassCounts {
  culledStoreys: number;
  culledElements: number;
  revealedElements: number;
}

function ownedByStoreyOf(ports: CullerPassPorts): Set<number> | undefined {
  return ports.storey?.isBuilt ? new Set(ports.storey.getCulledMemberIds()) : undefined;
}

/** Release every app-culler claim, in ownership order. */
export async function clearCullPass(ports: CullerPassPorts): Promise<void> {
  if (ports.tile?.isBuilt) {
    await ports.tile.clearCull(ports.tileTarget);
  } else if (ports.storey?.isBuilt) {
    await ports.storey.clearCull(ports.model, ports.storeyTarget);
  }
  if (!ports.tile?.isBuilt && ports.element?.isBuilt) {
    await ports.element.clearCull(ports.model, ports.elementTarget);
  }
}

/** Idle hide pass. Callers gate on user isolation/hide being inactive. */
export async function hideTickPass(ports: CullerPassPorts): Promise<CullerPassCounts> {
  const counts: CullerPassCounts = { culledStoreys: 0, culledElements: 0, revealedElements: 0 };
  if (ports.tile?.isBuilt) {
    const result = await ports.tile.tick(ports.camera, ports.tileTarget, ports.viewOptions());
    counts.culledElements = result.hiddenElementCount;
  } else if (ports.storey?.isBuilt) {
    counts.culledStoreys = await ports.storey.tick(ports.camera, ports.model, ports.storeyTarget);
  }
  if (!ports.tile?.isBuilt && ports.element?.isBuilt) {
    counts.culledElements = await ports.element.tick(
      ports.camera,
      ports.model,
      ownedByStoreyOf(ports),
      ports.elementTarget,
    );
  }
  return counts;
}

/** Orbit reveal pass: show culled elements that re-entered the frustum. */
export async function showCullPass(ports: CullerPassPorts): Promise<CullerPassCounts> {
  const counts: CullerPassCounts = { culledStoreys: 0, culledElements: 0, revealedElements: 0 };
  if (ports.tile?.isBuilt) {
    const result = await ports.tile.showPass(ports.camera, ports.tileTarget, ports.viewOptions());
    counts.revealedElements += result.revealedElementCount;
    counts.culledElements = result.hiddenElementCount;
  } else if (ports.storey?.isBuilt) {
    counts.revealedElements += await ports.storey.showPass(
      ports.camera,
      ports.model,
      ports.storeyTarget,
    );
  }
  if (!ports.tile?.isBuilt && ports.element?.isBuilt) {
    counts.revealedElements += await ports.element.showPass(
      ports.camera,
      ports.model,
      ownedByStoreyOf(ports),
      ports.elementTarget,
    );
  }
  return counts;
}

export function anyCullerBuilt(ports: CullerPassPorts): boolean {
  return !!(ports.tile?.isBuilt || ports.storey?.isBuilt || ports.element?.isBuilt);
}
