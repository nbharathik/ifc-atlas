import { describe, expect, it, vi } from 'vitest';
import { createViewerStateCapabilities } from '../viewerStateCapabilities';

function createState() {
  return {
    selectElement: vi.fn(),
    setHighlightedIds: vi.fn(),
    setIsolatedIds: vi.fn(),
    setHiddenIds: vi.fn(),
    clearVisibility: vi.fn(),
  };
}

describe('viewer state capabilities', () => {
  it('applies selection through one typed command', () => {
    const state = createState();
    const capabilities = createViewerStateCapabilities(() => state);

    capabilities.selection.apply({
      selectedId: 42,
      highlightedIds: [42, 84],
    });

    expect(state.setHighlightedIds).toHaveBeenCalledWith([42, 84]);
    expect(state.selectElement).toHaveBeenCalledWith(42);
  });

  it('gives isolation precedence over hidden ids', () => {
    const state = createState();
    const capabilities = createViewerStateCapabilities(() => state);

    capabilities.visibility.apply({
      isolatedIds: [7],
      hiddenIds: [8],
    });

    expect(state.setIsolatedIds).toHaveBeenCalledWith([7]);
    expect(state.setHiddenIds).not.toHaveBeenCalled();
  });

  it('clears visibility for an empty policy and ignores work after disposal', () => {
    const state = createState();
    const capabilities = createViewerStateCapabilities(() => state);

    capabilities.visibility.apply({ isolatedIds: [], hiddenIds: [] });
    capabilities.dispose();
    capabilities.visibility.hide([9]);
    capabilities.selection.select(9);

    expect(state.clearVisibility).toHaveBeenCalledTimes(1);
    expect(state.setHiddenIds).not.toHaveBeenCalled();
    expect(state.selectElement).not.toHaveBeenCalled();
  });
});
