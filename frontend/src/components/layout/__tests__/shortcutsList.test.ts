import { describe, expect, it } from 'vitest';
import { SHORTCUTS } from '../shortcutsList';

describe('shortcutsList - SHORTCUTS reference table', () => {
  it('exposes a non-empty list of shortcut entries', () => {
    expect(SHORTCUTS.length).toBeGreaterThan(0);
  });

  it('every entry has key, label, description, category', () => {
    for (const entry of SHORTCUTS) {
      expect(entry.key).toBeTruthy();
      expect(entry.label).toBeTruthy();
      expect(entry.description).toBeTruthy();
      expect(entry.category).toBeTruthy();
    }
  });

  it('includes the Ctrl+Shift+C clipboard shortcut', () => {
    const entry = SHORTCUTS.find((s) => s.key === 'Ctrl+Shift+C');
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('Edit');
    expect(entry?.description).toMatch(/copy/i);
    expect(entry?.description).toMatch(/globalid/i);
  });

  it('includes the selection-history shortcuts', () => {
    const back = SHORTCUTS.find((s) => s.key === 'Alt+[');
    const fwd = SHORTCUTS.find((s) => s.key === 'Alt+]');
    expect(back).toBeDefined();
    expect(fwd).toBeDefined();
    expect(back?.category).toBe('Selection');
    expect(fwd?.category).toBe('Selection');
  });

  it('has no duplicate keys within the same category', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const entry of SHORTCUTS) {
      const composite = `${entry.category}::${entry.key}`;
      if (seen.has(composite)) dupes.push(composite);
      seen.add(composite);
    }
    expect(dupes).toEqual([]);
  });
});
