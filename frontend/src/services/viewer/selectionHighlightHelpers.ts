/**
 * Selection-highlight decision + churn audit helpers.
 *
 * Verifies the amber selection highlight is
 * built once per *selection change* - not per render frame, and not
 * twice when the same store mutation touches both `selectedElementId`
 * and `selectedIds`.
 *
 * Companion to `hoverHighlightHelpers.ts`.
 * Same shape: framework-free pure functions so vitest can pin the
 * contract without mounting a renderer or @thatopen/fragments.
 */
import * as THREE from 'three';

/**
 * Selection amber hue. Distinct from the hover amber (`0xfbbf24`) so a
 * preview + selected element next to each other read as two states.
 */
export const SELECTION_HIGHLIGHT_HEX = 0xf59e0b;

/**
 * Selection highlight is opaque - the selected element should look
 * solid, not previewed.
 */
export const SELECTION_HIGHLIGHT_OPACITY = 1.0;

/**
 * Plain-old-data spec of the selection-highlight material. ViewerPanel
 * combines this with the @thatopen/fragments `renderedFaces` enum at
 * call-time so this module stays framework-free for vitest.
 */
export const SELECTION_HIGHLIGHT_MATERIAL_SPEC = Object.freeze({
  hex: SELECTION_HIGHLIGHT_HEX,
  opacity: SELECTION_HIGHLIGHT_OPACITY,
  transparent: false,
});

let _sharedColor: THREE.Color | null = null;

/**
 * Module-level THREE.Color singleton. Allocating a fresh `THREE.Color`
 * on every selection change adds wasted GC churn - the colour never
 * changes. Mirrors `getHoverHighlightColor` for symmetry.
 */
export function getSelectionHighlightColor(): THREE.Color {
  if (!_sharedColor) _sharedColor = new THREE.Color(SELECTION_HIGHLIGHT_HEX);
  return _sharedColor;
}

/**
 * Map (`selectedElementId`, `selectedIds`) → the list of express IDs
 * that should be painted amber. Centralises the single-vs-multi-select
 * rule so future changes (e.g. always prefer `selectedIds`) live in one
 * place + are pinned by vitest.
 *
 * Contract:
 *   - `selectedIds` non-empty → use it verbatim (multi-select wins).
 *   - else `selectedElementId !== null` → `[selectedElementId]`.
 *   - else `[]`.
 *
 * `0` is treated as a real express ID - never coerced to "empty".
 */
export function computeAmberIds(
  selectedElementId: number | null,
  selectedIds: readonly number[],
): number[] {
  if (selectedIds.length > 0) return selectedIds.slice();
  if (selectedElementId !== null) return [selectedElementId];
  return [];
}

export type DurableHighlightLayer = 'selection' | 'chat' | 'base' | 'none';

/**
 * Resolve the persistent visual that must be restored after a temporary
 * canvas/tree hover highlight is removed. Selection wins over chat, and chat
 * wins over colour-by / paint layers, matching ViewerPanel's rebuild order.
 */
export function resolveDurableHighlightLayer(
  expressId: number | null,
  amberIds: readonly number[],
  chatIds: readonly number[],
  hasBaseColour: boolean,
): DurableHighlightLayer {
  if (expressId === null) return 'none';
  if (amberIds.includes(expressId)) return 'selection';
  if (chatIds.includes(expressId)) return 'chat';
  if (hasBaseColour) return 'base';
  return 'none';
}

/**
 * What the highlight-rebuild loop should do given the previous + new
 * amber-ID sets. `skip: true` means the set is unchanged - calling
 * `model.highlight(...)` again would still produce identical pixels.
 *
 * Set equality is order-INsensitive: `[1, 2]` and `[2, 1]` are the same
 * selection. The viewer's reset+rebuild cadence already paints both as
 * identical fragments, so churning on order would be wasted work.
 */
export type SelectionWorkDecision = {
  skip: boolean;
  prevIds: ReadonlySet<number>;
  nextIds: ReadonlySet<number>;
};

export function decideSelectionWork(
  prev: readonly number[],
  next: readonly number[],
): SelectionWorkDecision {
  const prevSet = new Set(prev);
  const nextSet = new Set(next);
  let skip = prevSet.size === nextSet.size;
  if (skip) {
    for (const id of prevSet) {
      if (!nextSet.has(id)) { skip = false; break; }
    }
  }
  return { skip, prevIds: prevSet, nextIds: nextSet };
}

/**
 * Counts of selection-rebuild side-effects across a synthetic stream.
 * Mirrors `HoverChurnCounts`. The audit asserts:
 *   - `highlightCalls === number of distinct adjacent amber sets`
 *   - `skippedTicks` covers identical-set ticks (the core dedup guard)
 *   - `materialAllocations === 1` regardless of stream length
 */
export type SelectionChurnCounts = {
  highlightCalls: number;
  skippedTicks: number;
  emptyTicks: number;
  materialAllocations: number;
};

/**
 * Run a synthetic stream of amber-ID lists through `decideSelectionWork`
 * and tally the resulting fragment-API calls without touching THREE.js.
 * Pure; deterministic; safe under any vitest environment.
 */
export function countSelectionChurn(
  stream: ReadonlyArray<readonly number[]>,
  getColor?: () => THREE.Color,
): SelectionChurnCounts {
  let prev: readonly number[] = [];
  const counts: SelectionChurnCounts = {
    highlightCalls: 0,
    skippedTicks: 0,
    emptyTicks: 0,
    materialAllocations: 0,
  };
  const seenColors = new Set<THREE.Color>();
  for (const next of stream) {
    const { skip } = decideSelectionWork(prev, next);
    if (skip) {
      counts.skippedTicks += 1;
      continue;
    }
    if (next.length === 0) {
      counts.emptyTicks += 1;
    } else {
      counts.highlightCalls += 1;
      if (getColor) seenColors.add(getColor());
    }
    prev = next;
  }
  counts.materialAllocations = seenColors.size;
  return counts;
}
