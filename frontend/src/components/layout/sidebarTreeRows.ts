/**
 * Pure row-model helpers for the Sidebar's windowed spatial tree.
 *
 * The tree used to render one recursive <TreeNode> per spatial node, fully
 * expanded by default - ~50k DOM nodes on a 5k-element model, and a full
 * O(N) reconcile on every selection click. The Sidebar now flattens
 * (filteredTree, expandedIds) into a row array and mounts only the rows in
 * the scroll viewport. Everything in this module is pure (no DOM, no store)
 * so it is unit-testable in isolation.
 */
import type { SpatialNode } from '../../types/ifc';

/** Fixed row pitch in px. Must match `.tree-node-row { height }` in index.css. */
export const TREE_ROW_HEIGHT = 22;

/**
 * Px of indentation per depth level. Matches the old nested markup's
 * `.tree-node-children { padding-left: 16px }`; the flat rows reproduce it
 * with an inline margin-left so the hover/selection background still starts
 * at the indent like the nested version did.
 */
export const TREE_ROW_INDENT = 16;

/** Extra rows mounted above/below the viewport so fast scrolling hits rows, not blank. */
export const TREE_OVERSCAN_ROWS = 10;

/**
 * Viewport height assumed before the first ResizeObserver measurement lands
 * (the Sidebar's viewport state starts at 0). Tall enough that the first
 * paint is never blank.
 */
export const FALLBACK_VIEWPORT_PX = 800;

/**
 * Models with more nodes than this seed their expansion collapsed-to-container
 * instead of fully expanded. Below the threshold the historical
 * expand-everything default is kept so small models look identical.
 */
export const LARGE_MODEL_COLLAPSE_THRESHOLD = 1000;

/** Spatial container types - the levels kept open by the large-model seed. */
const SPATIAL_CONTAINER_TYPES = new Set([
  'ifcproject', 'ifcsite', 'ifcbuilding', 'ifcbuildingstorey',
  'ifcspace', 'ifczone', 'ifcgroup',
]);

export interface FlatTreeRow {
  node: SpatialNode;
  /** 0 for the root; drives the indent (depth * TREE_ROW_INDENT). */
  depth: number;
  hasChildren: boolean;
  /** Whether the row currently shows its children (chevron direction). Always false for leaves. */
  expanded: boolean;
}

/**
 * Pre-order flatten of the rows currently visible given the expansion state.
 * Children of a collapsed node are skipped entirely, so the array length is
 * the number of renderable rows, and row i sits at scroll offset
 * i * TREE_ROW_HEIGHT. `forceExpandAll` is used while a filter is active on a
 * large (collapsed-by-default) model, where the filtered tree must reveal its
 * matches regardless of the persisted expansion state.
 */
export function flattenVisibleRows(
  root: SpatialNode | null,
  expandedIds: ReadonlySet<number>,
  forceExpandAll = false,
): FlatTreeRow[] {
  const rows: FlatTreeRow[] = [];
  if (!root) return rows;
  const visit = (node: SpatialNode, depth: number) => {
    const hasChildren = node.children.length > 0;
    const expanded = hasChildren && (forceExpandAll || expandedIds.has(node.id));
    rows.push({ node, depth, hasChildren, expanded });
    if (expanded) {
      for (const child of node.children) visit(child, depth + 1);
    }
  };
  visit(root, 0);
  return rows;
}

/**
 * Half-open [start, end) slice of rows to mount for the current scroll
 * position. Pure index math on the fixed row pitch; the scroll container's
 * few px of top padding are absorbed by the overscan rows.
 */
export function computeRowWindow(
  rowCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number = TREE_ROW_HEIGHT,
  overscan: number = TREE_OVERSCAN_ROWS,
): { start: number; end: number } {
  if (rowCount <= 0) return { start: 0, end: 0 };
  const vh = viewportHeight > 0 ? viewportHeight : FALLBACK_VIEWPORT_PX;
  const top = Math.max(0, scrollTop);
  const end = Math.min(rowCount, Math.ceil((top + vh) / rowHeight) + overscan);
  // A stale (too large) scrollTop right after the row set shrinks - e.g. a
  // filter landed before the browser clamped the scroll position - must not
  // produce an empty slice, so start is clamped to keep at least one row.
  const start = Math.max(0, Math.min(Math.floor(top / rowHeight) - overscan, end - 1));
  return { start, end };
}

/**
 * Default expansion seed for a freshly-published model tree.
 *
 * Small models (node count <= threshold) keep the historical default: every
 * node expanded. Larger models expand only down to the container level - a
 * node is seeded expanded when some child's subtree contains a spatial
 * container, so Project/Site/Building rows open while storeys (whose children
 * are element rows) stay collapsed. The root is always seeded expanded so a
 * degenerate tree with no containers below the root still shows its first
 * level. The auto-expand-to-selected path unions on top of this seed, so a
 * selected element is still revealed on large models.
 */
export function computeDefaultExpandedIds(
  root: SpatialNode | null,
  threshold: number = LARGE_MODEL_COLLAPSE_THRESHOLD,
): Set<number> {
  if (!root) return new Set();
  const allIds: number[] = [];
  const containerLevel = new Set<number>();
  // Post-order: reports whether the subtree rooted at `node` (node included)
  // contains a spatial container. Every child is visited (no short-circuit)
  // because the walk doubles as the total node count for the threshold check.
  const visit = (node: SpatialNode): boolean => {
    allIds.push(node.id);
    let childHasContainer = false;
    for (const child of node.children) {
      if (visit(child)) childHasContainer = true;
    }
    if (childHasContainer) containerLevel.add(node.id);
    return childHasContainer || SPATIAL_CONTAINER_TYPES.has(node.ifc_type.toLowerCase());
  };
  visit(root);
  if (allIds.length <= threshold) return new Set(allIds);
  containerLevel.add(root.id);
  return containerLevel;
}
