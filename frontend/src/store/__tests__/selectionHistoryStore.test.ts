/**
 * Store-slice coverage for selection history.
 *
 * Verifies that `selectElement` auto-pushes to the history stack and
 * `navigateSelectionHistory` walks back/forward without re-pushing.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../useStore';
import { EMPTY_HISTORY } from '../../services/viewer/selectionHistoryHelpers';

function resetSlice() {
  useStore.setState({
    selectedElementId: null,
    selectedIds: [],
    selectionHistory: EMPTY_HISTORY,
  });
}

describe('selectionHistory store slice', () => {
  beforeEach(() => {
    resetSlice();
  });

  it('selectElement(null) does not push onto the history', () => {
    useStore.getState().selectElement(null);
    const { selectionHistory } = useStore.getState();
    expect(selectionHistory.stack).toEqual([]);
    expect(selectionHistory.pointer).toBe(-1);
  });

  it('selectElement(id) pushes onto history and advances pointer', () => {
    useStore.getState().selectElement(11);
    useStore.getState().selectElement(22);
    useStore.getState().selectElement(33);
    const { selectionHistory } = useStore.getState();
    expect(selectionHistory.stack).toEqual([11, 22, 33]);
    expect(selectionHistory.pointer).toBe(2);
  });

  it('re-selecting the active element does not bloat the stack', () => {
    useStore.getState().selectElement(7);
    useStore.getState().selectElement(7);
    useStore.getState().selectElement(7);
    const { selectionHistory } = useStore.getState();
    expect(selectionHistory.stack).toEqual([7]);
    expect(selectionHistory.pointer).toBe(0);
  });

  it('navigateSelectionHistory("back") walks to previous selection', () => {
    useStore.getState().selectElement(1);
    useStore.getState().selectElement(2);
    useStore.getState().selectElement(3);
    const result = useStore.getState().navigateSelectionHistory('back');
    expect(result).toBe(2);
    expect(useStore.getState().selectedElementId).toBe(2);
    expect(useStore.getState().selectionHistory.pointer).toBe(1);
    // Stack itself is unchanged - just the pointer moved.
    expect(useStore.getState().selectionHistory.stack).toEqual([1, 2, 3]);
  });

  it('navigateSelectionHistory("forward") returns null at the tail', () => {
    useStore.getState().selectElement(10);
    useStore.getState().selectElement(20);
    const result = useStore.getState().navigateSelectionHistory('forward');
    expect(result).toBeNull();
    expect(useStore.getState().selectedElementId).toBe(20);
  });

  it('navigateSelectionHistory("back") returns null at the head', () => {
    useStore.getState().selectElement(5);
    const result = useStore.getState().navigateSelectionHistory('back');
    expect(result).toBeNull();
    expect(useStore.getState().selectedElementId).toBe(5);
  });

  it('selecting a brand-new element after going back trims forward history', () => {
    useStore.getState().selectElement(1);
    useStore.getState().selectElement(2);
    useStore.getState().selectElement(3);
    useStore.getState().navigateSelectionHistory('back'); // at id=2
    useStore.getState().navigateSelectionHistory('back'); // at id=1
    useStore.getState().selectElement(99);
    const { selectionHistory, selectedElementId } = useStore.getState();
    expect(selectionHistory.stack).toEqual([1, 99]);
    expect(selectionHistory.pointer).toBe(1);
    expect(selectedElementId).toBe(99);
  });

  it('setModelLoaded(false) clears selection history', () => {
    useStore.getState().selectElement(1);
    useStore.getState().selectElement(2);
    expect(useStore.getState().selectionHistory.stack.length).toBe(2);
    useStore.getState().setModelLoaded(false);
    const { selectionHistory } = useStore.getState();
    expect(selectionHistory.stack).toEqual([]);
    expect(selectionHistory.pointer).toBe(-1);
  });

  it('selectElement clears selectedIds (multi-select) like before', () => {
    useStore.setState({ selectedIds: [1, 2, 3] });
    useStore.getState().selectElement(99);
    expect(useStore.getState().selectedIds).toEqual([]);
    expect(useStore.getState().selectedElementId).toBe(99);
  });

  it('navigateSelectionHistory clears selectedIds too', () => {
    useStore.getState().selectElement(1);
    useStore.getState().selectElement(2);
    useStore.setState({ selectedIds: [50, 60] });
    useStore.getState().navigateSelectionHistory('back');
    expect(useStore.getState().selectedIds).toEqual([]);
  });
});
