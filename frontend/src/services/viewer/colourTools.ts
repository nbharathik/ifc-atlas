import * as THREE from 'three';
import type { SpatialNode } from '../../types/ifc';
import type {
  ColourByProperty,
  ColourLayer,
  ColourLayerEntry,
  ColourLayerLegendRow,
} from '../../store/useStore';

/** IFC spatial-structure classes excluded from colour grouping. */
const SPATIAL_IFC_TYPES = new Set([
  'IfcProject', 'IfcSite', 'IfcBuilding', 'IfcBuildingStorey', 'IfcSpace',
]);

/**
 * Fixed palette for small group counts (≤ 12) - stable tailwind-family hues.
 *
 * Deliberately excludes the viewer's reserved highlight colours (selection
 * amber 0xf59e0b, hover amber 0xfbbf24, chat cyan 0x00d2ff) so a colour-by
 * group can never read as "selected" or "chat-highlighted". Adjacency is
 * ordered for deuteranopia/protanopia: blue/violet/pink/teal entries
 * interleave the greens (emerald, teal, lime) and the red (rose).
 */
export const PALETTE: THREE.Color[] = [
  new THREE.Color(0x3b82f6), // blue
  new THREE.Color(0x10b981), // emerald
  new THREE.Color(0x8b5cf6), // violet
  new THREE.Color(0xf43f5e), // rose
  new THREE.Color(0x14b8a6), // teal
  new THREE.Color(0xd946ef), // fuchsia
  new THREE.Color(0x84cc16), // lime
  new THREE.Color(0x6366f1), // indigo
  new THREE.Color(0xec4899), // pink
  new THREE.Color(0x38bdf8), // sky
  new THREE.Color(0xa855f7), // purple
  new THREE.Color(0xa8a29e), // stone
];

export interface ColourGroup {
  label: string;
  color: THREE.Color;
  ids: number[];
}

/**
 * Deterministic hash of a string to an HSL colour.
 *
 * Converts the string to a 32-bit integer via djb2 hash then maps to an HSL
 * triple with fixed saturation + lightness so the palette is always readable
 * on dark backgrounds.  Two strings that share the same hash bucket get the
 * same colour - acceptable for colour-by-property where labels are usually
 * unique within a model.
 */
export function hashStringToHSL(s: string): THREE.Color {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return new THREE.Color().setHSL(hue / 360, 0.60, 0.58);
}

/**
 * Choose a colour for a group label.
 *
 * Uses the fixed PALETTE for the first 12 groups (stable, visually distinct)
 * then falls back to `hashStringToHSL` for additional groups so that
 * large property sets (e.g. many material types) still get unique colours.
 */
function groupColor(label: string, sortedIndex: number): THREE.Color {
  return sortedIndex < PALETTE.length
    ? PALETTE[sortedIndex]
    : hashStringToHSL(label);
}

/**
 * Extract a "material family" label from an element name.
 *
 * IFC element names from authoring tools (Revit, ArchiCAD, etc.) often
 * encode the material or type family using colon-separated tokens, e.g.:
 *   "Basic Wall:Concrete Block 200mm:1234567"  → "Concrete Block 200mm"
 *   "Structural Column:Steel Column IPE300:98765" → "Steel Column IPE300"
 *   "Concrete Wall" (no colon) → "Concrete Wall"
 *
 * The heuristic: split on ":", return the second token (index 1) if it
 * exists and is non-trivial (not a plain integer), otherwise the first token.
 */
export function extractNameGroup(name: string): string {
  if (!name || !name.trim()) return 'Unknown';
  const parts = name.split(':');
  if (parts.length >= 2) {
    const mid = parts[1].trim();
    // Reject trivial tokens that are pure integers (Revit instance IDs)
    if (mid && !/^\d+$/.test(mid)) return mid;
  }
  return parts[0].trim() || 'Unknown';
}

/**
 * Walk the spatial tree and group leaf-element express IDs by `property`.
 * Returns an ordered array of groups (largest first for the legend).
 *
 * - `'type'`     - group by IfcType (IfcWall, IfcBeam, …)
 * - `'storey'`   - group by building storey name
 * - `'material'` - group by element name family (heuristic; see extractNameGroup)
 */
export function buildColourGroups(
  root: SpatialNode | null,
  property: Exclude<ColourByProperty, 'off'>,
): ColourGroup[] {
  if (!root) return [];

  const buckets = new Map<string, number[]>();

  function walk(node: SpatialNode, currentStorey: string): void {
    const storey =
      node.ifc_type === 'IfcBuildingStorey' ? node.name : currentStorey;

    if (!SPATIAL_IFC_TYPES.has(node.ifc_type) && node.id) {
      let key: string;
      if (property === 'type') {
        key = node.ifc_type;
      } else if (property === 'storey') {
        key = storey || 'Unknown';
      } else {
        // 'material' - use name-family heuristic
        key = extractNameGroup(node.name || '');
      }
      let arr = buckets.get(key);
      if (!arr) { arr = []; buckets.set(key, arr); }
      arr.push(node.id);
    }

    for (const child of node.children) {
      walk(child, storey);
    }
  }

  walk(root, 'Unknown');

  // Sort labels alphabetically for deterministic colour assignment
  const sorted = [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  return sorted
    .map(([label, ids], i) => ({
      label,
      color: groupColor(label, i),
      ids,
    }))
    .sort((a, b) => b.ids.length - a.ids.length);
}

/** Shorten an IFC type string for display. IfcWallStandardCase → Wall */
export function shortIfcType(ifcType: string): string {
  return ifcType.replace(/^Ifc/, '').replace(/StandardCase$/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
}

/**
 * Pure helpers for the generic colour-layer API (store `colourLayers`).
 *
 * A colour layer paints ANY element set with ANY colour - the store slice
 * carries the data, `ViewerPanel.rebuildNativeHighlights` does the painting,
 * and `ColourLayerLegend` renders legends. This module stays pure (no THREE,
 * no store access) so vitest can pin the ramp, the bucketing, and the
 * layer-merge semantics without a DOM or a viewer.
 */


/**
 * Heat-ramp anchor colours, low to high: blue -> cyan -> yellow -> red.
 * Piecewise-linear sRGB interpolation between tailwind-family anchors.
 * Deliberately avoids the viewer's reserved highlight hues (selection amber
 * 0xf59e0b, chat cyan 0x00d2ff) at the anchor points so a heatmap bucket
 * never reads as "selected" or "chat-highlighted".
 */
const HEAT_ANCHORS: ReadonlyArray<readonly [number, number, number]> = [
  [0x25, 0x63, 0xeb], // blue   (#2563eb)
  [0x22, 0xd3, 0xee], // cyan   (#22d3ee)
  [0xfa, 0xcc, 0x15], // yellow (#facc15)
  [0xef, 0x44, 0x44], // red    (#ef4444)
];

function channelHex(v: number): string {
  return Math.round(v).toString(16).padStart(2, '0');
}

/**
 * Map t in [0, 1] onto the blue -> cyan -> yellow -> red heat ramp.
 * Out-of-range inputs clamp to the ends (infinities included); NaN maps
 * to the cold end. Returns a CSS hex colour string '#rrggbb'.
 */
export function heatRamp(t: number): string {
  const clamped = Number.isNaN(t) ? 0 : Math.min(1, Math.max(0, t));
  const scaled = clamped * (HEAT_ANCHORS.length - 1);
  const i = Math.min(HEAT_ANCHORS.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const a = HEAT_ANCHORS[i];
  const b = HEAT_ANCHORS[i + 1];
  const r = a[0] + (b[0] - a[0]) * f;
  const g = a[1] + (b[1] - a[1]) * f;
  const bl = a[2] + (b[2] - a[2]) * f;
  return `#${channelHex(r)}${channelHex(g)}${channelHex(bl)}`;
}

/** Compact numeric label: 3 significant digits, trailing zeros stripped. */
function fmtNum(v: number): string {
  return Number(v.toPrecision(3)).toString();
}

export interface HeatmapValue {
  /** IFC express id. */
  id: number;
  value: number;
}

export interface HeatmapOptions {
  /** Ramp minimum. Defaults to the smallest finite value. */
  min?: number;
  /** Ramp maximum. Defaults to the largest finite value. */
  max?: number;
  /** Number of equal-width buckets (default 5, floor 1). */
  buckets?: number;
  /** Custom legend label for a bucket's [lo, hi] range. */
  label?: (lo: number, hi: number) => string;
  /** Display name for the legend header. */
  name?: string;
}

/**
 * Bucket numeric per-element values into a heat-ramped `ColourLayer`.
 *
 * - Values are split into `buckets` equal-width ranges over [min, max];
 *   values outside an explicit min/max clamp into the edge buckets.
 * - Non-finite values are ignored.
 * - min === max (all values equal, or a degenerate explicit range) collapses
 *   to a single mid-ramp bucket.
 * - The legend lists every bucket (full scale, coldest first) even when a
 *   bucket holds no elements; `entries` only carries non-empty buckets.
 */
export function buildHeatmapLayer(
  values: HeatmapValue[],
  opts: HeatmapOptions = {},
): ColourLayer {
  const finite = values.filter((v) => Number.isFinite(v.value));
  if (finite.length === 0) {
    return { entries: [], legend: [], name: opts.name };
  }

  let min = opts.min ?? Math.min(...finite.map((v) => v.value));
  let max = opts.max ?? Math.max(...finite.map((v) => v.value));
  if (min > max) [min, max] = [max, min];

  const degenerate = min === max;
  const buckets = degenerate ? 1 : Math.max(1, Math.floor(opts.buckets ?? 5));
  const step = degenerate ? 0 : (max - min) / buckets;

  const bucketIds: number[][] = Array.from({ length: buckets }, () => []);
  for (const { id, value } of finite) {
    const idx = degenerate
      ? 0
      : Math.min(buckets - 1, Math.max(0, Math.floor((value - min) / step)));
    bucketIds[idx].push(id);
  }

  const labelFor =
    opts.label
    ?? ((lo: number, hi: number) => (lo === hi ? fmtNum(lo) : `${fmtNum(lo)} - ${fmtNum(hi)}`));

  const entries: ColourLayerEntry[] = [];
  const legend: ColourLayerLegendRow[] = [];
  for (let i = 0; i < buckets; i++) {
    const lo = min + i * step;
    const hi = i === buckets - 1 ? max : min + (i + 1) * step;
    const color = buckets === 1 ? heatRamp(0.5) : heatRamp(i / (buckets - 1));
    legend.push({ color, label: labelFor(lo, hi) });
    if (bucketIds[i].length > 0) entries.push({ color, ids: bucketIds[i] });
  }

  return { entries, legend, name: opts.name };
}

/**
 * Merge every active colour layer into disjoint paint groups.
 *
 * Override semantics (mirrors paint order): layers are visited in the
 * record's key order (the store's `setColourLayer` keeps that "last set
 * last"), entries within a layer in array order, and a LATER write wins for
 * an id claimed twice. The result groups the winning ids by colour string,
 * so the caller can issue one highlight call per distinct colour and merge
 * the pairs into the highlight snapshot's per-id base-colour map.
 */
export function flattenColourLayers(
  layers: Record<string, ColourLayer>,
): ColourLayerEntry[] {
  // Map.set on an existing key updates the value in place, so iteration
  // order stays "first time the id was seen" while the colour is the last
  // one written - exactly the override rule documented above.
  const winner = new Map<number, string>();
  for (const key of Object.keys(layers)) {
    for (const entry of layers[key].entries) {
      for (const id of entry.ids) winner.set(id, entry.color);
    }
  }
  const groups = new Map<string, number[]>();
  for (const [id, color] of winner) {
    const ids = groups.get(color);
    if (ids) ids.push(id);
    else groups.set(color, [id]);
  }
  return [...groups.entries()].map(([color, ids]) => ({ color, ids }));
}
