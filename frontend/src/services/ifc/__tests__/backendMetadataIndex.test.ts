import { describe, expect, it } from 'vitest';

import {
  BackendMetadataIndex,
  indexElementToDetail,
  QUANTITY_VALUE_TYPES,
  type RawBackendIndex,
  type RawIndexElement,
  type RawIndexPropertySet,
} from '../backendMetadataIndex';

const wall: RawIndexElement = {
  id: 42,
  global_id: '0aBcWALL000000000000GUID',
  type: 'IFCWALL',
  name: 'Basic Wall',
  description: 'exterior',
  storey_id: 7,
  storey_name: 'Level 1',
};

const wallPsets: RawIndexPropertySet[] = [
  {
    id: 100,
    name: 'Pset_WallCommon',
    description: null,
    properties: [
      { name: 'IsExternal', value: 'T', value_type: 'boolean' },
      { name: 'FireRating', value: '60', value_type: 'ifclabel' },
      { name: 'ThermalTransmittance', value: '0.24', value_type: 'real' },
    ],
  },
  {
    id: 101,
    name: 'Qto_WallBaseQuantities',
    description: null,
    properties: [
      { name: 'NetSideArea', value: '12.5', value_type: 'area' },
      { name: 'Length', value: '5000', value_type: 'length' },
    ],
  },
];

describe('indexElementToDetail', () => {
  it('maps core fields and leaves index-absent fields null', () => {
    const d = indexElementToDetail(wall, wallPsets);
    expect(d.id).toBe(42);
    expect(d.global_id).toBe('0aBcWALL000000000000GUID');
    expect(d.name).toBe('Basic Wall');
    expect(d.ifc_type).toBe('IFCWALL');
    expect(d.storey).toBe('Level 1');
    expect(d.description).toBe('exterior');
    // Gaps documented for backend mode:
    expect(d.material).toBeNull();
    expect(d.relating_type).toBeNull();
    expect(d.predefined_type).toBeNull();
    expect(d.tag).toBeNull();
    expect(d.object_type).toBeNull();
  });

  it('routes quantity value-types to quantities (as numbers) not property_sets', () => {
    const d = indexElementToDetail(wall, wallPsets);
    expect(d.quantities).toEqual({ NetSideArea: 12.5, Length: 5000 });
    // The quantity pset contributed only quantities → no empty property set.
    const names = d.property_sets.map((p) => p.name);
    expect(names).toEqual(['Pset_WallCommon']);
  });

  it('coerces booleans and numerics inside a property set', () => {
    const d = indexElementToDetail(wall, wallPsets);
    const common = d.property_sets.find((p) => p.name === 'Pset_WallCommon')!;
    expect(common.properties.IsExternal).toBe(true);
    expect(common.properties.ThermalTransmittance).toBe(0.24);
    // Non-numeric label stays a string.
    expect(common.properties.FireRating).toBe('60');
  });

  it('handles an element with no property sets', () => {
    const d = indexElementToDetail({ id: 1, type: 'IFCSLAB' }, undefined);
    expect(d.property_sets).toEqual([]);
    expect(d.quantities).toEqual({});
    expect(d.global_id).toBe('');
    expect(d.name).toBeNull();
  });

  it('QUANTITY_VALUE_TYPES covers the sidecar quantity kinds', () => {
    for (const t of ['length', 'area', 'volume', 'count', 'weight', 'time']) {
      expect(QUANTITY_VALUE_TYPES.has(t)).toBe(true);
    }
  });
});

function makeRaw(): RawBackendIndex {
  return {
    source_sha256: 'deadbeef',
    // JSON object keys are strings even for int dicts - the class must coerce.
    elements: { '42': wall, '43': { id: 43, type: 'IFCDOOR', name: 'D1' } },
    element_psets: { '42': wallPsets },
    id_by_global_id: { '0aBcWALL000000000000GUID': 42 },
    materials: ['Concrete'],
  };
}

describe('BackendMetadataIndex', () => {
  it('builds maps from string-keyed JSON and exposes counts', () => {
    const idx = new BackendMetadataIndex(makeRaw(), 'deadbeef');
    expect(idx.sha256).toBe('deadbeef');
    expect(idx.elementCount).toBe(2);
    expect(idx.expressIdByGlobalId.get('0aBcWALL000000000000GUID')).toBe(42);
  });

  it('resolveOwner returns input and counts hits vs misses', () => {
    const idx = new BackendMetadataIndex(makeRaw(), null);
    expect(idx.resolveOwner(42)).toBe(42); // known product → hit
    expect(idx.resolveOwner(999)).toBe(999); // unknown sub-rep → miss, unchanged
    const stats = idx.resolveStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.rate).toBeCloseTo(0.5);
  });

  it('getElementDetail serves from the index then null after invalidate', () => {
    const idx = new BackendMetadataIndex(makeRaw(), null);
    expect(idx.getElementDetail(42)?.name).toBe('Basic Wall');
    expect(idx.hasProduct(42)).toBe(true);

    idx.invalidate([42]);
    expect(idx.getElementDetail(42)).toBeNull(); // → caller fetches authoritative
    expect(idx.hasProduct(42)).toBe(false);
  });

  it('getElementDetail returns null for unknown ids', () => {
    const idx = new BackendMetadataIndex(makeRaw(), null);
    expect(idx.getElementDetail(12345)).toBeNull();
  });
});
