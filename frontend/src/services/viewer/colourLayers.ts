/**
 * Pure helpers for the generic colour-layer API (store `colourLayers`).
 *
 * A colour layer paints ANY element set with ANY colour - the store slice
 * carries the data, `ViewerPanel.rebuildNativeHighlights` does the painting,
 * and `ColourLayerLegend` renders legends. This module stays pure (no THREE,
 * no store access) so vitest can pin the ramp, the bucketing, and the
 * layer-merge semantics without a DOM or a viewer.
 */

import type {
  ColourLayer,
  ColourLayerEntry,
  ColourLayerLegendRow,
} from '../../store/useStore';

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
