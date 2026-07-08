import { describe, it, expect } from 'vitest';
import { sortedTypeEntries, computeStoreyCounts } from '../../components/panels/ModelStatsPanel';

describe('sortedTypeEntries', () => {
  it('sorts by count descending', () => {
    const byType = { IfcWall: 50, IfcDoor: 10, IfcSlab: 30 };
    const result = sortedTypeEntries(byType);
    expect(result).toEqual([['IfcWall', 50], ['IfcSlab', 30], ['IfcDoor', 10]]);
  });

  it('returns empty array for empty input', () => {
    expect(sortedTypeEntries({})).toEqual([]);
  });

  it('returns single entry unchanged', () => {
    expect(sortedTypeEntries({ IfcColumn: 5 })).toEqual([['IfcColumn', 5]]);
  });

  it('handles tied counts stably', () => {
    const byType = { IfcWall: 5, IfcDoor: 5 };
    const result = sortedTypeEntries(byType);
    expect(result).toHaveLength(2);
    expect(result.every(([, count]) => count === 5)).toBe(true);
  });

  it('preserves Ifc-prefixed keys as-is', () => {
    const byType = { IfcBeam: 2 };
    const [[key]] = sortedTypeEntries(byType);
    expect(key).toBe('IfcBeam');
  });
});

describe('computeStoreyCounts', () => {
  it('maps storey names and childCounts', () => {
    const storeys = [
      { name: 'Ground Floor', childCount: 42 },
      { name: 'First Floor', childCount: 18 },
    ];
    const result = computeStoreyCounts(storeys);
    expect(result).toEqual([
      { name: 'Ground Floor', count: 42 },
      { name: 'First Floor', count: 18 },
    ]);
  });

  it('returns empty array for no storeys', () => {
    expect(computeStoreyCounts([])).toEqual([]);
  });

  it('handles zero child count', () => {
    const result = computeStoreyCounts([{ name: 'Empty', childCount: 0 }]);
    expect(result[0].count).toBe(0);
  });
});
