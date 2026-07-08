import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildQtoTsv,
  fetchQtoSummary,
  formatQtoCount,
  formatQtoNumber,
  formatQtoQuantity,
  qtoExportCsvUrl,
  qtoSortComparator,
  type QtoGroup,
  type QtoSummary,
} from './qto';

function makeGroup(overrides: Partial<QtoGroup> = {}): QtoGroup {
  return {
    key: { ifc_class: 'IfcWall', storey: 'Ground Floor' },
    label: 'IfcWall / Ground Floor',
    count: 12,
    quantities: { volume_m3: 5.3, area_m2: 18.4, length_m: 42.0 },
    coverage: { volume: 12, area: 10, length: 12 },
    element_ids: [101, 102],
    ...overrides,
  };
}

function makeSummary(overrides: Partial<QtoSummary> = {}): QtoSummary {
  return {
    group_by: ['ifc_class', 'storey'],
    groups: [makeGroup()],
    overall: { count: 149, quantities: { volume_m3: 0.0, area_m2: 0.0, length_m: 0.0 } },
    truncated: false,
    elapsed_ms: 12.3,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('formatQtoNumber', () => {
  it('formats to exactly one decimal place', () => {
    expect(formatQtoNumber(5.3)).toBe('5.3');
    expect(formatQtoNumber(5)).toBe('5.0');
    expect(formatQtoNumber(0)).toBe('0.0');
  });

  it('rounds, not truncates', () => {
    expect(formatQtoNumber(18.46)).toBe('18.5');
    expect(formatQtoNumber(18.44)).toBe('18.4');
  });

  it('adds thousands separators', () => {
    expect(formatQtoNumber(1234.56)).toBe('1,234.6');
    expect(formatQtoNumber(1000000)).toBe('1,000,000.0');
  });
});

describe('formatQtoCount', () => {
  it('formats integers without decimals', () => {
    expect(formatQtoCount(12)).toBe('12');
    expect(formatQtoCount(0)).toBe('0');
  });

  it('adds thousands separators', () => {
    expect(formatQtoCount(5000)).toBe('5,000');
  });
});

describe('formatQtoQuantity', () => {
  it('renders "-" when the group coverage is 0 (quantity unknown)', () => {
    expect(formatQtoQuantity(0, 0)).toBe('-');
    // A non-zero stored value with zero coverage is still unknown.
    expect(formatQtoQuantity(7.5, 0)).toBe('-');
  });

  it('formats the value when any element contributed', () => {
    expect(formatQtoQuantity(5.3, 12)).toBe('5.3');
    expect(formatQtoQuantity(0, 3)).toBe('0.0');
  });
});

describe('buildQtoTsv', () => {
  it('emits one column per group field plus count and quantity columns', () => {
    const tsv = buildQtoTsv([makeGroup()], ['ifc_class', 'storey']);
    const [header, row] = tsv.split('\n');
    expect(header).toBe('ifc_class\tstorey\tcount\tvolume_m3\tarea_m2\tlength_m');
    expect(row).toBe('IfcWall\tGround Floor\t12\t5.3\t18.4\t42.0');
  });

  it('preserves group_by order in the columns', () => {
    const tsv = buildQtoTsv([makeGroup()], ['storey', 'ifc_class']);
    const [header, row] = tsv.split('\n');
    expect(header.startsWith('storey\tifc_class')).toBe(true);
    expect(row.startsWith('Ground Floor\tIfcWall')).toBe(true);
  });

  it('writes "-" for quantities with zero coverage', () => {
    const group = makeGroup({ coverage: { volume: 0, area: 10, length: 0 } });
    const row = buildQtoTsv([group], ['ifc_class']).split('\n')[1];
    expect(row).toBe('IfcWall\t12\t-\t18.4\t-');
  });

  it('keeps rows in the order given (caller supplies sorted rows)', () => {
    const a = makeGroup({ label: 'A', key: { ifc_class: 'IfcDoor' } });
    const b = makeGroup({ label: 'B', key: { ifc_class: 'IfcWall' } });
    const lines = buildQtoTsv([b, a], ['ifc_class']).split('\n');
    expect(lines[1].startsWith('IfcWall')).toBe(true);
    expect(lines[2].startsWith('IfcDoor')).toBe(true);
  });

  it('flattens tabs and newlines inside cell values', () => {
    const group = makeGroup({ key: { ifc_class: 'Ifc\tWall\nX' } });
    const row = buildQtoTsv([group], ['ifc_class']).split('\n')[1];
    expect(row.startsWith('Ifc Wall X\t')).toBe(true);
  });

  it('writes an empty cell when a group field is missing from the key', () => {
    const group = makeGroup({ key: { ifc_class: 'IfcWall' } });
    const row = buildQtoTsv([group], ['ifc_class', 'storey']).split('\n')[1];
    expect(row.startsWith('IfcWall\t\t12')).toBe(true);
  });
});

describe('qtoSortComparator', () => {
  const walls = makeGroup({
    label: 'IfcWall',
    count: 12,
    quantities: { volume_m3: 5.3, area_m2: 18.4, length_m: 42.0 },
  });
  const doors = makeGroup({
    label: 'IfcDoor',
    count: 30,
    quantities: { volume_m3: 1.1, area_m2: 60.0, length_m: 2.0 },
  });
  const slabs = makeGroup({
    label: 'IfcSlab',
    count: 12,
    quantities: { volume_m3: 90.0, area_m2: 18.4, length_m: 8.0 },
  });

  it('sorts by count descending', () => {
    const sorted = [walls, doors, slabs].sort(qtoSortComparator('count', 'desc'));
    expect(sorted[0]).toBe(doors);
  });

  it('sorts by a quantity column ascending', () => {
    const sorted = [walls, doors, slabs].sort(qtoSortComparator('volume', 'asc'));
    expect(sorted.map((g) => g.label)).toEqual(['IfcDoor', 'IfcWall', 'IfcSlab']);
  });

  it('breaks ties by label so the order is deterministic', () => {
    // walls and slabs share count=12 and area=18.4.
    const byCount = [slabs, walls, doors].sort(qtoSortComparator('count', 'desc'));
    expect(byCount.map((g) => g.label)).toEqual(['IfcDoor', 'IfcSlab', 'IfcWall']);
    const byArea = [walls, slabs].sort(qtoSortComparator('area', 'desc'));
    expect(byArea.map((g) => g.label)).toEqual(['IfcSlab', 'IfcWall']);
  });

  it('reverses direction when toggled', () => {
    const desc = [walls, doors].sort(qtoSortComparator('length', 'desc'));
    const asc = [walls, doors].sort(qtoSortComparator('length', 'asc'));
    expect(desc[0]).toBe(walls);
    expect(asc[0]).toBe(doors);
  });
});

describe('fetchQtoSummary', () => {
  it('requests the summary with ordered group_by and include_ids=true', async () => {
    const summary = makeSummary();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(summary), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchQtoSummary(['storey', 'ifc_class']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    const query = new URLSearchParams(calledUrl.split('?')[1]);
    expect(calledUrl.split('?')[0].endsWith('/api/qto/summary')).toBe(true);
    expect(query.get('group_by')).toBe('storey,ifc_class');
    expect(query.get('include_ids')).toBe('true');
    expect(result).toEqual(summary);
  });

  it('throws with status and body text on a non-ok response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: 'No IFC model loaded' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchQtoSummary(['ifc_class'])).rejects.toThrow(
      'API error 400: {"detail":"No IFC model loaded"}',
    );
  });

  it('throws on a 422 unknown group_by response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Unknown group_by value' }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchQtoSummary(['ifc_class'])).rejects.toThrow(/API error 422/);
  });
});

describe('qtoExportCsvUrl', () => {
  it('targets the CSV route with the ordered grouping', () => {
    const url = qtoExportCsvUrl(['ifc_class', 'material']);
    expect(url.split('?')[0].endsWith('/api/qto/export.csv')).toBe(true);
    const query = new URLSearchParams(url.split('?')[1]);
    expect(query.get('group_by')).toBe('ifc_class,material');
  });
});
