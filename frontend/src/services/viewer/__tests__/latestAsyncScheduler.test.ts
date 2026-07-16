import { describe, expect, it, vi } from 'vitest';
import { createLatestAsyncScheduler } from '../latestAsyncScheduler';

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
