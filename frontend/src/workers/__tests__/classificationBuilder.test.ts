import { describe, expect, it } from 'vitest';
import {
  buildClassificationGroups,
  type RawClassification,
  type RawReference,
  type RawRelation,
} from '../classificationBuilder';

// ---- helpers ---------------------------------------------------------------

function cls(eid: number, name: string, edition: string | null = null): RawClassification {
  return { eid, name, source: null, edition };
}

function ref(eid: number, name: string, sourceEid: number | null, code: string | null = null): RawReference {
  return { eid, name, code, sourceEid };
}

function rel(relatingClassificationEid: number, memberIds: number[]): RawRelation {
  return { relatingClassificationEid, memberIds };
}

// ---- empty inputs ----------------------------------------------------------

describe('buildClassificationGroups - empty inputs', () => {
  it('returns [] when all inputs are empty', () => {
    expect(buildClassificationGroups([], [], [])).toEqual([]);
  });

  it('returns groups with no items when there are no relations', () => {
    const groups = buildClassificationGroups(
      [cls(1, 'Uniclass')],
      [],
      [],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('Uniclass');
    expect(groups[0].items).toHaveLength(0);
  });

  it('returns [] when classifications are absent but references exist', () => {
    const groups = buildClassificationGroups(
      [],
      [ref(10, 'Wall', 1)],
      [rel(10, [100, 101])],
    );
    expect(groups).toEqual([]);
  });
});

// ---- single classification, one reference ----------------------------------

describe('buildClassificationGroups - single classification', () => {
  it('creates one item under the right group', () => {
    const groups = buildClassificationGroups(
      [cls(1, 'Uniclass 2015')],
      [ref(10, 'Walls', 1, 'Ss_20_10')],
      [rel(10, [100, 200, 300])],
    );
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.classificationExpressId).toBe(1);
    expect(g.items).toHaveLength(1);
    const item = g.items[0];
    expect(item.refExpressId).toBe(10);
    expect(item.code).toBe('Ss_20_10');
    expect(item.name).toBe('Walls');
    expect(item.memberIds).toEqual([100, 200, 300]);
  });

  it('stores edition from RawClassification', () => {
    const groups = buildClassificationGroups(
      [cls(1, 'OmniClass', '2012')],
      [],
      [],
    );
    expect(groups[0].edition).toBe('2012');
  });

  it('item with null code is stored correctly', () => {
    const groups = buildClassificationGroups(
      [cls(1, 'SfB')],
      [ref(10, 'Structure', 1, null)],
      [rel(10, [5])],
    );
    expect(groups[0].items[0].code).toBeNull();
  });
});

// ---- multiple classifications -----------------------------------------------

describe('buildClassificationGroups - multiple classifications', () => {
  it('separates items into correct groups', () => {
    const groups = buildClassificationGroups(
      [cls(1, 'Uniclass'), cls(2, 'OmniClass')],
      [ref(10, 'Walls', 1), ref(20, 'Floors', 2)],
      [rel(10, [100]), rel(20, [200])],
    );
    expect(groups).toHaveLength(2);
    const byName = Object.fromEntries(groups.map((g) => [g.name, g]));
    expect(byName['Uniclass'].items[0].refExpressId).toBe(10);
    expect(byName['OmniClass'].items[0].refExpressId).toBe(20);
  });

  it('relations that point to unknown refs are silently dropped', () => {
    const groups = buildClassificationGroups(
      [cls(1, 'Uniclass')],
      [],
      [rel(999, [100])], // ref 999 does not exist
    );
    expect(groups[0].items).toHaveLength(0);
  });
});

// ---- nested reference chains -----------------------------------------------

describe('buildClassificationGroups - nested reference chains', () => {
  it('resolves a two-level chain (ref → parent-ref → classification)', () => {
    // Uniclass (eid=1) → CategoryRef (eid=10) → SubRef (eid=20)
    const groups = buildClassificationGroups(
      [cls(1, 'Uniclass')],
      [
        ref(10, 'Category', 1),        // direct child of classification
        ref(20, 'Sub-category', 10),   // child of ref 10
      ],
      [rel(20, [300, 301])],
    );
    expect(groups[0].items).toHaveLength(1);
    expect(groups[0].items[0].refExpressId).toBe(20);
    expect(groups[0].items[0].memberIds).toEqual([300, 301]);
  });

  it('stops chain walking at MAX_DEPTH (8) without infinite loop', () => {
    // Circular chain: ref 10 → ref 10 (source points to itself)
    const groups = buildClassificationGroups(
      [cls(1, 'Test')],
      [ref(10, 'Circular', 10)],
      [rel(10, [1])],
    );
    // The ref can't resolve to a root classification → no items.
    expect(groups[0].items).toHaveLength(0);
  });

  it('handles a three-level chain', () => {
    const groups = buildClassificationGroups(
      [cls(1, 'NF')],
      [
        ref(10, 'Level1', 1),
        ref(20, 'Level2', 10),
        ref(30, 'Level3', 20),
      ],
      [rel(30, [99])],
    );
    expect(groups[0].items[0].refExpressId).toBe(30);
    expect(groups[0].items[0].memberIds).toEqual([99]);
  });
});

// ---- relation edge cases ---------------------------------------------------

describe('buildClassificationGroups - relation edge cases', () => {
  it('merges member IDs from multiple relations pointing to the same ref', () => {
    const groups = buildClassificationGroups(
      [cls(1, 'Cls')],
      [ref(10, 'Walls', 1)],
      [rel(10, [1, 2]), rel(10, [3, 4])],
    );
    expect(groups[0].items[0].memberIds).toEqual([1, 2, 3, 4]);
  });

  it('skips relations with empty memberIds', () => {
    const groups = buildClassificationGroups(
      [cls(1, 'Cls')],
      [ref(10, 'Ref', 1)],
      [rel(10, [])],
    );
    expect(groups[0].items).toHaveLength(0);
  });

  it('direct relation to IfcClassification (no reference) works', () => {
    // RelatingClassification points directly to IfcClassification eid=1
    const groups = buildClassificationGroups(
      [cls(1, 'Direct')],
      [],
      [rel(1, [7, 8])],
    );
    expect(groups[0].items).toHaveLength(1);
    expect(groups[0].items[0].memberIds).toEqual([7, 8]);
    expect(groups[0].items[0].code).toBeNull();
  });
});
