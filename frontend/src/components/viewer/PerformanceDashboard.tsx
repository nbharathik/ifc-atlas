import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  buildSparklinePath,
  buildSparklineAreaPath,
  computeRange,
  orderSamplesOldestFirst,
  projectPoints,
  summariseValues,
} from '../../services/viewer/performanceSparklineHelpers';

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

function fmtMs(v: number | null): string {
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

export default function PerformanceDashboard({ onClose }: Props) {
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
                  ? `TTFR sparkline - ${spark.summary.count} samples, min ${fmtMs(
                      spark.summary.min,
                    )}, avg ${fmtMs(Math.round(spark.summary.avg))}, max ${fmtMs(spark.summary.max)}`
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
                    <title>{`${SOURCE_LABELS[ordered[i].source]} · ${fmtMs(ordered[i].ttfrMs)}`}</title>
                  </circle>
                ))}
              </svg>
              {spark.summary && (
                <div className="perf-dashboard-sparkline-axis">
                  <span title="Best TTFR in the window">
                    min <strong>{fmtMs(spark.summary.min)}</strong>
                  </span>
                  <span title="Average TTFR across the window">
                    avg <strong>{fmtMs(Math.round(spark.summary.avg))}</strong>
                  </span>
                  <span title="Worst TTFR in the window">
                    max <strong>{fmtMs(spark.summary.max)}</strong>
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
                  <td className="perf-cell-num">{fmtMs(s.ttfrMs)}</td>
                  <td className="perf-cell-num">{fmtMs(s.ttfgMs)}</td>
                  <td className="perf-cell-num">{fmtMs(s.loadMs)}</td>
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
                Avg TTFR: <strong>{fmtMs(Math.round(spark.summary.avg))}</strong>
              </span>
              <span>
                Best:{' '}
                <strong style={{ color: 'var(--green)' }}>{fmtMs(spark.summary.min)}</strong>
              </span>
              <span>
                Worst:{' '}
                <strong style={{ color: 'var(--acc)' }}>{fmtMs(spark.summary.max)}</strong>
              </span>
              <span className="perf-cell-dim">{spark.summary.count} samples (last 50)</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
