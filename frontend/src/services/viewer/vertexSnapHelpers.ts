/**
 * Screen-space vertex snapping helpers for the measurement tool.
 *
 * The @thatopen/fragments RaycastResult already includes `facePoints` -
 * the 3 world-space vertices of the hit triangle. We project each to
 * screen-space pixel coordinates and snap the cursor to the nearest
 * vertex within a configurable pixel threshold.
 *
 * All functions are pure (no THREE scene state, no DOM access beyond the
 * canvas dimensions passed in) so they are trivially unit-testable.
 */

import * as THREE from 'three';

/** Convert the `facePoints` Float32Array from a RaycastResult to THREE.Vector3 triplet. */
export function facePointsToVec3(facePoints: Float32Array): THREE.Vector3[] {
  const verts: THREE.Vector3[] = [];
  for (let i = 0; i + 2 < facePoints.length; i += 3) {
    verts.push(new THREE.Vector3(facePoints[i], facePoints[i + 1], facePoints[i + 2]));
  }
  return verts;
}

/**
 * Project a world-space point to canvas pixel coordinates.
 * Returns null if the point is behind the camera (w <= 0).
 */
export function worldToScreen(
  worldPt: THREE.Vector3,
  camera: THREE.Camera,
  canvasWidth: number,
  canvasHeight: number,
): THREE.Vector2 | null {
  const ndc = worldPt.clone().project(camera);
  // In NDC, z > 1 or z < -1 means outside frustum (behind camera at z > 1).
  if (ndc.z > 1) return null;
  return new THREE.Vector2(
    ((ndc.x + 1) / 2) * canvasWidth,
    ((-ndc.y + 1) / 2) * canvasHeight,
  );
}

/**
 * Find the world-space vertex from `verts` whose screen-space projection
 * is closest to `cursorScreen` and within `thresholdPx` pixels.
 *
 * Returns null when no vertex qualifies.
 */
export function findNearestVertexScreen(
  verts: THREE.Vector3[],
  cursorScreen: THREE.Vector2,
  camera: THREE.Camera,
  canvasWidth: number,
  canvasHeight: number,
  thresholdPx: number,
): THREE.Vector3 | null {
  let best: THREE.Vector3 | null = null;
  let bestDist = thresholdPx;
  for (const v of verts) {
    const screen = worldToScreen(v, camera, canvasWidth, canvasHeight);
    if (!screen) continue;
    const dist = cursorScreen.distanceTo(screen);
    if (dist < bestDist) {
      bestDist = dist;
      best = v;
    }
  }
  return best;
}

/**
 * High-level helper used by ViewerPanel's pointermove handler.
 *
 * Given the fragments RaycastResult's `facePoints` Float32Array, the raw
 * pointer position in canvas pixels, the camera, and the canvas dimensions,
 * returns either a snapped world-space vertex or null.
 *
 * When non-null the caller should use this as the cursor position (instead
 * of `result.point`) and render the snap dot in "vertex" colour.
 */
export function snapToFaceVertex(
  facePoints: Float32Array | undefined,
  canvasCursorPx: THREE.Vector2,
  camera: THREE.Camera,
  canvasWidth: number,
  canvasHeight: number,
  thresholdPx = 20,
): THREE.Vector3 | null {
  if (!facePoints || facePoints.length < 9) return null;
  const verts = facePointsToVec3(facePoints);
  return findNearestVertexScreen(verts, canvasCursorPx, camera, canvasWidth, canvasHeight, thresholdPx);
}
