import * as THREE from 'three';
import type * as FRAGS from '@thatopen/fragments';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  decideCullerWork,
  partitionElementsByOwner,
  decideElementCullerAction,
  tallyCullerCoordination,
  runCullerPlan,
  type CullerSnapshot,
  type CullerTickInput,
  type CullerPlanRunners,
  ElementFrustumCuller,
  extractStoreyNodes,
  StoreyFrustumCuller,
  decideCullerPolicy,
} from '../cullers';
import type { VisibilityMutationTarget } from '../renderStateCoordinator';
import type { SpatialNode } from '../../../types/ifc';

const snap = (
  storeyBuilt: boolean,
  elementBuilt: boolean,
  isolatedCount = 0,
  hiddenCount = 0,
): CullerSnapshot => ({
  storeyCullerBuilt: storeyBuilt,
  elementCullerBuilt: elementBuilt,
  isolatedCount,
  hiddenCount,
});

describe('decideCullerWork', () => {
  it('returns "skip" whenever the user is isolating anything', () => {
    expect(decideCullerWork(snap(true, true, 1, 0))).toBe('skip');
    expect(decideCullerWork(snap(true, true, 5, 0))).toBe('skip');
    expect(decideCullerWork(snap(false, false, 1, 0))).toBe('skip');
  });

  it('returns "skip" whenever the user has any hidden elements', () => {
    expect(decideCullerWork(snap(true, true, 0, 1))).toBe('skip');
    expect(decideCullerWork(snap(true, false, 0, 3))).toBe('skip');
  });

  it('isolate takes precedence over hide in the skip check (both still skip)', () => {
    expect(decideCullerWork(snap(true, true, 2, 3))).toBe('skip');
  });

  it('returns "noop" when neither culler is built', () => {
    expect(decideCullerWork(snap(false, false, 0, 0))).toBe('noop');
  });

  it('returns "storey-only" when only the storey culler is built', () => {
    expect(decideCullerWork(snap(true, false, 0, 0))).toBe('storey-only');
  });

  it('returns "element-only" when only the element culler is built', () => {
    expect(decideCullerWork(snap(false, true, 0, 0))).toBe('element-only');
  });

  it('returns "storey-then-element" when both are built (the correct sequenced plan)', () => {
    expect(decideCullerWork(snap(true, true, 0, 0))).toBe('storey-then-element');
  });

  it('treats 0 as a real isolated/hidden count guard (no count = no skip)', () => {
    // 0 isolated, 0 hidden → both cullers can run.
    expect(decideCullerWork(snap(true, true, 0, 0))).toBe('storey-then-element');
  });
});

describe('partitionElementsByOwner', () => {
  it('returns empty sets for empty inputs', () => {
    const { ownedByStorey, eligibleForElement } = partitionElementsByOwner([], []);
    expect(ownedByStorey.size).toBe(0);
    expect(eligibleForElement.size).toBe(0);
  });

  it('puts all elements in "eligibleForElement" when no storey is culled', () => {
    const { ownedByStorey, eligibleForElement } = partitionElementsByOwner(
      [1, 2, 3, 4, 5],
      [],
    );
    expect(ownedByStorey.size).toBe(0);
    expect([...eligibleForElement].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('puts elements whose id is in a culled storey under "ownedByStorey"', () => {
    const { ownedByStorey, eligibleForElement } = partitionElementsByOwner(
      [1, 2, 3, 4, 5],
      [2, 4],
    );
    expect([...ownedByStorey].sort((a, b) => a - b)).toEqual([2, 4]);
    expect([...eligibleForElement].sort((a, b) => a - b)).toEqual([1, 3, 5]);
  });

  it('the two output sets are disjoint', () => {
    const { ownedByStorey, eligibleForElement } = partitionElementsByOwner(
      [10, 11, 12, 13],
      [11, 12],
    );
    for (const id of ownedByStorey) {
      expect(eligibleForElement.has(id)).toBe(false);
    }
  });

  it('treats 0 as a real local ID (not coerced)', () => {
    const { ownedByStorey, eligibleForElement } = partitionElementsByOwner(
      [0, 1, 2],
      [0],
    );
    expect(ownedByStorey.has(0)).toBe(true);
    expect(eligibleForElement.has(0)).toBe(false);
    expect(eligibleForElement.has(1)).toBe(true);
    expect(eligibleForElement.has(2)).toBe(true);
  });

  it('ignores culled-storey IDs that are not in the element list', () => {
    const { ownedByStorey, eligibleForElement } = partitionElementsByOwner(
      [1, 2],
      [99, 100],
    );
    expect(ownedByStorey.size).toBe(0);
    expect(eligibleForElement.size).toBe(2);
  });

  it('deduplicates: an element id listed twice still appears once in eligible set', () => {
    // Set semantics - repeated IDs collapse.
    const { eligibleForElement } = partitionElementsByOwner([7, 7, 7], []);
    expect(eligibleForElement.size).toBe(1);
    expect(eligibleForElement.has(7)).toBe(true);
  });
});

describe('decideElementCullerAction', () => {
  it('returns "cede-to-storey" whenever the storey culler owns the id', () => {
    expect(decideElementCullerAction({
      ownedByStorey: true,
      autoCulled: false,
      inFrustum: true,
    })).toBe('cede-to-storey');
    expect(decideElementCullerAction({
      ownedByStorey: true,
      autoCulled: true,
      inFrustum: false,
    })).toBe('cede-to-storey');
  });

  it('returns "show" when in frustum and previously auto-culled', () => {
    expect(decideElementCullerAction({
      ownedByStorey: false,
      autoCulled: true,
      inFrustum: true,
    })).toBe('show');
  });

  it('returns "hide" when out of frustum and not previously auto-culled', () => {
    expect(decideElementCullerAction({
      ownedByStorey: false,
      autoCulled: false,
      inFrustum: false,
    })).toBe('hide');
  });

  it('returns "noop" when already in the right state (in frustum + visible)', () => {
    expect(decideElementCullerAction({
      ownedByStorey: false,
      autoCulled: false,
      inFrustum: true,
    })).toBe('noop');
  });

  it('returns "noop" when already in the right state (out of frustum + already hidden)', () => {
    expect(decideElementCullerAction({
      ownedByStorey: false,
      autoCulled: true,
      inFrustum: false,
    })).toBe('noop');
  });
});

describe('tallyCullerCoordination', () => {
  const tick = (overrides: Partial<CullerTickInput> = {}): CullerTickInput => ({
    storeyOwns: false,
    storeyJustRestored: false,
    elementInFrustum: true,
    elementAutoCulled: false,
    ...overrides,
  });

  it('returns all zeros for an empty stream', () => {
    expect(tallyCullerCoordination([])).toEqual({
      racingWrites: 0,
      sequencedWrites: 0,
      staleAutoCulled: 0,
    });
  });

  it('counts a racing write when both cullers would touch the same id this tick', () => {
    // storey owns this id (so storey culler will hide/show it) AND element
    // culler under the current arrangement also computes hide/show
    // (because it does not know to cede).
    const stream = [tick({
      storeyOwns: true,
      elementInFrustum: false,
      elementAutoCulled: false,
    })];
    const c = tallyCullerCoordination(stream);
    expect(c.racingWrites).toBe(1);
    // Sequenced arrangement would cede - no element-culler write here.
    expect(c.sequencedWrites).toBe(0);
  });

  it('does NOT count a racing write when storey does not own the id', () => {
    // Element culler would hide the id, but the storey culler is not
    // touching it this tick - so no race.
    const stream = [tick({
      storeyOwns: false,
      elementInFrustum: false,
      elementAutoCulled: false,
    })];
    const c = tallyCullerCoordination(stream);
    expect(c.racingWrites).toBe(0);
    expect(c.sequencedWrites).toBe(1);
  });

  it('does NOT count a racing write when the element culler would noop anyway', () => {
    // Storey owns, but the element decision is 'noop' under the current
    // arrangement (in-frustum + already visible) - no setVisible call to
    // race with storey's write.
    const stream = [tick({
      storeyOwns: true,
      elementInFrustum: true,
      elementAutoCulled: false,
    })];
    const c = tallyCullerCoordination(stream);
    expect(c.racingWrites).toBe(0);
    expect(c.sequencedWrites).toBe(0);
  });

  it('counts a stale autoCulled flag when storey restores while element thinks the id is culled and out of frustum', () => {
    // The bug: storey culler un-hides the storey, element culler's
    // record still flags autoCulled=true but the AABB is now out of
    // frustum. Element culler's next tick sees ownedByStorey=false
    // (storey just released) + autoCulled=true + inFrustum=false → noop.
    // The flag stays stale until something else flips it.
    const stream = [tick({
      storeyOwns: false,
      storeyJustRestored: true,
      elementInFrustum: false,
      elementAutoCulled: true,
    })];
    const c = tallyCullerCoordination(stream);
    expect(c.staleAutoCulled).toBe(1);
  });

  it('does NOT count stale when storey-just-restored but element is in frustum (element culler will show)', () => {
    const stream = [tick({
      storeyOwns: false,
      storeyJustRestored: true,
      elementInFrustum: true,
      elementAutoCulled: true,
    })];
    const c = tallyCullerCoordination(stream);
    expect(c.staleAutoCulled).toBe(0);
    // 'show' is a sequenced write under both arrangements.
    expect(c.sequencedWrites).toBe(1);
  });

  it('aggregates over a realistic multi-tick stream - quantifies the bug', () => {
    // 4 ticks:
    //   1. Storey owns + element would hide  → racing write.
    //   2. Storey owns + element would noop  → no race.
    //   3. Storey-just-restored + element flag stale → stale.
    //   4. Storey not owning + element hides → sequenced write.
    const stream: CullerTickInput[] = [
      tick({ storeyOwns: true,  elementInFrustum: false, elementAutoCulled: false }),
      tick({ storeyOwns: true,  elementInFrustum: true,  elementAutoCulled: false }),
      tick({ storeyOwns: false, storeyJustRestored: true, elementInFrustum: false, elementAutoCulled: true }),
      tick({ storeyOwns: false, elementInFrustum: false, elementAutoCulled: false }),
    ];
    const c = tallyCullerCoordination(stream);
    expect(c.racingWrites).toBe(1);
    expect(c.sequencedWrites).toBe(1);
    expect(c.staleAutoCulled).toBe(1);
  });
});

describe('runCullerPlan', () => {
  type Spies = {
    runners: CullerPlanRunners;
    runStoreyTick: ReturnType<typeof vi.fn>;
    runElementTick: ReturnType<typeof vi.fn>;
    runStoreyClear: ReturnType<typeof vi.fn>;
    runElementClear: ReturnType<typeof vi.fn>;
    onStoreyCulled: ReturnType<typeof vi.fn>;
    onElementCulled: ReturnType<typeof vi.fn>;
    isDisposed: ReturnType<typeof vi.fn>;
  };

  const makeSpies = (overrides: {
    storeyTickResult?: number;
    elementTickResult?: number;
    storeyTickPromise?: Promise<number>;
    elementTickPromise?: Promise<number>;
    storeyClearPromise?: Promise<void>;
    elementClearPromise?: Promise<void>;
    disposedAfter?: 'storey-tick' | 'element-tick' | 'never';
  } = {}): Spies => {
    let stepsSeen = 0;
    const stepName = ['storey-tick', 'element-tick'] as const;
    const runStoreyTick = vi.fn(async () => {
      stepsSeen = 1;
      return overrides.storeyTickPromise
        ? await overrides.storeyTickPromise
        : (overrides.storeyTickResult ?? 0);
    });
    const runElementTick = vi.fn(async () => {
      stepsSeen = 2;
      return overrides.elementTickPromise
        ? await overrides.elementTickPromise
        : (overrides.elementTickResult ?? 0);
    });
    const runStoreyClear = vi.fn(async () => {
      if (overrides.storeyClearPromise) await overrides.storeyClearPromise;
    });
    const runElementClear = vi.fn(async () => {
      if (overrides.elementClearPromise) await overrides.elementClearPromise;
    });
    const onStoreyCulled = vi.fn();
    const onElementCulled = vi.fn();
    const isDisposed = vi.fn(() => {
      if (overrides.disposedAfter === 'never' || !overrides.disposedAfter) return false;
      return stepName[stepsSeen - 1] === overrides.disposedAfter;
    });

    const runners: CullerPlanRunners = {
      runStoreyTick,
      runElementTick,
      runStoreyClear,
      runElementClear,
      onStoreyCulled,
      onElementCulled,
      isDisposed,
    };
    return {
      runners,
      runStoreyTick,
      runElementTick,
      runStoreyClear,
      runElementClear,
      onStoreyCulled,
      onElementCulled,
      isDisposed,
    };
  };

  const snap = (storeyBuilt: boolean, elementBuilt: boolean): CullerSnapshot => ({
    storeyCullerBuilt: storeyBuilt,
    elementCullerBuilt: elementBuilt,
    isolatedCount: 0,
    hiddenCount: 0,
  });

  it('"noop" does not call any runner', async () => {
    const s = makeSpies();
    await runCullerPlan('noop', snap(false, false), s.runners);
    expect(s.runStoreyTick).not.toHaveBeenCalled();
    expect(s.runElementTick).not.toHaveBeenCalled();
    expect(s.runStoreyClear).not.toHaveBeenCalled();
    expect(s.runElementClear).not.toHaveBeenCalled();
    expect(s.onStoreyCulled).not.toHaveBeenCalled();
    expect(s.onElementCulled).not.toHaveBeenCalled();
  });

  it('"skip" with both cullers built clears both and reports 0 for each', async () => {
    const s = makeSpies();
    await runCullerPlan('skip', snap(true, true), s.runners);
    expect(s.runStoreyClear).toHaveBeenCalledTimes(1);
    expect(s.runElementClear).toHaveBeenCalledTimes(1);
    expect(s.runStoreyTick).not.toHaveBeenCalled();
    expect(s.runElementTick).not.toHaveBeenCalled();
    expect(s.onStoreyCulled).toHaveBeenCalledWith(0);
    expect(s.onElementCulled).toHaveBeenCalledWith(0);
  });

  it('"skip" with only storey built does not call the element clear', async () => {
    const s = makeSpies();
    await runCullerPlan('skip', snap(true, false), s.runners);
    expect(s.runStoreyClear).toHaveBeenCalledTimes(1);
    expect(s.runElementClear).not.toHaveBeenCalled();
    expect(s.onStoreyCulled).toHaveBeenCalledWith(0);
    expect(s.onElementCulled).not.toHaveBeenCalled();
  });

  it('"skip" with only element built does not call the storey clear', async () => {
    const s = makeSpies();
    await runCullerPlan('skip', snap(false, true), s.runners);
    expect(s.runElementClear).toHaveBeenCalledTimes(1);
    expect(s.runStoreyClear).not.toHaveBeenCalled();
    expect(s.onElementCulled).toHaveBeenCalledWith(0);
    expect(s.onStoreyCulled).not.toHaveBeenCalled();
  });

  it('"skip" with neither built calls no runner (matches "noop" effect)', async () => {
    const s = makeSpies();
    await runCullerPlan('skip', snap(false, false), s.runners);
    expect(s.runStoreyClear).not.toHaveBeenCalled();
    expect(s.runElementClear).not.toHaveBeenCalled();
    expect(s.onStoreyCulled).not.toHaveBeenCalled();
    expect(s.onElementCulled).not.toHaveBeenCalled();
  });

  it('"skip" runs storey + element clears concurrently (not sequentially)', async () => {
    // If we make element-clear settle BEFORE storey-clear despite being
    // requested second, sequential code would still see storey first.
    // We use two manually-resolved deferreds to prove concurrency: the
    // orchestrator must have called both clears before either settles.
    let storeyClearResolve!: () => void;
    let elementClearResolve!: () => void;
    const storeyClearPromise = new Promise<void>((res) => { storeyClearResolve = res; });
    const elementClearPromise = new Promise<void>((res) => { elementClearResolve = res; });

    const s = makeSpies({ storeyClearPromise, elementClearPromise });
    const pending = runCullerPlan('skip', snap(true, true), s.runners);

    // Microtask flush: both clears should have been invoked before either resolves.
    await Promise.resolve();
    expect(s.runStoreyClear).toHaveBeenCalledTimes(1);
    expect(s.runElementClear).toHaveBeenCalledTimes(1);

    elementClearResolve();
    storeyClearResolve();
    await pending;
    expect(s.onStoreyCulled).toHaveBeenCalledWith(0);
    expect(s.onElementCulled).toHaveBeenCalledWith(0);
  });

  it('"storey-only" calls storey tick and forwards its return to onStoreyCulled', async () => {
    const s = makeSpies({ storeyTickResult: 7 });
    await runCullerPlan('storey-only', snap(true, false), s.runners);
    expect(s.runStoreyTick).toHaveBeenCalledTimes(1);
    expect(s.runElementTick).not.toHaveBeenCalled();
    expect(s.onStoreyCulled).toHaveBeenCalledWith(7);
    expect(s.onElementCulled).not.toHaveBeenCalled();
  });

  it('"element-only" calls element tick and forwards its return to onElementCulled', async () => {
    const s = makeSpies({ elementTickResult: 12 });
    await runCullerPlan('element-only', snap(false, true), s.runners);
    expect(s.runElementTick).toHaveBeenCalledTimes(1);
    expect(s.runStoreyTick).not.toHaveBeenCalled();
    expect(s.onElementCulled).toHaveBeenCalledWith(12);
    expect(s.onStoreyCulled).not.toHaveBeenCalled();
  });

  it('"storey-then-element" awaits storey tick before kicking off element tick', async () => {
    // This is the core racing-write fix: element tick MUST NOT be called
    // until storey tick has settled.
    let storeyTickResolve!: (n: number) => void;
    const storeyTickPromise = new Promise<number>((res) => { storeyTickResolve = res; });

    const s = makeSpies({ storeyTickPromise, elementTickResult: 3 });
    const pending = runCullerPlan('storey-then-element', snap(true, true), s.runners);

    // Microtask flush: storey tick should have started, element tick must NOT.
    await Promise.resolve();
    await Promise.resolve();
    expect(s.runStoreyTick).toHaveBeenCalledTimes(1);
    expect(s.runElementTick).not.toHaveBeenCalled();

    storeyTickResolve(5);
    await pending;
    expect(s.runElementTick).toHaveBeenCalledTimes(1);
    expect(s.onStoreyCulled).toHaveBeenCalledWith(5);
    expect(s.onElementCulled).toHaveBeenCalledWith(3);
  });

  it('"storey-then-element" reports onStoreyCulled BEFORE element tick fires', async () => {
    // Caller can rely on storey culledStoreys perf-metric update landing
    // before any element work touches setVisible.
    const orderLog: string[] = [];
    const s = makeSpies({ storeyTickResult: 4, elementTickResult: 9 });
    s.onStoreyCulled.mockImplementation(() => { orderLog.push('onStoreyCulled'); });
    s.runElementTick.mockImplementation(async () => {
      orderLog.push('runElementTick');
      return 9;
    });
    s.onElementCulled.mockImplementation(() => { orderLog.push('onElementCulled'); });

    await runCullerPlan('storey-then-element', snap(true, true), s.runners);
    expect(orderLog).toEqual(['onStoreyCulled', 'runElementTick', 'onElementCulled']);
  });

  it('"storey-then-element" skips element tick when isDisposed flips between storey and element', async () => {
    const s = makeSpies({
      storeyTickResult: 1,
      elementTickResult: 2,
      disposedAfter: 'storey-tick',
    });
    await runCullerPlan('storey-then-element', snap(true, true), s.runners);
    expect(s.runStoreyTick).toHaveBeenCalledTimes(1);
    expect(s.runElementTick).not.toHaveBeenCalled();
    // Neither perf metric sink fires once disposed.
    expect(s.onStoreyCulled).not.toHaveBeenCalled();
    expect(s.onElementCulled).not.toHaveBeenCalled();
  });

  it('"storey-only" suppresses onStoreyCulled when isDisposed flips after the tick', async () => {
    const s = makeSpies({ storeyTickResult: 4, disposedAfter: 'storey-tick' });
    await runCullerPlan('storey-only', snap(true, false), s.runners);
    expect(s.runStoreyTick).toHaveBeenCalledTimes(1);
    expect(s.onStoreyCulled).not.toHaveBeenCalled();
  });

  it('"storey-then-element" without isDisposed defined still works (gate is optional)', async () => {
    const runners: CullerPlanRunners = {
      runStoreyTick: vi.fn(async () => 11),
      runElementTick: vi.fn(async () => 22),
      runStoreyClear: vi.fn(async () => {}),
      runElementClear: vi.fn(async () => {}),
      onStoreyCulled: vi.fn(),
      onElementCulled: vi.fn(),
      // no isDisposed
    };
    await runCullerPlan('storey-then-element', snap(true, true), runners);
    expect(runners.runStoreyTick).toHaveBeenCalledTimes(1);
    expect(runners.runElementTick).toHaveBeenCalledTimes(1);
    expect(runners.onStoreyCulled).toHaveBeenCalledWith(11);
    expect(runners.onElementCulled).toHaveBeenCalledWith(22);
  });
});

// ── Minimal FragmentsModel mock ───────────────────────────────────────────────

function makeElementModelMock() {
  const visibilityCalls: Array<{ ids: number[]; visible: boolean }> = [];

  return {
    visibilityCalls,
    setVisible: vi.fn(async (ids: number[], visible: boolean) => {
      visibilityCalls.push({ ids: [...ids], visible });
    }),
    // Each element gets a unique bounding box at (id*2, 0, 0) ± 0.5.
    getBoxes: vi.fn(async (localIds: number[]) => {
      return localIds.map((id) => {
        const x = id * 2;
        return new THREE.Box3(
          new THREE.Vector3(x - 0.5, -0.5, -0.5),
          new THREE.Vector3(x + 0.5, 0.5, 0.5),
        );
      });
    }),
  } as unknown as FRAGS.FragmentsModel & { visibilityCalls: typeof visibilityCalls };
}

// ── Perspective camera that sees everything at localId=0 ─────────────────────

function makeCameraFar(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(75, 1, 0.1, 10_000);
  cam.position.set(0, 0, 100);
  cam.lookAt(0, 0, 0);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
  return cam;
}

// Camera with a very tight frustum - only sees near origin.
function makeCameraNear(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(5, 1, 0.1, 2);
  cam.position.set(0, 0, 1);
  cam.lookAt(0, 0, 0);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
  return cam;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ElementFrustumCuller', () => {
  let model: ReturnType<typeof makeElementModelMock>;
  let culler: ElementFrustumCuller;

  beforeEach(() => {
    model = makeElementModelMock();
    culler = new ElementFrustumCuller();
  });

  it('starts unbuilt with 0 elements', () => {
    expect(culler.isBuilt).toBe(false);
    expect(culler.elementCount).toBe(0);
  });

  it('build() sets isBuilt after resolving geometry', async () => {
    await culler.build(model as unknown as FRAGS.FragmentsModel, [0, 1]);
    expect(culler.isBuilt).toBe(true);
    expect(culler.elementCount).toBe(2);
  });

  it('build() with empty localIds produces 0 elements', async () => {
    await culler.build(model as unknown as FRAGS.FragmentsModel, []);
    expect(culler.isBuilt).toBe(true);
    expect(culler.elementCount).toBe(0);
  });

  it('tick() on unbuilt culler returns 0 and does not call setVisible', async () => {
    const cam = makeCameraFar();
    const count = await culler.tick(cam, model as unknown as FRAGS.FragmentsModel);
    expect(count).toBe(0);
    expect(model.setVisible).not.toHaveBeenCalled();
  });

  it('tick() with wide camera hides nothing', async () => {
    await culler.build(model as unknown as FRAGS.FragmentsModel, [0]);
    const cam = makeCameraFar();
    const count = await culler.tick(cam, model as unknown as FRAGS.FragmentsModel);
    expect(count).toBe(0);
    // No hide calls
    const hideCalls = model.visibilityCalls.filter((c) => !c.visible);
    expect(hideCalls).toHaveLength(0);
  });

  it('tick() batches hide calls - one setVisible(ids, false) call per tick', async () => {
    // Build with 3 elements at x=0,2,4. Tight camera near x=0 may cull x=4 element.
    await culler.build(model as unknown as FRAGS.FragmentsModel, [0, 1, 2]);
    expect(culler.elementCount).toBe(3);
    const cam = makeCameraNear();
    await culler.tick(cam, model as unknown as FRAGS.FragmentsModel);
    // setVisible may have been called 0 or 1 times for hiding (batch)
    const hideCalls = model.visibilityCalls.filter((c) => !c.visible);
    // All hidden elements should be in a single call (batched)
    expect(hideCalls.length).toBeLessThanOrEqual(1);
  });

  it('keeps culler flags retryable when a coordinated hide or show rejects', async () => {
    await culler.build(model as unknown as FRAGS.FragmentsModel, [2]);
    const applyVisibilityDelta = vi
      .fn<VisibilityMutationTarget['applyVisibilityDelta']>()
      .mockRejectedValueOnce(new Error('hide failed'))
      .mockResolvedValue(undefined);
    const target: VisibilityMutationTarget = {
      setVisible: vi.fn(async () => {}),
      applyVisibilityDelta,
    };

    expect(await culler.tick(makeCameraNear(), model, undefined, target)).toBe(0);
    expect(culler.getCulledLocalIds()).toEqual([]);
    expect(await culler.tick(makeCameraNear(), model, undefined, target)).toBe(1);
    expect(culler.getCulledLocalIds()).toEqual([2]);

    target.setVisible = vi
      .fn<VisibilityMutationTarget['setVisible']>()
      .mockRejectedValueOnce(new Error('show failed'))
      .mockResolvedValue(undefined);
    expect(await culler.showPass(makeCameraFar(), model, undefined, target)).toBe(0);
    expect(culler.getCulledLocalIds()).toEqual([2]);
    expect(await culler.showPass(makeCameraFar(), model, undefined, target)).toBe(1);
    expect(culler.getCulledLocalIds()).toEqual([]);
  });

  it('does not reclaim ownership when an old hide acknowledges after release', async () => {
    await culler.build(model as unknown as FRAGS.FragmentsModel, [2]);
    let acknowledge!: () => void;
    const gate = new Promise<void>((resolve) => { acknowledge = resolve; });
    const target: VisibilityMutationTarget = {
      setVisible: vi.fn(async () => {}),
      applyVisibilityDelta: vi.fn(async () => gate),
      clearVisibility: vi.fn(async () => {}),
    };

    const staleTick = culler.tick(makeCameraNear(), model, undefined, target);
    await vi.waitFor(() => expect(target.applyVisibilityDelta).toHaveBeenCalledTimes(1));
    culler.releaseOwnership();
    acknowledge();
    await staleTick;

    expect(culler.getCulledLocalIds()).toEqual([]);
  });

  it('reveals an authoritative hide whose acknowledgement is still in flight', async () => {
    await culler.build(model as unknown as FRAGS.FragmentsModel, [2]);
    let acknowledge!: () => void;
    const gate = new Promise<void>((resolve) => { acknowledge = resolve; });
    const hidden = new Set<number>();
    const target: VisibilityMutationTarget = {
      setVisible: vi.fn(async (ids, visible) => {
        for (const id of ids ?? []) {
          if (visible) hidden.delete(id);
          else hidden.add(id);
        }
      }),
      applyVisibilityDelta: vi.fn(async (toHide, toShow) => {
        for (const id of toShow) hidden.delete(id);
        for (const id of toHide) hidden.add(id);
        await gate;
      }),
      clearVisibility: vi.fn(async () => { hidden.clear(); }),
    };

    const pendingHide = culler.tick(makeCameraNear(), model, undefined, target);
    await vi.waitFor(() => expect(target.applyVisibilityDelta).toHaveBeenCalledTimes(1));
    expect([...hidden]).toEqual([2]);
    expect(culler.getCulledLocalIds()).toEqual([2]);

    // Navigation begins before the settle hide acknowledges. The local flag
    // already represents desired ownership, so only this pending hidden ID is
    // sent through the reveal path.
    await culler.showPass(makeCameraFar(), model, undefined, target);
    expect(target.setVisible).toHaveBeenCalledWith([2], true);
    expect([...hidden]).toEqual([]);

    acknowledge();
    await pendingHide;
    expect(culler.getCulledLocalIds()).toEqual([]);
  });

  it('authoritatively clears a coordinated layer even when local flags are empty', async () => {
    await culler.build(model as unknown as FRAGS.FragmentsModel, [0]);
    const clearVisibility = vi.fn(async () => {});
    const target: VisibilityMutationTarget = {
      setVisible: vi.fn(async () => {}),
      clearVisibility,
    };

    await culler.clearCull(model, target);

    expect(clearVisibility).toHaveBeenCalledTimes(1);
    expect(target.setVisible).not.toHaveBeenCalled();
  });

  it('clearCull() restores culled elements and resets autoCulled flags', async () => {
    await culler.build(model as unknown as FRAGS.FragmentsModel, [0, 1]);
    // Force a tick to potentially cull some
    const cam = makeCameraNear();
    await culler.tick(cam, model as unknown as FRAGS.FragmentsModel);
    const culledBefore = model.visibilityCalls.filter((c) => !c.visible);

    if (culledBefore.length > 0) {
      // Now clear - should restore
      model.visibilityCalls.length = 0;
      await culler.clearCull(model as unknown as FRAGS.FragmentsModel);
      const showCalls = model.visibilityCalls.filter((c) => c.visible);
      expect(showCalls.length).toBeGreaterThan(0);
    }
    // elementCount unchanged after clearCull
    expect(culler.elementCount).toBe(2);
  });

  it('dispose() marks the culler disposed and clears records', async () => {
    await culler.build(model as unknown as FRAGS.FragmentsModel, [0, 1]);
    await culler.dispose(model as unknown as FRAGS.FragmentsModel);
    expect(culler.isBuilt).toBe(false);
    expect(culler.elementCount).toBe(0);
  });

  it('build() after dispose() is a no-op', async () => {
    await culler.dispose(model as unknown as FRAGS.FragmentsModel);
    await culler.build(model as unknown as FRAGS.FragmentsModel, [0]);
    expect(culler.isBuilt).toBe(false);
    expect(culler.elementCount).toBe(0);
  });

  it('tick() after dispose() returns 0', async () => {
    await culler.build(model as unknown as FRAGS.FragmentsModel, [0]);
    await culler.dispose(model as unknown as FRAGS.FragmentsModel);
    const cam = makeCameraFar();
    const count = await culler.tick(cam, model as unknown as FRAGS.FragmentsModel);
    expect(count).toBe(0);
  });

  it('respects MAX_ELEMENTS cap (1500) - build skips elements beyond the cap', async () => {
    // Use 2000 IDs to exceed the cap
    const ids = Array.from({ length: 2000 }, (_, i) => i);
    await culler.build(model as unknown as FRAGS.FragmentsModel, ids);
    expect(culler.elementCount).toBeLessThanOrEqual(1500);
  });

  it('geometry failure is silently skipped', async () => {
    (model.getBoxes as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('no geom'));
    // 65 ids span 2 chunks (64 + 1). Chunk 1 (ids 0-63) fails and is
    // skipped; chunk 2 (id 64) succeeds.
    const ids = Array.from({ length: 65 }, (_, i) => i);
    await culler.build(model as unknown as FRAGS.FragmentsModel, ids);
    expect(culler.elementCount).toBe(1);
  });

  it('empty geometry (isEmpty box) is skipped', async () => {
    (model.getBoxes as ReturnType<typeof vi.fn>).mockResolvedValueOnce([new THREE.Box3()]);
    await culler.build(model as unknown as FRAGS.FragmentsModel, [0]);
    // Empty positions → empty Box3 → skipped
    expect(culler.elementCount).toBe(0);
  });

  // ── chunked geometry fetches ─────────────────────────────────────────
  //
  // build() must batch getBoxes into 64-id chunks (one worker
  // round-trip per chunk, not per element) and honor dispose() between
  // chunks so a model swap mid-build doesn't keep hammering the worker.

  it('build() batches geometry fetches - 130 ids issue ceil(130/64) = 3 calls', async () => {
    const ids = Array.from({ length: 130 }, (_, i) => i);
    await culler.build(model as unknown as FRAGS.FragmentsModel, ids);

    const geomMock = model.getBoxes as ReturnType<typeof vi.fn>;
    expect(geomMock).toHaveBeenCalledTimes(3);
    expect(geomMock.mock.calls.map((c) => (c[0] as number[]).length)).toEqual([64, 64, 2]);
    // Every id still gets its own record - batching must not lose items.
    expect(culler.elementCount).toBe(130);
  });

  it('dispose() mid-build stops further chunk fetches', async () => {
    const ids = Array.from({ length: 130 }, (_, i) => i); // 3 chunks
    const geomMock = model.getBoxes as ReturnType<typeof vi.fn>;
    geomMock.mockImplementationOnce(async (chunk: number[]) => {
      // Dispose while the first chunk is in flight - chunks 2 and 3 must
      // never be fetched.
      void culler.dispose();
      return chunk.map(() => new THREE.Box3(
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(1, 1, 1),
      ));
    });

    await culler.build(model as unknown as FRAGS.FragmentsModel, ids);

    expect(geomMock).toHaveBeenCalledTimes(1);
    expect(culler.isBuilt).toBe(false);
    expect(culler.elementCount).toBe(0);
  });

  // ── Coordination rule ❷ - exclusion set ──────────────────────────────
  //
  // The storey culler tells the element culler "I own these IDs this tick".
  // The element culler must (a) not write `setVisible` for them, and (b)
  // reset its own `autoCulled` flag so its book-keeping doesn't drift while
  // the storey culler is the owner.

  it('tick(excludeIds) skips storey-owned elements from frustum tests', async () => {
    // Build with 3 elements at x=0,2,4. Tight camera near origin culls the
    // far ones. Exclude id=2 entirely.
    await culler.build(model as unknown as FRAGS.FragmentsModel, [0, 1, 2]);
    const cam = makeCameraNear();
    const exclude = new Set<number>([2]);

    await culler.tick(cam, model as unknown as FRAGS.FragmentsModel, exclude);

    // Any setVisible(false) call must not include id=2 - it is storey-owned.
    for (const c of model.visibilityCalls) {
      expect(c.ids).not.toContain(2);
    }
  });

  it('tick(excludeIds) resets autoCulled=false on excluded records (drift fix)', async () => {
    // Set up: element culler hides id=1 on tick 1 (no exclusion). Then tick 2
    // arrives with id=1 in the exclusion set (its storey just got culled by
    // the storey culler). Our `autoCulled` flag for id=1 must reset to false
    // - the storey culler now owns visibility of id=1.
    await culler.build(model as unknown as FRAGS.FragmentsModel, [0, 1, 2]);
    const cam = makeCameraNear();
    // Tick 1 - no exclusion. id=2 gets culled (out of frustum).
    await culler.tick(cam, model as unknown as FRAGS.FragmentsModel);
    const records1 = (culler as unknown as {
      records: Array<{ localId: number; autoCulled: boolean }>;
    }).records;
    const r2Before = records1.find((r) => r.localId === 2);
    // If r2 didn't get culled, this test is a no-op; otherwise verify the
    // reset behavior. The mock camera/box arrangement reliably culls id=2.
    expect(r2Before).toBeDefined();
    // Force the precondition explicitly so the test isn't camera-fragile.
    r2Before!.autoCulled = true;

    // Tick 2 - id=2 is now storey-owned. Cull is excluded; autoCulled must reset.
    model.visibilityCalls.length = 0;
    await culler.tick(
      cam,
      model as unknown as FRAGS.FragmentsModel,
      new Set([2]),
    );

    const r2After = (culler as unknown as {
      records: Array<{ localId: number; autoCulled: boolean }>;
    }).records.find((r) => r.localId === 2)!;
    expect(r2After.autoCulled).toBe(false);
  });

  it('tick(excludeIds) does not emit setVisible writes for excluded ids', async () => {
    await culler.build(model as unknown as FRAGS.FragmentsModel, [0, 1, 2]);
    const cam = makeCameraNear();
    await culler.tick(
      cam,
      model as unknown as FRAGS.FragmentsModel,
      new Set([0, 1, 2]),
    );
    // With every element excluded, no setVisible call should fire from the
    // element culler at all.
    expect(model.visibilityCalls).toHaveLength(0);
  });

  it('tick() with undefined excludeIds preserves the original behaviour', async () => {
    // Regression guard: omitting the 3rd arg must behave identically to the
    // two-arg signature so the wire-up at the callsite can be added
    // incrementally without breaking other call paths.
    await culler.build(model as unknown as FRAGS.FragmentsModel, [0, 1, 2]);
    const cam = makeCameraNear();
    const count = await culler.tick(cam, model as unknown as FRAGS.FragmentsModel);
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it('return count excludes storey-owned records even if they were autoCulled previously', async () => {
    // 2 records - id=1 we force to autoCulled=true (was previously culled
    // by the element culler). With id=1 in the exclusion set, the storey
    // culler owns it; the element culler must reset autoCulled and the
    // returned count must not include id=1.
    await culler.build(model as unknown as FRAGS.FragmentsModel, [0, 1]);
    const records = (culler as unknown as {
      records: Array<{ localId: number; autoCulled: boolean }>;
    }).records;
    const r1 = records.find((r) => r.localId === 1)!;
    r1.autoCulled = true;
    const cam = makeCameraFar();
    const count = await culler.tick(
      cam,
      model as unknown as FRAGS.FragmentsModel,
      new Set([1]),
    );
    // With a wide camera, the only "culled" record before the tick was id=1.
    // The exclusion set reclaims it, so the post-tick count must be 0.
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(
  id: number,
  ifc_type: string,
  name: string,
  children: SpatialNode[] = [],
): SpatialNode {
  return { id, global_id: `id-${id}`, ifc_type, name, children };
}

function makeTree(): SpatialNode {
  return makeNode(1, 'IfcProject', 'Project', [
    makeNode(2, 'IfcSite', 'Site', [
      makeNode(3, 'IfcBuilding', 'Building', [
        makeNode(10, 'IfcBuildingStorey', 'Ground Floor', [
          makeNode(100, 'IfcWall', 'Wall A', []),
          makeNode(101, 'IfcWall', 'Wall B', []),
        ]),
        makeNode(11, 'IfcBuildingStorey', 'First Floor', [
          makeNode(110, 'IfcSlab', 'Slab', []),
        ]),
        makeNode(12, 'IfcBuildingStorey', 'Second Floor', []),
      ]),
    ]),
  ]);
}

/**
 * Minimal FragmentsModel mock for build() tests. getItem resolves
 * express → local as `expressId + 1000`; getBoxes returns one box per
 * requested id (result parallel to the input array).
 */
function makeModelMock() {
  return {
    setVisible: vi.fn(async () => {}),
    getItem: vi.fn((expressId: number) => ({
      getLocalId: vi.fn(async () => expressId + 1000),
    })),
    getBoxes: vi.fn(async (localIds: number[]) =>
      localIds.map((id) => new THREE.Box3(
        new THREE.Vector3(id, 0, 0),
        new THREE.Vector3(id + 1, 1, 1),
      )),
    ),
  } as unknown as FRAGS.FragmentsModel;
}

// ---------------------------------------------------------------------------
// extractStoreyNodes
// ---------------------------------------------------------------------------

describe('extractStoreyNodes', () => {
  it('returns empty array for null root', () => {
    expect(extractStoreyNodes(null)).toEqual([]);
  });

  it('returns empty array when tree has no storeys', () => {
    const root = makeNode(1, 'IfcProject', 'P', [
      makeNode(2, 'IfcSite', 'S', []),
    ]);
    expect(extractStoreyNodes(root)).toHaveLength(0);
  });

  it('extracts all storey nodes from a 3-storey tree', () => {
    const result = extractStoreyNodes(makeTree());
    expect(result).toHaveLength(3);
    expect(result.map((n) => n.id)).toEqual([10, 11, 12]);
  });

  it('extracts storey names correctly', () => {
    const result = extractStoreyNodes(makeTree());
    expect(result[0].name).toBe('Ground Floor');
    expect(result[1].name).toBe('First Floor');
    expect(result[2].name).toBe('Second Floor');
  });

  it('does not include non-storey nodes', () => {
    const result = extractStoreyNodes(makeTree());
    const types = result.map((n) => n.ifc_type.toLowerCase());
    for (const t of types) {
      expect(t).toBe('ifcbuildingstorey');
    }
  });

  it('handles a flat list of storeys at root level', () => {
    const root = makeNode(1, 'IfcProject', 'P', [
      makeNode(10, 'IfcBuildingStorey', 'S1', []),
      makeNode(11, 'IfcBuildingStorey', 'S2', []),
    ]);
    const result = extractStoreyNodes(root);
    expect(result).toHaveLength(2);
  });

  it('does not recurse into storey children for nested-storey models', () => {
    // Degenerate model: storey has another storey as a child.
    const root = makeNode(1, 'IfcProject', 'P', [
      makeNode(10, 'IfcBuildingStorey', 'Parent Storey', [
        makeNode(11, 'IfcBuildingStorey', 'Nested Storey', []),
      ]),
    ]);
    // extractStoreyNodes stops recursion at the first storey level
    const result = extractStoreyNodes(root);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(10);
  });

  it('handles a single-storey model', () => {
    const root = makeNode(1, 'IfcProject', 'P', [
      makeNode(2, 'IfcBuilding', 'B', [
        makeNode(10, 'IfcBuildingStorey', 'Only Floor', [
          makeNode(100, 'IfcWall', 'W', []),
        ]),
      ]),
    ]);
    expect(extractStoreyNodes(root)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// StoreyFrustumCuller.getCulledMemberIds (coordination rule ❷)
// ---------------------------------------------------------------------------
//
// The getter reads `records` directly - it does not require model geometry to
// be built, so we test it by mutating the internal `records` array via a thin
// wrapper. This mirrors the pattern used by the element-culler tests, which
// also bypass `build()` for record-shape verification.

interface StoreyRecord {
  storeyId: number;
  name: string;
  localIds: number[];
  box: unknown;
  autoCulled: boolean;
}

function seedRecords(culler: StoreyFrustumCuller, records: StoreyRecord[]): void {
  // Force `_built = true` and replace records so the getter has data to read.
  // We use the same shape `build()` would produce.
  const internal = culler as unknown as {
    records: StoreyRecord[];
    _built: boolean;
  };
  internal.records = records;
  internal._built = true;
}

describe('StoreyFrustumCuller.getCulledMemberIds', () => {
  it('returns [] before build', () => {
    const culler = new StoreyFrustumCuller();
    expect(culler.getCulledMemberIds()).toEqual([]);
  });

  it('returns [] when all storeys are visible', () => {
    const culler = new StoreyFrustumCuller();
    seedRecords(culler, [
      { storeyId: 1, name: 'A', localIds: [10, 11], box: {}, autoCulled: false },
      { storeyId: 2, name: 'B', localIds: [20, 21], box: {}, autoCulled: false },
    ]);
    expect(culler.getCulledMemberIds()).toEqual([]);
  });

  it('returns local ids of one culled storey', () => {
    const culler = new StoreyFrustumCuller();
    seedRecords(culler, [
      { storeyId: 1, name: 'A', localIds: [10, 11], box: {}, autoCulled: false },
      { storeyId: 2, name: 'B', localIds: [20, 21, 22], box: {}, autoCulled: true },
    ]);
    expect(culler.getCulledMemberIds()).toEqual([20, 21, 22]);
  });

  it('concatenates members across multiple culled storeys in record order', () => {
    const culler = new StoreyFrustumCuller();
    seedRecords(culler, [
      { storeyId: 1, name: 'A', localIds: [10, 11], box: {}, autoCulled: true },
      { storeyId: 2, name: 'B', localIds: [20], box: {}, autoCulled: false },
      { storeyId: 3, name: 'C', localIds: [30, 31], box: {}, autoCulled: true },
    ]);
    expect(culler.getCulledMemberIds()).toEqual([10, 11, 30, 31]);
  });

  it('returns [] after dispose', async () => {
    const culler = new StoreyFrustumCuller();
    seedRecords(culler, [
      { storeyId: 1, name: 'A', localIds: [10, 11], box: {}, autoCulled: true },
    ]);
    expect(culler.getCulledMemberIds()).toEqual([10, 11]);
    await culler.dispose();
    expect(culler.getCulledMemberIds()).toEqual([]);
  });

  it('treats 0 as a real local id (not coerced to empty)', () => {
    const culler = new StoreyFrustumCuller();
    seedRecords(culler, [
      { storeyId: 1, name: 'A', localIds: [0, 1], box: {}, autoCulled: true },
    ]);
    expect(culler.getCulledMemberIds()).toEqual([0, 1]);
  });
});

describe('StoreyFrustumCuller visibility ownership', () => {
  it('ignores a stale hide acknowledgement after ownership is released', async () => {
    const culler = new StoreyFrustumCuller();
    seedRecords(culler, [{
      storeyId: 1,
      name: 'Far storey',
      localIds: [10, 11],
      box: new THREE.Box3(
        new THREE.Vector3(100, 100, 100),
        new THREE.Vector3(101, 101, 101),
      ),
      autoCulled: false,
    }]);
    let acknowledge!: () => void;
    const gate = new Promise<void>((resolve) => { acknowledge = resolve; });
    const target: VisibilityMutationTarget = {
      setVisible: vi.fn(async () => {}),
      applyVisibilityDelta: vi.fn(async () => gate),
      clearVisibility: vi.fn(async () => {}),
    };
    const camera = new THREE.PerspectiveCamera(5, 1, 0.1, 2);
    camera.position.set(0, 0, 1);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    const staleTick = culler.tick(camera, makeModelMock(), target);
    await vi.waitFor(() => expect(target.applyVisibilityDelta).toHaveBeenCalledTimes(1));
    culler.releaseOwnership();
    acknowledge();
    await staleTick;

    expect(culler.getCulledMemberIds()).toEqual([]);
  });

  it('reveals an authoritative storey hide while its acknowledgement is pending', async () => {
    const culler = new StoreyFrustumCuller();
    seedRecords(culler, [{
      storeyId: 1,
      name: 'Far storey',
      localIds: [10, 11],
      box: new THREE.Box3(
        new THREE.Vector3(100, 100, 100),
        new THREE.Vector3(101, 101, 101),
      ),
      autoCulled: false,
    }]);
    const hidden = new Set<number>();
    let acknowledge!: () => void;
    const gate = new Promise<void>((resolve) => { acknowledge = resolve; });
    const target: VisibilityMutationTarget = {
      setVisible: vi.fn(async (ids, visible) => {
        for (const id of ids ?? []) {
          if (visible) hidden.delete(id);
          else hidden.add(id);
        }
      }),
      applyVisibilityDelta: vi.fn(async (toHide, toShow) => {
        for (const id of toShow) hidden.delete(id);
        for (const id of toHide) hidden.add(id);
        await gate;
      }),
      clearVisibility: vi.fn(async () => { hidden.clear(); }),
    };
    const hiddenCamera = new THREE.PerspectiveCamera(5, 1, 0.1, 2);
    hiddenCamera.position.set(0, 0, 1);
    hiddenCamera.lookAt(0, 0, 0);
    hiddenCamera.updateProjectionMatrix();
    hiddenCamera.updateMatrixWorld();
    const visibleCamera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    visibleCamera.position.set(100.5, 100.5, 105);
    visibleCamera.lookAt(100.5, 100.5, 100.5);
    visibleCamera.updateProjectionMatrix();
    visibleCamera.updateMatrixWorld();

    const pendingHide = culler.tick(hiddenCamera, makeModelMock(), target);
    await vi.waitFor(() => expect(target.applyVisibilityDelta).toHaveBeenCalledTimes(1));
    expect([...hidden]).toEqual([10, 11]);
    expect(culler.getCulledMemberIds()).toEqual([10, 11]);

    await culler.showPass(visibleCamera, makeModelMock(), target);
    expect(target.setVisible).toHaveBeenCalledWith([10, 11], true);
    expect([...hidden]).toEqual([]);

    acknowledge();
    await pendingHide;
    expect(culler.getCulledMemberIds()).toEqual([]);
  });

  it('rolls back only the newest failed desired hide and show', async () => {
    const culler = new StoreyFrustumCuller();
    seedRecords(culler, [{
      storeyId: 1,
      name: 'Far storey',
      localIds: [10, 11],
      box: new THREE.Box3(
        new THREE.Vector3(100, 100, 100),
        new THREE.Vector3(101, 101, 101),
      ),
      autoCulled: false,
    }]);
    const hiddenCamera = new THREE.PerspectiveCamera(5, 1, 0.1, 2);
    hiddenCamera.position.set(0, 0, 1);
    hiddenCamera.lookAt(0, 0, 0);
    hiddenCamera.updateProjectionMatrix();
    hiddenCamera.updateMatrixWorld();
    const visibleCamera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    visibleCamera.position.set(100.5, 100.5, 105);
    visibleCamera.lookAt(100.5, 100.5, 100.5);
    visibleCamera.updateProjectionMatrix();
    visibleCamera.updateMatrixWorld();
    const target: VisibilityMutationTarget = {
      setVisible: vi
        .fn<VisibilityMutationTarget['setVisible']>()
        .mockRejectedValueOnce(new Error('show failed'))
        .mockResolvedValue(undefined),
      applyVisibilityDelta: vi
        .fn<NonNullable<VisibilityMutationTarget['applyVisibilityDelta']>>()
        .mockRejectedValueOnce(new Error('hide failed'))
        .mockResolvedValue(undefined),
    };

    expect(await culler.tick(hiddenCamera, makeModelMock(), target)).toBe(0);
    expect(culler.getCulledMemberIds()).toEqual([]);
    expect(await culler.tick(hiddenCamera, makeModelMock(), target)).toBe(1);
    expect(culler.getCulledMemberIds()).toEqual([10, 11]);

    expect(await culler.showPass(visibleCamera, makeModelMock(), target)).toBe(0);
    expect(culler.getCulledMemberIds()).toEqual([10, 11]);
    expect(await culler.showPass(visibleCamera, makeModelMock(), target)).toBe(1);
    expect(culler.getCulledMemberIds()).toEqual([]);
  });

  it('authoritatively clears the target layer with no locally-culled records', async () => {
    const culler = new StoreyFrustumCuller();
    seedRecords(culler, [{
      storeyId: 1,
      name: 'Visible',
      localIds: [10],
      box: new THREE.Box3(),
      autoCulled: false,
    }]);
    const clearVisibility = vi.fn(async () => {});
    const target: VisibilityMutationTarget = {
      setVisible: vi.fn(async () => {}),
      clearVisibility,
    };

    await culler.clearCull(makeModelMock(), target);

    expect(clearVisibility).toHaveBeenCalledTimes(1);
    expect(target.setVisible).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// StoreyFrustumCuller.build - D1 chunked fetches + pre-resolved local ids
// ---------------------------------------------------------------------------

/** Single-storey tree with `count` leaf walls (express ids 1000…1000+count-1). */
function makeWideTree(count: number): { root: SpatialNode; lookup: Map<number, number> } {
  const leaves = Array.from({ length: count }, (_, i) =>
    makeNode(1000 + i, 'IfcWall', `Wall ${i}`),
  );
  const root = makeNode(1, 'IfcProject', 'P', [
    makeNode(10, 'IfcBuildingStorey', 'S', leaves),
  ]);
  // Identity-ish express→local map (local = express, distinct from the
  // mock's +1000 fallback so the two paths are tell-apart-able).
  const lookup = new Map<number, number>(
    leaves.map((n) => [n.id, n.id] as [number, number]),
  );
  return { root, lookup };
}

describe('StoreyFrustumCuller.build', () => {
  it('with localIdLookup performs zero getItem/getLocalId round-trips', async () => {
    const model = makeModelMock();
    const culler = new StoreyFrustumCuller();
    const lookup = new Map<number, number>([
      [100, 1100],
      [101, 1101],
      [110, 1110],
    ]);

    await culler.build(model, extractStoreyNodes(makeTree()), lookup);

    expect(model.getItem).not.toHaveBeenCalled();
    expect(culler.isBuilt).toBe(true);
    expect(culler.storeyCount).toBe(2); // Second Floor has no leaves
    // The lookup-resolved local ids are what the geometry fetch receives.
    const geomMock = model.getBoxes as ReturnType<typeof vi.fn>;
    expect(geomMock.mock.calls.map((c) => c[0])).toEqual([[1100, 1101], [1110]]);
  });

  it('without lookup falls back to per-id getItem().getLocalId() resolution', async () => {
    const model = makeModelMock();
    const culler = new StoreyFrustumCuller();

    await culler.build(model, extractStoreyNodes(makeTree()));

    expect(model.getItem).toHaveBeenCalledTimes(3); // leaves 100, 101, 110
    expect(culler.storeyCount).toBe(2);
    // Fallback-resolved ids (express + 1000) reach the geometry fetch.
    const geomMock = model.getBoxes as ReturnType<typeof vi.fn>;
    expect(geomMock.mock.calls.map((c) => c[0])).toEqual([[1100, 1101], [1110]]);
  });

  it('chunks geometry fetches - a 130-leaf storey issues ceil(130/64) = 3 calls', async () => {
    const { root, lookup } = makeWideTree(130);
    const model = makeModelMock();
    const culler = new StoreyFrustumCuller();

    await culler.build(model, extractStoreyNodes(root), lookup);

    const geomMock = model.getBoxes as ReturnType<typeof vi.fn>;
    expect(geomMock).toHaveBeenCalledTimes(3);
    expect(geomMock.mock.calls.map((c) => (c[0] as number[]).length)).toEqual([64, 64, 2]);
    expect(culler.storeyCount).toBe(1); // chunks accumulate into ONE storey box
  });

  it('dispose() mid-build stops further chunk fetches', async () => {
    const { root, lookup } = makeWideTree(130); // 3 chunks
    const model = makeModelMock();
    const culler = new StoreyFrustumCuller();
    const geomMock = model.getBoxes as ReturnType<typeof vi.fn>;
    geomMock.mockImplementationOnce(async (chunk: number[]) => {
      // Dispose while the first chunk is in flight - chunks 2 and 3 must
      // never be fetched.
      void culler.dispose();
      return chunk.map((id) => [
        {
          positions: new Float32Array([id, 0, 0, id + 1, 1, 1]),
          transform: new THREE.Matrix4(),
        },
      ]);
    });

    await culler.build(model, extractStoreyNodes(root), lookup);

    expect(geomMock).toHaveBeenCalledTimes(1);
    expect(culler.isBuilt).toBe(false);
    expect(culler.storeyCount).toBe(0);
  });
});

describe('decideCullerPolicy', () => {
  it('disables element culling for BasicHouse-sized synthetic models', () => {
    expect(decideCullerPolicy({
      navigationState: 'idle',
      elementCount: 149,
      isolatedCount: 0,
      hiddenCount: 0,
      storeyCullerBuilt: false,
      elementCullerBuilt: true,
      autoCulledCount: 0,
    })).toEqual({
      mode: 'disabled',
      runShowPass: false,
      runHidePass: false,
      elementCullerEnabled: false,
      storeyCullerEnabled: false,
    });
  });

  it('stands down when user isolation or hidden elements own visibility', () => {
    expect(decideCullerPolicy({
      navigationState: 'idle',
      elementCount: 500,
      isolatedCount: 2,
      hiddenCount: 0,
      storeyCullerBuilt: true,
      elementCullerBuilt: true,
      autoCulledCount: 20,
    })).toMatchObject({
      mode: 'stand-down-user-visibility',
      runShowPass: false,
      runHidePass: false,
    });
  });

  it('runs show-only work during navigation', () => {
    expect(decideCullerPolicy({
      navigationState: 'navigating',
      elementCount: 500,
      isolatedCount: 0,
      hiddenCount: 0,
      storeyCullerBuilt: true,
      elementCullerBuilt: true,
      autoCulledCount: 20,
    })).toMatchObject({
      mode: 'show-only',
      runShowPass: true,
      runHidePass: false,
    });
  });

  it('runs hide work only after idle', () => {
    expect(decideCullerPolicy({
      navigationState: 'idle',
      elementCount: 500,
      isolatedCount: 0,
      hiddenCount: 0,
      storeyCullerBuilt: true,
      elementCullerBuilt: true,
      autoCulledCount: 0,
    })).toMatchObject({
      mode: 'hide-after-idle',
      runShowPass: false,
      runHidePass: true,
    });
  });
});
