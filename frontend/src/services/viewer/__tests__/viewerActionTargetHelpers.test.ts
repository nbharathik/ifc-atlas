import { describe, expect, it } from 'vitest';
import { resolveViewerActionTargets } from '../viewerActionTargetHelpers';

describe('resolveViewerActionTargets', () => {
  it('prefers a non-empty multi-selection over the primary and highlights', () => {
    expect(resolveViewerActionTargets({
      selectedIds: [11, 12],
      selectedElementId: 12,
      highlightedIds: [90, 91],
    })).toEqual([11, 12]);
  });

  it('uses the primary selection when the multi-selection is empty', () => {
    expect(resolveViewerActionTargets({
      selectedIds: [],
      selectedElementId: 7,
      highlightedIds: [90, 91],
    })).toEqual([7]);
  });

  it('falls back to highlighted result IDs when there is no selection', () => {
    expect(resolveViewerActionTargets({
      selectedIds: [],
      selectedElementId: null,
      highlightedIds: [20, 21],
    })).toEqual([20, 21]);
  });

  it('returns an empty array when no action target exists', () => {
    expect(resolveViewerActionTargets({
      selectedIds: [],
      selectedElementId: null,
      highlightedIds: [],
    })).toEqual([]);
  });

  it('returns a fresh array and deduplicates the winning source in order', () => {
    const selectedIds: readonly number[] = Object.freeze([3, 4, 3, 5, 4]);
    const result = resolveViewerActionTargets({
      selectedIds,
      selectedElementId: 99,
      highlightedIds: [100],
    });

    expect(result).not.toBe(selectedIds);
    expect(result).toEqual([3, 4, 5]);
  });

  it('drops non-finite IDs without falling through from an owned multi-selection', () => {
    expect(resolveViewerActionTargets({
      selectedIds: [Number.NaN, Number.POSITIVE_INFINITY],
      selectedElementId: 7,
      highlightedIds: [8],
    })).toEqual([]);
  });

  it('ignores an invalid primary and safely falls back to result highlights', () => {
    expect(resolveViewerActionTargets({
      selectedIds: [],
      selectedElementId: Number.NaN,
      highlightedIds: [8, Number.NEGATIVE_INFINITY, 9],
    })).toEqual([8, 9]);
  });

  it('treats zero and negative finite IDs as values for downstream validation', () => {
    expect(resolveViewerActionTargets({
      selectedIds: [0, -1],
      selectedElementId: null,
      highlightedIds: [],
    })).toEqual([0, -1]);
  });
});
