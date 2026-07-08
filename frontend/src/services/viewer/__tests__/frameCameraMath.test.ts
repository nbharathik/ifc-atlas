import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  FRAME_PADDING,
  MAX_FRAME_ELEVATION,
  MAX_FRAME_SMOOTH_TIME,
  MIN_FRAME_ELEVATION,
  MIN_FRAME_SMOOTH_TIME,
  solveCameraFrame,
  type FrameSolveArgs,
} from '../frameCameraMath';

const perspArgs = (overrides: Partial<FrameSolveArgs> = {}): FrameSolveArgs => ({
  center: new THREE.Vector3(0, 0, 0),
  size: new THREE.Vector3(2, 2, 2),
  cameraPos: new THREE.Vector3(10, 5, 0),
  isPerspective: true,
  fovDeg: 60,
  aspect: 1,
  ...overrides,
});

/** Elevation (radians above horizon) of the eye as seen from the target. */
const elevationOf = (eye: THREE.Vector3, target: THREE.Vector3) =>
  Math.asin(eye.clone().sub(target).normalize().y);

describe('solveCameraFrame', () => {
  it('approaches from the camera\'s current side instead of a fixed diagonal', () => {
    const fromPlusX = solveCameraFrame(perspArgs({ cameraPos: new THREE.Vector3(20, 5, 1) }));
    const fromMinusZ = solveCameraFrame(perspArgs({ cameraPos: new THREE.Vector3(1, 5, -20) }));

    expect(fromPlusX.eye.x).toBeGreaterThan(0);
    expect(Math.abs(fromPlusX.eye.z)).toBeLessThan(fromPlusX.eye.x);
    expect(fromMinusZ.eye.z).toBeLessThan(0);
    expect(Math.abs(fromMinusZ.eye.x)).toBeLessThan(-fromMinusZ.eye.z);
  });

  it('keeps an in-band elevation unchanged', () => {
    // 30° elevation: horizontal distance 10, height 10·tan(30°).
    const y = 10 * Math.tan(THREE.MathUtils.degToRad(30));
    const { eye, target } = solveCameraFrame(perspArgs({ cameraPos: new THREE.Vector3(10, y, 0) }));
    expect(elevationOf(eye, target)).toBeCloseTo(THREE.MathUtils.degToRad(30), 5);
  });

  it('raises an under-floor view up to the minimum elevation', () => {
    const { eye, target } = solveCameraFrame(perspArgs({ cameraPos: new THREE.Vector3(10, -8, 0) }));
    expect(elevationOf(eye, target)).toBeCloseTo(MIN_FRAME_ELEVATION, 5);
    // Azimuth (the +X side) is preserved.
    expect(eye.x).toBeGreaterThan(0);
    expect(Math.abs(eye.z)).toBeLessThan(1e-6);
  });

  it('lowers a near-top-down view to the maximum elevation', () => {
    const { eye, target } = solveCameraFrame(perspArgs({ cameraPos: new THREE.Vector3(1, 30, 0) }));
    expect(elevationOf(eye, target)).toBeCloseTo(MAX_FRAME_ELEVATION, 5);
    expect(eye.x).toBeGreaterThan(0);
  });

  it('falls back to the default iso diagonal for straight top-down and degenerate views', () => {
    const topDown = solveCameraFrame(perspArgs({ cameraPos: new THREE.Vector3(0, 50, 0) }));
    const atCenter = solveCameraFrame(perspArgs({ cameraPos: new THREE.Vector3(0, 0, 0) }));
    for (const { eye } of [topDown, atCenter]) {
      expect(eye.x).toBeGreaterThan(0);
      expect(eye.z).toBeGreaterThan(0);
      expect(eye.y).toBeGreaterThan(0);
      expect(eye.x).toBeCloseTo(eye.z, 5);
    }
  });

  it('fits the padded bounding sphere into the narrower fov axis', () => {
    // fov 60 / aspect 1 → hFov = vFov = 60°, so d = r·padding / sin(30°).
    const { eye, target, orthoZoom } = solveCameraFrame(perspArgs());
    const radius = new THREE.Vector3(2, 2, 2).length() / 2;
    expect(eye.distanceTo(target)).toBeCloseTo((radius * FRAME_PADDING) / Math.sin(Math.PI / 6), 5);
    expect(orthoZoom).toBeNull();
  });

  it('backs out further for narrow viewports than for wide ones', () => {
    const narrow = solveCameraFrame(perspArgs({ aspect: 0.5 }));
    const wide = solveCameraFrame(perspArgs({ aspect: 2 }));
    expect(narrow.eye.distanceTo(narrow.target))
      .toBeGreaterThan(wide.eye.distanceTo(wide.target));
  });

  it('solves orthographic cameras via zoom against the smaller frustum extent', () => {
    const radius = new THREE.Vector3(2, 2, 2).length() / 2;
    const solution = solveCameraFrame(perspArgs({
      isPerspective: false,
      fovDeg: undefined,
      aspect: undefined,
      orthoWidth: 100,
      orthoHeight: 50,
      cameraPos: new THREE.Vector3(40, 10, 0),
    }));
    expect(solution.orthoZoom).toBeCloseTo(50 / (2 * radius * FRAME_PADDING), 5);
    // The camera keeps its current shell distance rather than dollying in.
    const camDist = new THREE.Vector3(40, 10, 0).length();
    expect(solution.eye.distanceTo(solution.target)).toBeCloseTo(camDist, 5);
  });

  it('scales smooth-time with travel distance, clamped to the configured band', () => {
    const shortHop = solveCameraFrame(perspArgs({ cameraPos: new THREE.Vector3(5, 1.5, 0) }));
    const longFlight = solveCameraFrame(perspArgs({ cameraPos: new THREE.Vector3(500, 100, 0) }));
    expect(shortHop.smoothTime).toBe(MIN_FRAME_SMOOTH_TIME);
    expect(longFlight.smoothTime).toBe(MAX_FRAME_SMOOTH_TIME);
  });

  it('handles zero-size boxes without producing NaN or a zero distance', () => {
    const { eye, target, smoothTime } = solveCameraFrame(perspArgs({
      size: new THREE.Vector3(0, 0, 0),
    }));
    expect(Number.isFinite(eye.x + eye.y + eye.z)).toBe(true);
    expect(eye.distanceTo(target)).toBeGreaterThan(0);
    expect(Number.isFinite(smoothTime)).toBe(true);
  });

  it('returns a fresh target vector, never the caller\'s center reference', () => {
    const center = new THREE.Vector3(1, 2, 3);
    const { target } = solveCameraFrame(perspArgs({ center }));
    expect(target).not.toBe(center);
    expect(target.equals(center)).toBe(true);
  });
});
