/**
 * Element Filter Panel.
 *
 * Lets users filter IFC elements by property value with a structured condition
 * (property name + operator + value). Matching elements are highlighted in the
 * 3D viewer. Accessible via keyboard shortcut Shift+F or the left toolbar.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  filterByPropertyValue,
  type PropertyFilterOperator,
  type PropertyFilterResult,
} from '../../services/api';
import { useStore } from '../../store/useStore';
import { useShallow } from 'zustand/react/shallow';

// ─── Pure helpers (exported for vitest) ──────────────────────────────────────

export const OPERATORS: { value: PropertyFilterOperator; label: string }[] = [
  { value: 'eq',         label: '= equals' },
  { value: 'neq',        label: '≠ not equals' },
  { value: 'contains',   label: '⊃ contains' },
  { value: 'startswith', label: '↦ starts with' },
  { value: 'gt',         label: '> greater than' },
  { value: 'lt',         label: '< less than' },
  { value: 'gte',        label: '≥ greater or equal' },
  { value: 'lte',        label: '≤ less or equal' },
];

export function isNumericOperator(op: PropertyFilterOperator): boolean {
  return op === 'gt' || op === 'lt' || op === 'gte' || op === 'lte';
}

export function validateFilterForm(
  propertyName: string,
  operator: PropertyFilterOperator,
  value: string,
): string | null {
  if (!propertyName.trim()) return 'Property name is required.';
  if (!value.trim()) return 'Value is required.';
  if (isNumericOperator(operator) && isNaN(Number(value))) {
    return `Operator "${operator}" requires a numeric value.`;
  }
  return null;
}

export function formatOperatorLabel(op: PropertyFilterOperator): string {
  return OPERATORS.find((o) => o.value === op)?.label ?? op;
}

// ─── Panel ────────────────────────────────────────────────────────────────────

export function ElementFilterPanel({ embedded = false }: { embedded?: boolean } = {}) {
  const { filterPanelOpen, setFilterPanelOpen, setFilterResultIds, highlightedIds, setHighlightedIds } = useStore(useShallow((s) => ({
    filterPanelOpen: s.filterPanelOpen,
    setFilterPanelOpen: s.setFilterPanelOpen,
    setFilterResultIds: s.setFilterResultIds,
    highlightedIds: s.highlightedIds,
    setHighlightedIds: s.setHighlightedIds,
  })));

  // ESC dismisses the panel, matching every other floating overlay.
  useEffect(() => {
    if (!filterPanelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Don't swallow Esc meant for an overlay layered above the Tools tab.
      if (useStore.getState().commandPaletteOpen || useStore.getState().settingsOpen) return;
      e.stopPropagation();
      setFilterPanelOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [filterPanelOpen, setFilterPanelOpen]);

  const [propertyName, setPropertyName] = useState('');
  const [operator, setOperator] = useState<PropertyFilterOperator>('eq');
  const [value, setValue] = useState('');
  const [ifcType, setIfcType] = useState('');
  const [storey, setStorey] = useState('');
  const [psetName, setPsetName] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PropertyFilterResult | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);

  const handleApply = useCallback(async () => {
    const validationError = validateFilterForm(propertyName, operator, value);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setLoading(true);
    setResult(null);
    try {
      const res = await filterByPropertyValue({
        property_name: propertyName.trim(),
        operator,
        value: value.trim(),
        ifc_type: ifcType.trim() || undefined,
        storey: storey.trim() || undefined,
        pset_name: psetName.trim() || undefined,
        limit: 200,
      });
      setResult(res);
      setFilterResultIds(res.element_ids);
      if (res.element_ids.length > 0) {
        setHighlightedIds(res.element_ids);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Filter request failed');
    } finally {
      setLoading(false);
    }
  }, [propertyName, operator, value, ifcType, storey, psetName, setFilterResultIds, setHighlightedIds]);

  const handleClear = useCallback(() => {
    setPropertyName('');
    setOperator('eq');
    setValue('');
    setIfcType('');
    setStorey('');
    setPsetName('');
    setError(null);
    setResult(null);
    setFilterResultIds([]);
    inputRef.current?.focus();
  }, [setFilterResultIds]);

  if (!filterPanelOpen) return null;

  return (
    <div
      className="element-filter-panel"
      role={embedded ? undefined : 'dialog'}
      aria-label={embedded ? undefined : 'Element property filter'}
    >
      {/* Header - omitted when docked in the Tools tab (breadcrumb owns it). */}
      {!embedded && (
        <div className="efp-header">
          <span className="efp-title">Property Filter</span>
          <button
            className="efp-close"
            onClick={() => setFilterPanelOpen(false)}
            aria-label="Close filter panel"
            title="Close (Shift+F)"
          >
            ×
          </button>
        </div>
      )}

      {/* Main filter fields */}
      <div className="efp-body">
        <div className="efp-row">
          <label className="efp-label" htmlFor="efp-prop">Property</label>
          <input
            ref={inputRef}
            id="efp-prop"
            className="efp-input"
            type="text"
            placeholder="e.g. FireRating, IsExternal, Area"
            value={propertyName}
            onChange={(e) => setPropertyName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleApply()}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="efp-row efp-row--inline">
          <label className="efp-label" htmlFor="efp-op">Operator</label>
          <select
            id="efp-op"
            className="efp-select"
            value={operator}
            onChange={(e) => setOperator(e.target.value as PropertyFilterOperator)}
          >
            {OPERATORS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        <div className="efp-row">
          <label className="efp-label" htmlFor="efp-val">Value</label>
          <input
            id="efp-val"
            className="efp-input"
            type={isNumericOperator(operator) ? 'number' : 'text'}
            placeholder={isNumericOperator(operator) ? 'e.g. 20.0' : 'e.g. 2h, true, Concrete'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleApply()}
            autoComplete="off"
          />
        </div>

        {/* Advanced filters (collapsible) */}
        <button
          className="efp-advanced-toggle"
          onClick={() => setShowAdvanced((v) => !v)}
          aria-expanded={showAdvanced}
        >
          {showAdvanced ? '▾' : '▸'} Advanced filters
        </button>

        {showAdvanced && (
          <div className="efp-advanced">
            <div className="efp-row">
              <label className="efp-label" htmlFor="efp-type">IFC Type</label>
              <input
                id="efp-type"
                className="efp-input efp-input--small"
                type="text"
                placeholder="e.g. IfcWall"
                value={ifcType}
                onChange={(e) => setIfcType(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="efp-row">
              <label className="efp-label" htmlFor="efp-storey">Storey</label>
              <input
                id="efp-storey"
                className="efp-input efp-input--small"
                type="text"
                placeholder="e.g. Level 1"
                value={storey}
                onChange={(e) => setStorey(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="efp-row">
              <label className="efp-label" htmlFor="efp-pset">Property Set</label>
              <input
                id="efp-pset"
                className="efp-input efp-input--small"
                type="text"
                placeholder="e.g. Pset_WallCommon"
                value={psetName}
                onChange={(e) => setPsetName(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <p className="efp-error" role="alert">{error}</p>
        )}

        {/* Actions */}
        <div className="efp-actions">
          <button
            className="efp-btn efp-btn--apply"
            onClick={handleApply}
            disabled={loading}
          >
            {loading ? 'Filtering…' : 'Apply Filter'}
          </button>
          <button
            className="efp-btn efp-btn--clear"
            onClick={handleClear}
            disabled={loading}
          >
            Clear
          </button>
        </div>

        {/* Result summary */}
        {result !== null && (
          <div className="efp-result">
            {result.count === 0 ? (
              <span className="efp-result-none">No elements matched.</span>
            ) : (
              <>
                <span className="efp-result-count">
                  {result.count} element{result.count !== 1 ? 's' : ''} matched
                  {result.truncated ? ' (truncated)' : ''}
                  {' - highlighted in viewer'}
                </span>
                <div className="efp-result-list">
                  {result.elements.slice(0, 10).map((el) => (
                    <div key={el.id} className="efp-result-row">
                      <span className="efp-result-name" title={`#${el.id}`}>
                        {el.name || `#${el.id}`}
                      </span>
                      <span className="efp-result-type">{el.ifc_type}</span>
                      <span className="efp-result-value" title={`${el.pset}.${el.property}`}>
                        {el.value}
                      </span>
                    </div>
                  ))}
                  {result.count > 10 && (
                    <p className="efp-result-more">
                      +{result.count - 10} more…
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
