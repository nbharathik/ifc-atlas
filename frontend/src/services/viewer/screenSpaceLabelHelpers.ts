import * as THREE from 'three';

/**
 * Result of projecting a world-space point to viewport pixel coordinates.
 *
 * `x` / `y` are always populated, but may lie outside `[0, width] × [0, height]`
 * when the point falls off-screen. Callers should check `visible` before
 * placing an in-bounds anchor, or use {@link clampToViewportEdge} for an
 * off-screen indicator.
 */
export interface ScreenSpaceProjection {
  /** Pixel X relative to the viewport's top-left. May be < 0 or > width. */
  x: number;
  /** Pixel Y relative to the viewport's top-left. May be < 0 or > height. */
  y: number;
  /** True when the point is behind the camera (NDC z > 1 after projection). */
  behind: boolean;
  /** True when the point is behind the camera OR outside the viewport rect. */
  offscreen: boolean;
  /** True iff `!offscreen` - equivalent to `!behind && inside-rect`. */
  visible: boolean;
}

function ndcToProjection(ndc: THREE.Vector3, width: number, height: number): ScreenSpaceProjection {
  const x = ((ndc.x + 1) / 2) * width;
  const y = ((-ndc.y + 1) / 2) * height;
  const behind = ndc.z > 1;
  const offscreen = behind || x < 0 || x > width || y < 0 || y > height;
  return { x, y, behind, offscreen, visible: !offscreen };
}

/**
 * Project a single world-space point to viewport pixel coordinates.
 *
 * Does not mutate `point`. Returns a flagged result rather than `null` so
 * callers can distinguish behind-camera from merely off-screen.
 */
export function worldToScreen(
  point: THREE.Vector3,
  camera: THREE.Camera,
  width: number,
  height: number,
): ScreenSpaceProjection {
  const scratch = new THREE.Vector3().copy(point).project(camera);
  return ndcToProjection(scratch, width, height);
}

/**
 * Project an array of world-space points in a single pass, reusing one
 * scratch vector to avoid per-point allocation. Order is preserved.
 *
 * Equivalent to calling {@link worldToScreen} on each element.
 */
export function worldToScreenBatch(
  points: ReadonlyArray<THREE.Vector3>,
  camera: THREE.Camera,
  width: number,
  height: number,
): ScreenSpaceProjection[] {
  const scratch = new THREE.Vector3();
  const out: ScreenSpaceProjection[] = new Array(points.length);
  for (let i = 0; i < points.length; i++) {
    scratch.copy(points[i]).project(camera);
    out[i] = ndcToProjection(scratch, width, height);
  }
  return out;
}

/** Edge label for {@link ViewportClampResult.edge}. */
export type ViewportEdge =
  | 'inside'
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right';

export interface ViewportClampResult {
  x: number;
  y: number;
  /** Which side of the viewport the point was clamped against (or 'inside'). */
  edge: ViewportEdge;
}

/**
 * Clamp a (potentially off-screen) pixel coordinate to the viewport rectangle,
 * inset by `padding` pixels from each edge. Returns the clamped position plus
 * a label naming which edge was hit - useful for placing off-screen indicator
 * arrows that point toward the original world target.
 *
 * If the point is already inside the (padded) viewport, returns it unchanged
 * with `edge: 'inside'`.
 *
 * Padding is clamped per-axis to `(extent - 1) / 2` so that the inset
 * rectangle is always non-empty (at least one pixel wide / tall). Negative
 * width/height or negative padding both fall back to a zero-pad clamp at the
 * raw viewport corners - callers should still pass sane values, but the
 * function won't return `NaN` or invert `min`/`max` if they don't.
 */
export function clampToViewportEdge(
  p: { readonly x: number; readonly y: number },
  width: number,
  height: number,
  padding = 0,
): ViewportClampResult {
  const safePad = Math.max(0, padding);
  const padX = width > 0 ? Math.min(safePad, Math.max(0, (width - 1) / 2)) : 0;
  const padY = height > 0 ? Math.min(safePad, Math.max(0, (height - 1) / 2)) : 0;
  const minX = padX;
  const minY = padY;
  const maxX = Math.max(padX, width - padX);
  const maxY = Math.max(padY, height - padY);

  let edgeX: 'left' | 'right' | null = null;
  let edgeY: 'top' | 'bottom' | null = null;
  let x = p.x;
  let y = p.y;

  if (x < minX) { x = minX; edgeX = 'left'; }
  else if (x > maxX) { x = maxX; edgeX = 'right'; }

  if (y < minY) { y = minY; edgeY = 'top'; }
  else if (y > maxY) { y = maxY; edgeY = 'bottom'; }

  let edge: ViewportEdge;
  if (edgeX && edgeY) edge = `${edgeY}-${edgeX}` as ViewportEdge;
  else if (edgeX) edge = edgeX;
  else if (edgeY) edge = edgeY;
  else edge = 'inside';

  return { x, y, edge };
}

/**
 * Compute the 3D centroid of `worldPoints`, then project it to the viewport.
 *
 * Projecting the centroid (rather than averaging projected pixel coords) is
 * the geometrically correct anchor: averaging in screen space introduces
 * perspective drift on long-axis polygons.
 *
 * Returns `null` for an empty input array.
 */
export function centroidScreen(
  worldPoints: ReadonlyArray<THREE.Vector3>,
  camera: THREE.Camera,
  width: number,
  height: number,
): ScreenSpaceProjection | null {
  if (worldPoints.length === 0) return null;
  const c = new THREE.Vector3();
  for (let i = 0; i < worldPoints.length; i++) c.add(worldPoints[i]);
  c.divideScalar(worldPoints.length);
  return worldToScreen(c, camera, width, height);
}
