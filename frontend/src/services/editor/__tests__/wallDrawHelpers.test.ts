import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WALL_HEIGHT_M,
  DEFAULT_WALL_THICKNESS_M,
  GRID_SNAP_M,
  formatWallLength,
  ifcElevationToWorldY,
  ifcXYToWorldXZ,
  lowestStorey,
  parseDimension,
  snapIfcXY,
  snapValue,
  wallLengthM,
  worldToIfcXY,
  type IfcXY,
} from '../wallDrawHelpers';

describe('coordinate conversion (viewer Y-up ↔ IFC Z-up)', () => {
  it('matches the backend bcf_service test vector: viewer (1,2,3) → IFC (1,-3,2)', () => {
    // backend/tests/test_bcf_service.py pins viewer_to_ifc_coords((1,2,3)) == [1,-3,2].
    // XY comes from world x/z, elevation (IFC z) from world y.
    expect(worldToIfcXY(1, 3)).toEqual([1, -3]);
    expect(ifcElevationToWorldY(2)).toBe(2);
  });

  it('is an exact round trip', () => {
    const [ifcX, ifcY] = worldToIfcXY(12.5, -7.25);
    expect(ifcXYToWorldXZ(ifcX, ifcY)).toEqual([12.5, -7.25]);
  });

  it('maps the origin to the origin', () => {
    expect(worldToIfcXY(0, 0)).toEqual([0, 0]);
    expect(ifcXYToWorldXZ(0, 0)).toEqual([0, 0]);
  });

  it('world +z is IFC −y (south of the IFC origin)', () => {
    expect(worldToIfcXY(0, 5)).toEqual([0, -5]);
    expect(ifcXYToWorldXZ(0, 5)).toEqual([0, -5]);
  });
});

describe('snapValue', () => {
  it('rounds to the nearest step', () => {
    expect(snapValue(0.14, 0.1)).toBe(0.1);
    expect(snapValue(0.15, 0.1)).toBe(0.2);
    expect(snapValue(3.0, 0.1)).toBe(3.0);
  });

  it('handles negative coordinates', () => {
    expect(snapValue(-0.14, 0.1)).toBe(-0.1);
    expect(snapValue(-0.16, 0.1)).toBe(-0.2);
  });

  it('erases IEEE float noise so backend params are exact', () => {
    expect(snapValue(0.30000000000000004, 0.1)).toBe(0.3);
    expect(snapValue(2.9000000000000004, 0.1)).toBe(2.9);
  });

  it('is the identity for a non-positive or non-finite step', () => {
    expect(snapValue(0.14159, 0)).toBe(0.14159);
    expect(snapValue(0.14159, -1)).toBe(0.14159);
    expect(snapValue(0.14159, Number.NaN)).toBe(0.14159);
  });

  it('passes non-finite values through untouched', () => {
    expect(snapValue(Number.NaN, 0.1)).toBeNaN();
    expect(snapValue(Number.POSITIVE_INFINITY, 0.1)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('snapIfcXY', () => {
  it('snaps both components with the default 0.1 m grid', () => {
    expect(GRID_SNAP_M).toBe(0.1);
    expect(snapIfcXY([1.04, -2.26])).toEqual([1.0, -2.3]);
  });

  it('accepts an explicit step', () => {
    expect(snapIfcXY([1.3, 1.8], 0.5)).toEqual([1.5, 2.0]);
  });
});

describe('wallLengthM', () => {
  it('computes euclidean length (3-4-5 triangle)', () => {
    expect(wallLengthM([0, 0], [3, 4])).toBe(5);
  });

  it('is zero for identical points', () => {
    const p: IfcXY = [2.5, -1.5];
    expect(wallLengthM(p, p)).toBe(0);
  });
});

describe('formatWallLength', () => {
  it('renders two decimals with a unit suffix', () => {
    expect(formatWallLength(3.4000001)).toBe('3.40 m');
    expect(formatWallLength(0.1)).toBe('0.10 m');
    expect(formatWallLength(12)).toBe('12.00 m');
  });
});

describe('lowestStorey', () => {
  it('returns the lowest-elevation storey (backend find_storey default)', () => {
    const storeys = [
      { name: 'Level 2', elevation: 3.0 },
      { name: 'Ground Floor', elevation: 0.0 },
      { name: 'Basement', elevation: -2.8 },
    ];
    expect(lowestStorey(storeys)?.name).toBe('Basement');
  });

  it('is stable on ties (first wins)', () => {
    const storeys = [
      { name: 'A', elevation: 0 },
      { name: 'B', elevation: 0 },
    ];
    expect(lowestStorey(storeys)?.name).toBe('A');
  });

  it('returns null for an empty list', () => {
    expect(lowestStorey([])).toBeNull();
  });
});

describe('parseDimension', () => {
  it('parses plain metres', () => {
    expect(parseDimension('3.5', DEFAULT_WALL_HEIGHT_M)).toBe(3.5);
    expect(parseDimension('0.2', DEFAULT_WALL_THICKNESS_M)).toBe(0.2);
  });

  it('falls back on junk, empty, and non-positive input', () => {
    expect(parseDimension('abc', 3)).toBe(3);
    expect(parseDimension('', 3)).toBe(3);
    expect(parseDimension('0', 3)).toBe(3);
    expect(parseDimension('-2', 3)).toBe(3);
  });

  it('clamps to the sane band (mm-habit typo protection)', () => {
    expect(parseDimension('3000', 3)).toBe(100);
    expect(parseDimension('0.001', 3)).toBe(0.01);
  });
});
