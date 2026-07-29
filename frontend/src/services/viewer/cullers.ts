import * as THREE from 'three';
import type * as FRAGS from '@thatopen/fragments';
import type { SpatialNode } from '../../types/ifc';
import { collectLeavesUnder } from './spatialTreeHelpers';
import type { VisibilityMutationTarget } from './renderStateCoordinator';

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

/**
 * Element-level AABB frustum culling for IFC models.
 *
 * Companion to StoreyFrustumCuller: the storey culler is a coarse pre-filter
 * that hides entire storeys. This culler provides fine-grained culling of
 * individual elements within visible storeys.
 *
 * Strategy:
 *   - Build one THREE.Box3 per element from model.getItemsGeometry() - async,
 *     one-time, fetched in chunks of 64 ids per worker round-trip with a
 *     macrotask yield between chunks.
 *   - On each camera settle, test THREE.Frustum.intersectsBox() per element AABB.
 *   - Elements outside the frustum are hidden via model.setVisible([localId], false).
 *   - Skip elements whose storey is already culled (storey culler owns those).
 *   - Gate: only runs when isolatedIds.length === 0 && hiddenIds.length === 0.
 *
 * Performance characteristics (BasicHouse.ifc, 149 elements):
 *   - Build: ~120-250 ms async (does not block rendering)
 *   - Tick: <1 ms frustum tests, O(N) setVisible calls grouped by change
 *   - Cap: MAX_ELEMENTS = 1500 to keep build time ≤ 3 s on typical models
 */


const MAX_ELEMENTS = 1_500;

/**
 * Geometry-fetch batch size. One
 * getItemsGeometry call per 64 ids instead of one per id collapses up to
 * 1 500 sequential worker round-trips into ≤ 24, and the macrotask yield
 * between chunks lets first clicks / camera work interleave with the build.
 */
const GEOMETRY_CHUNK = 64;

interface ElementRecord {
  localId: number;
  box: THREE.Box3;
  autoCulled: boolean;
}

export interface ElementFrustumCullerOptions {
  /**
   * Inflate each element AABB by `padFraction * modelDiag` after build, so
   * elements just outside the camera frustum are not culled. Eliminates the
   * "small pan → tiny element pops in/out" churn on the show path. Default
   * 0 (no padding) preserves the unpadded behaviour the existing tests
   * pin. ViewerPanel passes ~0.03 (3 % of model diagonal - ~1.5 m on a 50 m
   * BasicHouse).
   */
  padFraction?: number;
}

export class ElementFrustumCuller {
  private records: ElementRecord[] = [];
  private _built = false;
  private _disposed = false;
  private frustum = new THREE.Frustum();
  private projScreenMatrix = new THREE.Matrix4();
  private readonly padFraction: number;
  /** Last-invoked operation owns bookkeeping after its async mutation settles. */
  private ownershipEpoch = 0;

  constructor(opts: ElementFrustumCullerOptions = {}) {
    this.padFraction = Math.max(0, opts.padFraction ?? 0);
  }

  get isBuilt(): boolean { return this._built && !this._disposed; }
  get elementCount(): number { return this.records.length; }

  /**
   * Local IDs currently `autoCulled === true`. Used by the eager show-pass
   * during orbit (ViewerPanel.tsx) - the show-pass only needs to test the
   * subset that is currently hidden, not every record. Trivial helper kept
   * here to avoid leaking the private `records` field.
   */
  getCulledLocalIds(): number[] {
    if (!this._built || this._disposed) return [];
    const out: number[] = [];
    for (const r of this.records) if (r.autoCulled) out.push(r.localId);
    return out;
  }

  /**
   * Build per-element AABBs from the model geometry.
   *
   * Geometry is fetched in chunks of GEOMETRY_CHUNK ids (one worker
   * round-trip per chunk instead of one per element), with a macrotask
   * yield between chunks so clicks/camera work can interleave with the
   * build (D1). A failed chunk fetch silently skips that chunk's elements.
   *
   * @param model      The loaded FragmentsModel.
   * @param localIds   All element local IDs to include (subset or all model IDs).
   *                   Pass the subset from visible storeys for best perf.
   *                   Already local-id space - the caller resolves express→
   *                   local before calling; no per-id round-trips happen here.
   */
  async build(
    model: FRAGS.FragmentsModel,
    localIds: number[],
  ): Promise<void> {
    if (this._disposed) return;

    const capped = localIds.slice(0, MAX_ELEMENTS);
    const tmp = new THREE.Vector3();

    for (let start = 0; start < capped.length; start += GEOMETRY_CHUNK) {
      if (this._disposed) return;

      // Yield between chunks (not before the first) so user input and the
      // render loop get a turn between worker round-trips.
      if (start > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (this._disposed) return;
      }

      const chunk = capped.slice(start, start + GEOMETRY_CHUNK);
      try {
        // The worker computes per-item boxes directly; transferring raw vertex
        // buffers to rebuild them on the main thread cost 120-250 ms per model.
        const boxes = await model.getBoxes(chunk);
        for (let i = 0; i < chunk.length; i++) {
          if (this._disposed) return;
          const box = boxes[i];
          if (!box || box.isEmpty()) continue;
          this.records.push({ localId: chunk[i], box: box.clone(), autoCulled: false });
        }
      } catch { /* chunk geometry unavailable - its elements skipped */ }
    }

    // Frustum margin: inflate each element AABB by a fraction of
    // the model diagonal so a small pan doesn't cause edge elements to flap
    // hidden↔visible. The 5-15 ms `setVisible(true)` + fragments LOD-tile
    // refetch on every flap is the dominant "objects pop in late" cost on
    // small/medium models. Padding adds at most ~10 % more draws per frame
    // at idle (measured on BasicHouse: 149→~160 visible), an imperceptible
    // GPU cost in exchange for a smooth show path.
    if (this.padFraction > 0 && this.records.length > 0 && !this._disposed) {
      const union = new THREE.Box3();
      for (const r of this.records) union.union(r.box);
      const size = new THREE.Vector3();
      union.getSize(size);
      const diag = size.length();
      const padMeters = diag * this.padFraction;
      if (padMeters > 0) {
        for (const r of this.records) r.box.expandByScalar(padMeters);
      }
    }

    this._built = !this._disposed;
  }

  /**
   * Test the current camera frustum against element AABBs and hide/show accordingly.
   *
   * @param camera     THREE.Camera from the @thatopen world.
   * @param model      FragmentsModel for setVisible calls.
   * @param excludeIds Optional set of local IDs whose storey is currently
   *                   `autoCulled` by `StoreyFrustumCuller`. Coordination
   *                   rule ❷: these elements are owned by the storey culler
   *                   for this tick. For each excluded record we reset
   *                   `autoCulled = false` so this culler's book-keeping
   *                   does not drift while the storey culler manages
   *                   visibility (the secondary `staleAutoCulled`
   *                   drift bug). Excluded records
   *                   are then skipped from the frustum test - no
   *                   `setVisible` write fires for them this tick.
   * @returns          Number of elements currently culled by this culler
   *                   (storey-owned records do not count even if they
   *                   were marked culled by us on a prior tick).
   */
  async tick(
    camera: THREE.Camera,
    model: FRAGS.FragmentsModel,
    excludeIds?: ReadonlySet<number>,
    visibility: VisibilityMutationTarget = model,
  ): Promise<number> {
    if (!this._built || this._disposed || this.records.length === 0) return 0;
    const operationEpoch = ++this.ownershipEpoch;

    camera.updateMatrixWorld();
    this.projScreenMatrix.multiplyMatrices(
      (camera as THREE.PerspectiveCamera).projectionMatrix,
      camera.matrixWorldInverse,
    );
    this.frustum.setFromProjectionMatrix(this.projScreenMatrix);

    const toHide: ElementRecord[] = [];
    const toShow: ElementRecord[] = [];

    for (const r of this.records) {
      if (this._disposed) return 0;
      if (excludeIds?.has(r.localId)) {
        // Storey culler owns this element this tick. Reset our flag so it
        // doesn't claim a phantom culling state for a record we are not
        // touching. Skip the frustum test.
        if (r.autoCulled) toShow.push(r);
        continue;
      }
      const inFrustum = this.frustum.intersectsBox(r.box);
      if (!inFrustum && !r.autoCulled) {
        toHide.push(r);
      } else if (inFrustum && r.autoCulled) {
        toShow.push(r);
      }
    }

    // Publish local desired ownership before awaiting the worker/coordinator.
    // The coordinator updates its named mask synchronously, then resolves only
    // after a rendered acknowledgement. A navigation show-pass can therefore
    // overlap this await and must already see the pending hide. Roll back only
    // when this operation is still the newest owner; a newer show/tick wins.
    if (toHide.length > 0 || toShow.length > 0) {
      for (const record of toHide) record.autoCulled = true;
      for (const record of toShow) record.autoCulled = false;
      try {
        const hideIds = toHide.map((record) => record.localId);
        const showIds = toShow.map((record) => record.localId);
        if (visibility.applyVisibilityDelta) {
          await visibility.applyVisibilityDelta(hideIds, showIds);
        } else {
          if (showIds.length > 0) await visibility.setVisible(showIds, true);
          if (hideIds.length > 0) await visibility.setVisible(hideIds, false);
        }
      } catch {
        if (operationEpoch === this.ownershipEpoch && !this._disposed) {
          for (const record of toHide) record.autoCulled = false;
          for (const record of toShow) record.autoCulled = true;
        }
        /* best-effort; rolled-back flags make the next pass retry */
      }
    }

    return this.records.filter((r) => r.autoCulled).length;
  }

  /**
   * Cheap show-only pass for use DURING orbit. It iterates only the desired
   * `autoCulled` subset. Settle ticks publish that local desired ownership
   * before awaiting the renderer, so this includes hides whose rendered
   * acknowledgement is still in flight without sending every visible element
   * through the coordinator on each navigation pass.
   *
   * Cost: one frustum.intersectsBox per currently-hidden record + one
   * batched setVisible(true). With the 5 % frustum margin, the show set is
   * typically 0-3 elements per rAF tick on BasicHouse. Safe to call on
   * every animation frame during orbit.
   *
   * @param excludeIds Same semantics as tick(): storey-owned elements are
   *                   skipped and their autoCulled flag is reset to avoid
   *                   book-keeping drift.
   * @returns          Count of elements un-hidden this call.
   */
  async showPass(
    camera: THREE.Camera,
    model: FRAGS.FragmentsModel,
    excludeIds?: ReadonlySet<number>,
    visibility: VisibilityMutationTarget = model,
  ): Promise<number> {
    if (!this._built || this._disposed || this.records.length === 0) return 0;
    const operationEpoch = ++this.ownershipEpoch;

    let anyCulled = false;
    for (const record of this.records) {
      if (record.autoCulled) {
        anyCulled = true;
        break;
      }
    }
    if (!anyCulled) return 0;

    camera.updateMatrixWorld();
    this.projScreenMatrix.multiplyMatrices(
      (camera as THREE.PerspectiveCamera).projectionMatrix,
      camera.matrixWorldInverse,
    );
    this.frustum.setFromProjectionMatrix(this.projScreenMatrix);

    const toShow: ElementRecord[] = [];
    for (const r of this.records) {
      if (this._disposed) return 0;
      if (excludeIds?.has(r.localId)) {
        if (r.autoCulled) toShow.push(r);
        continue;
      }
      if (r.autoCulled && this.frustum.intersectsBox(r.box)) {
        toShow.push(r);
      }
    }

    if (toShow.length > 0) {
      for (const record of toShow) record.autoCulled = false;
      try {
        await visibility.setVisible(toShow.map((record) => record.localId), true);
      } catch {
        if (operationEpoch === this.ownershipEpoch && !this._disposed) {
          for (const record of toShow) record.autoCulled = true;
        }
        return 0;
      }
    }
    return toShow.length;
  }

  /**
   * Restore all auto-culled elements without clearing records.
   * Call before user activates isolation to avoid visibility conflicts.
   */
  async clearCull(
    model: FRAGS.FragmentsModel,
    visibility: VisibilityMutationTarget = model,
  ): Promise<void> {
    const operationEpoch = ++this.ownershipEpoch;
    const culledRecords = this.records.filter((record) => record.autoCulled);
    const culled = culledRecords.map((record) => record.localId);
    for (const record of culledRecords) record.autoCulled = false;
    // A coordinator target is authoritative even when local flags are stale
    // because an older async tick has not acknowledged yet.
    try {
      if (visibility.clearVisibility) {
        await visibility.clearVisibility();
      } else if (culled.length > 0) {
        await visibility.setVisible(culled, true);
      }
      if (operationEpoch === this.ownershipEpoch) {
        this.records.forEach((r) => { r.autoCulled = false; });
      }
    } catch (error) {
      if (operationEpoch === this.ownershipEpoch && !this._disposed) {
        for (const record of culledRecords) record.autoCulled = true;
      }
      throw error;
    }
  }

  /** Release all resources and restore visibility. */
  async dispose(
    model?: FRAGS.FragmentsModel,
    visibility?: VisibilityMutationTarget,
  ): Promise<void> {
    this._disposed = true;
    if (model) await this.clearCull(model, visibility ?? model);
    this.records = [];
  }

  /**
   * Forget culler ownership without mutating renderer visibility. Used when a
   * semantic user mask atomically clears the coordinator layer itself.
   */
  releaseOwnership(): void {
    this.ownershipEpoch += 1;
    for (const record of this.records) record.autoCulled = false;
  }
}

/**
 * Per-storey AABB frustum culling for multi-storey IFC models.
 *
 * Strategy from the archived WebGPU compute-culling research note:
 *   - Build one THREE.Box3 per storey from model.getItemsGeometry() - one-time
 *     async, ~50-300 ms, fetched in chunks of 64 ids with a macrotask yield
 *     between chunks.
 *   - Each camera settle (debounced 300 ms after camera stop), test THREE.Frustum.intersectsBox().
 *   - Storeys fully outside the frustum are hidden via model.setVisible(localIds, false).
 *   - Only runs when no user isolation is active (isolatedIds.length === 0) to avoid state conflict.
 *   - Dispose restores all auto-culled elements.
 *
 * Limitations:
 *   - Max 5 000 total leaf elements across all storeys (performance guard on large models).
 *   - Does not fight user-set visibility; disabled when user isolates any element.
 *   - Requires the spatial tree to have storey nodes with at least one leaf child.
 */


const MAX_TOTAL_ELEMENTS = 5_000;

/**
 * Geometry-fetch batch size. Caps a single
 * getItemsGeometry round-trip at 64 ids (a storey can hold thousands) and
 * yields a macrotask between chunks so clicks/camera work can interleave
 * with the build. Mirrors ElementFrustumCuller.
 */

interface StoreyRecord {
  storeyId: number;
  name: string;
  localIds: number[];
  box: THREE.Box3;
  autoCulled: boolean;
}

export interface StoreyFrustumCullerOptions {
  /**
   * Inflate each storey AABB by `padFraction * modelDiag` after build -
   * keeps storey contents visible when the camera frustum is just outside
   * the storey box. Default 0 (no padding) preserves the unpadded
   * behaviour the existing tests pin. ViewerPanel passes ~0.03.
   */
  padFraction?: number;
}

export class StoreyFrustumCuller {
  private records: StoreyRecord[] = [];
  private _built = false;
  private _disposed = false;
  private frustum = new THREE.Frustum();
  private projScreenMatrix = new THREE.Matrix4();
  private readonly padFraction: number;
  /** Last-invoked operation owns bookkeeping after its async mutation settles. */
  private ownershipEpoch = 0;

  constructor(opts: StoreyFrustumCullerOptions = {}) {
    this.padFraction = Math.max(0, opts.padFraction ?? 0);
  }

  get isBuilt(): boolean { return this._built && !this._disposed; }
  get storeyCount(): number { return this.records.length; }

  /**
   * Flat list of every local ID whose storey is currently `autoCulled`.
   * Read-only; safe to call from any tick - does not touch the model.
   *
   * Coordination rule ❷: the element culler reads this to skip storey-owned
   * elements from its own frustum test (and to keep its `autoCulled` book-
   * keeping in sync with the actual model state).
   */
  getCulledMemberIds(): number[] {
    if (!this._built || this._disposed) return [];
    const out: number[] = [];
    for (const r of this.records) {
      if (r.autoCulled) {
        for (const id of r.localIds) out.push(id);
      }
    }
    return out;
  }

  /** See ElementFrustumCuller.releaseOwnership. */
  releaseOwnership(): void {
    this.ownershipEpoch += 1;
    for (const record of this.records) record.autoCulled = false;
  }

  /**
   * Async one-time build - computes a bounding box per storey from geometry.
   * Safe to await or fire-and-forget (checks `_disposed` throughout).
   *
   * Geometry is fetched in chunks of GEOMETRY_CHUNK ids with a macrotask
   * yield between consecutive worker round-trips (D1) - including across
   * storeys - so the build never monopolizes the worker right after load.
   * A failed chunk fetch only loses that chunk's contribution to the
   * storey box instead of skipping the whole storey.
   *
   * @param localIdLookup Optional pre-resolved express→local id map (built
   *                      by the call-site in one batched round-trip). When
   *                      provided, no per-id `getItem().getLocalId()` calls
   *                      are made; when absent, falls back to the original
   *                      per-element resolution path.
   */
  async build(
    model: FRAGS.FragmentsModel,
    storeyNodes: SpatialNode[],
    localIdLookup?: ReadonlyMap<number, number>,
  ): Promise<void> {
    if (this._disposed) return;

    let totalElements = 0;
    let fetchedOnce = false;
    const tmp = new THREE.Vector3();

    for (const storey of storeyNodes) {
      if (this._disposed) return;

      const expressIds = collectLeavesUnder(storey);
      if (expressIds.length === 0) continue;

      totalElements += expressIds.length;
      if (totalElements > MAX_TOTAL_ELEMENTS) break;

      // Express → local IDs. Prefer the caller's pre-resolved map (zero
      // worker round-trips); otherwise resolve per element (async; uses
      // @thatopen internal map).
      const localIds: number[] = [];
      if (localIdLookup) {
        for (const expId of expressIds) {
          const lid = localIdLookup.get(expId);
          if (lid != null) localIds.push(lid);
        }
      } else {
        for (const expId of expressIds) {
          if (this._disposed) return;
          try {
            const item = model.getItem(expId);
            const lid = await item.getLocalId();
            if (lid != null) localIds.push(lid);
          } catch { /* element may not exist in fragments - skip */ }
        }
      }

      if (localIds.length === 0 || this._disposed) continue;

      // Union the worker-computed per-item boxes; shipping raw vertex buffers
      // to the main thread to recompute them was the dominant build cost.
      const box = new THREE.Box3();
      for (let start = 0; start < localIds.length; start += GEOMETRY_CHUNK) {
        if (this._disposed) return;

        // Yield between worker round-trips (also across storeys) so user
        // input and the render loop get a turn.
        if (fetchedOnce) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          if (this._disposed) return;
        }
        fetchedOnce = true;

        const chunk = localIds.slice(start, start + GEOMETRY_CHUNK);
        try {
          const boxes = await model.getBoxes(chunk);
          for (const itemBox of boxes) {
            if (this._disposed) return;
            if (itemBox && !itemBox.isEmpty()) box.union(itemBox);
          }
        } catch { /* chunk geometry unavailable - its elements skipped */ }
      }

      if (!box.isEmpty() && !this._disposed) {
        this.records.push({
          storeyId: storey.id,
          name: storey.name,
          localIds,
          box,
          autoCulled: false,
        });
      }
    }

    // Frustum margin: see ElementFrustumCuller for rationale.
    if (this.padFraction > 0 && this.records.length > 0 && !this._disposed) {
      const union = new THREE.Box3();
      for (const r of this.records) union.union(r.box);
      const size = new THREE.Vector3();
      union.getSize(size);
      const diag = size.length();
      const padMeters = diag * this.padFraction;
      if (padMeters > 0) {
        for (const r of this.records) r.box.expandByScalar(padMeters);
      }
    }

    this._built = !this._disposed;
  }

  /**
   * Test the current camera frustum against storey AABBs and hide/show accordingly.
   *
   * @param camera   The THREE.js camera from the @thatopen world.
   * @param model    FragmentsModel for setVisible calls.
   * @returns        Number of storeys currently culled (hidden by this culler).
   */
  async tick(
    camera: THREE.Camera,
    model: FRAGS.FragmentsModel,
    visibility: VisibilityMutationTarget = model,
  ): Promise<number> {
    if (!this._built || this._disposed || this.records.length === 0) return 0;
    const operationEpoch = ++this.ownershipEpoch;

    camera.updateMatrixWorld();
    this.projScreenMatrix.multiplyMatrices(
      (camera as THREE.PerspectiveCamera).projectionMatrix,
      camera.matrixWorldInverse,
    );
    this.frustum.setFromProjectionMatrix(this.projScreenMatrix);

    const toHide: StoreyRecord[] = [];
    const toShow: StoreyRecord[] = [];

    for (const r of this.records) {
      if (this._disposed) return 0;
      const inFrustum = this.frustum.intersectsBox(r.box);

      if (!inFrustum && !r.autoCulled) {
        toHide.push(r);
      } else if (inFrustum && r.autoCulled) {
        toShow.push(r);
      }
    }

    if (toHide.length > 0 || toShow.length > 0) {
      // Record desired ownership before awaiting the rendered coordinator
      // acknowledgement. Navigation can then reveal a just-published hide
      // without scanning/sending every in-frustum storey on steady frames.
      for (const record of toHide) record.autoCulled = true;
      for (const record of toShow) record.autoCulled = false;
      try {
        const hideIds = toHide.flatMap((record) => record.localIds);
        const showIds = toShow.flatMap((record) => record.localIds);
        if (visibility.applyVisibilityDelta) {
          await visibility.applyVisibilityDelta(hideIds, showIds);
        } else {
          if (showIds.length > 0) await visibility.setVisible(showIds, true);
          if (hideIds.length > 0) await visibility.setVisible(hideIds, false);
        }
      } catch {
        if (operationEpoch === this.ownershipEpoch && !this._disposed) {
          for (const record of toHide) record.autoCulled = false;
          for (const record of toShow) record.autoCulled = true;
        }
        /* rolled-back flags make a later tick retry */
      }
    }

    return this.records.filter((record) => record.autoCulled).length;
  }

  /**
   * Cheap show-only pass for use DURING orbit. Companion to
   * ElementFrustumCuller.showPass - iterates only desired `autoCulled`
   * storeys. Settle ticks set that desired flag before awaiting the rendered
   * acknowledgement, so pending hides remain revealable without redundant
   * full-model coordinator writes. No hide writes - hides wait for settle.
   */
  async showPass(
    camera: THREE.Camera,
    model: FRAGS.FragmentsModel,
    visibility: VisibilityMutationTarget = model,
  ): Promise<number> {
    if (!this._built || this._disposed || this.records.length === 0) return 0;
    const operationEpoch = ++this.ownershipEpoch;

    let anyCulled = false;
    for (const record of this.records) {
      if (record.autoCulled) {
        anyCulled = true;
        break;
      }
    }
    if (!anyCulled) return 0;

    camera.updateMatrixWorld();
    this.projScreenMatrix.multiplyMatrices(
      (camera as THREE.PerspectiveCamera).projectionMatrix,
      camera.matrixWorldInverse,
    );
    this.frustum.setFromProjectionMatrix(this.projScreenMatrix);

    const toShow: StoreyRecord[] = [];
    for (const r of this.records) {
      if (this._disposed) return 0;
      if (r.autoCulled && this.frustum.intersectsBox(r.box)) {
        toShow.push(r);
      }
    }
    if (toShow.length > 0) {
      for (const record of toShow) record.autoCulled = false;
      try {
        await visibility.setVisible(toShow.flatMap((record) => record.localIds), true);
      } catch {
        if (operationEpoch === this.ownershipEpoch && !this._disposed) {
          for (const record of toShow) record.autoCulled = true;
        }
        return 0;
      }
    }
    return toShow.length;
  }

  /**
   * Clear all auto-culled storeys (restores visibility) without tearing down records.
   * Call before user activates isolation so the two systems don't fight.
   */
  async clearCull(
    model: FRAGS.FragmentsModel,
    visibility: VisibilityMutationTarget = model,
  ): Promise<void> {
    const operationEpoch = ++this.ownershipEpoch;
    const culled = this.records.filter((record) => record.autoCulled);
    for (const record of culled) record.autoCulled = false;
    try {
      if (visibility.clearVisibility) {
        await visibility.clearVisibility();
      } else if (culled.length > 0) {
        await visibility.setVisible(culled.flatMap((record) => record.localIds), true);
      }
      if (operationEpoch === this.ownershipEpoch) {
        for (const record of this.records) record.autoCulled = false;
      }
    } catch (error) {
      if (operationEpoch === this.ownershipEpoch && !this._disposed) {
        for (const record of culled) record.autoCulled = true;
      }
      throw error;
    }
  }

  /** Release all resources and restore visibility. */
  async dispose(
    model?: FRAGS.FragmentsModel,
    visibility?: VisibilityMutationTarget,
  ): Promise<void> {
    this._disposed = true;
    if (model) await this.clearCull(model, visibility ?? model);
    this.records = [];
  }
}

/**
 * Extract IfcBuildingStorey nodes from the spatial tree root.
 * Returns an empty array if the tree is null or has no storey children.
 */
export function extractStoreyNodes(root: SpatialNode | null): SpatialNode[] {
  if (!root) return [];
  const out: SpatialNode[] = [];

  const walk = (node: SpatialNode) => {
    if (node.ifc_type.toLowerCase() === 'ifcbuildingstorey') {
      out.push(node);
      return; // don't recurse into nested storeys (degenerate models)
    }
    for (const child of node.children ?? []) walk(child);
  };

  walk(root);
  return out;
}

export type CullerNavigationState = 'navigating' | 'idle';

export type CullerPolicyMode =
  | 'disabled'
  | 'stand-down-user-visibility'
  | 'show-only'
  | 'hide-after-idle';

export interface CullerPolicyInput {
  readonly navigationState: CullerNavigationState;
  readonly elementCount: number;
  readonly isolatedCount: number;
  readonly hiddenCount: number;
  readonly storeyCullerBuilt: boolean;
  readonly elementCullerBuilt: boolean;
  readonly autoCulledCount: number;
  readonly smallModelElementThreshold?: number;
  readonly smallModelStoreyThreshold?: number;
}

export interface CullerPolicyDecision {
  readonly mode: CullerPolicyMode;
  readonly runShowPass: boolean;
  readonly runHidePass: boolean;
  readonly elementCullerEnabled: boolean;
  readonly storeyCullerEnabled: boolean;
}

export function decideCullerPolicy(input: CullerPolicyInput): CullerPolicyDecision {
  const smallModelElementThreshold = input.smallModelElementThreshold ?? 300;
  // Storey-culler gate: below this element count the GPU
  // handles the full draw with headroom to spare, so the only thing the
  // storey cull contributes is a visible pop on zoom-out as Fragments
  // re-inserts the un-hidden storey into its draw lists. The element
  // culler already gates at 300; the storey culler gates higher because
  // it's coarser - a single storey often covers hundreds of elements, so
  // its setVisible(true) round-trip touches more state at once.
  const smallModelStoreyThreshold = input.smallModelStoreyThreshold ?? 1500;
  const elementCullerEnabled =
    input.elementCullerBuilt && input.elementCount >= smallModelElementThreshold;
  const storeyCullerEnabled =
    input.storeyCullerBuilt && input.elementCount >= smallModelStoreyThreshold;
  const anyCullerEnabled = elementCullerEnabled || storeyCullerEnabled;

  if (!anyCullerEnabled) {
    return {
      mode: 'disabled',
      runShowPass: false,
      runHidePass: false,
      elementCullerEnabled,
      storeyCullerEnabled,
    };
  }

  if (input.isolatedCount > 0 || input.hiddenCount > 0) {
    return {
      mode: 'stand-down-user-visibility',
      runShowPass: false,
      runHidePass: false,
      elementCullerEnabled,
      storeyCullerEnabled,
    };
  }

  if (input.navigationState === 'navigating') {
    return {
      mode: 'show-only',
      runShowPass: input.autoCulledCount > 0,
      runHidePass: false,
      elementCullerEnabled,
      storeyCullerEnabled,
    };
  }

  return {
    mode: 'hide-after-idle',
    runShowPass: input.autoCulledCount > 0,
    runHidePass: anyCullerEnabled,
    elementCullerEnabled,
    storeyCullerEnabled,
  };
}
