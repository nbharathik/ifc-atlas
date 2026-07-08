import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  computeAggregates,
  escapeCsvField,
  aggregatesToCsv,
  copyAggregatesCsvToClipboard,
} from '../aggregateInspectorHelpers';
import type { ElementDetail } from '../../../types/ifc';

function makeEl(partial: Partial<ElementDetail> & { id: number }): ElementDetail {
  return {
    id: partial.id,
    global_id: partial.global_id ?? `gid-${partial.id}`,
    name: partial.name ?? `el-${partial.id}`,
    ifc_type: partial.ifc_type ?? 'IfcWall',
    storey: partial.storey ?? null,
    material: partial.material ?? null,
    property_sets: partial.property_sets ?? [],
    quantities: partial.quantities ?? {},
    relating_type: partial.relating_type ?? null,
    description: partial.description ?? null,
    object_type: partial.object_type ?? null,
    tag: partial.tag ?? null,
    predefined_type: partial.predefined_type ?? null,
  };
}

describe('computeAggregates', () => {
  it('returns zero/null for an empty selection', () => {
    const agg = computeAggregates([]);
    expect(agg.count).toBe(0);
    expect(agg.total_area).toBe(null);
    expect(agg.total_volume).toBe(null);
    expect(agg.type_histogram).toEqual({});
    expect(agg.material_histogram).toEqual({});
    expect(agg.missing_quantity_ids).toEqual([]);
  });

  it('strips Ifc prefix from type histogram', () => {
    const agg = computeAggregates([
      makeEl({ id: 1, ifc_type: 'IfcWall' }),
      makeEl({ id: 2, ifc_type: 'IfcSlab' }),
      makeEl({ id: 3, ifc_type: 'IfcWall' }),
    ]);
    expect(agg.type_histogram).toEqual({ Wall: 2, Slab: 1 });
  });

  it('counts materials and sorts by descending count', () => {
    const agg = computeAggregates([
      makeEl({ id: 1, material: 'Concrete' }),
      makeEl({ id: 2, material: 'Brick' }),
      makeEl({ id: 3, material: 'Concrete' }),
      makeEl({ id: 4, material: 'Concrete' }),
    ]);
    expect(Object.entries(agg.material_histogram)).toEqual([
      ['Concrete', 3],
      ['Brick', 1],
    ]);
  });

  it('sums GrossArea per priority order', () => {
    const agg = computeAggregates([
      makeEl({ id: 1, quantities: { GrossArea: 10, Length: 5 } }),
      makeEl({ id: 2, quantities: { GrossArea: 5, NetArea: 4 } }),
    ]);
    expect(agg.total_area).toBe(15);
    expect(agg.area_quantity_name).toBe('GrossArea');
  });

  it('falls back to NetArea when GrossArea is absent', () => {
    const agg = computeAggregates([
      makeEl({ id: 1, quantities: { NetArea: 3, Volume: 1 } }),
      makeEl({ id: 2, quantities: { NetArea: 7 } }),
    ]);
    expect(agg.total_area).toBe(10);
    expect(agg.area_quantity_name).toBe('NetArea');
  });

  it('falls back to any quantity whose key contains "area" if no priority name matches', () => {
    const agg = computeAggregates([
      makeEl({ id: 1, quantities: { CustomAreaThing: 4 } }),
    ]);
    expect(agg.total_area).toBe(4);
    expect(agg.area_quantity_name).toBe('CustomAreaThing');
  });

  it('sums GrossVolume per priority order', () => {
    const agg = computeAggregates([
      makeEl({ id: 1, quantities: { GrossVolume: 2.5, NetVolume: 2.0 } }),
      makeEl({ id: 2, quantities: { GrossVolume: 1.5 } }),
    ]);
    expect(agg.total_volume).toBe(4);
    expect(agg.volume_quantity_name).toBe('GrossVolume');
  });

  it('lists elements with no quantities in missing_quantity_ids', () => {
    const agg = computeAggregates([
      makeEl({ id: 11, quantities: {} }),
      makeEl({ id: 22, quantities: { GrossArea: 1 } }),
      makeEl({ id: 33, quantities: {} }),
    ]);
    expect(agg.missing_quantity_ids).toEqual([11, 33]);
    expect(agg.count).toBe(3); // count is total selection, not just contributors
  });

  it('rounds totals to 4 decimal places', () => {
    const agg = computeAggregates([
      makeEl({ id: 1, quantities: { GrossArea: 1.234567 } }),
      makeEl({ id: 2, quantities: { GrossArea: 2.345678 } }),
    ]);
    expect(agg.total_area).toBe(3.5802);
  });

  it('ignores null material', () => {
    const agg = computeAggregates([
      makeEl({ id: 1, material: null }),
      makeEl({ id: 2, material: 'Steel' }),
    ]);
    expect(agg.material_histogram).toEqual({ Steel: 1 });
  });

  it('handles mixed quantity-bearing and quantity-less elements without skipping type histogram', () => {
    const agg = computeAggregates([
      makeEl({ id: 1, ifc_type: 'IfcWall', quantities: {} }),
      makeEl({ id: 2, ifc_type: 'IfcDoor', quantities: { GrossArea: 2 } }),
    ]);
    expect(agg.type_histogram).toEqual({ Wall: 1, Door: 1 });
    expect(agg.total_area).toBe(2);
  });

  it('case-insensitive "area" substring fallback works', () => {
    const agg = computeAggregates([
      makeEl({ id: 1, quantities: { surface_AREA_total: 9 } }),
    ]);
    expect(agg.total_area).toBe(9);
  });
});

describe('escapeCsvField', () => {
  it('passes through plain values unchanged', () => {
    expect(escapeCsvField('Wall')).toBe('Wall');
    expect(escapeCsvField(42)).toBe('42');
  });

  it('returns empty string for null/undefined', () => {
    expect(escapeCsvField(null)).toBe('');
    expect(escapeCsvField(undefined)).toBe('');
  });

  it('quotes fields containing commas, semicolons, or newlines', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"');
    expect(escapeCsvField('a;b')).toBe('"a;b"');
    expect(escapeCsvField('a\nb')).toBe('"a\nb"');
  });

  it('escapes embedded double quotes by doubling them', () => {
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
  });
});

describe('aggregatesToCsv', () => {
  it('produces a header section, histogram rows, and ID list', () => {
    const agg = computeAggregates([
      makeEl({ id: 1, ifc_type: 'IfcWall', material: 'Concrete', quantities: { GrossArea: 3 } }),
      makeEl({ id: 2, ifc_type: 'IfcWall', material: 'Concrete', quantities: { GrossArea: 5 } }),
    ]);
    const csv = aggregatesToCsv(agg, [1, 2]);
    const rows = csv.split('\n');
    expect(rows[0]).toBe('section,key,value');
    expect(rows).toContain('summary,count,2');
    expect(rows).toContain('summary,total_area_m2,8');
    expect(rows).toContain('summary,area_quantity_name,GrossArea');
    expect(rows).toContain('type,Wall,2');
    expect(rows).toContain('material,Concrete,2');
    expect(rows).toContain('id,,1');
    expect(rows).toContain('id,,2');
  });

  it('escapes material names containing commas', () => {
    const agg = computeAggregates([
      makeEl({ id: 1, material: 'Concrete, C30/37' }),
    ]);
    const csv = aggregatesToCsv(agg, [1]);
    expect(csv).toContain('material,"Concrete, C30/37",1');
  });

  it('emits empty string for missing total_area / total_volume', () => {
    const agg = computeAggregates([makeEl({ id: 1, quantities: {} })]);
    const csv = aggregatesToCsv(agg, [1]);
    expect(csv).toContain('summary,total_area_m2,');
    expect(csv).toContain('summary,total_volume_m3,');
  });
});

describe('copyAggregatesCsvToClipboard', () => {
  let originalClipboard: Clipboard | undefined;

  beforeEach(() => {
    originalClipboard = navigator.clipboard;
  });

  afterEach(() => {
    if (originalClipboard !== undefined) {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: originalClipboard,
      });
    }
  });

  it('returns false when navigator.clipboard is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    const agg = computeAggregates([makeEl({ id: 1 })]);
    expect(await copyAggregatesCsvToClipboard(agg, [1])).toBe(false);
  });

  it('returns true when writeText resolves and passes the CSV through', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const agg = computeAggregates([
      makeEl({ id: 1, ifc_type: 'IfcDoor', quantities: { GrossArea: 2 } }),
    ]);
    const ok = await copyAggregatesCsvToClipboard(agg, [1]);
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledTimes(1);
    const payload = writeText.mock.calls[0][0] as string;
    expect(payload).toContain('summary,count,1');
    expect(payload).toContain('type,Door,1');
  });

  it('returns false when writeText rejects (permission denied)', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    const agg = computeAggregates([makeEl({ id: 1 })]);
    expect(await copyAggregatesCsvToClipboard(agg, [1])).toBe(false);
  });
});
