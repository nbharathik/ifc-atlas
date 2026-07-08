/**
 * Unit tests for the LangGraph chat-thread persistence slice of useStore.
 * Covers: initial state, setChatThreadId, setChatHistoryRestored,
 * restoreThreadHistory, and clearChat reset behaviour.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../useStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetThread() {
  // Reset just the thread fields without touching unrelated store state.
  useStore.setState({
    chatMessages: [],
    chatHistoryRestored: false,
  });
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe('chatThreadId initial state', () => {
  it('is a non-empty string', () => {
    const id = useStore.getState().chatThreadId;
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('chatHistoryRestored starts false', () => {
    expect(useStore.getState().chatHistoryRestored).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// setChatHistoryRestored
// ---------------------------------------------------------------------------

describe('setChatHistoryRestored', () => {
  beforeEach(() => resetThread());

  it('sets to true', () => {
    useStore.getState().setChatHistoryRestored(true);
    expect(useStore.getState().chatHistoryRestored).toBe(true);
  });

  it('sets back to false', () => {
    useStore.getState().setChatHistoryRestored(true);
    useStore.getState().setChatHistoryRestored(false);
    expect(useStore.getState().chatHistoryRestored).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// restoreThreadHistory
// ---------------------------------------------------------------------------

describe('restoreThreadHistory', () => {
  beforeEach(() => resetThread());

  it('replaces chatMessages with restored history', () => {
    const msgs = [
      { role: 'user' as const, content: 'How many walls?' },
      { role: 'assistant' as const, content: 'There are 3 walls.' },
    ];
    useStore.getState().restoreThreadHistory(msgs);
    expect(useStore.getState().chatMessages).toHaveLength(2);
    expect(useStore.getState().chatMessages[0].content).toBe('How many walls?');
  });

  it('sets chatHistoryRestored to true', () => {
    useStore.getState().restoreThreadHistory([{ role: 'user', content: 'hi' }]);
    expect(useStore.getState().chatHistoryRestored).toBe(true);
  });

  it('handles empty restoration gracefully', () => {
    useStore.getState().restoreThreadHistory([]);
    expect(useStore.getState().chatMessages).toHaveLength(0);
    expect(useStore.getState().chatHistoryRestored).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// setChatThreadId
// ---------------------------------------------------------------------------

describe('setChatThreadId', () => {
  beforeEach(() => {
    resetThread();
    useStore.getState().restoreThreadHistory([{ role: 'user', content: 'old message' }]);
  });

  it('updates chatThreadId', () => {
    useStore.getState().setChatThreadId('new-uuid-123');
    expect(useStore.getState().chatThreadId).toBe('new-uuid-123');
  });

  it('clears chatMessages when thread changes', () => {
    expect(useStore.getState().chatMessages).toHaveLength(1);
    useStore.getState().setChatThreadId('brand-new-thread');
    expect(useStore.getState().chatMessages).toHaveLength(0);
  });

  it('resets chatHistoryRestored when thread changes', () => {
    expect(useStore.getState().chatHistoryRestored).toBe(true);
    useStore.getState().setChatThreadId('another-thread');
    expect(useStore.getState().chatHistoryRestored).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// clearChat resets chatHistoryRestored
// ---------------------------------------------------------------------------

describe('clearChat', () => {
  beforeEach(() => resetThread());

  it('resets chatHistoryRestored to false', () => {
    useStore.getState().setChatHistoryRestored(true);
    useStore.getState().clearChat();
    expect(useStore.getState().chatHistoryRestored).toBe(false);
  });

  it('empties chatMessages', () => {
    useStore.getState().restoreThreadHistory([{ role: 'user', content: 'test' }]);
    useStore.getState().clearChat();
    expect(useStore.getState().chatMessages).toHaveLength(0);
  });
});
