import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store/useStore';
import { BROWSER_ONLY } from '../../config/featureFlags';
import Icon from '../ui/Icon';
import {
  QTO_GROUP_FIELDS,
  buildQtoTsv,
  fetchQtoSummary,
  formatQtoCount,
  formatQtoNumber,
  formatQtoQuantity,
  qtoExportCsvUrl,
  qtoSortComparator,
  type QtoGroup,
  type QtoGroupField,
  type QtoSortDirection,
  type QtoSortKey,
  type QtoSummary,
} from '../../services/features/qto';
import './qtoPanel.css';

const DEFAULT_GROUP_BY: QtoGroupField[] = ['ifc_class', 'storey'];

interface SortState {
  key: QtoSortKey;
  dir: QtoSortDirection;
}

interface SortHeaderProps {
  label: string;
  sortKey: QtoSortKey;
  sort: SortState;
  onSort: (key: QtoSortKey) => void;
}

function SortHeader({ label, sortKey, sort, onSort }: SortHeaderProps) {
  const active = sort.key === sortKey;
  return (
    <th
      className="qto-panel-th qto-panel-th--num"
      scope="col"
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
    >
      <button
        className={`qto-panel-sort-btn${active ? ' qto-panel-sort-btn--on' : ''}`}
        onClick={() => onSort(sortKey)}
        title={`Sort by ${label.toLowerCase()}`}
      >
        {label}
        <span className="qto-panel-sort-arrow" aria-hidden="true">
          {active ? (sort.dir === 'desc' ? '▾' : '▴') : ''}
        </span>
      </button>
    </th>
  );
}

export default function QtoPanel({ onClose, embedded = false }: { onClose: () => void; embedded?: boolean }) {
  const { modelLoaded, setHighlightedIds, setIsolatedIds, clearVisibility, frameElementsFn } =
    useStore(
      useShallow((s) => ({
        modelLoaded: s.modelLoaded,
        setHighlightedIds: s.setHighlightedIds,
        setIsolatedIds: s.setIsolatedIds,
        clearVisibility: s.clearVisibility,
        frameElementsFn: s.frameElementsFn,
      })),
    );

  const [groupBy, setGroupBy] = useState<QtoGroupField[]>(DEFAULT_GROUP_BY);
  const [summary, setSummary] = useState<QtoSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortState>({ key: 'count', dir: 'desc' });
  const [activeLabel, setActiveLabel] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Monotonic request counter: a slow response must never overwrite the
  // result of a request issued after it (chips can refetch rapidly).
  const requestSeq = useRef(0);

  const canFetch = modelLoaded && !BROWSER_ONLY;

  const load = useCallback(async () => {
    if (!canFetch || groupBy.length === 0) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchQtoSummary(groupBy);
      if (seq !== requestSeq.current) return;
      setSummary(result);
      setActiveLabel(null);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setError(e instanceof Error ? e.message : 'Quantity takeoff failed');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [canFetch, groupBy]);

  // Auto-fetch on open and whenever the grouping changes.
  useEffect(() => {
    void load();
  }, [load]);

  // Drop stale results when the model is unloaded.
  useEffect(() => {
    if (!modelLoaded) {
      setSummary(null);
      setError(null);
      setActiveLabel(null);
    }
  }, [modelLoaded]);

  const toggleField = useCallback((field: QtoGroupField) => {
    setGroupBy((prev) => {
      if (prev.includes(field)) {
        // The API requires at least one group field; keep the last chip on.
        if (prev.length === 1) return prev;
        return prev.filter((f) => f !== field);
      }
      return [...prev, field];
    });
  }, []);

  const handleSort = useCallback((key: QtoSortKey) => {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' }
        : { key, dir: 'desc' },
    );
  }, []);

  const sortedGroups = useMemo(
    () => (summary ? [...summary.groups].sort(qtoSortComparator(sort.key, sort.dir)) : []),
    [summary, sort],
  );

  const handleRowClick = useCallback(
    (group: QtoGroup) => {
      const ids = group.element_ids ?? [];
      setHighlightedIds(ids);
      setActiveLabel(group.label);
      if (frameElementsFn && ids.length > 0) frameElementsFn(ids);
    },
    [setHighlightedIds, frameElementsFn],
  );

  const handleIsolate = useCallback(
    (e: React.MouseEvent, group: QtoGroup) => {
      e.stopPropagation();
      setIsolatedIds(group.element_ids ?? []);
    },
    [setIsolatedIds],
  );

  const handleClear = useCallback(() => {
    clearVisibility();
    setHighlightedIds([]);
    setActiveLabel(null);
  }, [clearVisibility, setHighlightedIds]);

  const handleExportCsv = useCallback(() => {
    const anchor = document.createElement('a');
    anchor.href = qtoExportCsvUrl(groupBy);
    anchor.download = 'quantity-takeoff.csv';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }, [groupBy]);

  const handleCopyTsv = useCallback(async () => {
    if (!summary || sortedGroups.length === 0) return;
    // Columns come from the summary the rows belong to, not the live chips,
    // so a copy taken mid-refetch still matches its own rows.
    const tsv = buildQtoTsv(sortedGroups, summary.group_by);
    try {
      await navigator.clipboard.writeText(tsv);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (e.g. HTTP context): surface via console instead.
      console.info('[QTO] TSV:\n', tsv);
    }
  }, [summary, sortedGroups]);

  const hasRows = sortedGroups.length > 0;

  return (
    <div className="qto-panel-overlay">
      <div className="qto-panel" role="region" aria-label="Quantity takeoff">
        <div className="qto-panel-header">
          {!embedded && (
            <span className="qto-panel-title fpanel-title">
              <span className="fpanel-title-icon">
                <Icon name="bar-chart" size={14} />
              </span>
              Quantity takeoff
            </span>
          )}
          <div className="qto-panel-actions">
            <button
              className="qto-panel-btn"
              onClick={handleClear}
              disabled={!modelLoaded}
              title="Clear highlight and isolation"
            >
              Clear
            </button>
            <button
              className="qto-panel-btn"
              onClick={handleCopyTsv}
              disabled={!hasRows}
              title="Copy table as TSV"
              aria-label="Copy table as TSV"
            >
              {copied ? <Icon name="check" size={13} /> : 'TSV'}
            </button>
            <button
              className="qto-panel-btn"
              onClick={handleExportCsv}
              disabled={!canFetch}
              title="Download CSV"
              aria-label="Download CSV"
            >
              CSV
            </button>
            <button
              className="qto-panel-btn qto-panel-btn--accent fpanel-icon-btn"
              onClick={() => void load()}
              disabled={loading || !canFetch}
              title="Recompute quantities"
              aria-label="Refresh quantity takeoff"
            >
              <Icon name="refresh" size={13} />
            </button>
            {!embedded && (
              <button
                className="qto-panel-btn fpanel-icon-btn"
                onClick={onClose}
                aria-label="Close quantity takeoff panel"
              >
                <Icon name="x" size={14} />
              </button>
            )}
          </div>
        </div>

        {BROWSER_ONLY ? (
          <p className="qto-panel-empty">This feature needs the desktop backend.</p>
        ) : !modelLoaded ? (
          <p className="qto-panel-empty">Load an IFC model first.</p>
        ) : (
          <>
            <div className="qto-panel-chips" role="group" aria-label="Group by">
              {QTO_GROUP_FIELDS.map(({ value, label }) => {
                const order = groupBy.indexOf(value);
                const selected = order >= 0;
                return (
                  <button
                    key={value}
                    className={`qto-panel-chip${selected ? ' qto-panel-chip--on' : ''}`}
                    aria-pressed={selected}
                    onClick={() => toggleField(value)}
                  >
                    {selected && groupBy.length > 1 && (
                      <span className="qto-panel-chip-order">{order + 1}</span>
                    )}
                    {label}
                  </button>
                );
              })}
            </div>

            {error && (
              <div className="qto-panel-error" role="alert">
                <span className="qto-panel-error-msg">{error}</span>
                <button className="qto-panel-btn" onClick={() => void load()}>
                  Retry
                </button>
              </div>
            )}

            {loading && !summary && (
              <div className="qto-panel-skeleton" aria-label="Computing quantities">
                {Array.from({ length: 6 }, (_, i) => (
                  <div key={i} className="qto-panel-skeleton-row" />
                ))}
              </div>
            )}

            {summary && !hasRows && !loading && !error && (
              <p className="qto-panel-empty">No quantities found for this grouping.</p>
            )}

            {summary && hasRows && (
              <>
                <div
                  className={`qto-panel-table-wrap${loading ? ' qto-panel-table-wrap--loading' : ''}`}
                >
                  <table className="qto-panel-table">
                    <thead>
                      <tr>
                        <th className="qto-panel-th qto-panel-th--group" scope="col">
                          Group
                        </th>
                        <SortHeader label="Count" sortKey="count" sort={sort} onSort={handleSort} />
                        <SortHeader label="Volume (m3)" sortKey="volume" sort={sort} onSort={handleSort} />
                        <SortHeader label="Area (m2)" sortKey="area" sort={sort} onSort={handleSort} />
                        <SortHeader label="Length (m)" sortKey="length" sort={sort} onSort={handleSort} />
                      </tr>
                    </thead>
                    <tbody>
                      {sortedGroups.map((group) => (
                        <tr
                          key={group.label}
                          className={`qto-panel-row${
                            activeLabel === group.label ? ' qto-panel-row--active' : ''
                          }`}
                          tabIndex={0}
                          onClick={() => handleRowClick(group)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              handleRowClick(group);
                            }
                          }}
                        >
                          <td className="qto-panel-td qto-panel-td--group" title={group.label}>
                            <span className="qto-panel-group-cell">
                              <span className="qto-panel-group-label">{group.label}</span>
                              <button
                                className="qto-panel-isolate fpanel-icon-btn"
                                title={`Isolate ${formatQtoCount(group.count)} element${
                                  group.count !== 1 ? 's' : ''
                                }`}
                                aria-label={`Isolate ${group.label}`}
                                onClick={(e) => handleIsolate(e, group)}
                              >
                                <Icon name="crop" size={12} />
                              </button>
                            </span>
                          </td>
                          <td className="qto-panel-td qto-panel-td--num">
                            {formatQtoCount(group.count)}
                          </td>
                          <td className="qto-panel-td qto-panel-td--num">
                            {formatQtoQuantity(group.quantities.volume_m3, group.coverage.volume)}
                          </td>
                          <td className="qto-panel-td qto-panel-td--num">
                            {formatQtoQuantity(group.quantities.area_m2, group.coverage.area)}
                          </td>
                          <td className="qto-panel-td qto-panel-td--num">
                            {formatQtoQuantity(group.quantities.length_m, group.coverage.length)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="qto-panel-total-row">
                        <td className="qto-panel-td qto-panel-td--group">Total</td>
                        <td className="qto-panel-td qto-panel-td--num">
                          {formatQtoCount(summary.overall.count)}
                        </td>
                        <td className="qto-panel-td qto-panel-td--num">
                          {formatQtoNumber(summary.overall.quantities.volume_m3)}
                        </td>
                        <td className="qto-panel-td qto-panel-td--num">
                          {formatQtoNumber(summary.overall.quantities.area_m2)}
                        </td>
                        <td className="qto-panel-td qto-panel-td--num">
                          {formatQtoNumber(summary.overall.quantities.length_m)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                <div className="qto-panel-caption">
                  <span>
                    {formatQtoCount(summary.groups.length)} group
                    {summary.groups.length !== 1 ? 's' : ''} -{' '}
                    {formatQtoCount(summary.overall.count)} element
                    {summary.overall.count !== 1 ? 's' : ''}
                  </span>
                  {summary.truncated && (
                    <span className="qto-panel-trunc">
                      Group list truncated at 500 - narrow the grouping
                    </span>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
