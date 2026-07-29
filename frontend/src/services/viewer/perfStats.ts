/**
 * Click-to-highlight latency surface - pure helpers.
 *
 * Measures the round-trip from pointer-up (after drag detection) to the
 * resolution of the forced 'click-highlight' fragment flush - an upper
 * bound that runs a few ms past first paint (see the honesty note
 * on recordClickLatencyFlush in ViewerPanel). Surfaces in PerformanceHud
 * and (later) the Performance Dashboard.
 *
 * Budget (supersedes the old 90/200 ms thresholds): the targets are
 * p50 ≤ 50 ms and p95 ≤ 80 ms on the BasicHouse.ifc sample, so the
 * buckets now mirror those two lines. The old
 * 200 ms "ok" ceiling predated the engine-fence override and let real
 * regressions pass unflagged.
 *
 * The helpers in this file are intentionally framework-free so they can
 * be unit-tested without spinning up a renderer or a Zustand store.
 * `ViewerPanel.tsx` owns the timer; this file owns the
 * bucketing / formatting / rolling-window math.
 */

/** Latency at or under this is "fast" - meets the p50 target. */
export const CLICK_LATENCY_FAST_MS = 50;

/** Above fast, at or under this is "ok" - inside the p95 target. */
export const CLICK_LATENCY_OK_MS = 80;

/** Anything over CLICK_LATENCY_OK_MS is "slow" - investigate. */

/** Maximum samples to keep in the rolling-window helper. */
export const CLICK_LATENCY_WINDOW_SIZE = 10;

export type ClickLatencyBucket = 'fast' | 'ok' | 'slow';

/**
 * Bucket a latency reading. Negative / NaN / non-finite values return
 * `null` so callers can short-circuit (treat as "no measurement yet").
 *
 * Threshold rule: `<= FAST` → 'fast'; `<= OK` → 'ok'; otherwise 'slow'.
 * Equality with the threshold lands in the lower (better) bucket.
 */
export function bucketClickLatency(ms: number | null | undefined): ClickLatencyBucket | null {
  if (ms == null) return null;
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms <= CLICK_LATENCY_FAST_MS) return 'fast';
  if (ms <= CLICK_LATENCY_OK_MS) return 'ok';
  return 'slow';
}

/**
 * Map a latency reading to a CSS color variable matching the HUD's
 * fps / draw-calls colour scheme (green / yellow / red).
 *
 * `null` (no measurement) returns the neutral foreground colour so the
 * chip is visible but un-coloured before the first click.
 */
export function clickLatencyColor(ms: number | null | undefined): string {
  const bucket = bucketClickLatency(ms);
  if (bucket === 'fast') return 'var(--success)';
  if (bucket === 'ok') return 'var(--warning)';
  if (bucket === 'slow') return 'var(--danger)';
  return 'var(--fg)';
}

/**
 * Format a latency reading for the HUD chip. Renders sub-millisecond
 * values as `<1 ms` so the chip never shows the misleading `0 ms`.
 * `null` / non-finite → em-dash placeholder (matches PerfHud convention).
 */
export function formatClickLatency(ms: number | null | undefined): string {
  if (ms == null) return '-';
  if (!Number.isFinite(ms) || ms < 0) return '-';
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * Append a sample to a rolling window, dropping the oldest when the
 * window is full. Returns a NEW array - never mutates the input. The
 * input is left untouched even when the new sample is rejected.
 *
 * Non-finite / negative samples are dropped silently (returns the
 * unchanged window). The window cap is `CLICK_LATENCY_WINDOW_SIZE`
 * unless overridden.
 */
export function pushClickLatencySample(
  window: readonly number[],
  sample: number,
  cap: number = CLICK_LATENCY_WINDOW_SIZE,
): number[] {
  if (!Number.isFinite(sample) || sample < 0) return [...window];
  const next = [...window, sample];
  if (next.length <= cap) return next;
  return next.slice(next.length - cap);
}

/**
 * Median of a click-latency window. Returns `null` for an empty window.
 * Sorts a copy of the input - does not mutate. Used by A2 follow-up to
 * report a stable "last 10 median" instead of last-click only.
 */
export function medianClickLatency(window: readonly number[]): number | null {
  if (window.length === 0) return null;
  const sorted = [...window].sort((a, b) => a - b);
  const mid = sorted.length >>> 1;
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Worst sample in a click-latency window. Returns `null` for an empty
 * window. Pairs with `medianClickLatency` in the HUD so the user can
 * spot worst-case spikes that the median smooths away - directly
 * actionable when investigating "why was that one click slow?".
 *
 * Does not mutate the input.
 */
export function maxClickLatency(window: readonly number[]): number | null {
  if (window.length === 0) return null;
  let worst = window[0];
  for (let i = 1; i < window.length; i += 1) {
    if (window[i] > worst) worst = window[i];
  }
  return worst;
}

/**
 * 95th-percentile sample in a click-latency window. Returns `null` for an
 * empty window. Sits between the median (typical click) and the max (worst
 * spike): a stable "almost-worst-case" the HUD can chip alongside median so
 * the user sees the latency the slowest 1-in-20 clicks experience - the
 * number the plan's p95 ≤ 80 ms target (CLICK_LATENCY_OK_MS) is judged
 * against.
 *
 * Uses the nearest-rank method (ceil(p · N) − 1, clamped) so small windows
 * resolve to a concrete sample rather than an interpolated value; with the
 * default 10-sample window p95 lands on the worst sample, matching intuition
 * for short windows. Does not mutate the input.
 */
export function p95ClickLatency(window: readonly number[]): number | null {
  if (window.length === 0) return null;
  const sorted = [...window].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length) - 1;
  const idx = Math.min(sorted.length - 1, Math.max(0, rank));
  return sorted[idx];
}

/**
 * Format a measurement-run summary for the performance log.
 *
 * Drives the baseline-recording workflow: after driving N clicks
 * via the preview harness, the caller passes the collected samples to
 * this helper and pastes the returned string into the performance log.
 *
 * Returns a single multi-line string (Markdown-friendly) of the shape:
 *
 *   ```
 *   samples: 30
 *   median: 64 ms
 *   max: 112 ms
 *   budget: median ≤ 80 ms ✓, max ≤ 120 ms ✓
 *   ```
 *
 * Budget thresholds: median ≤ 80 ms, max ≤ 120 ms. These are the LEGACY
 * v1.0 measurement-run budgets kept so older recorded measurement runs
 * stay comparable; the live HUD buckets use the stricter 50/80 targets
 * (CLICK_LATENCY_FAST_MS / CLICK_LATENCY_OK_MS) above. Either one over
 * budget renders ✗ so future measurement runs catch regressions at a
 * glance.
 */
export const V1_F2_BUDGET_MEDIAN_MS = 80;
export const V1_F2_BUDGET_MAX_MS = 120;

export function summarizeClickLatencyRun(
  samples: readonly number[],
  label: string = 'BasicHouse',
): string {
  if (samples.length === 0) {
    return `## ${label}\nsamples: 0 (no measurements)\n`;
  }
  const median = medianClickLatency(samples);
  const max = maxClickLatency(samples);
  const medianOk = median !== null && median <= V1_F2_BUDGET_MEDIAN_MS;
  const maxOk = max !== null && max <= V1_F2_BUDGET_MAX_MS;
  const fmt = (v: number | null) => (v === null ? '-' : `${v.toFixed(0)} ms`);
  return [
    `## ${label}`,
    `samples: ${samples.length}`,
    `median: ${fmt(median)}`,
    `max: ${fmt(max)}`,
    `budget: median ≤ ${V1_F2_BUDGET_MEDIAN_MS} ms ${medianOk ? '✓' : '✗'}, `
      + `max ≤ ${V1_F2_BUDGET_MAX_MS} ms ${maxOk ? '✓' : '✗'}`,
    '',
  ].join('\n');
}

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

/**
 * Last main-pass render stats - the honest source for draw-call/triangle
 * counters.
 *
 * `renderer.info` cannot be sampled directly by the HUD or benches: the
 * engine's RendererWith2D base class re-triggers `onBeforeUpdate` from
 * inside its own `onAfterUpdate` handler (a constructor-time hook that runs
 * before any app handler), so a reset that rides `onBeforeUpdate` fires
 * TWICE per frame - once at the real frame start and once right after the
 * main scene render. Anything reading `renderer.info` between frames then
 * sees only the passes drawn after the second reset (the view gizmo:
 * ~9 calls / 72 triangles), not the ~124-call main scene. Off-frame passes
 * (the fast-picker ID pass, `__ifcRenderStats`'s probe render) also land in
 * whatever window is open at the time, so raw counters over-report too.
 *
 * ViewerPanel therefore captures the counters ONCE per rendered frame, right
 * after the main pass (overlay contribution subtracted), into the module
 * singleton below. Consumers (HUD sampler, `__ifcRenderStats`) read the
 * snapshot instead of `renderer.info`. The singleton is mutated in place -
 * zero per-frame allocation - and persists across sparse frames, so under
 * RENDER_ON_DEMAND it keeps reporting the frame that is actually on screen.
 *
 * Pure module - no DOM, no three.js - so the bookkeeping is unit-testable.
 */

export interface MainPassStats {
  /** Number of main passes recorded since the last reset (0 = no data). */
  frame: number;
  drawCalls: number;
  triangles: number;
  /** performance.now() timestamp of the last recorded main pass. */
  recordedAt: number;
}

const stats: MainPassStats = {
  frame: 0,
  drawCalls: 0,
  triangles: 0,
  recordedAt: 0,
};

/**
 * Record one main pass. Overlay counts (gizmo, and anything else drawn
 * between the main render and the capture point) are subtracted here so the
 * snapshot matches a dedicated scene-only render pass. Negative results are
 * clamped to 0 rather than trusted - they mean the overlay accounting and
 * the totals disagree (e.g. a counter reset raced the capture).
 */
export function recordMainPass(
  totalCalls: number,
  totalTriangles: number,
  overlayCalls: number,
  overlayTriangles: number,
  nowMs: number,
): void {
  stats.frame += 1;
  stats.drawCalls = Math.max(0, totalCalls - overlayCalls);
  stats.triangles = Math.max(0, totalTriangles - overlayTriangles);
  stats.recordedAt = nowMs;
}

/** The live singleton. Treat as read-only; it is rewritten every frame. */
export function getMainPassStats(): Readonly<MainPassStats> {
  return stats;
}

/**
 * Whether the snapshot is recent enough to serve without re-measuring.
 * "Fresh" tolerates the dev keep-alive cadence of RENDER_ON_DEMAND (one
 * frame per second); callers that find a stale snapshot (production MANUAL
 * mode after a long idle, or no frame drawn yet) should fall back to their
 * own measurement.
 */
export function isMainPassFresh(nowMs: number, maxAgeMs: number): boolean {
  return stats.frame > 0 && nowMs - stats.recordedAt <= maxAgeMs;
}

/** Clear on viewer teardown so a remount never serves a dead world's frame. */
export function resetMainPassStats(): void {
  stats.frame = 0;
  stats.drawCalls = 0;
  stats.triangles = 0;
  stats.recordedAt = 0;
}

/**
 * Frame-time statistics for the dev orbit benchmark.
 *
 * The HUD's FPS chip is an instantaneous 500 ms readout that needs an open
 * panel and manual eyeballing; regressions hide in percentiles. The dev
 * global wired in ViewerPanel (`window.__ifcOrbitBench`) drives a scripted
 * orbit, collects requestAnimationFrame deltas, and summarizes them here so
 * before/after runs are comparable single JSON objects in the console.
 *
 * Pure module - no DOM, no three.js - so the math is unit-testable.
 */

export interface FrameTimeStats {
  frames: number;
  durationMs: number;
  fps: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  worstMs: number;
  /** Frames slower than ~2 vsyncs at 60 Hz - visible hitches. */
  framesOver33Ms: number;
}

export interface FrameSamplingPolicyInput {
  readonly elapsedMs: number;
  readonly requestedDurationMs: number;
  readonly validSamples: number;
  readonly minimumSamples: number;
  readonly maximumDurationMs: number;
}

/**
 * Keep a diagnostic probe alive for both its requested time window and a
 * useful sample count. The maximum guard prevents a pathological software
 * renderer from extending an E2E run indefinitely.
 */
export function shouldContinueFrameSampling(input: FrameSamplingPolicyInput): boolean {
  const requestedDurationMs = Math.max(0, input.requestedDurationMs);
  const maximumDurationMs = Math.max(requestedDurationMs, input.maximumDurationMs);
  if (input.elapsedMs >= maximumDurationMs) return false;
  return (
    input.elapsedMs < requestedDurationMs
    || input.validSamples < Math.max(0, input.minimumSamples)
  );
}

export function summarizeFrameDeltas(deltas: readonly number[]): FrameTimeStats {
  const valid = deltas.filter((d) => Number.isFinite(d) && d > 0);
  if (valid.length === 0) {
    return {
      frames: 0,
      durationMs: 0,
      fps: 0,
      avgMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      worstMs: 0,
      framesOver33Ms: 0,
    };
  }
  const sorted = [...valid].sort((a, b) => a - b);
  const durationMs = valid.reduce((sum, d) => sum + d, 0);
  const rank = (p: number) => {
    const idx = Math.ceil(p * sorted.length) - 1;
    return sorted[Math.min(sorted.length - 1, Math.max(0, idx))];
  };
  const round1 = (v: number) => Math.round(v * 10) / 10;
  return {
    frames: valid.length,
    durationMs: Math.round(durationMs),
    fps: round1((valid.length / durationMs) * 1000),
    avgMs: round1(durationMs / valid.length),
    p50Ms: round1(rank(0.5)),
    p95Ms: round1(rank(0.95)),
    worstMs: round1(sorted[sorted.length - 1]),
    framesOver33Ms: valid.filter((d) => d > 33.4).length,
  };
}
