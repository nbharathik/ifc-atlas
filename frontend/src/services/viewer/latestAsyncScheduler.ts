/**
 * Frame-coalesced, single-flight scheduler for async viewer state writes.
 *
 * A plain rAF scheduler prevents duplicate work within one frame, but it does
 * not prevent the async run started by frame N from overlapping the run
 * started by frame N + 1. That matters for fragment visibility and opacity:
 * two worker requests may finish out of order and briefly restore stale state.
 *
 * This scheduler keeps at most one run in flight. Calls made while that run is
 * active collapse into one follow-up frame, whose callback reads the latest
 * application state. Intermediate snapshots are intentionally discarded.
 */

export interface LatestAsyncRunContext {
  readonly revision: number;
  /** True after a newer schedule/cancel or scheduler shutdown. */
  isSuperseded: () => boolean;
}

export interface LatestAsyncSchedulerOptions {
  raf: (cb: () => void) => number;
  cancelRaf: (handle: number) => void;
  run: (context: LatestAsyncRunContext) => Promise<void> | void;
  onError?: (error: unknown) => void;
}

export interface LatestAsyncScheduler {
  /** Request a run using the latest state. Synchronous bursts coalesce. */
  schedule: () => void;
  /** Cancel queued follow-up work. An already-running task cannot be aborted. */
  cancel: () => void;
  /** Cancel queued work and wait for the current async reader to settle. */
  shutdown: () => Promise<void>;
  /** True when a frame or post-flight rerun is queued. */
  pending: () => boolean;
  /** True while the async callback is executing. */
  inFlight: () => boolean;
}

export function createLatestAsyncScheduler(
  options: LatestAsyncSchedulerOptions,
): LatestAsyncScheduler {
  let frameHandle: number | null = null;
  let running = false;
  let rerunRequested = false;
  let revision = 0;
  let closed = false;
  let shutdownPromise: Promise<void> | null = null;
  let resolveShutdown: (() => void) | null = null;

  const queueFrame = () => {
    if (closed || frameHandle !== null || running || !rerunRequested) return;
    frameHandle = options.raf(() => {
      frameHandle = null;
      if (!rerunRequested || running) return;
      rerunRequested = false;
      running = true;
      const runRevision = revision;
      const context: LatestAsyncRunContext = {
        revision: runRevision,
        isSuperseded: () => closed || revision !== runRevision,
      };
      void (async () => {
        try {
          await options.run(context);
        } catch (error) {
          if (!context.isSuperseded()) options.onError?.(error);
        } finally {
          running = false;
          // State may have changed while the worker request was active. Run
          // once more on a frame boundary, using only the newest snapshot.
          if (closed) {
            resolveShutdown?.();
            resolveShutdown = null;
          } else {
            queueFrame();
          }
        }
      })();
    });
  };

  const schedule = () => {
    if (closed) return;
    revision += 1;
    rerunRequested = true;
    queueFrame();
  };

  const cancel = () => {
    revision += 1;
    rerunRequested = false;
    if (frameHandle !== null) {
      options.cancelRaf(frameHandle);
      frameHandle = null;
    }
  };

  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    closed = true;
    cancel();
    if (!running) {
      shutdownPromise = Promise.resolve();
      return shutdownPromise;
    }
    shutdownPromise = new Promise<void>((resolve) => { resolveShutdown = resolve; });
    return shutdownPromise;
  };

  return {
    schedule,
    cancel,
    shutdown,
    pending: () => frameHandle !== null || rerunRequested,
    inFlight: () => running,
  };
}
