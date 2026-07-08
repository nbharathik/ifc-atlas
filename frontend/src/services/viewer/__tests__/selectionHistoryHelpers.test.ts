import { describe, expect, it } from 'vitest';
import {
  EMPTY_HISTORY,
  MAX_HISTORY,
  canGoBack,
  canGoForward,
  currentId,
  goBack,
  goForward,
  pushSelection,
  resetHistory,
  shouldShowSelectionHistoryNav,
} from '../selectionHistoryHelpers';

describe('selectionHistoryHelpers', () => {
  describe('initial state', () => {
    it('EMPTY_HISTORY has empty stack and pointer -1', () => {
      expect(EMPTY_HISTORY.stack).toEqual([]);
      expect(EMPTY_HISTORY.pointer).toBe(-1);
    });

    it('currentId returns null on empty', () => {
      expect(currentId(EMPTY_HISTORY)).toBeNull();
    });

    it('canGoBack / canGoForward both false on empty', () => {
      expect(canGoBack(EMPTY_HISTORY)).toBe(false);
      expect(canGoForward(EMPTY_HISTORY)).toBe(false);
    });
  });

  describe('pushSelection', () => {
    it('appends first id and advances pointer to 0', () => {
      const next = pushSelection(EMPTY_HISTORY, 42);
      expect(next.stack).toEqual([42]);
      expect(next.pointer).toBe(0);
      expect(currentId(next)).toBe(42);
    });

    it('appends a different id at the tail', () => {
      const a = pushSelection(EMPTY_HISTORY, 1);
      const b = pushSelection(a, 2);
      const c = pushSelection(b, 3);
      expect(c.stack).toEqual([1, 2, 3]);
      expect(c.pointer).toBe(2);
    });

    it('is a no-op when re-pushing the currently active id', () => {
      const a = pushSelection(EMPTY_HISTORY, 7);
      const b = pushSelection(a, 7);
      // Same object reference - caller can rely on === short-circuit.
      expect(b).toBe(a);
    });

    it('discards forward history when pushing after a goBack (browser-style)', () => {
      let s = pushSelection(EMPTY_HISTORY, 1);
      s = pushSelection(s, 2);
      s = pushSelection(s, 3);
      // Walk back to id=1, then push a brand-new id - 2 and 3 should be gone.
      s = goBack(s); // pointer 1 (at id=2)
      s = goBack(s); // pointer 0 (at id=1)
      s = pushSelection(s, 99);
      expect(s.stack).toEqual([1, 99]);
      expect(s.pointer).toBe(1);
    });

    it('caps stack at MAX_HISTORY and shifts pointer to tail', () => {
      let s = EMPTY_HISTORY;
      for (let i = 0; i < MAX_HISTORY + 5; i++) {
        s = pushSelection(s, i);
      }
      expect(s.stack.length).toBe(MAX_HISTORY);
      expect(s.pointer).toBe(MAX_HISTORY - 1);
      // Oldest 5 entries dropped - first item should now be id=5.
      expect(s.stack[0]).toBe(5);
      expect(s.stack[s.stack.length - 1]).toBe(MAX_HISTORY + 4);
    });

    it('respects a custom maxSize', () => {
      let s = EMPTY_HISTORY;
      for (let i = 0; i < 10; i++) {
        s = pushSelection(s, i, 3);
      }
      expect(s.stack).toEqual([7, 8, 9]);
      expect(s.pointer).toBe(2);
    });

    it('rejects non-finite ids', () => {
      const a = pushSelection(EMPTY_HISTORY, Number.NaN);
      expect(a).toBe(EMPTY_HISTORY);
      const b = pushSelection(EMPTY_HISTORY, Number.POSITIVE_INFINITY);
      expect(b).toBe(EMPTY_HISTORY);
    });
  });

  describe('goBack / goForward', () => {
    it('walks back through the stack one step at a time', () => {
      let s = pushSelection(EMPTY_HISTORY, 10);
      s = pushSelection(s, 20);
      s = pushSelection(s, 30);
      expect(currentId(s)).toBe(30);
      s = goBack(s);
      expect(currentId(s)).toBe(20);
      s = goBack(s);
      expect(currentId(s)).toBe(10);
      // At the head - further back is a no-op.
      const beforeAdditionalBack = s;
      s = goBack(s);
      expect(s).toBe(beforeAdditionalBack);
    });

    it('walks forward after a back', () => {
      let s = pushSelection(EMPTY_HISTORY, 1);
      s = pushSelection(s, 2);
      s = pushSelection(s, 3);
      s = goBack(s);
      s = goBack(s);
      expect(currentId(s)).toBe(1);
      s = goForward(s);
      expect(currentId(s)).toBe(2);
      s = goForward(s);
      expect(currentId(s)).toBe(3);
      // At the tail - further forward is a no-op.
      const beforeExtra = s;
      s = goForward(s);
      expect(s).toBe(beforeExtra);
    });

    it('canGoBack / canGoForward reflect pointer position', () => {
      let s = pushSelection(EMPTY_HISTORY, 1);
      s = pushSelection(s, 2);
      s = pushSelection(s, 3);
      expect(canGoBack(s)).toBe(true);
      expect(canGoForward(s)).toBe(false);
      s = goBack(s);
      expect(canGoBack(s)).toBe(true);
      expect(canGoForward(s)).toBe(true);
      s = goBack(s);
      expect(canGoBack(s)).toBe(false);
      expect(canGoForward(s)).toBe(true);
    });

    it('re-pushing current id mid-history does not collapse the forward stack', () => {
      let s = pushSelection(EMPTY_HISTORY, 1);
      s = pushSelection(s, 2);
      s = pushSelection(s, 3);
      s = goBack(s); // at id=2, with id=3 forward
      // Synthetic re-push of id=2 (e.g. user clicks the same element again).
      const after = pushSelection(s, 2);
      expect(after).toBe(s); // no state change
      expect(canGoForward(after)).toBe(true);
      expect(after.stack).toEqual([1, 2, 3]);
    });
  });

  describe('resetHistory', () => {
    it('returns a fresh empty state', () => {
      let s = pushSelection(EMPTY_HISTORY, 1);
      s = pushSelection(s, 2);
      const fresh = resetHistory();
      expect(fresh.stack).toEqual([]);
      expect(fresh.pointer).toBe(-1);
      expect(s.stack.length).toBe(2); // original untouched
    });
  });

  describe('shouldShowSelectionHistoryNav', () => {
    it('false when no model is loaded', () => {
      const two = pushSelection(pushSelection(EMPTY_HISTORY, 1), 2);
      expect(shouldShowSelectionHistoryNav(false, two)).toBe(false);
    });

    it('false on an empty stack even when a model is loaded', () => {
      expect(shouldShowSelectionHistoryNav(true, EMPTY_HISTORY)).toBe(false);
    });

    it('false with only one selection - no useful navigation yet', () => {
      const one = pushSelection(EMPTY_HISTORY, 42);
      expect(shouldShowSelectionHistoryNav(true, one)).toBe(false);
    });

    it('true once at least two selections have been made', () => {
      const two = pushSelection(pushSelection(EMPTY_HISTORY, 1), 2);
      expect(shouldShowSelectionHistoryNav(true, two)).toBe(true);
    });

    it('stays true after walking back through history', () => {
      let s = pushSelection(EMPTY_HISTORY, 1);
      s = pushSelection(s, 2);
      s = pushSelection(s, 3);
      s = goBack(s);
      // Pointer moved, but stack length is unchanged - still navigable.
      expect(shouldShowSelectionHistoryNav(true, s)).toBe(true);
    });
  });
});
