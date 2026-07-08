/**
 * Hover-highlight decision + material-churn audit helpers.
 *
 * Audits `ViewerPanel.onPointerMove` to
 * confirm the hover highlight material is not re-created per move event
 * and to make the "skip work when hovering the same element" guard
 * regression-proof.
 *
 * The helpers in this file are intentionally framework-free so they can
 * be unit-tested without spinning up a renderer, a Zustand store or
 * @thatopen/fragments. `ViewerPanel.tsx` owns the pointer wiring and
 * fragment side-effects; this file owns the pure decision math + the
 * hover-material colour/opacity contract.
 */
import * as THREE from 'three';

/**
 * Soft-amber hover preview hue. Same family as the click-selection
 * amber, kept here so a refactor of the hover path can't accidentally
 * drift the colour without updating the audit test below.
 */
export const HOVER_HIGHLIGHT_HEX = 0xfbbf24;

/**
 * Hover-preview opacity. Picked at ~0.45 so the underlying shading
 * still bleeds through - the chip reads as "preview", not "selected".
 */
export const HOVER_HIGHLIGHT_OPACITY = 0.45;

/**
 * Plain-old-data spec of the hover-highlight material. ViewerPanel
 * combines this with the @thatopen/fragments `renderedFaces` enum at
 * call-time so this module stays framework-free for vitest.
 *
 * Test contract: `HOVER_HIGHLIGHT_MATERIAL_SPEC` is a frozen module
 * singleton - referential equality across calls means no allocation
 * per hover event.
 */
export const HOVER_HIGHLIGHT_MATERIAL_SPEC = Object.freeze({
  hex: HOVER_HIGHLIGHT_HEX,
  opacity: HOVER_HIGHLIGHT_OPACITY,
  transparent: true,
});

let _sharedColor: THREE.Color | null = null;

/**
 * Lazy module-level THREE.Color so a single instance is shared across
 * every hover update for the life of the page. Allocating a fresh
 * `THREE.Color` per pointermove tick would be a wasted GC churn at
 * 60 Hz with no visual benefit - the colour never changes.
 */
export function getHoverHighlightColor(): THREE.Color {
  if (!_sharedColor) _sharedColor = new THREE.Color(HOVER_HIGHLIGHT_HEX);
  return _sharedColor;
}

/**
 * What the pointermove loop should do given the previous + new hover
 * targets. `null` means "void / no element".
 *
 * - `skip: true` - same target as last tick. Nothing to do; do not
 *   touch `model.highlight` / `model.resetHighlight` / the render queue.
 * - `toReset` - localId of the element whose highlight must be cleared,
 *   or `null` if there was no previous highlight.
 * - `toHighlight` - localId of the element to paint amber, or `null`
 *   if the cursor is now over void.
 *
 * The function never mutates its inputs and never allocates beyond the
 * returned object - safe to call inside a rAF callback at 60+ Hz.
 */
export type HoverWorkDecision = {
  skip: boolean;
  toReset: number | null;
  toHighlight: number | null;
};

export function decideHoverWork(
  prevLocal: number | null,
  newLocal: number | null,
): HoverWorkDecision {
  if (newLocal === prevLocal) {
    return { skip: true, toReset: null, toHighlight: null };
  }
  return {
    skip: false,
    toReset: prevLocal,
    toHighlight: newLocal,
  };
}

/**
 * Counts of side-effects produced by a hover stream - used by the
 * material-churn vitest. Bumps any time `decideHoverWork` would have
 * triggered the corresponding @thatopen/fragments call.
 *
 * `materialAllocations` is bumped once per call to `getHoverHighlightColor`
 * during the stream. The audit asserts this stays at 1 regardless of
 * stream length - proving the colour is a true module singleton.
 */
export type HoverChurnCounts = {
  highlightCalls: number;
  resetCalls: number;
  skippedTicks: number;
  materialAllocations: number;
};

/**
 * Run a synthetic hover stream through `decideHoverWork` and tally the
 * resulting side-effects without actually touching THREE.js. Pure;
 * deterministic; safe to call from vitest under any environment.
 *
 * The `getColor` callback is optional - pass `getHoverHighlightColor`
 * directly to also assert the colour singleton stays at 1 allocation.
 */
export function countHoverChurn(
  stream: ReadonlyArray<number | null>,
  getColor?: () => THREE.Color,
): HoverChurnCounts {
  let prev: number | null = null;
  const counts: HoverChurnCounts = {
    highlightCalls: 0,
    resetCalls: 0,
    skippedTicks: 0,
    materialAllocations: 0,
  };
  const seenColors = new Set<THREE.Color>();
  for (const next of stream) {
    const decision = decideHoverWork(prev, next);
    if (decision.skip) {
      counts.skippedTicks += 1;
      continue;
    }
    if (decision.toReset !== null) counts.resetCalls += 1;
    if (decision.toHighlight !== null) {
      counts.highlightCalls += 1;
      if (getColor) seenColors.add(getColor());
    }
    prev = next;
  }
  counts.materialAllocations = seenColors.size;
  return counts;
}
