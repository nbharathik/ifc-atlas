import { describe, expect, it, vi } from 'vitest';
import {
  canReuseExactHoverPick,
  canReusePrefetchedPick,
  createPickLeaseCoordinator,
  createPickRequestToken,
  decideVoidClick,
  isClickGesture,
  isConfirmedVoidPick,
  isNoopSameElementClick,
  isStalePickResult,
  DEFAULT_INTERACTION_QUALITY_STATE,
  getRuntimeQualitySettings,
  reduceInteractionQuality,
  shouldDelayHoverRaycast,
  shouldRunHoverRaycast,
  createLatestAsyncScheduler,
  createContextMenuPickGuard,
} from '../interaction';

describe('pickingPipeline helpers', () => {
  it('holds an exact-pick lease until every overlapping pick releases', () => {
    const transitions: boolean[] = [];
    const leases = createPickLeaseCoordinator((active) => transitions.push(active));
    const releaseFirst = leases.acquire();
    const releaseSecond = leases.acquire();

    expect(leases.active).toBe(true);
    expect(leases.count).toBe(2);
    expect(transitions).toEqual([true]);

    releaseFirst();
    releaseFirst();
    expect(leases.active).toBe(true);
    expect(leases.count).toBe(1);

    releaseSecond();
    expect(leases.active).toBe(false);
    expect(leases.count).toBe(0);
    expect(transitions).toEqual([true, false]);
  });

  it('marks out-of-order pick results as stale', () => {
    const token = createPickRequestToken(4);

    expect(isStalePickResult({
      requestGeneration: token.generation,
      currentGeneration: 5,
    })).toBe(true);
    expect(isStalePickResult({
      requestGeneration: token.generation,
      currentGeneration: 4,
    })).toBe(false);
  });

  it('clears selection on void click when shift is not held', () => {
    expect(decideVoidClick({
      shiftKey: false,
      selectedElementId: 12,
      fastPickerAvailable: true,
      fastPickerHit: false,
      exactHit: false,
    })).toEqual({
      clearSelection: true,
      skipExactRaycastNextTime: true,
    });
  });

  it('keeps selection on shift void click', () => {
    expect(decideVoidClick({
      shiftKey: true,
      selectedElementId: 12,
      fastPickerAvailable: true,
      fastPickerHit: false,
      exactHit: false,
    }).clearSelection).toBe(false);
  });

  it('does not treat a real exact hit as a void click when FastModelPicker misses', () => {
    expect(decideVoidClick({
      shiftKey: false,
      selectedElementId: 12,
      fastPickerAvailable: true,
      fastPickerHit: false,
      exactHit: true,
    })).toEqual({
      clearSelection: false,
      skipExactRaycastNextTime: false,
    });
  });

  it('detects no-op same-element click in single selection mode', () => {
    expect(isNoopSameElementClick({
      clickedExpressId: 8,
      selectedElementId: 8,
      selectedIds: [],
      shiftKey: false,
    })).toBe(true);
  });

  it('does not treat shift-click as no-op because it toggles multi-selection', () => {
    expect(isNoopSameElementClick({
      clickedExpressId: 8,
      selectedElementId: 8,
      selectedIds: [],
      shiftKey: true,
    })).toBe(false);
  });

  it('accepts a long stationary press and rejects actual pointer travel', () => {
    expect(isClickGesture({ distancePx: 0, elapsedMs: 600 })).toBe(true);
    expect(isClickGesture({ distancePx: 3, elapsedMs: 2_000 })).toBe(true);
    expect(isClickGesture({ distancePx: 5, elapsedMs: 20 })).toBe(false);
  });

  it('does not turn a raycast failure into a void click', () => {
    expect(isConfirmedVoidPick({ exactHit: false, error: null })).toBe(true);
    expect(isConfirmedVoidPick({ exactHit: true, error: null })).toBe(false);
    expect(isConfirmedVoidPick({ exactHit: false, error: new Error('worker failed') })).toBe(false);
  });

  it('reuses only a fresh authoritative hover hit from unchanged viewer state', () => {
    const reusable = {
      exactHit: true,
      distancePx: 1.5,
      ageMs: 80,
      cameraUnchanged: true,
      visibilityUnchanged: true,
      fragmentReplacementBlocked: false,
    };
    expect(canReuseExactHoverPick(reusable)).toBe(true);
    expect(canReuseExactHoverPick({ ...reusable, exactHit: false })).toBe(false);
    expect(canReuseExactHoverPick({ ...reusable, ageMs: 151 })).toBe(false);
    expect(canReuseExactHoverPick({ ...reusable, cameraUnchanged: false })).toBe(false);
    expect(canReuseExactHoverPick({ ...reusable, visibilityUnchanged: false })).toBe(false);
    expect(canReuseExactHoverPick({ ...reusable, fragmentReplacementBlocked: true })).toBe(false);
  });

  it('honours explicit hover-reuse pixel and age budgets', () => {
    expect(canReuseExactHoverPick({
      exactHit: true,
      distancePx: 4,
      ageMs: 300,
      cameraUnchanged: true,
      visibilityUnchanged: true,
      fragmentReplacementBlocked: false,
      tolerancePx: 4,
      maxAgeMs: 300,
    })).toBe(true);
  });

  it('reuses a pointer-down prefetch only at the same release point and scene state', () => {
    const reusable = {
      requestGeneration: 7,
      currentGeneration: 7,
      distancePx: 1,
      cameraUnchanged: true,
      visibilityUnchanged: true,
      fragmentReplacementBlocked: false,
    };

    expect(canReusePrefetchedPick(reusable)).toBe(true);
    // A 4 px gesture is still a click, but its exact ray must be recomputed at
    // pointer-up instead of reusing the pointer-down pixel.
    expect(canReusePrefetchedPick({ ...reusable, distancePx: 4 })).toBe(false);
    expect(canReusePrefetchedPick({ ...reusable, currentGeneration: 8 })).toBe(false);
    expect(canReusePrefetchedPick({ ...reusable, cameraUnchanged: false })).toBe(false);
    expect(canReusePrefetchedPick({ ...reusable, visibilityUnchanged: false })).toBe(false);
    expect(canReusePrefetchedPick({ ...reusable, fragmentReplacementBlocked: true })).toBe(false);
  });

  it('fails prefetched-pick reuse closed for invalid distance and honours a custom radius', () => {
    const base = {
      requestGeneration: 3,
      currentGeneration: 3,
      cameraUnchanged: true,
      visibilityUnchanged: true,
      fragmentReplacementBlocked: false,
    };
    expect(canReusePrefetchedPick({ ...base, distancePx: Number.NaN })).toBe(false);
    expect(canReusePrefetchedPick({ ...base, distancePx: -1 })).toBe(false);
    expect(canReusePrefetchedPick({ ...base, distancePx: 2, tolerancePx: 2 })).toBe(true);
  });
});

describe('reduceInteractionQuality', () => {
  it('drops to interactive quality while navigating', () => {
    const next = reduceInteractionQuality(DEFAULT_INTERACTION_QUALITY_STATE, {
      type: 'navigation-start',
    });

    expect(next).toMatchObject({
      active: 'interactive',
      navigating: true,
      slowFrameStreak: 0,
      stableFrameStreak: 0,
    });
    expect(getRuntimeQualitySettings(next.active)).toMatchObject({
      hoverRaycastEnabled: false,
      cullerHideEnabled: false,
      postprocessing: 'off',
    });
  });

  it('drops one quality level after repeated synthetic slow frames', () => {
    const quality = reduceInteractionQuality(DEFAULT_INTERACTION_QUALITY_STATE, {
      type: 'set-target',
      target: 'quality',
    });

    const firstSlow = reduceInteractionQuality(quality, { type: 'frame', ms: 45 });
    const secondSlow = reduceInteractionQuality(firstSlow, { type: 'frame', ms: 42 });

    expect(firstSlow.active).toBe('quality');
    expect(secondSlow.active).toBe('balanced');
    expect(secondSlow.slowFrameStreak).toBe(0);
  });

  it('restores quality gradually after stable synthetic frames', () => {
    let state = reduceInteractionQuality(DEFAULT_INTERACTION_QUALITY_STATE, {
      type: 'set-target',
      target: 'quality',
    });
    state = reduceInteractionQuality(state, { type: 'frame', ms: 45 });
    state = reduceInteractionQuality(state, { type: 'frame', ms: 42 });
    expect(state.active).toBe('balanced');

    for (let i = 0; i < 8; i += 1) {
      state = reduceInteractionQuality(state, { type: 'frame', ms: 16 });
    }

    expect(state.active).toBe('quality');
  });

  it('ignores frame adaptation during active navigation', () => {
    let state = reduceInteractionQuality(DEFAULT_INTERACTION_QUALITY_STATE, {
      type: 'navigation-start',
    });
    state = reduceInteractionQuality(state, { type: 'frame', ms: 100 });
    state = reduceInteractionQuality(state, { type: 'frame', ms: 100 });

    expect(state.active).toBe('interactive');
    expect(state.slowFrameStreak).toBe(0);
  });
});

describe('shouldRunHoverRaycast', () => {
  it('keeps measurement raycasts active during navigation', () => {
    expect(shouldRunHoverRaycast({
      measuring: true,
      hoverHighlightEnabled: false,
      cameraNavigating: true,
    })).toBe(true);
  });

  it('suppresses hover-only raycasts during navigation', () => {
    expect(shouldRunHoverRaycast({
      measuring: false,
      hoverHighlightEnabled: true,
      cameraNavigating: true,
    })).toBe(false);
  });

  it('allows hover raycasts when idle and enabled', () => {
    expect(shouldRunHoverRaycast({
      measuring: false,
      hoverHighlightEnabled: true,
      cameraNavigating: false,
    })).toBe(true);
  });

  it('delays only hover-only raycasts', () => {
    expect(shouldDelayHoverRaycast({
      measuring: false,
      hoverHighlightEnabled: true,
      cameraNavigating: false,
    })).toBe(true);
    expect(shouldDelayHoverRaycast({
      measuring: true,
      hoverHighlightEnabled: true,
      cameraNavigating: false,
    })).toBe(false);
    expect(shouldDelayHoverRaycast({
      measuring: false,
      hoverHighlightEnabled: true,
      cameraNavigating: true,
    })).toBe(false);
  });
});

function makeFakeRaf() {
  const queue: Array<{ handle: number; cb: () => void; cancelled: boolean }> = [];
  let nextHandle = 1;
  const raf = vi.fn((cb: () => void) => {
    const handle = nextHandle++;
    queue.push({ handle, cb, cancelled: false });
    return handle;
  });
  const cancelRaf = vi.fn((handle: number) => {
    const entry = queue.find((candidate) => candidate.handle === handle);
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('createLatestAsyncScheduler', () => {
  it('coalesces a synchronous burst into one async run', async () => {
    const fake = makeFakeRaf();
    const run = vi.fn(async () => {});
    const scheduler = createLatestAsyncScheduler({
      raf: fake.raf,
      cancelRaf: fake.cancelRaf,
      run,
    });

    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();
    expect(fake.raf).toHaveBeenCalledTimes(1);

    fake.flush();
    await flushMicrotasks();
    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.inFlight()).toBe(false);
  });

  it('never overlaps runs and collapses in-flight changes into one rerun', async () => {
    const fake = makeFakeRaf();
    const first = deferred();
    let active = 0;
    let maxActive = 0;
    const run = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (run.mock.calls.length === 1) await first.promise;
      active -= 1;
    });
    const scheduler = createLatestAsyncScheduler({
      raf: fake.raf,
      cancelRaf: fake.cancelRaf,
      run,
    });

    scheduler.schedule();
    fake.flush();
    await flushMicrotasks();
    expect(scheduler.inFlight()).toBe(true);

    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();
    fake.flush();
    expect(run).toHaveBeenCalledTimes(1);

    first.resolve();
    await flushMicrotasks();
    expect(fake.raf).toHaveBeenCalledTimes(2);
    fake.flush();
    await flushMicrotasks();

    expect(run).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
  });

  it('a later request observes latest state instead of replaying snapshots', async () => {
    const fake = makeFakeRaf();
    const first = deferred();
    let value = 1;
    const seen: number[] = [];
    const run = vi.fn(async () => {
      seen.push(value);
      if (seen.length === 1) await first.promise;
    });
    const scheduler = createLatestAsyncScheduler({
      raf: fake.raf,
      cancelRaf: fake.cancelRaf,
      run,
    });

    scheduler.schedule();
    fake.flush();
    await flushMicrotasks();
    value = 2;
    scheduler.schedule();
    value = 3;
    scheduler.schedule();

    first.resolve();
    await flushMicrotasks();
    fake.flush();
    await flushMicrotasks();
    expect(seen).toEqual([1, 3]);
  });

  it('cancel suppresses a queued frame and pending rerun', async () => {
    const fake = makeFakeRaf();
    const first = deferred();
    const run = vi.fn(async () => {
      if (run.mock.calls.length === 1) await first.promise;
    });
    const scheduler = createLatestAsyncScheduler({
      raf: fake.raf,
      cancelRaf: fake.cancelRaf,
      run,
    });

    scheduler.schedule();
    fake.flush();
    await flushMicrotasks();
    scheduler.schedule();
    scheduler.cancel();
    first.resolve();
    await flushMicrotasks();
    fake.flush();

    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.pending()).toBe(false);
  });

  it('reports errors and remains usable', async () => {
    const fake = makeFakeRaf();
    const error = new Error('visibility failed');
    const onError = vi.fn();
    const run = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(undefined);
    const scheduler = createLatestAsyncScheduler({
      raf: fake.raf,
      cancelRaf: fake.cancelRaf,
      run,
      onError,
    });

    scheduler.schedule();
    fake.flush();
    await flushMicrotasks();
    expect(onError).toHaveBeenCalledWith(error);

    scheduler.schedule();
    fake.flush();
    await flushMicrotasks();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('marks an in-flight reader superseded when newer state is scheduled', async () => {
    const fake = makeFakeRaf();
    const first = deferred();
    const superseded: boolean[] = [];
    const run = vi.fn(async (context: { isSuperseded: () => boolean }) => {
      if (run.mock.calls.length === 1) {
        await first.promise;
        superseded.push(context.isSuperseded());
      }
    });
    const scheduler = createLatestAsyncScheduler({
      raf: fake.raf,
      cancelRaf: fake.cancelRaf,
      run,
    });

    scheduler.schedule();
    fake.flush();
    await flushMicrotasks();
    scheduler.schedule();
    first.resolve();
    await flushMicrotasks();

    expect(superseded).toEqual([true]);
    fake.flush();
    await flushMicrotasks();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('shutdown invalidates and waits for the current async reader', async () => {
    const fake = makeFakeRaf();
    const gate = deferred();
    let observedSuperseded = false;
    const scheduler = createLatestAsyncScheduler({
      raf: fake.raf,
      cancelRaf: fake.cancelRaf,
      run: async (context) => {
        await gate.promise;
        observedSuperseded = context.isSuperseded();
      },
    });

    scheduler.schedule();
    fake.flush();
    await flushMicrotasks();
    let settled = false;
    const shutdown = scheduler.shutdown().then(() => { settled = true; });
    await flushMicrotasks();
    expect(settled).toBe(false);

    gate.resolve();
    await shutdown;
    expect(settled).toBe(true);
    expect(observedSuperseded).toBe(true);

    scheduler.schedule();
    fake.flush();
    expect(scheduler.pending()).toBe(false);
  });
});

describe('createContextMenuPickGuard', () => {
  it('allows the latest successful hit to open the element menu', () => {
    const guard = createContextMenuPickGuard();
    const generation = guard.begin();
    const hit = { itemId: 42 };

    expect(guard.resolve(generation, { status: 'success', hit })).toEqual({
      kind: 'hit',
      hit,
    });
  });

  it('opens the generic menu only for a confirmed empty-space result', () => {
    const guard = createContextMenuPickGuard();
    const generation = guard.begin();

    expect(guard.resolve(generation, { status: 'success', hit: null })).toEqual({
      kind: 'empty',
    });
  });

  it('does not turn a current pick failure into an empty-space menu', () => {
    const guard = createContextMenuPickGuard();
    const generation = guard.begin();
    const error = new Error('worker unavailable');

    expect(guard.resolve(generation, { status: 'failure', error })).toEqual({
      kind: 'ignore',
      reason: 'failed',
      error,
    });
  });

  it('rejects an older hit when a newer request started first', () => {
    const guard = createContextMenuPickGuard();
    const older = guard.begin();
    const newer = guard.begin();

    expect(guard.resolve(newer, {
      status: 'success',
      hit: { itemId: 2 },
    })).toEqual({ kind: 'hit', hit: { itemId: 2 } });
    expect(guard.resolve(older, {
      status: 'success',
      hit: { itemId: 1 },
    })).toEqual({ kind: 'ignore', reason: 'stale' });
  });

  it('rejects stale misses and failures as well as stale hits', () => {
    const guard = createContextMenuPickGuard();
    const older = guard.begin();
    guard.begin();

    expect(guard.resolve(older, { status: 'success', hit: null })).toEqual({
      kind: 'ignore',
      reason: 'stale',
    });
    expect(guard.resolve(older, {
      status: 'failure',
      error: new Error('late failure'),
    })).toEqual({ kind: 'ignore', reason: 'stale' });
  });

  it('invalidates an in-flight pick for a canceled or dragged right-click', () => {
    const guard = createContextMenuPickGuard();
    const generation = guard.begin();

    guard.invalidate();

    expect(guard.resolve(generation, {
      status: 'success',
      hit: { itemId: 1 },
    })).toEqual({ kind: 'ignore', reason: 'stale' });
  });

  it('allows a fresh request after invalidation', () => {
    const guard = createContextMenuPickGuard();
    const canceled = guard.begin();
    guard.invalidate();
    const fresh = guard.begin();

    expect(guard.resolve(canceled, {
      status: 'success',
      hit: { itemId: 1 },
    })).toEqual({ kind: 'ignore', reason: 'stale' });
    expect(guard.resolve(fresh, {
      status: 'success',
      hit: { itemId: 2 },
    })).toEqual({ kind: 'hit', hit: { itemId: 2 } });
  });

  it('keeps an older hit stale when the latest request fails', () => {
    const guard = createContextMenuPickGuard();
    const older = guard.begin();
    const latest = guard.begin();

    expect(guard.resolve(latest, {
      status: 'failure',
      error: new Error('latest worker failure'),
    })).toMatchObject({ kind: 'ignore', reason: 'failed' });
    expect(guard.resolve(older, {
      status: 'success',
      hit: { itemId: 1 },
    })).toEqual({ kind: 'ignore', reason: 'stale' });
  });

  it('rejects pending and future continuations after disposal', () => {
    const guard = createContextMenuPickGuard();
    const pending = guard.begin();
    guard.dispose();
    const afterDispose = guard.begin();

    expect(guard.resolve(pending, {
      status: 'success',
      hit: { itemId: 1 },
    })).toEqual({ kind: 'ignore', reason: 'disposed' });
    expect(guard.resolve(afterDispose, {
      status: 'success',
      hit: { itemId: 2 },
    })).toEqual({ kind: 'ignore', reason: 'disposed' });
  });
});
