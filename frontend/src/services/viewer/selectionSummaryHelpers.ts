/**
 * Pure helpers for the SelectionSummaryChip.
 *
 * The chip floats over the viewer and shows a histogram of the currently
 * multi-selected elements ("5 selected · 3 Wall · 1 Door · 1 Window")
 * together with quick "Inspect" + "Clear" actions. These helpers are pure
 * functions so they can be unit-tested without a live store or DOM.
 */
import type { SpatialNode } from '../../types/ifc';
import type { RightTab } from '../../store/useStore';
import { getSpatialNodeIndex } from './spatialTreeHelpers';

/** Maximum distinct IFC types shown in the chip before a "+N more" suffix. */
export const MAX_TYPES_SHOWN = 3;

/**
 * Maximum characters of an IFC type label rendered in the chip; longer names
 * (e.g. `BuildingElementProxy`) are truncated with an ellipsis to keep the
 * floating chip narrow. Tied by test to {@link truncateTypeLabel} default.
 */
export const MAX_TYPE_LABEL_LEN = 18;

/**
 * Right-sidebar tab opened when the user clicks the chip's "Inspect" action.
 * Pinned as a constant so a future RightTab rename / removal trips a typecheck
 * error rather than silently no-op'ing the button. Locked by a unit test that
 * asserts the value is one of the legal {@link RightTab} union members.
 */
export const SELECTION_SUMMARY_INSPECT_TAB: RightTab = 'props';

/** Single bucket of the type histogram (post-sort, post-shorten). */
export interface SelectionTypeBucket {
  /** Display label with the leading "Ifc" stripped (e.g. "Wall"). */
  type: string;
  /** Number of selected elements with this raw IFC type. */
  count: number;
}

/** Strip a leading "Ifc" from an IFC type name for compact display. */
export function shortenIfcType(ifcType: string | null | undefined): string {
  if (!ifcType) return 'Element';
  return ifcType.replace(/^Ifc/, '') || 'Element';
}

/**
 * Cap a (already-shortened) IFC type label to `maxLen` characters by appending
 * a single ellipsis. Returns the input unchanged when it fits. Negative or
 * non-finite limits collapse to "…" so the chip never accidentally renders a
 * malformed string. Used by the chip's bucket rendering so long types like
 * `BuildingElementProxy` keep the floating chip narrow.
 */
export function truncateTypeLabel(
  label: string,
  maxLen: number = MAX_TYPE_LABEL_LEN,
): string {
  if (!Number.isFinite(maxLen) || maxLen <= 0) return '…';
  if (label.length <= maxLen) return label;
  if (maxLen === 1) return '…';
  return label.slice(0, maxLen - 1) + '…';
}

/**
 * Build a Map<selected id, ifc_type> covering only ids that resolve to a node
 * in the tree. Unknown ids are skipped silently - useful when selection
 * persists across model reloads. Resolution goes through the per-tree
 * memoized index (`getSpatialNodeIndex`, WeakMap keyed on the root), so this
 * is O(selectedIds) lookups instead of the full-tree DFS it used to run on
 * every multi-select change. The index covers both id-spaces (localId and
 * expressId), and a node selected under both is counted once.
 */
export function collectSelectedTypes(
  root: SpatialNode | null,
  selectedIds: readonly number[],
): Map<number, string> {
  const out = new Map<number, string>();
  if (!root || selectedIds.length === 0) return out;
  const index = getSpatialNodeIndex(root);
  if (!index) return out;

  const seen = new Set<SpatialNode>();
  for (const id of selectedIds) {
    const node = index.get(id);
    if (!node || seen.has(node)) continue;
    seen.add(node);
    out.set(id, node.ifc_type ?? 'IfcElement');
  }
  return out;
}

/**
 * Build a histogram sorted by descending count, then ascending type-name as
 * a stable tiebreaker. Type names are already shortened via `shortenIfcType`.
 */
export function buildSelectionTypeHistogram(
  root: SpatialNode | null,
  selectedIds: readonly number[],
): SelectionTypeBucket[] {
  const types = collectSelectedTypes(root, selectedIds);
  const counts: Record<string, number> = {};
  for (const ifcType of types.values()) {
    const short = shortenIfcType(ifcType);
    counts[short] = (counts[short] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => (b.count - a.count) || a.type.localeCompare(b.type));
}

export interface SelectionChipText {
  /** Total count of resolved selections (may be < selectedIds.length if some are stale). */
  total: number;
  /** True when `total === 0` and the chip should not render. */
  empty: boolean;
  /** Primary header label, e.g. "5 selected" or "1 selected". */
  header: string;
  /** Top-N buckets, capped at MAX_TYPES_SHOWN. */
  visibleBuckets: SelectionTypeBucket[];
  /** Number of additional buckets beyond MAX_TYPES_SHOWN (0 if none). */
  hiddenBucketCount: number;
  /** Pre-formatted "+N more" suffix; empty string when nothing hidden. */
  moreSuffix: string;
}

/** Format a single bucket as "3 Wall" (no Ifc prefix; trailing 's' is the caller's choice). */
export function formatBucket(b: SelectionTypeBucket): string {
  return `${b.count} ${b.type}`;
}

/**
 * Build the entire chip text payload in one pass. `total` is computed from the
 * histogram so stale ids in `selectedIds` do not inflate the count.
 */
export function buildSelectionChipText(
  root: SpatialNode | null,
  selectedIds: readonly number[],
): SelectionChipText {
  const buckets = buildSelectionTypeHistogram(root, selectedIds);
  const total = buckets.reduce((sum, b) => sum + b.count, 0);
  if (total === 0) {
    return {
      total: 0,
      empty: true,
      header: '0 selected',
      visibleBuckets: [],
      hiddenBucketCount: 0,
      moreSuffix: '',
    };
  }
  const visible = buckets.slice(0, MAX_TYPES_SHOWN);
  const hidden = Math.max(0, buckets.length - MAX_TYPES_SHOWN);
  return {
    total,
    empty: false,
    header: `${total} selected`,
    visibleBuckets: visible,
    hiddenBucketCount: hidden,
    moreSuffix: hidden > 0 ? `+${hidden} more` : '',
  };
}

/**
 * Convenience: render the buckets as a single human-readable string used by
 * the chip's compact (tooltip / aria-label) form.
 *
 *   buildSelectionChipText(...) → "5 selected · 3 Wall · 1 Door · 1 Window"
 */
export function formatSelectionChipLine(text: SelectionChipText): string {
  if (text.empty) return '';
  const parts = [text.header, ...text.visibleBuckets.map(formatBucket)];
  if (text.moreSuffix) parts.push(text.moreSuffix);
  return parts.join(' · ');
}
