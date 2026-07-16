import * as THREE from 'three';

import { facePointsToVec3 } from './vertexSnapHelpers';

export type ConstructionSnapKind =
  | 'vertex'
  | 'round-center'
  | 'midpoint'
  | 'axis'
  | 'edge'
  | 'face-center';

export type ConstructionSnapSource =
  | 'hit-triangle'
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

/** Generate vertex, edge, midpoint, and triangle-centroid candidates. */
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
