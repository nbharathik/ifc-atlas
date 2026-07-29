import { useEffect, useMemo, useRef, useState } from 'react';

import {
  advancePace,
  createPaceState,
  estimateExpectedTotal,
  formatEta,
  pathKindForSourceHint,
  presentLoadProgress,
  type LoadPathKind,
  type PaceState,
  VIEWER_PERF_LOG_STORAGE_KEY,
  type ViewerLoadProgress,
  type ViewerPerfLogEntry,
} from '../services/viewer/loadPipeline';
import { useStore } from '../store/useStore';

export interface LoadProgressPacer {
  loadPercent: number;
  loadBarPercent: number;
  loadCompact: boolean;
  loadEta: ReturnType<typeof formatEta>;
  loadPresentation: ReturnType<typeof presentLoadProgress>;
  loadElapsedSec: number | null;
}

/**
 * Presentation pacing for the load overlay.
 *
 * The displayed bar is monotonic (raw checkpoints regress on fallback paths),
 * never frozen (it drifts asymptotically toward the next checkpoint), and
 * time-weighted so long phases creep honestly instead of stalling. The expected
 * total comes from this machine's perf-log history with fixed priors as
 * fallback. The pacing loop only runs while the overlay is visible.
 */
export function useLoadProgressPacer(
  loadProgress: ViewerLoadProgress,
  loading: boolean,
): LoadProgressPacer {
  const [loadElapsedSec, setLoadElapsedSec] = useState<number | null>(null);
  const [displayProgress, setDisplayProgress] = useState<number>(loadProgress.progress);

  const paceRef = useRef<PaceState | null>(null);
  const targetProgressRef = useRef<number>(loadProgress.progress);
  targetProgressRef.current = loadProgress.progress;
  const expectedTotalRef = useRef<{ kind: LoadPathKind; ms: number; fromHistory: boolean }>({
    kind: 'unknown',
    ms: 25_000,
    fromHistory: false,
  });

  useEffect(() => {
    if (!loading) {
      setLoadElapsedSec(null);
      return;
    }
    const startedAt = Date.now();
    setLoadElapsedSec(0);
    const id = window.setInterval(() => {
      setLoadElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [loading]);

  const loadPathKind = pathKindForSourceHint(loadProgress.sourceHint);
  useEffect(() => {
    if (loadPathKind === 'unknown' || expectedTotalRef.current.kind === loadPathKind) return;
    let history: ViewerPerfLogEntry[] | null = null;
    try {
      history = JSON.parse(
        localStorage.getItem(VIEWER_PERF_LOG_STORAGE_KEY) ?? '[]',
      ) as ViewerPerfLogEntry[];
    } catch {
      history = null;
    }
    const estimate = estimateExpectedTotal(loadPathKind, history);
    expectedTotalRef.current = { kind: loadPathKind, ...estimate };
    if (paceRef.current) {
      paceRef.current = { ...paceRef.current, expectedTotalMs: estimate.ms };
    }
  }, [loadPathKind]);

  useEffect(() => {
    if (!loading) {
      paceRef.current = null;
      return;
    }
    let rafId = 0;
    let lastTs = performance.now();
    const tick = (now: number) => {
      const dt = Math.max(0, now - lastTs);
      lastTs = now;
      const previous = paceRef.current
        ?? createPaceState(targetProgressRef.current, expectedTotalRef.current.ms);
      const next = advancePace(previous, targetProgressRef.current, dt);
      paceRef.current = next;
      // Re-render at 0.1 pct granularity - finer is sub-pixel on the bar.
      if (Math.round(next.display * 10) !== Math.round(previous.display * 10)) {
        setDisplayProgress(next.display);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [loading]);

  // Snap to 100 without easing so completion lands cleanly. No snap on low
  // values: fallback branches re-report low checkpoints and the bar must never
  // jump backwards.
  useEffect(() => {
    if (loadProgress.progress >= 100) {
      paceRef.current = paceRef.current
        ? { ...paceRef.current, anchor: 100, display: 100 }
        : createPaceState(100, expectedTotalRef.current.ms);
      setDisplayProgress(100);
    }
  }, [loadProgress.progress]);

  const projectName = useStore((s) => s.project?.name ?? null);
  const serverCachePref = useStore((s) => s.useServerCache);
  const loadPresentation = useMemo(() => {
    const bytes = useStore.getState().ifcFileBytes;
    return presentLoadProgress(loadProgress, {
      fileName: projectName,
      fileSizeMB: bytes ? bytes.byteLength / (1024 * 1024) : null,
      cachesEnabled: serverCachePref,
    });
  }, [loadProgress, projectName, serverCachePref]);

  const loadEta = loadElapsedSec == null
    ? { text: null, overrun: false }
    : formatEta(
      loadElapsedSec * 1000,
      expectedTotalRef.current.ms,
      expectedTotalRef.current.fromHistory,
    );

  const loadPercent = Math.round(Math.max(0, Math.min(100, displayProgress)));

  return {
    loadPercent,
    loadBarPercent: Math.max(6, loadPercent),
    // Once the first frame is on screen the pill collapses to a compact chip so
    // the user watches their model, not the loader.
    loadCompact: loadProgress.progress >= 96,
    loadEta,
    loadPresentation,
    loadElapsedSec,
  };
}
