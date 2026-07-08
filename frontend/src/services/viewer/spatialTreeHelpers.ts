/**
 * Small, pure helpers for walking the frontend's in-memory SpatialNode tree.
 * Shared by the viewer context menu (ViewerContextMenu.tsx) and any future
 * feature that needs to pivot from a single express id to "everything of
 * the same kind / on the same storey / under the same container."
 *
 * Kept pure (no Zustand, no async, no THREE) so they're trivial to unit-test
 * and cheap to call from render closures.
 */
import type { SpatialNode } from '../../types/ifc';

/** Container ifc_types that live in the spatial tree but are not renderable
 *  geometry. Excluded from leaf collection so "Isolate storey" ends up with
 *  only the things that can actually be culled visually. */
const CONTAINER_TYPES = new Set([
  'ifcproject',
  'ifcsite',
  'ifcbuilding',
  'ifcbuildingstorey',
  'ifcspace',
]);

/** Walk the tree and collect every express id whose `ifc_type` matches
 *  `ifcType` (case-insensitive). Root may be null (empty tree - returns []). */
export function collectIdsByType(root: SpatialNode | null, ifcType: string): number[] {
  if (!root) return [];
  const target = ifcType.toLowerCase();
  const out: number[] = [];
  const walk = (n: SpatialNode) => {
    if (n.id > 0 && n.ifc_type.toLowerCase() === target) out.push(n.id);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

/** Locate the enclosing IfcBuildingStorey for the given express id, or null
 *  if the id isn't under any storey (e.g. the id IS the storey, or the id
 *  lives outside the building hierarchy). */
export function findStoreyFor(root: SpatialNode | null, id: number): SpatialNode | null {
  if (!root) return null;
  let hit: SpatialNode | null = null;
  const walk = (node: SpatialNode, storey: SpatialNode | null) => {
    if (hit) return;
    const isStorey = node.ifc_type.toLowerCase() === 'ifcbuildingstorey';
    const nextStorey = isStorey ? node : storey;
    if (node.id === id) {
      hit = nextStorey;
      return;
    }
    for (const c of node.children) {
      walk(c, nextStorey);
      if (hit) return;
    }
  };
  walk(root, null);
  return hit;
}

/** Collect every leaf-element express id under `node` - i.e. everything
 *  that isn't a spatial container (Project / Site / Building / Storey /
 *  Space). Useful for "isolate this storey" or "hide this building." */
export function collectLeavesUnder(node: SpatialNode): number[] {
  const out: number[] = [];
  const walk = (n: SpatialNode) => {
    if (n.id > 0 && !CONTAINER_TYPES.has(n.ifc_type.toLowerCase())) out.push(n.id);
    for (const c of n.children) walk(c);
  };
  walk(node);
  return out;
}

/** Look up the ifc_type for a node, matching against either id-space.
 *  See findNodeById for the local-vs-express-id rationale. */
export function findIfcTypeForId(root: SpatialNode | null, id: number): string | null {
  if (!root) return null;
  const walk = (n: SpatialNode): string | null => {
    if (n.id === id || n.expressId === id) return n.ifc_type;
    for (const c of n.children) {
      const hit = walk(c);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root);
}

/** Find a node by either ID space. SpatialNode.id is a FragmentsModel localId
 *  (what the sidebar dispatches on click); SpatialNode.expressId is the IFC
 *  Express ID (what the viewer raycast dispatches, after normalization to
 *  the owning IfcProduct). Matching against either lets a single
 *  selectedElementId from either source resolve to a tree row. */
export function findNodeById(root: SpatialNode | null, id: number): SpatialNode | null {
  if (!root) return null;
  const walk = (n: SpatialNode): SpatialNode | null => {
    if (n.id === id || n.expressId === id) return n;
    for (const c of n.children) {
      const hit = walk(c);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root);
}

/** O(1) node lookup for hot paths that would otherwise DFS the whole tree
 *  per call (hover tooltip at up to ~12 Hz, context menu). Memoized per tree
 *  root via WeakMap: a re-published tree (new identity) rebuilds the index
 *  once; abandoned trees are GC'd together with their index. Keys cover BOTH
 *  ID spaces with first-writer-wins in pre-order, matching findNodeById's
 *  resolution order exactly. */
const nodeIndexByRoot = new WeakMap<SpatialNode, Map<number, SpatialNode>>();

export function getSpatialNodeIndex(root: SpatialNode | null): Map<number, SpatialNode> | null {
  if (!root) return null;
  const cached = nodeIndexByRoot.get(root);
  if (cached) return cached;
  const index = new Map<number, SpatialNode>();
  const walk = (n: SpatialNode): void => {
    if (!index.has(n.id)) index.set(n.id, n);
    if (typeof n.expressId === 'number' && !index.has(n.expressId)) index.set(n.expressId, n);
    for (const c of n.children) walk(c);
  };
  walk(root);
  nodeIndexByRoot.set(root, index);
  return index;
}
