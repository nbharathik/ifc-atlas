/**
 * rAF-coalesce scheduler for the selection-highlight rebuild loop.
 *
 * Motivation: the four Zustand subscribers in `ViewerPanel.tsx` for
 * `highlightedIds`, `selectedElementId`, `selectedIds`, and `colourBy`
 * each fire `rebuildNativeHighlights()` synchronously. When a single
 * store action mutates more than one of those keys - Shift+click does
 * `selectedElementId + selectedIds` in one `set()` - two rebuilds
 * launch back-to-back. The `myGen = ++highlightGenRef.current`
 * cancellation pattern correctly suppresses the *writes* of the first
 * call, but its `await model.resetHighlight(undefined)` and colour-by
 * recompute have already cost wall-clock work that the second call
 * repeats.
 *
 * `createRebuildScheduler` collapses N synchronous `schedule()` calls
 * inside one rAF window into one `run()` invocation on the next frame.
 * The decision of whether the rebuild is needed at all still lives in
 * `selectionHighlightHelpers.decideSelectionWork` - this file is just
 * the frame-boundary collapser.
 *
 * Pure (rAF / cancelRaf / run are injected) so vitest can drive frames
 * deterministically without `requestAnimationFrame` or a renderer. The
 * production wiring in `ViewerPanel.tsx` passes
 * `window.requestAnimationFrame` / `window.cancelAnimationFrame`.
 */
export type RebuildSchedulerOptions = {
  /** Schedule `cb` to run on the next animation frame. Returns a handle. */
  raf: (cb: () => void) => number;
  /** Cancel a previously-scheduled rAF handle. No-op if already fired. */
  cancelRaf: (handle: number) => void;
  /** The work to do - invoked at most once per rAF window. */
  run: () => void;
};

export type RebuildScheduler = {
  /** Request a rebuild on the next frame. Multiple calls collapse into one. */
  schedule: () => void;
  /** Cancel any pending rebuild. Safe to call when nothing is pending. */
  cancel: () => void;
  /** True iff a rAF is queued and `run()` has not fired yet. */
  pending: () => boolean;
};

/**
 * Create a single-flight rAF scheduler. The contract:
 *   - `schedule()` while idle → queues one rAF; flips `pending()` to true.
 *   - `schedule()` while pending → no-op; the existing rAF still wins.
 *   - rAF fires → clears the pending flag *before* `run()` is invoked, so
 *     a reentrant `schedule()` inside `run()` correctly queues the next
 *     frame's rebuild.
 *   - `cancel()` while pending → cancels the rAF and clears the flag.
 *   - `cancel()` while idle → no-op.
 *
 * The scheduler is single-instance state - do NOT share one scheduler
 * across two viewers. Each `useEffect` mount creates its own and
 * cancels on unmount.
 */
export function createRebuildScheduler(opts: RebuildSchedulerOptions): RebuildScheduler {
  let pendingHandle: number | null = null;

  const schedule = () => {
    if (pendingHandle !== null) return;
    pendingHandle = opts.raf(() => {
      // Clear BEFORE run so a reentrant schedule() inside run() queues a
      // new rAF instead of being suppressed by the still-true flag.
      pendingHandle = null;
      opts.run();
    });
  };

  const cancel = () => {
    if (pendingHandle === null) return;
    opts.cancelRaf(pendingHandle);
    pendingHandle = null;
  };

  const pending = () => pendingHandle !== null;

  return { schedule, cancel, pending };
}
