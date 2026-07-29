import { useCallback, useLayoutEffect, useRef, useState, useEffect, useMemo } from 'react';
import { useStore, type PerfMetrics } from '../../store/useStore';
import {
  clickLatencyColor,
  formatClickLatency,
  buildSparklinePath,
  buildSparklineAreaPath,
  computeRange,
  orderSamplesOldestFirst,
  projectPoints,
  summariseValues,
} from '../../services/viewer/perfStats';

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

export function PerformanceHud() {
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

interface PerfSample {
  ts: number;
  source: 'ifc-parse' | 'fragments-cache' | 'server-convert' | 'server-cache';
  ttfrMs: number;
  ttfgMs: number;
  loadMs: number | null;
}

const SPARK_WIDTH = 480;
const SPARK_HEIGHT = 56;
const SPARK_PADDING = 6;

const PERF_LOG_KEY = 'ifc-viewer-perf-log';

const SOURCE_LABELS: Record<PerfSample['source'], string> = {
  'ifc-parse': 'Live parse',
  'fragments-cache': 'Local cache',
  'server-convert': 'Server convert',
  'server-cache': 'Server cache',
};

const SOURCE_COLORS: Record<PerfSample['source'], string> = {
  'ifc-parse': 'var(--acc)',
  'fragments-cache': 'var(--green)',
  'server-convert': 'var(--blue)',
  'server-cache': 'var(--green)',
};

function fmtMsWhole(v: number | null): string {
  if (v == null) return '-';
  if (v < 1000) return `${v} ms`;
  return `${(v / 1000).toFixed(2)} s`;
}

function fmtDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function ttfrBar(ms: number, maxMs: number): string {
  const pct = Math.min((ms / maxMs) * 100, 100);
  return `${pct.toFixed(1)}%`;
}

interface Props {
  onClose: () => void;
}

export function PerformanceDashboard({ onClose }: Props) {
  const [samples, setSamples] = useState<PerfSample[]>([]);

  const reload = useCallback(() => {
    try {
      const raw = localStorage.getItem(PERF_LOG_KEY);
      if (raw) setSamples(JSON.parse(raw) as PerfSample[]);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    reload();
    const handler = () => reload();
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, [reload]);

  const clearLog = useCallback(() => {
    localStorage.removeItem(PERF_LOG_KEY);
    setSamples([]);
  }, []);

  // Sparkline reads left-to-right as time; storage is newest-first so we
  // reverse for projection. The table below keeps newest-on-top because
  // that's the natural log-table convention.
  const ordered = useMemo(() => orderSamplesOldestFirst(samples), [samples]);

  // Pre-computed sparkline geometry. useMemo because the polyline + per-point
  // projection re-run on every sample-set change but never on hover / pointer
  // events. Empty `ordered` short-circuits to null so the SVG block is hidden
  // by the empty-state branch above.
  const spark = useMemo(() => {
    if (ordered.length === 0) return null;
    const values = ordered.map((s) => s.ttfrMs);
    const range = computeRange(values);
    const points = projectPoints(values, SPARK_WIDTH, SPARK_HEIGHT, SPARK_PADDING, range);
    const linePath = buildSparklinePath(points);
    const areaPath = buildSparklineAreaPath(points, SPARK_HEIGHT - SPARK_PADDING);
    const summary = summariseValues(values);
    return { points, linePath, areaPath, summary };
  }, [ordered]);

  // Shared across the table's per-row bar and the footer stats; using the
  // memoised summary avoids the `Math.max(...arr)` spread (stack-overflow risk
  // on large arrays even though the writer caps at 50) and removes the
  // duplicate avg / min / max passes the footer used to make.
  const maxTtfr = spark?.summary?.max ?? 1;

  return (
    <div className="perf-dashboard" role="dialog" aria-label="Performance history">
      <div className="perf-dashboard-header">
        <span className="perf-dashboard-title">Load Performance History</span>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <button
            className="btn-icon"
            title="Refresh"
            onClick={reload}
            style={{ fontSize: 13 }}
          >
            ↻
          </button>
          <button
            className="btn-icon"
            title="Clear history"
            onClick={clearLog}
            style={{ fontSize: 13 }}
          >
            &#x1F5D1;
          </button>
          <button
            className="btn-icon"
            title="Close"
            onClick={onClose}
            style={{ fontSize: 13 }}
          >
            &times;
          </button>
        </div>
      </div>

      {samples.length === 0 ? (
        <div className="perf-dashboard-empty">
          No load samples yet. Load an IFC file to record performance.
        </div>
      ) : (
        <div className="perf-dashboard-body">
          <div className="perf-dashboard-legend">
            {(Object.keys(SOURCE_LABELS) as PerfSample['source'][]).map((src) => (
              <span key={src} className="perf-dashboard-legend-item">
                <span
                  className="perf-dashboard-legend-dot"
                  style={{ background: SOURCE_COLORS[src] }}
                />
                {SOURCE_LABELS[src]}
              </span>
            ))}
          </div>

          {spark && (
            <div
              className="perf-dashboard-sparkline"
              aria-label={
                spark.summary
                  ? `TTFR sparkline - ${spark.summary.count} samples, min ${fmtMsWhole(
                      spark.summary.min,
                    )}, avg ${fmtMsWhole(Math.round(spark.summary.avg))}, max ${fmtMsWhole(spark.summary.max)}`
                  : 'TTFR sparkline'
              }
            >
              <div className="perf-dashboard-sparkline-title">TTFR trend (oldest → newest)</div>
              <svg
                viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
                preserveAspectRatio="none"
                width="100%"
                height={SPARK_HEIGHT}
                role="img"
                aria-labelledby="perf-sparkline-title"
              >
                {/* SVG <title> is the spec-mandated accessible name for role=img;
                    the wrapper aria-label gives the same string to SRs that read
                    the parent first, but the inner title is the canonical anchor. */}
                <title id="perf-sparkline-title">TTFR trend, oldest to newest</title>
                {/* Soft fill under the line so the visual weight reads as a trend, not a thread. */}
                <path d={spark.areaPath} fill="var(--blue)" fillOpacity={0.12} />
                <path
                  d={spark.linePath}
                  fill="none"
                  stroke="var(--blue)"
                  strokeWidth={1.5}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                {/* Per-sample dots colored by source so the user can see at a glance
                    which load path produced which spike. Indices match `ordered`
                    (oldest-first), not the newest-first storage array. */}
                {spark.points.map((p, i) => (
                  <circle
                    key={i}
                    cx={p.x}
                    cy={p.y}
                    r={2.2}
                    fill={SOURCE_COLORS[ordered[i].source]}
                  >
                    <title>{`${SOURCE_LABELS[ordered[i].source]} · ${fmtMsWhole(ordered[i].ttfrMs)}`}</title>
                  </circle>
                ))}
              </svg>
              {spark.summary && (
                <div className="perf-dashboard-sparkline-axis">
                  <span title="Best TTFR in the window">
                    min <strong>{fmtMsWhole(spark.summary.min)}</strong>
                  </span>
                  <span title="Average TTFR across the window">
                    avg <strong>{fmtMsWhole(Math.round(spark.summary.avg))}</strong>
                  </span>
                  <span title="Worst TTFR in the window">
                    max <strong>{fmtMsWhole(spark.summary.max)}</strong>
                  </span>
                </div>
              )}
            </div>
          )}

          <table className="perf-dashboard-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Source</th>
                <th>TTFR</th>
                <th>TTFG</th>
                <th>Total load</th>
                <th style={{ width: 120 }}>TTFR bar</th>
              </tr>
            </thead>
            <tbody>
              {samples.map((s, i) => (
                <tr key={i}>
                  <td className="perf-cell-dim">{fmtDate(s.ts)}</td>
                  <td>
                    <span
                      className="perf-dashboard-badge"
                      style={{ background: SOURCE_COLORS[s.source] }}
                    >
                      {SOURCE_LABELS[s.source]}
                    </span>
                  </td>
                  <td className="perf-cell-num">{fmtMsWhole(s.ttfrMs)}</td>
                  <td className="perf-cell-num">{fmtMsWhole(s.ttfgMs)}</td>
                  <td className="perf-cell-num">{fmtMsWhole(s.loadMs)}</td>
                  <td>
                    <div className="perf-bar-track">
                      <div
                        className="perf-bar-fill"
                        style={{
                          width: ttfrBar(s.ttfrMs, maxTtfr),
                          background: SOURCE_COLORS[s.source],
                        }}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {spark?.summary && spark.summary.count > 1 && (
            <div className="perf-dashboard-stats">
              <span>
                Avg TTFR: <strong>{fmtMsWhole(Math.round(spark.summary.avg))}</strong>
              </span>
              <span>
                Best:{' '}
                <strong style={{ color: 'var(--green)' }}>{fmtMsWhole(spark.summary.min)}</strong>
              </span>
              <span>
                Worst:{' '}
                <strong style={{ color: 'var(--acc)' }}>{fmtMsWhole(spark.summary.max)}</strong>
              </span>
              <span className="perf-cell-dim">{spark.summary.count} samples (last 50)</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
