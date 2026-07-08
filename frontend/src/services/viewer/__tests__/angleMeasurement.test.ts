import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  computeAngleDeg,
  formatAngle,
  buildAngleArc,
} from '../measurementController';

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

describe('computeAngleDeg', () => {
  it('returns 90° for perpendicular arms', () => {
    const vertex = v(0, 0, 0);
    const arm1 = v(1, 0, 0);
    const arm2 = v(0, 1, 0);
    expect(computeAngleDeg(vertex, arm1, arm2)).toBeCloseTo(90, 5);
  });

  it('returns 0° for coincident arms', () => {
    const vertex = v(0, 0, 0);
    const arm1 = v(1, 0, 0);
    const arm2 = v(2, 0, 0);
    expect(computeAngleDeg(vertex, arm1, arm2)).toBeCloseTo(0, 5);
  });

  it('returns 180° for opposite arms', () => {
    const vertex = v(0, 0, 0);
    const arm1 = v(1, 0, 0);
    const arm2 = v(-1, 0, 0);
    expect(computeAngleDeg(vertex, arm1, arm2)).toBeCloseTo(180, 5);
  });

  it('returns 45° for 45-degree arms', () => {
    const vertex = v(0, 0, 0);
    const arm1 = v(1, 0, 0);
    const arm2 = v(1, 1, 0);
    expect(computeAngleDeg(vertex, arm1, arm2)).toBeCloseTo(45, 4);
  });

  it('handles non-unit arm lengths correctly', () => {
    const vertex = v(1, 1, 1);
    const arm1 = v(4, 1, 1); // arm length 3
    const arm2 = v(1, 6, 1); // arm length 5
    expect(computeAngleDeg(vertex, arm1, arm2)).toBeCloseTo(90, 5);
  });

  it('returns 0 when arm1 equals vertex (degenerate)', () => {
    const vertex = v(0, 0, 0);
    const arm2 = v(1, 0, 0);
    expect(computeAngleDeg(vertex, vertex, arm2)).toBe(0);
  });

  it('returns 0 when arm2 equals vertex (degenerate)', () => {
    const vertex = v(0, 0, 0);
    const arm1 = v(1, 0, 0);
    expect(computeAngleDeg(vertex, arm1, vertex)).toBe(0);
  });

  it('computes 60° for equilateral triangle vertex', () => {
    const vertex = v(0, 0, 0);
    const arm1 = v(1, 0, 0);
    const arm2 = v(0.5, Math.sqrt(3) / 2, 0);
    expect(computeAngleDeg(vertex, arm1, arm2)).toBeCloseTo(60, 4);
  });

  it('is symmetric: swapping arm1 and arm2 gives same angle', () => {
    const vertex = v(2, 3, 0);
    const arm1 = v(5, 3, 0);
    const arm2 = v(2, 7, 0);
    const a1 = computeAngleDeg(vertex, arm1, arm2);
    const a2 = computeAngleDeg(vertex, arm2, arm1);
    expect(a1).toBeCloseTo(a2, 10);
  });

  it('works in 3D (not just XY plane)', () => {
    const vertex = v(0, 0, 0);
    const arm1 = v(1, 0, 0);
    const arm2 = v(0, 0, 1);
    expect(computeAngleDeg(vertex, arm1, arm2)).toBeCloseTo(90, 5);
  });
});

describe('formatAngle', () => {
  it('formats 90 degrees', () => {
    expect(formatAngle(90)).toBe('90.0°');
  });

  it('formats 45.5 degrees', () => {
    expect(formatAngle(45.5)).toBe('45.5°');
  });

  it('formats 0 degrees', () => {
    expect(formatAngle(0)).toBe('0.0°');
  });

  it('formats 180 degrees', () => {
    expect(formatAngle(180)).toBe('180.0°');
  });

  it('rounds to 1 decimal place', () => {
    expect(formatAngle(33.333)).toBe('33.3°');
    expect(formatAngle(33.35)).toBe('33.4°');
  });
});

describe('buildAngleArc', () => {
  it('returns segments+1 points for non-degenerate input', () => {
    const vertex = v(0, 0, 0);
    const arm1 = v(1, 0, 0);
    const arm2 = v(0, 1, 0);
    const pts = buildAngleArc(vertex, arm1, arm2, 10);
    expect(pts.length).toBe(11);
  });

  it('returns empty array when arm1 equals vertex', () => {
    const vertex = v(0, 0, 0);
    expect(buildAngleArc(vertex, vertex, v(1, 0, 0), 10)).toHaveLength(0);
  });

  it('returns empty array when arm2 equals vertex', () => {
    const vertex = v(0, 0, 0);
    expect(buildAngleArc(vertex, v(1, 0, 0), vertex, 10)).toHaveLength(0);
  });

  it('arc points lie at the correct radius from vertex', () => {
    const vertex = v(0, 0, 0);
    const arm1 = v(2, 0, 0); // arm length 2 → radius = 0.25 * 2 = 0.5
    const arm2 = v(0, 2, 0);
    const pts = buildAngleArc(vertex, arm1, arm2, 10);
    const expectedRadius = 0.5;
    for (const p of pts) {
      expect(p.distanceTo(vertex)).toBeCloseTo(expectedRadius, 4);
    }
  });

  it('clamps radius to 0.05 minimum for very short arms', () => {
    const vertex = v(0, 0, 0);
    const arm1 = v(0.01, 0, 0); // very short arm → radius would be 0.0025, clamped to 0.05
    const arm2 = v(0, 0.01, 0);
    const pts = buildAngleArc(vertex, arm1, arm2, 4);
    expect(pts.length).toBe(5);
    const expectedRadius = 0.05;
    for (const p of pts) {
      expect(p.distanceTo(vertex)).toBeCloseTo(expectedRadius, 4);
    }
  });

  it('clamps radius to 0.5 maximum for very long arms', () => {
    const vertex = v(0, 0, 0);
    const arm1 = v(100, 0, 0);
    const arm2 = v(0, 100, 0);
    const pts = buildAngleArc(vertex, arm1, arm2, 4);
    const expectedRadius = 0.5;
    for (const p of pts) {
      expect(p.distanceTo(vertex)).toBeCloseTo(expectedRadius, 4);
    }
  });

  it('first and last arc points align with the two arm directions', () => {
    const vertex = v(0, 0, 0);
    const arm1 = v(3, 0, 0);
    const arm2 = v(0, 3, 0);
    const pts = buildAngleArc(vertex, arm1, arm2, 20);
    const first = pts[0];
    const last = pts[pts.length - 1];
    // first point should be in the arm1 direction (positive X)
    expect(first.x).toBeGreaterThan(0);
    expect(first.y).toBeCloseTo(0, 3);
    // last point should be in the arm2 direction (positive Y)
    expect(last.y).toBeGreaterThan(0);
    expect(last.x).toBeCloseTo(0, 3);
  });
});
