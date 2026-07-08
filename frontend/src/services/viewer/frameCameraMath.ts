/**
 * Camera-framing math for zoom-to-element / frame-selection.
 *
 * Pure helper used by `ViewerPanel`'s `zoomToElement` and `frameElements`
 * (tree zoom icon, viewer double-click, context menu, chat tools, `F` key).
 * Replaces the old fixed `(1, 0.66, 1)` world-space approach direction with
 * a view that:
 *
 *   1. Approaches from the camera's CURRENT side of the element - the
 *      direction from the element center to the camera is preserved, so the
 *      camera never arcs across the scene or lands behind the building
 *      looking at the element through other geometry.
 *   2. Clamps the landing elevation into a pleasant band so the result is
 *      never an under-floor or straight top-down view.
 *   3. Fits the element's bounding SPHERE (half the AABB diagonal) instead
 *      of face-on box extents - rotation-invariant, so the element fills the
 *      frame without cropping from any approach angle, for any shape.
 *   4. Solves orthographic cameras via `zoom` (moving an ortho camera closer
 *      does not magnify), returned as `orthoZoom`.
 *   5. Scales the transition's smooth-time with travel distance so short
 *      hops feel snappy and long flights don't whip.
 *
 * Everything here is O(1) vector math (a handful of Vector3 ops per call,
 * no iteration over geometry) - the only expensive step on the zoom path
 * remains the async `getMergedBox` lookup done by the caller.
 */

import * as THREE from 'three';

/** Padding factor applied to the bounding-sphere radius when fitting. */
export const FRAME_PADDING = 1.2;

/** Landing-elevation band (radians above the horizon). */
export const MIN_FRAME_ELEVATION = THREE.MathUtils.degToRad(12);
export const MAX_FRAME_ELEVATION = THREE.MathUtils.degToRad(55);

/** Smooth-time clamp for the camera-controls transition (seconds). */
export const MIN_FRAME_SMOOTH_TIME = 0.25;
export const MAX_FRAME_SMOOTH_TIME = 0.7;
/** Metres of camera travel that map to one second of smooth-time. */
const TRAVEL_PER_SECOND = 40;

/** Floor for degenerate (zero-size) boxes, in metres. */
const MIN_RADIUS = 0.05;

/** Fallback approach direction when the current one is unusable. */
const DEFAULT_ISO_DIR = new THREE.Vector3(1, 0.66, 1).normalize();

export interface FrameSolveArgs {
  /** Center of the target's merged AABB, world space. */
  center: THREE.Vector3;
  /** Size of the target's merged AABB, world space. */
  size: THREE.Vector3;
  /** Current camera position, world space. */
  cameraPos: THREE.Vector3;
  isPerspective: boolean;
  /** Perspective-only: vertical fov in degrees. */
  fovDeg?: number;
  /** Perspective-only: viewport aspect ratio. */
  aspect?: number;
  /** Ortho-only: frustum width at zoom=1 (`right - left`). */
  orthoWidth?: number;
  /** Ortho-only: frustum height at zoom=1 (`top - bottom`). */
  orthoHeight?: number;
}

export interface FrameSolution {
  /** Camera position to fly to. */
  eye: THREE.Vector3;
  /** Look-at target (the element center). */
  target: THREE.Vector3;
  /** Zoom to apply via `controls.zoomTo` - null for perspective cameras. */
  orthoZoom: number | null;
  /** Transition smooth-time in seconds, scaled by travel distance. */
  smoothTime: number;
}

/**
 * Solve the camera pose that frames the given AABB from the camera's
 * current side, elevation-clamped, bounding-sphere fitted.
 */
export function solveCameraFrame(args: FrameSolveArgs): FrameSolution {
  const { center, size, cameraPos } = args;
  const radius = Math.max(size.length() / 2, MIN_RADIUS);

  // Approach direction: element center → current camera. Falls back to the
  // default iso diagonal when degenerate (camera at the center) or when the
  // view is straight top/bottom-down (no azimuth to preserve).
  const dir = cameraPos.clone().sub(center);
  if (dir.lengthSq() < 1e-8 || Math.hypot(dir.x, dir.z) < 1e-4 * dir.length()) {
    dir.copy(DEFAULT_ISO_DIR);
  }
  dir.normalize();

  const elevation = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
  const clamped = THREE.MathUtils.clamp(elevation, MIN_FRAME_ELEVATION, MAX_FRAME_ELEVATION);
  if (clamped !== elevation) {
    const horiz = Math.hypot(dir.x, dir.z);
    const scale = Math.cos(clamped) / horiz;
    dir.set(dir.x * scale, Math.sin(clamped), dir.z * scale);
  }

  let distance: number;
  let orthoZoom: number | null = null;
  if (args.isPerspective) {
    // Distance at which the padded bounding sphere exactly fills the
    // narrower fov axis: d = r / sin(minHalfFov).
    const vFov = THREE.MathUtils.degToRad(args.fovDeg ?? 60);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(0.1, args.aspect ?? 1));
    distance = (radius * FRAME_PADDING) / Math.sin(Math.min(vFov, hFov) / 2);
  } else {
    // Ortho magnification comes from zoom, not distance - keep the camera
    // roughly on its current shell (clamped clear of the sphere) and fit
    // the padded sphere into the zoom=1 frustum extents.
    distance = Math.max(cameraPos.distanceTo(center), radius * 2);
    const w = Math.max(args.orthoWidth ?? 1, 1e-4);
    const h = Math.max(args.orthoHeight ?? 1, 1e-4);
    orthoZoom = Math.min(w, h) / (2 * radius * FRAME_PADDING);
  }

  const eye = center.clone().addScaledVector(dir, distance);
  const smoothTime = THREE.MathUtils.clamp(
    cameraPos.distanceTo(eye) / TRAVEL_PER_SECOND,
    MIN_FRAME_SMOOTH_TIME,
    MAX_FRAME_SMOOTH_TIME,
  );

  return { eye, target: center.clone(), orthoZoom, smoothTime };
}
