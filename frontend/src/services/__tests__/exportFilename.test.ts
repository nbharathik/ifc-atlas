import { describe, it, expect } from 'vitest';
import { exportFilename } from '../exportFilename';

describe('exportFilename', () => {
  const fixedNow = new Date('2026-05-16T17:42:09.123Z');

  it('embeds an ISO-derived timestamp with colons and dots replaced', () => {
    const name = exportFilename('measurements', 'csv', fixedNow);
    expect(name).toBe('measurements-2026-05-16T17-42-09.csv');
  });

  it('produces a 19-char timestamp (YYYY-MM-DDTHH-MM-SS) regardless of millis', () => {
    const name = exportFilename('ids-failures', 'csv', fixedNow);
    const tsPart = name.replace(/^ids-failures-/, '').replace(/\.csv$/, '');
    expect(tsPart).toHaveLength(19);
    expect(tsPart).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
  });

  it('omits sub-second precision so filenames remain readable', () => {
    const name = exportFilename('codex-run', 'md', fixedNow);
    expect(name).not.toContain('123'); // millis
    // The only `.` should be the extension separator
    const dotMatches = name.match(/\./g) ?? [];
    expect(dotMatches).toHaveLength(1);
    expect(name.endsWith('.md')).toBe(true);
  });

  it('strips trailing hyphens from the prefix so callers can safely concatenate', () => {
    const name = exportFilename('selection-3-', 'csv', fixedNow);
    expect(name).toBe('selection-3-2026-05-16T17-42-09.csv');
  });

  it('strips leading dots from the extension so callers can pass `.md` or `md`', () => {
    const withDot = exportFilename('codex-run', '.md', fixedNow);
    const withoutDot = exportFilename('codex-run', 'md', fixedNow);
    expect(withDot).toBe(withoutDot);
  });

  it('strips multiple leading dots from the extension', () => {
    expect(exportFilename('x', '..json', fixedNow)).toBe('x-2026-05-16T17-42-09.json');
  });

  it('uses the current Date when called with no `now` argument', () => {
    const name = exportFilename('measurements', 'csv');
    // Loose regex - we can't pin the exact second, only the shape.
    expect(name).toMatch(/^measurements-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.csv$/);
  });

  it('produces a different timestamp for two distinct dates', () => {
    const a = exportFilename('export', 'csv', new Date('2026-01-01T00:00:00Z'));
    const b = exportFilename('export', 'csv', new Date('2026-12-31T23:59:59Z'));
    expect(a).not.toBe(b);
  });

  it('roundtrips simple alphanumeric prefixes unchanged', () => {
    const name = exportFilename('snap', 'png', fixedNow);
    expect(name.startsWith('snap-')).toBe(true);
    expect(name.endsWith('.png')).toBe(true);
  });
});
