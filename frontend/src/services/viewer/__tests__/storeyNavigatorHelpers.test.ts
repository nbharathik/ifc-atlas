import { describe, it, expect } from 'vitest';
import {
  countSubtree,
  collectStoreySubtreeIds,
  shortStoreyName,
  detectActiveStorey,
} from '../storeyNavigatorHelpers';
import type { SpatialNode } from '../../../types/ifc';

function makeNode(id: number, name: string, ifc_type = 'IfcWall', children: SpatialNode[] = []): SpatialNode {
  return { id, name, ifc_type, global_id: `gid-${id}`, children };
}

const GROUND = makeNode(10, 'Ground Floor', 'IfcBuildingStorey', [
  makeNode(11, 'Wall A'),
  makeNode(12, 'Wall B'),
  makeNode(13, 'Door 1'),
]);

const FIRST = makeNode(20, 'First Floor', 'IfcBuildingStorey', [
  makeNode(21, 'Wall C'),
  makeNode(22, 'Slab 1'),
]);

const SECOND = makeNode(30, 'Second Floor', 'IfcBuildingStorey', []);

const ROOT = makeNode(1, 'Building', 'IfcBuilding', [GROUND, FIRST, SECOND]);

// ── countSubtree ──────────────────────────────────────────────────────────────

describe('countSubtree', () => {
  it('counts 1 for a leaf node', () => {
    expect(countSubtree(makeNode(99, 'Wall'))).toBe(1);
  });

  it('counts node + all descendants', () => {
    // GROUND: storey(1) + 3 children = 4
    expect(countSubtree(GROUND)).toBe(4);
  });

  it('counts recursively for deep trees', () => {
    const deep = makeNode(1, 'A', 'IfcBuilding', [
      makeNode(2, 'B', 'IfcSite', [
        makeNode(3, 'C'),
        makeNode(4, 'D'),
      ]),
    ]);
    expect(countSubtree(deep)).toBe(4);
  });

  it('counts 1 for storey with no children', () => {
    expect(countSubtree(SECOND)).toBe(1);
  });
});

// ── collectStoreySubtreeIds ───────────────────────────────────────────────────

describe('collectStoreySubtreeIds', () => {
  it('includes the root node id', () => {
    const ids = collectStoreySubtreeIds(GROUND);
    expect(ids).toContain(10);
  });

  it('includes all child ids', () => {
    const ids = collectStoreySubtreeIds(GROUND);
    expect(ids).toContain(11);
    expect(ids).toContain(12);
    expect(ids).toContain(13);
  });

  it('returns correct length', () => {
    expect(collectStoreySubtreeIds(GROUND)).toHaveLength(4);
    expect(collectStoreySubtreeIds(FIRST)).toHaveLength(3);
  });

  it('returns just the node id for leaf', () => {
    expect(collectStoreySubtreeIds(SECOND)).toEqual([30]);
  });

  it('collects deeply nested ids', () => {
    const nested = makeNode(1, 'A', 'IfcBuildingStorey', [
      makeNode(2, 'B', 'IfcWall', [makeNode(3, 'C')]),
    ]);
    const ids = collectStoreySubtreeIds(nested);
    expect(ids).toEqual([1, 2, 3]);
  });
});

// ── shortStoreyName ───────────────────────────────────────────────────────────

describe('shortStoreyName', () => {
  it('strips "Level " prefix', () => {
    expect(shortStoreyName('Level 1')).toBe('1');
    expect(shortStoreyName('Level 02')).toBe('02');
  });

  it('strips "Floor " prefix case-insensitively', () => {
    expect(shortStoreyName('Ground Floor')).toBe('Ground');
    expect(shortStoreyName('floor 3')).toBe('3');
  });

  it('strips "Storey " prefix', () => {
    expect(shortStoreyName('Storey B')).toBe('B');
  });

  it('strips "Story " prefix', () => {
    expect(shortStoreyName('Story 5')).toBe('5');
  });

  it('keeps compact codes intact', () => {
    expect(shortStoreyName('B1')).toBe('B1');
    expect(shortStoreyName('GF')).toBe('GF');
  });

  it('truncates long names', () => {
    const result = shortStoreyName('This Is A Very Long Floor Name');
    expect(result.length).toBeLessThanOrEqual(14);
    expect(result.endsWith('…')).toBe(true);
  });

  it('returns em-dash for empty string', () => {
    expect(shortStoreyName('')).toBe('-');
  });

  it('preserves names that already have no prefix and are short', () => {
    expect(shortStoreyName('Ground')).toBe('Ground');
  });
});

// ── detectActiveStorey ────────────────────────────────────────────────────────

describe('detectActiveStorey', () => {
  const storeys = [GROUND, FIRST, SECOND];
  const subtrees = new Map<number, number[]>([
    [10, collectStoreySubtreeIds(GROUND)], // [10,11,12,13]
    [20, collectStoreySubtreeIds(FIRST)],  // [20,21,22]
    [30, collectStoreySubtreeIds(SECOND)], // [30]
  ]);

  it('returns null when nothing is isolated', () => {
    expect(detectActiveStorey([], storeys, subtrees)).toBeNull();
  });

  it('detects GROUND floor isolation', () => {
    expect(detectActiveStorey([10, 11, 12, 13], storeys, subtrees)).toBe(10);
  });

  it('detects FIRST floor isolation', () => {
    expect(detectActiveStorey([20, 21, 22], storeys, subtrees)).toBe(20);
  });

  it('detects SECOND floor isolation (single node)', () => {
    expect(detectActiveStorey([30], storeys, subtrees)).toBe(30);
  });

  it('returns -1 for partial/unrecognised isolation (e.g. single element)', () => {
    expect(detectActiveStorey([11], storeys, subtrees)).toBe(-1);
  });

  it('returns -1 when isolating a mix that does not match any storey', () => {
    expect(detectActiveStorey([11, 21], storeys, subtrees)).toBe(-1);
  });
});
