import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store/useStore';
import { BROWSER_ONLY } from '../../config/featureFlags';
import Icon from '../ui/Icon';
import { apiUrl } from '../../lib/platform';
import './diffPanel.css';

/**
 * Working-vs-original diff panel (docked in the Tools tab). Shows what changed
 * since the model was uploaded: added / removed / changed elements. Added and
 * changed elements are highlightable in the viewer (they exist in the working
 * model); removed elements are listed only (they are gone from the model).
 * Embedded-native.
 */
export default function DiffPanel(_props: { embedded?: boolean; onClose?: () => void }) {
  const { modelLoaded, selectElement, setHighlightedIds, clearVisibility, frameElementsFn } =
    useStore(
      useShallow((s) => ({
        modelLoaded: s.modelLoaded,
        selectElement: s.selectElement,
        setHighlightedIds: s.setHighlightedIds,
        clearVisibility: s.clearVisibility,
        frameElementsFn: s.frameElementsFn,
      })),
    );

  const [diff, setDiff] = useState<DiffResult | null>(null);
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
      const res = await fetchDiff();
      if (seq !== requestSeq.current) return;
      setDiff(res);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setError(e instanceof Error ? e.message : 'Diff failed');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [canFetch]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!modelLoaded) {
      setDiff(null);
      setError(null);
    }
  }, [modelLoaded]);

  const addedIds = useMemo(() => (diff?.added ?? []).map((r) => r.express_id), [diff]);
  const changedIds = useMemo(() => (diff?.changed ?? []).map((r) => r.express_id), [diff]);

  const highlight = useCallback(
    (ids: number[]) => {
      if (ids.length === 0) return;
      setHighlightedIds(ids);
      if (frameElementsFn) frameElementsFn(ids);
    },
    [setHighlightedIds, frameElementsFn],
  );

  const handleClear = useCallback(() => {
    clearVisibility();
    setHighlightedIds([]);
  }, [clearVisibility, setHighlightedIds]);

  const handleExport = useCallback(() => {
    const anchor = document.createElement('a');
    anchor.href = diffCsvUrl();
    anchor.download = 'changes.csv';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }, []);

  const total = diff ? diff.counts.added + diff.counts.removed + diff.counts.changed : 0;

  if (BROWSER_ONLY) {
    return <p className="diff-panel-empty">This feature needs the desktop backend.</p>;
  }

  return (
    <div className="diff-panel" role="region" aria-label="Model diff">
      <div className="diff-panel-toolbar">
        <span className="diff-panel-title">Changes since upload</span>
        <div className="diff-panel-actions">
          <button className="diff-panel-btn" onClick={handleClear} disabled={!modelLoaded}>
            Clear
          </button>
          <button className="diff-panel-btn" onClick={handleExport} disabled={!diff || total === 0}>
            CSV
          </button>
          <button
            className="diff-panel-btn diff-panel-btn--icon"
            onClick={() => void load()}
            disabled={loading || !canFetch}
            title="Recompute diff"
            aria-label="Recompute diff"
          >
            <Icon name="refresh" size={13} />
          </button>
        </div>
      </div>

      <div className="diff-panel-body">
        {!modelLoaded ? (
          <p className="diff-panel-empty">Load an IFC model first.</p>
        ) : error ? (
          <div className="diff-panel-error" role="alert">
            <span>{error}</span>
            <button className="diff-panel-btn" onClick={() => void load()}>
              Retry
            </button>
          </div>
        ) : loading && !diff ? (
          <p className="diff-panel-quiet">Comparing...</p>
        ) : diff && total === 0 ? (
          <p className="diff-panel-empty">No changes since upload.</p>
        ) : diff ? (
          <>
            <div className="diff-panel-summary">
              <button
                className="diff-panel-stat diff-panel-stat--added"
                onClick={() => highlight(addedIds)}
                disabled={addedIds.length === 0}
                title="Highlight added elements"
              >
                <span className="diff-panel-stat-value">{diff.counts.added}</span>
                <span className="diff-panel-stat-label">added</span>
              </button>
              <button
                className="diff-panel-stat diff-panel-stat--changed"
                onClick={() => highlight(changedIds)}
                disabled={changedIds.length === 0}
                title="Highlight changed elements"
              >
                <span className="diff-panel-stat-value">{diff.counts.changed}</span>
                <span className="diff-panel-stat-label">changed</span>
              </button>
              <span className="diff-panel-stat diff-panel-stat--removed" title="Removed elements are no longer in the model">
                <span className="diff-panel-stat-value">{diff.counts.removed}</span>
                <span className="diff-panel-stat-label">removed</span>
              </span>
            </div>

            {diff.changed.length > 0 && (
              <>
                <div className="diff-panel-section-label">Changed</div>
                <ul className="diff-panel-list">
                  {diff.changed.map((row) => (
                    <li key={`c-${row.express_id}`}>
                      <button
                        className="diff-panel-row diff-panel-row--changed"
                        onClick={() => {
                          selectElement(row.express_id);
                          highlight([row.express_id]);
                        }}
                        title="Select in viewer"
                      >
                        <span className="diff-panel-row-name">
                          {row.name_after || row.name_before || shortType(row.ifc_type)}
                        </span>
                        <span className="diff-panel-row-tag">{changeLabel(row.change)}</span>
                      </button>
                      {row.change === 'renamed' && (
                        <div className="diff-panel-row-detail">
                          {row.name_before || '(none)'} - {row.name_after || '(none)'}
                        </div>
                      )}
                      {row.property_changes.length > 0 && (
                        <div className="diff-panel-row-detail">
                          {row.property_changes.slice(0, 4).map((p, i) => (
                            <div key={i}>
                              {p.property_name}: {String(p.before)} - {String(p.after)}
                            </div>
                          ))}
                          {row.property_changes.length > 4 && (
                            <div>+{row.property_changes.length - 4} more</div>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {diff.added.length > 0 && (
              <>
                <div className="diff-panel-section-label">Added</div>
                <ul className="diff-panel-list">
                  {diff.added.map((row) => (
                    <li key={`a-${row.express_id}`}>
                      <button
                        className="diff-panel-row diff-panel-row--added"
                        onClick={() => {
                          selectElement(row.express_id);
                          highlight([row.express_id]);
                        }}
                        title="Select in viewer"
                      >
                        <span className="diff-panel-row-name">{row.name || shortType(row.ifc_type)}</span>
                        <span className="diff-panel-row-tag">{shortType(row.ifc_type)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {diff.removed.length > 0 && (
              <>
                <div className="diff-panel-section-label">Removed</div>
                <ul className="diff-panel-list">
                  {diff.removed.map((row) => (
                    <li key={`r-${row.express_id}`} className="diff-panel-row diff-panel-row--removed-li">
                      <span className="diff-panel-row-name">{row.name || shortType(row.ifc_type)}</span>
                      <span className="diff-panel-row-tag">{shortType(row.ifc_type)}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {diff.truncated && (
              <p className="diff-panel-caption">Lists truncated at 1000 per category.</p>
            )}
            {!diff.has_working_copy && (
              <p className="diff-panel-caption">
                No separate working copy on record - diff reflects in-memory edits only.
              </p>
            )}
          </>
        ) : (
          <p className="diff-panel-empty">No data.</p>
        )}
      </div>
    </div>
  );
}

/**
 * Working-vs-original diff API client for the Diff panel.
 *
 * Backend contract:
 *   GET /api/diff/working-vs-original      -> { added, removed, changed, counts, truncated, has_working_copy }
 *   GET /api/diff/working-vs-original.csv  -> change report CSV
 */

export interface DiffRow {
  express_id: number;
  ifc_type: string;
  name?: string | null;
}

export interface DiffPropertyChange {
  property_set?: string;
  property_name?: string;
  before?: unknown;
  after?: unknown;
}

export interface DiffChangedRow {
  express_id: number;
  ifc_type: string;
  change: string;
  name_before?: string | null;
  name_after?: string | null;
  property_changes: DiffPropertyChange[];
}

export interface DiffResult {
  added: DiffRow[];
  removed: DiffRow[];
  changed: DiffChangedRow[];
  counts: { added: number; removed: number; changed: number };
  truncated: boolean;
  has_working_copy: boolean;
}

export async function fetchDiff(): Promise<DiffResult> {
  const res = await fetch(apiUrl('/api/diff/working-vs-original'));
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<DiffResult>;
}

export function diffCsvUrl(): string {
  return apiUrl('/api/diff/working-vs-original.csv');
}

/** Strip the "Ifc" prefix (IfcWall -> Wall). */
export function shortType(ifcType: string): string {
  return ifcType.startsWith('Ifc') ? ifcType.slice(3) : ifcType;
}

/** A short human label for a change kind. */
export function changeLabel(change: string): string {
  switch (change) {
    case 'renamed':
      return 'renamed';
    case 'retyped':
      return 'retyped';
    case 'property_changed':
      return 'properties';
    default:
      return change;
  }
}
