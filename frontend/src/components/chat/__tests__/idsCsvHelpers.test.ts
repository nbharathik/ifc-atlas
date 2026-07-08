import { describe, it, expect } from 'vitest';
import {
  getIdsCsvButtonLabel,
  getIdsCsvButtonTitle,
  extractIdsFailedCount,
} from '../idsCsvHelpers';

// ── getIdsCsvButtonLabel ────────────────────────────────────────────────────

describe('getIdsCsvButtonLabel', () => {
  it('shows downloading spinner when downloading', () => {
    const label = getIdsCsvButtonLabel({ downloading: true, error: false, noModel: false, failedCount: 5 });
    expect(label).toContain('Downloading');
  });

  it('shows error text when error is true', () => {
    const label = getIdsCsvButtonLabel({ downloading: false, error: true, noModel: false, failedCount: undefined });
    expect(label).toContain('Download failed');
  });

  it('shows zero-failures label when failedCount is 0', () => {
    const label = getIdsCsvButtonLabel({ downloading: false, error: false, noModel: false, failedCount: 0 });
    expect(label).toContain('0 failures');
  });

  it('shows singular "failure" when failedCount is 1', () => {
    const label = getIdsCsvButtonLabel({ downloading: false, error: false, noModel: false, failedCount: 1 });
    expect(label).toContain('1 failure');
    expect(label).not.toContain('1 failures');
  });

  it('shows plural "failures" when failedCount is > 1', () => {
    const label = getIdsCsvButtonLabel({ downloading: false, error: false, noModel: false, failedCount: 7 });
    expect(label).toContain('7 failures');
  });

  it('falls back to generic label when failedCount is undefined', () => {
    const label = getIdsCsvButtonLabel({ downloading: false, error: false, noModel: false, failedCount: undefined });
    expect(label).toBe('📥 Download failures CSV');
  });

  it('shows generic label when noModel is true (button disabled)', () => {
    const label = getIdsCsvButtonLabel({ downloading: false, error: false, noModel: true, failedCount: 5 });
    expect(label).toBe('📥 Download failures CSV');
  });

  it('downloading takes priority over error', () => {
    const label = getIdsCsvButtonLabel({ downloading: true, error: true, noModel: false, failedCount: 3 });
    expect(label).toContain('Downloading');
  });

  it('downloading takes priority over noModel', () => {
    const label = getIdsCsvButtonLabel({ downloading: true, error: false, noModel: true, failedCount: undefined });
    expect(label).toContain('Downloading');
  });
});

// ── getIdsCsvButtonTitle ────────────────────────────────────────────────────

describe('getIdsCsvButtonTitle', () => {
  it('returns no-model message when noModel is true', () => {
    const title = getIdsCsvButtonTitle({ downloading: false, error: false, noModel: true, failedCount: undefined });
    expect(title).toContain('No IFC model');
  });

  it('returns error hint when error is true', () => {
    const title = getIdsCsvButtonTitle({ downloading: false, error: true, noModel: false, failedCount: undefined });
    expect(title).toContain('Download failed');
  });

  it('noModel takes priority over error', () => {
    const title = getIdsCsvButtonTitle({ downloading: false, error: true, noModel: true, failedCount: undefined });
    expect(title).toContain('No IFC model');
  });

  it('shows zero failures message when failedCount is 0', () => {
    const title = getIdsCsvButtonTitle({ downloading: false, error: false, noModel: false, failedCount: 0 });
    expect(title).toContain('no validation failures');
  });

  it('shows count in title for N > 0', () => {
    const title = getIdsCsvButtonTitle({ downloading: false, error: false, noModel: false, failedCount: 4 });
    expect(title).toContain('4 validation failure');
  });

  it('fallback title when failedCount is undefined', () => {
    const title = getIdsCsvButtonTitle({ downloading: false, error: false, noModel: false, failedCount: undefined });
    expect(title).toBe('Download validation failures as CSV');
  });
});

// ── extractIdsFailedCount ───────────────────────────────────────────────────

describe('extractIdsFailedCount', () => {
  it('returns the failed number from a report object', () => {
    expect(extractIdsFailedCount({ failed: 3, passed: 1 })).toBe(3);
  });

  it('returns 0 when failed is 0', () => {
    expect(extractIdsFailedCount({ failed: 0 })).toBe(0);
  });

  it('returns undefined when failed field is absent', () => {
    expect(extractIdsFailedCount({ passed: 2 })).toBeUndefined();
  });

  it('returns undefined when failed is not a number', () => {
    expect(extractIdsFailedCount({ failed: 'yes' })).toBeUndefined();
  });

  it('returns undefined for null input', () => {
    expect(extractIdsFailedCount(null)).toBeUndefined();
  });
});
