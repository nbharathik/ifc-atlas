import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store/useStore';
import { BROWSER_ONLY } from '../../config/featureFlags';
import Icon from '../ui/Icon';
import { apiUrl } from '../../lib/platform';
import './carbonPanel.css';

/**
 * Embodied-carbon panel (docked in the Tools tab). Estimates kgCO2e per material
 * over the quantity takeoff, with an editable factor library. Mirrors the Cost
 * panel. Embedded-native (fills .tool-embed-body, owns its scroll).
 */
export default function CarbonPanel(_props: { embedded?: boolean; onClose?: () => void }) {
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

  const [extra, setExtra] = useState<CarbonExtraField[]>([]);
  const [result, setResult] = useState<CarbonResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeLabel, setActiveLabel] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraftState] = useState<FactorLibrary>({});
  const [saving, setSaving] = useState(false);
  const requestSeq = useRef(0);

  const canFetch = modelLoaded && !BROWSER_ONLY;

  const load = useCallback(async () => {
    if (!canFetch) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchCarbon(extra);
      if (seq !== requestSeq.current) return;
      setResult(res);
      setActiveLabel(null);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setError(e instanceof Error ? e.message : 'Carbon estimate failed');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [canFetch, extra]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!modelLoaded) {
      setResult(null);
      setError(null);
      setActiveLabel(null);
    }
  }, [modelLoaded]);

  const toggleField = useCallback((field: CarbonExtraField) => {
    setExtra((prev) => (prev.includes(field) ? prev.filter((f) => f !== field) : [...prev, field]));
  }, []);

  const handleRowClick = useCallback(
    (row: CarbonResult['rows'][number]) => {
      const ids = row.element_ids ?? [];
      setHighlightedIds(ids);
      setActiveLabel(row.label);
      if (frameElementsFn && ids.length > 0) frameElementsFn(ids);
    },
    [setHighlightedIds, frameElementsFn],
  );

  const handleIsolate = useCallback(
    (e: React.MouseEvent, row: CarbonResult['rows'][number]) => {
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
    anchor.href = carbonCsvUrl(extra);
    anchor.download = 'embodied-carbon.csv';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }, [extra]);

  const openEditor = useCallback(async () => {
    try {
      const res = await fetchFactors();
      const seeded: FactorLibrary = { ...res.factors };
      for (const row of result?.rows ?? []) {
        if (!seeded[row.material]) seeded[row.material] = { basis: row.basis, factor: row.factor };
      }
      setDraftState(seeded);
      setEditing(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load factors');
    }
  }, [result]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await saveFactors(draft);
      setEditing(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save factors');
    } finally {
      setSaving(false);
    }
  }, [draft, load]);

  const setDraft = useCallback((mat: string, patch: Partial<{ basis: CarbonBasis; factor: number }>) => {
    setDraftState((prev) => ({
      ...prev,
      [mat]: { basis: prev[mat]?.basis ?? 'volume', factor: prev[mat]?.factor ?? 0, ...patch },
    }));
  }, []);

  const draftMaterials = useMemo(() => Object.keys(draft).sort(), [draft]);
  const hasRows = (result?.rows.length ?? 0) > 0;

  if (BROWSER_ONLY) {
    return <p className="carbon-panel-empty">This feature needs the desktop backend.</p>;
  }

  return (
    <div className="carbon-panel" role="region" aria-label="Embodied carbon">
      <div className="carbon-panel-toolbar">
        {!editing && (
          <div className="carbon-panel-chips" role="group" aria-label="Break down by">
            <span className="carbon-panel-chip carbon-panel-chip--fixed" title="Always grouped by material">
              Material
            </span>
            {CARBON_EXTRA_FIELDS.map(({ value, label }) => (
              <button
                key={value}
                className={`carbon-panel-chip${extra.includes(value) ? ' carbon-panel-chip--on' : ''}`}
                aria-pressed={extra.includes(value)}
                onClick={() => toggleField(value)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {editing && <span className="carbon-panel-editing-title">Edit emission factors (kgCO2e)</span>}
        <div className="carbon-panel-actions">
          {!editing ? (
            <>
              <button className="carbon-panel-btn" onClick={handleClear} disabled={!modelLoaded}>
                Clear
              </button>
              <button className="carbon-panel-btn" onClick={() => void openEditor()} disabled={!modelLoaded}>
                Factors
              </button>
              <button className="carbon-panel-btn" onClick={handleExportCsv} disabled={!hasRows}>
                CSV
              </button>
              <button
                className="carbon-panel-btn carbon-panel-btn--icon"
                onClick={() => void load()}
                disabled={loading || !canFetch}
                title="Recompute"
                aria-label="Recompute carbon estimate"
              >
                <Icon name="refresh" size={13} />
              </button>
            </>
          ) : (
            <>
              <button
                className="carbon-panel-btn carbon-panel-btn--accent"
                onClick={() => void handleSave()}
                disabled={saving}
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
              <button className="carbon-panel-btn" onClick={() => setEditing(false)} disabled={saving}>
                Cancel
              </button>
            </>
          )}
        </div>
      </div>

      <div className="carbon-panel-body">
        {!modelLoaded ? (
          <p className="carbon-panel-empty">Load an IFC model first.</p>
        ) : error ? (
          <div className="carbon-panel-error" role="alert">
            <span>{error}</span>
            <button className="carbon-panel-btn" onClick={() => void load()}>
              Retry
            </button>
          </div>
        ) : editing ? (
          <table className="carbon-panel-table">
            <thead>
              <tr>
                <th className="carbon-panel-th">Material</th>
                <th className="carbon-panel-th">Basis</th>
                <th className="carbon-panel-th carbon-panel-th--num">kgCO2e / unit</th>
              </tr>
            </thead>
            <tbody>
              {draftMaterials.map((mat) => (
                <tr key={mat}>
                  <td className="carbon-panel-td" title={mat}>
                    {mat}
                  </td>
                  <td className="carbon-panel-td">
                    <select
                      className="carbon-panel-input"
                      value={draft[mat]?.basis ?? 'volume'}
                      onChange={(e) => setDraft(mat, { basis: e.target.value as CarbonBasis })}
                    >
                      {CARBON_BASES.map((b) => (
                        <option key={b.value} value={b.value}>
                          {b.label} ({b.unit})
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="carbon-panel-td carbon-panel-td--num">
                    <input
                      className="carbon-panel-input carbon-panel-input--num"
                      type="number"
                      step="any"
                      min="0"
                      value={draft[mat]?.factor ?? 0}
                      onChange={(e) => setDraft(mat, { factor: Number(e.target.value) || 0 })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : loading && !result ? (
          <p className="carbon-panel-quiet">Estimating carbon...</p>
        ) : result && hasRows ? (
          <>
            <table className={`carbon-panel-table${loading ? ' carbon-panel-table--loading' : ''}`}>
              <thead>
                <tr>
                  <th className="carbon-panel-th">Group</th>
                  <th className="carbon-panel-th carbon-panel-th--num">Qty</th>
                  <th className="carbon-panel-th carbon-panel-th--num">Factor</th>
                  <th className="carbon-panel-th carbon-panel-th--num">kgCO2e</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => (
                  <tr
                    key={row.label}
                    className={`carbon-panel-row${activeLabel === row.label ? ' carbon-panel-row--active' : ''}${
                      row.factored ? '' : ' carbon-panel-row--unfactored'
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
                    <td className="carbon-panel-td carbon-panel-td--group" title={row.label}>
                      <span className="carbon-panel-group-cell">
                        <span className="carbon-panel-group-label">{row.label}</span>
                        <button
                          className="carbon-panel-isolate"
                          title={`Isolate ${row.count} element${row.count !== 1 ? 's' : ''}`}
                          aria-label={`Isolate ${row.label}`}
                          onClick={(e) => handleIsolate(e, row)}
                        >
                          <Icon name="crop" size={12} />
                        </button>
                      </span>
                    </td>
                    <td className="carbon-panel-td carbon-panel-td--num">
                      {formatQuantity(row.quantity, row.unit)}
                    </td>
                    <td className="carbon-panel-td carbon-panel-td--num">
                      {row.factor.toLocaleString('en-US', { maximumFractionDigits: 1 })}
                    </td>
                    <td className="carbon-panel-td carbon-panel-td--num">
                      {row.factored ? formatCarbon(row.carbon_kg) : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="carbon-panel-total-row">
                  <td className="carbon-panel-td">Total</td>
                  <td className="carbon-panel-td" />
                  <td className="carbon-panel-td" />
                  <td className="carbon-panel-td carbon-panel-td--num">
                    {result.total_tonnes.toLocaleString('en-US', { maximumFractionDigits: 2 })} t
                  </td>
                </tr>
              </tfoot>
            </table>
            <div className="carbon-panel-caption">
              {result.factored_rows} of {result.total_rows} materials factored
              {result.truncated && ' - list truncated at 500'}
              {'. Default factors are approximate placeholders - edit them via Factors.'}
            </div>
          </>
        ) : (
          <p className="carbon-panel-empty">No materials to estimate.</p>
        )}
      </div>
    </div>
  );
}

/**
 * Embodied-carbon API client + formatters for the Carbon panel.
 *
 * Backend contract:
 *   GET    /api/carbon/factors                   -> { factors }
 *   PUT    /api/carbon/factors  body { factors } -> { factors }
 *   GET    /api/carbon/estimate?group_by=<csv>&include_ids=true
 *   GET    /api/carbon/estimate.csv?group_by=<csv>
 * Always grouped by material first; group_by adds extra dimensions.
 */

export type CarbonBasis = 'volume' | 'area' | 'length' | 'count';

export const CARBON_BASES: ReadonlyArray<{ value: CarbonBasis; label: string; unit: string }> = [
  { value: 'volume', label: 'Volume', unit: 'm3' },
  { value: 'area', label: 'Area', unit: 'm2' },
  { value: 'length', label: 'Length', unit: 'm' },
  { value: 'count', label: 'Count', unit: 'nr' },
];

export type CarbonExtraField = 'ifc_class' | 'storey' | 'type_object' | 'classification';

export const CARBON_EXTRA_FIELDS: ReadonlyArray<{ value: CarbonExtraField; label: string }> = [
  { value: 'ifc_class', label: 'IFC class' },
  { value: 'storey', label: 'Storey' },
  { value: 'type_object', label: 'Type' },
  { value: 'classification', label: 'Classification' },
];

export interface FactorEntry {
  basis: CarbonBasis;
  factor: number;
}

export type FactorLibrary = Record<string, FactorEntry>;

export interface CarbonRow {
  key: Record<string, string>;
  label: string;
  material: string;
  count: number;
  basis: CarbonBasis;
  unit: string;
  quantity: number;
  factor: number;
  carbon_kg: number;
  factored: boolean;
  element_ids?: number[];
}

export interface CarbonResult {
  group_by: string[];
  rows: CarbonRow[];
  total_kg: number;
  total_tonnes: number;
  factored_rows: number;
  total_rows: number;
  truncated: boolean;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(apiUrl(path));
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export function fetchFactors(): Promise<{ factors: FactorLibrary }> {
  return getJson<{ factors: FactorLibrary }>('/api/carbon/factors');
}

export async function saveFactors(factors: FactorLibrary): Promise<{ factors: FactorLibrary }> {
  const res = await fetch(apiUrl('/api/carbon/factors'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ factors }),
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<{ factors: FactorLibrary }>;
}

export function fetchCarbon(extra: readonly CarbonExtraField[]): Promise<CarbonResult> {
  const params = new URLSearchParams({ group_by: extra.join(','), include_ids: 'true' });
  return getJson<CarbonResult>(`/api/carbon/estimate?${params.toString()}`);
}

export function carbonCsvUrl(extra: readonly CarbonExtraField[]): string {
  const params = new URLSearchParams({ group_by: extra.join(',') });
  return apiUrl(`/api/carbon/estimate.csv?${params.toString()}`);
}

/** Format embodied carbon: kg under 1 t, tonnes above, with thousands separators. */
export function formatCarbon(kg: number): string {
  if (kg >= 1000) {
    return `${(kg / 1000).toLocaleString('en-US', { maximumFractionDigits: 2 })} t`;
  }
  return `${kg.toLocaleString('en-US', { maximumFractionDigits: 1 })} kg`;
}

export function formatQuantity(value: number, unit: string): string {
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 3 })} ${unit}`;
}
