/**
 * Vitest coverage for the multi-select store reducers.
 *
 * toggleSelectId / clearSelectedIds / selectElement (clears selectedIds)
 * are the load-bearing actions for Shift-click multi-select. Regressions
 * here show up as: "Shift+click doesn't accumulate selections", "single
 * click doesn't reset multi-set", or "Escape doesn't clear highlights".
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../useStore';

function reset() {
  useStore.setState({
    selectedElementId: null,
    selectedElement: null,
    selectedIds: [],
  });
}

describe('multi-select reducers', () => {
  beforeEach(reset);

  describe('toggleSelectId', () => {
    it('adds an id to an empty set', () => {
      useStore.getState().toggleSelectId(10);
      expect(useStore.getState().selectedIds).toEqual([10]);
    });

    it('adds a second distinct id', () => {
      useStore.getState().toggleSelectId(10);
      useStore.getState().toggleSelectId(20);
      expect(useStore.getState().selectedIds).toEqual([10, 20]);
    });

    it('removes an id that is already in the set', () => {
      useStore.getState().toggleSelectId(10);
      useStore.getState().toggleSelectId(20);
      useStore.getState().toggleSelectId(10);
      expect(useStore.getState().selectedIds).toEqual([20]);
    });

    it('deselecting last id leaves empty array', () => {
      useStore.getState().toggleSelectId(10);
      useStore.getState().toggleSelectId(10);
      expect(useStore.getState().selectedIds).toEqual([]);
    });

    it('keeps selectedElementId as the last-toggled id when adding', () => {
      useStore.getState().toggleSelectId(10);
      useStore.getState().toggleSelectId(20);
      expect(useStore.getState().selectedElementId).toBe(20);
    });

    it('keeps previous selectedElementId when removing (set non-empty)', () => {
      useStore.getState().toggleSelectId(10);
      useStore.getState().toggleSelectId(20);
      // Remove 20 - selectedIds=[10], selectedElementId should be 10 (last in set)
      useStore.getState().toggleSelectId(20);
      expect(useStore.getState().selectedIds).toEqual([10]);
      // selectedElementId stays as the last element of the remaining set
      expect(useStore.getState().selectedElementId).toBe(10);
    });

    it('accumulates 5 distinct ids', () => {
      [1, 2, 3, 4, 5].forEach((id) => useStore.getState().toggleSelectId(id));
      expect(useStore.getState().selectedIds).toHaveLength(5);
      expect(useStore.getState().selectedIds).toEqual([1, 2, 3, 4, 5]);
    });

    it('does not create duplicates on repeated toggle of same id', () => {
      useStore.getState().toggleSelectId(7);
      useStore.getState().toggleSelectId(7); // remove
      useStore.getState().toggleSelectId(7); // add again
      expect(useStore.getState().selectedIds).toEqual([7]);
    });
  });

  describe('clearSelectedIds', () => {
    it('empties a populated selection set', () => {
      useStore.setState({ selectedIds: [1, 2, 3] });
      useStore.getState().clearSelectedIds();
      expect(useStore.getState().selectedIds).toEqual([]);
    });

    it('is a no-op on an already-empty set', () => {
      useStore.getState().clearSelectedIds();
      expect(useStore.getState().selectedIds).toEqual([]);
    });

    it('does not touch selectedElementId', () => {
      useStore.setState({ selectedElementId: 42, selectedIds: [1, 2] });
      useStore.getState().clearSelectedIds();
      expect(useStore.getState().selectedElementId).toBe(42);
    });
  });

  describe('selectElement clears selectedIds', () => {
    it('single-click select clears the multi-set', () => {
      useStore.setState({ selectedIds: [10, 20, 30] });
      useStore.getState().selectElement(99);
      expect(useStore.getState().selectedIds).toEqual([]);
      expect(useStore.getState().selectedElementId).toBe(99);
    });

    it('selectElement(null) clears both selectedElementId and selectedIds', () => {
      useStore.setState({ selectedElementId: 5, selectedIds: [5, 6] });
      useStore.getState().selectElement(null);
      expect(useStore.getState().selectedElementId).toBeNull();
      expect(useStore.getState().selectedIds).toEqual([]);
    });
  });
});

describe('setSelectedIds (bridge/AI replace-set action)', () => {
  beforeEach(() => {
    useStore.setState({
      selectedElementId: null,
      selectedElement: null,
      selectedIds: [],
    });
  });

  it('replaces the whole set and makes the first id primary', () => {
    useStore.setState({ selectedIds: [1, 2], selectedElementId: 2 });
    useStore.getState().setSelectedIds([10, 20, 30]);
    expect(useStore.getState().selectedIds).toEqual([10, 20, 30]);
    expect(useStore.getState().selectedElementId).toBe(10);
  });

  it('keeps the current primary when it is inside the new set', () => {
    useStore.setState({ selectedElementId: 20 });
    useStore.getState().setSelectedIds([10, 20, 30]);
    expect(useStore.getState().selectedElementId).toBe(20);
    expect(useStore.getState().selectedIds).toEqual([10, 20, 30]);
  });

  it('empty ids clears the set but leaves the primary selection alone', () => {
    useStore.setState({ selectedElementId: 7, selectedIds: [7, 8] });
    useStore.getState().setSelectedIds([]);
    expect(useStore.getState().selectedIds).toEqual([]);
    expect(useStore.getState().selectedElementId).toBe(7);
  });
});
