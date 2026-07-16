import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import {
  axisSnapCandidate,
  boundsAxisSnapCandidates,
  circumcircleFromThreePoints,
  closestScreenPointOnWorldSegment,
  faceNormalAxisSnapCandidate,
  projectWorldPoint,
  roundCenterSnapCandidate,
  selectBestSnapCandidate,
  snapToTriangleFeatures,
  triangleSnapCandidates,
  type ConstructionSnapCandidate,
} from '../constructionSnapCandidates';

const WIDTH = 800;
const HEIGHT = 600;
const v = (x: number, y: number, z: number): THREE.Vector3 =>
  new THREE.Vector3(x, y, z);

function expectVector(actual: THREE.Vector3, expected: THREE.Vector3, precision = 7): void {
  expect(actual.x).toBeCloseTo(expected.x, precision);
  expect(actual.y).toBeCloseTo(expected.y, precision);
  expect(actual.z).toBeCloseTo(expected.z, precision);
}

function makeOrthoCamera(): THREE.OrthographicCamera {
  const camera = new THREE.OrthographicCamera(-400, 400, 300, -300, 0.1, 1000);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

function makePerspectiveCamera(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(60, WIDTH / HEIGHT, 0.1, 1000);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

const triangle = new Float32Array([
  -100, -100, 0,
  100, -100, 0,
  0, 100, 0,
]);

describe('triangle construction snaps', () => {
  it('generates exact vertex, edge, midpoint, and face-center candidates', () => {
    const candidates = triangleSnapCandidates(
      triangle,
      new THREE.Vector2(400, 300),
      makeOrthoCamera(),
      WIDTH,
      HEIGHT,
    );

    expect(candidates).toHaveLength(10);
    expect(candidates.filter((candidate) => candidate.kind === 'vertex')).toHaveLength(3);
    expect(candidates.filter((candidate) => candidate.kind === 'edge')).toHaveLength(3);
    expect(candidates.filter((candidate) => candidate.kind === 'midpoint')).toHaveLength(3);
    expect(candidates.filter((candidate) => candidate.kind === 'face-center')).toHaveLength(1);
    expect(candidates.every((candidate) => candidate.exact)).toBe(true);
    expect(candidates.every((candidate) => candidate.source === 'hit-triangle')).toBe(true);
  });

  it('prefers a midpoint at an exact edge midpoint and an edge elsewhere', () => {
    const camera = makeOrthoCamera();
    const midpoint = snapToTriangleFeatures(
      triangle,
      new THREE.Vector2(400, 400),
      camera,
      WIDTH,
      HEIGHT,
      20,
    );
    expect(midpoint?.kind).toBe('midpoint');
    expectVector(midpoint!.point, v(0, -100, 0));

    const edge = snapToTriangleFeatures(
      triangle,
      new THREE.Vector2(450, 400),
      camera,
      WIDTH,
      HEIGHT,
      20,
    );
    expect(edge?.kind).toBe('edge');
    expectVector(edge!.point, v(50, -100, 0));
  });

  it('selects a vertex or the filled-face centroid when the cursor is exact', () => {
    const camera = makeOrthoCamera();
    const vertex = snapToTriangleFeatures(
      triangle,
      new THREE.Vector2(300, 400),
      camera,
      WIDTH,
      HEIGHT,
      20,
    );
    expect(vertex?.kind).toBe('vertex');

    const centerWorld = v(0, -100 / 3, 0);
    const centerPx = projectWorldPoint(centerWorld, camera, WIDTH, HEIGHT)!.screen;
    const faceCenter = snapToTriangleFeatures(
      triangle,
      centerPx,
      camera,
      WIDTH,
      HEIGHT,
      20,
    );
    expect(faceCenter?.kind).toBe('face-center');
    expectVector(faceCenter!.point, centerWorld, 5);
  });

  it('returns no candidates for incomplete face data', () => {
    expect(triangleSnapCandidates(
      new Float32Array([0, 0, 0, 1, 0, 0]),
      new THREE.Vector2(),
      makeOrthoCamera(),
      WIDTH,
      HEIGHT,
    )).toEqual([]);
  });
});

describe('screen-space selection policy', () => {
  const candidate = (
    kind: ConstructionSnapCandidate['kind'],
    distancePx: number,
    priority: number,
  ): ConstructionSnapCandidate => ({
    kind,
    point: v(0, 0, 0),
    distancePx,
    exact: true,
    source: 'hit-triangle',
    priority,
  });

  it('does not let a distant high-priority feature steal a clear edge', () => {
    const edge = candidate('edge', 1, 70);
    const vertex = candidate('vertex', 8, 100);
    expect(selectBestSnapCandidate([vertex, edge], 20)).toBe(edge);
  });

  it('uses construction priority only for near-equal screen hits', () => {
    const edge = candidate('edge', 1, 70);
    const midpoint = candidate('midpoint', 2.5, 90);
    expect(selectBestSnapCandidate([edge, midpoint], 20)).toBe(midpoint);
    expect(selectBestSnapCandidate([edge], 0)).toBeNull();
  });
});

describe('perspective-correct segment snapping', () => {
  it('maps a projected cursor back to the original world parameter', () => {
    const camera = makePerspectiveCamera();
    const start = v(-1, 0, -2);
    const end = v(4, 0, -20);
    const expectedParameter = 0.35;
    const worldPoint = start.clone().lerp(end, expectedParameter);
    const cursor = projectWorldPoint(worldPoint, camera, WIDTH, HEIGHT)!.screen;

    const result = closestScreenPointOnWorldSegment(
      start,
      end,
      cursor,
      camera,
      WIDTH,
      HEIGHT,
    );
    expect(result).not.toBeNull();
    expect(result!.parameter).toBeCloseTo(expectedParameter, 7);
    expectVector(result!.point, worldPoint, 7);
    expect(result!.distancePx).toBeCloseTo(0, 7);
  });

  it('creates explicit axis candidates with stable provenance', () => {
    const candidate = axisSnapCandidate(
      v(-20, 0, 0),
      v(20, 0, 0),
      new THREE.Vector2(410, 300),
      makeOrthoCamera(),
      WIDTH,
      HEIGHT,
      { featureId: 'grid-A' },
    );
    expect(candidate?.kind).toBe('axis');
    expect(candidate?.source).toBe('explicit-axis');
    expect(candidate?.exact).toBe(true);
    expect(candidate?.featureId).toBe('grid-A');
    expectVector(candidate!.point, v(10, 0, 0));
  });
});

describe('axis and round-center candidate sources', () => {
  it('marks bounding-box axes as inferred and face-normal axes as exact', () => {
    const camera = makeOrthoCamera();
    const bounds = new THREE.Box3(v(-10, -20, -2), v(10, 20, 2));
    const inferred = boundsAxisSnapCandidates(
      bounds,
      new THREE.Vector2(400, 300),
      camera,
      WIDTH,
      HEIGHT,
    );
    expect(inferred).toHaveLength(3);
    expect(inferred.every((item) => item.kind === 'axis')).toBe(true);
    expect(inferred.every((item) => !item.exact && item.source === 'bounds-axis')).toBe(true);

    const normal = faceNormalAxisSnapCandidate(
      triangle,
      5,
      new THREE.Vector2(400, 300),
      camera,
      WIDTH,
      HEIGHT,
    );
    expect(normal?.kind).toBe('axis');
    expect(normal?.source).toBe('face-normal-axis');
    expect(normal?.exact).toBe(true);
    expect(faceNormalAxisSnapCandidate(
      new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]),
      5,
      new THREE.Vector2(400, 300),
      camera,
      WIDTH,
      HEIGHT,
    )).toBeNull();
  });

  it('computes exact 3D circumcenters and rejects collinear samples', () => {
    const circle = circumcircleFromThreePoints(v(3, 2, 7), v(1, 4, 7), v(-1, 2, 7));
    expect(circle).not.toBeNull();
    expectVector(circle!.center, v(1, 2, 7));
    expect(circle!.radius).toBeCloseTo(2);
    expect(Math.abs(circle!.normal.z)).toBeCloseTo(1);
    expect(circumcircleFromThreePoints(v(0, 0, 0), v(1, 0, 0), v(2, 0, 0))).toBeNull();
  });

  it('distinguishes explicit circular semantics from inferred three-point fits', () => {
    const camera = makeOrthoCamera();
    const circle = circumcircleFromThreePoints(v(2, 0, 0), v(0, 2, 0), v(-2, 0, 0))!;
    const explicit = roundCenterSnapCandidate(
      circle,
      new THREE.Vector2(400, 300),
      camera,
      WIDTH,
      HEIGHT,
      true,
      'pipe-17',
    );
    const inferred = roundCenterSnapCandidate(
      circle,
      new THREE.Vector2(400, 300),
      camera,
      WIDTH,
      HEIGHT,
      false,
    );
    expect(explicit).toMatchObject({
      kind: 'round-center',
      source: 'explicit-round',
      exact: true,
      featureId: 'pipe-17',
    });
    expect(inferred).toMatchObject({
      kind: 'round-center',
      source: 'inferred-round',
      exact: false,
    });
  });
});
