import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

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
