import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import {
  anchorSnapCandidates,
  axisSnapCandidate,
  boundsAxisSnapCandidates,
  circumcircleFromThreePoints,
  closestScreenPointOnWorldSegment,
  engineSnapCandidates,
  faceNormalAxisSnapCandidate,
  projectWorldPoint,
  roundCenterSnapCandidate,
  selectBestSnapCandidate,
  snapToTriangleFeatures,
  triangleSnapCandidates,
  type ConstructionSnapCandidate,
  type EngineSnapHit,
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

// ────────────────────────────────────────────────────────────────────────────
// Engine-sourced snaps. These come from the fragments worker's snapping
// raycast, which searches a screen-space frustum against the model's real
// point/line primitives - so unlike triangleSnapCandidates they are not
// limited to the corners of the one triangle under the cursor.
// ────────────────────────────────────────────────────────────────────────────

describe('engine snap candidates', () => {
  // Ortho camera: world (x, y) maps to screen (400 + x, 300 - y).
  const edgeHit = (start: THREE.Vector3, end: THREE.Vector3, point: THREE.Vector3): EngineSnapHit => ({
    snappingClass: 'line',
    point,
    edgeStart: start,
    edgeEnd: end,
  });

  it('turns a point hit into an exact vertex candidate', () => {
    const candidates = engineSnapCandidates(
      [{ snappingClass: 'point', point: v(10, 0, 0) }],
      new THREE.Vector2(410, 300),
      makeOrthoCamera(),
      WIDTH,
      HEIGHT,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ kind: 'vertex', source: 'engine-point', exact: true });
    expect(candidates[0].distancePx).toBeCloseTo(0, 5);
  });

  it('derives edge, midpoint and both endpoints from one line hit', () => {
    const candidates = engineSnapCandidates(
      [edgeHit(v(-100, 0, 0), v(100, 0, 0), v(0, 0, 0))],
      new THREE.Vector2(400, 300),
      makeOrthoCamera(),
      WIDTH,
      HEIGHT,
    );
    expect(candidates.map((c) => c.kind).sort()).toEqual(['edge', 'midpoint', 'vertex', 'vertex']);
    expect(candidates.every((c) => c.exact && c.source === 'engine-line')).toBe(true);
  });

  it('ignores face hits - the face point is the cursor itself, not a feature', () => {
    // A face point projects ~0 px from the cursor, so admitting it as a
    // candidate would let it beat every real snap feature.
    expect(engineSnapCandidates(
      [{ snappingClass: 'face', point: v(0, 0, 0) }],
      new THREE.Vector2(400, 300),
      makeOrthoCamera(),
      WIDTH,
      HEIGHT,
    )).toEqual([]);
  });

  it('falls back to an edge candidate when a line hit reports no edge', () => {
    const candidates = engineSnapCandidates(
      [{ snappingClass: 'line', point: v(0, 0, 0) }],
      new THREE.Vector2(400, 300),
      makeOrthoCamera(),
      WIDTH,
      HEIGHT,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe('edge');
  });

  it('snaps to a wall edge from mid-face, where triangle snapping cannot', () => {
    // The regression that made measuring feel broken: on a large face the hit
    // triangle's corners are far outside tolerance, so nothing snapped at all.
    // The engine reports the nearby edge regardless of where the ray landed.
    // Cursor sits 4 px off the edge and ~50 px down it, clear of the midpoint.
    const camera = makeOrthoCamera();
    const best = selectBestSnapCandidate(
      engineSnapCandidates(
        [edgeHit(v(0, -100, 0), v(0, 100, 0), v(0, -50, 0))],
        new THREE.Vector2(404, 350),
        camera,
        WIDTH,
        HEIGHT,
      ),
      20,
      8,
    );
    expect(best?.kind).toBe('edge');
    expect(best?.point.x).toBeCloseTo(0, 5);
    expect(best?.point.y).toBeCloseTo(-50, 5);
  });

  it('prefers an edge midpoint over the edge when the cursor is on it', () => {
    const camera = makeOrthoCamera();
    const best = selectBestSnapCandidate(
      engineSnapCandidates(
        [edgeHit(v(0, -100, 0), v(0, 100, 0), v(0, 0, 0))],
        new THREE.Vector2(404, 300),
        camera,
        WIDTH,
        HEIGHT,
      ),
      20,
      8,
    );
    expect(best?.kind).toBe('midpoint');
    expectVector(best!.point, v(0, 0, 0));
  });

  it('prefers a vertex over the edge running through it within the priority window', () => {
    // Sticky corners: hovering 5 px from an endpoint should latch the endpoint,
    // even though the edge itself is 0 px away.
    const camera = makeOrthoCamera();
    const best = selectBestSnapCandidate(
      engineSnapCandidates(
        [edgeHit(v(-100, 0, 0), v(100, 0, 0), v(95, 0, 0))],
        new THREE.Vector2(495, 300),
        camera,
        WIDTH,
        HEIGHT,
      ),
      20,
      8,
    );
    expect(best?.kind).toBe('vertex');
    expect(best?.point.x).toBeCloseTo(100, 5);
  });

  it('keeps the edge when every point feature is outside the priority window', () => {
    // 2 px off the edge, but ~50 px from the midpoint and from both endpoints.
    const camera = makeOrthoCamera();
    const best = selectBestSnapCandidate(
      engineSnapCandidates(
        [edgeHit(v(-100, 0, 0), v(100, 0, 0), v(50, 0, 0))],
        new THREE.Vector2(450, 302),
        camera,
        WIDTH,
        HEIGHT,
      ),
      20,
      8,
    );
    expect(best?.kind).toBe('edge');
    expect(best?.point.x).toBeCloseTo(50, 5);
  });
});

describe('measurement endpoint anchors', () => {
  it('ranks endpoints above raw geometry at comparable screen distance', () => {
    // Chaining dimensions must stay exact: an endpoint and a vertex a couple of
    // pixels apart should resolve to the endpoint.
    const camera = makeOrthoCamera();
    const cursor = new THREE.Vector2(400, 300);
    const best = selectBestSnapCandidate(
      [
        ...engineSnapCandidates(
          [{ snappingClass: 'point', point: v(1, 0, 0) }],
          cursor, camera, WIDTH, HEIGHT,
        ),
        ...anchorSnapCandidates([v(-2, 0, 0)], cursor, camera, WIDTH, HEIGHT),
      ],
      20,
      8,
    );
    expect(best).toMatchObject({ kind: 'endpoint', source: 'measurement-endpoint', exact: true });
  });

  it('does not let a far endpoint steal a vertex under the cursor', () => {
    // The old world-space rule snapped to any endpoint within 10 cm regardless
    // of zoom, so a distant endpoint beat an exact vertex on the pixel.
    const camera = makeOrthoCamera();
    const cursor = new THREE.Vector2(400, 300);
    const best = selectBestSnapCandidate(
      [
        ...engineSnapCandidates(
          [{ snappingClass: 'point', point: v(0, 0, 0) }],
          cursor, camera, WIDTH, HEIGHT,
        ),
        ...anchorSnapCandidates([v(15, 0, 0)], cursor, camera, WIDTH, HEIGHT),
      ],
      20,
      8,
    );
    expect(best?.kind).toBe('vertex');
  });

  it('drops endpoints outside the pixel tolerance entirely', () => {
    const camera = makeOrthoCamera();
    const cursor = new THREE.Vector2(400, 300);
    expect(selectBestSnapCandidate(
      anchorSnapCandidates([v(200, 0, 0)], cursor, camera, WIDTH, HEIGHT),
      20,
      8,
    )).toBeNull();
  });
});
