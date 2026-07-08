import { describe, it, expect } from 'vitest';
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
} from '../clickLatencyHelpers';

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
