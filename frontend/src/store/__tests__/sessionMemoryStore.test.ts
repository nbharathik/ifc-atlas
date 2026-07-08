import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../useStore';

const store = () => useStore.getState();

function resetSlice() {
  useStore.setState({ sessionMemoryFacts: [] });
}

describe('session memory store slice', () => {
  beforeEach(resetSlice);

  it('initial state is empty array', () => {
    expect(store().sessionMemoryFacts).toEqual([]);
  });

  it('setSessionMemoryFacts replaces list', () => {
    store().setSessionMemoryFacts(['Total elements: 149', 'Storeys: Ground Floor, First Floor']);
    expect(store().sessionMemoryFacts).toHaveLength(2);
    expect(store().sessionMemoryFacts[0]).toBe('Total elements: 149');
  });

  it('setSessionMemoryFacts with empty list clears', () => {
    store().setSessionMemoryFacts(['fact 1']);
    store().setSessionMemoryFacts([]);
    expect(store().sessionMemoryFacts).toHaveLength(0);
  });

  it('clearSessionMemoryFacts resets to empty', () => {
    store().setSessionMemoryFacts(['a', 'b', 'c']);
    store().clearSessionMemoryFacts();
    expect(store().sessionMemoryFacts).toEqual([]);
  });

  it('multiple setSessionMemoryFacts calls keep latest', () => {
    store().setSessionMemoryFacts(['old fact']);
    store().setSessionMemoryFacts(['new fact 1', 'new fact 2']);
    expect(store().sessionMemoryFacts).toEqual(['new fact 1', 'new fact 2']);
  });
});
