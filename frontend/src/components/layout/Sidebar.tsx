import { useState, useMemo, useCallback, useEffect, useRef, useDeferredValue, startTransition, memo } from 'react';
import { useStore } from '../../store/useStore';
import Icon from '../ui/Icon';
import type { SpatialNode } from '../../types/ifc';

/**
 * Collect every descendant id (including the node itself) so "isolate" on a
 * storey/building keeps the whole subtree visible rather than just the single
 * container. The IFC spatial tree is usually shallow so recursion is fine.
 */
function collectSubtreeIds(node: SpatialNode): number[] {
  const out: number[] = [node.id];
  for (const child of node.children) {
    out.push(...collectSubtreeIds(child));
  }
  return out;
}

/** Walk the tree and return a map of ifc_type → count for leaf-level types. */
export function collectIfcTypes(node: SpatialNode): Map<string, number> {
  const counts = new Map<string, number>();
  function walk(n: SpatialNode) {
    counts.set(n.ifc_type, (counts.get(n.ifc_type) ?? 0) + 1);
    for (const child of n.children) walk(child);
  }
  walk(node);
  return counts;
}

/** IFC container / structural types that clutter the type filter chip list. */
const CONTAINER_TYPES = new Set([
  'IfcProject', 'IfcSite', 'IfcBuilding', 'IfcBuildingStorey',
  'IfcSpace', 'IfcZone', 'IfcGroup',
]);

/**
 * Flat O(1)-lookup index over a spatial tree, memoized per-tree in the
 * Sidebar. `parentOf` lets the selection path be built by an O(depth) walk
 * up the parent chain instead of a full O(N) DFS on every selection change.
 *
 * `targetToLocalId` resolves either id-space to the owning node's localId:
 * tree clicks dispatch SpatialNode.id (localId) while viewer raycast clicks
 * dispatch the owning IfcProduct's express id (SpatialNode.expressId). Both
 * spaces map to the same localId so a single selectedElementId from either
 * source resolves to one row.
 */
interface SpatialTreeIndex {
  /** localId → node */
  byId: Map<number, SpatialNode>;
  /** localId → parent localId (root maps to nothing) */
  parentOf: Map<number, number>;
  /** localId | expressId → owning node's localId */
  targetToLocalId: Map<number, number>;
  /** Every localId in the tree - the small-model fully-expanded seed. */
  allIds: number[];
}

export function buildTreeIndex(root: SpatialNode): SpatialTreeIndex {
  const byId = new Map<number, SpatialNode>();
  const parentOf = new Map<number, number>();
  const targetToLocalId = new Map<number, number>();
  const allIds: number[] = [];
  const walk = (node: SpatialNode, parentId: number | null) => {
    byId.set(node.id, node);
    allIds.push(node.id);
    targetToLocalId.set(node.id, node.id);
    if (node.expressId !== undefined) targetToLocalId.set(node.expressId, node.id);
    if (parentId !== null) parentOf.set(node.id, parentId);
    for (const child of node.children) walk(child, node.id);
  };
  walk(root, null);
  return { byId, parentOf, targetToLocalId, allIds };
}

/**
 * Resolve `targetId` (localId or express id) to the root→target localId path
 * via the flat index, in O(depth). Returns null when the target is not in
 * this subtree.
 */
export function pathToNode(index: SpatialTreeIndex, targetId: number): number[] | null {
  const localId = index.targetToLocalId.get(targetId);
  if (localId === undefined) return null;
  const path: number[] = [localId];
  // Guard against cycles in the parent chain. A malformed spatial tree with
  // duplicate localIds - which large, server-converted fragment models can
  // produce - makes `parentOf` loop back on itself (A→B→A). Without this guard
  // the walk pushes forever and throws `RangeError: Invalid array length`;
  // because nothing catches it, React unmounts the whole tree, whose cleanup
  // disposes the FragmentsModel AND the metadata worker - which is why a click
  // ended with "Properties unavailable" and `worker disposed`. Breaking on a
  // repeat keeps a valid (possibly partial) ancestor path so the row still
  // expands + scrolls into view.
  const visited = new Set<number>([localId]);
  let cursor = localId;
  for (;;) {
    const parent = index.parentOf.get(cursor);
    if (parent === undefined || visited.has(parent)) break;
    visited.add(parent);
    path.push(parent);
    cursor = parent;
  }
  path.reverse();
  return path;
}

/**
 * Find the sequence of node IDs (localIds) from root to the target node
 * (inclusive). Returns null when the target is not in this subtree.
 *
 * `targetId` may be either a FragmentsModel localId (what tree clicks
 * dispatch via SpatialNode.id) or an IFC Express ID (what viewer raycast
 * clicks dispatch after normalizing to the owning IfcProduct). Each node
 * is matched against both id-spaces so a single selectedElementId from
 * either source resolves correctly. Kept as an exported pure helper for
 * tests; the Sidebar itself uses the O(depth) index walk above.
 */
export function findPathToNode(node: SpatialNode, targetId: number, path: number[] = []): number[] | null {
  const current = [...path, node.id];
  if (node.id === targetId || node.expressId === targetId) return current;
  for (const child of node.children) {
    const result = findPathToNode(child, targetId, current);
    if (result) return result;
  }
  return null;
}

/** Count total visible nodes in a tree (all descendants). */
export function countNodes(node: SpatialNode): number {
  return 1 + node.children.reduce((sum, c) => sum + countNodes(c), 0);
}

// ── TreeRow ──────────────────────────────────────────────────────────────────

interface TreeRowProps {
  node: SpatialNode;
  /** Depth in the (filtered) tree; rendered as an indent on the flat row. */
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  /**
   * Plain boolean computed by the Sidebar from its selection Set. Passing the
   * membership result instead of the Set itself keeps the props of unchanged
   * rows stable across selection clicks, so React.memo skips them and a
   * selection change re-renders only the rows whose highlight actually
   * flipped (instead of the old full-tree reconcile from the new-Set
   * identity).
   */
  isSelected: boolean;
  /** Toggle a node's expansion in the Sidebar-owned expandedIds Set. */
  onToggle: (id: number) => void;
}

// Wrapped in React.memo: with windowing only ~40-60 rows are mounted, and all
// props are scalars / stable references, so scrolling and unrelated Sidebar
// re-renders skip every row whose window slot didn't change.
const TreeRow = memo(function TreeRow({
  node,
  depth,
  hasChildren,
  expanded,
  isSelected,
  onToggle,
}: TreeRowProps) {
  // Dispatch the IFC Express ID when the metadata worker's id-bridge has
  // hydrated SpatialNode.expressId, so the store and PropertiesPanel see
  // the same id-space the viewer raycast uses. Falls back to localId
  // during the brief hydration window - PropertiesPanel and viewer
  // helpers both tolerate localId via their findNodeById/comparator
  // matching both id-spaces.
  const dispatchId = node.expressId ?? node.id;
  // Handlers read actions through getState() instead of subscribing - actions
  // are stable refs in Zustand 5, and skipping the subscription keeps rows
  // free of store coupling.
  const handleClick = (e: React.MouseEvent) => {
    const store = useStore.getState();
    if (e.shiftKey) store.toggleSelectId(dispatchId);
    else store.selectElement(dispatchId);
  };

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggle(node.id);
  };

  const handleZoom = (e: React.MouseEvent) => {
    e.stopPropagation();
    useStore.getState().zoomToElement(dispatchId);
  };

  const handleIsolate = (e: React.MouseEvent) => {
    e.stopPropagation();
    const ids = collectSubtreeIds(node);
    const store = useStore.getState();
    store.setIsolatedIds(ids);
    store.logActivity({
      kind: 'isolate',
      summary: `Isolated "${node.name}" (${ids.length} element${ids.length === 1 ? '' : 's'})`,
    });
  };

  // Soft amber preview highlight on tree-row hover.
  const handlePointerEnter = () => useStore.getState().treeHoverPreview(node.id);
  const handlePointerLeave = () => useStore.getState().treeHoverPreview(null);

  return (
    <div
      data-tree-id={node.id}
      className={`tree-node-row ${isSelected ? 'selected' : ''}`}
      // The old nested markup indented via `.tree-node-children` padding
      // (TREE_ROW_INDENT px per level); the flat row reproduces it with a
      // margin so the row box (hover/selection background, accent bar) starts
      // at the indent exactly like before. +2 keeps the base `margin: 0 2px`.
      style={{ marginLeft: depth * TREE_ROW_INDENT + 2 }}
      onClick={handleClick}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      title={`${node.name} #${node.id}${isSelected ? ' (selected)' : ''}`}
    >
      <span className="tree-toggle" onClick={hasChildren ? handleToggle : undefined}>
        {hasChildren ? (
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={11} />
        ) : null}
      </span>
      <span className="tree-node-label" title={`${node.name} - #${node.id}`}>
        {node.name || node.ifc_type.replace('Ifc', '')}
      </span>
      <span className="type-badge">{node.ifc_type.replace('Ifc', '')} #{node.id}</span>
      <span className="tree-row-actions" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="tree-row-action-btn"
          title="Zoom to element"
          aria-label={`Zoom to ${node.name}`}
          onClick={handleZoom}
        >
          <Icon name="focus" size={12} />
        </button>
        <button
          type="button"
          className="tree-row-action-btn"
          title="Isolate (mini view)"
          aria-label={`Isolate ${node.name}`}
          onClick={handleIsolate}
        >
          <Icon name="crop" size={12} />
        </button>
      </span>
    </div>
  );
});

// ── Filter helpers ────────────────────────────────────────────────────────────

function filterByTypes(node: SpatialNode, activeTypes: Set<string>): SpatialNode | null {
  const filteredChildren = node.children
    .map((c) => filterByTypes(c, activeTypes))
    .filter((n): n is SpatialNode => n !== null);

  if (activeTypes.has(node.ifc_type)) {
    return { ...node, children: filteredChildren };
  }
  if (filteredChildren.length > 0) {
    return { ...node, children: filteredChildren };
  }
  return null;
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

interface PendingRowScroll {
  /** Target row's localId (SpatialNode.id). */
  id: number;
  block: 'nearest' | 'center';
  behavior: ScrollBehavior;
}

export default function Sidebar() {
  const spatialTree = useStore((s) => s.spatialTree);
  const clearVisibility = useStore((s) => s.clearVisibility);
  const isolatedIds = useStore((s) => s.isolatedIds);
  const hiddenIds = useStore((s) => s.hiddenIds);
  const selectedElementId = useStore((s) => s.selectedElementId);
  const selectedIds = useStore((s) => s.selectedIds);
  const setForceExpandIds = useStore((s) => s.setForceExpandIds);
  const [filter, setFilter] = useState('');
  // Defer the filter value so each keystroke paints immediately and the (full
  // tree) filter re-render runs in a low-priority pass - typing never blocks on
  // walking + reconciling a large tree.
  const deferredFilter = useDeferredValue(filter);
  const [activeTypeFilters, setActiveTypeFilters] = useState<Set<string>>(new Set());
  const panelBodyRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);

  // Membership Set for selection highlighting, built ONCE per selectedIds
  // change. Replaces the per-node `selectedIds.includes(node.id)` scan that
  // was O(selectedIds) per node per store mutation. selectedIds stays a
  // number[] in the store (it is read in many files); the Set is purely local
  // and each row receives only its own boolean membership result.
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  // ── Expansion state, lifted out of per-node useState ─────────────────────
  // A single source of truth for which rows are expanded, re-seeded whenever
  // a new model tree arrives. Small models seed fully expanded (the historical
  // default); models above LARGE_MODEL_COLLAPSE_THRESHOLD seed collapsed to
  // container/storey level so the windowed list starts at a few dozen rows
  // instead of N element rows.
  const [expandedIds, setExpandedIds] = useState<Set<number>>(() => new Set());

  // Flat O(1) index over the FULL (unfiltered) tree - used for O(depth)
  // selection-path building and the total node count. Built from spatialTree
  // (not filteredTree) so a selection that is currently filtered out of view
  // still resolves a path, and so expandedIds keys against the stable
  // full-tree id-space rather than the filtered subset.
  const fullIndex = useMemo(
    () => (spatialTree ? buildTreeIndex(spatialTree) : null),
    [spatialTree],
  );

  // Re-seed expansion whenever the underlying model tree changes (new model
  // loaded, metadata patch rebuilt the tree).
  useEffect(() => {
    setExpandedIds(computeDefaultExpandedIds(spatialTree));
  }, [spatialTree]);

  const handleToggle = useCallback((id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // ── Windowing state ───────────────────────────────────────────────────────
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    // Horizontal scrolling fires this too; a same-value setScrollTop bails out
    // of the re-render, so only vertical movement re-windows the list.
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  useEffect(() => {
    const el = panelBodyRef.current;
    if (!el) return;
    const measure = () => setViewportHeight(el.clientHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /**
   * Scroll a flat-row index into view via pure index math (rows have a fixed
   * pitch). Replaces the old rAF + querySelector polling for data-tree-id.
   * The rows wrapper's offset inside the scroll content is measured instead
   * of hardcoding panel-body's CSS padding.
   */
  const scrollToRowIndex = useCallback(
    (index: number, block: 'nearest' | 'center', behavior: ScrollBehavior) => {
      const body = panelBodyRef.current;
      if (!body) return;
      const rowsEl = rowsRef.current;
      const baseTop = rowsEl
        ? rowsEl.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop
        : 0;
      const rowTop = baseTop + index * TREE_ROW_HEIGHT;
      const rowBottom = rowTop + TREE_ROW_HEIGHT;
      let top: number | null = null;
      if (block === 'center') {
        top = rowTop - (body.clientHeight - TREE_ROW_HEIGHT) / 2;
      } else if (rowTop < body.scrollTop) {
        top = rowTop;
      } else if (rowBottom > body.scrollTop + body.clientHeight) {
        top = rowBottom - body.clientHeight;
      }
      if (top !== null) body.scrollTo({ top: Math.max(0, top), behavior });
    },
    [],
  );

  // Scroll request waiting for the commit in which its target row exists in
  // the flat row array (path expansion lands one render after it is queued).
  const pendingScrollRef = useRef<PendingRowScroll | null>(null);

  // When the selected element changes, expand the path to it and queue a
  // scroll. Path expansion unions the root→target localIds into the lifted
  // expandedIds Set (a manually-collapsed ancestor is re-expanded in one
  // commit) - this also reveals selections on large models that seeded
  // collapsed. The setState cascade is wrapped in `startTransition` so the
  // click handler that triggered the selection can yield to paint before
  // React commits the expansion. INP win on big spatial trees.
  useEffect(() => {
    if (selectedElementId == null || !fullIndex) return;

    const path = pathToNode(fullIndex, selectedElementId);
    if (!path) return;

    // Path is a list of localIds (SpatialNode.id). selectedElementId may
    // be an express id (from viewer-click) or a localId (from tree-click);
    // either way the path's last element IS the target row's localId, which
    // is what the flat rows key on.
    pendingScrollRef.current = {
      id: path[path.length - 1],
      block: 'nearest',
      behavior: 'auto',
    };

    startTransition(() => {
      // Always a NEW Set, even when the path is already expanded: the pending
      // scroll above is consumed by an effect keyed on the flat row array,
      // which only recomputes when expandedIds changes identity.
      setExpandedIds((prev) => {
        const next = new Set(prev);
        for (const id of path) next.add(id);
        return next;
      });
      // Keep the store path in sync for any consumer that still reads it; the
      // tree now expands from the local Set, but this is the public API and
      // leaving it set avoids touching the store.
      setForceExpandIds(new Set(path));
    });
  }, [selectedElementId, fullIndex, setForceExpandIds]);

  // Collect and sort non-container IFC types by count, capped at 8 chips.
  const typeChips = useMemo(() => {
    if (!spatialTree) return [];
    const counts = collectIfcTypes(spatialTree);
    return Array.from(counts.entries())
      .filter(([type]) => !CONTAINER_TYPES.has(type))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
  }, [spatialTree]);

  const toggleTypeFilter = useCallback((type: string) => {
    setActiveTypeFilters((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  const clearTypeFilters = useCallback(() => setActiveTypeFilters(new Set()), []);

  const filteredTree = useMemo(() => {
    let tree = spatialTree;
    if (tree && activeTypeFilters.size > 0) {
      tree = filterByTypes(tree, activeTypeFilters);
    }
    if (!tree || !deferredFilter) return tree;
    const q = deferredFilter.toLowerCase();
    function filterNode(node: SpatialNode): SpatialNode | null {
      const matchesSelf =
        node.name.toLowerCase().includes(q) ||
        node.ifc_type.toLowerCase().includes(q);
      const filteredChildren = node.children
        .map(filterNode)
        .filter((n): n is SpatialNode => n !== null);
      if (matchesSelf || filteredChildren.length > 0) {
        return { ...node, children: filteredChildren };
      }
      return null;
    }
    return filterNode(tree);
  }, [spatialTree, deferredFilter, activeTypeFilters]);

  const totalCount = fullIndex ? fullIndex.allIds.length : 0;
  // The unfiltered count comes from the index (no walk); the filtered count is
  // memoized and only walks when a filter actually replaced the tree. The old
  // code ran countNodes twice per render.
  const nodeCount = useMemo(() => {
    if (!filteredTree) return 0;
    if (filteredTree === spatialTree) return fullIndex ? fullIndex.allIds.length : 0;
    return countNodes(filteredTree);
  }, [filteredTree, spatialTree, fullIndex]);

  const isLargeModel = totalCount > LARGE_MODEL_COLLAPSE_THRESHOLD;
  // Must mirror filteredTree's inputs (deferredFilter, activeTypeFilters), not
  // the immediate `filter`, so the force-expand flag flips in the same commit
  // as the filtered tree itself.
  const filtersActive = deferredFilter !== '' || activeTypeFilters.size > 0;

  // Flat list of the rows currently visible given expansion state. On large
  // models (seeded collapsed) an active filter force-expands the - much
  // smaller - filtered tree, otherwise matches would sit invisible under
  // collapsed storeys. Small models keep expandedIds authority so existing
  // filter + collapse behavior is unchanged.
  const visibleRows = useMemo(
    () => flattenVisibleRows(filteredTree, expandedIds, isLargeModel && filtersActive),
    [filteredTree, expandedIds, isLargeModel, filtersActive],
  );

  const { start: winStart, end: winEnd } = computeRowWindow(
    visibleRows.length,
    scrollTop,
    viewportHeight,
  );

  // Consume the pending scroll once the target row is present in the flat
  // array. Keyed on visibleRows: every path-expansion above creates a new
  // expandedIds Set, so the array identity always changes in the commit the
  // expansion lands - no DOM polling needed.
  useEffect(() => {
    const pending = pendingScrollRef.current;
    if (!pending) return;
    pendingScrollRef.current = null;
    let index = -1;
    for (let i = 0; i < visibleRows.length; i++) {
      if (visibleRows[i].node.id === pending.id) {
        index = i;
        break;
      }
    }
    // index < 0: the row is filtered out of the current tree - same give-up
    // the old querySelector polling had.
    if (index >= 0) scrollToRowIndex(index, pending.block, pending.behavior);
  }, [visibleRows, scrollToRowIndex]);

  /** Manually scroll the selected element into view (header button). */
  const scrollToSelected = useCallback(() => {
    if (selectedElementId == null || !fullIndex) return;
    // Re-expand the path in case the user collapsed an ancestor after the
    // initial auto-expand, or selection came from the 3D viewer before the
    // tree finished expanding.
    const path = pathToNode(fullIndex, selectedElementId);
    if (!path) return;
    pendingScrollRef.current = {
      id: path[path.length - 1],
      block: 'center',
      behavior: 'smooth',
    };
    // New Set unconditionally - see the selection effect above.
    setExpandedIds((prev) => {
      const next = new Set(prev);
      for (const id of path) next.add(id);
      return next;
    });
    setForceExpandIds(new Set(path));
  }, [selectedElementId, fullIndex, setForceExpandIds]);

  const visibilityActive = isolatedIds.length > 0 || hiddenIds.length > 0;
  const isFiltered = filter.trim() !== '' || activeTypeFilters.size > 0;

  return (
    <div className="panel" style={{ height: '100%' }}>
      <div className="panel-header">
        <span>
          Model Tree
          {nodeCount > 0 && (
            <span className="tree-node-count" title={isFiltered ? `${nodeCount} of ${totalCount} nodes visible` : `${totalCount} nodes`}>
              {isFiltered ? ` ${nodeCount}/${totalCount}` : ` ${totalCount}`}
            </span>
          )}
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          {selectedElementId != null && (
            <button
              type="button"
              className="panel-header-action"
              title="Scroll to selected element in tree"
              onClick={scrollToSelected}
            >
              ⦿
            </button>
          )}
          {visibilityActive && (
            <button
              type="button"
              className="panel-header-action"
              title="Show all elements"
              onClick={() => clearVisibility()}
            >
              Show all
            </button>
          )}
        </div>
      </div>
      <div className="search-bar">
        <input
          type="text"
          placeholder="Filter tree..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="panel-body" ref={panelBodyRef} onScroll={handleScroll}>
        {filteredTree ? (
          // The wrapper carries the `.tree-node` cursor/font styles the old
          // per-node wrappers provided, plus padding spacers that keep the
          // scroll height at rowCount * TREE_ROW_HEIGHT while only the
          // windowed slice is mounted.
          <div
            ref={rowsRef}
            className="tree-node"
            style={{
              paddingTop: winStart * TREE_ROW_HEIGHT,
              paddingBottom: (visibleRows.length - winEnd) * TREE_ROW_HEIGHT,
            }}
          >
            {visibleRows.slice(winStart, winEnd).map((row, i) => {
              const expressId = row.node.expressId;
              // Match against both id-spaces: tree clicks dispatch
              // SpatialNode.id (localId), viewer raycast clicks dispatch the
              // owning IfcProduct's express id. Either may land in
              // selectedIds / selectedElementId.
              const isSelected =
                selectedIdSet.has(row.node.id)
                || (expressId !== undefined && selectedIdSet.has(expressId))
                || selectedElementId === row.node.id
                || (expressId !== undefined && selectedElementId === expressId);
              // Composite key tolerates the duplicate localIds malformed
              // converted models can carry (same reason the old nested render
              // keyed `${id}-${idx}`).
              return (
                <TreeRow
                  key={`${row.node.id}-${winStart + i}`}
                  node={row.node}
                  depth={row.depth}
                  hasChildren={row.hasChildren}
                  expanded={row.expanded}
                  isSelected={isSelected}
                  onToggle={handleToggle}
                />
              );
            })}
          </div>
        ) : (
          <p style={{ color: 'var(--text-muted)', padding: 8 }}>
            {spatialTree ? 'No elements match the filter' : 'No model loaded'}
          </p>
        )}
      </div>
    </div>
  );
}

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
