import { describe, it, expect, vi } from 'vitest';
import { createRebuildScheduler } from '../rebuildScheduler';

/**
 * Fake rAF driver: queued callbacks fire on `flush()`. Lets us assert
 * exact rAF-call counts without timing flake.
 */
function makeFakeRaf() {
  const queue: Array<{ handle: number; cb: () => void; cancelled: boolean }> = [];
  let nextHandle = 1;
  const raf = vi.fn((cb: () => void) => {
    const handle = nextHandle++;
    queue.push({ handle, cb, cancelled: false });
    return handle;
  });
  const cancelRaf = vi.fn((handle: number) => {
    const entry = queue.find((e) => e.handle === handle);
    if (entry) entry.cancelled = true;
  });
  const flush = () => {
    // Pop everything so reentrant raf() during cb lands in a fresh queue.
    const pending = queue.splice(0, queue.length);
    for (const entry of pending) {
      if (!entry.cancelled) entry.cb();
    }
  };
  return { raf, cancelRaf, flush, queue };
}

describe('createRebuildScheduler', () => {
  it('schedule() while idle queues exactly one rAF', () => {
    const fake = makeFakeRaf();
    const run = vi.fn();
    const s = createRebuildScheduler({ raf: fake.raf, cancelRaf: fake.cancelRaf, run });
    s.schedule();
    expect(fake.raf).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    expect(s.pending()).toBe(true);
  });

  it('coalesces 4 back-to-back schedule() calls into one run()', () => {
    // The headline coalescing contract: a Zustand action that
    // touches `selectedElementId` + `selectedIds` + `highlightedIds` +
    // `colourBy` in the same tick fires the 4 ViewerPanel subscribers
    // synchronously. All four must collapse into one rebuild.
    const fake = makeFakeRaf();
    const run = vi.fn();
    const s = createRebuildScheduler({ raf: fake.raf, cancelRaf: fake.cancelRaf, run });
    s.schedule();
    s.schedule();
    s.schedule();
    s.schedule();
    expect(fake.raf).toHaveBeenCalledTimes(1);
    fake.flush();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('coalesces 100 schedule() calls into one run() (stress)', () => {
    const fake = makeFakeRaf();
    const run = vi.fn();
    const s = createRebuildScheduler({ raf: fake.raf, cancelRaf: fake.cancelRaf, run });
    for (let i = 0; i < 100; i += 1) s.schedule();
    expect(fake.raf).toHaveBeenCalledTimes(1);
    fake.flush();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('pending() flips false BEFORE run() so reentrant schedule() queues next frame', () => {
    // Failure mode this guards against: clearing the pending flag AFTER
    // run() returns means a `schedule()` called inside run() (e.g. a
    // rebuild that itself mutated the store) gets silently dropped.
    const fake = makeFakeRaf();
    let observedPendingInsideRun = true;
    const s = createRebuildScheduler({
      raf: fake.raf,
      cancelRaf: fake.cancelRaf,
      run: () => {
        observedPendingInsideRun = s.pending();
        s.schedule();
      },
    });
    s.schedule();
    fake.flush();
    expect(observedPendingInsideRun).toBe(false);
    expect(s.pending()).toBe(true);
    expect(fake.raf).toHaveBeenCalledTimes(2);
  });

  it('schedule() after rAF fires queues a fresh rAF', () => {
    const fake = makeFakeRaf();
    const run = vi.fn();
    const s = createRebuildScheduler({ raf: fake.raf, cancelRaf: fake.cancelRaf, run });
    s.schedule();
    fake.flush();
    expect(run).toHaveBeenCalledTimes(1);
    expect(s.pending()).toBe(false);
    s.schedule();
    fake.flush();
    expect(run).toHaveBeenCalledTimes(2);
    expect(fake.raf).toHaveBeenCalledTimes(2);
  });

  it('cancel() before rAF fires suppresses run()', () => {
    const fake = makeFakeRaf();
    const run = vi.fn();
    const s = createRebuildScheduler({ raf: fake.raf, cancelRaf: fake.cancelRaf, run });
    s.schedule();
    expect(s.pending()).toBe(true);
    s.cancel();
    expect(s.pending()).toBe(false);
    expect(fake.cancelRaf).toHaveBeenCalledTimes(1);
    fake.flush();
    expect(run).not.toHaveBeenCalled();
  });

  it('cancel() when idle is a no-op (does not call cancelRaf)', () => {
    const fake = makeFakeRaf();
    const run = vi.fn();
    const s = createRebuildScheduler({ raf: fake.raf, cancelRaf: fake.cancelRaf, run });
    s.cancel();
    expect(fake.cancelRaf).not.toHaveBeenCalled();
    expect(s.pending()).toBe(false);
  });

  it('cancel() after run() fires is a no-op (the rAF already cleared pending)', () => {
    const fake = makeFakeRaf();
    const run = vi.fn();
    const s = createRebuildScheduler({ raf: fake.raf, cancelRaf: fake.cancelRaf, run });
    s.schedule();
    fake.flush();
    s.cancel();
    expect(fake.cancelRaf).not.toHaveBeenCalled();
  });

  it('schedule → cancel → schedule re-queues a fresh rAF', () => {
    const fake = makeFakeRaf();
    const run = vi.fn();
    const s = createRebuildScheduler({ raf: fake.raf, cancelRaf: fake.cancelRaf, run });
    s.schedule();
    s.cancel();
    s.schedule();
    expect(fake.raf).toHaveBeenCalledTimes(2);
    fake.flush();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('two independent schedulers do not share state', () => {
    // Defensive: confirm each `useEffect` mount gets isolated state. A
    // shared module-level flag would mean unmount+remount during HMR
    // could leak a stale "pending" between the two viewer instances.
    const fake = makeFakeRaf();
    const runA = vi.fn();
    const runB = vi.fn();
    const a = createRebuildScheduler({ raf: fake.raf, cancelRaf: fake.cancelRaf, run: runA });
    const b = createRebuildScheduler({ raf: fake.raf, cancelRaf: fake.cancelRaf, run: runB });
    a.schedule();
    expect(a.pending()).toBe(true);
    expect(b.pending()).toBe(false);
    b.schedule();
    expect(fake.raf).toHaveBeenCalledTimes(2);
    fake.flush();
    expect(runA).toHaveBeenCalledTimes(1);
    expect(runB).toHaveBeenCalledTimes(1);
  });

  it('rAF that fires with a stale handle still runs (handle reuse is rAF API contract)', () => {
    // Sanity: the scheduler trusts the injected rAF impl. If the rAF
    // backend reuses handles (the DOM spec allows it), the cb invocation
    // is still the source-of-truth for "this rebuild fired".
    const fake = makeFakeRaf();
    const run = vi.fn();
    const s = createRebuildScheduler({ raf: fake.raf, cancelRaf: fake.cancelRaf, run });
    s.schedule();
    fake.flush();
    s.schedule();
    fake.flush();
    expect(run).toHaveBeenCalledTimes(2);
  });
});
