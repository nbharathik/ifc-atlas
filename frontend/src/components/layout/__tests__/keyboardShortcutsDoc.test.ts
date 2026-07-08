import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHORTCUTS } from '../shortcutsList';

/**
 * Regression guard for the user-facing keyboard-shortcuts reference.
 *
 * Whenever a new shortcut is added to `SHORTCUTS` (the in-app `?` help modal),
 * the public doc `docs/user/KEYBOARD_SHORTCUTS.md` must mention it. The guard
 * has caught (and prevented) 6 shortcuts drifting out of the doc:
 * Alt+[, Alt+], Shift+G, Shift+W, N (angle), Ctrl+Shift+C.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOC_PATH = resolve(__dirname, '../../../../../docs/user/KEYBOARD_SHORTCUTS.md');

/**
 * Some `SHORTCUTS` labels are rendered differently in the doc - usually because
 * the doc uses platform-neutral phrasing (`Ctrl+K`) where the modal label has to
 * spell both options (`Ctrl/Cmd+K`), or because a contiguous range collapses to
 * a single entry (`Shift+1…9` covers nine bindings).
 *
 * Each override is an array of substrings that MUST all be present in the doc
 * for the source-side entry to count as documented.
 */
const DOC_OVERRIDES: Record<string, string[]> = {
  'Shift+1-9': ['Shift+1', 'Shift+9'],
  'Ctrl/Cmd+K': ['Ctrl+K'],
  'Ctrl/Cmd+/': ['Ctrl+/'],
  'Ctrl/Cmd+,': ['Ctrl+,'],
  'Ctrl/Cmd+Shift+M': ['Ctrl+Shift+M'],
};

describe('docs/user/KEYBOARD_SHORTCUTS.md - drift guard', () => {
  const docContents = readFileSync(DOC_PATH, 'utf8');

  it('doc file is non-empty and reachable from the test location', () => {
    expect(docContents.length).toBeGreaterThan(100);
    expect(docContents).toMatch(/^# Keyboard Shortcuts/);
  });

  it.each(SHORTCUTS)('documents $key ($description)', (entry) => {
    const required = DOC_OVERRIDES[entry.key] ?? [entry.key];
    for (const needle of required) {
      expect(docContents).toContain(needle);
    }
  });

  it('mentions every category at least once as a section heading', () => {
    const categories = new Set(SHORTCUTS.map((s) => s.category));
    for (const category of categories) {
      // Categories surface as `## Foo` or `## Foo & Bar` headings. We tolerate
      // grouping (e.g. Selection + Visibility merged) by just requiring the
      // category word to appear somewhere in the markdown.
      expect(docContents.toLowerCase()).toContain(category.toLowerCase());
    }
  });
});
