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
