import { useCallback, useLayoutEffect, useRef } from 'react';
import { useStore } from '../../store/useStore';
import type { PerfMetrics } from '../../store/useStore';
import {
  clickLatencyColor,
  formatClickLatency,
} from '../../services/viewer/clickLatencyHelpers';

function fmtMs(v: number | null): string {
  if (v == null) return '-';
  if (v < 1000) return `${v.toFixed(0)} ms`;
  return `${(v / 1000).toFixed(2)} s`;
}

function fmtMem(v: number | null): string {
  if (v == null) return '-';
  if (v > 1024) return `${(v / 1024).toFixed(2)} GB`;
  return `${v.toFixed(0)} MB`;
}

function fpsColor(fps: number): string {
  if (fps >= 50) return 'var(--success)';
  if (fps >= 30) return 'var(--warning)';
  return 'var(--danger)';
}

/** ≤150 = green (on target); 150-300 = yellow (watch); >300 = red (budget blown). */
function drawCallColor(n: number): string {
  if (n <= 150) return 'var(--success)';
  if (n <= 300) return 'var(--warning)';
  return 'var(--danger)';
}

export default function PerformanceHud() {
  const visible = useStore((s) => s.perfHudVisible);
  const setVisible = useStore((s) => s.setPerfHudVisible);
  // `stats` is set once per model load (low frequency) so it stays a render
  // subscription. `perfMetrics` is the per-frame hot source and is read ONLY
  // transiently below; it must never appear in the render path or a `stats`
  // commit would clobber the imperative DOM writes with a stale snapshot.
  const stats = useStore((s) => s.stats);

  // Imperative targets for the perfMetrics-driven chips. Updating these via a
  // transient useStore.subscribe (textContent / style.color) instead of a
  // render subscription means the HUD commits zero React renders per frame
  // while open; only `stats` / `visible` changes trigger a real re-render.
  // Same pattern the viewer's selection/highlight scheduler bridges use.
  const fpsValRef = useRef<HTMLSpanElement>(null);
  const memValRef = useRef<HTMLSpanElement>(null);
  const drawCallsValRef = useRef<HTMLSpanElement>(null);
  const trianglesValRef = useRef<HTMLSpanElement>(null);
  const culledStoreysRowRef = useRef<HTMLDivElement>(null);
  const culledStoreysValRef = useRef<HTMLSpanElement>(null);
  const culledElementsRowRef = useRef<HTMLDivElement>(null);
  const culledElementsValRef = useRef<HTMLSpanElement>(null);
  const ttfrValRef = useRef<HTMLSpanElement>(null);
  const loadValRef = useRef<HTMLSpanElement>(null);
  const clickValRef = useRef<HTMLSpanElement>(null);
  const medianRowRef = useRef<HTMLDivElement>(null);
  const medianValRef = useRef<HTMLSpanElement>(null);
  const p95RowRef = useRef<HTMLDivElement>(null);
  const p95ValRef = useRef<HTMLSpanElement>(null);
  const maxRowRef = useRef<HTMLDivElement>(null);
  const maxValRef = useRef<HTMLSpanElement>(null);

  // Single writer shared by the initial layout-effect paint and the transient
  // subscription so the two formatting paths can never diverge. Conditional
  // rows toggle `display` rather than mount/unmount (they live permanently in
  // the DOM so the subscription can flip them without a React commit).
  const applyMetrics = useCallback((m: PerfMetrics) => {
    if (fpsValRef.current) {
      fpsValRef.current.textContent = m.fps.toFixed(0);
      fpsValRef.current.style.color = fpsColor(m.fps);
    }
    if (memValRef.current) memValRef.current.textContent = fmtMem(m.memoryMb);
    if (drawCallsValRef.current) {
      drawCallsValRef.current.textContent = m.drawCalls.toLocaleString();
      drawCallsValRef.current.style.color = drawCallColor(m.drawCalls);
    }
    if (trianglesValRef.current) {
      trianglesValRef.current.textContent = m.triangles.toLocaleString();
    }
    if (culledStoreysRowRef.current) {
      culledStoreysRowRef.current.style.display = m.culledStoreys > 0 ? '' : 'none';
    }
    if (culledStoreysValRef.current) {
      culledStoreysValRef.current.textContent = String(m.culledStoreys);
    }
    if (culledElementsRowRef.current) {
      culledElementsRowRef.current.style.display = m.culledElements > 0 ? '' : 'none';
    }
    if (culledElementsValRef.current) {
      culledElementsValRef.current.textContent = String(m.culledElements);
    }
    if (ttfrValRef.current) ttfrValRef.current.textContent = fmtMs(m.ttfrMs);
    if (loadValRef.current) loadValRef.current.textContent = fmtMs(m.loadMs);
    if (clickValRef.current) {
      clickValRef.current.textContent = formatClickLatency(m.clickToHighlightMs);
      clickValRef.current.style.color = clickLatencyColor(m.clickToHighlightMs);
    }
    if (medianRowRef.current) {
      medianRowRef.current.style.display = m.clickToHighlightMedianMs != null ? '' : 'none';
    }
    if (medianValRef.current) {
      medianValRef.current.textContent = formatClickLatency(m.clickToHighlightMedianMs);
      medianValRef.current.style.color = clickLatencyColor(m.clickToHighlightMedianMs);
    }
    if (p95RowRef.current) {
      p95RowRef.current.style.display = m.clickToHighlightP95Ms != null ? '' : 'none';
    }
    if (p95ValRef.current) {
      p95ValRef.current.textContent = formatClickLatency(m.clickToHighlightP95Ms);
      p95ValRef.current.style.color = clickLatencyColor(m.clickToHighlightP95Ms);
    }
    if (maxRowRef.current) {
      maxRowRef.current.style.display = m.clickToHighlightMaxMs != null ? '' : 'none';
    }
    if (maxValRef.current) {
      maxValRef.current.textContent = formatClickLatency(m.clickToHighlightMaxMs);
      maxValRef.current.style.color = clickLatencyColor(m.clickToHighlightMaxMs);
    }
  }, []);

  // Layout effect (not plain effect) so the first paint of the value spans
  // lands before the browser paints; otherwise the chips would flash empty
  // for one frame each time the HUD opens. Dep `[visible]` re-arms the
  // subscription on every open; the early `return null` below unmounts it.
  useLayoutEffect(() => {
    if (!visible) return;
    applyMetrics(useStore.getState().perfMetrics);
    const unsub = useStore.subscribe((s) => s.perfMetrics, applyMetrics);
    return unsub;
  }, [visible, applyMetrics]);

  if (!visible) return null;

  return (
    <div className="perf-hud" title="Performance metrics (M to toggle)">
      <div className="perf-hud-header">
        <span>Performance</span>
        <button
          className="perf-hud-close"
          onClick={() => setVisible(false)}
          title="Hide performance HUD (M)"
        >
          &times;
        </button>
      </div>
      <div className="perf-hud-body">
        <div className="perf-row">
          <span className="perf-label">FPS</span>
          <span className="perf-value" ref={fpsValRef} />
        </div>
        <div className="perf-row">
          <span className="perf-label">Memory</span>
          <span className="perf-value" ref={memValRef} />
        </div>
        <div className="perf-row">
          <span className="perf-label">Draw calls</span>
          <span className="perf-value" ref={drawCallsValRef} />
        </div>
        <div className="perf-row">
          <span className="perf-label">Triangles</span>
          <span className="perf-value" ref={trianglesValRef} />
        </div>
        <div className="perf-row" ref={culledStoreysRowRef}>
          <span className="perf-label">Culled storeys</span>
          <span
            className="perf-value"
            ref={culledStoreysValRef}
            style={{ color: 'var(--success)' }}
          />
        </div>
        <div className="perf-row" ref={culledElementsRowRef}>
          <span className="perf-label">Culled elements</span>
          <span
            className="perf-value"
            ref={culledElementsValRef}
            style={{ color: 'var(--success)' }}
          />
        </div>
        <div className="perf-row">
          <span className="perf-label">TTFR</span>
          <span className="perf-value" ref={ttfrValRef} />
        </div>
        <div className="perf-row">
          <span className="perf-label">Load time</span>
          <span className="perf-value" ref={loadValRef} />
        </div>
        <div
          className="perf-row"
          title="Click → highlight round trip (budget: ≤ 50 ms typical)"
        >
          <span className="perf-label">Click → highlight</span>
          <span className="perf-value" ref={clickValRef} />
        </div>
        <div
          className="perf-row"
          ref={medianRowRef}
          title="Rolling median of the last 10 click → highlight samples (the steadier number)"
        >
          <span className="perf-label">↳ median (10)</span>
          <span className="perf-value" ref={medianValRef} />
        </div>
        <div
          className="perf-row"
          ref={p95RowRef}
          title="Rolling p95 of the last 10 click → highlight samples (budget ≤ 80 ms)"
        >
          <span className="perf-label">↳ p95 (10)</span>
          <span className="perf-value" ref={p95ValRef} />
        </div>
        <div
          className="perf-row"
          ref={maxRowRef}
          title="Worst click → highlight sample in the last 10 - spots one-off spikes the median hides"
        >
          <span className="perf-label">↳ max (10)</span>
          <span className="perf-value" ref={maxValRef} />
        </div>
        {stats && (
          <div className="perf-row">
            <span className="perf-label">Elements</span>
            <span className="perf-value">{stats.total_elements.toLocaleString()}</span>
          </div>
        )}
      </div>
    </div>
  );
}
