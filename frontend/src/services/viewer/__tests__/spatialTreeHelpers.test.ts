import { describe, expect, it } from 'vitest';
import type { SpatialNode } from '../../../types/ifc';
import {
  collectIdsByType,
  collectLeavesUnder,
  findIfcTypeForId,
  findNodeById,
  findStoreyFor,
} from '../spatialTreeHelpers';

/** Build a minimal two-storey fixture mirroring BasicHouse.ifc's shape:
 *  Project → Site → Building → [Storey GF, Storey 1F] → walls + doors.
 *  Using contrived ids (1..99) keeps the assertions readable. */
function makeTree(): SpatialNode {
  const gfWalls: SpatialNode[] = [
    { id: 10, global_id: 'w-gf-1', name: 'Wall GF 1', ifc_type: 'IfcWall', children: [] },
    { id: 11, global_id: 'w-gf-2', name: 'Wall GF 2', ifc_type: 'IfcWall', children: [] },
    { id: 12, global_id: 'd-gf-1', name: 'Door GF 1', ifc_type: 'IfcDoor', children: [] },
  ];
  const fWalls: SpatialNode[] = [
    { id: 20, global_id: 'w-1f-1', name: 'Wall 1F 1', ifc_type: 'IfcWall', children: [] },
    { id: 21, global_id: 'win-1f-1', name: 'Window 1F 1', ifc_type: 'IfcWindow', children: [] },
  ];
  const gfStorey: SpatialNode = {
    id: 2, global_id: 'gf', name: 'Ground', ifc_type: 'IfcBuildingStorey', children: gfWalls,
  };
  const fStorey: SpatialNode = {
    id: 3, global_id: '1f', name: 'First', ifc_type: 'IfcBuildingStorey', children: fWalls,
  };
  const building: SpatialNode = {
    id: 1, global_id: 'b', name: 'House', ifc_type: 'IfcBuilding', children: [gfStorey, fStorey],
  };
  const site: SpatialNode = {
    id: -2, global_id: 'site', name: 'Site', ifc_type: 'IfcSite', children: [building],
  };
  return {
    id: -1, global_id: 'proj', name: 'Project', ifc_type: 'IfcProject', children: [site],
  };
}

describe('collectIdsByType', () => {
  const tree = makeTree();

  it('returns all walls (case-insensitive match)', () => {
    expect(collectIdsByType(tree, 'IfcWall').sort()).toEqual([10, 11, 20]);
  });

  it('ignores case differences', () => {
    expect(collectIdsByType(tree, 'ifcwall').sort()).toEqual([10, 11, 20]);
    expect(collectIdsByType(tree, 'IFCWALL').sort()).toEqual([10, 11, 20]);
  });

  it('returns [] for types that do not appear', () => {
    expect(collectIdsByType(tree, 'IfcStair')).toEqual([]);
  });

  it('returns [] when the root is null', () => {
    expect(collectIdsByType(null, 'IfcWall')).toEqual([]);
  });

  it('skips sentinel / placeholder ids (id <= 0) even on match', () => {
    expect(collectIdsByType(tree, 'IfcProject')).toEqual([]);
    expect(collectIdsByType(tree, 'IfcSite')).toEqual([]);
  });
});

describe('findStoreyFor', () => {
  const tree = makeTree();

  it('finds the ground-floor storey for a GF wall', () => {
    const storey = findStoreyFor(tree, 10);
    expect(storey).not.toBeNull();
    expect(storey!.id).toBe(2);
    expect(storey!.name).toBe('Ground');
  });

  it('finds the first-floor storey for a 1F window', () => {
    const storey = findStoreyFor(tree, 21);
    expect(storey).not.toBeNull();
    expect(storey!.id).toBe(3);
  });

  it('returns null for a storey-sibling node (no enclosing storey)', () => {
    expect(findStoreyFor(tree, 1)).toBeNull();
  });

  it('returns the storey node itself when asked for the storey id', () => {
    expect(findStoreyFor(tree, 2)?.id).toBe(2);
  });

  it('returns null when the id is not in the tree', () => {
    expect(findStoreyFor(tree, 9999)).toBeNull();
  });

  it('returns null on an empty tree', () => {
    expect(findStoreyFor(null, 10)).toBeNull();
  });
});

describe('collectLeavesUnder', () => {
  const tree = makeTree();

  it('returns every non-container express id under a storey', () => {
    const gfStorey = tree.children[0].children[0].children[0]; // Project > Site > Building > GF
    expect(collectLeavesUnder(gfStorey).sort()).toEqual([10, 11, 12]);
  });

  it('returns every leaf under the whole building (merges storeys)', () => {
    const building = tree.children[0].children[0];
    expect(collectLeavesUnder(building).sort()).toEqual([10, 11, 12, 20, 21]);
  });

  it('returns empty for a leaf element (no children to collect)', () => {
    const wall = tree.children[0].children[0].children[0].children[0];
    expect(collectLeavesUnder(wall)).toEqual([10]);
  });

  it('excludes IfcSpace nodes (containers) but includes their child elements', () => {
    // Mirror real BasicHouse layout: a storey may parent an IfcSpace which
    // itself parents furniture / fittings. The space itself must NOT show
    // up in "isolate storey" because it has no renderable geometry of its
    // own and would visually overlap every leaf inside it.
    const space: SpatialNode = {
      id: 99, global_id: 'space-1', name: 'Living', ifc_type: 'IfcSpace',
      children: [
        { id: 30, global_id: 'f-1', name: 'Chair', ifc_type: 'IfcFurniture', children: [] },
      ],
    };
    const storey: SpatialNode = {
      id: 50, global_id: 'gf', name: 'GF', ifc_type: 'IfcBuildingStorey',
      children: [space, { id: 31, global_id: 'w-1', name: 'Wall', ifc_type: 'IfcWall', children: [] }],
    };
    expect(collectLeavesUnder(storey).sort()).toEqual([30, 31]);
  });

  it('walks deeply nested geometry (IfcOpening → IfcWindow inside an IfcWall)', () => {
    // Real IFC trees chain hosted elements 3-4 levels deep. Helpers must
    // recurse through the whole subtree, not just the immediate children.
    const window: SpatialNode = { id: 42, global_id: 'win', name: 'Window', ifc_type: 'IfcWindow', children: [] };
    const opening: SpatialNode = { id: 41, global_id: 'op', name: 'Opening', ifc_type: 'IfcOpeningElement', children: [window] };
    const wall: SpatialNode = { id: 40, global_id: 'w', name: 'Wall', ifc_type: 'IfcWall', children: [opening] };
    const storey: SpatialNode = { id: 4, global_id: 'gf', name: 'GF', ifc_type: 'IfcBuildingStorey', children: [wall] };
    expect(collectLeavesUnder(storey).sort()).toEqual([40, 41, 42]);
  });
});

describe('findIfcTypeForId', () => {
  const tree = makeTree();

  it('finds the ifc_type of a wall', () => {
    expect(findIfcTypeForId(tree, 10)).toBe('IfcWall');
  });

  it('finds the ifc_type of a storey', () => {
    expect(findIfcTypeForId(tree, 2)).toBe('IfcBuildingStorey');
  });

  it('returns null for missing ids', () => {
    expect(findIfcTypeForId(tree, 999)).toBeNull();
  });

  it('returns null on a null root', () => {
    expect(findIfcTypeForId(null, 10)).toBeNull();
  });
});

describe('findNodeById', () => {
  const tree = makeTree();

  it('returns the full node for a wall', () => {
    const node = findNodeById(tree, 10);
    expect(node).not.toBeNull();
    expect(node!.id).toBe(10);
    expect(node!.name).toBe('Wall GF 1');
    expect(node!.ifc_type).toBe('IfcWall');
  });

  it('returns the storey node when queried by storey id', () => {
    const node = findNodeById(tree, 2);
    expect(node).not.toBeNull();
    expect(node!.ifc_type).toBe('IfcBuildingStorey');
    expect(node!.name).toBe('Ground');
  });

  it('finds a deeply nested node', () => {
    const node = findNodeById(tree, 21);
    expect(node).not.toBeNull();
    expect(node!.name).toBe('Window 1F 1');
    expect(node!.ifc_type).toBe('IfcWindow');
  });

  it('returns null when id is not in tree', () => {
    expect(findNodeById(tree, 9999)).toBeNull();
  });

  it('returns null on a null root', () => {
    expect(findNodeById(null, 10)).toBeNull();
  });
});
