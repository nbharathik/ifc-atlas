/**
 * Tests for the pure helpers in Sidebar.tsx:
 *   - findPathToNode
 *   - countNodes
 */

import { describe, it, expect } from 'vitest';
import type { SpatialNode } from '../../../types/ifc';
import { findPathToNode, countNodes, buildTreeIndex, pathToNode } from '../Sidebar';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeNode(
  id: number,
  children: SpatialNode[] = [],
  name = `Node ${id}`,
): SpatialNode {
  return { id, name, ifc_type: 'IfcWall', global_id: `G${id}`, children };
}

// Tree:
//   1
//   ├── 2
//   │   ├── 4
//   │   └── 5
//   └── 3
//       └── 6
//           └── 7 (deepest leaf)

const LEAF_7 = makeNode(7);
const NODE_6 = makeNode(6, [LEAF_7]);
const LEAF_4 = makeNode(4);
const LEAF_5 = makeNode(5);
const NODE_2 = makeNode(2, [LEAF_4, LEAF_5]);
const NODE_3 = makeNode(3, [NODE_6]);
const ROOT = makeNode(1, [NODE_2, NODE_3]);

// ─── findPathToNode ───────────────────────────────────────────────────────────

describe('findPathToNode', () => {
  it('returns [rootId] when target is the root', () => {
    expect(findPathToNode(ROOT, 1)).toEqual([1]);
  });

  it('returns direct child path', () => {
    expect(findPathToNode(ROOT, 2)).toEqual([1, 2]);
    expect(findPathToNode(ROOT, 3)).toEqual([1, 3]);
  });

  it('returns path to deeper node', () => {
    expect(findPathToNode(ROOT, 4)).toEqual([1, 2, 4]);
    expect(findPathToNode(ROOT, 5)).toEqual([1, 2, 5]);
  });

  it('returns path to deepest node', () => {
    expect(findPathToNode(ROOT, 7)).toEqual([1, 3, 6, 7]);
  });

  it('returns null for id not in tree', () => {
    expect(findPathToNode(ROOT, 99)).toBeNull();
  });

  it('returns null for empty children', () => {
    expect(findPathToNode(LEAF_7, 99)).toBeNull();
  });

  it('returns path within a subtree', () => {
    // Start from NODE_3 instead of ROOT
    expect(findPathToNode(NODE_3, 7)).toEqual([3, 6, 7]);
  });

  it('does not return partial paths for non-matching branches', () => {
    const result = findPathToNode(ROOT, 6);
    expect(result).toEqual([1, 3, 6]);
    expect(result).not.toContain(2); // 2 is in a different branch
  });
});

// ─── pathToNode (parent-chain walk + cycle safety) ────────────────────────────

describe('pathToNode', () => {
  it('walks the parent chain root→target', () => {
    const index = buildTreeIndex(ROOT);
    expect(pathToNode(index, 7)).toEqual([1, 3, 6, 7]);
    expect(pathToNode(index, 4)).toEqual([1, 2, 4]);
  });

  it('resolves an expressId to the owning node path', () => {
    const withExpress: SpatialNode = {
      ...makeNode(1, [makeNode(2, [{ ...makeNode(9), expressId: 4242 }])]),
    };
    const index = buildTreeIndex(withExpress);
    expect(pathToNode(index, 4242)).toEqual([1, 2, 9]);
  });

  it('returns null for an id not in the tree', () => {
    expect(pathToNode(buildTreeIndex(ROOT), 99)).toBeNull();
  });

  it('terminates on a malformed tree whose duplicate ids cycle parentOf', () => {
    // Reused localId 5 (A and C) makes buildTreeIndex overwrite parentOf[5]
    // to 10 while parentOf[10] stays 5 → a 5↔10 cycle. Before the visited-set
    // guard this looped until `RangeError: Invalid array length`, which
    // (unhandled) tore down the React tree and disposed the model + worker.
    const cyclic = makeNode(1, [makeNode(5, [makeNode(10, [makeNode(5)])])]);
    const index = buildTreeIndex(cyclic);
    const path = pathToNode(index, 5);
    expect(path).not.toBeNull();
    // No infinite loop: the path is bounded by the number of distinct ids.
    expect(path!.length).toBeLessThanOrEqual(index.byId.size + 1);
    expect(new Set(path)).toEqual(new Set(path)); // each id visited at most once
    expect(path!.length).toBe(new Set(path!).size);
  });
});

// ─── countNodes ──────────────────────────────────────────────────────────────

describe('countNodes', () => {
  it('counts single node as 1', () => {
    expect(countNodes(LEAF_7)).toBe(1);
  });

  it('counts node + direct children', () => {
    expect(countNodes(NODE_2)).toBe(3); // node_2 + leaf_4 + leaf_5
  });

  it('counts full tree', () => {
    // ROOT(1) + NODE_2(1) + LEAF_4(1) + LEAF_5(1) + NODE_3(1) + NODE_6(1) + LEAF_7(1) = 7
    expect(countNodes(ROOT)).toBe(7);
  });

  it('counts leaf as 1', () => {
    expect(countNodes(LEAF_4)).toBe(1);
  });
});
