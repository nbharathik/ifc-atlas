import type { ToolCall } from '../../types/ifc';

/**
 * One renderable piece of an assistant message, in transcript order.
 *
 * An assistant turn interleaves text and tool calls (text → tool → text → …).
 * The store keeps the full text in `content` and the tool calls in `toolCalls`,
 * each tagged with a `contentOffset` = the number of assistant-text characters
 * emitted BEFORE that tool call. This helper reconstructs the true chronological
 * order from those two fields so the UI renders text and tools where they
 * actually happened, instead of dumping every tool call at the top.
 */
export type MessagePart =
  | { type: 'text'; text: string; key: string }
  | { type: 'tool'; toolCall: ToolCall; key: string };

/**
 * Build the ordered parts for an assistant message.
 *
 * Legacy safety: messages restored from history (or produced before offsets
 * existed) have tool calls with no `contentOffset`. The clamp below then
 * naturally reproduces the old "all tools, then the text" layout, so nothing
 * regresses for those.
 */
export function buildMessageParts(content: string, toolCalls?: ToolCall[]): MessagePart[] {
  const calls = toolCalls ?? [];
  if (calls.length === 0) {
    return content ? [{ type: 'text', text: content, key: 't0' }] : [];
  }

  const parts: MessagePart[] = [];
  let cursor = 0;
  calls.forEach((call, i) => {
    // Offset is monotonic (content is append-only) and never before the cursor;
    // an absent offset pins the tool at the cursor (→ legacy top-stacking).
    const raw = typeof call.contentOffset === 'number' ? call.contentOffset : cursor;
    const offset = Math.max(cursor, Math.min(content.length, raw));
    const textSlice = content.slice(cursor, offset);
    if (textSlice) parts.push({ type: 'text', text: textSlice, key: `t${i}` });
    parts.push({ type: 'tool', toolCall: call, key: `c${i}` });
    cursor = offset;
  });

  const tail = content.slice(cursor);
  if (tail) parts.push({ type: 'text', text: tail, key: 'tail' });
  return parts;
}
