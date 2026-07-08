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
