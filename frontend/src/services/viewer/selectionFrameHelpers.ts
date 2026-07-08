/**
 * Selection-aware "frame" target resolution.
 *
 * Pure helper used by the `F` keyboard shortcut, the Menubar "Frame …" entry,
 * and the command palette. Mirrors the priority order already used by `H` and
 * `I` (hide / isolate) in `KeyboardShortcuts.tsx`:
 *
 *   1. A single-element selection wins outright.
 *   2. Otherwise fall back to the multi-element highlight set (`highlightedIds`)
 *      so a chat tool that highlighted N results can be framed in one keystroke.
 *   3. If neither is set, return `null` so the caller can fit the whole model.
 *
 * The function is intentionally tiny + dependency-free so it can be exercised
 * by vitest without spinning up the viewer.
 */

export type FrameTargets = number[] | null;

/**
 * Pick the elements that the camera should frame, given the current single-
 * select id and the multi-highlight list.
 *
 * Returns `null` when there is no target. Always returns a fresh array (never
 * the caller's `highlightedIds` reference) so downstream consumers can safely
 * sort / mutate without aliasing store state.
 *
 * Non-finite ids (NaN / Infinity) are dropped; duplicate ids in the highlight
 * list are deduplicated while preserving first-seen order. An empty result
 * after filtering is treated as "no target" (returns `null`).
 */
export function chooseFrameTargets(
  selectedId: number | null,
  highlightedIds: ReadonlyArray<number>,
): FrameTargets {
  if (selectedId != null && Number.isFinite(selectedId)) {
    return [selectedId];
  }

  if (highlightedIds.length === 0) return null;

  const seen = new Set<number>();
  const filtered: number[] = [];
  for (const id of highlightedIds) {
    if (!Number.isFinite(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    filtered.push(id);
  }

  return filtered.length > 0 ? filtered : null;
}
