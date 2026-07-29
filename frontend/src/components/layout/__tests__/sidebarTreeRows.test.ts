/**
 * Tests for the pure windowed-tree helpers in sidebarTreeRows.ts:
 *   - flattenVisibleRows (expansion, ordering, forced expansion under filters)
 *   - computeRowWindow (viewport slicing + clamping)
 *   - computeDefaultExpandedIds (the large-model collapse seed + threshold)
 *
 * Text/type filtering itself happens upstream (the Sidebar flattens the
 * already-filtered tree), so filter behavior is covered by flattening
 * pre-filtered subtrees + the forceExpandAll flag.
 */

import { describe, it, expect } from 'vitest';
import type { SpatialNode } from '../../../types/ifc';
import {
  TREE_ROW_HEIGHT,
  TREE_OVERSCAN_ROWS,
  FALLBACK_VIEWPORT_PX,
  LARGE_MODEL_COLLAPSE_THRESHOLD,
  flattenVisibleRows,
  computeRowWindow,
  computeDefaultExpandedIds,
} from '../Sidebar';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeNode(
  id: number,
  ifc_type: string,
  children: SpatialNode[] = [],
  name = `Node ${id}`,
): SpatialNode {
  return { id, name, ifc_type, global_id: `G${id}`, children };
}

// Spatial-shaped tree:
//   1 Project
//   └── 2 Site
//       └── 3 Building
//           ├── 4 Storey A
//           │   ├── 10 Wall
//           │   └── 11 Door
//           └── 5 Storey B
//               └── 20 Wall
const SAMPLE = makeNode(1, 'IfcProject', [
  makeNode(2, 'IfcSite', [
    makeNode(3, 'IfcBuilding', [
      makeNode(4, 'IfcBuildingStorey', [
        makeNode(10, 'IfcWall'),
        makeNode(11, 'IfcDoor'),
      ]),
      makeNode(5, 'IfcBuildingStorey', [
        makeNode(20, 'IfcWall'),
      ]),
    ]),
  ]),
]);

const ALL_SAMPLE_IDS = new Set([1, 2, 3, 4, 5, 10, 11, 20]);

/** Spatial skeleton (5 containers) + enough storey children to hit `total` nodes. */
function makeBigTree(total: number): SpatialNode {
  const elements = total - 5;
  const half = Math.floor(elements / 2);
  const storeyA: SpatialNode[] = [];
  const storeyB: SpatialNode[] = [];
  for (let i = 0; i < half; i++) storeyA.push(makeNode(1000 + i, 'IfcWall'));
  for (let i = 0; i < elements - half; i++) storeyB.push(makeNode(100000 + i, 'IfcWall'));
  return makeNode(1, 'IfcProject', [
    makeNode(2, 'IfcSite', [
      makeNode(3, 'IfcBuilding', [
        makeNode(4, 'IfcBuildingStorey', storeyA),
        makeNode(5, 'IfcBuildingStorey', storeyB),
      ]),
    ]),
  ]);
}

// ── flattenVisibleRows ───────────────────────────────────────────────────────

describe('flattenVisibleRows', () => {
  it('returns an empty array for a null root', () => {
    expect(flattenVisibleRows(null, new Set([1]))).toEqual([]);
  });

  it('emits all rows in pre-order with correct depths when fully expanded', () => {
    const rows = flattenVisibleRows(SAMPLE, ALL_SAMPLE_IDS);
    expect(rows.map((r) => r.node.id)).toEqual([1, 2, 3, 4, 10, 11, 5, 20]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 3, 4, 4, 3, 4]);
  });

  it('sets hasChildren and expanded flags per row', () => {
    const rows = flattenVisibleRows(SAMPLE, ALL_SAMPLE_IDS);
    const byId = new Map(rows.map((r) => [r.node.id, r]));
    expect(byId.get(3)!.hasChildren).toBe(true);
    expect(byId.get(3)!.expanded).toBe(true);
    expect(byId.get(10)!.hasChildren).toBe(false);
    // Leaves are never reported expanded, even when their id is in the set.
    expect(byId.get(10)!.expanded).toBe(false);
  });

  it('skips the entire subtree of a collapsed node', () => {
    const expanded = new Set([1, 2, 3, 5]); // storey 4 collapsed
    const rows = flattenVisibleRows(SAMPLE, expanded);
    expect(rows.map((r) => r.node.id)).toEqual([1, 2, 3, 4, 5, 20]);
    const storeyA = rows.find((r) => r.node.id === 4)!;
    expect(storeyA.hasChildren).toBe(true);
    expect(storeyA.expanded).toBe(false);
  });

  it('renders only the root row when nothing is expanded', () => {
    const rows = flattenVisibleRows(SAMPLE, new Set());
    expect(rows.map((r) => r.node.id)).toEqual([1]);
    expect(rows[0].expanded).toBe(false);
  });

  it('forceExpandAll reveals every row regardless of expandedIds', () => {
    const rows = flattenVisibleRows(SAMPLE, new Set(), true);
    expect(rows.map((r) => r.node.id)).toEqual([1, 2, 3, 4, 10, 11, 5, 20]);
    expect(rows.filter((r) => r.hasChildren).every((r) => r.expanded)).toBe(true);
  });

  it('flattens a filtered subtree by the same rules (filtering happens upstream)', () => {
    // Simulate the Sidebar's text filter keeping only the path to wall 20.
    const filtered = makeNode(1, 'IfcProject', [
      makeNode(2, 'IfcSite', [
        makeNode(3, 'IfcBuilding', [
          makeNode(5, 'IfcBuildingStorey', [makeNode(20, 'IfcWall')]),
        ]),
      ]),
    ]);
    const rows = flattenVisibleRows(filtered, ALL_SAMPLE_IDS);
    expect(rows.map((r) => r.node.id)).toEqual([1, 2, 3, 5, 20]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 3, 4]);
  });
});

// ── computeRowWindow ─────────────────────────────────────────────────────────

describe('computeRowWindow', () => {
  it('returns an empty window for zero rows', () => {
    expect(computeRowWindow(0, 0, 400)).toEqual({ start: 0, end: 0 });
  });

  it('starts at 0 with overscan applied only below at the top of the list', () => {
    const viewport = 20 * TREE_ROW_HEIGHT;
    const win = computeRowWindow(5000, 0, viewport);
    expect(win.start).toBe(0);
    expect(win.end).toBe(20 + TREE_OVERSCAN_ROWS);
  });

  it('windows around the scroll offset with overscan on both sides', () => {
    const viewport = 10 * TREE_ROW_HEIGHT;
    const win = computeRowWindow(5000, 100 * TREE_ROW_HEIGHT, viewport);
    expect(win.start).toBe(100 - TREE_OVERSCAN_ROWS);
    expect(win.end).toBe(110 + TREE_OVERSCAN_ROWS);
  });

  it('clamps the end of the window to the row count', () => {
    const viewport = 10 * TREE_ROW_HEIGHT;
    const win = computeRowWindow(105, 100 * TREE_ROW_HEIGHT, viewport);
    expect(win.end).toBe(105);
    expect(win.start).toBe(100 - TREE_OVERSCAN_ROWS);
  });

  it('keeps at least one row when scrollTop is stale beyond the shrunken content', () => {
    // e.g. a filter cut 5000 rows down to 8 before the browser clamped scroll.
    const win = computeRowWindow(8, 4000 * TREE_ROW_HEIGHT, 400);
    expect(win.start).toBeLessThan(win.end);
    expect(win.end).toBe(8);
  });

  it('treats negative scrollTop (overscroll bounce) as 0', () => {
    const win = computeRowWindow(100, -50, 10 * TREE_ROW_HEIGHT);
    expect(win.start).toBe(0);
  });

  it('falls back to a tall viewport before the first measurement (height 0)', () => {
    const win = computeRowWindow(5000, 0, 0);
    expect(win.end).toBe(Math.ceil(FALLBACK_VIEWPORT_PX / TREE_ROW_HEIGHT) + TREE_OVERSCAN_ROWS);
  });

  it('honours a custom row height and overscan', () => {
    const win = computeRowWindow(1000, 300, 300, 30, 2);
    expect(win.start).toBe(10 - 2);
    expect(win.end).toBe(20 + 2);
  });
});

// ── computeDefaultExpandedIds ────────────────────────────────────────────────

describe('computeDefaultExpandedIds', () => {
  it('returns an empty set for a null tree', () => {
    expect(computeDefaultExpandedIds(null)).toEqual(new Set());
  });

  it('expands everything for small models (the historical default)', () => {
    expect(computeDefaultExpandedIds(SAMPLE)).toEqual(ALL_SAMPLE_IDS);
  });

  it('expands everything at exactly the threshold node count', () => {
    const tree = makeBigTree(LARGE_MODEL_COLLAPSE_THRESHOLD);
    const seed = computeDefaultExpandedIds(tree);
    expect(seed.size).toBe(LARGE_MODEL_COLLAPSE_THRESHOLD);
  });

  it('collapses to container level one node above the threshold', () => {
    const tree = makeBigTree(LARGE_MODEL_COLLAPSE_THRESHOLD + 1);
    const seed = computeDefaultExpandedIds(tree);
    // Project, Site and Building open; storeys (element parents) collapsed.
    expect(seed).toEqual(new Set([1, 2, 3]));
  });

  it('honours a custom threshold (storeys stay collapsed, spaces too)', () => {
    const withSpace = makeNode(1, 'IfcProject', [
      makeNode(2, 'IfcSite', [
        makeNode(3, 'IfcBuilding', [
          makeNode(4, 'IfcBuildingStorey', [
            makeNode(6, 'IfcSpace', [makeNode(10, 'IfcWall')]),
            makeNode(11, 'IfcDoor'),
          ]),
        ]),
      ]),
    ]);
    const seed = computeDefaultExpandedIds(withSpace, 3);
    // The storey contains an IfcSpace container, so it opens down to the
    // space; the space itself (element children only) stays collapsed.
    expect(seed).toEqual(new Set([1, 2, 3, 4]));
  });

  it('always seeds the root expanded, even with no containers below it', () => {
    const flat = makeNode(1, 'IfcProject', [
      makeNode(10, 'IfcWall'),
      makeNode(11, 'IfcWall'),
      makeNode(12, 'IfcWall'),
    ]);
    const seed = computeDefaultExpandedIds(flat, 2);
    expect(seed).toEqual(new Set([1]));
  });

  it('a selected-path union on top of the seed reveals an element row', () => {
    // Mirrors the Sidebar's auto-expand-to-selected: seed + path(10) must make
    // wall 10 visible in the flattened rows of a large model.
    const tree = makeBigTree(LARGE_MODEL_COLLAPSE_THRESHOLD + 1);
    const seed = computeDefaultExpandedIds(tree);
    const withPath = new Set(seed);
    for (const id of [1, 2, 3, 4]) withPath.add(id); // root -> storey A
    const rows = flattenVisibleRows(tree, withPath);
    expect(rows.some((r) => r.node.id === 1000)).toBe(true); // first wall of storey A
    // Storey B stays collapsed: its walls are not mounted.
    expect(rows.some((r) => r.node.id === 100000)).toBe(false);
  });
});
