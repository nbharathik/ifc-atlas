import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store/useStore';
import { BROWSER_ONLY } from '../../config/featureFlags';
import Icon from '../ui/Icon';
import {
  collectAllFailingIds,
  deleteIdsEntry,
  failingElementLabel,
  fetchIdsLibrary,
  fetchLastIdsRun,
  formatIdsDate,
  idsEntryLabel,
  idsErrorMessage,
  idsLastCsvUrl,
  isIdsFileName,
  specCountLabel,
  specFailingIds,
  summarizeIdsReport,
  truncationNote,
  uploadIdsFile,
  validateIdsEntry,
  type IdsLastRun,
  type IdsLibraryEntry,
  type IdsSpecStatus,
  type IdsSpecificationResult,
} from '../../services/features/ids';
import './idsPanel.css';

const STATUS_LABEL: Record<IdsSpecStatus, string> = {
  passed: 'Passed',
  failed: 'Failed',
  no_applicable: 'N/A',
};

interface SpecCardProps {
  spec: IdsSpecificationResult;
  onSelectElement: (id: number) => void;
  onShowFailing: (ids: number[]) => void;
}

function SpecCard({ spec, onSelectElement, onShowFailing }: SpecCardProps) {
  const [expanded, setExpanded] = useState(false);

  const failingIds = specFailingIds(spec);
  const canExpand = spec.status === 'failed' && spec.failing_elements.length > 0;

  return (
    <div className={`ids-panel-spec ids-panel-spec--${spec.status}`}>
      <div className="ids-panel-spec-header-row">
        <button
          className="ids-panel-spec-header"
          onClick={() => canExpand && setExpanded((e) => !e)}
          aria-expanded={canExpand ? expanded : undefined}
          disabled={!canExpand}
        >
          <span className={`ids-panel-pill ids-panel-pill--${spec.status}`}>
            {STATUS_LABEL[spec.status]}
          </span>
          <span className="ids-panel-spec-name" title={spec.name}>
            {spec.name}
          </span>
          {canExpand && (
            <span className="ids-panel-chevron" aria-hidden="true">
              {expanded ? '▾' : '▸'}
            </span>
          )}
        </button>
        {failingIds.length > 0 && (
          <button
            className="ids-panel-spec-show"
            title={`Highlight ${failingIds.length} failing element${failingIds.length !== 1 ? 's' : ''} in the viewer`}
            onClick={() => onShowFailing(failingIds)}
          >
            Show failing in viewer
          </button>
        )}
      </div>

      <div className="ids-panel-spec-counts">
        applied to {spec.applied_to} · passed {spec.passed} · failed {spec.failed}
      </div>
      {spec.description && <p className="ids-panel-spec-desc">{spec.description}</p>}

      {expanded && (
        <ul className="ids-panel-el-list" aria-label={`Failing elements of ${spec.name}`}>
          {spec.failing_elements.map((el, idx) => (
            <li key={`${el.id}-${idx}`}>
              <button
                className="ids-panel-el-row"
                title="Select this element in the viewer"
                onClick={() => onSelectElement(el.id)}
              >
                <span className="ids-panel-el-name">{failingElementLabel(el)}</span>
                <span className="ids-panel-el-type">{el.ifc_type}</span>
                <span className="ids-panel-el-facet">{el.facet_type}</span>
                <span className="ids-panel-el-reason">{el.reason}</span>
              </button>
            </li>
          ))}
          {spec.failing_truncated && (
            <li className="ids-panel-trunc-note">
              {truncationNote(spec.failing_elements.length)}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

export default function IdsPanel({ onClose, embedded = false }: { onClose: () => void; embedded?: boolean }) {
  const { modelLoaded, selectElement, setHighlightedIds, setIsolatedIds, clearVisibility } =
    useStore(
      useShallow((s) => ({
        modelLoaded: s.modelLoaded,
        selectElement: s.selectElement,
        setHighlightedIds: s.setHighlightedIds,
        setIsolatedIds: s.setIsolatedIds,
        clearVisibility: s.clearVisibility,
      })),
    );

  const [library, setLibrary] = useState<IdsLibraryEntry[] | null>(null);
  const [run, setRun] = useState<IdsLastRun | null>(null);
  const [validatingId, setValidatingId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load the saved-spec library on mount (model-independent).
  useEffect(() => {
    if (BROWSER_ONLY) return;
    let cancelled = false;
    void (async () => {
      try {
        const entries = await fetchIdsLibrary();
        if (!cancelled) setLibrary(entries);
      } catch (e) {
        if (!cancelled) {
          setLibrary([]);
          setError(idsErrorMessage(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Restore the cached report for the current model fingerprint. A run the
  // user started before this resolves must win, hence the prev ?? guard.
  useEffect(() => {
    if (BROWSER_ONLY || !modelLoaded) return;
    let cancelled = false;
    void (async () => {
      try {
        const last = await fetchLastIdsRun();
        if (!cancelled && last) setRun((prev) => prev ?? last);
      } catch {
        // Best-effort restore - a fresh run is always one click away.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [modelLoaded]);

  // A cached report is scoped to a model fingerprint; drop it on unload so
  // stale express ids can't drive selection against the next model.
  useEffect(() => {
    if (!modelLoaded) setRun(null);
  }, [modelLoaded]);

  const handleRun = useCallback(
    async (idsId: string) => {
      if (!modelLoaded) return;
      setValidatingId(idsId);
      setError(null);
      try {
        const result = await validateIdsEntry(idsId);
        setRun({ idsId: result.ids_id, ranAt: result.ran_at, report: result });
      } catch (e) {
        setError(idsErrorMessage(e));
      } finally {
        setValidatingId(null);
      }
    },
    [modelLoaded],
  );

  const handleFile = useCallback(
    async (file: File | null) => {
      if (!file) return;
      if (!isIdsFileName(file.name)) {
        setError(`"${file.name}" is not an .ids or .xml file.`);
        return;
      }
      setUploading(true);
      setError(null);
      try {
        const entry = await uploadIdsFile(file);
        // Duplicate uploads return the existing entry: replace, don't append.
        setLibrary((prev) => [entry, ...(prev ?? []).filter((e) => e.id !== entry.id)]);
        if (modelLoaded) await handleRun(entry.id);
      } catch (e) {
        setError(idsErrorMessage(e));
      } finally {
        setUploading(false);
      }
    },
    [modelLoaded, handleRun],
  );

  const handleDelete = useCallback(async (idsId: string) => {
    setError(null);
    try {
      await deleteIdsEntry(idsId);
      setLibrary((prev) => (prev ?? []).filter((e) => e.id !== idsId));
    } catch (e) {
      setError(idsErrorMessage(e));
    }
  }, []);

  const handleExportCsv = useCallback(() => {
    const anchor = document.createElement('a');
    anchor.href = idsLastCsvUrl();
    anchor.download = 'ids-validation.csv';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }, []);

  const handleShowFailing = useCallback(
    (ids: number[]) => setHighlightedIds(ids),
    [setHighlightedIds],
  );

  const handleClear = useCallback(() => {
    clearVisibility();
    setHighlightedIds([]);
  }, [clearVisibility, setHighlightedIds]);

  const allFailingIds = useMemo(
    () => (run ? collectAllFailingIds(run.report) : []),
    [run],
  );
  const counts = useMemo(() => (run ? summarizeIdsReport(run.report) : null), [run]);

  const caption = run
    ? [
        run.report.ids_title,
        run.report.engine ? `engine: ${run.report.engine}` : null,
        run.ranAt ? `ran ${formatIdsDate(run.ranAt, true)}` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  return (
    <div className="ids-panel-overlay">
      <div className="ids-panel" role="region" aria-label="IDS validation">
        <div className="ids-panel-header">
          {!embedded && (
            <span className="ids-panel-title fpanel-title">
              <span className="fpanel-title-icon">
                <Icon name="list-checks" size={14} />
              </span>
              IDS validation
            </span>
          )}
          <div className="ids-panel-actions">
            <button
              className="ids-panel-btn"
              onClick={handleExportCsv}
              disabled={!run}
              title={run ? 'Download the last run as CSV' : 'Run a validation first'}
            >
              Export CSV
            </button>
            {!embedded && (
              <button
                className="ids-panel-btn fpanel-icon-btn"
                onClick={onClose}
                aria-label="Close IDS validation panel"
              >
                <Icon name="x" size={14} />
              </button>
            )}
          </div>
        </div>

        {BROWSER_ONLY ? (
          <p className="ids-panel-empty">This feature needs the desktop backend.</p>
        ) : (
          <div className="ids-panel-body">
            {error && (
              <div className="ids-panel-error" role="alert">
                {error}
              </div>
            )}

            <div className="ids-panel-section-label">Library</div>

            <div
              className={`ids-panel-dropzone${dragOver ? ' ids-panel-dropzone--over' : ''}`}
              role="button"
              tabIndex={0}
              aria-label="Upload an IDS specification"
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                void handleFile(e.dataTransfer.files[0] ?? null);
              }}
            >
              {uploading
                ? 'Uploading…'
                : 'Drop an .ids or .xml spec here, or click to browse'}
            </div>
            <input
              ref={fileInputRef}
              className="ids-panel-file-input"
              type="file"
              accept=".ids,.xml"
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                e.target.value = '';
                void handleFile(file);
              }}
            />

            {library === null && !error && (
              <p className="ids-panel-quiet">Loading saved specs…</p>
            )}
            {library !== null && library.length === 0 && (
              <p className="ids-panel-quiet">No saved specs yet.</p>
            )}
            {library !== null && library.length > 0 && (
              <ul className="ids-panel-entries" aria-label="Saved IDS specifications">
                {library.map((entry) => (
                  <li key={entry.id} className="ids-panel-entry">
                    <div className="ids-panel-entry-info">
                      <span className="ids-panel-entry-title" title={entry.filename}>
                        {idsEntryLabel(entry)}
                      </span>
                      <span className="ids-panel-entry-meta">
                        {specCountLabel(entry.specifications_count)} · added{' '}
                        {formatIdsDate(entry.added_at)}
                      </span>
                    </div>
                    <div className="ids-panel-entry-actions">
                      <button
                        className="ids-panel-btn ids-panel-btn--accent"
                        onClick={() => void handleRun(entry.id)}
                        disabled={validatingId !== null || !modelLoaded}
                        title={
                          modelLoaded
                            ? 'Validate the loaded model against this spec'
                            : 'Load an IFC model first'
                        }
                      >
                        {validatingId === entry.id ? (
                          <span className="ids-panel-spinner" aria-label="Validating" />
                        ) : (
                          'Run'
                        )}
                      </button>
                      <button
                        className="ids-panel-delete fpanel-icon-btn"
                        onClick={() => void handleDelete(entry.id)}
                        title="Delete this spec"
                        aria-label={`Delete ${idsEntryLabel(entry)}`}
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <div className="ids-panel-section-label">Results</div>

            {!modelLoaded && <p className="ids-panel-quiet">Load an IFC model first.</p>}

            {modelLoaded && !run && (
              <p className="ids-panel-quiet">
                Upload a spec or run a saved one to validate the model.
              </p>
            )}

            {modelLoaded && run && counts && (
              <>
                <div className="ids-panel-summary" aria-label="Validation summary">
                  <span className="ids-panel-stat ids-panel-stat--passed">
                    {counts.passed} passed
                  </span>
                  <span className="ids-panel-stat ids-panel-stat--failed">
                    {counts.failed} failed
                  </span>
                  <span className="ids-panel-stat ids-panel-stat--na">
                    {counts.noApplicable} not applicable
                  </span>
                </div>
                {caption && <p className="ids-panel-caption">{caption}</p>}

                <div className="ids-panel-global-actions">
                  <button
                    className="ids-panel-btn"
                    onClick={() => setHighlightedIds(allFailingIds)}
                    disabled={allFailingIds.length === 0}
                    title="Highlight every failing element"
                  >
                    Show all failing
                  </button>
                  <button
                    className="ids-panel-btn"
                    onClick={() => setIsolatedIds(allFailingIds)}
                    disabled={allFailingIds.length === 0}
                    title="Hide everything except the failing elements"
                  >
                    Isolate failing
                  </button>
                  <button
                    className="ids-panel-btn"
                    onClick={handleClear}
                    title="Clear highlight and isolation"
                  >
                    Clear
                  </button>
                </div>

                <div className="ids-panel-specs">
                  {run.report.specifications.map((spec, idx) => (
                    <SpecCard
                      key={`${spec.name}-${idx}`}
                      spec={spec}
                      onSelectElement={selectElement}
                      onShowFailing={handleShowFailing}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
