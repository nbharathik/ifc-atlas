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
