import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  worldToScreen,
  worldToScreenBatch,
  clampToViewportEdge,
  centroidScreen,
} from '../screenSpaceLabelHelpers';

function makeCamera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  cam.position.set(0, 0, 10);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  return cam;
}

describe('worldToScreen', () => {
  it('projects the origin to the centre of the viewport', () => {
    const cam = makeCamera();
    const r = worldToScreen(new THREE.Vector3(0, 0, 0), cam, 800, 600);
    expect(r.x).toBeCloseTo(400, 0);
    expect(r.y).toBeCloseTo(300, 0);
    expect(r.behind).toBe(false);
    expect(r.offscreen).toBe(false);
    expect(r.visible).toBe(true);
  });

  it('flags a point behind the camera with behind=true and visible=false', () => {
    const cam = makeCamera();
    const r = worldToScreen(new THREE.Vector3(0, 0, 20), cam, 800, 600);
    expect(r.behind).toBe(true);
    expect(r.offscreen).toBe(true);
    expect(r.visible).toBe(false);
  });

  it('flags a point off the right edge with offscreen=true but behind=false', () => {
    const cam = makeCamera();
    // camera is at z=10 with 60° FOV, aspect 1 - half-width at z=0 is tan(30°)*10 ≈ 5.77
    // x=100 is far off the right side.
    const r = worldToScreen(new THREE.Vector3(100, 0, 0), cam, 800, 600);
    expect(r.behind).toBe(false);
    expect(r.offscreen).toBe(true);
    expect(r.visible).toBe(false);
    expect(r.x).toBeGreaterThan(800);
  });

  it('flags a point off the left edge', () => {
    const cam = makeCamera();
    const r = worldToScreen(new THREE.Vector3(-100, 0, 0), cam, 800, 600);
    expect(r.behind).toBe(false);
    expect(r.offscreen).toBe(true);
    expect(r.x).toBeLessThan(0);
  });

  it('flags a point off the top edge', () => {
    const cam = makeCamera();
    const r = worldToScreen(new THREE.Vector3(0, 100, 0), cam, 800, 600);
    expect(r.offscreen).toBe(true);
    expect(r.y).toBeLessThan(0);
  });

  it('flags a point off the bottom edge', () => {
    const cam = makeCamera();
    const r = worldToScreen(new THREE.Vector3(0, -100, 0), cam, 800, 600);
    expect(r.offscreen).toBe(true);
    expect(r.y).toBeGreaterThan(600);
  });

  it('does not mutate the input world point', () => {
    const cam = makeCamera();
    const p = new THREE.Vector3(1, 2, 3);
    worldToScreen(p, cam, 800, 600);
    expect(p.x).toBe(1);
    expect(p.y).toBe(2);
    expect(p.z).toBe(3);
  });
});

describe('worldToScreenBatch', () => {
  it('returns the same projection as worldToScreen for each point (order preserved)', () => {
    const cam = makeCamera();
    const points = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(1, 1, 0),
      new THREE.Vector3(-1, -1, 0),
      new THREE.Vector3(0, 0, 20), // behind
    ];
    const batch = worldToScreenBatch(points, cam, 800, 600);
    expect(batch).toHaveLength(4);
    for (let i = 0; i < points.length; i++) {
      const single = worldToScreen(points[i], cam, 800, 600);
      expect(batch[i].x).toBeCloseTo(single.x, 5);
      expect(batch[i].y).toBeCloseTo(single.y, 5);
      expect(batch[i].behind).toBe(single.behind);
      expect(batch[i].offscreen).toBe(single.offscreen);
      expect(batch[i].visible).toBe(single.visible);
    }
  });

  it('returns an empty array for empty input', () => {
    const cam = makeCamera();
    expect(worldToScreenBatch([], cam, 800, 600)).toEqual([]);
  });

  it('does not mutate any input point', () => {
    const cam = makeCamera();
    const points = [new THREE.Vector3(1, 2, 3), new THREE.Vector3(4, 5, 6)];
    worldToScreenBatch(points, cam, 800, 600);
    expect(points[0].toArray()).toEqual([1, 2, 3]);
    expect(points[1].toArray()).toEqual([4, 5, 6]);
  });
});

describe('clampToViewportEdge', () => {
  it('returns the point unchanged when inside the viewport', () => {
    const r = clampToViewportEdge({ x: 100, y: 200 }, 800, 600);
    expect(r.x).toBe(100);
    expect(r.y).toBe(200);
    expect(r.edge).toBe('inside');
  });

  it('clamps a point that is off the left edge', () => {
    const r = clampToViewportEdge({ x: -50, y: 300 }, 800, 600);
    expect(r.x).toBe(0);
    expect(r.y).toBe(300);
    expect(r.edge).toBe('left');
  });

  it('clamps a point that is off the right edge', () => {
    const r = clampToViewportEdge({ x: 900, y: 300 }, 800, 600);
    expect(r.x).toBe(800);
    expect(r.edge).toBe('right');
  });

  it('clamps a point that is off the top edge', () => {
    const r = clampToViewportEdge({ x: 400, y: -10 }, 800, 600);
    expect(r.y).toBe(0);
    expect(r.edge).toBe('top');
  });

  it('clamps a point that is off the bottom edge', () => {
    const r = clampToViewportEdge({ x: 400, y: 700 }, 800, 600);
    expect(r.y).toBe(600);
    expect(r.edge).toBe('bottom');
  });

  it('returns a composite edge label for corner-off cases', () => {
    const tl = clampToViewportEdge({ x: -10, y: -10 }, 800, 600);
    expect(tl.edge).toBe('top-left');
    const br = clampToViewportEdge({ x: 900, y: 700 }, 800, 600);
    expect(br.edge).toBe('bottom-right');
  });

  it('honours the padding inset', () => {
    const r = clampToViewportEdge({ x: 5, y: 300 }, 800, 600, 20);
    expect(r.x).toBe(20);
    expect(r.edge).toBe('left');
    const inside = clampToViewportEdge({ x: 100, y: 100 }, 800, 600, 20);
    expect(inside.edge).toBe('inside');
  });

  it('caps oversize padding so the inset rect stays non-empty', () => {
    // padding = 500 > width/2 = 400. Without the cap, maxX = -100 < minX = 500,
    // which would make every point clamp to a nonsense corner.
    const r = clampToViewportEdge({ x: 400, y: 300 }, 800, 600, 500);
    // padding is capped to (800-1)/2 = 399.5 on X and (600-1)/2 = 299.5 on Y.
    // (400, 300) is inside the padded rect by a hair.
    expect(r.edge).toBe('inside');
    expect(r.x).toBeCloseTo(400, 5);
    expect(r.y).toBeCloseTo(300, 5);
  });

  it('treats negative padding as zero', () => {
    const r = clampToViewportEdge({ x: -10, y: 300 }, 800, 600, -5);
    expect(r.x).toBe(0);
    expect(r.edge).toBe('left');
  });

  it('handles a zero-size viewport without inverting bounds or returning NaN', () => {
    const r = clampToViewportEdge({ x: 50, y: 50 }, 0, 0, 10);
    expect(Number.isFinite(r.x)).toBe(true);
    expect(Number.isFinite(r.y)).toBe(true);
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
  });
});

describe('centroidScreen', () => {
  it('projects the 3D centroid of the input points', () => {
    const cam = makeCamera();
    // Square around the origin in the z=0 plane - centroid is the origin.
    const r = centroidScreen(
      [
        new THREE.Vector3(-1, -1, 0),
        new THREE.Vector3(1, -1, 0),
        new THREE.Vector3(1, 1, 0),
        new THREE.Vector3(-1, 1, 0),
      ],
      cam,
      800,
      600,
    );
    expect(r).not.toBeNull();
    expect(r!.x).toBeCloseTo(400, 0);
    expect(r!.y).toBeCloseTo(300, 0);
    expect(r!.visible).toBe(true);
  });

  it('returns null for an empty point array', () => {
    const cam = makeCamera();
    expect(centroidScreen([], cam, 800, 600)).toBeNull();
  });

  it('agrees with worldToScreen on the manually-computed centroid', () => {
    const cam = makeCamera();
    const pts = [
      new THREE.Vector3(2, 0, 0),
      new THREE.Vector3(0, 2, 0),
      new THREE.Vector3(-2, -2, 0),
    ];
    const manual = pts
      .reduce((acc, p) => acc.add(p), new THREE.Vector3())
      .divideScalar(pts.length);
    const expected = worldToScreen(manual, cam, 800, 600);
    const actual = centroidScreen(pts, cam, 800, 600);
    expect(actual).not.toBeNull();
    expect(actual!.x).toBeCloseTo(expected.x, 5);
    expect(actual!.y).toBeCloseTo(expected.y, 5);
  });

  it('does not mutate the input points', () => {
    const cam = makeCamera();
    const a = new THREE.Vector3(1, 2, 3);
    const b = new THREE.Vector3(4, 5, 6);
    centroidScreen([a, b], cam, 800, 600);
    expect(a.toArray()).toEqual([1, 2, 3]);
    expect(b.toArray()).toEqual([4, 5, 6]);
  });
});
