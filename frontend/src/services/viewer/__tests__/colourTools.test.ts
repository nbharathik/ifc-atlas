import { describe, it, expect } from 'vitest';
import {
  PALETTE,
  buildColourGroups,
  shortIfcType,
  hashStringToHSL,
  extractNameGroup,
  heatRamp,
  buildHeatmapLayer,
  flattenColourLayers,
} from '../colourTools';
import { SELECTION_HIGHLIGHT_HEX } from '../selectionHighlightHelpers';
import type { SpatialNode } from '../../../types/ifc';
import type { ColourLayer } from '../../../store/useStore';

function makeNode(
  id: number,
  ifc_type: string,
  name: string,
  children: SpatialNode[] = [],
): SpatialNode {
  return { id, global_id: `G${id}`, name, ifc_type, children };
}

const SAMPLE_TREE: SpatialNode = makeNode(1, 'IfcProject', 'My Project', [
  makeNode(2, 'IfcSite', 'Site A', [
    makeNode(3, 'IfcBuilding', 'Building', [
      makeNode(10, 'IfcBuildingStorey', 'Ground Floor', [
        makeNode(101, 'IfcWallStandardCase', 'Wall 1'),
        makeNode(102, 'IfcWallStandardCase', 'Wall 2'),
        makeNode(103, 'IfcDoor', 'Door 1'),
        makeNode(104, 'IfcWindow', 'Window 1'),
      ]),
      makeNode(20, 'IfcBuildingStorey', 'First Floor', [
        makeNode(201, 'IfcWallStandardCase', 'Wall 3'),
        makeNode(202, 'IfcSlab', 'Slab 1'),
      ]),
    ]),
  ]),
]);

describe('buildColourGroups', () => {
  it('returns empty array for null root', () => {
    expect(buildColourGroups(null, 'type')).toEqual([]);
  });

  it('groups by type correctly', () => {
    const groups = buildColourGroups(SAMPLE_TREE, 'type');
    const labels = groups.map(g => g.label);
    expect(labels).toContain('IfcWallStandardCase');
    expect(labels).toContain('IfcDoor');
    expect(labels).toContain('IfcWindow');
    expect(labels).toContain('IfcSlab');
    // Spatial structure types must NOT appear
    expect(labels).not.toContain('IfcProject');
    expect(labels).not.toContain('IfcSite');
    expect(labels).not.toContain('IfcBuilding');
    expect(labels).not.toContain('IfcBuildingStorey');
  });

  it('groups by storey correctly', () => {
    const groups = buildColourGroups(SAMPLE_TREE, 'storey');
    const labels = groups.map(g => g.label);
    expect(labels).toContain('Ground Floor');
    expect(labels).toContain('First Floor');
  });

  it('wall group has correct element IDs', () => {
    const groups = buildColourGroups(SAMPLE_TREE, 'type');
    const walls = groups.find(g => g.label === 'IfcWallStandardCase');
    expect(walls?.ids).toHaveLength(3);
    expect(walls?.ids).toContain(101);
    expect(walls?.ids).toContain(102);
    expect(walls?.ids).toContain(201);
  });

  it('storey groups have correct element counts', () => {
    const groups = buildColourGroups(SAMPLE_TREE, 'storey');
    const ground = groups.find(g => g.label === 'Ground Floor');
    const first = groups.find(g => g.label === 'First Floor');
    expect(ground?.ids).toHaveLength(4);
    expect(first?.ids).toHaveLength(2);
  });

  it('each group has a distinct color', () => {
    const groups = buildColourGroups(SAMPLE_TREE, 'type');
    const hexes = groups.map(g => g.color.getHexString());
    const unique = new Set(hexes);
    // With ≤12 groups (< palette size) all colors should be unique
    expect(unique.size).toBe(groups.length);
  });

  it('sorts groups by count descending', () => {
    const groups = buildColourGroups(SAMPLE_TREE, 'type');
    const counts = groups.map(g => g.ids.length);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
    }
  });
});

// ─── PALETTE - reserved-colour collisions ────────────────────────────────────

describe('PALETTE', () => {
  it('matches the de-collided 12-colour tailwind set in CVD-aware order', () => {
    expect(PALETTE.map(c => c.getHexString())).toEqual([
      '3b82f6', // blue
      '10b981', // emerald
      '8b5cf6', // violet
      'f43f5e', // rose
      '14b8a6', // teal
      'd946ef', // fuchsia
      '84cc16', // lime
      '6366f1', // indigo
      'ec4899', // pink
      '38bdf8', // sky
      'a855f7', // purple
      'a8a29e', // stone
    ]);
  });

  it('contains no reserved viewer highlight colours', () => {
    const hexes = PALETTE.map(c => c.getHex());
    expect(hexes).not.toContain(0xf59e0b); // selection amber
    expect(hexes).not.toContain(SELECTION_HIGHLIGHT_HEX); // same hue, linked to its source of truth
    expect(hexes).not.toContain(0x00d2ff); // chat highlight cyan (ViewerPanel CHAT_HIGHLIGHT_COLOR)
  });
});

describe('shortIfcType', () => {
  it('strips Ifc prefix', () => {
    expect(shortIfcType('IfcWall')).toBe('Wall');
  });

  it('strips StandardCase suffix', () => {
    expect(shortIfcType('IfcWallStandardCase')).toBe('Wall');
  });

  it('inserts space on camelCase boundary', () => {
    expect(shortIfcType('IfcBuildingElement')).toBe('Building Element');
  });

  it('handles IfcDoor without suffix', () => {
    expect(shortIfcType('IfcDoor')).toBe('Door');
  });
});

// ─── hashStringToHSL ─────────────────────────────────────────────────────────

describe('hashStringToHSL', () => {
  it('returns a THREE.Color instance', () => {
    const c = hashStringToHSL('Concrete');
    expect(c).toBeDefined();
    expect(typeof c.getHexString).toBe('function');
  });

  it('is deterministic - same input always same output', () => {
    const a = hashStringToHSL('Steel').getHexString();
    const b = hashStringToHSL('Steel').getHexString();
    expect(a).toBe(b);
  });

  it('produces different colours for different strings', () => {
    const steel = hashStringToHSL('Steel').getHexString();
    const concrete = hashStringToHSL('Concrete').getHexString();
    expect(steel).not.toBe(concrete);
  });

  it('handles empty string without throwing', () => {
    expect(() => hashStringToHSL('')).not.toThrow();
  });
});

// ─── extractNameGroup ────────────────────────────────────────────────────────

describe('extractNameGroup', () => {
  it('extracts middle token for colon-separated Revit-style names', () => {
    expect(extractNameGroup('Basic Wall:Concrete Block 200mm:1234567')).toBe('Concrete Block 200mm');
  });

  it('returns the first token when there is no colon', () => {
    expect(extractNameGroup('Concrete Column')).toBe('Concrete Column');
  });

  it('skips pure-integer second token (Revit instance ID fallback)', () => {
    expect(extractNameGroup('Basic Wall:9876543')).toBe('Basic Wall');
  });

  it('returns Unknown for empty/blank names', () => {
    expect(extractNameGroup('')).toBe('Unknown');
    expect(extractNameGroup('   ')).toBe('Unknown');
  });
});

// ─── buildColourGroups - material mode ───────────────────────────────────────

const MATERIAL_TREE: SpatialNode = makeNode(1, 'IfcProject', 'Proj', [
  makeNode(2, 'IfcSite', 'Site', [
    makeNode(3, 'IfcBuilding', 'Bldg', [
      makeNode(10, 'IfcBuildingStorey', 'GF', [
        makeNode(101, 'IfcWallStandardCase', 'Basic Wall:Concrete Block 200mm:1001'),
        makeNode(102, 'IfcWallStandardCase', 'Basic Wall:Concrete Block 200mm:1002'),
        makeNode(103, 'IfcBeam', 'Structural Framing:Steel Beam IPE300:1003'),
        makeNode(104, 'IfcColumn', 'Structural Column:Steel Column 200:1004'),
      ]),
    ]),
  ]),
]);

describe('buildColourGroups - material mode', () => {
  it('groups elements by extracted name family', () => {
    const groups = buildColourGroups(MATERIAL_TREE, 'material');
    const labels = groups.map(g => g.label);
    expect(labels).toContain('Concrete Block 200mm');
    expect(labels).toContain('Steel Beam IPE300');
    expect(labels).toContain('Steel Column 200');
  });

  it('merges two elements with the same name family into one group', () => {
    const groups = buildColourGroups(MATERIAL_TREE, 'material');
    const concrete = groups.find(g => g.label === 'Concrete Block 200mm');
    expect(concrete?.ids).toHaveLength(2);
    expect(concrete?.ids).toContain(101);
    expect(concrete?.ids).toContain(102);
  });
});

/**
 * Vitest coverage for the generic colour-layer helpers:
 * heatRamp (pure ramp math), buildHeatmapLayer (bucketing + legend),
 * and flattenColourLayers (the paint/snapshot merge rule).
 */


const HEX_RE = /^#[0-9a-f]{6}$/;

describe('heatRamp', () => {
  it('returns lowercase #rrggbb strings across the ramp', () => {
    for (const t of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      expect(heatRamp(t)).toMatch(HEX_RE);
    }
  });

  it('anchors: blue at 0, red at 1', () => {
    expect(heatRamp(0)).toBe('#2563eb');
    expect(heatRamp(1)).toBe('#ef4444');
  });

  it('hits the interior anchors at the piecewise joints', () => {
    expect(heatRamp(1 / 3)).toBe('#22d3ee'); // cyan
    expect(heatRamp(2 / 3)).toBe('#facc15'); // yellow
  });

  it('clamps out-of-range input to the ends', () => {
    expect(heatRamp(-3)).toBe(heatRamp(0));
    expect(heatRamp(42)).toBe(heatRamp(1));
  });

  it('maps non-finite input to the cold end', () => {
    expect(heatRamp(Number.NaN)).toBe(heatRamp(0));
    expect(heatRamp(Number.POSITIVE_INFINITY)).toBe(heatRamp(1));
    expect(heatRamp(Number.NEGATIVE_INFINITY)).toBe(heatRamp(0));
  });

  it('interpolates between anchors (midpoint of blue->cyan)', () => {
    // t=1/6 is halfway between anchor 0 (#2563eb) and anchor 1 (#22d3ee).
    expect(heatRamp(1 / 6)).toBe('#249bed');
  });
});

describe('buildHeatmapLayer', () => {
  it('buckets values over the min..max range with a full-scale legend', () => {
    const layer = buildHeatmapLayer(
      [
        { id: 1, value: 0 },
        { id: 2, value: 4 },
        { id: 3, value: 10 },
      ],
      { buckets: 5 },
    );
    // Full scale: legend row per bucket even for empty buckets.
    expect(layer.legend).toHaveLength(5);
    // Entries only for non-empty buckets: 0 -> bucket 0, 4 -> bucket 2, 10 -> bucket 4.
    expect(layer.entries).toHaveLength(3);
    expect(layer.entries[0]).toEqual({ color: heatRamp(0), ids: [1] });
    expect(layer.entries[1]).toEqual({ color: heatRamp(0.5), ids: [2] });
    expect(layer.entries[2]).toEqual({ color: heatRamp(1), ids: [3] });
  });

  it('puts the max value in the LAST bucket, not an overflow bucket', () => {
    const layer = buildHeatmapLayer(
      [
        { id: 1, value: 0 },
        { id: 2, value: 10 },
      ],
      { buckets: 2 },
    );
    expect(layer.entries).toHaveLength(2);
    expect(layer.entries[1].ids).toEqual([2]);
  });

  it('clamps values outside an explicit min/max into the edge buckets', () => {
    const layer = buildHeatmapLayer(
      [
        { id: 1, value: -100 },
        { id: 2, value: 900 },
      ],
      { min: 0, max: 10, buckets: 4 },
    );
    expect(layer.entries).toHaveLength(2);
    expect(layer.entries[0]).toEqual({ color: heatRamp(0), ids: [1] });
    expect(layer.entries[1]).toEqual({ color: heatRamp(1), ids: [2] });
  });

  it('min === max degenerates to one mid-ramp bucket', () => {
    const layer = buildHeatmapLayer(
      [
        { id: 1, value: 7 },
        { id: 2, value: 7 },
      ],
      { buckets: 5 },
    );
    expect(layer.entries).toHaveLength(1);
    expect(layer.entries[0]).toEqual({ color: heatRamp(0.5), ids: [1, 2] });
    expect(layer.legend).toEqual([{ color: heatRamp(0.5), label: '7' }]);
  });

  it('default legend labels are "lo - hi" with 3 significant digits', () => {
    const layer = buildHeatmapLayer(
      [
        { id: 1, value: 0 },
        { id: 2, value: 1 },
      ],
      { buckets: 3 },
    );
    expect(layer.legend?.map((r) => r.label)).toEqual([
      '0 - 0.333',
      '0.333 - 0.667',
      '0.667 - 1',
    ]);
  });

  it('uses a custom label function when provided', () => {
    const layer = buildHeatmapLayer(
      [
        { id: 1, value: 0 },
        { id: 2, value: 2 },
      ],
      { buckets: 2, label: (lo, hi) => `${lo.toFixed(0)} to ${hi.toFixed(0)} kg` },
    );
    expect(layer.legend?.map((r) => r.label)).toEqual(['0 to 1 kg', '1 to 2 kg']);
  });

  it('passes the name through and ignores non-finite values', () => {
    const layer = buildHeatmapLayer(
      [
        { id: 1, value: 1 },
        { id: 2, value: Number.NaN },
        { id: 3, value: Number.POSITIVE_INFINITY },
        { id: 4, value: 3 },
      ],
      { buckets: 2, name: 'Elements per storey' },
    );
    expect(layer.name).toBe('Elements per storey');
    expect(layer.entries.flatMap((e) => e.ids).sort()).toEqual([1, 4]);
  });

  it('returns an empty layer for empty (or all-non-finite) input', () => {
    expect(buildHeatmapLayer([])).toEqual({ entries: [], legend: [], name: undefined });
    expect(buildHeatmapLayer([{ id: 1, value: Number.NaN }]).entries).toEqual([]);
  });

  it('swaps an inverted explicit min/max instead of producing NaN buckets', () => {
    const layer = buildHeatmapLayer(
      [{ id: 1, value: 5 }],
      { min: 10, max: 0, buckets: 2 },
    );
    expect(layer.entries).toHaveLength(1);
    expect(layer.entries[0].ids).toEqual([1]);
  });
});

describe('flattenColourLayers', () => {
  const layer = (entries: ColourLayer['entries']): ColourLayer => ({ entries });

  it('passes a single layer through as colour groups', () => {
    const out = flattenColourLayers({
      a: layer([{ color: '#ff0000', ids: [1, 2] }, { color: '#00ff00', ids: [3] }]),
    });
    expect(out).toEqual([
      { color: '#ff0000', ids: [1, 2] },
      { color: '#00ff00', ids: [3] },
    ]);
  });

  it('later layers win for overlapping ids', () => {
    const out = flattenColourLayers({
      first: layer([{ color: '#ff0000', ids: [1, 2, 3] }]),
      second: layer([{ color: '#0000ff', ids: [2] }]),
    });
    expect(out).toEqual([
      { color: '#ff0000', ids: [1, 3] },
      { color: '#0000ff', ids: [2] },
    ]);
  });

  it('later entries win inside one layer', () => {
    const out = flattenColourLayers({
      a: layer([
        { color: '#ff0000', ids: [1, 2] },
        { color: '#0000ff', ids: [2] },
      ]),
    });
    expect(out).toEqual([
      { color: '#ff0000', ids: [1] },
      { color: '#0000ff', ids: [2] },
    ]);
  });

  it('merges same-colour entries into one paint group', () => {
    const out = flattenColourLayers({
      a: layer([{ color: '#ff0000', ids: [1] }]),
      b: layer([{ color: '#ff0000', ids: [2] }]),
    });
    expect(out).toEqual([{ color: '#ff0000', ids: [1, 2] }]);
  });

  it('returns [] for no layers', () => {
    expect(flattenColourLayers({})).toEqual([]);
  });
});
