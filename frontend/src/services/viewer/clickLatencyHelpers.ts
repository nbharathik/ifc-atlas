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
