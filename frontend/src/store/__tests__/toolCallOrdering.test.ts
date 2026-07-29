/**
 * End-to-end (store + render helper) test for chronological tool-call ordering.
 *
 * The store stamps each tool call with the assistant-text length at the moment
 * it fires (contentOffset); buildMessageParts then reconstructs the true
 * transcript order. This pins the whole path that fixes "all tool calls stack
 * at the top of the message".
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../useStore';
import { buildMessageParts } from '../../components/chat/ChatPanel';

function last() {
  const msgs = useStore.getState().chatMessages;
  return msgs[msgs.length - 1];
}

describe('tool-call chronological ordering (store + parts)', () => {
  beforeEach(() => {
    useStore.setState({ chatMessages: [] });
    useStore.getState().addChatMessage({ role: 'assistant', content: '' });
  });

  it('stamps contentOffset from the current assistant text length', () => {
    useStore.getState().updateLastAssistantMessage('Let me check. ');
    useStore.getState().addToolCallToLastMessage({ name: 'query_elements', arguments: {} });
    const tc = last().toolCalls?.[0];
    expect(tc?.contentOffset).toBe('Let me check. '.length);
  });

  it('produces text → tool → text order end-to-end', () => {
    useStore.getState().updateLastAssistantMessage('Let me check. ');
    useStore.getState().addToolCallToLastMessage({ name: 'query_elements', arguments: {} });
    useStore.getState().updateLastAssistantMessage('Let me check. There are 12 walls.');

    const msg = last();
    const parts = buildMessageParts(msg.content, msg.toolCalls);
    expect(parts.map((p) => p.type)).toEqual(['text', 'tool', 'text']);
    expect((parts[0] as { text: string }).text).toBe('Let me check. ');
    expect((parts[1] as { toolCall: { name: string } }).toolCall.name).toBe('query_elements');
    expect((parts[2] as { text: string }).text).toBe('There are 12 walls.');
  });

  it('orders multiple tool calls between text runs', () => {
    const s = useStore.getState();
    s.updateLastAssistantMessage('First. ');
    s.addToolCallToLastMessage({ name: 'a', arguments: {} });
    s.updateLastAssistantMessage('First. Second. ');
    s.addToolCallToLastMessage({ name: 'b', arguments: {} });
    s.updateLastAssistantMessage('First. Second. Done.');

    const msg = last();
    const parts = buildMessageParts(msg.content, msg.toolCalls);
    expect(parts.map((p) => p.type)).toEqual(['text', 'tool', 'text', 'tool', 'text']);
    expect(msg.toolCalls?.map((t) => t.name)).toEqual(['a', 'b']);
  });

  it('a tool call before any text is stamped at offset 0 (renders first)', () => {
    useStore.getState().addToolCallToLastMessage({ name: 'lead', arguments: {} });
    expect(last().toolCalls?.[0].contentOffset).toBe(0);
    useStore.getState().updateLastAssistantMessage('answer after tool');
    const msg = last();
    const parts = buildMessageParts(msg.content, msg.toolCalls);
    expect(parts.map((p) => p.type)).toEqual(['tool', 'text']);
  });

  it('updateLastToolCallResult preserves contentOffset', () => {
    useStore.getState().updateLastAssistantMessage('abc');
    useStore.getState().addToolCallToLastMessage({ name: 't', arguments: {} });
    useStore.getState().updateLastToolCallResult('{"ok":true}', 'server');
    const tc = last().toolCalls?.[0];
    expect(tc?.contentOffset).toBe(3);
    expect(tc?.result).toBe('{"ok":true}');
    expect(tc?.executedOn).toBe('server');
  });
});
