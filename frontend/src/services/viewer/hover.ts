import * as THREE from 'three';
import * as FRAGS from '@thatopen/fragments';

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

/**
 * Shared frozen hover-highlight material.
 *
 * Both hover surfaces - the canvas pointer-move preview and the sidebar
 * tree-row preview - paint the same soft-amber "this is what you'd pick"
 * highlight. They used to each build their own material-options object (and
 * the tree path allocated a fresh `new THREE.Color(0xfbbf24)` on EVERY row
 * hover), undoing the colour singleton the hover-churn tests pin.
 *
 * This module is the single source of truth: one frozen options object whose
 * `color` is the `getHoverHighlightColor()` page-singleton, combined with the
 * @thatopen/fragments `RenderedFaces` enum here (the colour/opacity contract
 * itself stays framework-free in `hoverHighlightHelpers.ts` so vitest can pin
 * it without pulling in fragments). Referential equality across hovers means
 * zero per-paint allocation on either surface.
 */

/**
 * The exact material handed to `model.highlight()` for a hover preview.
 * Frozen so neither call site can mutate the shared instance, and built once
 * at module load - the colour is the lazy page-singleton, so this triggers a
 * single `THREE.Color` allocation for the life of the page.
 */
export const HOVER_HIGHLIGHT_MATERIAL = Object.freeze({
  color: getHoverHighlightColor(),
  opacity: HOVER_HIGHLIGHT_OPACITY,
  transparent: true,
  renderedFaces: FRAGS.RenderedFaces.ONE,
});

/**
 * Tree-row hover preview state machine.
 *
 * Sidebar tree rows fire `onPointerEnter` / `onPointerLeave` events.  The viewer
 * resolves each requested express ID to a fragment local ID (async) and paints
 * a soft amber preview highlight - same material as the cursor hover.  Because
 * the resolution is async, a fast cursor sweep across many rows can race: a
 * stale resolution must NOT paint after a newer one has been requested.
 *
 * This module keeps that gen-counter state machine pure so it can be exercised
 * without a Three.js world.
 */

export interface TreeHoverPreviewState {
  /** Monotonic counter; bumped on every enter / leave. */
  gen: number;
  /** Most-recently requested express ID (`null` = hovered out / idle). */
  requestedId: number | null;
  /** Express ID currently painted in the viewer (`null` = nothing painted). */
  paintedId: number | null;
}

export const INITIAL_TREE_HOVER_STATE: TreeHoverPreviewState = Object.freeze({
  gen: 0,
  requestedId: null,
  paintedId: null,
});

/** Tree row pointer-enter - bumps gen, records the requested express ID. */
export function onTreeHoverEnter(
  state: TreeHoverPreviewState,
  expressId: number,
): TreeHoverPreviewState {
  if (state.requestedId === expressId) return state;
  return { ...state, gen: state.gen + 1, requestedId: expressId };
}

/** Tree row pointer-leave - bumps gen, clears the request. */
export function onTreeHoverLeave(state: TreeHoverPreviewState): TreeHoverPreviewState {
  if (state.requestedId === null) return state;
  return { ...state, gen: state.gen + 1, requestedId: null };
}

/**
 * An async resolution that completed at gen `resolvedAtGen` is stale when a
 * newer enter / leave has already bumped the gen.  Callers should drop the
 * paint when this returns `true`.
 */
export function isResolutionStale(
  state: TreeHoverPreviewState,
  resolvedAtGen: number,
): boolean {
  return resolvedAtGen !== state.gen;
}

/**
 * Record that the viewer painted `paintedExpressId` (or cleared paint when
 * passed `null`).  No-op when the painted id has not changed.
 */
export function onTreeHoverPainted(
  state: TreeHoverPreviewState,
  paintedExpressId: number | null,
): TreeHoverPreviewState {
  if (state.paintedId === paintedExpressId) return state;
  return { ...state, paintedId: paintedExpressId };
}

/**
 * Returns true when the currently-painted express id is also click-selected,
 * meaning the hover-leave handler must skip its `resetHighlight` call so the
 * opaque amber selection paint stays put.  Centralises the brittle
 * `selectedIds.includes(prev ?? -1)` pattern from the call site.
 */
export function shouldSkipResetForSelection(
  paintedExpressId: number | null,
  selectedElementId: number | null,
  selectedIds: ReadonlyArray<number>,
): boolean {
  if (paintedExpressId === null) return false;
  if (selectedElementId === paintedExpressId) return true;
  return selectedIds.includes(paintedExpressId);
}

/**
 * Tiny external store for the 3D-canvas hover tooltip.
 *
 * Why not ViewerPanel state: the tooltip updates at up to ~12 Hz during hover
 * sweeps, and a `useState` on ViewerPanel reconciled the entire ~5k-line
 * component per update. The pointermove handler writes here; the
 * leaf `ViewerHoverTooltip` component is the only React subscriber, so a
 * tooltip move re-renders ~20 DOM nodes instead of the whole viewer.
 *
 * Kept dependency-free (no zustand, no THREE) - it's a five-line pub/sub
 * consumed via useSyncExternalStore.
 */

export interface HoverTooltipData {
  x: number;
  y: number;
  name: string;
  type: string;
  storey?: string | null;
}

let current: HoverTooltipData | null = null;
const listeners = new Set<() => void>();

export function setHoverTooltipData(next: HoverTooltipData | null): void {
  // Cheap dedupe: clearing an already-cleared tooltip is the common case
  // (every void crossing / pointer-leave) - skip the notify storm.
  if (next === null && current === null) return;
  current = next;
  for (const listener of listeners) listener();
}

export function getHoverTooltipData(): HoverTooltipData | null {
  return current;
}

export function subscribeHoverTooltip(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
