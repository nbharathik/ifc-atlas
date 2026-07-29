import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../store/useStore';
import { BROWSER_ONLY } from '../../config/featureFlags';
import Icon from '../ui/Icon';
import { apiUrl } from '../../lib/platform';
import './cobiePanel.css';

/**
 * COBie data-handover panel (docked in the Tools tab). Shows sheet counts +
 * handover completeness, with a one-click COBie-lite CSV export. Read-only;
 * embedded-native (fills .tool-embed-body).
 */
export default function CobiePanel(_props: { embedded?: boolean; onClose?: () => void }) {
  const modelLoaded = useStore((s) => s.modelLoaded);
  const [summary, setSummary] = useState<CobieSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const canFetch = modelLoaded && !BROWSER_ONLY;

  const load = useCallback(async () => {
    if (!canFetch) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchCobieSummary();
      if (seq !== requestSeq.current) return;
      setSummary(res);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setError(e instanceof Error ? e.message : 'COBie summary failed');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [canFetch]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!modelLoaded) {
      setSummary(null);
      setError(null);
    }
  }, [modelLoaded]);

  const handleExport = useCallback(() => {
    const anchor = document.createElement('a');
    anchor.href = cobieCsvUrl();
    anchor.download = 'cobie.csv';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }, []);

  if (BROWSER_ONLY) {
    return <p className="cobie-panel-empty">This feature needs the desktop backend.</p>;
  }

  return (
    <div className="cobie-panel" role="region" aria-label="COBie handover">
      <div className="cobie-panel-toolbar">
        <span className="cobie-panel-title">Data handover (COBie)</span>
        <div className="cobie-panel-actions">
          <button className="cobie-panel-btn" onClick={handleExport} disabled={!summary}>
            Export CSV
          </button>
          <button
            className="cobie-panel-btn cobie-panel-btn--icon"
            onClick={() => void load()}
            disabled={loading || !canFetch}
            title="Refresh"
            aria-label="Refresh COBie summary"
          >
            <Icon name="refresh" size={13} />
          </button>
        </div>
      </div>

      <div className="cobie-panel-body">
        {!modelLoaded ? (
          <p className="cobie-panel-empty">Load an IFC model first.</p>
        ) : error ? (
          <div className="cobie-panel-error" role="alert">
            <span>{error}</span>
            <button className="cobie-panel-btn" onClick={() => void load()}>
              Retry
            </button>
          </div>
        ) : loading && !summary ? (
          <p className="cobie-panel-quiet">Reading model...</p>
        ) : summary ? (
          <>
            <div className="cobie-panel-section-label">Sheets</div>
            <div className="cobie-panel-stats">
              {(
                [
                  ['Floors', summary.counts.floors],
                  ['Spaces', summary.counts.spaces],
                  ['Types', summary.counts.types],
                  ['Components', summary.counts.components],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="cobie-panel-stat">
                  <span className="cobie-panel-stat-value">{value.toLocaleString('en-US')}</span>
                  <span className="cobie-panel-stat-label">{label}</span>
                </div>
              ))}
            </div>

            <div className="cobie-panel-section-label">Handover completeness</div>
            <div className="cobie-panel-bars">
              {summary.completeness.map((item) => (
                <div key={item.label} className="cobie-panel-bar-row">
                  <div className="cobie-panel-bar-head">
                    <span className="cobie-panel-bar-label">{item.label}</span>
                    <span className="cobie-panel-bar-value">
                      {item.present}/{item.total} ({item.pct}%)
                    </span>
                  </div>
                  <div className="cobie-panel-bar-track">
                    <div
                      className={`cobie-panel-bar-fill${
                        item.pct >= 80
                          ? ' cobie-panel-bar-fill--good'
                          : item.pct >= 40
                            ? ' cobie-panel-bar-fill--mid'
                            : ' cobie-panel-bar-fill--low'
                      }`}
                      style={{ width: `${item.pct}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
            <p className="cobie-panel-caption">
              COBie-lite export: Facility, Floor, Space, Type and Component sheets as one CSV.
            </p>
          </>
        ) : (
          <p className="cobie-panel-empty">No data.</p>
        )}
      </div>
    </div>
  );
}

/**
 * COBie data-handover API client for the COBie panel.
 *
 * Backend contract:
 *   GET /api/cobie/summary     -> { counts, completeness }
 *   GET /api/cobie/export.csv  -> multi-section COBie-lite CSV download
 */

export interface CobieCounts {
  floors: number;
  spaces: number;
  types: number;
  components: number;
}

export interface CobieCompletenessItem {
  label: string;
  present: number;
  total: number;
  pct: number;
}

export interface CobieSummary {
  counts: CobieCounts;
  completeness: CobieCompletenessItem[];
}

export async function fetchCobieSummary(): Promise<CobieSummary> {
  const res = await fetch(apiUrl('/api/cobie/summary'));
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<CobieSummary>;
}

export function cobieCsvUrl(): string {
  return apiUrl('/api/cobie/export.csv');
}
