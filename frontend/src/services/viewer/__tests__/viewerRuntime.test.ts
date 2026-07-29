import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';

// Stub three-mesh-bvh so the test doesn't require the native extension.
// The mock attaches / removes a sentinel `boundsTree` on the geometry instance
// exactly as the real library does.
vi.mock('three-mesh-bvh', () => ({
  acceleratedRaycast: vi.fn(),
  computeBoundsTree: function (this: THREE.BufferGeometry) {
    (this as unknown as Record<string, unknown>).boundsTree = { _mock: true };
  },
  disposeBoundsTree: function (this: THREE.BufferGeometry) {
    delete (this as unknown as Record<string, unknown>).boundsTree;
  },
}));

import {
  ViewerSession,
  computeSceneBVH,
  createFragmentUpdateScheduler,
  createInvalidationRenderLoop,
  disposeSceneBVH,
  getBVHCoverage,
  installBVH,
  isBVHInstalled,
  type FragmentUpdateRun,
} from '../viewerRuntime';

// Install once for the whole suite - idempotent.
installBVH();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMesh(vertexCount = 9): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(new Float32Array(vertexCount), 3),
  );
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
}

// ---------------------------------------------------------------------------

describe('installBVH', () => {
  it('is idempotent - multiple calls stay stable', () => {
    installBVH();
    installBVH();
    expect(isBVHInstalled()).toBe(true);
  });

  it('patches computeBoundsTree onto BufferGeometry.prototype', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((THREE.BufferGeometry.prototype as any).computeBoundsTree).toBeTypeOf('function');
  });

  it('patches disposeBoundsTree onto BufferGeometry.prototype', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((THREE.BufferGeometry.prototype as any).disposeBoundsTree).toBeTypeOf('function');
  });
});

// ---------------------------------------------------------------------------

describe('computeSceneBVH', () => {
  it('computes BVH for a regular Mesh with ≥3 vertices', () => {
    const scene = new THREE.Scene();
    const mesh = makeMesh(9);
    scene.add(mesh);

    const count = computeSceneBVH(scene);
    expect(count).toBeGreaterThanOrEqual(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mesh.geometry as any).boundsTree).toBeDefined();
  });

  it('skips meshes with fewer than 3 vertices', () => {
    const scene = new THREE.Scene();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3)); // 1 vertex
    const mesh = new THREE.Mesh(geo);
    scene.add(mesh);

    const before = computeSceneBVH(new THREE.Scene()); // empty → 0
    expect(before).toBe(0);

    // Mesh with 1 vertex should be skipped
    const count = computeSceneBVH(scene);
    expect(count).toBe(0);
  });

  it('skips InstancedMesh', () => {
    const scene = new THREE.Scene();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(9), 3));
    const im = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial(), 4);
    scene.add(im);

    const count = computeSceneBVH(scene);
    expect(count).toBe(0);
  });

  it('skips geometries that already have a boundsTree', () => {
    const scene = new THREE.Scene();
    const mesh = makeMesh(9);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mesh.geometry as any).boundsTree = { pre: true };
    scene.add(mesh);

    const count = computeSceneBVH(scene);
    expect(count).toBe(0);
    // Pre-existing boundsTree must be untouched
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mesh.geometry as any).boundsTree.pre).toBe(true);
  });

  it('returns total count for nested scenes', () => {
    const scene = new THREE.Scene();
    const group = new THREE.Group();
    group.add(makeMesh(9));
    group.add(makeMesh(9));
    scene.add(group);
    scene.add(makeMesh(9));

    const count = computeSceneBVH(scene);
    expect(count).toBe(3);
  });
});

// ---------------------------------------------------------------------------

describe('disposeSceneBVH', () => {
  it('removes boundsTree from all geometries', () => {
    const scene = new THREE.Scene();
    const mesh = makeMesh(9);
    scene.add(mesh);
    computeSceneBVH(scene);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mesh.geometry as any).boundsTree).toBeDefined();

    disposeSceneBVH(scene);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mesh.geometry as any).boundsTree).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe('getBVHCoverage', () => {
  it('returns zero coverage for empty scene', () => {
    const cov = getBVHCoverage(new THREE.Scene());
    expect(cov.totalMeshes).toBe(0);
    expect(cov.coveragePct).toBe(0);
  });

  it('returns 100% when all meshes have boundsTree', () => {
    const scene = new THREE.Scene();
    const mesh = makeMesh(9);
    scene.add(mesh);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mesh.geometry as any).boundsTree = { _mock: true };

    const cov = getBVHCoverage(scene);
    expect(cov.coveragePct).toBe(100);
    expect(cov.bvhMeshes).toBe(1);
    expect(cov.totalMeshes).toBe(1);
  });

  it('returns partial coverage when some meshes lack boundsTree', () => {
    const scene = new THREE.Scene();
    const m1 = makeMesh(9);
    const m2 = makeMesh(9);
    scene.add(m1);
    scene.add(m2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m1.geometry as any).boundsTree = { _mock: true };

    const cov = getBVHCoverage(scene);
    expect(cov.totalMeshes).toBe(2);
    expect(cov.bvhMeshes).toBe(1);
    expect(cov.coveragePct).toBeCloseTo(50);
  });

  it('excludes InstancedMesh from totalMeshes count', () => {
    const scene = new THREE.Scene();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(9), 3));
    const im = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial(), 2);
    scene.add(im);

    const cov = getBVHCoverage(scene);
    expect(cov.totalMeshes).toBe(0);
  });
});


function harness(initialWindowMs = 0) {
  let now = 0;
  let nextHandle = 1;
  const frames = new Map<number, () => void>();
  const invalidate = vi.fn();
  const cancelRaf = vi.fn((handle: number) => { frames.delete(handle); });
  const loop = createInvalidationRenderLoop({
    now: () => now,
    raf: (callback) => {
      const handle = nextHandle++;
      frames.set(handle, callback);
      return handle;
    },
    cancelRaf,
    invalidate,
    initialWindowMs,
  });
  return {
    loop,
    invalidate,
    cancelRaf,
    pending: () => frames.size,
    setNow: (value: number) => { now = value; },
    frame: () => {
      const first = frames.entries().next().value as [number, () => void] | undefined;
      if (!first) throw new Error('No frame is pending');
      frames.delete(first[0]);
      first[1]();
    },
  };
}

describe('createInvalidationRenderLoop', () => {
  it('parks completely when no invalidation window is active', () => {
    const h = harness();
    expect(h.pending()).toBe(0);
    expect(h.loop.snapshot().running).toBe(false);
  });

  it('invalidates immediately and keeps one coalesced frame scheduled', () => {
    const h = harness();
    h.loop.kick(100);
    h.loop.kick(50);
    expect(h.invalidate).toHaveBeenCalledTimes(2);
    expect(h.pending()).toBe(1);
  });

  it('parks after the requested window expires', () => {
    const h = harness();
    h.loop.kick(100);
    h.setNow(50);
    h.frame();
    expect(h.pending()).toBe(1);
    h.setNow(101);
    h.frame();
    expect(h.pending()).toBe(0);
    expect(h.loop.snapshot().running).toBe(false);
  });

  it('extends an active window without starting a second loop', () => {
    const h = harness();
    h.loop.kick(50);
    h.setNow(25);
    h.loop.kick(100);
    expect(h.pending()).toBe(1);
    h.setNow(60);
    h.frame();
    expect(h.pending()).toBe(1);
    h.setNow(126);
    h.frame();
    expect(h.pending()).toBe(0);
  });

  it('supports an initial paint window', () => {
    const h = harness(1_500);
    expect(h.invalidate).toHaveBeenCalledOnce();
    expect(h.pending()).toBe(1);
    expect(h.loop.snapshot().renderUntil).toBe(1_500);
  });

  it('cancels a pending frame and ignores later kicks after stop', () => {
    const h = harness();
    h.loop.kick(100);
    h.loop.stop();
    h.loop.stop();
    expect(h.cancelRaf).toHaveBeenCalledOnce();
    expect(h.pending()).toBe(0);
    const calls = h.invalidate.mock.calls.length;
    h.loop.kick(100);
    expect(h.invalidate).toHaveBeenCalledTimes(calls);
    expect(h.loop.snapshot().stopped).toBe(true);
  });
});


function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('ViewerSession', () => {
  it('starts the runtime once for concurrent callers', async () => {
    const initialize = vi.fn(async () => ({ ready: true }));
    const session = new ViewerSession({ dispose: vi.fn() });

    const [first, second] = await Promise.all([
      session.start(initialize),
      session.start(initialize),
    ]);

    expect(first).toBe(second);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(session.snapshot()).toMatchObject({
      state: 'active',
      startState: 'started',
      pendingBarriers: 0,
    });
    await session.dispose();
  });

  it('runs nested cleanups before disposing the engine', async () => {
    const events: string[] = [];
    const session = new ViewerSession({
      dispose: () => { events.push('engine'); },
    });
    session.addCleanup(() => { events.push('first'); });
    session.addCleanup(async () => {
      await Promise.resolve();
      events.push('second');
    });

    await session.dispose();

    expect(events).toEqual(['second', 'first', 'engine']);
    expect(session.snapshot().state).toBe('disposed');
  });

  it('keeps the engine alive until registered async work settles', async () => {
    const gate = deferred();
    const disposeEngine = vi.fn();
    const session = new ViewerSession({ dispose: disposeEngine });
    session.addBarrier(gate.promise);

    const disposing = session.dispose();
    await Promise.resolve();
    expect(disposeEngine).not.toHaveBeenCalled();

    gate.resolve();
    await disposing;
    expect(disposeEngine).toHaveBeenCalledTimes(1);
  });

  it('is idempotent and revokes worker URLs after engine disposal', async () => {
    const events: string[] = [];
    const session = new ViewerSession(
      { dispose: () => { events.push('engine'); } },
      { revokeObjectUrl: (url) => { events.push(`revoke:${url}`); } },
    );
    session.ownObjectUrl('blob:fragments-worker');

    const first = session.dispose();
    const second = session.dispose();
    expect(second).toBe(first);
    await Promise.all([first, second]);

    expect(events).toEqual(['engine', 'revoke:blob:fragments-worker']);
  });

  it('aborts session-scoped work as soon as disposal starts', async () => {
    const session = new ViewerSession({ dispose: vi.fn() });
    const abort = vi.fn();
    session.signal.addEventListener('abort', abort);

    await session.dispose();

    expect(abort).toHaveBeenCalledTimes(1);
    expect(session.signal.aborted).toBe(true);
  });

  it('releases every resource across repeated start and dispose cycles', async () => {
    const disposeEngine = vi.fn();
    const cleanup = vi.fn();

    for (let index = 0; index < 20; index += 1) {
      const session = new ViewerSession({ dispose: disposeEngine });
      await session.start(({ addCleanup }) => {
        addCleanup(cleanup);
        return { index };
      });
      await session.dispose();
      expect(session.snapshot()).toEqual({
        state: 'disposed',
        startState: 'started',
        pendingBarriers: 0,
        registeredCleanups: 0,
        ownedObjectUrls: 0,
      });
    }

    expect(cleanup).toHaveBeenCalledTimes(20);
    expect(disposeEngine).toHaveBeenCalledTimes(20);
  });
});


function makeFakeRaf() {
  const queue: Array<{ handle: number; cb: () => void; cancelled: boolean }> = [];
  let nextHandle = 1;
  const raf = vi.fn((cb: () => void) => {
    const handle = nextHandle;
    nextHandle += 1;
    queue.push({ handle, cb, cancelled: false });
    return handle;
  });
  const cancelRaf = vi.fn((handle: number) => {
    const entry = queue.find((item) => item.handle === handle);
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

describe('createFragmentUpdateScheduler', () => {
  it('coalesces 100 camera requests into one non-forced update', async () => {
    const fake = makeFakeRaf();
    const update = vi.fn(() => Promise.resolve());
    const scheduler = createFragmentUpdateScheduler({
      raf: fake.raf,
      cancelRaf: fake.cancelRaf,
      update,
    });

    for (let i = 0; i < 100; i += 1) {
      scheduler.request({ priority: 'camera', force: false, reason: 'camera' });
    }

    expect(fake.raf).toHaveBeenCalledTimes(1);
    fake.flush();
    await Promise.resolve();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(false);
  });

  it('reports camera priority for camera-only batches', async () => {
    const fake = makeFakeRaf();
    const update = vi.fn(() => Promise.resolve());
    const runs: FragmentUpdateRun[] = [];
    const scheduler = createFragmentUpdateScheduler({
      raf: fake.raf,
      cancelRaf: fake.cancelRaf,
      update,
      onRunStart: (run) => runs.push(run),
    });

    scheduler.request({ priority: 'camera', force: false, reason: 'camera' });
    fake.flush();
    await Promise.resolve();

    expect(runs[0]).toMatchObject({
      force: false,
      priority: 'camera',
      reasons: ['camera'],
    });
  });

  it('promotes mixed camera plus visual batches to visual priority', async () => {
    const fake = makeFakeRaf();
    const update = vi.fn(() => Promise.resolve());
    const runs: FragmentUpdateRun[] = [];
    const scheduler = createFragmentUpdateScheduler({
      raf: fake.raf,
      cancelRaf: fake.cancelRaf,
      update,
      onRunStart: (run) => runs.push(run),
    });

    scheduler.request({ priority: 'camera', force: false, reason: 'camera' });
    scheduler.request({ priority: 'visual', force: true, reason: 'hover-highlight' });
    fake.flush();
    await Promise.resolve();

    expect(runs[0]).toMatchObject({
      force: true,
      priority: 'visual',
    });
    expect(runs[0].reasons).toEqual(['camera', 'hover-highlight']);
  });

  it('runs a forced visual update after an in-flight camera update finishes', async () => {
    const fake = makeFakeRaf();
    const first = deferred();
    const update = vi
      .fn<(force: boolean) => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(undefined);
    const runs: FragmentUpdateRun[] = [];
    const scheduler = createFragmentUpdateScheduler({
      raf: fake.raf,
      cancelRaf: fake.cancelRaf,
      update,
      onRunStart: (run) => runs.push(run),
    });

    scheduler.request({ priority: 'camera', force: false, reason: 'camera' });
    fake.flush();
    expect(update).toHaveBeenCalledTimes(1);

    scheduler.request({ priority: 'visual', force: true, reason: 'click-highlight' });
    expect(scheduler.snapshot().immediatePending).toBe(true);
    expect(fake.raf).toHaveBeenCalledTimes(1);

    first.resolve();
    await Promise.resolve();
    fake.flush();
    await Promise.resolve();

    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls.map(([force]) => force)).toEqual([false, true]);
    expect(runs.map((run) => run.reasons)).toEqual([['camera'], ['click-highlight']]);
  });

  it('holds idle work while navigating and releases it on navigation end', async () => {
    const fake = makeFakeRaf();
    const update = vi.fn(() => Promise.resolve());
    const scheduler = createFragmentUpdateScheduler({
      raf: fake.raf,
      cancelRaf: fake.cancelRaf,
      update,
    });

    scheduler.setNavigating(true);
    scheduler.request({ priority: 'idle', force: true, reason: 'culler-hide' });

    expect(scheduler.snapshot()).toMatchObject({
      navigating: true,
      framePending: false,
      idlePending: true,
    });

    scheduler.setNavigating(false);
    expect(scheduler.snapshot().framePending).toBe(true);
    fake.flush();
    await Promise.resolve();

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(true);
  });

  it('allows forced visual work during navigation but keeps idle work queued', async () => {
    const fake = makeFakeRaf();
    const update = vi.fn(() => Promise.resolve());
    const runs: FragmentUpdateRun[] = [];
    const scheduler = createFragmentUpdateScheduler({
      raf: fake.raf,
      cancelRaf: fake.cancelRaf,
      update,
      onRunStart: (run) => runs.push(run),
    });

    scheduler.setNavigating(true);
    scheduler.request({ priority: 'idle', force: true, reason: 'culler-hide' });
    scheduler.request({ priority: 'visual', force: true, reason: 'ghost-visibility' });

    fake.flush();
    await Promise.resolve();

    expect(update).toHaveBeenCalledTimes(1);
    expect(runs[0]).toMatchObject({ force: true, reasons: ['ghost-visibility'] });
    expect(scheduler.snapshot().idlePending).toBe(true);
  });

  it('clears in-flight state after update rejection and accepts the next request', async () => {
    const fake = makeFakeRaf();
    const update = vi
      .fn<(force: boolean) => Promise<void>>()
      .mockRejectedValueOnce(new Error('fragment update failed'))
      .mockResolvedValueOnce(undefined);
    const errors: unknown[] = [];
    const scheduler = createFragmentUpdateScheduler({
      raf: fake.raf,
      cancelRaf: fake.cancelRaf,
      update,
      onRunEnd: (_run, error) => {
        if (error) errors.push(error);
      },
    });

    scheduler.request({ priority: 'visual', force: true, reason: 'manual' });
    fake.flush();
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toHaveLength(1);
    expect(scheduler.snapshot().inFlight).toBe(false);

    scheduler.request({ priority: 'camera', force: false, reason: 'camera' });
    fake.flush();
    await Promise.resolve();

    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1][0]).toBe(false);
  });

  it('drains visual requests on a microtask without waiting for a frame', async () => {
    const fake = makeFakeRaf();
    const microtasks: Array<() => void> = [];
    const update = vi.fn(() => Promise.resolve());
    const runs: FragmentUpdateRun[] = [];
    const scheduler = createFragmentUpdateScheduler({
      raf: fake.raf,
      cancelRaf: fake.cancelRaf,
      microtask: (cb) => microtasks.push(cb),
      update,
      onRunStart: (run) => runs.push(run),
    });

    scheduler.request({ priority: 'visual', force: true, reason: 'click-highlight' });
    scheduler.request({ priority: 'visual', force: true, reason: 'hover-highlight' });

    // No frame was scheduled (the drain rides the microtask queue), and the
    // two same-turn requests coalesced into one pending drain.
    expect(fake.raf).not.toHaveBeenCalled();
    expect(microtasks).toHaveLength(1);
    expect(scheduler.snapshot().microtaskPending).toBe(true);

    microtasks.shift()!();
    await Promise.resolve();

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(true);
    expect(runs[0].reasons).toEqual(['click-highlight', 'hover-highlight']);
  });

  it('visual microtask drain absorbs a pending camera frame into the same update', async () => {
    const fake = makeFakeRaf();
    const microtasks: Array<() => void> = [];
    const update = vi.fn(() => Promise.resolve());
    const runs: FragmentUpdateRun[] = [];
    const scheduler = createFragmentUpdateScheduler({
      raf: fake.raf,
      cancelRaf: fake.cancelRaf,
      microtask: (cb) => microtasks.push(cb),
      update,
      onRunStart: (run) => runs.push(run),
    });

    scheduler.request({ priority: 'camera', force: false, reason: 'camera' });
    expect(fake.raf).toHaveBeenCalledTimes(1);
    scheduler.request({ priority: 'visual', force: true, reason: 'click-highlight' });

    microtasks.shift()!();
    await Promise.resolve();

    // The camera rAF was cancelled and its batch drained alongside the
    // visual flush - one engine update, not two.
    expect(fake.cancelRaf).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(runs[0]).toMatchObject({ force: true, priority: 'visual' });
    expect(runs[0].reasons).toEqual(['camera', 'click-highlight']);
    fake.flush();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('defers a visual request that arrives mid-flight to a post-run microtask drain', async () => {
    const fake = makeFakeRaf();
    const microtasks: Array<() => void> = [];
    const first = deferred();
    const update = vi
      .fn<(force: boolean) => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(undefined);
    const scheduler = createFragmentUpdateScheduler({
      raf: fake.raf,
      cancelRaf: fake.cancelRaf,
      microtask: (cb) => microtasks.push(cb),
      update,
    });

    scheduler.request({ priority: 'camera', force: false, reason: 'camera' });
    fake.flush();
    expect(update).toHaveBeenCalledTimes(1);

    scheduler.request({ priority: 'visual', force: true, reason: 'click-highlight' });
    // In-flight: nothing scheduled yet, the batch just merges.
    expect(microtasks).toHaveLength(0);

    first.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The finished run rescheduled the waiting visual batch on a microtask.
    expect(microtasks).toHaveLength(1);
    microtasks.shift()!();
    await Promise.resolve();
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1][0]).toBe(true);
  });

  it('cancel clears queued immediate and idle work', () => {
    const fake = makeFakeRaf();
    const update = vi.fn(() => Promise.resolve());
    const scheduler = createFragmentUpdateScheduler({
      raf: fake.raf,
      cancelRaf: fake.cancelRaf,
      update,
    });

    scheduler.request({ priority: 'visual', force: true, reason: 'manual' });
    scheduler.request({ priority: 'idle', force: true, reason: 'culler-hide' });
    scheduler.cancel();

    expect(fake.cancelRaf).toHaveBeenCalledTimes(1);
    expect(scheduler.snapshot()).toMatchObject({
      framePending: false,
      immediatePending: false,
      idlePending: false,
    });
  });

  it('acknowledges a request only after its coalesced worker update completes', async () => {
    const fake = makeFakeRaf();
    const gate = deferred();
    const update = vi.fn(() => gate.promise);
    const scheduler = createFragmentUpdateScheduler({
      raf: fake.raf,
      cancelRaf: fake.cancelRaf,
      update,
    });

    let acknowledged = false;
    const acknowledgement = scheduler.requestAndWait({
      priority: 'visual',
      force: true,
      reason: 'ghost-visibility',
    }).then((run) => {
      acknowledged = true;
      return run;
    });

    await Promise.resolve();
    expect(update).toHaveBeenCalledTimes(1);
    expect(acknowledged).toBe(false);

    gate.resolve();
    const run = await acknowledgement;
    expect(run.reasons).toEqual(['ghost-visibility']);
    expect(acknowledged).toBe(true);
  });

  it('rejects queued acknowledgements when the scheduler is cancelled', async () => {
    const fake = makeFakeRaf();
    const scheduler = createFragmentUpdateScheduler({
      raf: fake.raf,
      cancelRaf: fake.cancelRaf,
      update: vi.fn(),
    });

    scheduler.setNavigating(true);
    const acknowledgement = scheduler.requestAndWait({
      priority: 'idle',
      force: true,
      reason: 'culler-hide',
    });
    scheduler.cancel();

    await expect(acknowledgement).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('arms a waiter hook only when its own queued batch starts', async () => {
    const fake = makeFakeRaf();
    const microtasks: Array<() => void> = [];
    const first = deferred();
    const update = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(undefined);
    const scheduler = createFragmentUpdateScheduler({
      raf: fake.raf,
      cancelRaf: fake.cancelRaf,
      microtask: (cb) => microtasks.push(cb),
      update,
    });

    scheduler.request({ priority: 'camera', force: false, reason: 'camera' });
    fake.flush();
    expect(update).toHaveBeenCalledTimes(1);

    const onBatchStart = vi.fn();
    const acknowledgement = scheduler.requestAndWait(
      { priority: 'visual', force: true, reason: 'click-highlight' },
      { onBatchStart },
    );

    // An event emitted by the preceding in-flight update cannot be observed
    // by a listener installed from this hook because the hook is not armed yet.
    expect(onBatchStart).not.toHaveBeenCalled();
    first.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(onBatchStart).not.toHaveBeenCalled();

    microtasks.shift()!();
    await acknowledgement;
    expect(onBatchStart).toHaveBeenCalledTimes(1);
    expect(onBatchStart.mock.calls[0][0].reasons).toEqual(['click-highlight']);
  });

  it('shutdown cancels queued work and waits for the consumed update', async () => {
    const fake = makeFakeRaf();
    const first = deferred();
    const update = vi.fn(() => first.promise);
    const scheduler = createFragmentUpdateScheduler({
      raf: fake.raf,
      cancelRaf: fake.cancelRaf,
      update,
    });

    scheduler.request({ priority: 'camera', force: false, reason: 'camera' });
    fake.flush();
    expect(update).toHaveBeenCalledTimes(1);

    const queued = scheduler.requestAndWait({
      priority: 'visual',
      force: true,
      reason: 'click-highlight',
    });
    const queuedAssertion = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    let settled = false;
    const shutdown = scheduler.shutdown().then(() => { settled = true; });

    await queuedAssertion;
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(scheduler.snapshot().immediatePending).toBe(false);

    first.resolve();
    await shutdown;
    expect(settled).toBe(true);
    await expect(scheduler.requestAndWait({
      priority: 'visual',
      force: true,
      reason: 'manual',
    })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('notifies onEnqueue for every accepted request, including mid-flight ones', async () => {
    const fake = makeFakeRaf();
    const first = deferred();
    const enqueued: Array<{ priority: string; reason: string }> = [];
    const update = vi.fn(() => first.promise);
    const scheduler = createFragmentUpdateScheduler({
      raf: fake.raf,
      cancelRaf: fake.cancelRaf,
      update,
      onEnqueue: (request) => enqueued.push({ priority: request.priority, reason: request.reason }),
    });

    scheduler.request({ priority: 'camera', force: false, reason: 'camera' });
    fake.flush();
    expect(update).toHaveBeenCalledTimes(1);

    // A click arriving while the camera update is still in flight must still
    // surface through onEnqueue - that notification is what lets the update
    // callback stop waiting on a best-effort acknowledgement.
    scheduler.request({ priority: 'visual', force: true, reason: 'click-highlight' });
    scheduler.request({ priority: 'idle', force: false, reason: 'culler-hide' });

    expect(enqueued).toEqual([
      { priority: 'camera', reason: 'camera' },
      { priority: 'visual', reason: 'click-highlight' },
      { priority: 'idle', reason: 'culler-hide' },
    ]);

    first.resolve();
    await scheduler.shutdown();
  });

  it('keeps scheduling intact when onEnqueue throws', async () => {
    const fake = makeFakeRaf();
    const update = vi.fn(() => Promise.resolve());
    const scheduler = createFragmentUpdateScheduler({
      raf: fake.raf,
      cancelRaf: fake.cancelRaf,
      update,
      onEnqueue: () => { throw new Error('instrumentation exploded'); },
    });

    const run = scheduler.requestAndWait({ priority: 'camera', force: false, reason: 'camera' });
    fake.flush();
    await expect(run).resolves.toMatchObject({ priority: 'camera' });
    expect(update).toHaveBeenCalledTimes(1);
  });
});
