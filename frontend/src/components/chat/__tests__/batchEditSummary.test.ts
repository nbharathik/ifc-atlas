/**
 * Pure logic tests for batch-edit result parsing used by ToolCallDisplay /
 * BatchEditSummary.  We test the derived values (badges, icon choice) without
 * mounting a React component - consistent with the rest of the test suite.
 */

import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers - mirror the logic inside BatchEditSummary
// ---------------------------------------------------------------------------

interface BatchResult {
  action?: string;
  changed_count?: unknown;
  skipped_count?: unknown;
  failed_count?: unknown;
  edit_id?: string;
}

function parseBatchSummary(result: BatchResult): string[] {
  const changed = typeof result.changed_count === 'number' ? result.changed_count : null;
  const skipped = typeof result.skipped_count === 'number' ? result.skipped_count : null;
  const failed  = typeof result.failed_count  === 'number' ? result.failed_count  : null;

  if (changed === null) return [];

  const parts: string[] = [];
  if (changed > 0)  parts.push(`${changed} changed`);
  if (skipped !== null && skipped > 0) parts.push(`${skipped} skipped`);
  if (failed  !== null && failed  > 0) parts.push(`${failed} failed`);
  if (parts.length === 0) parts.push('no changes');
  return parts;
}

function isBatchEdit(result: BatchResult | null): boolean {
  return result?.action === 'metadata_changed' && typeof result?.changed_count === 'number';
}

// ---------------------------------------------------------------------------
// parseBatchSummary
// ---------------------------------------------------------------------------

describe('parseBatchSummary', () => {
  it('returns ["N changed"] when only changed_count is nonzero', () => {
    const parts = parseBatchSummary({ changed_count: 3, skipped_count: 0, failed_count: 0 });
    expect(parts).toEqual(['3 changed']);
  });

  it('includes skipped when > 0', () => {
    const parts = parseBatchSummary({ changed_count: 2, skipped_count: 1, failed_count: 0 });
    expect(parts).toContain('1 skipped');
    expect(parts).toContain('2 changed');
  });

  it('includes failed when > 0', () => {
    const parts = parseBatchSummary({ changed_count: 0, skipped_count: 0, failed_count: 2 });
    expect(parts).toContain('2 failed');
  });

  it('returns ["no changes"] when all counts are zero', () => {
    const parts = parseBatchSummary({ changed_count: 0, skipped_count: 0, failed_count: 0 });
    expect(parts).toEqual(['no changes']);
  });

  it('returns empty array when changed_count is not a number', () => {
    expect(parseBatchSummary({ changed_count: 'oops' })).toEqual([]);
    expect(parseBatchSummary({})).toEqual([]);
  });

  it('omits skipped/failed lines when they are 0', () => {
    const parts = parseBatchSummary({ changed_count: 5, skipped_count: 0, failed_count: 0 });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toBe('5 changed');
  });

  it('handles partial result missing skipped/failed keys', () => {
    const parts = parseBatchSummary({ changed_count: 4 });
    expect(parts).toEqual(['4 changed']);
  });

  it('full mixed batch', () => {
    const parts = parseBatchSummary({ changed_count: 3, skipped_count: 1, failed_count: 2 });
    expect(parts).toContain('3 changed');
    expect(parts).toContain('1 skipped');
    expect(parts).toContain('2 failed');
    expect(parts).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// isBatchEdit gate - determines whether BatchEditSummary renders at all
// ---------------------------------------------------------------------------

describe('isBatchEdit', () => {
  it('true for metadata_changed with numeric changed_count', () => {
    expect(isBatchEdit({ action: 'metadata_changed', changed_count: 2 })).toBe(true);
  });

  it('false for pending_edit action', () => {
    expect(isBatchEdit({ action: 'pending_edit', changed_count: 1 })).toBe(false);
  });

  it('false when changed_count is missing', () => {
    expect(isBatchEdit({ action: 'metadata_changed' })).toBe(false);
  });

  it('false when result is null', () => {
    expect(isBatchEdit(null)).toBe(false);
  });

  it('false for non-batch metadata_changed (e.g. single rename without count)', () => {
    expect(isBatchEdit({ action: 'metadata_changed', changed_count: undefined })).toBe(false);
  });

  it('true even when changed_count is 0 (all no-ops)', () => {
    expect(isBatchEdit({ action: 'metadata_changed', changed_count: 0 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Badge class assignment logic
// ---------------------------------------------------------------------------

describe('badge class derivation', () => {
  function badgeClass(part: string): string {
    if (part.includes('failed'))  return 'batch-badge--fail';
    if (part.includes('skipped')) return 'batch-badge--skip';
    return 'batch-badge--ok';
  }

  it('ok for "N changed"', () => {
    expect(badgeClass('3 changed')).toBe('batch-badge--ok');
  });

  it('skip for "N skipped"', () => {
    expect(badgeClass('1 skipped')).toBe('batch-badge--skip');
  });

  it('fail for "N failed"', () => {
    expect(badgeClass('2 failed')).toBe('batch-badge--fail');
  });

  it('ok for "no changes"', () => {
    expect(badgeClass('no changes')).toBe('batch-badge--ok');
  });
});
