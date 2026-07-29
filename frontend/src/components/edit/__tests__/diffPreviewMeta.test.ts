/**
 * Vitest coverage for the ``DiffPreviewPanel`` helpers extracted during
 * the 2026-04-23 A2 finish of the ``execute_ifc_code`` feature.
 *
 * The panel's job is tiny but load-bearing: if the badge silently
 * stops rendering, the user loses the only visual signal that an edit
 * came from arbitrary LLM Python (vs a safe structured op). A unit test
 * on the decision helper keeps that regression-proof.
 */

import { describe, expect, it } from 'vitest';

import {
  formatCountBadge,
  getExecuteIfcCodeMeta,
} from '../DiffPreviewPanel';
import type { PendingEditEnvelope } from '../../../types/ifc';

function makeEnvelope(
  operations: Record<string, unknown>[],
): PendingEditEnvelope {
  return {
    edit_id: 'e1',
    created_at: 1700000000,
    base_model_version: 1,
    base_model_fingerprint: 'fp-base',
    sandbox_fingerprint: 'fp-sandbox',
    summary: 'test',
    operations,
    changes: [],
    counts: { total: 0 },
  };
}

describe('getExecuteIfcCodeMeta', () => {
  it('returns null for a null/undefined envelope', () => {
    expect(getExecuteIfcCodeMeta(null)).toBeNull();
    expect(getExecuteIfcCodeMeta(undefined)).toBeNull();
  });

  it('returns null for an envelope with no operations', () => {
    expect(getExecuteIfcCodeMeta(makeEnvelope([]))).toBeNull();
  });

  it('returns null for a structured edit_semantic envelope (set_name)', () => {
    const env = makeEnvelope([
      { op: 'set_name', element_id: 361, new_name: 'New Name' },
    ]);
    expect(getExecuteIfcCodeMeta(env)).toBeNull();
  });

  it('returns metadata for an execute_ifc_code envelope', () => {
    const env = makeEnvelope([
      { op: 'execute_ifc_code', code_chars: 420, elapsed_ms: 1234 },
    ]);
    expect(getExecuteIfcCodeMeta(env)).toEqual({
      elapsedMs: 1234,
      codeChars: 420,
    });
  });

  it('tolerates a missing elapsed_ms (very short script) and still enables the badge', () => {
    const env = makeEnvelope([{ op: 'execute_ifc_code', code_chars: 30 }]);
    // Non-null result means the badge would render; elapsedMs null hides
    // the "sandbox ran in Nms" suffix but the badge itself still shows.
    expect(getExecuteIfcCodeMeta(env)).toEqual({
      elapsedMs: null,
      codeChars: 30,
    });
  });

  it('tolerates a missing code_chars', () => {
    const env = makeEnvelope([{ op: 'execute_ifc_code', elapsed_ms: 200 }]);
    expect(getExecuteIfcCodeMeta(env)).toEqual({
      elapsedMs: 200,
      codeChars: null,
    });
  });

  it('rejects non-numeric / negative / NaN values as missing', () => {
    const env = makeEnvelope([
      {
        op: 'execute_ifc_code',
        elapsed_ms: 'very fast',
        code_chars: -5,
      },
    ]);
    // Guard against a future backend bug spraying bad types into the
    // envelope - the panel must never render "−5 chars of Python".
    expect(getExecuteIfcCodeMeta(env)).toEqual({
      elapsedMs: null,
      codeChars: null,
    });

    const env2 = makeEnvelope([
      { op: 'execute_ifc_code', elapsed_ms: Number.NaN },
    ]);
    expect(getExecuteIfcCodeMeta(env2)?.elapsedMs).toBeNull();
  });

  it('rounds fractional numbers - e.g. elapsed_ms=123.7 → 124', () => {
    const env = makeEnvelope([
      { op: 'execute_ifc_code', elapsed_ms: 123.7, code_chars: 10.2 },
    ]);
    const meta = getExecuteIfcCodeMeta(env);
    expect(meta?.elapsedMs).toBe(124);
    expect(meta?.codeChars).toBe(10);
  });

  it('only inspects the first op (envelope invariant)', () => {
    // The sandbox synthesises exactly one pseudo-op for execute_ifc_code.
    // If a future bug stuffs a second op in, we still key off [0].
    const env = makeEnvelope([
      { op: 'set_name', element_id: 1, new_name: 'x' },
      { op: 'execute_ifc_code', elapsed_ms: 5 },
    ]);
    expect(getExecuteIfcCodeMeta(env)).toBeNull();
  });
});

describe('formatCountBadge', () => {
  it('returns an empty string for zero or negative counts', () => {
    expect(formatCountBadge('renamed', 0)).toBe('');
    expect(formatCountBadge('property_changed', -1)).toBe('');
  });

  it('formats single-word labels verbatim', () => {
    expect(formatCountBadge('renamed', 3)).toBe('3 renamed');
    expect(formatCountBadge('deleted', 1)).toBe('1 deleted');
  });

  it('expands snake_case labels to spaces', () => {
    expect(formatCountBadge('property_changed', 500)).toBe(
      '500 property changed',
    );
  });
});
