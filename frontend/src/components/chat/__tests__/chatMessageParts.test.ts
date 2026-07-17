import { describe, expect, it } from 'vitest';
import { buildMessageParts } from '../chatMessageParts';
import type { ToolCall } from '../../../types/ifc';

const tc = (name: string, contentOffset?: number): ToolCall => ({
  name, arguments: {}, contentOffset,
});

describe('buildMessageParts', () => {
  it('returns a single text part when there are no tool calls', () => {
    expect(buildMessageParts('hello world', [])).toEqual([
      { type: 'text', text: 'hello world', key: 't0' },
    ]);
  });

  it('returns nothing for empty content and no tools', () => {
    expect(buildMessageParts('', [])).toEqual([]);
    expect(buildMessageParts('', undefined)).toEqual([]);
  });

  it('interleaves text and tools in transcript order (the core fix)', () => {
    // "Let me check. " (14 chars) → tool → "There are 12 walls." (offset 14)
    const content = 'Let me check. There are 12 walls.';
    const parts = buildMessageParts(content, [tc('search_elements', 14)]);
    expect(parts.map((p) => p.type)).toEqual(['text', 'tool', 'text']);
    expect((parts[0] as { text: string }).text).toBe('Let me check. ');
    expect((parts[2] as { text: string }).text).toBe('There are 12 walls.');
  });

  it('handles multiple tools with text between each', () => {
    const content = 'AAABBBCCC';
    const parts = buildMessageParts(content, [tc('t1', 3), tc('t2', 6)]);
    expect(parts.map((p) => p.type)).toEqual(['text', 'tool', 'text', 'tool', 'text']);
    expect((parts[0] as { text: string }).text).toBe('AAA');
    expect((parts[2] as { text: string }).text).toBe('BBB');
    expect((parts[4] as { text: string }).text).toBe('CCC');
  });

  it('renders consecutive tool calls (same offset) with no empty text between', () => {
    const content = 'intro';
    const parts = buildMessageParts(content, [tc('t1', 5), tc('t2', 5)]);
    // text "intro", then two tools back-to-back, no empty text parts
    expect(parts.map((p) => p.type)).toEqual(['text', 'tool', 'tool']);
  });

  it('places a leading tool (offset 0) before the text', () => {
    const parts = buildMessageParts('the answer', [tc('t1', 0)]);
    expect(parts.map((p) => p.type)).toEqual(['tool', 'text']);
  });

  it('legacy messages without offsets fall back to tools-first, then text', () => {
    const parts = buildMessageParts('final text', [tc('t1'), tc('t2')]);
    expect(parts.map((p) => p.type)).toEqual(['tool', 'tool', 'text']);
    expect((parts[2] as { text: string }).text).toBe('final text');
  });

  it('clamps out-of-range / non-monotonic offsets safely', () => {
    const content = 'abc';
    // offsets beyond content length and a backwards one
    const parts = buildMessageParts(content, [tc('t1', 999), tc('t2', 1)]);
    // t1 clamps to 3 (end) → text "abc" then t1; t2 clamps to >= cursor(3) → after
    expect(parts[0]).toMatchObject({ type: 'text', text: 'abc' });
    expect(parts.filter((p) => p.type === 'tool')).toHaveLength(2);
    // total text never exceeds the original content
    const totalText = parts.filter((p) => p.type === 'text')
      .map((p) => (p as { text: string }).text).join('');
    expect(totalText).toBe('abc');
  });
});
