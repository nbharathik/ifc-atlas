import { describe, expect, it } from 'vitest';

import { summarizeFrameDeltas } from '../frameTimeRecorder';

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
