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
}

export interface FragmentUpdateSchedulerSnapshot {
  readonly navigating: boolean;
  readonly inFlight: boolean;
  readonly framePending: boolean;
  readonly microtaskPending: boolean;
  readonly immediatePending: boolean;
  readonly idlePending: boolean;
}

export interface FragmentUpdateScheduler {
  request: (request: FragmentUpdateRequest) => void;
  setNavigating: (navigating: boolean) => void;
  cancel: () => void;
  snapshot: () => FragmentUpdateSchedulerSnapshot;
}

interface PendingBatch {
  force: boolean;
  reasons: Set<FragmentUpdateReason>;
  priorities: Set<FragmentUpdatePriority>;
}

function createEmptyBatch(): PendingBatch {
  return { force: false, reasons: new Set(), priorities: new Set() };
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
} {
  const out = {
    force: batch.force,
    priority: inferPriority(batch),
    reasons: Array.from(batch.reasons),
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
  let frameHandle: number | null = null;
  let microtaskQueued = false;
  const queueTask = options.microtask ?? ((cb: () => void) => queueMicrotask(cb));
  const immediate = createEmptyBatch();
  const idle = createEmptyBatch();

  const canRun = () => hasBatch(immediate) || (!navigating && hasBatch(idle));

  const scheduleFrame = () => {
    if (frameHandle !== null || inFlight || !canRun()) return;
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
    if (microtaskQueued || inFlight || !canRun()) return;
    microtaskQueued = true;
    queueTask(() => {
      microtaskQueued = false;
      if (frameHandle !== null) {
        options.cancelRaf(frameHandle);
        frameHandle = null;
      }
      void drain();
    });
  };

  const scheduleNext = () => {
    if (hasBatch(immediate) && immediate.priorities.has('visual')) {
      scheduleMicrotask();
    } else {
      scheduleFrame();
    }
  };

  const drain = async () => {
    if (inFlight || !canRun()) return;

    const batch = hasBatch(immediate) ? consumeBatch(immediate) : consumeBatch(idle);
    const run: FragmentUpdateRun = {
      force: batch.force,
      priority: batch.priority,
      reasons: batch.reasons,
    };

    inFlight = true;
    options.onRunStart?.(run);
    let error: unknown | null = null;
    try {
      await options.update(run.force);
    } catch (err) {
      error = err;
    } finally {
      inFlight = false;
      options.onRunEnd?.(run, error);
      scheduleNext();
    }
  };

  const request = (next: FragmentUpdateRequest) => {
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
  };

  const setNavigating = (next: boolean) => {
    if (navigating === next) return;
    navigating = next;
    scheduleFrame();
  };

  const cancel = () => {
    if (frameHandle !== null) {
      options.cancelRaf(frameHandle);
      frameHandle = null;
    }
    immediate.force = false;
    immediate.reasons.clear();
    immediate.priorities.clear();
    idle.force = false;
    idle.reasons.clear();
    idle.priorities.clear();
  };

  const snapshot = (): FragmentUpdateSchedulerSnapshot => ({
    navigating,
    inFlight,
    framePending: frameHandle !== null,
    microtaskPending: microtaskQueued,
    immediatePending: hasBatch(immediate),
    idlePending: hasBatch(idle),
  });

  return { request, setNavigating, cancel, snapshot };
}
