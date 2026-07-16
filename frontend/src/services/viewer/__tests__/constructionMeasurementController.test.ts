import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import {
  MeasurementController,
  type MeasurementSnapshot,
} from '../measurementController';

const v = (x: number, y: number, z: number): THREE.Vector3 =>
  new THREE.Vector3(x, y, z);

function createController(): {
  controller: MeasurementController;
  scene: THREE.Scene;
  changes: MeasurementSnapshot[];
} {
  const scene = new THREE.Scene();
  const changes: MeasurementSnapshot[] = [];
  const model = {} as ConstructorParameters<typeof MeasurementController>[1];
  const controller = new MeasurementController(scene, model, {
    onChange: (snapshot) => changes.push(snapshot),
  });
  return { controller, scene, changes };
}

describe('MeasurementController construction-measurement bridge', () => {
  it('commits exact precomputed witness points with additive provenance', () => {
    const { controller, changes } = createController();
    const source = v(1, 2, 3);
    const witness = v(1, 7, 3);

    const measurement = controller.addLinearMeasurement(source, witness, {
      subtype: 'perpendicular',
      exact: true,
      source: 'point-to-plane',
    });

    expect(measurement).not.toBeNull();
    expect(measurement).toMatchObject({
      kind: 'linear',
      value: 5,
      subtype: 'perpendicular',
      exact: true,
      source: 'point-to-plane',
    });
    expect(measurement!.timestamp).toBeTruthy();
    expect(measurement!.points[0]).not.toBe(source);
    expect(measurement!.points[1]).not.toBe(witness);
    expect(changes).toHaveLength(1);
    expect(changes[0].committed[0]).toBe(measurement);

    source.set(100, 100, 100);
    witness.set(200, 200, 200);
    expect(measurement!.points[0]).toEqual(expect.objectContaining({ x: 1, y: 2, z: 3 }));
    expect(measurement!.points[1]).toEqual(expect.objectContaining({ x: 1, y: 7, z: 3 }));
    controller.dispose();
  });

  it('does not disturb the active pointer mode or its pending point', () => {
    const { controller } = createController();
    controller.setMode('linear');
    controller.handleClick(v(10, 0, 0));

    const measurement = controller.addLinearMeasurement(v(0, 0, 0), v(0, 0, 3), {
      subtype: 'shortest',
      exact: true,
      source: 'triangle-pair',
    });
    const snapshot = controller.snapshot();

    expect(measurement?.value).toBeCloseTo(3);
    expect(snapshot.mode).toBe('linear');
    expect(snapshot.pending).toHaveLength(1);
    expect(snapshot.pending[0]).toEqual(expect.objectContaining({ x: 10, y: 0, z: 0 }));
    expect(snapshot.committed).toHaveLength(1);
    controller.dispose();
  });

  it('rejects non-finite witness coordinates without changing scene state', () => {
    const { controller, changes } = createController();
    expect(controller.addLinearMeasurement(v(0, 0, 0), v(Number.NaN, 0, 0))).toBeNull();
    expect(controller.addLinearMeasurement(v(0, 0, 0), v(Number.POSITIVE_INFINITY, 0, 0))).toBeNull();
    expect(controller.snapshot().committed).toEqual([]);
    expect(changes).toEqual([]);
    controller.dispose();
  });

  it('commits a two-click project-up height with constrained witness geometry', () => {
    const { controller } = createController();
    controller.setMode('height');
    controller.handleClick(v(2, 1, 4));
    controller.handleMove(v(8, 6, 9));
    controller.handleClick(v(8, 6, 9));

    const measurement = controller.snapshot().committed[0];
    expect(measurement).toMatchObject({
      kind: 'height',
      value: 5,
      signedValue: 5,
      exact: true,
      source: 'project-y-axis',
    });
    expect(measurement.points[0]).toEqual(expect.objectContaining({ x: 2, y: 1, z: 4 }));
    expect(measurement.points[1]).toEqual(expect.objectContaining({ x: 2, y: 6, z: 4 }));
    expect(measurement.sourcePoints?.[1]).toEqual(
      expect.objectContaining({ x: 8, y: 6, z: 9 }),
    );
    expect(controller.snapshot().pending).toEqual([]);
    controller.dispose();
  });

  it('commits the exact snap preview as a one-click coordinate marker', () => {
    const { controller } = createController();
    const snapped = v(1.25, 2.5, 3.75);
    controller.setMode('position');
    controller.handleMove(v(1.2, 2.45, 3.7), {
      point: snapped,
      kind: 'midpoint',
      exact: true,
      source: 'triangle-edge-midpoint',
    });

    const preview = controller.snapshot().snapFeedback;
    expect(preview).toMatchObject({
      kind: 'midpoint',
      exact: true,
      source: 'triangle-edge-midpoint',
    });
    controller.handleClick(v(1.2, 2.45, 3.7));

    const measurement = controller.snapshot().committed[0];
    expect(measurement).toMatchObject({
      kind: 'position',
      snapKind: 'midpoint',
      exact: true,
      source: 'triangle-edge-midpoint',
    });
    expect(measurement.points[0]).toEqual(
      expect.objectContaining({ x: 1.25, y: 2.5, z: 3.75 }),
    );
    expect(measurement.coordinates?.local).toEqual(
      expect.objectContaining({ x: 1.25, y: 2.5, z: 3.75 }),
    );
    expect(controller.snapshot().snapFeedback).toBeNull();
    controller.dispose();
  });

  it('accepts construction snap candidates directly and normalises centre kinds', () => {
    const { controller } = createController();
    controller.setMode('position');
    controller.handleMove(v(4, 5, 6), {
      point: v(4.1, 5.1, 6.1),
      kind: 'round-center',
      distancePx: 3,
      exact: true,
      source: 'explicit-round',
      priority: 95,
    });

    expect(controller.snapshot().snapFeedback).toMatchObject({
      kind: 'centre',
      exact: true,
      source: 'explicit-round',
    });
    controller.handleClick(v(4, 5, 6));
    expect(controller.snapshot().committed[0]).toMatchObject({
      kind: 'position',
      snapKind: 'centre',
      source: 'explicit-round',
    });
    controller.dispose();
  });

  it('adds exact clearance witnesses without disturbing pending interaction state', () => {
    const { controller } = createController();
    controller.setMode('area');
    controller.handleClick(v(10, 0, 0));

    const clearance = controller.addWitnessMeasurement(
      'clearance',
      v(0, 0, 0),
      v(0, 0.25, 0),
      { exact: true, source: 'triangle-pair', snapKind: 'face' },
    );

    expect(clearance).toMatchObject({
      kind: 'clearance',
      value: 0.25,
      exact: true,
      source: 'triangle-pair',
      snapKind: 'face',
    });
    expect(controller.snapshot().mode).toBe('area');
    expect(controller.snapshot().pending).toHaveLength(1);
    controller.dispose();
  });
});
