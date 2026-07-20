/**
 * chatThreadId survives reset().
 *
 * The id is session identity, not model state: initialState captures it ONCE
 * at module load (from localStorage or a fresh UUID). "New chat" writes a
 * fresh UUID to store + localStorage; spreading initialState in reset() then
 * reverted the in-memory id to the stale captured one while localStorage held
 * the newer one. On the next open, ChatPanel's restore effect refetched the
 * WRONG thread's history for that reverted id.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../useStore';

describe('chatThreadId across reset()', () => {
  beforeEach(() => {
    useStore.getState().reset();
  });

  it('keeps the current thread id when the model is closed', () => {
    const fresh = 'thread-after-new-chat';
    useStore.getState().setChatThreadId(fresh);

    // "Close model" / opening a different IFC both funnel through reset().
    useStore.getState().reset();

    expect(useStore.getState().chatThreadId).toBe(fresh);
  });

  it('still clears the chat transcript itself on reset', () => {
    useStore.getState().setChatThreadId('thread-x');
    useStore.getState().addChatMessage({ role: 'user', content: 'hello' });

    useStore.getState().reset();

    expect(useStore.getState().chatThreadId).toBe('thread-x');
    expect(useStore.getState().chatMessages).toEqual([]);
    expect(useStore.getState().chatHistoryRestored).toBe(false);
  });
});
