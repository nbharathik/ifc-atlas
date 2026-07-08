import { describe, expect, it, vi } from 'vitest';
import {
  createFragmentUpdateScheduler,
  type FragmentUpdateRun,
} from '../fragmentUpdateScheduler';

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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
});
