import { describe, expect, it } from 'vitest';
import { createContextMenuPickGuard } from '../contextMenuPickGuard';

describe('createContextMenuPickGuard', () => {
  it('allows the latest successful hit to open the element menu', () => {
    const guard = createContextMenuPickGuard();
    const generation = guard.begin();
    const hit = { itemId: 42 };

    expect(guard.resolve(generation, { status: 'success', hit })).toEqual({
      kind: 'hit',
      hit,
    });
  });

  it('opens the generic menu only for a confirmed empty-space result', () => {
    const guard = createContextMenuPickGuard();
    const generation = guard.begin();

    expect(guard.resolve(generation, { status: 'success', hit: null })).toEqual({
      kind: 'empty',
    });
  });

  it('does not turn a current pick failure into an empty-space menu', () => {
    const guard = createContextMenuPickGuard();
    const generation = guard.begin();
    const error = new Error('worker unavailable');

    expect(guard.resolve(generation, { status: 'failure', error })).toEqual({
      kind: 'ignore',
      reason: 'failed',
      error,
    });
  });

  it('rejects an older hit when a newer request started first', () => {
    const guard = createContextMenuPickGuard();
    const older = guard.begin();
    const newer = guard.begin();

    expect(guard.resolve(newer, {
      status: 'success',
      hit: { itemId: 2 },
    })).toEqual({ kind: 'hit', hit: { itemId: 2 } });
    expect(guard.resolve(older, {
      status: 'success',
      hit: { itemId: 1 },
    })).toEqual({ kind: 'ignore', reason: 'stale' });
  });

  it('rejects stale misses and failures as well as stale hits', () => {
    const guard = createContextMenuPickGuard();
    const older = guard.begin();
    guard.begin();

    expect(guard.resolve(older, { status: 'success', hit: null })).toEqual({
      kind: 'ignore',
      reason: 'stale',
    });
    expect(guard.resolve(older, {
      status: 'failure',
      error: new Error('late failure'),
    })).toEqual({ kind: 'ignore', reason: 'stale' });
  });

  it('invalidates an in-flight pick for a canceled or dragged right-click', () => {
    const guard = createContextMenuPickGuard();
    const generation = guard.begin();

    guard.invalidate();

    expect(guard.resolve(generation, {
      status: 'success',
      hit: { itemId: 1 },
    })).toEqual({ kind: 'ignore', reason: 'stale' });
  });

  it('allows a fresh request after invalidation', () => {
    const guard = createContextMenuPickGuard();
    const canceled = guard.begin();
    guard.invalidate();
    const fresh = guard.begin();

    expect(guard.resolve(canceled, {
      status: 'success',
      hit: { itemId: 1 },
    })).toEqual({ kind: 'ignore', reason: 'stale' });
    expect(guard.resolve(fresh, {
      status: 'success',
      hit: { itemId: 2 },
    })).toEqual({ kind: 'hit', hit: { itemId: 2 } });
  });

  it('keeps an older hit stale when the latest request fails', () => {
    const guard = createContextMenuPickGuard();
    const older = guard.begin();
    const latest = guard.begin();

    expect(guard.resolve(latest, {
      status: 'failure',
      error: new Error('latest worker failure'),
    })).toMatchObject({ kind: 'ignore', reason: 'failed' });
    expect(guard.resolve(older, {
      status: 'success',
      hit: { itemId: 1 },
    })).toEqual({ kind: 'ignore', reason: 'stale' });
  });

  it('rejects pending and future continuations after disposal', () => {
    const guard = createContextMenuPickGuard();
    const pending = guard.begin();
    guard.dispose();
    const afterDispose = guard.begin();

    expect(guard.resolve(pending, {
      status: 'success',
      hit: { itemId: 1 },
    })).toEqual({ kind: 'ignore', reason: 'disposed' });
    expect(guard.resolve(afterDispose, {
      status: 'success',
      hit: { itemId: 2 },
    })).toEqual({ kind: 'ignore', reason: 'disposed' });
  });
});
