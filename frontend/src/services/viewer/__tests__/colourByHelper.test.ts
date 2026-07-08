import { describe, it, expect } from 'vitest';
import { PALETTE, buildColourGroups, shortIfcType, hashStringToHSL, extractNameGroup } from '../colourByHelper';
import { SELECTION_HIGHLIGHT_HEX } from '../selectionHighlightHelpers';
import type { SpatialNode } from '../../../types/ifc';

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
