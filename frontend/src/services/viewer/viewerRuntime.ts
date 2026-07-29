import * as THREE from 'three';
import * as OBC from '@thatopen/components';
import * as OBCF from '@thatopen/components-front';
import type * as FRAGS from '@thatopen/fragments';
import {
  acceleratedRaycast,
  computeBoundsTree,
  disposeBoundsTree,
} from 'three-mesh-bvh';
import { RENDER_ON_DEMAND } from '../../config/featureFlags';

/**
 * Owns the lifetime of one viewer engine instance.
 *
 * React starts the session and publishes capabilities, but it does not own
 * engine teardown details.  All asynchronous capability shutdown work is
 * registered as a barrier; the engine is disposed once, after those barriers
 * settle or the bounded shutdown deadline expires.
 */

export interface ViewerEngine {
  dispose(): void;
}

export type ViewerSessionCleanup = () => void | Promise<void>;

export interface ViewerSessionOptions {
  /** Maximum time to wait for worker reads and capability shutdown. */
  shutdownTimeoutMs?: number;
  /** Injected for deterministic tests and non-browser runtimes. */
  revokeObjectUrl?: (url: string) => void;
}

export type ViewerSessionState = 'active' | 'disposing' | 'disposed';
export type ViewerSessionStartState = 'idle' | 'starting' | 'started' | 'failed';

export interface ViewerSessionStartContext<TEngine extends ViewerEngine> {
  readonly engine: TEngine;
  readonly signal: AbortSignal;
  addCleanup(cleanup: ViewerSessionCleanup): () => void;
  ownObjectUrl(url: string): void;
}

export interface ViewerSessionSnapshot {
  readonly state: ViewerSessionState;
  readonly startState: ViewerSessionStartState;
  readonly pendingBarriers: number;
  readonly registeredCleanups: number;
  readonly ownedObjectUrls: number;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3_000;

export class ViewerSession<TEngine extends ViewerEngine = ViewerEngine> {
  readonly engine: TEngine;
  readonly signal: AbortSignal;

  private readonly abortController = new AbortController();
  private readonly cleanups: ViewerSessionCleanup[] = [];
  private readonly barriers = new Set<Promise<unknown>>();
  private readonly objectUrls = new Set<string>();
  private readonly shutdownTimeoutMs: number;
  private readonly revokeObjectUrl: (url: string) => void;
  private state: ViewerSessionState = 'active';
  private startState: ViewerSessionStartState = 'idle';
  private startPromise: Promise<unknown> | null = null;
  private disposePromise: Promise<void> | null = null;

  constructor(engine: TEngine, options: ViewerSessionOptions = {}) {
    this.engine = engine;
    this.signal = this.abortController.signal;
    this.shutdownTimeoutMs = Math.max(
      0,
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    );
    this.revokeObjectUrl = options.revokeObjectUrl
      ?? ((url) => URL.revokeObjectURL(url));
  }

  get disposed(): boolean {
    return this.state !== 'active';
  }

  /**
   * Start the engine runtime once.
   *
   * Concurrent callers share one startup promise. The initializer receives
   * only session-owned resource hooks, so resources created during startup
   * cannot outlive the engine.
   */
  start<TRuntime>(
    initialize: (context: ViewerSessionStartContext<TEngine>) => Promise<TRuntime> | TRuntime,
  ): Promise<TRuntime> {
    if (this.startPromise) return this.startPromise as Promise<TRuntime>;
    if (this.state !== 'active') {
      return Promise.reject(new Error('Cannot start a disposed viewer session.'));
    }

    this.startState = 'starting';
    const operation = Promise.resolve().then(() => initialize({
      engine: this.engine,
      signal: this.signal,
      addCleanup: (cleanup) => this.addCleanup(cleanup),
      ownObjectUrl: (url) => this.ownObjectUrl(url),
    }));
    this.startPromise = operation.then(
      (runtime) => {
        this.startState = 'started';
        return runtime;
      },
      (error) => {
        this.startState = 'failed';
        throw error;
      },
    );
    this.addBarrier(this.startPromise);
    return this.startPromise as Promise<TRuntime>;
  }

  /**
   * Register synchronous or asynchronous capability cleanup.
   *
   * Cleanups run in reverse registration order, matching resource nesting.
   * The returned function removes a cleanup that a capability already ran.
   */
  addCleanup(cleanup: ViewerSessionCleanup): () => void {
    if (this.state !== 'active') {
      void Promise.resolve().then(cleanup).catch(() => {});
      return () => {};
    }
    this.cleanups.push(cleanup);
    return () => {
      const index = this.cleanups.lastIndexOf(cleanup);
      if (index >= 0) this.cleanups.splice(index, 1);
    };
  }

  /** Keep the engine alive until an in-flight worker/capability task settles. */
  addBarrier<T>(operation: Promise<T>): Promise<T> {
    if (this.state !== 'active') return operation;
    this.barriers.add(operation);
    const release = () => this.barriers.delete(operation);
    void operation.then(release, release);
    return operation;
  }

  /** Revoke a blob-backed worker URL only after engine disposal. */
  ownObjectUrl(url: string): void {
    if (!url) return;
    if (this.state === 'disposed') {
      try {
        this.revokeObjectUrl(url);
      } catch {
        // Best-effort browser resource cleanup.
      }
      return;
    }
    this.objectUrls.add(url);
  }

  snapshot(): ViewerSessionSnapshot {
    return {
      state: this.state,
      startState: this.startState,
      pendingBarriers: this.barriers.size,
      registeredCleanups: this.cleanups.length,
      ownedObjectUrls: this.objectUrls.size,
    };
  }

  /** Abort fetches/readers before the asynchronous disposal barrier begins. */
  abortPendingWork(): void {
    if (!this.abortController.signal.aborted) this.abortController.abort();
  }

  /**
   * Dispose the session exactly once.
   *
   * Repeated callers receive the same promise. Cleanup failures never prevent
   * later resources from being released, and a stuck worker cannot retain the
   * renderer beyond the configured deadline.
   */
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.state = 'disposing';
    this.abortPendingWork();
    this.disposePromise = this.disposeOnce();
    return this.disposePromise;
  }

  private async disposeOnce(): Promise<void> {
    while (this.cleanups.length > 0) {
      const cleanup = this.cleanups.pop();
      if (!cleanup) continue;
      try {
        await cleanup();
      } catch {
        // Continue releasing the rest of the session.
      }
    }

    const pending = [...this.barriers]
      .map((operation) => Promise.resolve(operation).catch(() => {}));

    if (pending.length > 0) {
      await this.waitWithinDeadline(Promise.allSettled(pending));
    }

    try {
      this.engine.dispose();
    } catch {
      // An engine may be partly initialised; object URLs still need release.
    }

    for (const url of this.objectUrls) {
      try {
        this.revokeObjectUrl(url);
      } catch {
        // Best-effort browser resource cleanup.
      }
    }
    this.objectUrls.clear();
    this.barriers.clear();
    this.state = 'disposed';
  }

  private async waitWithinDeadline(operation: Promise<unknown>): Promise<void> {
    if (this.shutdownTimeoutMs === 0) return;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timeoutHandle = globalThis.setTimeout(resolve, this.shutdownTimeoutMs);
    });
    await Promise.race([operation.then(() => {}), timeout]);
    if (timeoutHandle !== undefined) globalThis.clearTimeout(timeoutHandle);
  }
}

/**
 * Parkable render invalidation loop.
 *
 * A kick renders immediately and keeps invalidating for the requested motion
 * window. Once the window expires there is no resident requestAnimationFrame
 * callback; the next input, worker update, or store mutation wakes it again.
 */

export interface InvalidationRenderLoopOptions {
  readonly now: () => number;
  readonly raf: (callback: () => void) => number;
  readonly cancelRaf: (handle: number) => void;
  readonly invalidate: () => void;
  readonly initialWindowMs?: number;
}

export interface InvalidationRenderLoopSnapshot {
  readonly running: boolean;
  readonly stopped: boolean;
  readonly renderUntil: number;
}

export interface InvalidationRenderLoop {
  /** Render now and continue rendering for at least `windowMs`. */
  kick: (windowMs?: number) => void;
  /** Cancel pending work permanently. Safe to call repeatedly. */
  stop: () => void;
  snapshot: () => InvalidationRenderLoopSnapshot;
}

export function createInvalidationRenderLoop(
  options: InvalidationRenderLoopOptions,
): InvalidationRenderLoop {
  let frameHandle: number | null = null;
  let renderUntil = options.now();
  let stopped = false;

  const schedule = () => {
    if (stopped || frameHandle !== null) return;
    frameHandle = options.raf(runFrame);
  };

  const runFrame = () => {
    frameHandle = null;
    if (stopped) return;
    options.invalidate();
    if (options.now() < renderUntil) schedule();
  };

  const kick = (windowMs = 300) => {
    if (stopped) return;
    const duration = Number.isFinite(windowMs) ? Math.max(0, windowMs) : 0;
    renderUntil = Math.max(renderUntil, options.now() + duration);
    // Do not wait a frame to expose click/visibility changes to the renderer.
    options.invalidate();
    if (duration > 0) schedule();
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (frameHandle !== null) {
      options.cancelRaf(frameHandle);
      frameHandle = null;
    }
  };

  const snapshot = (): InvalidationRenderLoopSnapshot => ({
    running: frameHandle !== null,
    stopped,
    renderUntil,
  });

  const initialWindowMs = options.initialWindowMs ?? 0;
  if (initialWindowMs > 0) kick(initialWindowMs);

  return { kick, stop, snapshot };
}

export type FragmentUpdatePriority = 'camera' | 'visual' | 'idle';

export type FragmentUpdateReason =
  | 'camera'
  | 'click-highlight'
  | 'hover-highlight'
  | 'ghost-visibility'
  | 'culler-show'
  | 'culler-hide'
  | 'resize'
  | 'manual';

export interface FragmentUpdateRequest {
  readonly force: boolean;
  readonly priority: FragmentUpdatePriority;
  readonly reason: FragmentUpdateReason;
}

export interface FragmentUpdateRun {
  readonly force: boolean;
  readonly priority: FragmentUpdatePriority;
  readonly reasons: readonly FragmentUpdateReason[];
}

export interface FragmentUpdateSchedulerOptions {
  readonly raf: (cb: () => void) => number;
  readonly cancelRaf: (handle: number) => void;
  /** Microtask hook for 'visual' drains (default: queueMicrotask). Injectable for tests. */
  readonly microtask?: (cb: () => void) => void;
  readonly update: (force: boolean) => Promise<void> | void;
  readonly onRunStart?: (run: FragmentUpdateRun) => void;
  readonly onRunEnd?: (run: FragmentUpdateRun, error: unknown | null) => void;
  /**
   * Fires after every accepted enqueue, before the batch drains. The in-flight
   * update callback can use it to stop waiting on best-effort acknowledgements
   * when newer immediate work is already queued behind it.
   */
  readonly onEnqueue?: (request: FragmentUpdateRequest) => void;
}

export interface FragmentUpdateSchedulerSnapshot {
  readonly navigating: boolean;
  readonly inFlight: boolean;
  readonly framePending: boolean;
  readonly microtaskPending: boolean;
  readonly immediatePending: boolean;
  readonly idlePending: boolean;
}

export interface FragmentUpdateWaitHooks {
  /**
   * Runs immediately before the worker update containing this request starts.
   * This is deliberately per-request: callers can subscribe to a model event
   * only once the exact coalesced batch they are waiting for is consumed.
   */
  readonly onBatchStart?: (run: FragmentUpdateRun) => void;
}

export interface FragmentUpdateScheduler {
  request: (request: FragmentUpdateRequest) => void;
  /** Resolve after the coalesced worker update containing this request ends. */
  requestAndWait: (
    request: FragmentUpdateRequest,
    hooks?: FragmentUpdateWaitHooks,
  ) => Promise<FragmentUpdateRun>;
  setNavigating: (navigating: boolean) => void;
  /** Cancel queued work and wait for the already-consumed update to finish. */
  shutdown: () => Promise<void>;
  cancel: () => void;
  snapshot: () => FragmentUpdateSchedulerSnapshot;
}

interface PendingBatch {
  force: boolean;
  reasons: Set<FragmentUpdateReason>;
  priorities: Set<FragmentUpdatePriority>;
  waiters: Array<{
    resolve: (run: FragmentUpdateRun) => void;
    reject: (error: unknown) => void;
    onBatchStart?: (run: FragmentUpdateRun) => void;
    startError?: unknown;
  }>;
}

function createEmptyBatch(): PendingBatch {
  return { force: false, reasons: new Set(), priorities: new Set(), waiters: [] };
}

function hasBatch(batch: PendingBatch): boolean {
  return batch.reasons.size > 0;
}

function mergeRequest(batch: PendingBatch, request: FragmentUpdateRequest): void {
  batch.force = batch.force || request.force;
  batch.reasons.add(request.reason);
  batch.priorities.add(request.priority);
}

function inferPriority(batch: PendingBatch): FragmentUpdatePriority {
  if (batch.priorities.has('visual')) return 'visual';
  if (batch.priorities.has('camera')) return 'camera';
  return 'idle';
}

function consumeBatch(batch: PendingBatch): {
  force: boolean;
  priority: FragmentUpdatePriority;
  reasons: FragmentUpdateReason[];
  waiters: PendingBatch['waiters'];
} {
  const out = {
    force: batch.force,
    priority: inferPriority(batch),
    reasons: Array.from(batch.reasons),
    waiters: batch.waiters.splice(0, batch.waiters.length),
  };
  batch.force = false;
  batch.reasons.clear();
  batch.priorities.clear();
  return out;
}

export function createFragmentUpdateScheduler(
  options: FragmentUpdateSchedulerOptions,
): FragmentUpdateScheduler {
  let navigating = false;
  let inFlight = false;
  let closed = false;
  let frameHandle: number | null = null;
  let microtaskQueued = false;
  let microtaskGeneration = 0;
  let shutdownPromise: Promise<void> | null = null;
  let resolveShutdown: (() => void) | null = null;
  const queueTask = options.microtask ?? ((cb: () => void) => queueMicrotask(cb));
  const immediate = createEmptyBatch();
  const idle = createEmptyBatch();

  const canRun = () => hasBatch(immediate) || (!navigating && hasBatch(idle));

  const scheduleFrame = () => {
    if (closed || frameHandle !== null || inFlight || !canRun()) return;
    frameHandle = options.raf(() => {
      frameHandle = null;
      void drain();
    });
  };

  // 'visual' batches drain on a microtask instead of the next rAF: a click
  // or hover flush starts its worker refreshView in the same event-loop turn
  // (saves the 0-16 ms frame wait) while still running AFTER the caller's
  // synchronous highlight RPC posts - every requester posts its RPCs before
  // calling request(), so worker message order is preserved. Camera/idle
  // batches keep rAF pacing so damped orbit events stay coalesced to one
  // engine update per frame.
  const scheduleMicrotask = () => {
    if (closed || microtaskQueued || inFlight || !canRun()) return;
    microtaskQueued = true;
    const generation = microtaskGeneration;
    queueTask(() => {
      if (generation !== microtaskGeneration) return;
      microtaskQueued = false;
      if (frameHandle !== null) {
        options.cancelRaf(frameHandle);
        frameHandle = null;
      }
      void drain();
    });
  };

  const scheduleNext = () => {
    if (closed) return;
    if (hasBatch(immediate) && immediate.priorities.has('visual')) {
      scheduleMicrotask();
    } else {
      scheduleFrame();
    }
  };

  const drain = async () => {
    if (closed || inFlight || !canRun()) return;

    const batch = hasBatch(immediate) ? consumeBatch(immediate) : consumeBatch(idle);
    const run: FragmentUpdateRun = {
      force: batch.force,
      priority: batch.priority,
      reasons: batch.reasons,
    };

    inFlight = true;
    for (const waiter of batch.waiters) {
      try {
        waiter.onBatchStart?.(run);
      } catch (err) {
        waiter.startError = err;
      }
    }
    try { options.onRunStart?.(run); } catch { /* instrumentation is non-fatal */ }
    let error: unknown | null = null;
    try {
      await options.update(run.force);
    } catch (err) {
      error = err;
    } finally {
      inFlight = false;
      try { options.onRunEnd?.(run, error); } catch { /* instrumentation is non-fatal */ }
      for (const waiter of batch.waiters) {
        if (waiter.startError) waiter.reject(waiter.startError);
        else if (error) waiter.reject(error);
        else waiter.resolve(run);
      }
      scheduleNext();
      if (closed) {
        resolveShutdown?.();
        resolveShutdown = null;
      }
    }
  };

  const enqueue = (
    next: FragmentUpdateRequest,
    waiter?: PendingBatch['waiters'][number],
  ) => {
    if (closed) {
      const error = new Error('Fragment update scheduler is shut down');
      error.name = 'AbortError';
      waiter?.reject(error);
      return;
    }
    const target = next.priority === 'idle' ? idle : immediate;
    if (waiter) target.waiters.push(waiter);
    if (next.priority === 'idle') {
      mergeRequest(idle, next);
      scheduleFrame();
    } else if (next.priority === 'visual') {
      mergeRequest(immediate, next);
      scheduleMicrotask();
    } else {
      mergeRequest(immediate, next);
      scheduleFrame();
    }
    try { options.onEnqueue?.(next); } catch { /* instrumentation is non-fatal */ }
  };

  const request = (next: FragmentUpdateRequest) => {
    enqueue(next);
  };

  const requestAndWait = (
    next: FragmentUpdateRequest,
    hooks?: FragmentUpdateWaitHooks,
  ): Promise<FragmentUpdateRun> => (
    new Promise<FragmentUpdateRun>((resolve, reject) => {
      enqueue(next, { resolve, reject, onBatchStart: hooks?.onBatchStart });
    })
  );

  const setNavigating = (next: boolean) => {
    if (closed) return;
    if (navigating === next) return;
    navigating = next;
    scheduleFrame();
  };

  const cancel = () => {
    if (frameHandle !== null) {
      options.cancelRaf(frameHandle);
      frameHandle = null;
    }
    if (microtaskQueued) {
      microtaskGeneration += 1;
      microtaskQueued = false;
    }
    const error = new Error('Fragment update request cancelled');
    error.name = 'AbortError';
    for (const waiter of immediate.waiters.splice(0)) waiter.reject(error);
    for (const waiter of idle.waiters.splice(0)) waiter.reject(error);
    immediate.force = false;
    immediate.reasons.clear();
    immediate.priorities.clear();
    idle.force = false;
    idle.reasons.clear();
    idle.priorities.clear();
  };

  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    closed = true;
    cancel();
    if (!inFlight) {
      shutdownPromise = Promise.resolve();
      return shutdownPromise;
    }
    shutdownPromise = new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });
    return shutdownPromise;
  };

  const snapshot = (): FragmentUpdateSchedulerSnapshot => ({
    navigating,
    inFlight,
    framePending: frameHandle !== null,
    microtaskPending: microtaskQueued,
    immediatePending: hasBatch(immediate),
    idlePending: hasBatch(idle),
  });

  return { request, requestAndWait, setNavigating, shutdown, cancel, snapshot };
}

/**
 * three-mesh-bvh global setup + scene-level BVH computation.
 *
 * Call `installBVH()` once at app boot (before any Three.js raycasting).
 * Call `computeSceneBVH(scene)` after an IFC model is loaded so every
 * BufferGeometry in the scene gets a BVH acceleration structure.
 *
 * Why: THREE.Raycaster.intersectObjects falls back to brute-force triangle
 * tests without BVH.  With BVH patched onto Mesh.prototype the same raycaster
 * call runs an O(log n) tree traversal instead.  For scene-level objects
 * (clip-plane gizmos, snap-dots, measurement helpers, ViewHelper sprites) the
 * speedup is immediate with zero API changes.
 *
 * The @thatopen/components FragmentsModel.raycast() path uses its own async
 * internal pipeline and is unaffected, but any THREE.Raycaster we run
 * ourselves (gizmo picking, clip-plane drag origin, measurement snap) gets
 * the BVH automatically.
 */

let _installed = false;

/**
 * Monkey-patch Three.js prototypes for accelerated raycasting.
 * Idempotent - safe to call multiple times.
 */
export function installBVH(): void {
  if (_installed) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (THREE.BufferGeometry.prototype as any).computeBoundsTree = computeBoundsTree;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (THREE.BufferGeometry.prototype as any).disposeBoundsTree = disposeBoundsTree;
  THREE.Mesh.prototype.raycast = acceleratedRaycast;
  _installed = true;
}

/** Returns true once installBVH() has been called. */
export function isBVHInstalled(): boolean {
  return _installed;
}

/**
 * Walk the scene and compute BVH for every BufferGeometry that:
 *   - belongs to a THREE.Mesh (not InstancedMesh - those are managed by @thatopen)
 *   - has at least 3 vertices (non-degenerate)
 *   - does not already have a boundsTree
 *
 * Returns a count of geometries processed.
 */
export function computeSceneBVH(scene: THREE.Object3D): number {
  if (!_installed) installBVH();

  let count = 0;
  scene.traverse((obj) => {
    // Skip InstancedMesh - @thatopen manages those internally.
    if (obj instanceof THREE.InstancedMesh) return;
    if (!(obj instanceof THREE.Mesh)) return;

    const geo = obj.geometry as THREE.BufferGeometry & { boundsTree?: unknown };
    if (!geo?.isBufferGeometry) return;
    if (geo.boundsTree) return;

    const pos = geo.attributes.position;
    if (!pos || pos.count < 3) return;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (geo as any).computeBoundsTree();
      count++;
    } catch {
      // Non-indexed geometries without position data can throw - skip silently.
    }
  });

  return count;
}

/**
 * Dispose BVH from all geometries in the scene to free memory.
 * Call on viewer unmount or model unload.
 */
export function disposeSceneBVH(scene: THREE.Object3D): void {
  scene.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const geo = obj.geometry as THREE.BufferGeometry & { boundsTree?: unknown; disposeBoundsTree?: () => void };
    if (geo?.boundsTree && typeof geo.disposeBoundsTree === 'function') {
      geo.disposeBoundsTree();
    }
  });
}

/**
 * Snapshot BVH coverage in the scene - useful for the performance dashboard.
 *
 * Returns:
 *   - totalMeshes: Mesh count (excluding InstancedMesh)
 *   - bvhMeshes: count with boundsTree
 *   - coveragePct: bvhMeshes / totalMeshes * 100 (0 when totalMeshes === 0)
 */
export function getBVHCoverage(scene: THREE.Object3D): {
  totalMeshes: number;
  bvhMeshes: number;
  coveragePct: number;
} {
  let totalMeshes = 0;
  let bvhMeshes = 0;

  scene.traverse((obj) => {
    if (obj instanceof THREE.InstancedMesh) return;
    if (!(obj instanceof THREE.Mesh)) return;
    totalMeshes++;
    const geo = obj.geometry as THREE.BufferGeometry & { boundsTree?: unknown };
    if (geo?.boundsTree) bvhMeshes++;
  });

  return {
    totalMeshes,
    bvhMeshes,
    coveragePct: totalMeshes === 0 ? 0 : (bvhMeshes / totalMeshes) * 100,
  };
}

export interface FragmentRuntimeOptions {
  readonly renderKick: (milliseconds?: number) => void;
  readonly onForcedUpdateTiming?: (timing: {
    readonly paceWaitMs: number;
    readonly flushMs: number;
  }) => void;
  readonly onClickHighlightRunStart?: (timestamp: number) => void;
}

export interface FragmentRuntime {
  readonly manager: OBC.FragmentsManager;
  readonly scheduler: FragmentUpdateScheduler;
  readonly residentModel: FRAGS.FragmentsModel | null;
  adoptModel(model: FRAGS.FragmentsModel): void;
}

/**
 * Owns FragmentsManager boot, update serialization, worker URL lifetime, and
 * the active model acknowledgement target.
 */
export async function createFragmentRuntime(
  session: ViewerSessionStartContext<OBC.Components>,
  options: FragmentRuntimeOptions,
): Promise<FragmentRuntime> {
  const { engine: components, signal } = session;
  const manager = components.get(OBC.FragmentsManager);
  let residentModel: FRAGS.FragmentsModel | null = null;
  let rawCoreUpdate: ((force?: boolean) => Promise<void>) | null = null;
  let droppedForcedFlushes = 0;
  const acknowledgementPreemptors = new Set<() => void>();

  const readEngineLastUpdate = (): number | null => {
    const enginePacing = manager.core as unknown as { _lastUpdate?: unknown };
    return typeof enginePacing._lastUpdate === 'number'
      ? enginePacing._lastUpdate
      : null;
  };
  const invokeRawCoreUpdate = (force: boolean): Promise<void> => {
    if (rawCoreUpdate) return rawCoreUpdate(force);
    return manager.core.update(force);
  };
  const updatePaced = async (force: boolean): Promise<boolean> => {
    if (!force) {
      const callAt = performance.now();
      await invokeRawCoreUpdate(false);
      const after = readEngineLastUpdate();
      return after === null || after >= callAt;
    }

    const forcedStart = performance.now();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (signal.aborted) throw new Error('viewer-disposed');
      const last = readEngineLastUpdate();
      const rate = manager.core.settings.maxUpdateRate;
      if (last !== null && rate > 0) {
        const since = performance.now() - last;
        if (since < rate) {
          await new Promise((resolve) => {
            window.setTimeout(resolve, Math.max(1, Math.ceil(rate - since) + 1));
          });
        }
      }
      const callAt = performance.now();
      await invokeRawCoreUpdate(true);
      const after = readEngineLastUpdate();
      if (after === null || after >= callAt) {
        options.onForcedUpdateTiming?.({
          paceWaitMs: callAt - forcedStart,
          flushMs: performance.now() - callAt,
        });
        return true;
      }
      droppedForcedFlushes += 1;
      if (import.meta.env.DEV) {
        console.debug(
          '[viewer] forced fragment flush dropped by engine pacing - retrying',
          { attempt: attempt + 1, droppedForcedFlushes },
        );
      }
    }
    throw new Error('fragments forced update dropped by engine pacing (3 attempts)');
  };

  const updatePacedAndAcknowledged = async (force: boolean): Promise<void> => {
    const acknowledgedModel = residentModel;
    if (!acknowledgedModel) {
      await updatePaced(force);
      return;
    }
    let finished = false;
    let acknowledgementTimeout = 0;
    let resolveFinished!: () => void;
    const finish = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });
    const onViewUpdated = () => {
      finished = true;
      resolveFinished();
    };
    acknowledgedModel.onViewUpdated.add(onViewUpdated);
    try {
      const accepted = await updatePaced(force);
      if (accepted && !force && !finished) {
        let preempted = false;
        const preempt = () => {
          preempted = true;
          resolveFinished();
        };
        acknowledgementPreemptors.add(preempt);
        try {
          acknowledgementTimeout = window.setTimeout(resolveFinished, 2_500);
          await finish;
        } finally {
          acknowledgementPreemptors.delete(preempt);
        }
        if (import.meta.env.DEV && !finished) {
          console.debug('[viewer] non-forced view-update acknowledgement released', {
            reason: preempted ? 'preempted-by-immediate-work' : 'no-view-change-timeout',
          });
        }
      }
    } finally {
      window.clearTimeout(acknowledgementTimeout);
      try {
        acknowledgedModel.onViewUpdated.remove(onViewUpdated);
      } catch {
        // The model may already be disposed.
      }
    }
  };

  const scheduler = createFragmentUpdateScheduler({
    raf: (callback) => window.requestAnimationFrame(callback),
    cancelRaf: (handle) => window.cancelAnimationFrame(handle),
    update: updatePacedAndAcknowledged,
    onEnqueue: (request) => {
      if (request.priority === 'idle') return;
      for (const preempt of [...acknowledgementPreemptors]) preempt();
    },
    onRunStart: (run) => {
      options.renderKick(350);
      if (import.meta.env.DEV && run.reasons.includes('click-highlight')) {
        options.onClickHighlightRunStart?.(performance.now());
      }
    },
    onRunEnd: () => options.renderKick(350),
  });

  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__ifcSchedSnapshot =
      () => scheduler.snapshot();
  }
  session.addCleanup(() => {
    residentModel = null;
    scheduler.cancel();
    acknowledgementPreemptors.clear();
    if (import.meta.env.DEV) {
      delete (window as unknown as Record<string, unknown>).__ifcSchedSnapshot;
    }
  });

  const workerHttpUrl = new URL('/worker.mjs', window.location.origin).href;
  let workerInitUrl = workerHttpUrl;
  try {
    const response = await fetch(workerHttpUrl, { signal });
    if (response.ok) {
      const workerText = await response.text();
      workerInitUrl = URL.createObjectURL(
        new Blob([workerText], { type: 'application/javascript' }),
      );
      session.ownObjectUrl(workerInitUrl);
    }
  } catch {
    if (signal.aborted) throw new Error('viewer-disposed');
    // Fall back to the HTTP worker URL when blob preparation fails.
  }
  manager.init(workerInitUrl);
  manager.core.settings.maxUpdateRate = 8;
  manager.core.settings.forceUpdateRate = 1;
  manager.core.settings.forceUpdateBuffer = 2;

  const coreWithLoad = manager.core as unknown as {
    load: (...arguments_: unknown[]) => Promise<unknown>;
  };
  const originalLoad = coreWithLoad.load.bind(manager.core);
  coreWithLoad.load = (...arguments_: unknown[]) => {
    if (signal.aborted) return Promise.reject(new Error('viewer-disposed'));
    return originalLoad(...arguments_);
  };

  try {
    const coreWithUpdate = manager.core as unknown as {
      update: (force?: boolean) => Promise<void>;
    };
    rawCoreUpdate = coreWithUpdate.update.bind(manager.core);
    coreWithUpdate.update = async (force = false) => {
      if (RENDER_ON_DEMAND) options.renderKick(350);
      if (signal.aborted) return;
      try {
        await scheduler.requestAndWait({
          priority: force ? 'visual' : 'camera',
          force,
          reason: 'camera',
        });
      } catch (error) {
        if (!signal.aborted && (error as { name?: string })?.name !== 'AbortError') {
          console.warn('[viewer] scheduled engine update failed', error);
        }
      }
    };
  } catch {
    // Direct application updates still use the scheduler.
  }

  return {
    manager,
    scheduler,
    get residentModel() {
      return residentModel;
    },
    adoptModel: (model) => {
      residentModel = model;
    },
  };
}

export type ViewerWorld = OBC.SimpleWorld<
  OBC.SimpleScene,
  OBC.SimpleCamera,
  OBC.SimpleRenderer
>;

export interface ViewerRendererFlags {
  readonly antialias: boolean;
  readonly logarithmicDepthBuffer: boolean;
}

export interface ViewerRuntimeOptions {
  readonly container: HTMLElement;
  readonly rendererFlags: ViewerRendererFlags;
  readonly getRestoredPixelRatioCap: () => number;
  readonly subscribeVisualChanges?: (kick: (milliseconds?: number) => void) => () => void;
  readonly onContextLost?: () => void;
  readonly onContextRestored?: () => void;
  readonly fragments?: Omit<FragmentRuntimeOptions, 'renderKick'>;
}

export interface InteractionPixelRatioController {
  readonly activeCap: number;
  setCap(cap: number): void;
  restoreCap(): void;
  noteCameraUpdate(): void;
  cancelDeferredDrop(): void;
  applyQualityCap(
    cap: number,
    options: {
      readonly navigating: boolean;
      readonly isCameraNavigating: () => boolean;
    },
  ): void;
}

export interface ViewerRuntime {
  readonly world: ViewerWorld;
  readonly grid: ReturnType<OBC.Grids['create']>;
  readonly renderKick: (milliseconds?: number) => void;
  readonly pixelRatio: InteractionPixelRatioController;
  readonly navigationPixelRatioCap: number;
  readonly cameraSettleDelayMs: number;
  readonly cullerShowPassMinIntervalMs: number;
  readonly postproduction: OBCF.PostproductionRenderer['postproduction'] | null;
  readonly fragments: FragmentRuntime;
}

const HARD_PIXEL_RATIO_CAP = 2;
const NAVIGATION_PIXEL_RATIO_CAP = 1;
const CAMERA_SETTLE_DELAY_MS = 320;
const CULLER_SHOW_PASS_MIN_INTERVAL_MS = 220;
const DPR_DROP_DELAY_MS = 180;
const WHEEL_GESTURE_WINDOW_MS = 300;
const DPR_DROP_RECENT_MOTION_MS = 120;

/**
 * Creates the browser renderer runtime and registers every browser resource
 * with the owning ViewerSession before returning it to React.
 */
export async function createViewerRuntime(
  session: ViewerSessionStartContext<OBC.Components>,
  options: ViewerRuntimeOptions,
): Promise<ViewerRuntime> {
  const { engine: components, signal } = session;
  const { container } = options;

  installBVH();

  const worlds = components.get(OBC.Worlds);
  const world = worlds.create<
    OBC.SimpleScene,
    OBC.SimpleCamera,
    OBC.SimpleRenderer
  >();
  world.scene = new OBC.SimpleScene(components);
  world.renderer = new OBCF.PostproductionRenderer(components, container, {
    antialias: options.rendererFlags.antialias,
    logarithmicDepthBuffer: options.rendererFlags.logarithmicDepthBuffer,
    powerPreference: 'high-performance',
    stencil: false,
    preserveDrawingBuffer: false,
  });
  world.renderer.showLogo = false;

  try {
    const renderer = world.renderer as unknown as OBCF.PostproductionRenderer;
    renderer.turnOffOnManualMode = false;
    renderer.manualModeDelay = 120;
  } catch {
    // Older @thatopen/components-front versions may not expose these knobs.
  }

  let renderKick: (milliseconds?: number) => void = () => {};
  if (RENDER_ON_DEMAND) {
    try {
      const renderer = world.renderer as unknown as {
        mode: OBC.RendererMode;
        needsUpdate: boolean;
      };
      renderer.mode = OBC.RendererMode.MANUAL;
      const invalidationLoop = createInvalidationRenderLoop({
        now: () => performance.now(),
        raf: (callback) => window.requestAnimationFrame(callback),
        cancelRaf: (handle) => window.cancelAnimationFrame(handle),
        invalidate: () => {
          renderer.needsUpdate = true;
        },
        initialWindowMs: 1_500,
      });
      renderKick = (milliseconds = 300) => invalidationLoop.kick(milliseconds);

      const kickOnPointer = (event: PointerEvent) => {
        if (event.buttons !== 0) renderKick(200);
      };
      const kickOnWheel = () => renderKick(400);
      container.addEventListener('pointermove', kickOnPointer, { passive: true });
      container.addEventListener('pointerdown', kickOnPointer, { passive: true });
      container.addEventListener('wheel', kickOnWheel, { passive: true });
      const unsubscribeVisualChanges = options.subscribeVisualChanges?.(renderKick);

      session.addCleanup(() => {
        container.removeEventListener('pointermove', kickOnPointer);
        container.removeEventListener('pointerdown', kickOnPointer);
        container.removeEventListener('wheel', kickOnWheel);
        unsubscribeVisualChanges?.();
        invalidationLoop.stop();
        try {
          renderer.mode = OBC.RendererMode.AUTO;
        } catch {
          // The renderer may already be partially disposed.
        }
      });
    } catch {
      // Manual rendering is best-effort; an incompatible engine stays in AUTO.
    }
  }

  const rendererCanvas = world.renderer.three.domElement;
  const onContextLost = () => options.onContextLost?.();
  const onContextRestored = () => {
    renderKick(600);
    options.onContextRestored?.();
  };
  rendererCanvas.addEventListener('webglcontextlost', onContextLost);
  rendererCanvas.addEventListener('webglcontextrestored', onContextRestored);
  session.addCleanup(() => {
    rendererCanvas.removeEventListener('webglcontextlost', onContextLost);
    rendererCanvas.removeEventListener('webglcontextrestored', onContextRestored);
  });

  let postproduction: OBCF.PostproductionRenderer['postproduction'] | null = null;
  try {
    postproduction = (
      world.renderer as unknown as OBCF.PostproductionRenderer
    ).postproduction;
    postproduction.enabled = false;
    postproduction.edgesPass.mode = OBCF.EdgeDetectionPassMode.GLOBAL;
  } catch {
    postproduction = null;
  }

  try {
    const rendererWith2D = world.renderer as unknown as {
      three2D?: { render: (...args: unknown[]) => void };
    };
    if (rendererWith2D.three2D) rendererWith2D.three2D.render = () => {};
  } catch {
    // The engine's optional CSS2D internals may change shape.
  }

  world.camera = new OBC.SimpleCamera(components);
  try {
    const controls = world.camera.controls;
    controls.smoothTime = 0.12;
    controls.draggingSmoothTime = 0.05;
    controls.minDistance = 0.5;
  } catch {
    // camera-controls API varies by version.
  }
  try {
    const camera = world.camera.three;
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.near = 0.05;
      camera.far = 5_000;
      camera.updateProjectionMatrix();
    }
  } catch {
    // Best-effort camera precision setup.
  }

  const targetPixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
  let activePixelRatioCap = targetPixelRatio;
  let deferredDrop: number | null = null;
  let lastCameraUpdate = -Infinity;
  let lastWheel = -Infinity;

  // canvas.setSize resets the drawing buffer to transparent black, and
  // ResizeObserver callbacks are delivered after the frame's rAF render but
  // before paint. Without an immediate repaint every divider-drag tick paints
  // a cleared canvas: visible flicker in AUTO mode, and a viewport that stays
  // blank for the whole drag in on-demand mode once the kick window expires.
  // renderer.update() (not raw three.render) keeps the gizmo overlay and the
  // render-stats hooks on onBeforeUpdate/onAfterUpdate consistent.
  const renderNow = () => {
    try {
      world.camera.updateAspect();
      const renderer = world.renderer as unknown as {
        needsUpdate: boolean;
        update: () => void;
      };
      renderer.needsUpdate = true;
      renderer.update();
    } catch {
      // The renderer can be incomplete while the component is unmounting.
    }
  };
  // The engine's own ResizeObserver calls three.setSize on every container
  // resize and fires onResize immediately after, still before paint.
  world.renderer.onResize.add(renderNow);
  session.addCleanup(() => {
    try {
      world.renderer?.onResize.remove(renderNow);
    } catch {
      // Renderer already disposed.
    }
  });

  const applyPixelRatio = () => {
    try {
      const renderer = world.renderer!.three;
      const next = Math.min(window.devicePixelRatio || 1, activePixelRatioCap);
      const width = Math.floor(container.clientWidth * next);
      const height = Math.floor(container.clientHeight * next);
      const canvas = renderer.domElement;
      if (
        renderer.getPixelRatio() === next
        && canvas.width === width
        && canvas.height === height
      ) {
        return;
      }
      if (renderer.getPixelRatio() !== next) renderer.setPixelRatio(next);
      renderer.setSize(container.clientWidth, container.clientHeight, true);
      // Direct three.setSize does not raise the engine onResize event, so the
      // synchronous repaint must happen here too.
      renderNow();
      renderKick(250);
    } catch {
      // The renderer can be incomplete while the component is unmounting.
    }
  };
  const setCap = (cap: number) => {
    activePixelRatioCap = Math.min(HARD_PIXEL_RATIO_CAP, Math.max(1, cap));
    applyPixelRatio();
  };
  const cancelDeferredDrop = () => {
    if (deferredDrop === null) return;
    window.clearTimeout(deferredDrop);
    deferredDrop = null;
  };
  const isWheelGesture = () => performance.now() - lastWheel < WHEEL_GESTURE_WINDOW_MS;

  const trackWheel = () => {
    lastWheel = performance.now();
  };
  rendererCanvas.addEventListener('wheel', trackWheel, { passive: true });
  session.addCleanup(() => {
    rendererCanvas.removeEventListener('wheel', trackWheel);
    cancelDeferredDrop();
  });

  const pixelRatio: InteractionPixelRatioController = {
    get activeCap() {
      return activePixelRatioCap;
    },
    setCap,
    restoreCap: () => setCap(options.getRestoredPixelRatioCap()),
    noteCameraUpdate: () => {
      lastCameraUpdate = performance.now();
    },
    cancelDeferredDrop,
    applyQualityCap: (cap, qualityOptions) => {
      cancelDeferredDrop();
      const droppingForNavigation =
        qualityOptions.navigating && cap < activePixelRatioCap;
      if (!droppingForNavigation) {
        setCap(cap);
        return;
      }
      if (isWheelGesture()) return;
      deferredDrop = window.setTimeout(() => {
        deferredDrop = null;
        if (signal.aborted || !qualityOptions.isCameraNavigating() || isWheelGesture()) {
          return;
        }
        if (performance.now() - lastCameraUpdate > DPR_DROP_RECENT_MOTION_MS) return;
        setCap(cap);
      }, DPR_DROP_DELAY_MS);
    },
  };

  applyPixelRatio();
  const pixelRatioObserver = new ResizeObserver(applyPixelRatio);
  pixelRatioObserver.observe(container);
  session.addCleanup(() => pixelRatioObserver.disconnect());

  try {
    const renderer = world.renderer.three;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1;
  } catch {
    // Best-effort explicit color management.
  }

  components.init();
  world.scene.setup({
    backgroundColor: new THREE.Color(0x0a0a1a),
  });
  try {
    const scene = world.scene.three as THREE.Scene;
    for (const child of scene.children) {
      if (child instanceof THREE.AmbientLight) child.intensity = 0.4;
      else if (child instanceof THREE.DirectionalLight) child.intensity = 2;
    }
    const hemisphere = new THREE.HemisphereLight(0xffffff, 0x6b7280, 0.75);
    hemisphere.name = 'hemi-fill';
    scene.add(hemisphere);
    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    ambient.name = 'ambient-fill';
    scene.add(ambient);
    const counterKey = new THREE.DirectionalLight(0xffffff, 0.6);
    counterKey.position.set(-30, 40, -30);
    counterKey.name = 'counter-key';
    scene.add(counterKey);
  } catch {
    // Lighting fallback is not critical to engine startup.
  }
  world.camera.controls.setLookAt(15, 15, 15, 0, 0, 0);
  const grid = components.get(OBC.Grids).create(world);
  const fragments = await createFragmentRuntime(session, {
    renderKick,
    ...options.fragments,
  });

  return {
    world,
    grid,
    renderKick,
    pixelRatio,
    navigationPixelRatioCap: NAVIGATION_PIXEL_RATIO_CAP,
    cameraSettleDelayMs: CAMERA_SETTLE_DELAY_MS,
    cullerShowPassMinIntervalMs: CULLER_SHOW_PASS_MIN_INTERVAL_MS,
    postproduction,
    fragments,
  };
}
