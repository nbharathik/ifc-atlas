import { describe, it, expect } from 'vitest';
import { SearchIndex, fuzzyScore } from './searchIndex';
import { parseSearchQuery } from './searchQuery';

function makeIndex(): SearchIndex {
  const idx = new SearchIndex();
  idx.add({ id: 1, globalId: 'G1', name: 'South Wall', ifcType: 'IfcWall', storey: 'Ground Floor' });
  idx.add({ id: 2, globalId: 'G2', name: 'North Wall', ifcType: 'IfcWallStandardCase', storey: 'First Floor' });
  idx.add({ id: 3, globalId: 'G3', name: 'Main Door', ifcType: 'IfcDoor', storey: 'Ground Floor' });
  idx.add({ id: 4, globalId: 'G4', name: 'Roof Slab', ifcType: 'IfcSlab', storey: 'Roof' });
  return idx;
}

function enrich(idx: SearchIndex): SearchIndex {
  idx.setEnrichment(1, {
    objectType: 'Basic Wall 200',
    psets: [
      { pset: 'Pset_WallCommon', prop: 'IsExternal', value: 'true' },
      { pset: 'Pset_WallCommon', prop: 'FireRating', value: 'F60' },
      { pset: 'Dimensions', prop: 'Width', value: '200.0' },
    ],
    classifications: [{ system: 'Uniclass', code: 'Ss_25_10' }],
  });
  idx.setEnrichment(2, {
    objectType: 'Basic Wall 100',
    psets: [
      { pset: 'Pset_WallCommon', prop: 'IsExternal', value: 'false' },
      { pset: 'Dimensions', prop: 'Width', value: '100' },
    ],
    classifications: [],
  });
  return idx;
}

function idsOf(idx: SearchIndex, query: string): number[] {
  return idx.searchParsed(parseSearchQuery(query)).elements.map((e) => e.id).sort((a, b) => a - b);
}

// ─── fuzzyScore ───────────────────────────────────────────────────────────────

describe('fuzzyScore ordering invariants', () => {
  const target = 'Basement wall 01';

  it('ranks substring > word-prefix > subsequence > no match', () => {
    const substring = fuzzyScore('wall', target);
    const wordPrefix = fuzzyScore('ba wa', target);
    const subsequence = fuzzyScore('bw', target);
    const noMatch = fuzzyScore('xyz', target);
    expect(substring).toBeGreaterThan(wordPrefix);
    expect(wordPrefix).toBeGreaterThan(subsequence);
    expect(subsequence).toBeGreaterThan(0);
    expect(noMatch).toBe(0);
  });

  it('prefers shorter targets within the same tier', () => {
    expect(fuzzyScore('wall', 'Wall')).toBeGreaterThan(fuzzyScore('wall', 'Wall with a long name'));
    expect(fuzzyScore('do', 'Main Door')).toBeGreaterThan(fuzzyScore('do', 'Main Door of the entrance'));
  });

  it('is case-insensitive', () => {
    expect(fuzzyScore('WALL', 'south wall')).toBeGreaterThan(0);
    expect(fuzzyScore('wall', 'SOUTH WALL')).toBeGreaterThan(0);
  });

  it('returns 0 for empty query or empty target', () => {
    expect(fuzzyScore('', 'Wall')).toBe(0);
    expect(fuzzyScore('wall', '')).toBe(0);
  });

  it('requires subsequence characters in order', () => {
    expect(fuzzyScore('lw', 'wall')).toBe(0);
    expect(fuzzyScore('wl', 'wall')).toBeGreaterThan(0);
  });
});

// ─── backward-compatible string search ────────────────────────────────────────

describe('SearchIndex.search (legacy API)', () => {
  it('finds items by token', () => {
    const ids = makeIndex().search('wall').elements.map((e) => e.id).sort();
    expect(ids).toEqual([1, 2]);
  });

  it('applies exact ifcType and storey options', () => {
    const idx = makeIndex();
    expect(idx.search('wall', { ifcType: 'IfcWall' }).elements.map((e) => e.id)).toEqual([1]);
    expect(idx.search('wall', { storey: 'first floor' }).elements.map((e) => e.id)).toEqual([2]);
  });

  it('respects the limit while reporting full total', () => {
    const res = makeIndex().search('wall', { limit: 1 });
    expect(res.elements).toHaveLength(1);
    expect(res.total).toBe(2);
  });

  it('clear() empties the index', () => {
    const idx = makeIndex();
    idx.clear();
    expect(idx.size).toBe(0);
    expect(idx.search('wall').total).toBe(0);
  });
});

// ─── searchParsed ─────────────────────────────────────────────────────────────

describe('SearchIndex.searchParsed - bare terms', () => {
  it('matches via the inverted index and fuzzy re-rank', () => {
    expect(idsOf(makeIndex(), 'wall')).toEqual([1, 2]);
  });

  it('requires every term to match (AND)', () => {
    expect(idsOf(makeIndex(), 'south wall')).toEqual([1]);
    expect(idsOf(makeIndex(), 'south door')).toEqual([]);
  });

  it('falls back to a linear fuzzy scan when the token index yields nothing', () => {
    // "wl" defeats the prefix buckets (no token starts with it) but is an
    // in-order subsequence of "wall".
    expect(idsOf(makeIndex(), 'wl')).toEqual([1, 2]);
  });

  it('returns nothing for an empty parsed query', () => {
    const res = makeIndex().searchParsed(parseSearchQuery('   '));
    expect(res.elements).toEqual([]);
    expect(res.total).toBe(0);
  });

  it('echoes the raw query string', () => {
    expect(makeIndex().searchParsed(parseSearchQuery('wall')).query).toBe('wall');
  });
});

describe('SearchIndex.searchParsed - type and storey filters', () => {
  it('type:IfcWall is an exact class match', () => {
    expect(idsOf(makeIndex(), 'type:IfcWall')).toEqual([1]);
  });

  it('type:wall matches class names containing wall', () => {
    expect(idsOf(makeIndex(), 'type:wall')).toEqual([1, 2]);
  });

  it('storey filters are case-insensitive substrings', () => {
    expect(idsOf(makeIndex(), 'storey:"Ground Floor"')).toEqual([1, 3]);
    expect(idsOf(makeIndex(), 'storey:ground')).toEqual([1, 3]);
  });

  it('combines terms with filters (AND)', () => {
    expect(idsOf(makeIndex(), 'wall storey:"First Floor"')).toEqual([2]);
    expect(idsOf(makeIndex(), 'door type:IfcWall')).toEqual([]);
  });
});

describe('SearchIndex.searchParsed - pset filters', () => {
  it('matches qualified pset.prop=value', () => {
    expect(idsOf(enrich(makeIndex()), 'pset:Pset_WallCommon.IsExternal=true')).toEqual([1]);
  });

  it('matches unqualified prop=value in any pset', () => {
    expect(idsOf(enrich(makeIndex()), 'pset:IsExternal=true')).toEqual([1]);
    expect(idsOf(enrich(makeIndex()), 'pset:IsExternal=false')).toEqual([2]);
  });

  it('compares values case-insensitively', () => {
    expect(idsOf(enrich(makeIndex()), 'pset:IsExternal=TRUE')).toEqual([1]);
    expect(idsOf(enrich(makeIndex()), 'pset:FireRating=f60')).toEqual([1]);
  });

  it('treats a bare property as a presence check', () => {
    expect(idsOf(enrich(makeIndex()), 'pset:FireRating')).toEqual([1]);
    expect(idsOf(enrich(makeIndex()), 'pset:Width')).toEqual([1, 2]);
  });

  it('compares numerically when both sides parse', () => {
    // stored "200.0" vs queried "200", and stored "100" vs queried "100.0"
    expect(idsOf(enrich(makeIndex()), 'pset:Width=200')).toEqual([1]);
    expect(idsOf(enrich(makeIndex()), 'pset:Dimensions.Width=100.0')).toEqual([2]);
  });

  it('returns nothing for unknown properties or mismatched values', () => {
    expect(idsOf(enrich(makeIndex()), 'pset:NoSuchProp')).toEqual([]);
    expect(idsOf(enrich(makeIndex()), 'pset:FireRating=F120')).toEqual([]);
  });

  it('returns nothing before enrichment is built (no throw)', () => {
    expect(idsOf(makeIndex(), 'pset:IsExternal=true')).toEqual([]);
  });
});

describe('SearchIndex.searchParsed - classification filters', () => {
  it('matches by system, code, or system.code (case-insensitive substring)', () => {
    expect(idsOf(enrich(makeIndex()), 'class:Uniclass')).toEqual([1]);
    expect(idsOf(enrich(makeIndex()), 'class:ss_25_10')).toEqual([1]);
    expect(idsOf(enrich(makeIndex()), 'class:Uniclass.Ss_25_10')).toEqual([1]);
  });

  it('returns nothing for unknown classifications', () => {
    expect(idsOf(enrich(makeIndex()), 'class:OmniClass')).toEqual([]);
  });

  it('combines with terms and type filters', () => {
    expect(idsOf(enrich(makeIndex()), 'wall class:Uniclass')).toEqual([1]);
    expect(idsOf(enrich(makeIndex()), 'type:IfcWallStandardCase pset:IsExternal=false')).toEqual([2]);
  });
});

describe('SearchIndex enrichment lifecycle', () => {
  it('hasEnrichment flips on and off', () => {
    const idx = makeIndex();
    expect(idx.hasEnrichment).toBe(false);
    enrich(idx);
    expect(idx.hasEnrichment).toBe(true);
    idx.clearEnrichment();
    expect(idx.hasEnrichment).toBe(false);
    expect(idsOf(idx, 'pset:IsExternal=true')).toEqual([]);
  });

  it('ObjectType joins bare-term matching after enrichment', () => {
    const idx = makeIndex();
    expect(idsOf(idx, 'basic')).toEqual([]);
    enrich(idx);
    expect(idsOf(idx, 'basic')).toEqual([1, 2]);
  });

  it('clear() drops enrichment along with the base layer', () => {
    const idx = enrich(makeIndex());
    idx.clear();
    expect(idx.size).toBe(0);
    expect(idx.hasEnrichment).toBe(false);
  });
});
