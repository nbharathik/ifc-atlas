import * as THREE from 'three';
import { describe, it, expect } from 'vitest';
import { axisNormal, projectOntoAxis, axisOriginForOffset } from '../clipPlanes';

// Helpers
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const almostEq = (a: number, b: number) => Math.abs(a - b) < 1e-10;

describe('axisNormal', () => {
  it('y axis not inverted → points down (−Y = kept side is below)', () => {
    const n = axisNormal('y', false);
    expect(n.x).toBe(0);
    expect(n.y).toBe(-1);
    expect(n.z).toBe(0);
  });

  it('y axis inverted → points up (+Y)', () => {
    const n = axisNormal('y', true);
    expect(n.y).toBe(1);
  });

  it('x axis not inverted → normal is −X', () => {
    const n = axisNormal('x', false);
    expect(n.x).toBe(-1);
    expect(n.y).toBe(0);
    expect(n.z).toBe(0);
  });

  it('x axis inverted → normal is +X', () => {
    expect(axisNormal('x', true).x).toBe(1);
  });

  it('z axis not inverted → normal is −Z', () => {
    expect(axisNormal('z', false).z).toBe(-1);
  });

  it('z axis inverted → normal is +Z', () => {
    expect(axisNormal('z', true).z).toBe(1);
  });

  it('returns unit vectors (length = 1)', () => {
    for (const axis of ['x', 'y', 'z'] as const) {
      for (const inv of [false, true]) {
        expect(almostEq(axisNormal(axis, inv).length(), 1)).toBe(true);
      }
    }
  });

  it('inverted and non-inverted normals are antiparallel', () => {
    for (const axis of ['x', 'y', 'z'] as const) {
      const a = axisNormal(axis, false);
      const b = axisNormal(axis, true);
      expect(almostEq(a.dot(b), -1)).toBe(true);
    }
  });
});

describe('projectOntoAxis', () => {
  const centre = v(10, 20, 30);

  it('x axis: returns origin.x - centre.x', () => {
    expect(projectOntoAxis('x', v(13, 99, 99), centre)).toBe(3);
  });

  it('y axis: returns origin.y - centre.y', () => {
    expect(projectOntoAxis('y', v(99, 24, 99), centre)).toBe(4);
  });

  it('z axis: returns origin.z - centre.z', () => {
    expect(projectOntoAxis('z', v(99, 99, 25), centre)).toBe(-5);
  });

  it('returns zero when origin equals centre', () => {
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(projectOntoAxis(axis, centre.clone(), centre)).toBe(0);
    }
  });

  it('returns negative offset correctly', () => {
    expect(projectOntoAxis('y', v(0, 15, 0), centre)).toBe(-5);
  });
});

describe('axisOriginForOffset', () => {
  const centre = v(0, 0, 0);

  it('x axis: shifts only X', () => {
    const o = axisOriginForOffset('x', centre, 5);
    expect(o.x).toBe(5);
    expect(o.y).toBe(0);
    expect(o.z).toBe(0);
  });

  it('y axis: shifts only Y', () => {
    const o = axisOriginForOffset('y', centre, -3);
    expect(o.x).toBe(0);
    expect(o.y).toBe(-3);
    expect(o.z).toBe(0);
  });

  it('z axis: shifts only Z', () => {
    const o = axisOriginForOffset('z', centre, 7);
    expect(o.z).toBe(7);
    expect(o.x).toBe(0);
    expect(o.y).toBe(0);
  });

  it('does not mutate the centre vector', () => {
    const c = v(1, 2, 3);
    axisOriginForOffset('y', c, 100);
    expect(c.y).toBe(2);
  });

  it('zero offset returns clone of centre', () => {
    const c = v(4, 5, 6);
    const o = axisOriginForOffset('x', c, 0);
    expect(o.x).toBe(4);
    expect(o.y).toBe(5);
    expect(o.z).toBe(6);
    expect(o).not.toBe(c);
  });
});

describe('round-trip invariant: projectOntoAxis(axisOriginForOffset) === offset', () => {
  const centre = v(1.5, -2.7, 100);
  const offsets = [-50, -1, 0, 0.001, 3.14, 42];

  for (const axis of ['x', 'y', 'z'] as const) {
    for (const d of offsets) {
      it(`axis=${axis} offset=${d}`, () => {
        const origin = axisOriginForOffset(axis, centre, d);
        const back = projectOntoAxis(axis, origin, centre);
        expect(almostEq(back, d)).toBe(true);
      });
    }
  }
});
