import { describe, it, expect } from 'vitest';
import { parseSearchQuery } from './searchQuery';

describe('parseSearchQuery - bare terms', () => {
  it('returns an empty query for blank input', () => {
    expect(parseSearchQuery('').isEmpty).toBe(true);
    expect(parseSearchQuery('   ').isEmpty).toBe(true);
  });

  it('collects multiple bare terms (AND semantics live in the index)', () => {
    const q = parseSearchQuery('south wall');
    expect(q.terms).toEqual(['south', 'wall']);
    expect(q.isEmpty).toBe(false);
    expect(q.needsEnrichment).toBe(false);
  });

  it('keeps a quoted phrase as one term', () => {
    expect(parseSearchQuery('"south wall"').terms).toEqual(['south wall']);
  });

  it('echoes the raw query', () => {
    expect(parseSearchQuery('wall type:IfcWall').raw).toBe('wall type:IfcWall');
  });
});

describe('parseSearchQuery - type:', () => {
  it('captures the class filter', () => {
    const q = parseSearchQuery('type:IfcWall');
    expect(q.typeFilters).toEqual(['IfcWall']);
    expect(q.terms).toEqual([]);
    expect(q.needsEnrichment).toBe(false);
  });

  it('captures partial class filters', () => {
    expect(parseSearchQuery('type:wall').typeFilters).toEqual(['wall']);
  });

  it('accepts an uppercase prefix', () => {
    expect(parseSearchQuery('TYPE:IfcWall').typeFilters).toEqual(['IfcWall']);
  });

  it('treats a value-less prefix as a bare term', () => {
    const q = parseSearchQuery('type:');
    expect(q.typeFilters).toEqual([]);
    expect(q.terms).toEqual(['type:']);
  });
});

describe('parseSearchQuery - storey:', () => {
  it('supports quoted values with spaces', () => {
    const q = parseSearchQuery('storey:"Ground Floor"');
    expect(q.storeyFilters).toEqual(['Ground Floor']);
  });

  it('supports unquoted single-word values', () => {
    expect(parseSearchQuery('storey:Roof').storeyFilters).toEqual(['Roof']);
  });
});

describe('parseSearchQuery - pset:', () => {
  it('parses pset.prop=value', () => {
    const q = parseSearchQuery('pset:Pset_WallCommon.IsExternal=true');
    expect(q.psetFilters).toEqual([
      { pset: 'Pset_WallCommon', prop: 'IsExternal', value: 'true' },
    ]);
    expect(q.needsEnrichment).toBe(true);
  });

  it('parses prop=value with no pset name', () => {
    expect(parseSearchQuery('pset:IsExternal=true').psetFilters).toEqual([
      { pset: null, prop: 'IsExternal', value: 'true' },
    ]);
  });

  it('parses a bare property name as a presence check', () => {
    expect(parseSearchQuery('pset:FireRating').psetFilters).toEqual([
      { pset: null, prop: 'FireRating', value: null },
    ]);
  });

  it('treats an empty value (trailing =) as a presence check', () => {
    expect(parseSearchQuery('pset:FireRating=').psetFilters).toEqual([
      { pset: null, prop: 'FireRating', value: null },
    ]);
  });

  it('supports quoted values with spaces', () => {
    expect(parseSearchQuery('pset:Pset_Door.Description="fire rated"').psetFilters).toEqual([
      { pset: 'Pset_Door', prop: 'Description', value: 'fire rated' },
    ]);
  });

  it('drops a pset filter with no property name back to a bare term', () => {
    const q = parseSearchQuery('pset:Pset_WallCommon.');
    expect(q.psetFilters).toEqual([]);
    expect(q.terms).toEqual(['pset:Pset_WallCommon.']);
  });
});

describe('parseSearchQuery - class:', () => {
  it('captures system.code filters', () => {
    const q = parseSearchQuery('class:Uniclass.Ss_25_10');
    expect(q.classFilters).toEqual(['Uniclass.Ss_25_10']);
    expect(q.needsEnrichment).toBe(true);
  });

  it('captures bare code filters', () => {
    expect(parseSearchQuery('class:Ss_25_10').classFilters).toEqual(['Ss_25_10']);
  });
});

describe('parseSearchQuery - mixed and malformed input', () => {
  it('parses every facet of a mixed query', () => {
    const q = parseSearchQuery('wall type:IfcWall storey:"Ground Floor" pset:IsExternal=true class:Ss_25');
    expect(q.terms).toEqual(['wall']);
    expect(q.typeFilters).toEqual(['IfcWall']);
    expect(q.storeyFilters).toEqual(['Ground Floor']);
    expect(q.psetFilters).toEqual([{ pset: null, prop: 'IsExternal', value: 'true' }]);
    expect(q.classFilters).toEqual(['Ss_25']);
    expect(q.needsEnrichment).toBe(true);
    expect(q.isEmpty).toBe(false);
  });

  it('treats unknown prefixes as bare terms', () => {
    expect(parseSearchQuery('foo:bar').terms).toEqual(['foo:bar']);
  });

  it('treats a leading colon as a bare term', () => {
    expect(parseSearchQuery(':wall').terms).toEqual([':wall']);
  });

  it('never throws on unbalanced quotes', () => {
    const q = parseSearchQuery('storey:"Ground');
    expect(q.storeyFilters).toEqual(['Ground']);
  });

  it('never throws on punctuation-only input', () => {
    expect(parseSearchQuery(':::"').isEmpty).toBe(false);
    expect(() => parseSearchQuery('=== ... :::')).not.toThrow();
  });

  it('handles GlobalId-like terms untouched', () => {
    expect(parseSearchQuery('1kTvXnbbzCWw8lcMd1dR4o').terms).toEqual(['1kTvXnbbzCWw8lcMd1dR4o']);
  });
});
