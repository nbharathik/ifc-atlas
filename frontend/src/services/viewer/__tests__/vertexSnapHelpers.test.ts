import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  facePointsToVec3,
  worldToScreen,
  findNearestVertexScreen,
  snapToFaceVertex,
} from '../vertexSnapHelpers';

// ─── facePointsToVec3 ──────────────────────────────────────────────────────────

describe('facePointsToVec3', () => {
  it('converts a 9-element Float32Array to 3 Vector3s', () => {
    const fp = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const verts = facePointsToVec3(fp);
    expect(verts).toHaveLength(3);
    expect(verts[0]).toEqual(expect.objectContaining({ x: 1, y: 2, z: 3 }));
    expect(verts[1]).toEqual(expect.objectContaining({ x: 4, y: 5, z: 6 }));
    expect(verts[2]).toEqual(expect.objectContaining({ x: 7, y: 8, z: 9 }));
  });

  it('converts a 12-element array (4 verts) to 4 Vector3s', () => {
    const fp = new Float32Array(12).fill(1);
    expect(facePointsToVec3(fp)).toHaveLength(4);
  });

  it('returns empty array for length < 3', () => {
    expect(facePointsToVec3(new Float32Array([1, 2]))).toHaveLength(0);
  });

  it('ignores trailing incomplete triplet', () => {
    // 10 elements = 3 complete triplets (9) + 1 leftover
    const fp = new Float32Array(10);
    expect(facePointsToVec3(fp)).toHaveLength(3);
  });
});

// ─── worldToScreen ────────────────────────────────────────────────────────────

function makeOrthoCam(w = 800, h = 600): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(-w / 2, w / 2, h / 2, -h / 2, 0.1, 1000);
  cam.position.set(0, 0, 10);
  cam.lookAt(0, 0, 0);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
  return cam;
}

describe('worldToScreen', () => {
  const W = 800;
  const H = 600;

  it('projects the origin to the canvas center', () => {
    const cam = makeOrthoCam(W, H);
    const screen = worldToScreen(new THREE.Vector3(0, 0, 0), cam, W, H);
    expect(screen).not.toBeNull();
    expect(screen!.x).toBeCloseTo(W / 2, 0);
    expect(screen!.y).toBeCloseTo(H / 2, 0);
  });

  it('returns null for points beyond the far plane (z > 1 in NDC)', () => {
    // For an ortho camera at z=10 far=1000: far plane at z = 10 - 1000 = -990.
    // A point far beyond the far plane has NDC z > 1.
    const cam = makeOrthoCam(W, H);
    const screen = worldToScreen(new THREE.Vector3(0, 0, -2000), cam, W, H);
    expect(screen).toBeNull();
  });
});

// ─── findNearestVertexScreen ──────────────────────────────────────────────────

describe('findNearestVertexScreen', () => {
  const W = 800;
  const H = 600;
  const cam = makeOrthoCam(W, H);

  // Three world verts: centre, slightly right, far right.
  const vCentre = new THREE.Vector3(0, 0, 0);     // projects to (400, 300)
  const vRight = new THREE.Vector3(10, 0, 0);     // projects to (410, 300) approx (ortho 10 units = 10px at 1:1)
  const vFarRight = new THREE.Vector3(400, 0, 0); // projects beyond canvas

  it('returns the vertex nearest to the cursor within threshold', () => {
    const cursor = new THREE.Vector2(402, 300); // 2 px from centre screen pos
    const nearest = findNearestVertexScreen([vCentre, vRight], cursor, cam, W, H, 20);
    // vCentre projects to (400, 300) → dist = 2 px < 20 threshold → should win
    expect(nearest).not.toBeNull();
    expect(nearest!.x).toBeCloseTo(0, 1);
  });

  it('returns null when cursor is farther than threshold from all verts', () => {
    const cursor = new THREE.Vector2(0, 0); // top-left corner
    const nearest = findNearestVertexScreen([vCentre], cursor, cam, W, H, 20);
    // Centre projects to (400, 300), distance >> 20
    expect(nearest).toBeNull();
  });

  it('returns null for empty vertex list', () => {
    expect(findNearestVertexScreen([], new THREE.Vector2(400, 300), cam, W, H, 20)).toBeNull();
  });

  it('prefers the closer of two candidates within threshold', () => {
    // vCentre → screen (400, 300), vRight → screen (410, 300)
    // cursor at (408, 300): dist to vCentre = 8, dist to vRight = 2
    const cursor = new THREE.Vector2(408, 300);
    const nearest = findNearestVertexScreen([vCentre, vRight], cursor, cam, W, H, 20);
    expect(nearest).not.toBeNull();
    expect(nearest!.x).toBeCloseTo(10, 0); // vRight wins
  });
});

// ─── snapToFaceVertex ─────────────────────────────────────────────────────────

describe('snapToFaceVertex', () => {
  const W = 800;
  const H = 600;
  const cam = makeOrthoCam(W, H);

  it('returns null when facePoints is undefined', () => {
    expect(snapToFaceVertex(undefined, new THREE.Vector2(400, 300), cam, W, H)).toBeNull();
  });

  it('returns null when facePoints is too short (< 9 elements)', () => {
    const fp = new Float32Array([1, 2, 3, 4, 5, 6]); // only 2 verts
    expect(snapToFaceVertex(fp, new THREE.Vector2(400, 300), cam, W, H)).toBeNull();
  });

  it('snaps to the nearest face vertex within 20 px', () => {
    // Triangle with one vertex at world origin (projects to canvas centre 400,300).
    const fp = new Float32Array([
      0, 0, 0,   // vertex A → screen ~(400, 300)
      5, 5, 0,   // vertex B → screen ~(405, 295)
      -5, 5, 0,  // vertex C → screen ~(395, 295)
    ]);
    const cursor = new THREE.Vector2(401, 301); // 1.4 px from A
    const snap = snapToFaceVertex(fp, cursor, cam, W, H, 20);
    expect(snap).not.toBeNull();
    expect(snap!.x).toBeCloseTo(0, 1);
    expect(snap!.y).toBeCloseTo(0, 1);
  });

  it('returns null when cursor is outside threshold', () => {
    const fp = new Float32Array([100, 0, 0, 200, 0, 0, 150, 100, 0]);
    const cursor = new THREE.Vector2(0, 0); // far from all projections
    expect(snapToFaceVertex(fp, cursor, cam, W, H, 20)).toBeNull();
  });

  it('respects custom threshold', () => {
    const fp = new Float32Array([0, 0, 0, 50, 0, 0, 25, 50, 0]);
    // cursor 10 px from origin projection
    const cursor = new THREE.Vector2(410, 300);
    // threshold = 5 → too small
    expect(snapToFaceVertex(fp, cursor, cam, W, H, 5)).toBeNull();
    // threshold = 15 → close enough
    expect(snapToFaceVertex(fp, cursor, cam, W, H, 15)).not.toBeNull();
  });
});
