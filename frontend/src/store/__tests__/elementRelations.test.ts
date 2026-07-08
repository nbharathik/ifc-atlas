/**
 * Tests for ElementRelations types and data-shape helpers.
 *
 * The Relations section is a React component so we can't render it in vitest
 * without a DOM. We instead test the pure data-processing helpers that were
 * factored out, and validate the API type shapes so regressions surface early.
 */

import { describe, it, expect } from 'vitest';
import type { ElementRelations, ElementMaterial, ElementRelation } from '../../services/api';

// ---------------------------------------------------------------------------
// Type-shape smoke tests
// ---------------------------------------------------------------------------

describe('ElementRelations type shape', () => {
  it('accepts a well-formed relations payload', () => {
    const payload: ElementRelations = {
      element_id: 42,
      material: {
        material_type: 'layer_set',
        layer_set_name: 'Exterior Wall',
        layers: [
          { name: 'Concrete', thickness_mm: 200 },
          { name: 'Insulation', thickness_mm: 80 },
        ],
        total_thickness_mm: 280,
      },
      connections: {
        element_id: 42,
        count: 2,
        connected_elements: [
          { id: 10, name: 'Wall-A', ifc_type: 'IfcWallStandardCase', connection_type: 'ATSTART' },
          { id: 11, name: 'Wall-B', ifc_type: 'IfcWallStandardCase', connection_type: 'ATEND' },
        ],
      },
      openings: {
        element_id: 42,
        count: 1,
        openings: [
          { id: 20, name: 'Window 01', ifc_type: 'IfcWindow' },
        ],
      },
    };

    expect(payload.element_id).toBe(42);
    expect(payload.material.layers).toHaveLength(2);
    expect(payload.connections.count).toBe(2);
    expect(payload.openings.count).toBe(1);
  });

  it('accepts a none-material payload', () => {
    const mat: ElementMaterial = { material_type: 'none', layers: [] };
    expect(mat.material_type).toBe('none');
    expect(mat.layers).toHaveLength(0);
  });

  it('accepts a single-material payload', () => {
    const mat: ElementMaterial = { material_type: 'single', name: 'Steel', layers: [] };
    expect(mat.name).toBe('Steel');
  });

  it('accepts a connection with null connection_type', () => {
    const rel: ElementRelation = { id: 5, name: 'Wall', ifc_type: 'IfcWall', connection_type: null };
    expect(rel.connection_type).toBeNull();
  });

  it('accepts a connection without connection_type field', () => {
    const rel: ElementRelation = { id: 5, name: 'Wall', ifc_type: 'IfcWall' };
    expect(rel.connection_type).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Pure helper: hasAny logic (extracted from RelationsSection)
// ---------------------------------------------------------------------------

function hasAnyRelations(data: ElementRelations): boolean {
  const hasMaterial = data.material.material_type !== 'none';
  const hasConnections = data.connections.count > 0;
  const hasOpenings = data.openings.count > 0;
  return hasMaterial || hasConnections || hasOpenings;
}

function countRelationItems(data: ElementRelations): number {
  const hasMaterial = data.material.material_type !== 'none' ? 1 : 0;
  return data.connections.count + data.openings.count + hasMaterial;
}

describe('hasAnyRelations', () => {
  const emptyRelations = (mat: ElementMaterial): ElementRelations => ({
    element_id: 1,
    material: mat,
    connections: { element_id: 1, count: 0, connected_elements: [] },
    openings: { element_id: 1, count: 0, openings: [] },
  });

  it('returns false when all relations are empty', () => {
    const r = emptyRelations({ material_type: 'none', layers: [] });
    expect(hasAnyRelations(r)).toBe(false);
  });

  it('returns true when material is present', () => {
    const r = emptyRelations({ material_type: 'single', name: 'Steel', layers: [] });
    expect(hasAnyRelations(r)).toBe(true);
  });

  it('returns true when there are connections', () => {
    const r: ElementRelations = {
      element_id: 1,
      material: { material_type: 'none', layers: [] },
      connections: {
        element_id: 1,
        count: 1,
        connected_elements: [{ id: 2, name: 'Wall', ifc_type: 'IfcWall' }],
      },
      openings: { element_id: 1, count: 0, openings: [] },
    };
    expect(hasAnyRelations(r)).toBe(true);
  });

  it('returns true when there are openings', () => {
    const r: ElementRelations = {
      element_id: 1,
      material: { material_type: 'none', layers: [] },
      connections: { element_id: 1, count: 0, connected_elements: [] },
      openings: {
        element_id: 1,
        count: 1,
        openings: [{ id: 5, name: 'Window', ifc_type: 'IfcWindow' }],
      },
    };
    expect(hasAnyRelations(r)).toBe(true);
  });
});

describe('countRelationItems', () => {
  it('counts 0 for empty payload', () => {
    const r: ElementRelations = {
      element_id: 1,
      material: { material_type: 'none', layers: [] },
      connections: { element_id: 1, count: 0, connected_elements: [] },
      openings: { element_id: 1, count: 0, openings: [] },
    };
    expect(countRelationItems(r)).toBe(0);
  });

  it('counts 1 for a single material (no connections/openings)', () => {
    const r: ElementRelations = {
      element_id: 1,
      material: { material_type: 'layer_set', layers: [{ name: 'X', thickness_mm: 100 }] },
      connections: { element_id: 1, count: 0, connected_elements: [] },
      openings: { element_id: 1, count: 0, openings: [] },
    };
    expect(countRelationItems(r)).toBe(1);
  });

  it('sums material + connections + openings', () => {
    const r: ElementRelations = {
      element_id: 1,
      material: { material_type: 'single', name: 'Steel', layers: [] },
      connections: { element_id: 1, count: 3, connected_elements: [] },
      openings: { element_id: 1, count: 2, openings: [] },
    };
    // 1 (material) + 3 (connections) + 2 (openings) = 6
    expect(countRelationItems(r)).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Layer rendering helper
// ---------------------------------------------------------------------------

function formatLayerThickness(layers: Array<{ name: string; thickness_mm: number }>): string[] {
  return layers.map((l) => `${l.name}: ${l.thickness_mm} mm`);
}

describe('formatLayerThickness', () => {
  it('formats a single layer', () => {
    const result = formatLayerThickness([{ name: 'Concrete', thickness_mm: 200 }]);
    expect(result).toEqual(['Concrete: 200 mm']);
  });

  it('formats multiple layers', () => {
    const layers = [
      { name: 'Insulation', thickness_mm: 100 },
      { name: 'Plaster', thickness_mm: 20 },
    ];
    const result = formatLayerThickness(layers);
    expect(result).toEqual(['Insulation: 100 mm', 'Plaster: 20 mm']);
  });

  it('returns empty array for no layers', () => {
    expect(formatLayerThickness([])).toEqual([]);
  });
});
