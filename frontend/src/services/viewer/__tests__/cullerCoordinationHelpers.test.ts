import { describe, it, expect, vi } from 'vitest';
import {
  decideCullerWork,
  partitionElementsByOwner,
  decideElementCullerAction,
  tallyCullerCoordination,
  runCullerPlan,
  type CullerSnapshot,
  type CullerTickInput,
  type CullerPlanRunners,
} from '../cullerCoordinationHelpers';

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
