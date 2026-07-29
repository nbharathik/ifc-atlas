import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToolCall } from '../../../types/ifc';
import {
  formatToolCallClipboard,
  tryParseToolResult,
  writeToClipboard,
} from '../ChatPanel';

// ── tryParseToolResult ───────────────────────────────────────────────────────

describe('tryParseToolResult', () => {
  it('returns null for undefined', () => {
    expect(tryParseToolResult(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(tryParseToolResult('')).toBeNull();
  });

  it('parses valid JSON object', () => {
    expect(tryParseToolResult('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses valid JSON array', () => {
    expect(tryParseToolResult('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('parses JSON scalars (number, bool, null)', () => {
    expect(tryParseToolResult('42')).toBe(42);
    expect(tryParseToolResult('true')).toBe(true);
    expect(tryParseToolResult('null')).toBeNull();
  });

  it('falls back to raw string on parse failure', () => {
    expect(tryParseToolResult('not json {{')).toBe('not json {{');
  });

  it('returns the raw string for non-JSON multi-line text', () => {
    expect(tryParseToolResult('line1\nline2')).toBe('line1\nline2');
  });
});

// ── formatToolCallClipboard ─────────────────────────────────────────────────

describe('formatToolCallClipboard', () => {
  const baseCall: ToolCall = {
    name: 'viewer_control',
    arguments: { action: 'highlight', element_ids: [12, 34] },
    result: '{"highlighted":2}',
  };

  it('produces pretty-printed JSON with tool/arguments/result keys', () => {
    const out = formatToolCallClipboard(baseCall);
    const parsed = JSON.parse(out);
    expect(parsed).toEqual({
      tool: 'viewer_control',
      arguments: { action: 'highlight', element_ids: [12, 34] },
      result: { highlighted: 2 },
    });
    expect(out).toContain('\n');
  });

  it('includes executed_on only when set', () => {
    const withSource: ToolCall = { ...baseCall, executedOn: 'server' };
    const parsedWith = JSON.parse(formatToolCallClipboard(withSource));
    expect(parsedWith.executed_on).toBe('server');

    const parsedWithout = JSON.parse(formatToolCallClipboard(baseCall));
    expect('executed_on' in parsedWithout).toBe(false);
  });

  it('handles a tool call without a result (in-flight)', () => {
    const inflight: ToolCall = { name: 'describe_model', arguments: { part: 'storeys' } };
    const parsed = JSON.parse(formatToolCallClipboard(inflight));
    expect(parsed.result).toBeNull();
  });

  it('falls back to raw string when result is not JSON', () => {
    const tc: ToolCall = {
      name: 'execute_ifc_code',
      arguments: { code: 'print(1)' },
      result: 'Traceback: NameError',
    };
    const parsed = JSON.parse(formatToolCallClipboard(tc));
    expect(parsed.result).toBe('Traceback: NameError');
  });

  it('preserves empty arguments dict', () => {
    const tc: ToolCall = { name: 'get_edit_history', arguments: {} };
    const parsed = JSON.parse(formatToolCallClipboard(tc));
    expect(parsed.arguments).toEqual({});
  });

  it('handles nested argument objects', () => {
    const tc: ToolCall = {
      name: 'query_elements',
      arguments: { mode: 'property', filter: { pset: 'Pset_WallCommon', name: 'IsExternal', value: true } },
    };
    const parsed = JSON.parse(formatToolCallClipboard(tc));
    expect(parsed.arguments.filter.pset).toBe('Pset_WallCommon');
  });

  it('coerces missing arguments to empty object', () => {
    // arguments is required by the type, but a runtime-corrupt blob shouldn't crash
    const tc = { name: 'broken', arguments: undefined } as unknown as ToolCall;
    const parsed = JSON.parse(formatToolCallClipboard(tc));
    expect(parsed.arguments).toEqual({});
  });
});

// ── writeToClipboard ────────────────────────────────────────────────────────

describe('writeToClipboard', () => {
  const originalNavigator = globalThis.navigator;

  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNavigator,
      configurable: true,
      writable: true,
    });
  });

  beforeEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      value: undefined,
      configurable: true,
      writable: true,
    });
  });

  it('returns false when navigator is undefined (SSR / node env)', async () => {
    expect(await writeToClipboard('x')).toBe(false);
  });

  it('returns false when navigator.clipboard is unavailable', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { /* no clipboard */ },
      configurable: true,
      writable: true,
    });
    expect(await writeToClipboard('x')).toBe(false);
  });

  it('returns true when writeText resolves', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText } },
      configurable: true,
      writable: true,
    });
    expect(await writeToClipboard('hello')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('returns false when writeText rejects (permission denied)', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText } },
      configurable: true,
      writable: true,
    });
    expect(await writeToClipboard('hello')).toBe(false);
  });

  it('returns false when writeText is not a function', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText: 'not-a-fn' } },
      configurable: true,
      writable: true,
    });
    expect(await writeToClipboard('hello')).toBe(false);
  });
});
