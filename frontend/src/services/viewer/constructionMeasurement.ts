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
