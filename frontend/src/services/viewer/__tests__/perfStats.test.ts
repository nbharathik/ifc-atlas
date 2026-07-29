import { describe, it, expect, beforeEach } from 'vitest';
import {
  CLICK_LATENCY_FAST_MS,
  CLICK_LATENCY_OK_MS,
  CLICK_LATENCY_WINDOW_SIZE,
  V1_F2_BUDGET_MAX_MS,
  V1_F2_BUDGET_MEDIAN_MS,
  bucketClickLatency,
  clickLatencyColor,
  formatClickLatency,
  pushClickLatencySample,
  medianClickLatency,
  maxClickLatency,
  p95ClickLatency,
  summarizeClickLatencyRun,
  computeRange,
  projectPoints,
  buildSparklinePath,
  buildSparklineAreaPath,
  orderSamplesOldestFirst,
  summariseValues,
  getMainPassStats,
  isMainPassFresh,
  recordMainPass,
  resetMainPassStats,
  shouldContinueFrameSampling,
  summarizeFrameDeltas,
} from '../perfStats';

describe('bucketClickLatency', () => {
  it('returns null for null / undefined / non-finite / negative', () => {
    expect(bucketClickLatency(null)).toBeNull();
    expect(bucketClickLatency(undefined)).toBeNull();
    expect(bucketClickLatency(Number.NaN)).toBeNull();
    expect(bucketClickLatency(Number.POSITIVE_INFINITY)).toBeNull();
    expect(bucketClickLatency(-1)).toBeNull();
  });

  it('buckets fast values at and below the fast threshold', () => {
    expect(bucketClickLatency(0)).toBe('fast');
    expect(bucketClickLatency(45)).toBe('fast');
    expect(bucketClickLatency(CLICK_LATENCY_FAST_MS)).toBe('fast');
  });

  it('buckets ok values just over fast and at the ok threshold', () => {
    expect(bucketClickLatency(CLICK_LATENCY_FAST_MS + 0.1)).toBe('ok');
    expect(bucketClickLatency(65)).toBe('ok');
    expect(bucketClickLatency(CLICK_LATENCY_OK_MS)).toBe('ok');
  });

  it('buckets slow values strictly above the ok threshold', () => {
    expect(bucketClickLatency(CLICK_LATENCY_OK_MS + 0.1)).toBe('slow');
    expect(bucketClickLatency(500)).toBe('slow');
    expect(bucketClickLatency(10_000)).toBe('slow');
  });
});

describe('clickLatencyColor', () => {
  it('maps each bucket to a distinct CSS var', () => {
    expect(clickLatencyColor(50)).toBe('var(--success)');
    expect(clickLatencyColor(65)).toBe('var(--warning)');
    expect(clickLatencyColor(500)).toBe('var(--danger)');
  });

  it('returns neutral foreground when no measurement yet', () => {
    expect(clickLatencyColor(null)).toBe('var(--fg)');
    expect(clickLatencyColor(undefined)).toBe('var(--fg)');
    expect(clickLatencyColor(Number.NaN)).toBe('var(--fg)');
  });
});

describe('formatClickLatency', () => {
  it('em-dashes a null / non-finite / negative input', () => {
    expect(formatClickLatency(null)).toBe('-');
    expect(formatClickLatency(undefined)).toBe('-');
    expect(formatClickLatency(Number.NaN)).toBe('-');
    expect(formatClickLatency(-5)).toBe('-');
  });

  it('renders sub-millisecond values as <1 ms', () => {
    expect(formatClickLatency(0)).toBe('<1 ms');
    expect(formatClickLatency(0.4)).toBe('<1 ms');
    expect(formatClickLatency(0.999)).toBe('<1 ms');
  });

  it('renders sub-second values as integer ms', () => {
    expect(formatClickLatency(1)).toBe('1 ms');
    expect(formatClickLatency(45.4)).toBe('45 ms');
    expect(formatClickLatency(999)).toBe('999 ms');
  });

  it('renders ≥ 1s as fixed-2 seconds', () => {
    expect(formatClickLatency(1000)).toBe('1.00 s');
    expect(formatClickLatency(1234)).toBe('1.23 s');
    expect(formatClickLatency(12_345)).toBe('12.35 s');
  });
});

describe('pushClickLatencySample', () => {
  it('appends within cap and does not mutate the input', () => {
    const window = [10, 20];
    const next = pushClickLatencySample(window, 30, 5);
    expect(next).toEqual([10, 20, 30]);
    // Input unchanged - readonly contract.
    expect(window).toEqual([10, 20]);
  });

  it('drops the oldest sample when at cap', () => {
    expect(pushClickLatencySample([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
  });

  it('drops multiple oldest if the window starts over-cap', () => {
    expect(pushClickLatencySample([1, 2, 3, 4, 5], 6, 3)).toEqual([4, 5, 6]);
  });

  it('uses the default cap when not supplied', () => {
    const big = Array.from({ length: CLICK_LATENCY_WINDOW_SIZE }, (_, i) => i + 1);
    const next = pushClickLatencySample(big, 99);
    expect(next).toHaveLength(CLICK_LATENCY_WINDOW_SIZE);
    expect(next[next.length - 1]).toBe(99);
    expect(next[0]).toBe(2);
  });

  it('silently drops non-finite / negative samples', () => {
    expect(pushClickLatencySample([10, 20], Number.NaN)).toEqual([10, 20]);
    expect(pushClickLatencySample([10, 20], Number.POSITIVE_INFINITY)).toEqual([10, 20]);
    expect(pushClickLatencySample([10, 20], -5)).toEqual([10, 20]);
  });

  it('accepts zero as a valid sample', () => {
    expect(pushClickLatencySample([10], 0, 5)).toEqual([10, 0]);
  });
});

describe('rolling-window + median composition (ViewerPanel sequence)', () => {
  it('returns the sample itself for the first push', () => {
    const w = pushClickLatencySample([], 45);
    expect(medianClickLatency(w)).toBe(45);
  });

  it('stabilises around the true median after the window fills', () => {
    let w: number[] = [];
    // Ten increasing samples (1..10) - median of 1..10 is (5+6)/2 = 5.5.
    for (const ms of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      w = pushClickLatencySample(w, ms);
    }
    expect(w).toHaveLength(CLICK_LATENCY_WINDOW_SIZE);
    expect(medianClickLatency(w)).toBe(5.5);
  });

  it('drops a brief outlier as the window slides past it', () => {
    let w: number[] = [];
    for (const ms of [50, 50, 50, 50, 50, 50, 50, 50, 50, 50]) {
      w = pushClickLatencySample(w, ms);
    }
    // A single 900 ms spike shows in the last reading but the median is
    // still pulled by the other nine 50 ms samples → 50.
    w = pushClickLatencySample(w, 900);
    expect(medianClickLatency(w)).toBe(50);
    // Keep pushing 50s - the spike eventually falls off the window and
    // the median settles back to 50 with no trace of the outlier.
    for (let i = 0; i < CLICK_LATENCY_WINDOW_SIZE; i += 1) {
      w = pushClickLatencySample(w, 50);
    }
    expect(w).not.toContain(900);
    expect(medianClickLatency(w)).toBe(50);
  });
});

describe('maxClickLatency', () => {
  it('returns null for empty input', () => {
    expect(maxClickLatency([])).toBeNull();
  });

  it('returns the sole element for a one-sample window', () => {
    expect(maxClickLatency([42])).toBe(42);
  });

  it('returns the largest element', () => {
    expect(maxClickLatency([10, 5, 30, 20])).toBe(30);
    expect(maxClickLatency([1, 2, 3, 4, 5])).toBe(5);
    expect(maxClickLatency([5, 4, 3, 2, 1])).toBe(5);
  });

  it('handles duplicate maxima', () => {
    expect(maxClickLatency([7, 9, 9, 3])).toBe(9);
  });

  it('does not mutate the input', () => {
    const win = [3, 1, 7, 2];
    maxClickLatency(win);
    expect(win).toEqual([3, 1, 7, 2]);
  });

  it('co-exists with median (spike is visible in max, hidden in median)', () => {
    // Nine 50 ms samples + one 900 ms spike. Median smooths the spike;
    // max exposes it - exactly the diagnostic case the HUD row covers.
    const w = [50, 50, 50, 50, 50, 50, 50, 50, 50, 900];
    expect(medianClickLatency(w)).toBe(50);
    expect(maxClickLatency(w)).toBe(900);
  });

  it('falls back to the next-highest when the spike slides off the window', () => {
    let w: number[] = [];
    for (const ms of [50, 50, 50, 50, 50, 50, 50, 50, 50, 900]) {
      w = pushClickLatencySample(w, ms);
    }
    expect(maxClickLatency(w)).toBe(900);
    // Push enough samples to push 900 off the window.
    for (let i = 0; i < CLICK_LATENCY_WINDOW_SIZE; i += 1) {
      w = pushClickLatencySample(w, 60);
    }
    expect(w).not.toContain(900);
    expect(maxClickLatency(w)).toBe(60);
  });
});

describe('p95ClickLatency', () => {
  it('returns null for empty input', () => {
    expect(p95ClickLatency([])).toBeNull();
  });

  it('returns the sole element for a one-sample window', () => {
    expect(p95ClickLatency([42])).toBe(42);
  });

  it('does not mutate the input', () => {
    const win = [3, 1, 7, 2];
    p95ClickLatency(win);
    expect(win).toEqual([3, 1, 7, 2]);
  });

  it('lands on the worst sample for the default 10-sample window (nearest-rank)', () => {
    // ceil(0.95 * 10) - 1 = 9 -> last sorted index, so a full window's p95
    // equals its max; this is intentional for short windows.
    const w = [50, 50, 50, 50, 50, 50, 50, 50, 50, 900];
    expect(p95ClickLatency(w)).toBe(900);
    expect(p95ClickLatency(w)).toBe(maxClickLatency(w));
  });

  it('ignores a lone 1-in-20 spike but catches the worst 5% at N=20', () => {
    // ceil(0.95 * 20) - 1 = 18 -> second-worst slot. One spike among 20
    // sits at index 19 and is excluded; two spikes reach index 18.
    const oneSpike = [...Array(19).fill(10), 100];
    expect(p95ClickLatency(oneSpike)).toBe(10);
    const twoSpikes = [...Array(18).fill(10), 100, 100];
    expect(p95ClickLatency(twoSpikes)).toBe(100);
  });

  it('sits between median and max (almost-worst-case)', () => {
    const w = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const median = medianClickLatency(w)!;
    const p95 = p95ClickLatency(w)!;
    const max = maxClickLatency(w)!;
    expect(p95).toBeGreaterThanOrEqual(median);
    expect(p95).toBeLessThanOrEqual(max);
  });
});

describe('medianClickLatency', () => {
  it('returns null for empty input', () => {
    expect(medianClickLatency([])).toBeNull();
  });

  it('returns the sole element for a one-sample window', () => {
    expect(medianClickLatency([42])).toBe(42);
  });

  it('returns the middle element for odd-length windows', () => {
    expect(medianClickLatency([3, 1, 2])).toBe(2);
    expect(medianClickLatency([10, 20, 30, 40, 50])).toBe(30);
  });

  it('averages the two middle elements for even-length windows', () => {
    expect(medianClickLatency([1, 2, 3, 4])).toBe(2.5);
    expect(medianClickLatency([10, 30])).toBe(20);
  });

  it('does not mutate the input', () => {
    const win = [5, 1, 3];
    medianClickLatency(win);
    expect(win).toEqual([5, 1, 3]);
  });
});

// ---------------------------------------------------------------------------
// Budget constants + summarizeClickLatencyRun
// ---------------------------------------------------------------------------

describe('click-latency budget constants', () => {
  it('median budget is 80 ms (Invariant 7)', () => {
    expect(V1_F2_BUDGET_MEDIAN_MS).toBe(80);
  });

  it('max budget is 120 ms (Invariant 7)', () => {
    expect(V1_F2_BUDGET_MAX_MS).toBe(120);
  });
});

describe('summarizeClickLatencyRun', () => {
  it('formats an empty run as 0 samples', () => {
    const text = summarizeClickLatencyRun([], 'BasicHouse');
    expect(text).toContain('samples: 0');
    expect(text).toContain('BasicHouse');
    expect(text).toContain('no measurements');
  });

  it('formats a passing run with checkmarks', () => {
    // 30 samples all under budget - median ≈ 50, max = 70
    const samples = Array.from({ length: 30 }, (_, i) => 30 + i);
    const text = summarizeClickLatencyRun(samples);
    expect(text).toContain('samples: 30');
    expect(text).toContain('median:');
    expect(text).toContain('max: 59 ms');
    expect(text).toContain('✓');
    expect(text).not.toContain('✗');
  });

  it('marks median over budget with ✗', () => {
    // Every sample 100 ms - median 100, over 80 ms budget
    const samples = Array.from({ length: 20 }, () => 100);
    const text = summarizeClickLatencyRun(samples);
    expect(text).toContain('median: 100 ms');
    expect(text).toContain('median ≤ 80 ms ✗');
  });

  it('marks max over budget with ✗', () => {
    // Median 50, one outlier at 200 → max ✗ but median ✓
    const samples = [...Array.from({ length: 19 }, () => 50), 200];
    const text = summarizeClickLatencyRun(samples);
    expect(text).toContain('median ≤ 80 ms ✓');
    expect(text).toContain('max ≤ 120 ms ✗');
  });

  it('uses the provided label in the summary header', () => {
    const text = summarizeClickLatencyRun([50, 60, 70], 'model_77.ifc');
    expect(text).toContain('## model_77.ifc');
  });

  it('defaults the label to BasicHouse when omitted', () => {
    const text = summarizeClickLatencyRun([50, 60, 70]);
    expect(text).toContain('## BasicHouse');
  });
});

describe('computeRange', () => {
  it('returns the sentinel range for empty input so callers never divide by zero', () => {
    expect(computeRange([])).toEqual({ min: 0, max: 1 });
  });

  it('returns the sentinel range when every value is non-finite', () => {
    expect(computeRange([NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])).toEqual({
      min: 0,
      max: 1,
    });
  });

  it('computes the literal min/max for varied input', () => {
    expect(computeRange([10, 25, 5, 18])).toEqual({ min: 5, max: 25 });
  });

  it('pads a flat series by max(1, |v|*0.1) so the line sits mid-canvas', () => {
    expect(computeRange([100, 100, 100])).toEqual({ min: 90, max: 110 });
    // Tiny values fall back to the 1-unit floor.
    expect(computeRange([2, 2])).toEqual({ min: 1, max: 3 });
  });

  it('ignores non-finite values when other finite samples exist', () => {
    expect(computeRange([5, NaN, 15])).toEqual({ min: 5, max: 15 });
  });
});

describe('projectPoints', () => {
  it('returns no points for empty input', () => {
    expect(projectPoints([], 100, 50, 4)).toEqual([]);
  });

  it('maps a single sample to the canvas centre', () => {
    const pts = projectPoints([50], 100, 50, 4);
    expect(pts).toHaveLength(1);
    expect(pts[0].x).toBe(4); // padding only - no stepX with n=1
    // y is the centre because the flat-series range pads to ±10% so 50 lands mid-canvas.
    expect(pts[0].y).toBeCloseTo(25, 5);
  });

  it('spreads N samples evenly across the inner width', () => {
    const pts = projectPoints([10, 20, 30], 100, 50, 10);
    expect(pts).toHaveLength(3);
    // innerW = 100 - 20 = 80 → step = 40
    expect(pts[0].x).toBe(10);
    expect(pts[1].x).toBe(50);
    expect(pts[2].x).toBe(90);
  });

  it('inverts the y-axis (max value maps near the top)', () => {
    const pts = projectPoints([10, 20], 100, 50, 10);
    // innerH = 30; y_max-value = padding + 30*(1-1) = 10 (top)
    //          y_min-value = padding + 30*(1-0) = 40 (bottom)
    expect(pts[0].y).toBeCloseTo(40, 5);
    expect(pts[1].y).toBeCloseTo(10, 5);
  });

  it('clamps non-finite values to the y-range minimum instead of producing NaN', () => {
    const pts = projectPoints([10, NaN, 30], 100, 50, 10);
    expect(pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    // NaN sample sits at the baseline (same y as min-value sample).
    expect(pts[1].y).toBeCloseTo(pts[0].y, 5);
  });

  it('survives zero/negative canvas dimensions without producing NaN', () => {
    const pts = projectPoints([1, 2, 3], 0, 0, 0);
    expect(pts).toHaveLength(3);
    expect(pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  });

  it('honours an explicit range so callers can share a y-axis across siblings', () => {
    const pts = projectPoints([10, 20], 100, 50, 10, { min: 0, max: 40 });
    // value 10 in range 0..40 → yNorm 0.25 → y = 10 + 30*(1-0.25) = 32.5
    expect(pts[0].y).toBeCloseTo(32.5, 5);
    expect(pts[1].y).toBeCloseTo(25, 5);
  });
});

describe('buildSparklinePath', () => {
  it('returns empty string for empty input so callers can skip the SVG render', () => {
    expect(buildSparklinePath([])).toBe('');
  });

  it('draws a 3px-wide horizontal tick for single-point input', () => {
    const d = buildSparklinePath([{ x: 10, y: 20 }]);
    expect(d).toBe('M 8.50 20.00 L 11.50 20.00');
  });

  it('emits an M-then-L sequence for multi-point input with 2-decimal coords', () => {
    const d = buildSparklinePath([
      { x: 1, y: 2 },
      { x: 3.123, y: 4 },
      { x: 5, y: 6.987 },
    ]);
    expect(d).toBe('M 1.00 2.00 L 3.12 4.00 L 5.00 6.99');
  });
});

describe('buildSparklineAreaPath', () => {
  it('returns empty string for empty input', () => {
    expect(buildSparklineAreaPath([], 50)).toBe('');
  });

  it('closes the polyline along the baseline so the fill is a watertight polygon', () => {
    const d = buildSparklineAreaPath(
      [
        { x: 0, y: 10 },
        { x: 10, y: 5 },
        { x: 20, y: 15 },
      ],
      30,
    );
    // Polyline → line down to baseline at last x → line across to first x at baseline → Z
    expect(d).toBe('M 0.00 10.00 L 10.00 5.00 L 20.00 15.00 L 20.00 30.00 L 0.00 30.00 Z');
  });
});

describe('summariseValues', () => {
  it('returns null for empty / all-non-finite input so labels can hide', () => {
    expect(summariseValues([])).toBeNull();
    expect(summariseValues([NaN, Infinity])).toBeNull();
  });

  it('returns {min, avg, max, count} ignoring non-finite values', () => {
    const s = summariseValues([10, 20, NaN, 30]);
    expect(s).toEqual({ min: 10, avg: 20, max: 30, count: 3 });
  });

  it('handles a single sample (min = avg = max)', () => {
    expect(summariseValues([42])).toEqual({ min: 42, avg: 42, max: 42, count: 1 });
  });

  it('handles negative values without flipping min/max', () => {
    expect(summariseValues([-30, -10, -20])).toEqual({
      min: -30,
      max: -10,
      avg: -20,
      count: 3,
    });
  });
});

describe('orderSamplesOldestFirst', () => {
  it('returns a new array, leaving the input untouched (matches Zustand snapshot expectations)', () => {
    const input = [{ ts: 3 }, { ts: 2 }, { ts: 1 }];
    const out = orderSamplesOldestFirst(input);
    expect(out).not.toBe(input);
    expect(input).toEqual([{ ts: 3 }, { ts: 2 }, { ts: 1 }]); // input untouched
    expect(out).toEqual([{ ts: 1 }, { ts: 2 }, { ts: 3 }]);
  });

  it('returns empty array for empty input (sparkline short-circuits to hidden state)', () => {
    expect(orderSamplesOldestFirst([])).toEqual([]);
  });

  it('returns a 1-element copy unchanged (single sample is its own oldest)', () => {
    const input = [{ ts: 99, label: 'only' }];
    const out = orderSamplesOldestFirst(input);
    expect(out).toEqual([{ ts: 99, label: 'only' }]);
    expect(out).not.toBe(input);
  });

  it('reverses the perf-log storage convention (samples[0] = newest, samples[N-1] = oldest)', () => {
    // Mirrors the actual ViewerPanel writer: unshift({ts, source, ttfrMs, ...})
    const stored = [
      { ts: 300, ttfrMs: 1500 }, // newest in storage
      { ts: 200, ttfrMs: 800 },
      { ts: 100, ttfrMs: 1200 }, // oldest in storage
    ];
    const display = orderSamplesOldestFirst(stored);
    // Sparkline reads left→right as time, so display[0] must be the oldest.
    expect(display.map((s) => s.ts)).toEqual([100, 200, 300]);
    expect(display.map((s) => s.ttfrMs)).toEqual([1200, 800, 1500]);
  });

  it('is stable for an already-sorted input under repeated application (idempotent shape)', () => {
    const input = [1, 2, 3, 4];
    const once = orderSamplesOldestFirst(input);
    const twice = orderSamplesOldestFirst(once);
    expect(once).toEqual([4, 3, 2, 1]);
    expect(twice).toEqual([1, 2, 3, 4]); // back to original - confirms it's a true reverse
  });
});

describe('renderStatsSnapshot', () => {
  beforeEach(() => {
    resetMainPassStats();
  });

  it('starts empty: no frame recorded, never fresh', () => {
    const snap = getMainPassStats();
    expect(snap.frame).toBe(0);
    expect(snap.drawCalls).toBe(0);
    expect(snap.triangles).toBe(0);
    expect(isMainPassFresh(1000, 60000)).toBe(false);
  });

  it('records main-pass counts with the overlay subtracted', () => {
    // 131 total calls with a 9-call / 72-tri gizmo overlay = 122 main calls
    // (the BasicHouse shape of the original bug).
    recordMainPass(131, 582135, 9, 72, 500);
    const snap = getMainPassStats();
    expect(snap.frame).toBe(1);
    expect(snap.drawCalls).toBe(122);
    expect(snap.triangles).toBe(582063);
    expect(snap.recordedAt).toBe(500);
  });

  it('overwrites in place on subsequent frames and counts them', () => {
    const snap = getMainPassStats();
    recordMainPass(131, 582135, 9, 72, 500);
    recordMainPass(140, 600000, 9, 72, 516);
    // Same object rewritten each frame - the consumer contract that makes
    // the recorder zero-allocation.
    expect(getMainPassStats()).toBe(snap);
    expect(snap.frame).toBe(2);
    expect(snap.drawCalls).toBe(131);
    expect(snap.triangles).toBe(599928);
    expect(snap.recordedAt).toBe(516);
  });

  it('clamps negative results to zero instead of trusting bad accounting', () => {
    // Overlay larger than the total means a reset raced the capture.
    recordMainPass(5, 40, 9, 72, 100);
    const snap = getMainPassStats();
    expect(snap.drawCalls).toBe(0);
    expect(snap.triangles).toBe(0);
  });

  it('freshness is an inclusive age window from the last record', () => {
    recordMainPass(131, 582135, 9, 72, 1000);
    expect(isMainPassFresh(1000, 2000)).toBe(true);
    expect(isMainPassFresh(3000, 2000)).toBe(true); // exactly at the limit
    expect(isMainPassFresh(3001, 2000)).toBe(false);
  });

  it('reset clears the data and the freshness', () => {
    recordMainPass(131, 582135, 9, 72, 1000);
    resetMainPassStats();
    const snap = getMainPassStats();
    expect(snap.frame).toBe(0);
    expect(snap.drawCalls).toBe(0);
    expect(snap.triangles).toBe(0);
    expect(isMainPassFresh(1001, 60000)).toBe(false);
  });
});

describe('shouldContinueFrameSampling', () => {
  const policy = (elapsedMs: number, validSamples: number) =>
    shouldContinueFrameSampling({
      elapsedMs,
      requestedDurationMs: 2_000,
      validSamples,
      minimumSamples: 6,
      maximumDurationMs: 10_000,
    });

  it('keeps the requested duration as a hard minimum', () => {
    expect(policy(1_999, 100)).toBe(true);
  });

  it('continues beyond the duration until the sample floor is met', () => {
    expect(policy(2_100, 5)).toBe(true);
    expect(policy(2_100, 6)).toBe(false);
  });

  it('stops at the maximum-duration guard even with too few samples', () => {
    expect(policy(10_000, 1)).toBe(false);
  });
});

describe('summarizeFrameDeltas', () => {
  it('returns zeros for an empty window', () => {
    const s = summarizeFrameDeltas([]);
    expect(s.frames).toBe(0);
    expect(s.fps).toBe(0);
  });

  it('drops non-finite and non-positive samples', () => {
    const s = summarizeFrameDeltas([16, Number.NaN, -5, 0, Infinity, 16]);
    expect(s.frames).toBe(2);
    expect(s.avgMs).toBe(16);
  });

  it('computes percentiles with nearest-rank on a uniform stream', () => {
    const deltas = Array.from({ length: 100 }, () => 16.7);
    const s = summarizeFrameDeltas(deltas);
    expect(s.p50Ms).toBe(16.7);
    expect(s.p95Ms).toBe(16.7);
    expect(s.fps).toBeCloseTo(59.9, 0);
    expect(s.framesOver33Ms).toBe(0);
  });

  it('surfaces hitches in p95/worst and the over-33ms count', () => {
    const deltas = [...Array.from({ length: 95 }, () => 16), ...Array.from({ length: 5 }, () => 50)];
    const s = summarizeFrameDeltas(deltas);
    expect(s.p50Ms).toBe(16);
    expect(s.p95Ms).toBe(16);
    expect(s.worstMs).toBe(50);
    expect(s.framesOver33Ms).toBe(5);
  });
});
