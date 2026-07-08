import { describe, it, expect } from 'vitest';
import {
  measurementsToCsv,
  toDisplayValue,
  unitLabel,
} from '../measurementsExport';
import type { CommittedMeasurement } from '../measurementController';
import * as THREE from 'three';

function makeMeasurement(
  id: string,
  kind: 'linear' | 'area' | 'angle',
  value: number,
  timestamp = '2026-01-01T00:00:00.000Z',
): CommittedMeasurement {
  return {
    id,
    kind,
    points: [new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0)],
    value,
    timestamp,
  };
}

describe('measurementsToCsv', () => {
  it('produces a header row with 5 columns', () => {
    const csv = measurementsToCsv([], 'm');
    expect(csv).toBe('index,kind,value,unit,timestamp');
  });

  it('produces one data row per measurement', () => {
    const ms = [
      makeMeasurement('a', 'linear', 3.5),
      makeMeasurement('b', 'area', 12.0),
    ];
    const rows = measurementsToCsv(ms, 'm').split('\n');
    expect(rows).toHaveLength(3); // header + 2 data rows
  });

  it('indexes measurements from 1', () => {
    const ms = [makeMeasurement('x', 'linear', 1.0)];
    const rows = measurementsToCsv(ms, 'm').split('\n');
    expect(rows[1]).toMatch(/^1,/);
  });

  it('writes linear unit as "m" for metre mode', () => {
    const ms = [makeMeasurement('x', 'linear', 1.5)];
    const row = measurementsToCsv(ms, 'm').split('\n')[1];
    const parts = row.split(',');
    expect(parts[3]).toBe('m');
  });

  it('writes linear unit as "mm" for millimetre mode', () => {
    const ms = [makeMeasurement('x', 'linear', 1.5)];
    const row = measurementsToCsv(ms, 'mm').split('\n')[1];
    const parts = row.split(',');
    expect(parts[3]).toBe('mm');
  });

  it('writes linear unit as "ft" for feet mode', () => {
    const ms = [makeMeasurement('x', 'linear', 1.5)];
    const row = measurementsToCsv(ms, 'ft').split('\n')[1];
    const parts = row.split(',');
    expect(parts[3]).toBe('ft');
  });

  it('writes area unit as "m²" for metre mode', () => {
    const ms = [makeMeasurement('x', 'area', 4.0)];
    const row = measurementsToCsv(ms, 'm').split('\n')[1];
    const parts = row.split(',');
    expect(parts[3]).toBe('m²');
  });

  it('writes kind column correctly', () => {
    const lin = makeMeasurement('a', 'linear', 1.0);
    const area = makeMeasurement('b', 'area', 2.0);
    const rows = measurementsToCsv([lin, area], 'm').split('\n');
    expect(rows[1].split(',')[1]).toBe('linear');
    expect(rows[2].split(',')[1]).toBe('area');
  });

  it('value column is numeric-only (no unit suffix)', () => {
    const ms = [makeMeasurement('x', 'linear', 2.5)];
    const row = measurementsToCsv(ms, 'm').split('\n')[1];
    const parts = row.split(',');
    expect(parts[2]).toMatch(/^[\d.]+$/);
  });

  it('timestamp column matches the measurement timestamp', () => {
    const ts = '2026-05-04T12:00:00.000Z';
    const ms = [makeMeasurement('x', 'linear', 1.0, ts)];
    const row = measurementsToCsv(ms, 'm').split('\n')[1];
    const parts = row.split(',');
    // timestamp is the 5th column (index 4)
    expect(parts[4]).toBe(ts);
  });

  it('empty list produces only header', () => {
    expect(measurementsToCsv([], 'm')).toBe('index,kind,value,unit,timestamp');
  });

  it('is deterministic for same inputs', () => {
    const ms = [makeMeasurement('x', 'linear', 1.23)];
    expect(measurementsToCsv(ms, 'm')).toBe(measurementsToCsv(ms, 'm'));
  });

  it('converts mm linear correctly (×1000)', () => {
    const ms = [makeMeasurement('x', 'linear', 1.0)];
    const row = measurementsToCsv(ms, 'mm').split('\n')[1];
    const parts = row.split(',');
    expect(parseFloat(parts[2])).toBeCloseTo(1000, 0);
  });

  it('converts ft linear correctly (×3.28084)', () => {
    const ms = [makeMeasurement('x', 'linear', 1.0)];
    const row = measurementsToCsv(ms, 'ft').split('\n')[1];
    const parts = row.split(',');
    expect(parseFloat(parts[2])).toBeCloseTo(3.28084, 3);
  });

  it('converts mm² area correctly (×1_000_000)', () => {
    const ms = [makeMeasurement('x', 'area', 1.0)];
    const row = measurementsToCsv(ms, 'mm').split('\n')[1];
    const parts = row.split(',');
    expect(parseFloat(parts[2])).toBeCloseTo(1_000_000, 0);
  });
});

describe('toDisplayValue', () => {
  const lin1m = makeMeasurement('a', 'linear', 1.0);
  const area1m2 = makeMeasurement('b', 'area', 1.0);

  it('linear m → 1.0', () => expect(toDisplayValue(lin1m, 'm')).toBe(1.0));
  it('linear mm → 1000', () => expect(toDisplayValue(lin1m, 'mm')).toBe(1000));
  it('linear ft → ~3.28084', () => expect(toDisplayValue(lin1m, 'ft')).toBeCloseTo(3.28084, 4));
  it('area m → 1.0', () => expect(toDisplayValue(area1m2, 'm')).toBe(1.0));
  it('area mm → 1_000_000', () => expect(toDisplayValue(area1m2, 'mm')).toBe(1_000_000));
  it('area ft → ~10.7639', () => expect(toDisplayValue(area1m2, 'ft')).toBeCloseTo(10.7639, 3));
});

describe('unitLabel', () => {
  const lin = makeMeasurement('a', 'linear', 1.0);
  const area = makeMeasurement('b', 'area', 1.0);
  const ang = makeMeasurement('c', 'angle', 90.0);

  it('linear m → m', () => expect(unitLabel(lin, 'm')).toBe('m'));
  it('linear mm → mm', () => expect(unitLabel(lin, 'mm')).toBe('mm'));
  it('linear ft → ft', () => expect(unitLabel(lin, 'ft')).toBe('ft'));
  it('area m → m²', () => expect(unitLabel(area, 'm')).toBe('m²'));
  it('area mm → mm²', () => expect(unitLabel(area, 'mm')).toBe('mm²'));
  it('area ft → ft²', () => expect(unitLabel(area, 'ft')).toBe('ft²'));
  it('angle → deg (unit-independent)', () => {
    expect(unitLabel(ang, 'm')).toBe('deg');
    expect(unitLabel(ang, 'mm')).toBe('deg');
    expect(unitLabel(ang, 'ft')).toBe('deg');
  });
});

describe('toDisplayValue - angle kind', () => {
  const ang = makeMeasurement('a', 'angle', 45.0);

  it('angle value is passed through unchanged regardless of unit', () => {
    expect(toDisplayValue(ang, 'm')).toBe(45.0);
    expect(toDisplayValue(ang, 'mm')).toBe(45.0);
    expect(toDisplayValue(ang, 'ft')).toBe(45.0);
  });
});

describe('measurementsToCsv - angle kind', () => {
  it('writes kind as "angle"', () => {
    const ms = [makeMeasurement('x', 'angle', 90.0)];
    const row = measurementsToCsv(ms, 'm').split('\n')[1];
    expect(row.split(',')[1]).toBe('angle');
  });

  it('writes unit as "deg" for angle', () => {
    const ms = [makeMeasurement('x', 'angle', 90.0)];
    const row = measurementsToCsv(ms, 'm').split('\n')[1];
    expect(row.split(',')[3]).toBe('deg');
  });

  it('writes angle value with 1 decimal', () => {
    const ms = [makeMeasurement('x', 'angle', 45.56)];
    const row = measurementsToCsv(ms, 'm').split('\n')[1];
    expect(row.split(',')[2]).toBe('45.6');
  });

  it('angle value unchanged when unit is mm or ft', () => {
    const ms = [makeMeasurement('x', 'angle', 30.0)];
    const rowM = measurementsToCsv(ms, 'm').split('\n')[1];
    const rowMm = measurementsToCsv(ms, 'mm').split('\n')[1];
    const rowFt = measurementsToCsv(ms, 'ft').split('\n')[1];
    expect(rowM.split(',')[2]).toBe('30.0');
    expect(rowMm.split(',')[2]).toBe('30.0');
    expect(rowFt.split(',')[2]).toBe('30.0');
  });

  it('mixed linear+angle list is serialised in order', () => {
    const ms = [
      makeMeasurement('a', 'linear', 2.0),
      makeMeasurement('b', 'angle', 90.0),
    ];
    const rows = measurementsToCsv(ms, 'm').split('\n');
    expect(rows[1].split(',')[1]).toBe('linear');
    expect(rows[2].split(',')[1]).toBe('angle');
  });
});
