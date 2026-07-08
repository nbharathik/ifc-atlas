/**
 * Vitest coverage for the flashHighlightIds store action.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../useStore';

function resetSlice() {
  useStore.setState({ highlightedIds: [] });
}

describe('flashHighlightIds store action', () => {
  beforeEach(() => {
    resetSlice();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sets highlightedIds immediately', () => {
    useStore.getState().flashHighlightIds([10, 20, 30]);
    expect(useStore.getState().highlightedIds).toEqual([10, 20, 30]);
  });

  it('clears highlightedIds after default 250 ms', () => {
    useStore.getState().flashHighlightIds([10, 20]);
    vi.advanceTimersByTime(250);
    expect(useStore.getState().highlightedIds).toEqual([]);
  });

  it('clears after custom duration', () => {
    useStore.getState().flashHighlightIds([1], 100);
    vi.advanceTimersByTime(99);
    expect(useStore.getState().highlightedIds).toEqual([1]);
    vi.advanceTimersByTime(1);
    expect(useStore.getState().highlightedIds).toEqual([]);
  });

  it('does not clear when highlight has been overwritten by a different set', () => {
    useStore.getState().flashHighlightIds([10, 20]);
    // Overwrite before timeout fires
    useStore.setState({ highlightedIds: [99] });
    vi.advanceTimersByTime(250);
    // Should not have been reset to [] because [99] ≠ [10, 20]
    expect(useStore.getState().highlightedIds).toEqual([99]);
  });

  it('setHighlightedIds still works independently', () => {
    useStore.getState().setHighlightedIds([7, 8, 9]);
    expect(useStore.getState().highlightedIds).toEqual([7, 8, 9]);
    vi.advanceTimersByTime(500);
    // setHighlightedIds has no timeout - stays
    expect(useStore.getState().highlightedIds).toEqual([7, 8, 9]);
  });
});
