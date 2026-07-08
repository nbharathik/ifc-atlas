import { describe, it, expect } from 'vitest';
import {
  MAX_TYPES_SHOWN,
  MAX_TYPE_LABEL_LEN,
  SELECTION_SUMMARY_INSPECT_TAB,
  shortenIfcType,
  truncateTypeLabel,
  collectSelectedTypes,
  buildSelectionTypeHistogram,
  buildSelectionChipText,
  formatBucket,
  formatSelectionChipLine,
} from '../selectionSummaryHelpers';
import type { SpatialNode } from '../../../types/ifc';
import type { RightTab } from '../../../store/useStore';

function n(id: number, ifc_type: string, children: SpatialNode[] = []): SpatialNode {
  return { id, global_id: `g-${id}`, name: `n-${id}`, ifc_type, children };
}

const tree: SpatialNode = n(0, 'IfcProject', [
  n(1, 'IfcSite', [
    n(2, 'IfcBuilding', [
      n(3, 'IfcBuildingStorey', [
        n(10, 'IfcWall'),
        n(11, 'IfcWall'),
        n(12, 'IfcWall'),
        n(13, 'IfcDoor'),
        n(14, 'IfcWindow'),
        n(15, 'IfcSlab'),
        n(16, 'IfcRailing'),
      ]),
    ]),
  ]),
]);

describe('shortenIfcType', () => {
  it('strips the leading Ifc prefix', () => {
    expect(shortenIfcType('IfcWall')).toBe('Wall');
    expect(shortenIfcType('IfcBuildingStorey')).toBe('BuildingStorey');
  });

  it('returns "Element" for null / undefined / empty inputs', () => {
    expect(shortenIfcType(null)).toBe('Element');
    expect(shortenIfcType(undefined)).toBe('Element');
    expect(shortenIfcType('')).toBe('Element');
  });

  it('keeps non-Ifc types intact and stays non-empty if the type WAS only "Ifc"', () => {
    expect(shortenIfcType('CustomThing')).toBe('CustomThing');
    expect(shortenIfcType('Ifc')).toBe('Element');
  });
});

describe('collectSelectedTypes', () => {
  it('returns an empty Map when no tree is provided', () => {
    expect(collectSelectedTypes(null, [10, 11])).toEqual(new Map());
  });

  it('returns an empty Map when no IDs are selected', () => {
    expect(collectSelectedTypes(tree, [])).toEqual(new Map());
  });

  it('walks the tree once and returns id → ifc_type for matched IDs only', () => {
    const got = collectSelectedTypes(tree, [10, 11, 13]);
    expect(got.size).toBe(3);
    expect(got.get(10)).toBe('IfcWall');
    expect(got.get(11)).toBe('IfcWall');
    expect(got.get(13)).toBe('IfcDoor');
  });

  it('silently skips IDs that are not in the tree', () => {
    const got = collectSelectedTypes(tree, [10, 999, 13]);
    expect(got.size).toBe(2);
    expect(got.get(10)).toBe('IfcWall');
    expect(got.has(999)).toBe(false);
  });
});

describe('buildSelectionTypeHistogram', () => {
  it('builds an empty histogram for empty inputs', () => {
    expect(buildSelectionTypeHistogram(null, [])).toEqual([]);
    expect(buildSelectionTypeHistogram(tree, [])).toEqual([]);
  });

  it('groups by shortened IFC type and sorts by descending count', () => {
    const hist = buildSelectionTypeHistogram(tree, [10, 11, 12, 13, 14]);
    expect(hist).toEqual([
      { type: 'Wall', count: 3 },
      { type: 'Door', count: 1 },
      { type: 'Window', count: 1 },
    ]);
  });

  it('uses ascending type-name as a stable tiebreaker for equal counts', () => {
    const hist = buildSelectionTypeHistogram(tree, [13, 14, 15, 16]);
    // All counts = 1 → alphabetical: Door, Railing, Slab, Window
    expect(hist.map(b => b.type)).toEqual(['Door', 'Railing', 'Slab', 'Window']);
  });

  it('drops stale IDs from the count', () => {
    const hist = buildSelectionTypeHistogram(tree, [10, 11, 12, 9999, 8888]);
    expect(hist).toEqual([{ type: 'Wall', count: 3 }]);
  });
});

describe('buildSelectionChipText', () => {
  it('returns empty=true when there is nothing to summarise', () => {
    const got = buildSelectionChipText(tree, []);
    expect(got.empty).toBe(true);
    expect(got.total).toBe(0);
    expect(got.header).toBe('0 selected');
    expect(got.visibleBuckets).toEqual([]);
    expect(got.hiddenBucketCount).toBe(0);
    expect(got.moreSuffix).toBe('');
  });

  it('computes total from the resolved histogram, not the input length', () => {
    const got = buildSelectionChipText(tree, [10, 11, 9999]);
    expect(got.total).toBe(2);
    expect(got.empty).toBe(false);
    expect(got.header).toBe('2 selected');
  });

  it('caps the visible bucket list at MAX_TYPES_SHOWN', () => {
    const got = buildSelectionChipText(tree, [10, 13, 14, 15, 16]);
    expect(got.visibleBuckets.length).toBe(MAX_TYPES_SHOWN);
    expect(got.hiddenBucketCount).toBe(5 - MAX_TYPES_SHOWN);
    expect(got.moreSuffix).toBe(`+${5 - MAX_TYPES_SHOWN} more`);
  });

  it('omits the more-suffix when all buckets fit within MAX_TYPES_SHOWN', () => {
    const got = buildSelectionChipText(tree, [10, 11, 13]);
    expect(got.hiddenBucketCount).toBe(0);
    expect(got.moreSuffix).toBe('');
  });
});

describe('formatBucket', () => {
  it('renders count + type', () => {
    expect(formatBucket({ type: 'Wall', count: 3 })).toBe('3 Wall');
    expect(formatBucket({ type: 'Door', count: 1 })).toBe('1 Door');
  });
});

describe('truncateTypeLabel', () => {
  it('returns the label unchanged when within the default cap', () => {
    expect(truncateTypeLabel('Wall')).toBe('Wall');
    expect(truncateTypeLabel('BuildingStorey')).toBe('BuildingStorey');
  });

  it('truncates long labels with a single trailing ellipsis at the default cap', () => {
    const long = 'BuildingElementProxyExtra';
    const out = truncateTypeLabel(long);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBe(MAX_TYPE_LABEL_LEN);
    expect(long.startsWith(out.slice(0, -1))).toBe(true);
  });

  it('honours a custom maxLen', () => {
    // 8 = 7-char prefix + ellipsis; total length is exactly 8.
    expect(truncateTypeLabel('BuildingStorey', 8)).toBe('Buildin…');
    expect(truncateTypeLabel('BuildingStorey', 8).length).toBe(8);
  });

  it('returns just the ellipsis for non-positive or non-finite caps', () => {
    expect(truncateTypeLabel('Wall', 0)).toBe('…');
    expect(truncateTypeLabel('Wall', -3)).toBe('…');
    expect(truncateTypeLabel('Wall', Number.NaN)).toBe('…');
    expect(truncateTypeLabel('Wall', Number.POSITIVE_INFINITY)).toBe('…');
  });

  it('returns just the ellipsis for maxLen === 1 to avoid emitting an empty prefix', () => {
    expect(truncateTypeLabel('Wall', 1)).toBe('…');
  });

  it('is idempotent for labels at the cap boundary', () => {
    const exact = 'x'.repeat(MAX_TYPE_LABEL_LEN);
    expect(truncateTypeLabel(exact)).toBe(exact);
  });
});

describe('SELECTION_SUMMARY_INSPECT_TAB', () => {
  it('is the "props" RightTab so the Inspect action opens Properties', () => {
    // Compile-time check + runtime pin - if RightTab is renamed or `props` is
    // removed, the type assignment below stops compiling and this test fires.
    const tab: RightTab = SELECTION_SUMMARY_INSPECT_TAB;
    expect(tab).toBe('props');
  });
});

describe('formatSelectionChipLine', () => {
  it('returns an empty string for an empty payload', () => {
    expect(formatSelectionChipLine(buildSelectionChipText(tree, []))).toBe('');
  });

  it('joins header + visible buckets with a middle dot', () => {
    const text = buildSelectionChipText(tree, [10, 11, 12, 13, 14]);
    expect(formatSelectionChipLine(text)).toBe('5 selected · 3 Wall · 1 Door · 1 Window');
  });

  it('appends the more-suffix when buckets are truncated', () => {
    const text = buildSelectionChipText(tree, [10, 13, 14, 15, 16]);
    // 5 selected, 5 distinct types (1 Wall + 4 single-counts) → 2 hidden after cap=3
    expect(formatSelectionChipLine(text).endsWith(`+${text.hiddenBucketCount} more`)).toBe(true);
    expect(formatSelectionChipLine(text).split(' · ').length).toBe(2 + MAX_TYPES_SHOWN);
  });
});
