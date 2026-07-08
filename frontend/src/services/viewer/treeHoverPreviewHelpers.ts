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
