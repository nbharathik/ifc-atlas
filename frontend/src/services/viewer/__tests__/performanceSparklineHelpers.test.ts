import { describe, it, expect } from 'vitest';
import {
  computeRange,
  projectPoints,
  buildSparklinePath,
  buildSparklineAreaPath,
  orderSamplesOldestFirst,
  summariseValues,
} from '../performanceSparklineHelpers';

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
