import { describe, it, expect } from 'vitest';
import {
  INITIAL_TREE_HOVER_STATE,
  isResolutionStale,
  onTreeHoverEnter,
  onTreeHoverLeave,
  onTreeHoverPainted,
  shouldSkipResetForSelection,
} from '../treeHoverPreviewHelpers';

describe('treeHoverPreviewHelpers', () => {
  describe('onTreeHoverEnter', () => {
    it('bumps gen and records the requested id on first hover', () => {
      const next = onTreeHoverEnter(INITIAL_TREE_HOVER_STATE, 42);
      expect(next.gen).toBe(1);
      expect(next.requestedId).toBe(42);
      expect(next.paintedId).toBeNull();
    });

    it('is a no-op when re-entering the same id', () => {
      const a = onTreeHoverEnter(INITIAL_TREE_HOVER_STATE, 42);
      const b = onTreeHoverEnter(a, 42);
      expect(b).toBe(a);
    });

    it('bumps gen again when entering a different id', () => {
      const a = onTreeHoverEnter(INITIAL_TREE_HOVER_STATE, 42);
      const b = onTreeHoverEnter(a, 99);
      expect(b.gen).toBe(2);
      expect(b.requestedId).toBe(99);
    });

    it('preserves paintedId across enters (resolution may still be in flight)', () => {
      const painted = onTreeHoverPainted(INITIAL_TREE_HOVER_STATE, 7);
      const next = onTreeHoverEnter(painted, 8);
      expect(next.paintedId).toBe(7);
    });
  });

  describe('onTreeHoverLeave', () => {
    it('clears requestedId and bumps gen when leaving an active hover', () => {
      const entered = onTreeHoverEnter(INITIAL_TREE_HOVER_STATE, 42);
      const left = onTreeHoverLeave(entered);
      expect(left.gen).toBe(2);
      expect(left.requestedId).toBeNull();
    });

    it('is a no-op when the state is already idle', () => {
      const next = onTreeHoverLeave(INITIAL_TREE_HOVER_STATE);
      expect(next).toBe(INITIAL_TREE_HOVER_STATE);
    });

    it('preserves paintedId after leave (caller still needs to clear the paint)', () => {
      const painted = onTreeHoverPainted(
        onTreeHoverEnter(INITIAL_TREE_HOVER_STATE, 42),
        42,
      );
      const left = onTreeHoverLeave(painted);
      expect(left.paintedId).toBe(42);
      expect(left.requestedId).toBeNull();
    });
  });

  describe('isResolutionStale', () => {
    it('returns false when the resolution gen matches', () => {
      const s = onTreeHoverEnter(INITIAL_TREE_HOVER_STATE, 42);
      expect(isResolutionStale(s, s.gen)).toBe(false);
    });

    it('returns true after a subsequent enter has bumped the gen', () => {
      const a = onTreeHoverEnter(INITIAL_TREE_HOVER_STATE, 42);
      const aGen = a.gen;
      const b = onTreeHoverEnter(a, 99);
      expect(isResolutionStale(b, aGen)).toBe(true);
    });

    it('returns true after a leave has bumped the gen', () => {
      const a = onTreeHoverEnter(INITIAL_TREE_HOVER_STATE, 42);
      const aGen = a.gen;
      const b = onTreeHoverLeave(a);
      expect(isResolutionStale(b, aGen)).toBe(true);
    });
  });

  describe('onTreeHoverPainted', () => {
    it('records a new paintedId', () => {
      const next = onTreeHoverPainted(INITIAL_TREE_HOVER_STATE, 42);
      expect(next.paintedId).toBe(42);
    });

    it('is a no-op when the paintedId has not changed', () => {
      const a = onTreeHoverPainted(INITIAL_TREE_HOVER_STATE, 42);
      const b = onTreeHoverPainted(a, 42);
      expect(b).toBe(a);
    });

    it('clears paintedId when passed null', () => {
      const a = onTreeHoverPainted(INITIAL_TREE_HOVER_STATE, 42);
      const b = onTreeHoverPainted(a, null);
      expect(b.paintedId).toBeNull();
    });
  });

  describe('shouldSkipResetForSelection', () => {
    it('returns false when paintedExpressId is null', () => {
      expect(shouldSkipResetForSelection(null, 42, [42])).toBe(false);
    });

    it('returns true when paintedExpressId matches selectedElementId', () => {
      expect(shouldSkipResetForSelection(42, 42, [])).toBe(true);
    });

    it('returns true when paintedExpressId is in selectedIds', () => {
      expect(shouldSkipResetForSelection(42, null, [10, 42, 99])).toBe(true);
    });

    it('returns false when paintedExpressId is neither selected nor in selectedIds', () => {
      expect(shouldSkipResetForSelection(42, 99, [10, 11])).toBe(false);
    });

    it('does not treat -1 as a valid express id (regression - old code passed prev ?? -1)', () => {
      // The old call site passed `prev ?? -1` to .includes(), so a -1 in
      // selectedIds would accidentally skip the reset.  The new helper
      // returns false for paintedExpressId === null regardless of what's
      // in selectedIds.
      expect(shouldSkipResetForSelection(null, null, [-1])).toBe(false);
    });

    it('handles empty selection cleanly', () => {
      expect(shouldSkipResetForSelection(42, null, [])).toBe(false);
    });
  });

  describe('rapid hover sweep (integration)', () => {
    it('correctly identifies the painting attempt that wins the race', () => {
      // Hover rows 1 → 2 → 3 rapidly; only the gen-3 resolution should paint.
      let s = INITIAL_TREE_HOVER_STATE;
      s = onTreeHoverEnter(s, 1);
      const gen1 = s.gen;
      s = onTreeHoverEnter(s, 2);
      const gen2 = s.gen;
      s = onTreeHoverEnter(s, 3);
      const gen3 = s.gen;

      expect(isResolutionStale(s, gen1)).toBe(true);
      expect(isResolutionStale(s, gen2)).toBe(true);
      expect(isResolutionStale(s, gen3)).toBe(false);
    });

    it('hover sweep that ends in leave produces a stale chain', () => {
      let s = INITIAL_TREE_HOVER_STATE;
      s = onTreeHoverEnter(s, 1);
      const gen1 = s.gen;
      s = onTreeHoverEnter(s, 2);
      const gen2 = s.gen;
      s = onTreeHoverLeave(s);

      expect(s.requestedId).toBeNull();
      expect(isResolutionStale(s, gen1)).toBe(true);
      expect(isResolutionStale(s, gen2)).toBe(true);
    });
  });
});
