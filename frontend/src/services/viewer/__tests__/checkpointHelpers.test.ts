import { describe, it, expect } from 'vitest';
import { formatCheckpointTs, shortSha, restoreButtonTitle } from '../checkpointHelpers';

describe('formatCheckpointTs', () => {
  it('formats a valid ISO string to locale string', () => {
    const result = formatCheckpointTs('2026-05-08T10:30:00.000Z');
    // Should contain a colon (time separator) - exact format is locale-dependent.
    expect(result).toContain(':');
    expect(result.length).toBeGreaterThan(4);
  });

  it('returns the original string when input is invalid', () => {
    expect(formatCheckpointTs('not-a-date')).toBe('not-a-date');
  });

  it('returns the original string on empty input', () => {
    expect(formatCheckpointTs('')).toBe('');
  });

  it('handles a UTC midnight timestamp without throwing', () => {
    const result = formatCheckpointTs('2026-01-01T00:00:00Z');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('handles a timestamp without timezone without throwing', () => {
    const result = formatCheckpointTs('2026-05-08T14:22:00');
    expect(typeof result).toBe('string');
  });
});

describe('shortSha', () => {
  it('returns at most 12 characters', () => {
    expect(shortSha('abcdef1234567890extra')).toBe('abcdef123456');
  });

  it('returns the full string when already ≤12 chars', () => {
    expect(shortSha('abc123')).toBe('abc123');
  });

  it('handles empty string', () => {
    expect(shortSha('')).toBe('');
  });

  it('returns exactly 12 chars for a full 40-char SHA', () => {
    const fullSha = 'a'.repeat(40);
    expect(shortSha(fullSha)).toHaveLength(12);
  });
});

describe('restoreButtonTitle', () => {
  it('includes the sha and message in the title', () => {
    const title = restoreButtonTitle('abc123456789', 'Edit #3');
    expect(title).toContain('abc123456789');
    expect(title).toContain('Edit #3');
  });

  it('handles empty message gracefully', () => {
    const title = restoreButtonTitle('abc123456789', '');
    expect(title).toContain('abc123456789');
    expect(typeof title).toBe('string');
  });
});
