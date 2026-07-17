import { describe, expect, it, vi } from 'vitest';
import { createInvalidationRenderLoop } from '../invalidationRenderLoop';

function harness(initialWindowMs = 0) {
  let now = 0;
  let nextHandle = 1;
  const frames = new Map<number, () => void>();
  const invalidate = vi.fn();
  const cancelRaf = vi.fn((handle: number) => { frames.delete(handle); });
  const loop = createInvalidationRenderLoop({
    now: () => now,
    raf: (callback) => {
      const handle = nextHandle++;
      frames.set(handle, callback);
      return handle;
    },
    cancelRaf,
    invalidate,
    initialWindowMs,
  });
  return {
    loop,
    invalidate,
    cancelRaf,
    pending: () => frames.size,
    setNow: (value: number) => { now = value; },
    frame: () => {
      const first = frames.entries().next().value as [number, () => void] | undefined;
      if (!first) throw new Error('No frame is pending');
      frames.delete(first[0]);
      first[1]();
    },
  };
}

describe('createInvalidationRenderLoop', () => {
  it('parks completely when no invalidation window is active', () => {
    const h = harness();
    expect(h.pending()).toBe(0);
    expect(h.loop.snapshot().running).toBe(false);
  });

  it('invalidates immediately and keeps one coalesced frame scheduled', () => {
    const h = harness();
    h.loop.kick(100);
    h.loop.kick(50);
    expect(h.invalidate).toHaveBeenCalledTimes(2);
    expect(h.pending()).toBe(1);
  });

  it('parks after the requested window expires', () => {
    const h = harness();
    h.loop.kick(100);
    h.setNow(50);
    h.frame();
    expect(h.pending()).toBe(1);
    h.setNow(101);
    h.frame();
    expect(h.pending()).toBe(0);
    expect(h.loop.snapshot().running).toBe(false);
  });

  it('extends an active window without starting a second loop', () => {
    const h = harness();
    h.loop.kick(50);
    h.setNow(25);
    h.loop.kick(100);
    expect(h.pending()).toBe(1);
    h.setNow(60);
    h.frame();
    expect(h.pending()).toBe(1);
    h.setNow(126);
    h.frame();
    expect(h.pending()).toBe(0);
  });

  it('supports an initial paint window', () => {
    const h = harness(1_500);
    expect(h.invalidate).toHaveBeenCalledOnce();
    expect(h.pending()).toBe(1);
    expect(h.loop.snapshot().renderUntil).toBe(1_500);
  });

  it('cancels a pending frame and ignores later kicks after stop', () => {
    const h = harness();
    h.loop.kick(100);
    h.loop.stop();
    h.loop.stop();
    expect(h.cancelRaf).toHaveBeenCalledOnce();
    expect(h.pending()).toBe(0);
    const calls = h.invalidate.mock.calls.length;
    h.loop.kick(100);
    expect(h.invalidate).toHaveBeenCalledTimes(calls);
    expect(h.loop.snapshot().stopped).toBe(true);
  });
});
