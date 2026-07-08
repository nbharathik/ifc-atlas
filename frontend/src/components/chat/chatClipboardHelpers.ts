/**
 * Pure helpers that turn a ToolCall into clipboard text. Used by the
 * "📋 Copy" affordance on every ToolCallDisplay row in ChatPanel.
 *
 * Why a dedicated helper: tool-call results are JSON-strings inside the
 * `ToolCall.result` field, but they can also be plain text (e.g. LLM-emitted
 * "no model loaded" errors before JSON-encoding wraps the path). The
 * formatter parses-when-it-can and falls back to a raw paste so users never
 * get a "[object Object]" or a double-escaped JSON blob in their clipboard.
 *
 * Kept pure (no DOM, no navigator.clipboard, no Zustand) so the format is
 * unit-testable and the component code stays a thin wrapper around
 * `navigator.clipboard.writeText(formatToolCallClipboard(tc))`.
 */
import type { ToolCall } from '../../types/ifc';

/** Try JSON.parse on a tool result; return the parsed value on success or
 *  the original raw string on failure. Used to fold a JSON-encoded result
 *  into the outer payload without double-escaping. */
export function tryParseToolResult(raw: string | undefined): unknown {
  if (raw == null || raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Format a single ToolCall as a pretty-printed JSON paste containing the
 *  tool name, the arguments dict, and the (parsed-when-possible) result.
 *  Includes `executedOn` only if it was set - keeps the paste tidy for the
 *  common server-only case. */
export function formatToolCallClipboard(tc: ToolCall): string {
  const payload: Record<string, unknown> = {
    tool: tc.name,
    arguments: tc.arguments ?? {},
    result: tryParseToolResult(tc.result),
  };
  if (tc.executedOn) {
    payload.executed_on = tc.executedOn;
  }
  return JSON.stringify(payload, null, 2);
}

/** Lightweight wrapper around navigator.clipboard.writeText that resolves
 *  to `true` on success, `false` on failure. Tests can mock `navigator`. */
export async function writeToClipboard(text: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    return false;
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
