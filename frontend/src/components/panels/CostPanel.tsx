import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store/useStore';
import { BROWSER_ONLY } from '../../config/featureFlags';
import Icon from '../ui/Icon';
import { apiUrl } from '../../lib/platform';
import './costPanel.css';

/**
 * 5D cost panel (docked in the Tools tab). Shows a priced bill of quantities
 * over the existing quantity takeoff, plus an editable rate library. Rows drive
 * highlight/isolate in the viewer, mirroring the QTO panel.
 *
 * Embedded-native: no floating overlay, so it needs no .tool-embed-host
 * neutralization - it fills .tool-embed-body and scrolls its own body.
 */
export default function CostPanel(_props: { embedded?: boolean; onClose?: () => void }) {
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

  const [extra, setExtra] = useState<CostExtraField[]>([]);
  const [boq, setBoq] = useState<CostBoq | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeLabel, setActiveLabel] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftRates, setDraftRates] = useState<RateLibrary>({});
  const [currency, setCurrency] = useState('USD');
  const [saving, setSaving] = useState(false);
  const requestSeq = useRef(0);

  const canFetch = modelLoaded && !BROWSER_ONLY;

  const load = useCallback(async () => {
    if (!canFetch) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchBoq(extra);
      if (seq !== requestSeq.current) return;
      setBoq(result);
      setCurrency(result.currency);
      setActiveLabel(null);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setError(e instanceof Error ? e.message : 'Cost takeoff failed');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [canFetch, extra]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!modelLoaded) {
      setBoq(null);
      setError(null);
      setActiveLabel(null);
    }
  }, [modelLoaded]);

  const toggleField = useCallback((field: CostExtraField) => {
    setExtra((prev) =>
      prev.includes(field) ? prev.filter((f) => f !== field) : [...prev, field],
    );
  }, []);

  const handleRowClick = useCallback(
    (row: CostBoq['rows'][number]) => {
      const ids = row.element_ids ?? [];
      setHighlightedIds(ids);
      setActiveLabel(row.label);
      if (frameElementsFn && ids.length > 0) frameElementsFn(ids);
    },
    [setHighlightedIds, frameElementsFn],
  );

  const handleIsolate = useCallback(
    (e: React.MouseEvent, row: CostBoq['rows'][number]) => {
      e.stopPropagation();
      setIsolatedIds(row.element_ids ?? []);
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
    anchor.href = boqCsvUrl(extra);
    anchor.download = 'bill-of-quantities.csv';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }, [extra]);

  const openRatesEditor = useCallback(async () => {
    try {
      const res = await fetchRates();
      // Seed the draft with the library plus any classes seen in the current BoQ.
      const seeded: RateLibrary = { ...res.rates };
      for (const row of boq?.rows ?? []) {
        if (!seeded[row.ifc_class]) {
          seeded[row.ifc_class] = { basis: row.basis, rate: row.rate };
        }
      }
      setDraftRates(seeded);
      setCurrency(res.currency);
      setEditing(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load rates');
    }
  }, [boq]);

  const handleSaveRates = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await saveRates(draftRates);
      setEditing(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save rates');
    } finally {
      setSaving(false);
    }
  }, [draftRates, load]);

  const setDraft = useCallback((cls: string, patch: Partial<{ basis: CostBasis; rate: number }>) => {
    setDraftRates((prev) => ({
      ...prev,
      [cls]: { basis: prev[cls]?.basis ?? 'count', rate: prev[cls]?.rate ?? 0, ...patch },
    }));
  }, []);

  const draftClasses = useMemo(() => Object.keys(draftRates).sort(), [draftRates]);
  const hasRows = (boq?.rows.length ?? 0) > 0;

  if (BROWSER_ONLY) {
    return <p className="cost-panel-empty">This feature needs the desktop backend.</p>;
  }

  return (
    <div className="cost-panel" role="region" aria-label="Cost takeoff">
      <div className="cost-panel-toolbar">
        {!editing && (
          <div className="cost-panel-chips" role="group" aria-label="Break down by">
            <span className="cost-panel-chip cost-panel-chip--fixed" title="Always grouped by IFC class">
              IFC class
            </span>
            {COST_EXTRA_FIELDS.map(({ value, label }) => (
              <button
                key={value}
                className={`cost-panel-chip${extra.includes(value) ? ' cost-panel-chip--on' : ''}`}
                aria-pressed={extra.includes(value)}
                onClick={() => toggleField(value)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {editing && <span className="cost-panel-editing-title">Edit rate library ({currency})</span>}
        <div className="cost-panel-actions">
          {!editing ? (
            <>
              <button className="cost-panel-btn" onClick={handleClear} disabled={!modelLoaded}>
                Clear
              </button>
              <button className="cost-panel-btn" onClick={() => void openRatesEditor()} disabled={!modelLoaded}>
                Rates
              </button>
              <button className="cost-panel-btn" onClick={handleExportCsv} disabled={!hasRows}>
                CSV
              </button>
              <button
                className="cost-panel-btn cost-panel-btn--icon"
                onClick={() => void load()}
                disabled={loading || !canFetch}
                title="Recompute"
                aria-label="Recompute cost takeoff"
              >
                <Icon name="refresh" size={13} />
              </button>
            </>
          ) : (
            <>
              <button
                className="cost-panel-btn cost-panel-btn--accent"
                onClick={() => void handleSaveRates()}
                disabled={saving}
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
              <button className="cost-panel-btn" onClick={() => setEditing(false)} disabled={saving}>
                Cancel
              </button>
            </>
          )}
        </div>
      </div>

      <div className="cost-panel-body">
        {!modelLoaded ? (
          <p className="cost-panel-empty">Load an IFC model first.</p>
        ) : error ? (
          <div className="cost-panel-error" role="alert">
            <span>{error}</span>
            <button className="cost-panel-btn" onClick={() => void load()}>
              Retry
            </button>
          </div>
        ) : editing ? (
          <table className="cost-panel-table">
            <thead>
              <tr>
                <th className="cost-panel-th">IFC class</th>
                <th className="cost-panel-th">Basis</th>
                <th className="cost-panel-th cost-panel-th--num">Rate ({currency})</th>
              </tr>
            </thead>
            <tbody>
              {draftClasses.map((cls) => (
                <tr key={cls}>
                  <td className="cost-panel-td">{shortClass(cls)}</td>
                  <td className="cost-panel-td">
                    <select
                      className="cost-panel-input"
                      value={draftRates[cls]?.basis ?? 'count'}
                      onChange={(e) => setDraft(cls, { basis: e.target.value as CostBasis })}
                    >
                      {COST_BASES.map((b) => (
                        <option key={b.value} value={b.value}>
                          {b.label} ({b.unit})
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="cost-panel-td cost-panel-td--num">
                    <input
                      className="cost-panel-input cost-panel-input--num"
                      type="number"
                      step="any"
                      min="0"
                      value={draftRates[cls]?.rate ?? 0}
                      onChange={(e) => setDraft(cls, { rate: Number(e.target.value) || 0 })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : loading && !boq ? (
          <p className="cost-panel-quiet">Computing costs...</p>
        ) : boq && hasRows ? (
          <>
            <table className={`cost-panel-table${loading ? ' cost-panel-table--loading' : ''}`}>
              <thead>
                <tr>
                  <th className="cost-panel-th">Group</th>
                  <th className="cost-panel-th cost-panel-th--num">Qty</th>
                  <th className="cost-panel-th cost-panel-th--num">Rate</th>
                  <th className="cost-panel-th cost-panel-th--num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {boq.rows.map((row) => (
                  <tr
                    key={row.label}
                    className={`cost-panel-row${activeLabel === row.label ? ' cost-panel-row--active' : ''}${
                      row.priced ? '' : ' cost-panel-row--unpriced'
                    }`}
                    tabIndex={0}
                    onClick={() => handleRowClick(row)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleRowClick(row);
                      }
                    }}
                  >
                    <td className="cost-panel-td cost-panel-td--group" title={row.label}>
                      <span className="cost-panel-group-cell">
                        <span className="cost-panel-group-label">{row.label}</span>
                        <button
                          className="cost-panel-isolate"
                          title={`Isolate ${row.count} element${row.count !== 1 ? 's' : ''}`}
                          aria-label={`Isolate ${row.label}`}
                          onClick={(e) => handleIsolate(e, row)}
                        >
                          <Icon name="crop" size={12} />
                        </button>
                      </span>
                    </td>
                    <td className="cost-panel-td cost-panel-td--num">
                      {formatQuantity(row.quantity, row.unit)}
                    </td>
                    <td className="cost-panel-td cost-panel-td--num">
                      {row.rate.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                    </td>
                    <td className="cost-panel-td cost-panel-td--num">
                      {row.priced
                        ? row.amount.toLocaleString('en-US', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })
                        : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="cost-panel-total-row">
                  <td className="cost-panel-td">Total</td>
                  <td className="cost-panel-td" />
                  <td className="cost-panel-td" />
                  <td className="cost-panel-td cost-panel-td--num">
                    {formatMoney(boq.total, boq.currency)}
                  </td>
                </tr>
              </tfoot>
            </table>
            <div className="cost-panel-caption">
              {boq.priced_rows} of {boq.total_rows} groups priced
              {boq.truncated && ' - list truncated at 500'}
              {'. Default rates are placeholders - edit them via Rates.'}
            </div>
          </>
        ) : (
          <p className="cost-panel-empty">No quantities to price.</p>
        )}
      </div>
    </div>
  );
}

/**
 * 5D cost / bill-of-quantities API client + formatters for the Cost panel.
 *
 * Backend contract:
 *   GET    /api/cost/rates                       -> { currency, rates }
 *   PUT    /api/cost/rates  body { rates }       -> { currency, rates }
 *   GET    /api/cost/boq?group_by=<csv>&include_ids=true
 *   GET    /api/cost/boq.csv?group_by=<csv>
 * The BoQ is always grouped by ifc_class first; group_by adds extra dimensions
 * (storey | material | type_object | classification).
 */

/** Measurement basis a rate is applied against. */
export type CostBasis = 'volume' | 'area' | 'length' | 'count';

export const COST_BASES: ReadonlyArray<{ value: CostBasis; label: string; unit: string }> = [
  { value: 'area', label: 'Area', unit: 'm2' },
  { value: 'volume', label: 'Volume', unit: 'm3' },
  { value: 'length', label: 'Length', unit: 'm' },
  { value: 'count', label: 'Count', unit: 'nr' },
];

/** Extra grouping dimensions (after the implicit ifc_class). */
export type CostExtraField = 'storey' | 'material' | 'type_object' | 'classification';

export const COST_EXTRA_FIELDS: ReadonlyArray<{ value: CostExtraField; label: string }> = [
  { value: 'storey', label: 'Storey' },
  { value: 'material', label: 'Material' },
  { value: 'type_object', label: 'Type' },
  { value: 'classification', label: 'Classification' },
];

export interface RateEntry {
  basis: CostBasis;
  rate: number;
}

export type RateLibrary = Record<string, RateEntry>;

export interface RatesResponse {
  currency: string;
  rates: RateLibrary;
}

export interface CostBoqRow {
  key: Record<string, string>;
  label: string;
  ifc_class: string;
  count: number;
  basis: CostBasis;
  unit: string;
  quantity: number;
  rate: number;
  amount: number;
  priced: boolean;
  element_ids?: number[];
}

export interface CostBoq {
  currency: string;
  group_by: string[];
  rows: CostBoqRow[];
  total: number;
  priced_rows: number;
  total_rows: number;
  truncated: boolean;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(apiUrl(path));
  if (!res.ok) {
    throw new Error(`API error ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

/** Fetch the editable rate library. */
export function fetchRates(): Promise<RatesResponse> {
  return getJson<RatesResponse>('/api/cost/rates');
}

/** Replace the rate library; returns the persisted (sanitized) result. */
export async function saveRates(rates: RateLibrary): Promise<RatesResponse> {
  const res = await fetch(apiUrl('/api/cost/rates'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rates }),
  });
  if (!res.ok) {
    throw new Error(`API error ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<RatesResponse>;
}

/** Fetch the priced bill of quantities. `extra` are dimensions after ifc_class. */
export function fetchBoq(extra: readonly CostExtraField[]): Promise<CostBoq> {
  const params = new URLSearchParams({ group_by: extra.join(','), include_ids: 'true' });
  return getJson<CostBoq>(`/api/cost/boq?${params.toString()}`);
}

/** Download URL for the BoQ CSV. */
export function boqCsvUrl(extra: readonly CostExtraField[]): string {
  const params = new URLSearchParams({ group_by: extra.join(',') });
  return apiUrl(`/api/cost/boq.csv?${params.toString()}`);
}

/** Format a money amount with thousands separators and 2 decimals. */
export function formatMoney(value: number, currency: string): string {
  const num = value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${currency} ${num}`;
}

/** Format a quantity (3 dp, trimmed) with its unit. */
export function formatQuantity(value: number, unit: string): string {
  const num = value.toLocaleString('en-US', { maximumFractionDigits: 3 });
  return `${num} ${unit}`;
}

/** Strip the "Ifc" prefix for display (IfcWall -> Wall). */
export function shortClass(ifcClass: string): string {
  return ifcClass.startsWith('Ifc') ? ifcClass.slice(3) : ifcClass;
}
