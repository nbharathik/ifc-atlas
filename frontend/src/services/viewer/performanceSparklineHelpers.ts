/**
 * Pure SVG sparkline helpers for the Performance Dashboard.
 *
 * Kept React-free + DOM-free so they can be unit-tested in isolation.
 * The dashboard uses them to render a TTFR trend chart above the sample
 * table - the historical view that the table alone can't surface at a
 * glance.
 */

export interface SparklinePoint {
  x: number;
  y: number;
}

export interface SparklineRange {
  min: number;
  max: number;
}

/**
 * Returns the y-range covered by the values. Defends against:
 *  - empty input          → { min: 0, max: 1 } so callers never divide by zero.
 *  - all-NaN/Infinite     → same fallback as empty.
 *  - flat series (min===max) → padded by max(1, |v|*0.1) so the polyline sits
 *    in the middle of the canvas instead of along the bottom edge.
 */
export function computeRange(values: readonly number[]): SparklineRange {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: 1 };
  }
  if (max === min) {
    const pad = Math.max(1, Math.abs(min) * 0.1);
    return { min: min - pad, max: max + pad };
  }
  return { min, max };
}

/**
 * Projects sample indices into screen-space points inside a (width × height)
 * canvas with `padding` on each side. NaN / non-finite values are clamped to
 * the y-range minimum so the line never disappears.
 */
export function projectPoints(
  values: readonly number[],
  width: number,
  height: number,
  padding: number,
  range?: SparklineRange,
): SparklinePoint[] {
  if (values.length === 0) return [];
  const r = range ?? computeRange(values);
  // Guard against zero/negative canvas - projection still returns something
  // sensible (a degenerate line) instead of NaN-cascading into the SVG.
  const innerW = Math.max(1, width - padding * 2);
  const innerH = Math.max(1, height - padding * 2);
  const span = r.max - r.min || 1;
  const n = values.length;
  const stepX = n > 1 ? innerW / (n - 1) : 0;
  const out: SparklinePoint[] = [];
  for (let i = 0; i < n; i += 1) {
    const raw = values[i];
    const v = Number.isFinite(raw) ? raw : r.min;
    const yNorm = (v - r.min) / span;
    const x = padding + i * stepX;
    const y = padding + innerH * (1 - yNorm);
    out.push({ x, y });
  }
  return out;
}

/**
 * Returns the SVG `d` attribute for a polyline through the given points.
 * Empty input yields `''` so the caller can short-circuit the render.
 * Single-point input draws a short horizontal tick (3 px wide) so it's still
 * visible.
 */
export function buildSparklinePath(points: readonly SparklinePoint[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) {
    const p = points[0];
    return `M ${(p.x - 1.5).toFixed(2)} ${p.y.toFixed(2)} L ${(p.x + 1.5).toFixed(2)} ${p.y.toFixed(2)}`;
  }
  let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let i = 1; i < points.length; i += 1) {
    d += ` L ${points[i].x.toFixed(2)} ${points[i].y.toFixed(2)}`;
  }
  return d;
}

/**
 * Returns the SVG `d` attribute for the area under the polyline, closing on
 * `baselineY` (typically the bottom inner edge of the canvas). Used when the
 * caller wants a soft-fill sparkline beneath the stroke.
 */
export function buildSparklineAreaPath(
  points: readonly SparklinePoint[],
  baselineY: number,
): string {
  if (points.length === 0) return '';
  const line = buildSparklinePath(points);
  const last = points[points.length - 1];
  const first = points[0];
  return `${line} L ${last.x.toFixed(2)} ${baselineY.toFixed(2)} L ${first.x.toFixed(2)} ${baselineY.toFixed(2)} Z`;
}

/**
 * Returns a copy of `samples` in oldest-first order.
 *
 * Storage convention (see ViewerPanel.tsx, key `ifc-viewer-perf-log`):
 * new samples are pushed with `unshift`, so `samples[0]` is the newest and
 * `samples[N-1]` is the oldest. The sparkline reads left-to-right as time,
 * so callers reverse for projection to keep the "oldest → newest" axis
 * truthful. Pulled into a named helper so the invariant is testable and
 * future writers don't have to re-derive which end is which.
 */
export function orderSamplesOldestFirst<T>(samples: readonly T[]): T[] {
  return [...samples].reverse();
}

/**
 * Convenience: derive the {min,avg,max} triple used by the dashboard labels
 * in one pass. Returns null for empty / all-non-finite input so the caller
 * can hide the labels.
 */
export function summariseValues(
  values: readonly number[],
): { min: number; max: number; avg: number; count: number } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  let n = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    n += 1;
  }
  if (n === 0) return null;
  return { min, max, avg: sum / n, count: n };
}
