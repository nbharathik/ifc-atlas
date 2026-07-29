/**
 * Selection-history navigation.
 *
 * Pure reducers + read-helpers for a browser-style back/forward stack of the
 * single-element selection (`selectedElementId`). Lives outside the store so
 * the math is independently unit-testable and the slice stays a thin wrapper.
 *
 * State shape:
 *   - `stack`: ordered list of express IDs the user has selected.
 *   - `pointer`: index into `stack` of the *currently active* selection.
 *     `-1` means "empty history" (no selection has been pushed yet).
 *
 * Semantics:
 *   - `pushSelection(state, id)` - a new selection trims any forward history
 *     past `pointer` (mirrors a browser address bar), then appends `id` and
 *     advances the pointer. No-op if `id === stack[pointer]` so re-clicking
 *     the active element doesn't bloat the stack.
 *   - `goBack(state)` / `goForward(state)` - move the pointer one step,
 *     clamped. Caller reads `currentId(next)` to decide which element to
 *     re-select in the viewer.
 *
 * The stack is bounded by `MAX_HISTORY` (default 20) so a long session of
 * clicking doesn't grow the array indefinitely.
 */

export interface SelectionHistoryState {
  stack: number[];
  pointer: number;
}

export const MAX_HISTORY = 20;

export const EMPTY_HISTORY: SelectionHistoryState = Object.freeze({
  stack: [] as number[],
  pointer: -1,
}) as SelectionHistoryState;

/** Returns the express ID currently pointed at, or `null` if the stack is empty. */
export function currentId(state: SelectionHistoryState): number | null {
  if (state.pointer < 0 || state.pointer >= state.stack.length) return null;
  return state.stack[state.pointer];
}

export function canGoBack(state: SelectionHistoryState): boolean {
  return state.pointer > 0;
}

export function canGoForward(state: SelectionHistoryState): boolean {
  return state.pointer >= 0 && state.pointer < state.stack.length - 1;
}

/**
 * Append `id` to the history. If the pointer is not at the tail, the
 * forward portion of the stack is discarded first (browser-like). When the
 * stack would exceed `maxSize`, the oldest entry is dropped and the pointer
 * shifts left to compensate.
 *
 * Re-pushing the currently-active id is a no-op so the back/forward
 * navigation can call this without growing the stack.
 */
export function pushSelection(
  state: SelectionHistoryState,
  id: number,
  maxSize: number = MAX_HISTORY,
): SelectionHistoryState {
  if (!Number.isFinite(id)) return state;
  if (state.pointer >= 0 && state.stack[state.pointer] === id) {
    return state;
  }

  // Discard any forward history so the new push becomes the new tail.
  const trimmed = state.stack.slice(0, state.pointer + 1);
  trimmed.push(id);

  // Cap stack length; oldest entries fall off the front.
  let next = trimmed;
  if (next.length > maxSize) {
    next = next.slice(next.length - maxSize);
  }

  return { stack: next, pointer: next.length - 1 };
}

export function goBack(state: SelectionHistoryState): SelectionHistoryState {
  if (!canGoBack(state)) return state;
  return { stack: state.stack, pointer: state.pointer - 1 };
}

export function goForward(state: SelectionHistoryState): SelectionHistoryState {
  if (!canGoForward(state)) return state;
  return { stack: state.stack, pointer: state.pointer + 1 };
}

/** Reset to empty - used when a new model is loaded. */
export function resetHistory(): SelectionHistoryState {
  return { stack: [], pointer: -1 };
}
