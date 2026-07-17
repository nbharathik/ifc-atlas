import { describe, it, expect } from 'vitest';
import {
  describeAppliedFilters,
  countAppliedFilters,
  type AppliedFiltersInput,
} from '../appliedFilters';

const CLEAN: AppliedFiltersInput = {
  isolatedCount: 0,
  hiddenCount: 0,
  ghostModeOn: false,
  enabledClipPlaneCount: 0,
  sectionBoxEnabled: false,
  hasSectionWorkspace: false,
  colourBy: 'off',
  colourLayerCount: 0,
  highlightedCount: 0,
  measurementCount: 0,
  measurementMode: 'off',
  pickPlaneMode: false,
};

function ids(input: Partial<AppliedFiltersInput>) {
  return describeAppliedFilters({ ...CLEAN, ...input }).map((f) => f.id);
}

describe('describeAppliedFilters', () => {
  it('reports nothing for an as-loaded model', () => {
    expect(describeAppliedFilters(CLEAN)).toEqual([]);
    expect(countAppliedFilters(CLEAN)).toBe(0);
  });

  it('counts isolation and hiding as one visibility row, never two', () => {
    // The store makes these mutually exclusive; the UI must not imply otherwise.
    expect(ids({ isolatedCount: 3 })).toEqual(['visibility']);
    expect(ids({ hiddenCount: 5 })).toEqual(['visibility']);
    expect(ids({ isolatedCount: 3, hiddenCount: 5 })).toEqual(['visibility']);
  });

  it('distinguishes isolate from hide in the detail text', () => {
    const [isolated] = describeAppliedFilters({ ...CLEAN, isolatedCount: 3 });
    expect(isolated.label).toBe('Isolated elements');
    expect(isolated.detail).toContain('3 elements');

    const [hidden] = describeAppliedFilters({ ...CLEAN, hiddenCount: 1 });
    expect(hidden.label).toBe('Hidden elements');
    expect(hidden.detail).toBe('1 element');
  });

  it('ignores ghost xray unless something is actually isolated', () => {
    // Ghost with no isolation paints nothing, so listing it would be a lie.
    expect(ids({ ghostModeOn: true })).toEqual([]);
    expect(ids({ ghostModeOn: true, isolatedCount: 2 })).toEqual(['visibility', 'ghost']);
  });

  it('ignores disabled clip planes', () => {
    expect(ids({ enabledClipPlaneCount: 0 })).toEqual([]);
    expect(ids({ enabledClipPlaneCount: 2 })).toEqual(['clip-planes']);
  });

  it('reports a section workspace even when the box is toggled off', () => {
    // The fitted bounds survive the toggle, so they are still "applied".
    expect(ids({ hasSectionWorkspace: true })).toEqual(['section-box']);
    expect(ids({ sectionBoxEnabled: true })).toEqual(['section-box']);
    // ...but never twice.
    expect(ids({ sectionBoxEnabled: true, hasSectionWorkspace: true })).toEqual(['section-box']);
  });

  it('names the active colour-by property', () => {
    const [row] = describeAppliedFilters({ ...CLEAN, colourBy: 'storey' });
    expect(row.detail).toBe('Storey');
  });

  it('separates AI colour overlays from colour-by', () => {
    expect(ids({ colourBy: 'type', colourLayerCount: 2 })).toEqual(['colour-by', 'colour-layers']);
  });

  it('lists committed measurements and an armed tool independently', () => {
    expect(ids({ measurementCount: 4 })).toEqual(['measurements']);
    expect(ids({ measurementMode: 'linear' })).toEqual(['measure-mode']);
    const rows = describeAppliedFilters({ ...CLEAN, measurementCount: 4, measurementMode: 'angle' });
    expect(rows.map((r) => r.id)).toEqual(['measurements', 'measure-mode']);
    expect(rows[1].detail).toBe('Angle armed');
  });

  it('orders rows visibility -> section -> paint -> annotation', () => {
    expect(ids({
      isolatedCount: 1,
      ghostModeOn: true,
      enabledClipPlaneCount: 1,
      sectionBoxEnabled: true,
      colourBy: 'type',
      colourLayerCount: 1,
      highlightedCount: 2,
      measurementCount: 1,
      measurementMode: 'linear',
      pickPlaneMode: true,
    })).toEqual([
      'visibility',
      'ghost',
      'clip-planes',
      'section-box',
      'colour-by',
      'colour-layers',
      'highlights',
      'measurements',
      'measure-mode',
      'pick-plane',
    ]);
  });

  it('counts every applied override', () => {
    expect(countAppliedFilters({ ...CLEAN, isolatedCount: 1, colourBy: 'type' })).toBe(2);
  });
});
