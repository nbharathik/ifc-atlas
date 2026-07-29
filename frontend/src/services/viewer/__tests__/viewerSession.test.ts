import { describe, expect, it, vi } from 'vitest';
import { ViewerSession } from '../viewerSession';

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
