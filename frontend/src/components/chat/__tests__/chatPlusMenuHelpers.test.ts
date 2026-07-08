/**
 * chatPlusMenuHelpers contract.
 *
 * Pins the order, group structure, disabled rules, and separator
 * positions of the chat-input "+" picker. ChatPanel renders the list
 * declaratively from these helpers; if a future refactor wants to
 * re-order or rename items it must update this test first.
 */
import { describe, it, expect } from 'vitest';
import {
  getPlusMenuItems,
  getPlusMenuItemIds,
  getPlusMenuSeparatorIndices,
  type ChatPlusMenuState,
} from '../chatPlusMenuHelpers';

const BASELINE_STATE: ChatPlusMenuState = {
  hasSelectedElement: false,
  hasSelectedElementWithDetails: false,
};

describe('getPlusMenuItems', () => {
  it('returns the 4 picker items in the canonical order', () => {
    expect(getPlusMenuItemIds(BASELINE_STATE)).toEqual([
      'upload-pdf',
      'attach-file',
      'mention-selection',
      'paste-properties',
    ]);
  });

  it('assigns each item to one of the 2 groups', () => {
    const items = getPlusMenuItems(BASELINE_STATE);
    expect(items.find((i) => i.id === 'upload-pdf')?.group).toBe('upload');
    expect(items.find((i) => i.id === 'attach-file')?.group).toBe('upload');
    expect(items.find((i) => i.id === 'mention-selection')?.group).toBe('selection');
    expect(items.find((i) => i.id === 'paste-properties')?.group).toBe('selection');
  });

  it('disables mention + paste when no element is selected', () => {
    const items = getPlusMenuItems(BASELINE_STATE);
    expect(items.find((i) => i.id === 'mention-selection')!.disabled).toBe(true);
    expect(items.find((i) => i.id === 'paste-properties')!.disabled).toBe(true);
  });

  it('enables mention when an element is selected, even without details', () => {
    const items = getPlusMenuItems({
      ...BASELINE_STATE,
      hasSelectedElement: true,
      hasSelectedElementWithDetails: false,
    });
    expect(items.find((i) => i.id === 'mention-selection')!.disabled).toBe(false);
    // Paste still needs full details (property sets to format).
    expect(items.find((i) => i.id === 'paste-properties')!.disabled).toBe(true);
  });

  it('enables paste-properties only when details are loaded', () => {
    const items = getPlusMenuItems({
      ...BASELINE_STATE,
      hasSelectedElement: true,
      hasSelectedElementWithDetails: true,
    });
    expect(items.find((i) => i.id === 'paste-properties')!.disabled).toBe(false);
  });

  it('upload rows are never disabled by selection state', () => {
    for (const flag of [true, false]) {
      const items = getPlusMenuItems({
        ...BASELINE_STATE,
        hasSelectedElement: flag,
        hasSelectedElementWithDetails: flag,
      });
      expect(items.find((i) => i.id === 'upload-pdf')!.disabled).toBe(false);
      expect(items.find((i) => i.id === 'attach-file')!.disabled).toBe(false);
    }
  });

  it('uses the pre-formatted hint for mention when provided', () => {
    const items = getPlusMenuItems({
      ...BASELINE_STATE,
      hasSelectedElement: true,
      selectionMentionHint: '#142 Front Door',
    });
    expect(items.find((i) => i.id === 'mention-selection')!.hint).toBe('#142 Front Door');
  });

  it('falls back to "Select an element first" when nothing is selected', () => {
    const items = getPlusMenuItems(BASELINE_STATE);
    expect(items.find((i) => i.id === 'mention-selection')!.hint).toBe(
      'Select an element first',
    );
    expect(items.find((i) => i.id === 'paste-properties')!.hint).toBe(
      'Select an element first',
    );
  });
});

describe('getPlusMenuSeparatorIndices', () => {
  it('places a separator after the upload group', () => {
    // attach-file is at index 1 → separator after upload group
    // selection group has no trailing separator (it's the last group)
    expect(getPlusMenuSeparatorIndices(BASELINE_STATE)).toEqual([1]);
  });

  it('separator positions are stable regardless of disabled state', () => {
    // Disabled rows still occupy the same index - the separator layout
    // is structural, not state-dependent.
    const a = getPlusMenuSeparatorIndices(BASELINE_STATE);
    const b = getPlusMenuSeparatorIndices({
      ...BASELINE_STATE,
      hasSelectedElement: true,
      hasSelectedElementWithDetails: true,
    });
    expect(a).toEqual(b);
  });
});
