import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { padBox } from '../sectionBoxHelpers';

describe('padBox', () => {
  it('returns a new box (does not mutate input)', () => {
    const box = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(2, 4, 6));
    const result = padBox(box, 0.1);
    // Input unchanged
    expect(box.min.x).toBe(0);
    expect(box.max.x).toBe(2);
    // Result is a different object
    expect(result).not.toBe(box);
  });

  it('pads a unit cube by 10 %: each face shifts by 0.1', () => {
    const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    const result = padBox(box, 0.1);
    expect(result.min.x).toBeCloseTo(-1.2);
    expect(result.min.y).toBeCloseTo(-1.2);
    expect(result.min.z).toBeCloseTo(-1.2);
    expect(result.max.x).toBeCloseTo(1.2);
    expect(result.max.y).toBeCloseTo(1.2);
    expect(result.max.z).toBeCloseTo(1.2);
  });

  it('zero factor returns a clone identical to input', () => {
    const box = new THREE.Box3(new THREE.Vector3(-3, -2, -1), new THREE.Vector3(3, 2, 1));
    const result = padBox(box, 0);
    expect(result.min.x).toBeCloseTo(-3);
    expect(result.max.x).toBeCloseTo(3);
    expect(result.min.y).toBeCloseTo(-2);
    expect(result.max.y).toBeCloseTo(2);
  });

  it('asymmetric box: padding scales per-axis by that axis size', () => {
    // Box: x-size=2, y-size=10, z-size=4
    const box = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(2, 10, 4));
    const result = padBox(box, 0.1);
    // x: pad = 0.1 * 2 = 0.2 → min=-0.2, max=2.2
    expect(result.min.x).toBeCloseTo(-0.2);
    expect(result.max.x).toBeCloseTo(2.2);
    // y: pad = 0.1 * 10 = 1.0 → min=-1.0, max=11.0
    expect(result.min.y).toBeCloseTo(-1.0);
    expect(result.max.y).toBeCloseTo(11.0);
    // z: pad = 0.1 * 4 = 0.4 → min=-0.4, max=4.4
    expect(result.min.z).toBeCloseTo(-0.4);
    expect(result.max.z).toBeCloseTo(4.4);
  });

  it('factor=1 doubles each axis extent', () => {
    const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    const result = padBox(box, 1);
    // size per axis=2, pad=2 → min=-3, max=3
    expect(result.min.x).toBeCloseTo(-3);
    expect(result.max.x).toBeCloseTo(3);
  });

  it('result is a valid bounding box (min < max after padding)', () => {
    const box = new THREE.Box3(new THREE.Vector3(5, 5, 5), new THREE.Vector3(6, 7, 8));
    const result = padBox(box, 0.25);
    expect(result.min.x).toBeLessThan(result.max.x);
    expect(result.min.y).toBeLessThan(result.max.y);
    expect(result.min.z).toBeLessThan(result.max.z);
  });

  it('works on a zero-size (degenerate) box - result stays degenerate', () => {
    // A point box: min == max → size = 0 → pad = 0 → result unchanged
    const box = new THREE.Box3(new THREE.Vector3(3, 3, 3), new THREE.Vector3(3, 3, 3));
    const result = padBox(box, 0.1);
    expect(result.min.x).toBeCloseTo(3);
    expect(result.max.x).toBeCloseTo(3);
  });
});
