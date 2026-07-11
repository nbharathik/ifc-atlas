import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useStore } from '../../store/useStore';
import * as api from '../../services/api';
import type { ElementRelations } from '../../services/api';
import { BROWSER_ONLY } from '../../config/featureFlags';
import { modelService } from '../../services/ifc/ModelService';
import type { AggregateResult } from '../../types/ifc';
import {
  downloadAggregatesCsv,
  copyAggregatesCsvToClipboard,
} from '../../services/viewer/aggregateInspectorHelpers';
import Icon from '../ui/Icon';

interface PropertiesPanelProps {
  embedded?: boolean;
}

const PROPERTY_FETCH_DELAY_MS = 32;

interface PropGroupProps {
  title: string;
  count: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

function PropGroup({ title, count, defaultOpen = true, children }: PropGroupProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="prop-group">
      <button
        className="prop-group-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="prop-group-caret">
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={10} />
        </span>
        <span className="prop-group-title">{title}</span>
        <span className="prop-group-count">{count}</span>
      </button>
      {open && <div className="prop-group-body">{children}</div>}
    </div>
  );
}

function fmt(v: number, unit: 'm²' | 'm³'): string {
  return `${v.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unit}`;
}

/** Shimmer placeholder shown while element properties resolve.
 *  Mirrors the Identity-group shape so the panel doesn't jump when real
 *  rows replace it; the caption reassures on slow backends. */
function PropertiesSkeleton() {
  const valueWidths = [62, 78, 44, 70, 52, 64];
  return (
    <div className="prop-skeleton" aria-busy="true" aria-label="Loading properties">
      <div className="prop-skeleton-head prop-skeleton-shimmer" />
      {valueWidths.map((w, i) => (
        <div className="prop-skeleton-row" key={i}>
          <span className="prop-skeleton-shimmer" style={{ width: `${24 + ((i * 13) % 18)}%` }} />
          <span className="prop-skeleton-shimmer" style={{ width: `${w}%`, maxWidth: '52%' }} />
        </div>
      ))}
      <div className="prop-skeleton-caption">Loading properties…</div>
    </div>
  );
}

function MultiSelectPanel({ ids }: { ids: number[] }) {
  const clearSelectedIds = useStore((s) => s.clearSelectedIds);
  const selectElement = useStore((s) => s.selectElement);

  const [agg, setAgg] = useState<AggregateResult | null>(null);
  const [aggLoading, setAggLoading] = useState(false);

  // Fetch aggregate from backend; debounce so rapid shift-clicks don't spam
  useEffect(() => {
    if (BROWSER_ONLY) return; // no backend, quantities/histograms stay hidden
    if (ids.length < 2) { setAgg(null); return; }
    setAggLoading(true);
    const timer = setTimeout(() => {
      api.getAggregate(ids)
        .then((r) => setAgg(r))
        .catch(() => setAgg(null))
        .finally(() => setAggLoading(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [ids]);

  const typeHistogram = useMemo(
    () => agg ? Object.entries(agg.type_histogram) : [],
    [agg],
  );
  const materialHistogram = useMemo(
    () => agg ? Object.entries(agg.material_histogram) : [],
    [agg],
  );

  const [copyStatus, setCopyStatus] = useState<'idle' | 'ok' | 'fail'>('idle');

  const exportCsv = useCallback(() => {
    if (!agg) return;
    downloadAggregatesCsv(agg, ids);
  }, [agg, ids]);

  const copyCsv = useCallback(async () => {
    if (!agg) return;
    const ok = await copyAggregatesCsvToClipboard(agg, ids);
    setCopyStatus(ok ? 'ok' : 'fail');
    setTimeout(() => setCopyStatus('idle'), 1500);
  }, [agg, ids]);

  const SHOW_IDS = 8;
  const shown = ids.slice(0, SHOW_IDS);
  const overflow = ids.length - SHOW_IDS;

  return (
    <div className="prop-multi-select">
      <div className="prop-multi-header">
        <span className="prop-multi-count">{ids.length}</span>
        <span className="prop-multi-label"> elements selected</span>
        <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
          <button
            className="prop-multi-clear"
            onClick={exportCsv}
            title="Download CSV"
            disabled={!agg}
            style={{ opacity: agg ? 1 : 0.4 }}
          >CSV</button>
          <button
            className="prop-multi-clear"
            onClick={copyCsv}
            title="Copy CSV to clipboard"
            disabled={!agg}
            style={{ opacity: agg ? 1 : 0.4 }}
          >{copyStatus === 'ok' ? '✓' : copyStatus === 'fail' ? '✗' : 'Copy'}</button>
          <button
            className="prop-multi-clear"
            onClick={() => { clearSelectedIds(); selectElement(null); }}
            title="Clear selection (Esc)"
          >Clear</button>
        </div>
      </div>
      <p className="prop-multi-hint">Shift+click to add or remove elements</p>

      {/* Quantities summary */}
      {aggLoading && (
        <div className="prop-multi-section">
          <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Loading quantities…</span>
        </div>
      )}
      {agg && (agg.total_area !== null || agg.total_volume !== null) && (
        <div className="prop-multi-section">
          <div className="prop-multi-section-title">Quantities</div>
          {agg.total_area !== null && (
            <div className="prop-row">
              <span className="prop-key">ΣArea</span>
              <span className="prop-value">{fmt(agg.total_area, 'm²')}</span>
            </div>
          )}
          {agg.total_volume !== null && (
            <div className="prop-row">
              <span className="prop-key">ΣVolume</span>
              <span className="prop-value">{fmt(agg.total_volume, 'm³')}</span>
            </div>
          )}
          {agg.missing_quantity_ids.length > 0 && (
            <div className="prop-multi-overflow" style={{ marginTop: 4 }}>
              {agg.missing_quantity_ids.length} element
              {agg.missing_quantity_ids.length !== 1 ? 's' : ''} without qty data
            </div>
          )}
        </div>
      )}

      {/* Type histogram */}
      {typeHistogram.length > 0 && (
        <div className="prop-multi-section">
          <div className="prop-multi-section-title">Types</div>
          {typeHistogram.map(([type, count]) => (
            <div className="prop-row" key={type}>
              <span className="prop-key">{type}</span>
              <span className="prop-value">{count}</span>
            </div>
          ))}
        </div>
      )}

      {/* Material histogram */}
      {materialHistogram.length > 0 && (
        <div className="prop-multi-section">
          <div className="prop-multi-section-title">Materials</div>
          {materialHistogram.slice(0, 10).map(([mat, count]) => (
            <div className="prop-row" key={mat}>
              <span className="prop-key" title={mat} style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 140 }}>{mat}</span>
              <span className="prop-value">{count}</span>
            </div>
          ))}
          {materialHistogram.length > 10 && (
            <div className="prop-multi-overflow">+{materialHistogram.length - 10} more materials</div>
          )}
        </div>
      )}

      {/* ID list */}
      <div className="prop-multi-section">
        <div className="prop-multi-section-title">IDs</div>
        {shown.map((id) => (
          <div className="prop-row" key={id}>
            <span className="prop-key">#{id}</span>
          </div>
        ))}
        {overflow > 0 && (
          <div className="prop-multi-overflow">+{overflow} more</div>
        )}
      </div>
    </div>
  );
}

/** Lazy-loads and renders connected elements, material layers, and openings. */
function RelationsSection({ elementId }: { elementId: number }) {
  const selectElement = useStore((s) => s.selectElement);
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ElementRelations | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    setOpen(false);
  }, [elementId]);

  function handleToggle() {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (data) return;
    setLoading(true);
    api.getElementRelations(elementId)
      .then((d) => setData(d))
      .catch(() => setError('Could not load relations.'))
      .finally(() => setLoading(false));
  }

  const hasMaterial = data && data.material.material_type !== 'none';
  const hasConnections = data && data.connections.count > 0;
  const hasOpenings = data && data.openings.count > 0;
  const hasAny = hasMaterial || hasConnections || hasOpenings;

  return (
    <div className="prop-group">
      <button
        className="prop-group-head"
        onClick={handleToggle}
        aria-expanded={open}
      >
        <span className="prop-group-caret">
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={10} />
        </span>
        <span className="prop-group-title">Relations</span>
        <span className="prop-group-count prop-relations-badge">
          {data
            ? (data.connections.count + data.openings.count + (hasMaterial ? 1 : 0))
            : '…'}
        </span>
      </button>
      {open && (
        <div className="prop-group-body">
          {loading && <div className="prop-relations-loading">Loading…</div>}
          {error && <div className="prop-relations-error">{error}</div>}
          {data && !hasAny && (
            <div className="prop-relations-empty">No relations found.</div>
          )}
          {hasMaterial && (
            <div className="prop-relations-block">
              <div className="prop-relations-subhead">Material</div>
              {data!.material.name && (
                <div className="prop-row">
                  <span className="prop-key">Name</span>
                  <span className="prop-value">{data!.material.name}</span>
                </div>
              )}
              {data!.material.layer_set_name && (
                <div className="prop-row">
                  <span className="prop-key">Layer set</span>
                  <span className="prop-value">{data!.material.layer_set_name}</span>
                </div>
              )}
              {data!.material.layers.map((l, i) => (
                <div className="prop-row" key={i}>
                  <span className="prop-key">{l.name}</span>
                  <span className="prop-value">{l.thickness_mm} mm</span>
                </div>
              ))}
              {data!.material.total_thickness_mm != null && (
                <div className="prop-row prop-row-total">
                  <span className="prop-key">Total</span>
                  <span className="prop-value">{data!.material.total_thickness_mm} mm</span>
                </div>
              )}
            </div>
          )}
          {hasConnections && (
            <div className="prop-relations-block">
              <div className="prop-relations-subhead">Connected walls ({data!.connections.count})</div>
              {data!.connections.connected_elements.map((c) => (
                <button
                  key={c.id}
                  className="prop-relations-item"
                  onClick={() => selectElement(c.id)}
                  title={`Select ${c.name}`}
                >
                  <span className="prop-relations-itype">{c.ifc_type.replace('IfcWallStandardCase', 'Wall')}</span>
                  <span className="prop-relations-name">{c.name}</span>
                  {c.connection_type && (
                    <span className="prop-relations-conn">{c.connection_type}</span>
                  )}
                </button>
              ))}
            </div>
          )}
          {hasOpenings && (
            <div className="prop-relations-block">
              <div className="prop-relations-subhead">Hosted openings ({data!.openings.count})</div>
              {data!.openings.openings.map((o) => (
                <button
                  key={o.id}
                  className="prop-relations-item"
                  onClick={() => selectElement(o.id)}
                  title={`Select ${o.name}`}
                >
                  <span className="prop-relations-itype">{o.ifc_type.replace('Ifc', '')}</span>
                  <span className="prop-relations-name">{o.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Coerce an edited string back toward the original value's type so a bool
 *  property stays a bool and a number stays a number when it round-trips. */
function coerceLike(next: string, original: unknown): string | number | boolean {
  const t = next.trim();
  if (typeof original === 'boolean') {
    const l = t.toLowerCase();
    if (l === 'true') return true;
    if (l === 'false') return false;
    return t;
  }
  if (typeof original === 'number') {
    const n = Number(t);
    return t !== '' && Number.isFinite(n) ? n : t;
  }
  return t;
}

/** Pre-commit validation matching coerceLike's coercion rules: reject drafts
 *  that would silently change a value's type instead of shipping them to the
 *  backend. Returns an error string or null when the draft is acceptable. */
export function validateDraft(
  next: string,
  original: unknown,
  { required = false }: { required?: boolean } = {},
): string | null {
  const t = next.trim();
  if (required && t === '') return 'Value cannot be empty';
  if (typeof original === 'boolean') {
    const l = t.toLowerCase();
    if (l !== 'true' && l !== 'false') return 'Enter true or false';
    return null;
  }
  if (typeof original === 'number') {
    if (t === '' || !Number.isFinite(Number(t))) return 'Enter a number';
    return null;
  }
  return null;
}

/** A property value that becomes an inline text input in Edit mode. Commits on
 *  Enter or blur; Escape cancels. The single commit path is onBlur (Enter and
 *  Escape both blur), so the operation never fires twice. While the operation
 *  is in flight the field is disabled (a fast second edit cannot race the
 *  first); a type-invalid draft or a failed op shows an inline error and keeps
 *  the field open for correction. */
function EditableText({
  value,
  original,
  required = false,
  onCommit,
}: {
  value: string;
  /** The pre-edit typed value; drives type validation (bool/number/string). */
  original?: unknown;
  /** Reject empty drafts (element names). */
  required?: boolean;
  onCommit: (next: string) => void | Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const skipBlur = useRef(false);

  useEffect(() => { setDraft(value); }, [value]);

  const commit = async () => {
    if (skipBlur.current) {
      skipBlur.current = false;
      setEditing(false);
      setError(null);
      return;
    }
    const next = draft.trim();
    if (next === value.trim()) { setEditing(false); setError(null); return; }
    const invalid = validateDraft(next, original ?? value, { required });
    if (invalid) {
      // Keep the editor open so the user can fix the draft; blur happened, so
      // re-focus is up to them, but the error and draft are preserved.
      setError(invalid);
      return;
    }
    setError(null);
    setPending(true);
    try {
      await onCommit(next);
      setEditing(false);
    } finally {
      setPending(false);
    }
  };

  if (!editing) {
    return (
      <span
        className="prop-value"
        role="button"
        tabIndex={0}
        title="Click to edit"
        style={{ cursor: 'text', borderBottom: '1px dashed var(--border, #444)' }}
        onClick={() => { setDraft(value); setError(null); setEditing(true); }}
        onKeyDown={(e) => { if (e.key === 'Enter') { setDraft(value); setError(null); setEditing(true); } }}
      >
        {value === '' ? '-' : value}
      </span>
    );
  }

  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', maxWidth: '52%' }}>
      <input
        className="prop-value"
        autoFocus
        value={draft}
        disabled={pending}
        aria-invalid={error !== null}
        onChange={(e) => { setDraft(e.target.value); if (error) setError(null); }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
          else if (e.key === 'Escape') {
            e.preventDefault();
            skipBlur.current = true;
            setDraft(value);
            e.currentTarget.blur();
          }
        }}
        style={{
          font: 'inherit', color: 'inherit', textAlign: 'right',
          background: 'var(--surface, #1a1a1a)',
          border: `1px solid ${error ? 'var(--danger, #c55)' : 'var(--accent, #4a7)'}`,
          borderRadius: 3,
          padding: '0 4px', width: '100%',
          opacity: pending ? 0.6 : 1,
        }}
      />
      {error && (
        <span style={{ fontSize: 10, color: 'var(--danger, #c55)', paddingTop: 1 }}>{error}</span>
      )}
    </span>
  );
}

export default function PropertiesPanel({ embedded = false }: PropertiesPanelProps = {}) {
  const selectedElementId = useStore((s) => s.selectedElementId);
  const selectedIds = useStore((s) => s.selectedIds);
  const selectedElement = useStore((s) => s.selectedElement);
  const setSelectedElement = useStore((s) => s.setSelectedElement);
  const selectElement = useStore((s) => s.selectElement);
  const editMode = useStore((s) => s.editMode);
  const editModeAvailable = useStore((s) => s.editModeAvailable);
  const toggleEditMode = useStore((s) => s.toggleEditMode);
  const applyOperation = useStore((s) => s.applyOperation);
  const detailRefreshSerial = useStore((s) => s.detailRefreshSerial);
  // Inline editing is offered only when the backend reports editing enabled
  // (runtime /edit-state probe), we're in Edit mode, and a backend exists
  // (no authoring in the browser-only build).
  const editable = editMode && editModeAvailable && !BROWSER_ONLY;
  const [propertyError, setPropertyError] = useState<string | null>(null);
  const [loadingElementId, setLoadingElementId] = useState<number | null>(null);

  useEffect(() => {
    if (selectedElementId === null) {
      setSelectedElement(null);
      setLoadingElementId(null);
      setPropertyError(null);
      return;
    }
    // K - synchronous cache peek: repeat selections render instantly, no
    // 32 ms debounce and no skeleton flash. The viewer's pointer-down
    // pre-resolve + click-commit prefetch make this the common case.
    const cachedDetail = modelService.peekElement(selectedElementId);
    if (cachedDetail) {
      if (cachedDetail.id !== selectedElementId) {
        selectElement(cachedDetail.id);
        return;
      }
      setSelectedElement(cachedDetail);
      setLoadingElementId(null);
      setPropertyError(null);
      return;
    }

    let cancelled = false;
    setSelectedElement(null);
    setLoadingElementId(selectedElementId);
    setPropertyError(null);

    // In the browser-only build the metadata worker is the ONLY properties
    // source; when it died (OOM / timeout on huge files) say so instead of
    // the generic per-element message.
    const unavailableMessage = () =>
      BROWSER_ONLY && modelService.metadataFailed
        ? 'Property extraction failed for this model - see the Activity log. The desktop app handles larger files.'
        : 'Properties are unavailable for this element.';

    const fetchNow = () => {
      modelService.getElement(selectedElementId)
        .then((el) => {
          if (cancelled) return;
          // The metadata worker walks up to the owning IfcProduct when the
          // raycast hit a non-IfcRoot entity (representation / geometry item).
          // Resync the store so the tree highlight, scroll-to-selected, and
          // viewer focus land on the resolved product instead of the inner
          // representation. The follow-up render reuses the cached payload
          // (modelService.elementDetailCache), so no extra worker round-trip.
          if (el && el.id !== selectedElementId) {
            selectElement(el.id);
            return;
          }
          setSelectedElement(el);
          setLoadingElementId(null);
          setPropertyError(el ? null : unavailableMessage());
        })
        .catch(() => {
          if (cancelled) return;
          setSelectedElement(null);
          setLoadingElementId(null);
          setPropertyError(unavailableMessage());
        });
    };

    // The debounce exists for rapid selection stepping (keyboard /
    // tree arrows), where it coalesces fetch starts. When the viewer's
    // pointer prefetch already has THIS id's fetch in flight, the debounce
    // only delays attaching to that promise (the in-flight dedupe makes the
    // immediate call free), so skip it and shave up to 32 ms off the first
    // properties paint.
    let timer: number | null = null;
    if (modelService.hasElementInFlight(selectedElementId)) {
      fetchNow();
    } else {
      timer = window.setTimeout(fetchNow, PROPERTY_FETCH_DELAY_MS);
    }
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
    // detailRefreshSerial: bumped after an edit invalidates the selected
    // element's cached detail - the id is unchanged, so without it this
    // effect would never re-fetch and the panel would blank out post-commit.
  }, [selectedElementId, setSelectedElement, selectElement, detailRefreshSerial]);

  const identityRows = useMemo(() => {
    if (!selectedElement) return [];
    const rows: Array<{ k: string; v: string | number | null | undefined }> = [
      { k: 'ID',        v: `#${selectedElement.id}` },
      { k: 'GlobalId',  v: selectedElement.global_id },
      { k: 'Name',      v: selectedElement.name || '-' },
      { k: 'Type',      v: selectedElement.ifc_type },
    ];
    if (selectedElement.predefined_type) rows.push({ k: 'Predefined', v: selectedElement.predefined_type });
    if (selectedElement.object_type) rows.push({ k: 'ObjectType', v: selectedElement.object_type });
    if (selectedElement.description) rows.push({ k: 'Description', v: selectedElement.description });
    if (selectedElement.tag) rows.push({ k: 'Tag', v: selectedElement.tag });
    if (selectedElement.storey) rows.push({ k: 'Storey',   v: selectedElement.storey });
    if (selectedElement.material) rows.push({ k: 'Material', v: selectedElement.material });
    if (selectedElement.relating_type) rows.push({ k: 'Type Def', v: selectedElement.relating_type });
    return rows;
  }, [selectedElement]);

  const containerStyle: React.CSSProperties = embedded
    ? { flex: 1, minHeight: 0 }
    : { flex: '0 0 auto', maxHeight: '50%' };

  return (
    <div className="panel" style={containerStyle}>
      {!embedded && <div className="panel-header">Properties</div>}
      <div className="panel-body prop-panel-body">
        {editModeAvailable && !BROWSER_ONLY && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '2px 0 6px' }}>
            <button
              type="button"
              onClick={() => toggleEditMode()}
              title={editMode ? 'Editing enabled - click a value to edit it' : 'Enable editing'}
              style={{
                fontSize: 11, padding: '2px 8px', borderRadius: 4, cursor: 'pointer',
                border: '1px solid var(--border, #333)',
                background: editMode ? 'var(--accent, #4a7)' : 'transparent',
                color: editMode ? '#fff' : 'var(--text-muted, #999)',
              }}
            >
              {editMode ? '● Editing' : '○ Edit'}
            </button>
          </div>
        )}
        {selectedIds.length > 1 ? (
          <MultiSelectPanel ids={selectedIds} />
        ) : !selectedElement ? (
          loadingElementId != null && !propertyError ? (
            <PropertiesSkeleton />
          ) : (
            <div className="prop-empty-state">
              <Icon name="info" size={24} />
              {propertyError && <p>{propertyError}</p>}
              <p hidden={propertyError !== null}>
                Select an element in the viewport or outliner to see its properties.
              </p>
            </div>
          )
        ) : (
          <>
            <PropGroup title="Identity" count={identityRows.length}>
              {identityRows.map(({ k, v }) => (
                <div className="prop-row" key={k}>
                  <span className="prop-key">{k}</span>
                  {editable && k === 'Name' ? (
                    <EditableText
                      value={selectedElement.name ?? ''}
                      required
                      onCommit={(next) =>
                        applyOperation('set_name', {
                          element_id: selectedElement.id,
                          new_name: next,
                        })
                      }
                    />
                  ) : (
                    <span className="prop-value">{v as string}</span>
                  )}
                </div>
              ))}
            </PropGroup>

            {Object.keys(selectedElement.quantities).length > 0 && (
              <PropGroup
                title="Quantities"
                count={Object.keys(selectedElement.quantities).length}
              >
                {Object.entries(selectedElement.quantities).map(([k, v]) => (
                  <div className="prop-row" key={k}>
                    <span className="prop-key">{k}</span>
                    <span className="prop-value">
                      {typeof v === 'number' ? v.toFixed(3) : String(v)}
                    </span>
                  </div>
                ))}
              </PropGroup>
            )}

            {selectedElement.property_sets.map((pset) => (
              <PropGroup
                key={pset.name}
                title={pset.name}
                count={Object.keys(pset.properties).length}
                defaultOpen={true}
              >
                {Object.entries(pset.properties).map(([k, v]) => (
                  <div className="prop-row" key={k}>
                    <span className="prop-key">{k}</span>
                    {editable ? (
                      <EditableText
                        value={v === null ? '' : String(v)}
                        original={v}
                        onCommit={(next) =>
                          applyOperation('set_property', {
                            element_id: selectedElement.id,
                            property_name: k,
                            new_value: coerceLike(next, v),
                            pset_name: pset.name,
                          })
                        }
                      />
                    ) : (
                      <span className="prop-value">{v === null ? '-' : String(v)}</span>
                    )}
                  </div>
                ))}
              </PropGroup>
            ))}

            {!BROWSER_ONLY && <RelationsSection elementId={selectedElement.id} />}
          </>
        )}
      </div>
    </div>
  );
}
