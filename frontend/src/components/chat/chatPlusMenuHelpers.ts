/**
 * Chat input "+" picker contract.
 *
 * The picker exposes 4 actions in 2 groups:
 *
 *   Upload group:    Upload PDF · Attach file
 *   Selection group: Mention selection · Paste properties
 *
 * The rendering in ChatPanel still does the JSX layout, but the **shape** + **order** +
 * **disabled rules** live here as a pure helper so the contract is
 * regression-proof and the menu can grow without re-deriving the rules
 * inline.
 */
import type { IconName } from '../ui/Icon';

export type ChatPlusItemId =
  | 'upload-pdf'
  | 'attach-file'
  | 'mention-selection'
  | 'paste-properties';

export type ChatPlusItemGroup = 'upload' | 'selection';

export interface ChatPlusItem {
  readonly id: ChatPlusItemId;
  readonly group: ChatPlusItemGroup;
  readonly label: string;
  readonly icon: IconName;
  readonly hint: string;
  /** True → render the row muted + skip the click handler. */
  readonly disabled: boolean;
  /** Render a divider AFTER this row to separate from the next group. */
  readonly separatorAfter?: boolean;
}

export interface ChatPlusMenuState {
  readonly hasSelectedElement: boolean;
  readonly hasSelectedElementWithDetails: boolean;
  /** Pre-formatted hint for "Mention selection" (e.g. "#142 IfcWall"). */
  readonly selectionMentionHint?: string;
  /** Pre-formatted hint for "Paste properties" (e.g. "3 property sets"). */
  readonly selectionPropertiesHint?: string;
}

/**
 * Build the ordered menu items + group separators for the current
 * picker state. Pure: deterministic given inputs, no React / DOM /
 * store touches.
 */
export function getPlusMenuItems(state: ChatPlusMenuState): ChatPlusItem[] {
  const mentionHint = state.hasSelectedElement
    ? state.selectionMentionHint || 'mention this element'
    : 'Select an element first';
  const propsHint = state.hasSelectedElementWithDetails
    ? state.selectionPropertiesHint || 'paste property sets'
    : 'Select an element first';

  return [
    {
      id: 'upload-pdf',
      group: 'upload',
      label: 'Upload PDF',
      icon: 'file-text',
      hint: 'Attach a PDF document to this message',
      disabled: false,
    },
    {
      id: 'attach-file',
      group: 'upload',
      label: 'Attach file',
      icon: 'clip',
      hint: 'Images, IDS, XML, text, CSV, JSON',
      disabled: false,
      separatorAfter: true,
    },
    {
      id: 'mention-selection',
      group: 'selection',
      label: 'Mention selection',
      icon: 'tag',
      hint: mentionHint,
      disabled: !state.hasSelectedElement,
    },
    {
      id: 'paste-properties',
      group: 'selection',
      label: 'Paste properties',
      icon: 'clipboard-list',
      hint: propsHint,
      disabled: !state.hasSelectedElementWithDetails,
    },
  ];
}

/** Order-only view - convenient for tests pinning the menu order. */
export function getPlusMenuItemIds(state: ChatPlusMenuState): ChatPlusItemId[] {
  return getPlusMenuItems(state).map((i) => i.id);
}

/** Indices of separators (after-row dividers) - for the JSX to render. */
export function getPlusMenuSeparatorIndices(state: ChatPlusMenuState): number[] {
  const items = getPlusMenuItems(state);
  const indices: number[] = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].separatorAfter) indices.push(i);
  }
  return indices;
}
