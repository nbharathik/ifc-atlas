/**
 * Chat top-bar overflow menu.
 *
 * The chat toolbar used to expose 6 icon-only buttons on the right edge:
 * Export Markdown, Export JSON, Clear, New Chat, Chat Manager.
 * Plus the conditional Stop button, the memory badge, and the Detach
 * button - eight to ten controls jammed into a 28-px-tall row.
 * Those six get folded into a
 * single `⋯` overflow menu.  Stop / memory badge / detach stay visible
 * since they are status-driven or layout-critical.
 *
 * This helper is the source of truth for the menu's *shape* - id, label,
 * icon, separator, and the conditional `disabled` flag.  ChatPanel
 * imports the list and renders it; the conditional disable comes from
 * whether the conversation has any messages.  Keeping the structure here
 * (pure, no React, no Zustand) lets the unit tests pin the menu order
 * + disabled-state semantics without spinning up a DOM.
 */
import type { IconName } from '../ui/Icon';

/**
 * One row in the `⋯` overflow menu.
 *
 * `id` is the contract the renderer uses to wire the click handler.
 * `disabled` is computed by `getTopBarOverflowActions(hasMessages)` so
 * the component never has to repeat the "no messages → disable export
 * and clear" rule.
 */
export interface ChatTopBarAction {
  id: 'export-md' | 'export-json' | 'clear' | 'new-chat' | 'chat-manager';
  label: string;
  /** Lucide icon name rendered to the left of the label. */
  icon: IconName;
  /** Tooltip / aria-label so the action is announceable. */
  hint: string;
  /** True → render as disabled, with a muted appearance and no click handler. */
  disabled: boolean;
  /** Show a thin divider after this row (groups history / utility / management). */
  separatorAfter?: boolean;
}

/**
 * Build the ordered list of overflow-menu rows.
 *
 * Order = history actions (Export MD / JSON / Clear) → fresh-chat (New
 * chat) → management surface (Chat Manager).  Separators
 * group those three bands.  Disabled state for the history group is
 * driven by the presence of any chat messages - there is nothing to
 * export or clear in an empty thread.
 */
export function getTopBarOverflowActions(hasMessages: boolean): ChatTopBarAction[] {
  return [
    {
      id: 'export-md',
      label: 'Export as Markdown',
      icon: 'file-text',
      hint: 'Download transcript as Markdown (.md)',
      disabled: !hasMessages,
    },
    {
      id: 'export-json',
      label: 'Export as JSON',
      icon: 'file',
      hint: 'Download transcript as JSON (.json)',
      disabled: !hasMessages,
    },
    {
      id: 'clear',
      label: 'Clear conversation',
      icon: 'trash',
      hint: 'Clear all messages but keep this thread',
      disabled: !hasMessages,
      separatorAfter: true,
    },
    {
      id: 'new-chat',
      label: 'New chat',
      icon: 'plus',
      hint: 'Start a fresh conversation thread',
      disabled: false,
      separatorAfter: true,
    },
    {
      id: 'chat-manager',
      label: 'Chat Manager',
      icon: 'cpu',
      hint: 'Agents · skills · tools · MCP · settings (Ctrl+Shift+M)',
      disabled: false,
    },
  ];
}

/** Return only the action ids - handy for tests that just want to pin the order. */
export function getTopBarOverflowActionIds(hasMessages: boolean): ChatTopBarAction['id'][] {
  return getTopBarOverflowActions(hasMessages).map((a) => a.id);
}

/** Return only the disabled-action ids - handy for tests pinning the
 *  empty-thread rule. */
export function getDisabledOverflowActionIds(hasMessages: boolean): ChatTopBarAction['id'][] {
  return getTopBarOverflowActions(hasMessages)
    .filter((a) => a.disabled)
    .map((a) => a.id);
}

/**
 * Keyboard-nav math - kept pure so it tests without a DOM.
 *
 * Given the current `activeIndex` (or `null` when nothing is focused yet) and
 * a direction, return the next index that points at an *enabled* row.
 * Wraps end-to-end so ArrowDown on the last enabled row jumps to the first.
 * Returns `null` only when every row is disabled (e.g. empty thread → all
 * three history rows disabled but Settings / Chat Manager / New chat stay
 * enabled, so `null` would only fire if the menu were *fully* empty).
 */
export function nextEnabledIndex(
  actions: ChatTopBarAction[],
  currentIndex: number | null,
  direction: 1 | -1,
): number | null {
  const n = actions.length;
  if (n === 0) return null;
  // Bail early if every row is disabled - no enabled target exists.
  if (actions.every((a) => a.disabled)) return null;
  // Seed from `currentIndex` (or -1 / n depending on direction so the first
  // step lands on index 0 / n-1 respectively).
  let i = currentIndex ?? (direction === 1 ? -1 : n);
  // Walk forward / back, wrapping, until we hit an enabled row.  Bounded by
  // n iterations because the above all-disabled guard ensures termination.
  for (let step = 0; step < n; step++) {
    i = (i + direction + n) % n;
    if (!actions[i].disabled) return i;
  }
  return null;
}

/**
 * Return the first enabled index (Home key + menu open).  `null` if every
 * row is disabled.
 */
export function firstEnabledIndex(actions: ChatTopBarAction[]): number | null {
  for (let i = 0; i < actions.length; i++) {
    if (!actions[i].disabled) return i;
  }
  return null;
}

/**
 * Return the last enabled index (End key).  `null` if every row is disabled.
 */
export function lastEnabledIndex(actions: ChatTopBarAction[]): number | null {
  for (let i = actions.length - 1; i >= 0; i--) {
    if (!actions[i].disabled) return i;
  }
  return null;
}

/** Keys this menu treats as navigation.  Anything else is passed through. */
export type OverflowNavKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';

/** Type-guard so the ChatPanel onKeyDown handler stays tidy. */
export function isOverflowNavKey(key: string): key is OverflowNavKey {
  return key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End';
}

/**
 * Single entry point for keyboard navigation - maps a key + current index
 * to the next enabled index.  Returns `null` when the key isn't a nav key
 * (caller should pass through) or every row is disabled.
 */
export function nextIndexForKey(
  actions: ChatTopBarAction[],
  currentIndex: number | null,
  key: string,
): number | null {
  switch (key) {
    case 'ArrowDown':
      return nextEnabledIndex(actions, currentIndex, 1);
    case 'ArrowUp':
      return nextEnabledIndex(actions, currentIndex, -1);
    case 'Home':
      return firstEnabledIndex(actions);
    case 'End':
      return lastEnabledIndex(actions);
    default:
      return null;
  }
}
