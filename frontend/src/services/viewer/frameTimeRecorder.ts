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
