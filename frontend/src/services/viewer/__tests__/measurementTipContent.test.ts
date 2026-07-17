import { describe, expect, it } from 'vitest';
import { buildMeasurementTip } from '../measurementTipContent';
import type { MeasurementLiveReadout } from '../measurementController';

const BASE: MeasurementLiveReadout = {
  mode: 'linear',
  pendingCount: 0,
  hasCursor: false,
  value: null,
  perimeter: null,
  angleDeg: null,
  slopeDeg: null,
  cursorWorld: null,
  snapKind: null,
  snapExact: false,
};

describe('buildMeasurementTip', () => {
  it('returns null when no tool is armed', () => {
    expect(buildMeasurementTip({ ...BASE, mode: 'off' }, 'm')).toBeNull();
  });

  it('shows a step hint until a value exists', () => {
    const tip = buildMeasurementTip(BASE, 'm')!;
    expect(tip.primary).toBeNull();
    expect(tip.hint).toBe('Click start point');

    const second = buildMeasurementTip({ ...BASE, pendingCount: 1 }, 'm')!;
    expect(second.hint).toBe('Click end point');
  });

  it('formats a live distance with slope for linear mode', () => {
    const tip = buildMeasurementTip(
      { ...BASE, pendingCount: 1, hasCursor: true, value: 2.5, slopeDeg: 12.34 },
      'm',
    )!;
    expect(tip.primary).toBe('2.500 m');
    expect(tip.secondary).toBe('slope 12.3°');
    expect(tip.hint).toBeNull();
  });

  it('formats area with perimeter for polygon and rectangle modes', () => {
    const tip = buildMeasurementTip(
      { ...BASE, mode: 'area', pendingCount: 3, value: 12, perimeter: 14 },
      'm',
    )!;
    expect(tip.primary).toBe('12.000 m²');
    expect(tip.secondary).toBe('14.000 m');
  });

  it('formats the live angle in angle mode', () => {
    const tip = buildMeasurementTip(
      { ...BASE, mode: 'angle', pendingCount: 2, angleDeg: 90 },
      'm',
    )!;
    expect(tip.primary).toBe('90.0°');
  });

  it('shows cursor coordinates in position mode', () => {
    const tip = buildMeasurementTip(
      { ...BASE, mode: 'position', cursorWorld: { x: 1, y: 2, z: 3 } },
      'm',
    )!;
    expect(tip.primary).toContain('X 1.000');
    expect(tip.primary).toContain('Z 3.000');
  });

  it('carries the snap kind and exactness through', () => {
    const tip = buildMeasurementTip(
      { ...BASE, snapKind: 'vertex', snapExact: true },
      'm',
    )!;
    expect(tip.snap).toEqual({ label: 'Vertex', exact: true });
  });

  it('respects the unit for lengths', () => {
    const tip = buildMeasurementTip(
      { ...BASE, pendingCount: 1, value: 1 },
      'mm',
    )!;
    expect(tip.primary).toBe('1000.0 mm');
  });
});

describe('MeasurementController.liveReadout', () => {
  it('reports slope for an inclined linear segment', async () => {
    const THREE = await import('three');
    const { MeasurementController } = await import('../measurementController');
    const model = {} as ConstructorParameters<typeof MeasurementController>[1];
    const controller = new MeasurementController(new THREE.Scene(), model, {
      onChange: () => {},
    });
    controller.setMode('linear');
    controller.handleClick(new THREE.Vector3(0, 0, 0));
    controller.handleMove(new THREE.Vector3(1, 1, 0), null);

    const readout = controller.liveReadout();
    expect(readout.value).toBeCloseTo(Math.SQRT2, 5);
    expect(readout.slopeDeg).toBeCloseTo(45, 5);
    controller.dispose();
  });
});
