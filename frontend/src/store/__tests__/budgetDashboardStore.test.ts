/**
 * Tests for the budget dashboard store slice.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../useStore';

function reset() {
  useStore.setState({ budgetPanelOpen: false });
}

describe('budget dashboard panel open/close', () => {
  beforeEach(reset);

  it('defaults: budget panel closed', () => {
    expect(useStore.getState().budgetPanelOpen).toBe(false);
  });

  it('setBudgetPanelOpen(true) opens the panel', () => {
    useStore.getState().setBudgetPanelOpen(true);
    expect(useStore.getState().budgetPanelOpen).toBe(true);
  });

  it('setBudgetPanelOpen(false) closes the panel', () => {
    useStore.getState().setBudgetPanelOpen(true);
    useStore.getState().setBudgetPanelOpen(false);
    expect(useStore.getState().budgetPanelOpen).toBe(false);
  });

  it('toggling twice returns to initial state', () => {
    const initial = useStore.getState().budgetPanelOpen;
    useStore.getState().setBudgetPanelOpen(!initial);
    useStore.getState().setBudgetPanelOpen(initial);
    expect(useStore.getState().budgetPanelOpen).toBe(initial);
  });

  it('budget panel is independent of checkpoint panel', () => {
    useStore.getState().setBudgetPanelOpen(true);
    useStore.getState().setCheckpointPanelOpen(false);
    expect(useStore.getState().budgetPanelOpen).toBe(true);
    expect(useStore.getState().checkpointPanelOpen).toBe(false);
  });
});
