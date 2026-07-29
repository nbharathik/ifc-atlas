import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  closestPointOnSegment,
  closestPointsBetweenSegments,
  closestPointOnTriangle,
  coordinateInFrame,
  projectPointToPlaneExact,
  shortestDistanceBetweenTriangles,
  shortestDistanceBetweenTriangleSets,
  type Triangle3,
  verticalHeightBetween,
  WORLD_Y_UP_FRAME,
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
  facePointsToVec3,
  worldToScreen,
  findNearestVertexScreen,
  snapToFaceVertex,
} from '../constructionMeasurement';

const v = (x: number, y: number, z: number): THREE.Vector3 =>
  new THREE.Vector3(x, y, z);

function expectVector(actual: THREE.Vector3, expected: THREE.Vector3, precision = 8): void {
  expect(actual.x).toBeCloseTo(expected.x, precision);
  expect(actual.y).toBeCloseTo(expected.y, precision);
  expect(actual.z).toBeCloseTo(expected.z, precision);
}

describe('closestPointOnSegment', () => {
  it('returns an exact interior witness and parameter', () => {
    const result = closestPointOnSegment(v(2, 3, 0), v(0, 0, 0), v(4, 0, 0));

    expectVector(result.point, v(2, 0, 0));
    expect(result.parameter).toBeCloseTo(0.5);
    expect(result.distance).toBeCloseTo(3);
  });

  it('clamps to an endpoint and handles a degenerate segment', () => {
    const clamped = closestPointOnSegment(v(-2, 1, 0), v(0, 0, 0), v(4, 0, 0));
    expectVector(clamped.point, v(0, 0, 0));
    expect(clamped.parameter).toBe(0);

    const pointSegment = closestPointOnSegment(v(4, 6, 3), v(1, 2, 3), v(1, 2, 3));
    expectVector(pointSegment.point, v(1, 2, 3));
    expect(pointSegment.distance).toBeCloseTo(5);
  });
});

describe('closestPointsBetweenSegments', () => {
  it('finds the shortest connector between skew segments', () => {
    const result = closestPointsBetweenSegments(
      v(-1, 0, 0), v(1, 0, 0),
      v(0, -1, 2), v(0, 1, 2),
    );

    expectVector(result.pointA, v(0, 0, 0));
    expectVector(result.pointB, v(0, 0, 2));
    expect(result.distance).toBeCloseTo(2);
    expect(result.parameterA).toBeCloseTo(0.5);
    expect(result.parameterB).toBeCloseTo(0.5);
  });

  it('reports zero for intersecting segments and supports point-segment input', () => {
    const crossing = closestPointsBetweenSegments(
      v(-1, 0, 0), v(1, 0, 0),
      v(0, -1, 0), v(0, 1, 0),
    );
    expect(crossing.distance).toBeCloseTo(0);
    expectVector(crossing.pointA, crossing.pointB);

    const degenerate = closestPointsBetweenSegments(
      v(3, 2, 0), v(3, 2, 0),
      v(0, 0, 0), v(4, 0, 0),
    );
    expectVector(degenerate.pointA, v(3, 2, 0));
    expectVector(degenerate.pointB, v(3, 0, 0));
    expect(degenerate.distance).toBeCloseTo(2);
  });
});

describe('point projection foundations', () => {
  it('projects perpendicular to a non-unit plane normal with signed distance', () => {
    const result = projectPointToPlaneExact(v(2, -3, 4), v(0, 1, 0), v(0, 2, 0));

    expect(result).not.toBeNull();
    expectVector(result!.point, v(2, 1, 4));
    expect(result!.signedDistance).toBeCloseTo(-4);
    expect(result!.distance).toBeCloseTo(4);
    expect(projectPointToPlaneExact(v(0, 0, 0), v(0, 0, 0), v(0, 0, 0))).toBeNull();
  });

  it('finds face, edge, and degenerate-triangle witnesses', () => {
    const triangle: Triangle3 = [v(0, 0, 0), v(4, 0, 0), v(0, 4, 0)];
    const face = closestPointOnTriangle(v(1, 1, 3), triangle);
    expectVector(face.point, v(1, 1, 0));
    expect(face.feature).toBe('face');
    expect(face.barycentric.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);

    const edge = closestPointOnTriangle(v(3, 3, 0), triangle);
    expectVector(edge.point, v(2, 2, 0));
    expect(edge.feature).toBe('edge');

    const degenerate: Triangle3 = [v(0, 0, 0), v(2, 0, 0), v(4, 0, 0)];
    const line = closestPointOnTriangle(v(3, 2, 0), degenerate);
    expectVector(line.point, v(3, 0, 0));
    expect(line.distance).toBeCloseTo(2);
  });
});

describe('shortest construction distance', () => {
  it('returns exact witnesses for separated parallel triangles', () => {
    const lower: Triangle3 = [v(0, 0, 0), v(4, 0, 0), v(0, 0, 4)];
    const upper: Triangle3 = [v(1, 2, 1), v(2, 2, 1), v(1, 2, 2)];
    const result = shortestDistanceBetweenTriangles(lower, upper);

    expect(result.distance).toBeCloseTo(2);
    expect(result.pointA.y).toBeCloseTo(0);
    expect(result.pointB.y).toBeCloseTo(2);
    expect(result.pointA.x).toBeCloseTo(result.pointB.x);
    expect(result.pointA.z).toBeCloseTo(result.pointB.z);
  });

  it('detects an edge piercing the interior of another triangle', () => {
    const horizontal: Triangle3 = [v(-3, -3, 0), v(3, -3, 0), v(0, 3, 0)];
    const vertical: Triangle3 = [v(0, 0, -2), v(0, 0, 2), v(4, 0, 0)];
    const result = shortestDistanceBetweenTriangles(horizontal, vertical);

    expect(result.distance).toBeCloseTo(0);
    expectVector(result.pointA, result.pointB);
    expect(result.featureA).toBe('intersection');
  });

  it('finds the nearest pair across triangle sets and prunes impossible pairs', () => {
    const farA: Triangle3 = [v(100, 0, 0), v(101, 0, 0), v(100, 1, 0)];
    const nearA: Triangle3 = [v(0, 0, 0), v(1, 0, 0), v(0, 1, 0)];
    const nearB: Triangle3 = [v(0, 0, 3), v(1, 0, 3), v(0, 1, 3)];
    const farB: Triangle3 = [v(-100, 0, 0), v(-99, 0, 0), v(-100, 1, 0)];

    const result = shortestDistanceBetweenTriangleSets([nearA, farA], [nearB, farB]);
    expect(result).not.toBeNull();
    expect(result!.distance).toBeCloseTo(3);
    expect(result!.triangleA).toBe(0);
    expect(result!.triangleB).toBe(0);
    expect(result!.comparisons).toBeLessThan(4);
    expect(shortestDistanceBetweenTriangleSets([], [nearB])).toBeNull();
  });
});

describe('height and coordinate measurements', () => {
  it('constrains vertical dimensions to the project up axis', () => {
    const result = verticalHeightBetween(v(2, 8, 4), v(20, 3, -7));

    expect(result).not.toBeNull();
    expect(result!.signedHeight).toBeCloseTo(-5);
    expect(result!.height).toBeCloseTo(5);
    expectVector(result!.dimensionStart, v(2, 8, 4));
    expectVector(result!.dimensionEnd, v(2, 3, 4));

    const zUp = verticalHeightBetween(v(1, 2, 3), v(8, 9, 13), 'z');
    expect(zUp!.height).toBeCloseTo(10);
    expectVector(zUp!.dimensionEnd, v(1, 2, 13));
    expect(verticalHeightBetween(v(0, 0, 0), v(1, 1, 1), v(0, 0, 0))).toBeNull();
  });

  it('reports translated, rotated, and scaled local coordinates', () => {
    const translated = coordinateInFrame(v(7, 11, 13), {
      ...WORLD_Y_UP_FRAME,
      origin: v(2, 3, 5),
    });
    expectVector(translated!.local, v(5, 8, 8));

    const rotated = coordinateInFrame(v(8, 3, 1), {
      origin: v(10, 0, 0),
      xAxis: v(0, 1, 0),
      yAxis: v(-1, 0, 0),
      zAxis: v(0, 0, 1),
    });
    expectVector(rotated!.local, v(3, 2, 1));

    const scaled = coordinateInFrame(v(4, 9, 16), {
      origin: v(0, 0, 0),
      xAxis: v(2, 0, 0),
      yAxis: v(0, 3, 0),
      zAxis: v(0, 0, 4),
    });
    expectVector(scaled!.local, v(2, 3, 4));

    expect(coordinateInFrame(v(1, 2, 3), {
      origin: v(0, 0, 0),
      xAxis: v(1, 0, 0),
      yAxis: v(2, 0, 0),
      zAxis: v(0, 0, 1),
    })).toBeNull();
  });
});

const WIDTH = 800;
const HEIGHT = 600;

function expectVectorApprox(actual: THREE.Vector3, expected: THREE.Vector3, precision = 7): void {
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
    expectVectorApprox(midpoint!.point, v(0, -100, 0));

    const edge = snapToTriangleFeatures(
      triangle,
      new THREE.Vector2(450, 400),
      camera,
      WIDTH,
      HEIGHT,
      20,
    );
    expect(edge?.kind).toBe('edge');
    expectVectorApprox(edge!.point, v(50, -100, 0));
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
    expectVectorApprox(faceCenter!.point, centerWorld, 5);
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
    expectVectorApprox(result!.point, worldPoint, 7);
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
    expectVectorApprox(candidate!.point, v(10, 0, 0));
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
    expectVectorApprox(circle!.center, v(1, 2, 7));
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
    expectVectorApprox(best!.point, v(0, 0, 0));
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
