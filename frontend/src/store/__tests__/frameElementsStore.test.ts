/**
 * Vitest coverage for the frameElements / setFrameElementsFn store slice.
 * Verifies the thin-wrapper / registration contract used by
 * ViewerPanel and KeyboardShortcuts to drive the camera without prop drilling.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../useStore';

function resetSlice() {
  useStore.setState({ frameElementsFn: null });
}

describe('frameElements store slice', () => {
  beforeEach(() => {
    resetSlice();
  });

  afterEach(() => {
    resetSlice();
  });

  it('is a no-op when no fn has been registered', () => {
    // Should not throw; nothing observable changes.
    expect(() => useStore.getState().frameElements([1, 2, 3])).not.toThrow();
  });

  it('forwards the ids array to the registered fn', () => {
    const spy = vi.fn();
    useStore.getState().setFrameElementsFn(spy);
    useStore.getState().frameElements([10, 20, 30]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith([10, 20, 30]);
  });

  it('does not call the fn when the ids array is empty', () => {
    const spy = vi.fn();
    useStore.getState().setFrameElementsFn(spy);
    useStore.getState().frameElements([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects non-array input without throwing', () => {
    const spy = vi.fn();
    useStore.getState().setFrameElementsFn(spy);
    // Runtime safety check - downstream callers may forward garbage from a
    // store snapshot. Casts bypass the strict signature so the guard is
    // exercised.
    const frame = useStore.getState().frameElements as (v: unknown) => void;
    frame(null);
    frame(undefined);
    frame('nope');
    expect(spy).not.toHaveBeenCalled();
  });

  it('setFrameElementsFn(null) cleanly de-registers', () => {
    const spy = vi.fn();
    useStore.getState().setFrameElementsFn(spy);
    useStore.getState().setFrameElementsFn(null);
    useStore.getState().frameElements([1]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('subsequent setFrameElementsFn replaces the previous fn', () => {
    const first = vi.fn();
    const second = vi.fn();
    useStore.getState().setFrameElementsFn(first);
    useStore.getState().setFrameElementsFn(second);
    useStore.getState().frameElements([5]);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith([5]);
  });
});
