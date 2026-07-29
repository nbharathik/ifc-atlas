import * as THREE from 'three';

/** Numerical tolerance used only for degeneracy decisions, never UI snapping. */
const EPSILON = 1e-12;

export type Triangle3 = readonly [THREE.Vector3, THREE.Vector3, THREE.Vector3];

export type ClosestFeature = 'vertex' | 'edge' | 'face' | 'intersection';

/** Exact witness points for a distance measurement. */
export interface ClosestPointPair {
  pointA: THREE.Vector3;
  pointB: THREE.Vector3;
  distance: number;
  distanceSquared: number;
  featureA: ClosestFeature;
  featureB: ClosestFeature;
}

export interface SegmentProjection {
  point: THREE.Vector3;
  /** Parametric position on [start,end], clamped to [0,1]. */
  parameter: number;
  distance: number;
  distanceSquared: number;
}

export interface TriangleProjection {
  point: THREE.Vector3;
  /** Barycentric weights for [a,b,c]. */
  barycentric: readonly [number, number, number];
  distance: number;
  distanceSquared: number;
  feature: 'vertex' | 'edge' | 'face';
}

export interface PlaneProjection {
  point: THREE.Vector3;
  /** Signed component along the normalized plane normal. */
  signedDistance: number;
  distance: number;
  normal: THREE.Vector3;
}

export interface VerticalHeightMeasurement {
  sourceA: THREE.Vector3;
  sourceB: THREE.Vector3;
  /** Dimension line anchored at A and constrained to the configured up axis. */
  dimensionStart: THREE.Vector3;
  dimensionEnd: THREE.Vector3;
  up: THREE.Vector3;
  signedHeight: number;
  height: number;
}

export interface CoordinateFrame {
  origin: THREE.Vector3;
  xAxis: THREE.Vector3;
  yAxis: THREE.Vector3;
  zAxis: THREE.Vector3;
}

export interface CoordinateMeasurement {
  world: THREE.Vector3;
  local: THREE.Vector3;
  frame: CoordinateFrame;
}

export interface TriangleSetDistanceResult extends ClosestPointPair {
  triangleA: number;
  triangleB: number;
  comparisons: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function featureForBarycentric(
  barycentric: readonly [number, number, number],
): 'vertex' | 'edge' | 'face' {
  const zeroCount = barycentric.filter((value) => Math.abs(value) <= 1e-10).length;
  if (zeroCount >= 2) return 'vertex';
  if (zeroCount === 1) return 'edge';
  return 'face';
}

export function closestPointOnSegment(
  point: THREE.Vector3,
  start: THREE.Vector3,
  end: THREE.Vector3,
): SegmentProjection {
  const direction = new THREE.Vector3().subVectors(end, start);
  const lengthSquared = direction.lengthSq();
  const parameter = lengthSquared <= EPSILON
    ? 0
    : clamp01(new THREE.Vector3().subVectors(point, start).dot(direction) / lengthSquared);
  const projected = start.clone().addScaledVector(direction, parameter);
  const distanceSquared = projected.distanceToSquared(point);
  return {
    point: projected,
    parameter,
    distance: Math.sqrt(distanceSquared),
    distanceSquared,
  };
}

/**
 * Exact shortest connector between two finite 3D segments. Handles parallel,
 * intersecting, point-segment, and point-point degeneracies.
 */
export function closestPointsBetweenSegments(
  aStart: THREE.Vector3,
  aEnd: THREE.Vector3,
  bStart: THREE.Vector3,
  bEnd: THREE.Vector3,
): ClosestPointPair & { parameterA: number; parameterB: number } {
  const d1 = new THREE.Vector3().subVectors(aEnd, aStart);
  const d2 = new THREE.Vector3().subVectors(bEnd, bStart);
  const r = new THREE.Vector3().subVectors(aStart, bStart);
  const a = d1.dot(d1);
  const e = d2.dot(d2);
  const f = d2.dot(r);
  let s = 0;
  let t = 0;

  if (a <= EPSILON && e <= EPSILON) {
    s = 0;
    t = 0;
  } else if (a <= EPSILON) {
    s = 0;
    t = clamp01(f / e);
  } else {
    const c = d1.dot(r);
    if (e <= EPSILON) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = d1.dot(d2);
      const denominator = a * e - b * b;
      s = Math.abs(denominator) > EPSILON
        ? clamp01((b * f - c * e) / denominator)
        : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }

  const pointA = aStart.clone().addScaledVector(d1, s);
  const pointB = bStart.clone().addScaledVector(d2, t);
  const distanceSquared = pointA.distanceToSquared(pointB);
  return {
    pointA,
    pointB,
    distance: Math.sqrt(distanceSquared),
    distanceSquared,
    featureA: s <= 1e-10 || s >= 1 - 1e-10 ? 'vertex' : 'edge',
    featureB: t <= 1e-10 || t >= 1 - 1e-10 ? 'vertex' : 'edge',
    parameterA: s,
    parameterB: t,
  };
}

export function projectPointToPlaneExact(
  point: THREE.Vector3,
  planePoint: THREE.Vector3,
  planeNormal: THREE.Vector3,
): PlaneProjection | null {
  const normalLength = planeNormal.length();
  if (normalLength <= EPSILON) return null;
  const normal = planeNormal.clone().multiplyScalar(1 / normalLength);
  const signedDistance = new THREE.Vector3().subVectors(point, planePoint).dot(normal);
  return {
    point: point.clone().addScaledVector(normal, -signedDistance),
    signedDistance,
    distance: Math.abs(signedDistance),
    normal,
  };
}

function closestPointOnDegenerateTriangle(
  point: THREE.Vector3,
  triangle: Triangle3,
): TriangleProjection {
  const edges: Array<readonly [number, number]> = [[0, 1], [1, 2], [2, 0]];
  let best: TriangleProjection | null = null;
  for (const [startIndex, endIndex] of edges) {
    const projection = closestPointOnSegment(
      point,
      triangle[startIndex],
      triangle[endIndex],
    );
    const barycentric: [number, number, number] = [0, 0, 0];
    barycentric[startIndex] = 1 - projection.parameter;
    barycentric[endIndex] = projection.parameter;
    const candidate: TriangleProjection = {
      point: projection.point,
      barycentric,
      distance: projection.distance,
      distanceSquared: projection.distanceSquared,
      feature: featureForBarycentric(barycentric),
    };
    if (!best || candidate.distanceSquared < best.distanceSquared) best = candidate;
  }
  return best!;
}

/** Closest point on a filled triangle using exact Voronoi-region tests. */
export function closestPointOnTriangle(
  point: THREE.Vector3,
  triangle: Triangle3,
): TriangleProjection {
  const [a, b, c] = triangle;
  const ab = new THREE.Vector3().subVectors(b, a);
  const ac = new THREE.Vector3().subVectors(c, a);
  if (new THREE.Vector3().crossVectors(ab, ac).lengthSq() <= EPSILON) {
    return closestPointOnDegenerateTriangle(point, triangle);
  }

  const ap = new THREE.Vector3().subVectors(point, a);
  const d1 = ab.dot(ap);
  const d2 = ac.dot(ap);
  let barycentric: [number, number, number];

  if (d1 <= 0 && d2 <= 0) {
    barycentric = [1, 0, 0];
  } else {
    const bp = new THREE.Vector3().subVectors(point, b);
    const d3 = ab.dot(bp);
    const d4 = ac.dot(bp);
    if (d3 >= 0 && d4 <= d3) {
      barycentric = [0, 1, 0];
    } else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        barycentric = [1 - v, v, 0];
      } else {
        const cp = new THREE.Vector3().subVectors(point, c);
        const d5 = ab.dot(cp);
        const d6 = ac.dot(cp);
        if (d6 >= 0 && d5 <= d6) {
          barycentric = [0, 0, 1];
        } else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const w = d2 / (d2 - d6);
            barycentric = [1 - w, 0, w];
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
              barycentric = [0, 1 - w, w];
            } else {
              const denominator = 1 / (va + vb + vc);
              const v = vb * denominator;
              const w = vc * denominator;
              barycentric = [1 - v - w, v, w];
            }
          }
        }
      }
    }
  }

  const projected = a.clone()
    .multiplyScalar(barycentric[0])
    .addScaledVector(b, barycentric[1])
    .addScaledVector(c, barycentric[2]);
  const distanceSquared = projected.distanceToSquared(point);
  return {
    point: projected,
    barycentric,
    distance: Math.sqrt(distanceSquared),
    distanceSquared,
    feature: featureForBarycentric(barycentric),
  };
}

function segmentTriangleIntersection(
  start: THREE.Vector3,
  end: THREE.Vector3,
  triangle: Triangle3,
): THREE.Vector3 | null {
  const [a, b, c] = triangle;
  const direction = new THREE.Vector3().subVectors(end, start);
  const edge1 = new THREE.Vector3().subVectors(b, a);
  const edge2 = new THREE.Vector3().subVectors(c, a);
  const p = new THREE.Vector3().crossVectors(direction, edge2);
  const determinant = edge1.dot(p);
  if (Math.abs(determinant) <= EPSILON) return null;
  const inverse = 1 / determinant;
  const tVector = new THREE.Vector3().subVectors(start, a);
  const u = tVector.dot(p) * inverse;
  if (u < -1e-10 || u > 1 + 1e-10) return null;
  const q = new THREE.Vector3().crossVectors(tVector, edge1);
  const v = direction.dot(q) * inverse;
  if (v < -1e-10 || u + v > 1 + 1e-10) return null;
  const t = edge2.dot(q) * inverse;
  if (t < -1e-10 || t > 1 + 1e-10) return null;
  return start.clone().addScaledVector(direction, clamp01(t));
}

function withFeatures(
  pointA: THREE.Vector3,
  pointB: THREE.Vector3,
  featureA: ClosestFeature,
  featureB: ClosestFeature,
): ClosestPointPair {
  const distanceSquared = pointA.distanceToSquared(pointB);
  return {
    pointA,
    pointB,
    distance: Math.sqrt(distanceSquared),
    distanceSquared,
    featureA,
    featureB,
  };
}

/** Exact shortest witness points between two filled triangles. */
export function shortestDistanceBetweenTriangles(
  triangleA: Triangle3,
  triangleB: Triangle3,
): ClosestPointPair {
  const edges: Array<readonly [number, number]> = [[0, 1], [1, 2], [2, 0]];

  // A triangle edge can pierce the other face without approaching any of its
  // boundary edges, so test both directions explicitly before boundary pairs.
  for (const [start, end] of edges) {
    const point = segmentTriangleIntersection(triangleA[start], triangleA[end], triangleB);
    if (point) return withFeatures(point, point.clone(), 'intersection', 'intersection');
  }
  for (const [start, end] of edges) {
    const point = segmentTriangleIntersection(triangleB[start], triangleB[end], triangleA);
    if (point) return withFeatures(point.clone(), point, 'intersection', 'intersection');
  }

  let best: ClosestPointPair | null = null;
  const consider = (candidate: ClosestPointPair): void => {
    if (!best || candidate.distanceSquared < best.distanceSquared) best = candidate;
  };

  for (const vertex of triangleA) {
    const projection = closestPointOnTriangle(vertex, triangleB);
    consider(withFeatures(vertex.clone(), projection.point, 'vertex', projection.feature));
  }
  for (const vertex of triangleB) {
    const projection = closestPointOnTriangle(vertex, triangleA);
    consider(withFeatures(projection.point, vertex.clone(), projection.feature, 'vertex'));
  }
  for (const [aStart, aEnd] of edges) {
    for (const [bStart, bEnd] of edges) {
      consider(closestPointsBetweenSegments(
        triangleA[aStart],
        triangleA[aEnd],
        triangleB[bStart],
        triangleB[bEnd],
      ));
    }
  }
  return best!;
}

function triangleBounds(triangle: Triangle3): THREE.Box3 {
  return new THREE.Box3().setFromPoints([...triangle]);
}

function boxDistanceSquared(a: THREE.Box3, b: THREE.Box3): number {
  let result = 0;
  for (const axis of ['x', 'y', 'z'] as const) {
    const gap = Math.max(0, b.min[axis] - a.max[axis], a.min[axis] - b.max[axis]);
    result += gap * gap;
  }
  return result;
}

/**
 * Exact selected-object clearance over triangle sets. AABB lower bounds skip
 * pairs that cannot improve the current result; callers can later feed this
 * from a BVH without changing the witness-point contract.
 */
export function shortestDistanceBetweenTriangleSets(
  trianglesA: readonly Triangle3[],
  trianglesB: readonly Triangle3[],
): TriangleSetDistanceResult | null {
  if (trianglesA.length === 0 || trianglesB.length === 0) return null;
  const boundsA = trianglesA.map(triangleBounds);
  const boundsB = trianglesB.map(triangleBounds);
  let best: TriangleSetDistanceResult | null = null;
  let comparisons = 0;
  for (let indexA = 0; indexA < trianglesA.length; indexA++) {
    for (let indexB = 0; indexB < trianglesB.length; indexB++) {
      if (best && boxDistanceSquared(boundsA[indexA], boundsB[indexB]) > best.distanceSquared) {
        continue;
      }
      comparisons += 1;
      const candidate = shortestDistanceBetweenTriangles(
        trianglesA[indexA],
        trianglesB[indexB],
      );
      if (!best || candidate.distanceSquared < best.distanceSquared) {
        best = { ...candidate, triangleA: indexA, triangleB: indexB, comparisons };
        if (best.distanceSquared <= EPSILON) return best;
      }
    }
  }
  if (best) best.comparisons = comparisons;
  return best;
}

function normalizedUp(up: THREE.Vector3 | 'x' | 'y' | 'z'): THREE.Vector3 | null {
  const vector = typeof up === 'string'
    ? new THREE.Vector3(up === 'x' ? 1 : 0, up === 'y' ? 1 : 0, up === 'z' ? 1 : 0)
    : up.clone();
  return vector.lengthSq() <= EPSILON ? null : vector.normalize();
}

/** Signed and absolute height difference along a configurable project up axis. */
export function verticalHeightBetween(
  a: THREE.Vector3,
  b: THREE.Vector3,
  up: THREE.Vector3 | 'x' | 'y' | 'z' = 'y',
): VerticalHeightMeasurement | null {
  const upVector = normalizedUp(up);
  if (!upVector) return null;
  const signedHeight = new THREE.Vector3().subVectors(b, a).dot(upVector);
  return {
    sourceA: a.clone(),
    sourceB: b.clone(),
    dimensionStart: a.clone(),
    dimensionEnd: a.clone().addScaledVector(upVector, signedHeight),
    up: upVector,
    signedHeight,
    height: Math.abs(signedHeight),
  };
}

/**
 * Transform a world position into a project/local coordinate frame. Basis
 * inversion supports rotated and scaled frames and rejects singular axes.
 */
export function coordinateInFrame(
  point: THREE.Vector3,
  frame: CoordinateFrame,
): CoordinateMeasurement | null {
  const basis = new THREE.Matrix3().set(
    frame.xAxis.x, frame.yAxis.x, frame.zAxis.x,
    frame.xAxis.y, frame.yAxis.y, frame.zAxis.y,
    frame.xAxis.z, frame.yAxis.z, frame.zAxis.z,
  );
  if (Math.abs(basis.determinant()) <= EPSILON) return null;
  const local = new THREE.Vector3().subVectors(point, frame.origin).applyMatrix3(basis.invert());
  return {
    world: point.clone(),
    local,
    frame: {
      origin: frame.origin.clone(),
      xAxis: frame.xAxis.clone(),
      yAxis: frame.yAxis.clone(),
      zAxis: frame.zAxis.clone(),
    },
  };
}

export const WORLD_Y_UP_FRAME: CoordinateFrame = {
  origin: new THREE.Vector3(),
  xAxis: new THREE.Vector3(1, 0, 0),
  yAxis: new THREE.Vector3(0, 1, 0),
  zAxis: new THREE.Vector3(0, 0, 1),
};

export type ConstructionSnapKind =
  | 'endpoint'
  | 'vertex'
  | 'round-center'
  | 'midpoint'
  | 'axis'
  | 'edge'
  | 'face-center';

export type ConstructionSnapSource =
  | 'hit-triangle'
  | 'engine-point'
  | 'engine-line'
  | 'measurement-endpoint'
  | 'explicit-axis'
  | 'face-normal-axis'
  | 'bounds-axis'
  | 'explicit-round'
  | 'inferred-round';

export interface ConstructionSnapCandidate {
  kind: ConstructionSnapKind;
  point: THREE.Vector3;
  /** Screen distance from the pointer, used for a zoom-independent tolerance. */
  distancePx: number;
  /** Exact means the point follows explicit geometry/semantics, not an inferred object axis. */
  exact: boolean;
  source: ConstructionSnapSource;
  priority: number;
  featureId?: string;
}

export interface ProjectedWorldPoint {
  screen: THREE.Vector2;
  clipW: number;
  ndcZ: number;
}

export interface SegmentScreenProjection {
  point: THREE.Vector3;
  screen: THREE.Vector2;
  distancePx: number;
  /** Parametric position on the world segment, perspective-corrected. */
  parameter: number;
}

export interface Circumcircle3 {
  center: THREE.Vector3;
  radius: number;
  normal: THREE.Vector3;
}

export interface TriangleSnapOptions {
  includeVertices?: boolean;
  includeEdges?: boolean;
  includeMidpoints?: boolean;
  includeFaceCenter?: boolean;
}

const PRIORITY: Record<ConstructionSnapKind, number> = {
  // An existing measurement endpoint outranks raw geometry: chaining dimensions
  // and closing polygons exactly matters more than the vertex underneath it.
  endpoint: 110,
  vertex: 100,
  'round-center': 95,
  midpoint: 90,
  axis: 80,
  edge: 70,
  'face-center': 60,
};

function distancePointToSegment2D(
  point: THREE.Vector2,
  start: THREE.Vector2,
  end: THREE.Vector2,
): { lambda: number; point: THREE.Vector2; distance: number } {
  const direction = new THREE.Vector2().subVectors(end, start);
  const lengthSquared = direction.lengthSq();
  const lambda = lengthSquared <= 1e-12
    ? 0
    : Math.max(
      0,
      Math.min(1, new THREE.Vector2().subVectors(point, start).dot(direction) / lengthSquared),
    );
  const projected = start.clone().addScaledVector(direction, lambda);
  return { lambda, point: projected, distance: projected.distanceTo(point) };
}

/** Project a visible world point to canvas pixels without losing clip-space W. */
export function projectWorldPoint(
  point: THREE.Vector3,
  camera: THREE.Camera,
  canvasWidth: number,
  canvasHeight: number,
): ProjectedWorldPoint | null {
  if (canvasWidth <= 0 || canvasHeight <= 0) return null;
  const viewProjection = new THREE.Matrix4().multiplyMatrices(
    camera.projectionMatrix,
    camera.matrixWorldInverse,
  );
  const clip = new THREE.Vector4(point.x, point.y, point.z, 1).applyMatrix4(viewProjection);
  if (!Number.isFinite(clip.w) || clip.w <= 1e-12) return null;
  const ndcX = clip.x / clip.w;
  const ndcY = clip.y / clip.w;
  const ndcZ = clip.z / clip.w;
  if (!Number.isFinite(ndcX) || !Number.isFinite(ndcY) || ndcZ < -1 || ndcZ > 1) {
    return null;
  }
  return {
    screen: new THREE.Vector2(
      ((ndcX + 1) * 0.5) * canvasWidth,
      ((1 - ndcY) * 0.5) * canvasHeight,
    ),
    clipW: clip.w,
    ndcZ,
  };
}

/**
 * Closest cursor position on a projected 3D segment. The inverse mapping from
 * screen-line lambda to world parameter accounts for perspective clip W.
 */
export function closestScreenPointOnWorldSegment(
  start: THREE.Vector3,
  end: THREE.Vector3,
  cursorPx: THREE.Vector2,
  camera: THREE.Camera,
  canvasWidth: number,
  canvasHeight: number,
): SegmentScreenProjection | null {
  const projectedStart = projectWorldPoint(start, camera, canvasWidth, canvasHeight);
  const projectedEnd = projectWorldPoint(end, camera, canvasWidth, canvasHeight);
  if (!projectedStart || !projectedEnd) return null;
  const screenProjection = distancePointToSegment2D(
    cursorPx,
    projectedStart.screen,
    projectedEnd.screen,
  );
  const lambda = screenProjection.lambda;
  const denominator = lambda * projectedStart.clipW
    + (1 - lambda) * projectedEnd.clipW;
  const parameter = Math.abs(denominator) <= 1e-12
    ? lambda
    : (lambda * projectedStart.clipW) / denominator;
  return {
    point: start.clone().lerp(end, parameter),
    screen: screenProjection.point,
    distancePx: screenProjection.distance,
    parameter,
  };
}

function pointCandidate(
  kind: ConstructionSnapKind,
  point: THREE.Vector3,
  cursorPx: THREE.Vector2,
  camera: THREE.Camera,
  canvasWidth: number,
  canvasHeight: number,
  source: ConstructionSnapSource,
  exact: boolean,
  featureId?: string,
): ConstructionSnapCandidate | null {
  const projected = projectWorldPoint(point, camera, canvasWidth, canvasHeight);
  if (!projected) return null;
  return {
    kind,
    point: point.clone(),
    distancePx: projected.screen.distanceTo(cursorPx),
    exact,
    source,
    priority: PRIORITY[kind],
    featureId,
  };
}

function segmentCandidate(
  kind: 'edge' | 'axis',
  start: THREE.Vector3,
  end: THREE.Vector3,
  cursorPx: THREE.Vector2,
  camera: THREE.Camera,
  canvasWidth: number,
  canvasHeight: number,
  source: ConstructionSnapSource,
  exact: boolean,
  featureId?: string,
): ConstructionSnapCandidate | null {
  const projected = closestScreenPointOnWorldSegment(
    start,
    end,
    cursorPx,
    camera,
    canvasWidth,
    canvasHeight,
  );
  if (!projected) return null;
  return {
    kind,
    point: projected.point,
    distancePx: projected.distancePx,
    exact,
    source,
    priority: PRIORITY[kind],
    featureId,
  };
}

/**
 * Generate vertex, edge, midpoint, and triangle-centroid candidates.
 *
 * SUPERSEDED by `engineSnapCandidates` for the live snap path: this only sees
 * one triangle (no snap on large faces), and `facePoints` is sometimes a full
 * N-gon face profile, so slicing three points invents a fake triangle.
 */
export function triangleSnapCandidates(
  facePoints: Float32Array | undefined,
  cursorPx: THREE.Vector2,
  camera: THREE.Camera,
  canvasWidth: number,
  canvasHeight: number,
  options: TriangleSnapOptions = {},
): ConstructionSnapCandidate[] {
  if (!facePoints || facePoints.length < 9) return [];
  const vertices = facePointsToVec3(facePoints).slice(0, 3);
  if (vertices.length !== 3) return [];
  const includeVertices = options.includeVertices ?? true;
  const includeEdges = options.includeEdges ?? true;
  const includeMidpoints = options.includeMidpoints ?? true;
  const includeFaceCenter = options.includeFaceCenter ?? true;
  const candidates: ConstructionSnapCandidate[] = [];
  const edges: Array<readonly [number, number]> = [[0, 1], [1, 2], [2, 0]];

  if (includeVertices) {
    vertices.forEach((vertex, index) => {
      const candidate = pointCandidate(
        'vertex', vertex, cursorPx, camera, canvasWidth, canvasHeight,
        'hit-triangle', true, `vertex-${index}`,
      );
      if (candidate) candidates.push(candidate);
    });
  }
  for (let index = 0; index < edges.length; index++) {
    const [startIndex, endIndex] = edges[index];
    const start = vertices[startIndex];
    const end = vertices[endIndex];
    if (includeEdges) {
      const candidate = segmentCandidate(
        'edge', start, end, cursorPx, camera, canvasWidth, canvasHeight,
        'hit-triangle', true, `edge-${startIndex}-${endIndex}`,
      );
      if (candidate) candidates.push(candidate);
    }
    if (includeMidpoints) {
      const candidate = pointCandidate(
        'midpoint', start.clone().lerp(end, 0.5), cursorPx, camera,
        canvasWidth, canvasHeight, 'hit-triangle', true,
        `midpoint-${startIndex}-${endIndex}`,
      );
      if (candidate) candidates.push(candidate);
    }
  }
  if (includeFaceCenter) {
    const center = vertices[0].clone().add(vertices[1]).add(vertices[2]).multiplyScalar(1 / 3);
    const candidate = pointCandidate(
      'face-center', center, cursorPx, camera, canvasWidth, canvasHeight,
      'hit-triangle', true, 'triangle-centroid',
    );
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

/** One hit from the fragments engine's snapping raycast, already in world space. */
export interface EngineSnapHit {
  /** Which primitive the engine matched. `face` carries no snap feature. */
  snappingClass: 'point' | 'line' | 'face';
  point: THREE.Vector3;
  /** Endpoints of the matched edge. Present on `line` hits. */
  edgeStart?: THREE.Vector3;
  edgeEnd?: THREE.Vector3;
}

/**
 * Snap candidates from the engine's `raycastWithSnapping`, which matches the
 * model's real point/line primitives in a frustum around the cursor. This is
 * what makes snapping work on large faces. `face` hits are skipped: their
 * point is the cursor's own surface projection (~0 px), so as a candidate it
 * would beat every real feature.
 */
export function engineSnapCandidates(
  hits: readonly EngineSnapHit[],
  cursorPx: THREE.Vector2,
  camera: THREE.Camera,
  canvasWidth: number,
  canvasHeight: number,
): ConstructionSnapCandidate[] {
  const candidates: ConstructionSnapCandidate[] = [];
  hits.forEach((hit, index) => {
    if (hit.snappingClass === 'point') {
      const candidate = pointCandidate(
        'vertex', hit.point, cursorPx, camera, canvasWidth, canvasHeight,
        'engine-point', true, `engine-vertex-${index}`,
      );
      if (candidate) candidates.push(candidate);
      return;
    }
    if (hit.snappingClass !== 'line') return;
    const { edgeStart, edgeEnd } = hit;
    if (!edgeStart || !edgeEnd) {
      // Line class with no reported edge: the hit point is still on an edge.
      const candidate = pointCandidate(
        'edge', hit.point, cursorPx, camera, canvasWidth, canvasHeight,
        'engine-line', true, `engine-edge-point-${index}`,
      );
      if (candidate) candidates.push(candidate);
      return;
    }
    // A real edge yields three CAD features: the two endpoints, its midpoint,
    // and the sliding closest-point along it.
    const along = segmentCandidate(
      'edge', edgeStart, edgeEnd, cursorPx, camera, canvasWidth, canvasHeight,
      'engine-line', true, `engine-edge-${index}`,
    );
    if (along) candidates.push(along);
    const midpoint = pointCandidate(
      'midpoint', edgeStart.clone().lerp(edgeEnd, 0.5), cursorPx, camera,
      canvasWidth, canvasHeight, 'engine-line', true, `engine-midpoint-${index}`,
    );
    if (midpoint) candidates.push(midpoint);
    [edgeStart, edgeEnd].forEach((end, endIndex) => {
      const candidate = pointCandidate(
        'vertex', end, cursorPx, camera, canvasWidth, canvasHeight,
        'engine-line', true, `engine-edge-end-${index}-${endIndex}`,
      );
      if (candidate) candidates.push(candidate);
    });
  });
  return candidates;
}

/**
 * Existing measurement endpoints as pixel-space candidates, ranked in the same
 * pool as geometry. A separate world-metre threshold was zoom-dependent and let
 * a far endpoint steal the snap from a vertex under the cursor.
 */
export function anchorSnapCandidates(
  anchors: readonly THREE.Vector3[],
  cursorPx: THREE.Vector2,
  camera: THREE.Camera,
  canvasWidth: number,
  canvasHeight: number,
): ConstructionSnapCandidate[] {
  const candidates: ConstructionSnapCandidate[] = [];
  anchors.forEach((anchor, index) => {
    const candidate = pointCandidate(
      'endpoint', anchor, cursorPx, camera, canvasWidth, canvasHeight,
      'measurement-endpoint', true, `anchor-${index}`,
    );
    if (candidate) candidates.push(candidate);
  });
  return candidates;
}

/**
 * Select within a pixel threshold. Geometry priority only breaks near-equal
 * screen hits, so a distant vertex cannot steal an obvious edge snap.
 */
export function selectBestSnapCandidate(
  candidates: readonly ConstructionSnapCandidate[],
  thresholdPx: number,
  priorityWindowPx = 2,
): ConstructionSnapCandidate | null {
  if (thresholdPx <= 0) return null;
  const eligible = candidates.filter(
    (candidate) => Number.isFinite(candidate.distancePx) && candidate.distancePx <= thresholdPx,
  );
  if (eligible.length === 0) return null;
  const closestDistance = Math.min(...eligible.map((candidate) => candidate.distancePx));
  const contenders = eligible.filter(
    (candidate) => candidate.distancePx <= closestDistance + Math.max(0, priorityWindowPx),
  );
  contenders.sort((a, b) =>
    b.priority - a.priority
    || a.distancePx - b.distancePx
    || Number(b.exact) - Number(a.exact)
    || (a.featureId ?? '').localeCompare(b.featureId ?? ''),
  );
  return contenders[0] ?? null;
}

export function snapToTriangleFeatures(
  facePoints: Float32Array | undefined,
  cursorPx: THREE.Vector2,
  camera: THREE.Camera,
  canvasWidth: number,
  canvasHeight: number,
  thresholdPx = 20,
  options: TriangleSnapOptions = {},
): ConstructionSnapCandidate | null {
  return selectBestSnapCandidate(
    triangleSnapCandidates(
      facePoints,
      cursorPx,
      camera,
      canvasWidth,
      canvasHeight,
      options,
    ),
    thresholdPx,
  );
}

/** Explicit BIM/grid/MEP axis segment candidate. */
export function axisSnapCandidate(
  start: THREE.Vector3,
  end: THREE.Vector3,
  cursorPx: THREE.Vector2,
  camera: THREE.Camera,
  canvasWidth: number,
  canvasHeight: number,
  options: { exact?: boolean; source?: ConstructionSnapSource; featureId?: string } = {},
): ConstructionSnapCandidate | null {
  return segmentCandidate(
    'axis', start, end, cursorPx, camera, canvasWidth, canvasHeight,
    options.source ?? 'explicit-axis', options.exact ?? true, options.featureId,
  );
}

/** Three inferred principal bounds axes, explicitly marked non-exact. */
export function boundsAxisSnapCandidates(
  bounds: THREE.Box3,
  cursorPx: THREE.Vector2,
  camera: THREE.Camera,
  canvasWidth: number,
  canvasHeight: number,
): ConstructionSnapCandidate[] {
  if (bounds.isEmpty()) return [];
  const center = bounds.getCenter(new THREE.Vector3());
  const segments: Array<readonly [THREE.Vector3, THREE.Vector3, string]> = [
    [new THREE.Vector3(bounds.min.x, center.y, center.z), new THREE.Vector3(bounds.max.x, center.y, center.z), 'bounds-x'],
    [new THREE.Vector3(center.x, bounds.min.y, center.z), new THREE.Vector3(center.x, bounds.max.y, center.z), 'bounds-y'],
    [new THREE.Vector3(center.x, center.y, bounds.min.z), new THREE.Vector3(center.x, center.y, bounds.max.z), 'bounds-z'],
  ];
  return segments.flatMap(([start, end, featureId]) => {
    const candidate = axisSnapCandidate(
      start,
      end,
      cursorPx,
      camera,
      canvasWidth,
      canvasHeight,
      { exact: false, source: 'bounds-axis', featureId },
    );
    return candidate ? [candidate] : [];
  });
}

/** Face-normal construction axis through a triangle centroid. */
export function faceNormalAxisSnapCandidate(
  facePoints: Float32Array | undefined,
  halfLength: number,
  cursorPx: THREE.Vector2,
  camera: THREE.Camera,
  canvasWidth: number,
  canvasHeight: number,
): ConstructionSnapCandidate | null {
  if (!facePoints || facePoints.length < 9 || halfLength <= 0) return null;
  const [a, b, c] = facePointsToVec3(facePoints);
  const normal = new THREE.Vector3()
    .crossVectors(new THREE.Vector3().subVectors(b, a), new THREE.Vector3().subVectors(c, a));
  if (normal.lengthSq() <= 1e-12) return null;
  normal.normalize();
  const center = a.clone().add(b).add(c).multiplyScalar(1 / 3);
  return axisSnapCandidate(
    center.clone().addScaledVector(normal, -halfLength),
    center.clone().addScaledVector(normal, halfLength),
    cursorPx,
    camera,
    canvasWidth,
    canvasHeight,
    { exact: true, source: 'face-normal-axis', featureId: 'triangle-normal' },
  );
}

/** Exact 3D circumcircle through three non-collinear sample points. */
export function circumcircleFromThreePoints(
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
): Circumcircle3 | null {
  const u = new THREE.Vector3().subVectors(b, a);
  const v = new THREE.Vector3().subVectors(c, a);
  const cross = new THREE.Vector3().crossVectors(u, v);
  const crossLengthSquared = cross.lengthSq();
  if (crossLengthSquared <= 1e-12) return null;
  const offset = new THREE.Vector3()
    .add(new THREE.Vector3().crossVectors(v, cross).multiplyScalar(u.lengthSq()))
    .add(new THREE.Vector3().crossVectors(cross, u).multiplyScalar(v.lengthSq()))
    .multiplyScalar(1 / (2 * crossLengthSquared));
  const center = a.clone().add(offset);
  return { center, radius: center.distanceTo(a), normal: cross.normalize() };
}

/**
 * Center candidate from an explicit circular primitive or an inferred
 * three-point fit. Inferred fits remain visibly non-exact in the contract.
 */
export function roundCenterSnapCandidate(
  circle: Circumcircle3,
  cursorPx: THREE.Vector2,
  camera: THREE.Camera,
  canvasWidth: number,
  canvasHeight: number,
  explicitRoundPrimitive: boolean,
  featureId?: string,
): ConstructionSnapCandidate | null {
  return pointCandidate(
    'round-center',
    circle.center,
    cursorPx,
    camera,
    canvasWidth,
    canvasHeight,
    explicitRoundPrimitive ? 'explicit-round' : 'inferred-round',
    explicitRoundPrimitive,
    featureId,
  );
}

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
