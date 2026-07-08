import { describe, it, expect } from 'vitest';
import type { ElementSummary } from '../../../types/ifc';
import {
  formatElementLabel,
  formatTypeLabel,
  zoomAriaLabel,
  isolateAriaLabel,
  groupResultsByClass,
  groupHeaderLabel,
  enrichmentProgressLabel,
} from '../searchPanelHelpers';

function makeEl(overrides: Partial<ElementSummary> = {}): ElementSummary {
  return {
    id: 42,
    global_id: 'GLOBAL42',
    name: 'Test Wall',
    ifc_type: 'IfcWall',
    storey: 'Ground Floor',
    ...overrides,
  };
}

// ─── formatElementLabel ───────────────────────────────────────────────────────

describe('formatElementLabel', () => {
  it('returns name when present', () => {
    expect(formatElementLabel(makeEl({ name: 'South Wall' }))).toBe('South Wall');
  });

  it('returns #id when name is null', () => {
    expect(formatElementLabel(makeEl({ name: null }))).toBe('#42');
  });

  it('returns #id when name is empty string', () => {
    expect(formatElementLabel(makeEl({ id: 99, name: '' }))).toBe('#99');
  });

  it('returns #id for unnamed element with different id', () => {
    expect(formatElementLabel(makeEl({ id: 99, name: null }))).toBe('#99');
  });
});

// ─── formatTypeLabel ──────────────────────────────────────────────────────────

describe('formatTypeLabel', () => {
  it('strips Ifc prefix', () => {
    expect(formatTypeLabel('IfcWall')).toBe('Wall');
  });

  it('strips Ifc prefix from IfcBeam', () => {
    expect(formatTypeLabel('IfcBeam')).toBe('Beam');
  });

  it('strips Ifc prefix from IfcBuildingElementProxy', () => {
    expect(formatTypeLabel('IfcBuildingElementProxy')).toBe('BuildingElementProxy');
  });

  it('leaves non-Ifc-prefixed types unchanged', () => {
    expect(formatTypeLabel('CustomType')).toBe('CustomType');
  });

  it('only removes the leading Ifc prefix once', () => {
    expect(formatTypeLabel('IfcIfcWall')).toBe('IfcWall');
  });
});

// ─── zoomAriaLabel ────────────────────────────────────────────────────────────

describe('zoomAriaLabel', () => {
  it('uses element name when present', () => {
    expect(zoomAriaLabel(makeEl({ name: 'Column A' }))).toBe('Zoom to Column A');
  });

  it('falls back to ifc_type when name is null', () => {
    expect(zoomAriaLabel(makeEl({ name: null }))).toBe('Zoom to IfcWall');
  });
});

// ─── isolateAriaLabel ─────────────────────────────────────────────────────────

describe('isolateAriaLabel', () => {
  it('uses element name when present', () => {
    expect(isolateAriaLabel(makeEl({ name: 'Slab Level 1' }))).toBe('Isolate Slab Level 1');
  });

  it('falls back to ifc_type when name is null', () => {
    expect(isolateAriaLabel(makeEl({ name: null, ifc_type: 'IfcSlab' }))).toBe('Isolate IfcSlab');
  });
});

// ─── groupResultsByClass ──────────────────────────────────────────────────────

describe('groupResultsByClass', () => {
  it('returns no groups for no results', () => {
    expect(groupResultsByClass([])).toEqual([]);
  });

  it('groups elements by ifc_type', () => {
    const groups = groupResultsByClass([
      makeEl({ id: 1, ifc_type: 'IfcWall' }),
      makeEl({ id: 2, ifc_type: 'IfcDoor' }),
      makeEl({ id: 3, ifc_type: 'IfcWall' }),
    ]);
    expect(groups).toHaveLength(2);
    const wall = groups.find((g) => g.ifcType === 'IfcWall');
    expect(wall?.elements.map((e) => e.id)).toEqual([1, 3]);
  });

  it('orders groups by size descending, then class name', () => {
    const groups = groupResultsByClass([
      makeEl({ id: 1, ifc_type: 'IfcDoor' }),
      makeEl({ id: 2, ifc_type: 'IfcWall' }),
      makeEl({ id: 3, ifc_type: 'IfcWall' }),
      makeEl({ id: 4, ifc_type: 'IfcBeam' }),
    ]);
    expect(groups.map((g) => g.ifcType)).toEqual(['IfcWall', 'IfcBeam', 'IfcDoor']);
  });

  it('preserves element order within a group (relevance order)', () => {
    const groups = groupResultsByClass([
      makeEl({ id: 9, ifc_type: 'IfcWall' }),
      makeEl({ id: 3, ifc_type: 'IfcWall' }),
      makeEl({ id: 7, ifc_type: 'IfcWall' }),
    ]);
    expect(groups[0].elements.map((e) => e.id)).toEqual([9, 3, 7]);
  });
});

// ─── group / progress labels ──────────────────────────────────────────────────

describe('groupHeaderLabel', () => {
  it('formats class name with count', () => {
    const groups = groupResultsByClass([
      makeEl({ id: 1, ifc_type: 'IfcWall' }),
      makeEl({ id: 2, ifc_type: 'IfcWall' }),
    ]);
    expect(groupHeaderLabel(groups[0])).toBe('IfcWall (2)');
  });
});

describe('enrichmentProgressLabel', () => {
  it('formats processed/total', () => {
    expect(enrichmentProgressLabel(2400, 8000)).toBe('Indexing properties... 2400/8000');
  });
});

// ─── store-level: setIsolatedIds (search-panel use case) ─────────────────────

import { useStore } from '../../../store/useStore';

describe('setIsolatedIds via search panel isolate action', () => {
  it('isolates a single element', () => {
    useStore.setState({ isolatedIds: [] });
    useStore.getState().setIsolatedIds([42]);
    expect(useStore.getState().isolatedIds).toEqual([42]);
  });

  it('isolates multiple elements from a search result set', () => {
    useStore.setState({ isolatedIds: [] });
    useStore.getState().setIsolatedIds([1, 2, 3, 99]);
    expect(useStore.getState().isolatedIds).toEqual([1, 2, 3, 99]);
  });

  it('replaces previous isolation when called again', () => {
    useStore.getState().setIsolatedIds([10]);
    useStore.getState().setIsolatedIds([20, 21]);
    expect(useStore.getState().isolatedIds).toEqual([20, 21]);
  });

  it('clears isolation when passed empty array', () => {
    useStore.getState().setIsolatedIds([5]);
    useStore.getState().setIsolatedIds([]);
    expect(useStore.getState().isolatedIds).toEqual([]);
  });
});
