import { describe, it, expect } from 'vitest';
import {
  getTopBarOverflowActions,
  getTopBarOverflowActionIds,
  getDisabledOverflowActionIds,
  nextEnabledIndex,
  firstEnabledIndex,
  lastEnabledIndex,
  isOverflowNavKey,
  nextIndexForKey,
  type ChatTopBarAction,
} from '../chatTopBarOverflowHelpers';

describe('getTopBarOverflowActions', () => {
  it('returns five rows in the documented order regardless of state', () => {
    const empty = getTopBarOverflowActionIds(false);
    const full = getTopBarOverflowActionIds(true);
    const expected: ChatTopBarAction['id'][] = [
      'export-md',
      'export-json',
      'clear',
      'new-chat',
      'chat-manager',
    ];
    expect(empty).toEqual(expected);
    expect(full).toEqual(expected);
  });

  it('disables export and clear when the thread has no messages', () => {
    expect(getDisabledOverflowActionIds(false)).toEqual([
      'export-md',
      'export-json',
      'clear',
    ]);
  });

  it('enables every row when the thread has messages', () => {
    expect(getDisabledOverflowActionIds(true)).toEqual([]);
  });

  it('places separators after clear and new-chat to group the three bands', () => {
    const rows = getTopBarOverflowActions(true);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get('clear')!.separatorAfter).toBe(true);
    expect(byId.get('new-chat')!.separatorAfter).toBe(true);
    // No other row defines separatorAfter - keeps the bands at exactly 3.
    const separators = rows.filter((r) => r.separatorAfter).map((r) => r.id);
    expect(separators).toEqual(['clear', 'new-chat']);
  });

  it('every row has a non-empty label, icon, and hint', () => {
    for (const row of getTopBarOverflowActions(true)) {
      expect(row.label.length).toBeGreaterThan(0);
      expect(row.icon.length).toBeGreaterThan(0);
      expect(row.hint.length).toBeGreaterThan(0);
    }
  });

  it('returns Lucide icons that match the legacy top-bar exactly', () => {
    // Pin the icons so a future refactor doesn't silently flip the menu
    // visual.  These are the same icons the legacy top-bar buttons used.
    const rows = getTopBarOverflowActions(true);
    expect(rows.find((r) => r.id === 'export-md')!.icon).toBe('file-text');
    expect(rows.find((r) => r.id === 'export-json')!.icon).toBe('file');
    expect(rows.find((r) => r.id === 'clear')!.icon).toBe('trash');
    expect(rows.find((r) => r.id === 'new-chat')!.icon).toBe('plus');
    expect(rows.find((r) => r.id === 'chat-manager')!.icon).toBe('cpu');
  });

  it('ids are unique - the renderer keys off id', () => {
    const rows = getTopBarOverflowActions(true);
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('mentions the Ctrl+Shift+M shortcut on the chat-manager hint', () => {
    // The legacy button's tooltip read "Chat Manager (Ctrl+Shift+M)";
    // surface it on the menu row hint too so the keybind discoverability
    // does not regress when the icon disappears behind the overflow.
    const cm = getTopBarOverflowActions(true).find((r) => r.id === 'chat-manager')!;
    expect(cm.hint).toContain('Ctrl+Shift+M');
  });

  it('returns fresh arrays on each call so callers can mutate locally', () => {
    const a = getTopBarOverflowActions(true);
    const b = getTopBarOverflowActions(true);
    expect(a).not.toBe(b);
    expect(a[0]).not.toBe(b[0]);
  });
});

describe('overflow menu keyboard navigation', () => {
  describe('nextEnabledIndex', () => {
    it('lands on index 0 from null when first row is enabled (hasMessages=true)', () => {
      const rows = getTopBarOverflowActions(true);
      expect(nextEnabledIndex(rows, null, 1)).toBe(0);
    });

    it('skips the three disabled history rows from null on empty thread', () => {
      // Empty thread → export-md / export-json / clear disabled (idx 0/1/2).
      // ArrowDown from null should land on `new-chat` (idx 3).
      const rows = getTopBarOverflowActions(false);
      expect(nextEnabledIndex(rows, null, 1)).toBe(3);
    });

    it('wraps end-to-start when stepping forward from the last enabled row', () => {
      const rows = getTopBarOverflowActions(true);
      // Index 4 (chat-manager) -> wrap to index 0 (export-md).
      expect(nextEnabledIndex(rows, 4, 1)).toBe(0);
    });

    it('wraps start-to-end when stepping back from the first enabled row', () => {
      const rows = getTopBarOverflowActions(true);
      expect(nextEnabledIndex(rows, 0, -1)).toBe(4);
    });

    it('skips disabled rows when stepping back on the empty thread', () => {
      // Empty thread, currentIndex=3 (new-chat) → ArrowUp should land on
      // the last enabled row (chat-manager, idx 4) by wrapping, skipping the
      // disabled history block.
      const rows = getTopBarOverflowActions(false);
      expect(nextEnabledIndex(rows, 3, -1)).toBe(4);
    });

    it('returns null when every row is disabled', () => {
      const allDisabled: ChatTopBarAction[] = getTopBarOverflowActions(true).map((r) => ({
        ...r,
        disabled: true,
      }));
      expect(nextEnabledIndex(allDisabled, null, 1)).toBeNull();
      expect(nextEnabledIndex(allDisabled, 0, 1)).toBeNull();
      expect(nextEnabledIndex(allDisabled, 2, -1)).toBeNull();
    });

    it('returns null on an empty action list', () => {
      expect(nextEnabledIndex([], null, 1)).toBeNull();
      expect(nextEnabledIndex([], null, -1)).toBeNull();
    });
  });

  describe('firstEnabledIndex / lastEnabledIndex', () => {
    it('first is 0 and last is 4 on a fully enabled thread', () => {
      const rows = getTopBarOverflowActions(true);
      expect(firstEnabledIndex(rows)).toBe(0);
      expect(lastEnabledIndex(rows)).toBe(4);
    });

    it('first is 3 (new-chat) on an empty thread, last is still 4 (chat-manager)', () => {
      const rows = getTopBarOverflowActions(false);
      expect(firstEnabledIndex(rows)).toBe(3);
      expect(lastEnabledIndex(rows)).toBe(4);
    });

    it('both return null when every row is disabled', () => {
      const allDisabled = getTopBarOverflowActions(true).map((r) => ({ ...r, disabled: true }));
      expect(firstEnabledIndex(allDisabled)).toBeNull();
      expect(lastEnabledIndex(allDisabled)).toBeNull();
    });
  });

  describe('isOverflowNavKey', () => {
    it('returns true for the four supported keys', () => {
      expect(isOverflowNavKey('ArrowDown')).toBe(true);
      expect(isOverflowNavKey('ArrowUp')).toBe(true);
      expect(isOverflowNavKey('Home')).toBe(true);
      expect(isOverflowNavKey('End')).toBe(true);
    });

    it('returns false for keys the menu does not consume', () => {
      // Enter / Space / Escape / Tab / printable keys all fall through to
      // the renderer (Enter triggers click on the focused row natively;
      // Escape closes the menu via the document handler).
      expect(isOverflowNavKey('Enter')).toBe(false);
      expect(isOverflowNavKey(' ')).toBe(false);
      expect(isOverflowNavKey('Escape')).toBe(false);
      expect(isOverflowNavKey('Tab')).toBe(false);
      expect(isOverflowNavKey('a')).toBe(false);
      expect(isOverflowNavKey('PageDown')).toBe(false);
    });
  });

  describe('nextIndexForKey', () => {
    it('ArrowDown advances + wraps', () => {
      const rows = getTopBarOverflowActions(true);
      expect(nextIndexForKey(rows, null, 'ArrowDown')).toBe(0);
      expect(nextIndexForKey(rows, 0, 'ArrowDown')).toBe(1);
      expect(nextIndexForKey(rows, 4, 'ArrowDown')).toBe(0);
    });

    it('ArrowUp retreats + wraps', () => {
      const rows = getTopBarOverflowActions(true);
      expect(nextIndexForKey(rows, null, 'ArrowUp')).toBe(4);
      expect(nextIndexForKey(rows, 0, 'ArrowUp')).toBe(4);
      expect(nextIndexForKey(rows, 3, 'ArrowUp')).toBe(2);
    });

    it('Home jumps to first enabled', () => {
      expect(nextIndexForKey(getTopBarOverflowActions(true), 4, 'Home')).toBe(0);
      // Empty thread → first enabled is new-chat at idx 3, not export-md.
      expect(nextIndexForKey(getTopBarOverflowActions(false), 4, 'Home')).toBe(3);
    });

    it('End jumps to last enabled', () => {
      expect(nextIndexForKey(getTopBarOverflowActions(true), 0, 'End')).toBe(4);
      expect(nextIndexForKey(getTopBarOverflowActions(false), 3, 'End')).toBe(4);
    });

    it('returns null for unknown keys so the caller can pass through', () => {
      const rows = getTopBarOverflowActions(true);
      expect(nextIndexForKey(rows, 0, 'Enter')).toBeNull();
      expect(nextIndexForKey(rows, 0, 'Escape')).toBeNull();
      expect(nextIndexForKey(rows, 0, ' ')).toBeNull();
      expect(nextIndexForKey(rows, 0, 'k')).toBeNull();
    });
  });
});
