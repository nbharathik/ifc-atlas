import { describe, it, expect } from 'vitest';
import { collectIfcTypes } from '../Sidebar';
import type { SpatialNode } from '../../../types/ifc';

function makeNode(
  id: number,
  ifc_type: string,
  name: string,
  children: SpatialNode[] = [],
): SpatialNode {
  return { id, ifc_type, name, global_id: `GUID_${id}`, children };
}

const sampleTree: SpatialNode = makeNode(1, 'IfcProject', 'My Project', [
  makeNode(2, 'IfcSite', 'Default Site', [
    makeNode(3, 'IfcBuilding', 'Building', [
      makeNode(4, 'IfcBuildingStorey', 'Ground Floor', [
        makeNode(10, 'IfcWall', 'Wall 1'),
        makeNode(11, 'IfcWall', 'Wall 2'),
        makeNode(12, 'IfcDoor', 'Door 1'),
        makeNode(13, 'IfcWindow', 'Window 1'),
        makeNode(14, 'IfcWindow', 'Window 2'),
        makeNode(15, 'IfcWindow', 'Window 3'),
      ]),
      makeNode(5, 'IfcBuildingStorey', 'First Floor', [
        makeNode(20, 'IfcWall', 'Wall 3'),
        makeNode(21, 'IfcSlab', 'Slab 1'),
      ]),
    ]),
  ]),
]);

describe('collectIfcTypes', () => {
  it('returns a Map', () => {
    const m = collectIfcTypes(sampleTree);
    expect(m).toBeInstanceOf(Map);
  });

  it('counts IfcWall correctly', () => {
    const m = collectIfcTypes(sampleTree);
    expect(m.get('IfcWall')).toBe(3);
  });

  it('counts IfcWindow correctly', () => {
    const m = collectIfcTypes(sampleTree);
    expect(m.get('IfcWindow')).toBe(3);
  });

  it('counts IfcDoor correctly', () => {
    const m = collectIfcTypes(sampleTree);
    expect(m.get('IfcDoor')).toBe(1);
  });

  it('counts container types', () => {
    const m = collectIfcTypes(sampleTree);
    expect(m.get('IfcProject')).toBe(1);
    expect(m.get('IfcBuildingStorey')).toBe(2);
  });

  it('single node returns count 1', () => {
    const node = makeNode(99, 'IfcBeam', 'Beam');
    const m = collectIfcTypes(node);
    expect(m.get('IfcBeam')).toBe(1);
    expect(m.size).toBe(1);
  });

  it('does not count types absent from tree', () => {
    const m = collectIfcTypes(sampleTree);
    expect(m.get('IfcColumn')).toBeUndefined();
  });

  it('total count equals node count', () => {
    const m = collectIfcTypes(sampleTree);
    const total = Array.from(m.values()).reduce((a, b) => a + b, 0);
    // 1 Project + 1 Site + 1 Building + 2 Storeys + 3 Walls + 1 Door + 3 Windows + 1 Slab = 13
    expect(total).toBe(13);
  });
});
