/**
 * Knowledge section - Chat Manager tab for the AI's reference desk (plan E4).
 *
 * Two knowledge sources back the agent's "Read - Knowledge" tools:
 *
 *   1. IfcOpenShell API reference - a local index built from the *installed*
 *      package's docstrings (one document per API domain). Queried by the
 *      `get_docs` tool with source 'ifcopenshell'. A fresh install ships with
 *      an EMPTY index: until the user clicks "Fetch IfcOpenShell API docs"
 *      here (or runs scripts/fetch_reference_docs.py), get_docs returns
 *      `not_indexed`. This tab surfaces that state and the fix.
 *
 *   2. bSDD (buildingSMART Data Dictionary) - a live web API consulted by
 *      bsdd_search / bsdd_get_class / bsdd_get_properties with an automatic
 *      6-hour server-side cache. Nothing to fetch or manage; the card below
 *      is a static explainer.
 */

import { useCallback, useEffect, useState } from 'react';
import Icon from '../ui/Icon';
import {
  getReferenceDocsStatus,
  fetchReferenceDocs,
  type ReferenceDocsStatus,
  type ReferenceDocsSemanticStatus,
} from '../../services/api';
import './knowledgeSection.css';

// ---------------------------------------------------------------------------
// Pure formatting helpers (unit-tested in __tests__/knowledgeSection.test.ts)
// ---------------------------------------------------------------------------

export interface FetchOutcome {
  ok: boolean;
  message: string;
}

/** Turn the raw POST /chat/reference-docs/fetch payload into a one-line
 *  outcome message. Success shape: { ok, indexed, errors, domains,
 *  ifcopenshell_version, source }; failure: { ok: false, error, indexed: 0 }. */
export function summarizeFetchResult(raw: Record<string, unknown>): FetchOutcome {
  if (raw.ok !== true) {
    const err = typeof raw.error === 'string' && raw.error ? raw.error : 'Fetch failed';
    return { ok: false, message: err };
  }
  const indexed = typeof raw.indexed === 'number' ? raw.indexed : 0;
  const errors = typeof raw.errors === 'number' ? raw.errors : 0;
  const version =
    typeof raw.ifcopenshell_version === 'string' && raw.ifcopenshell_version
      ? raw.ifcopenshell_version
      : null;
  let msg = `Indexed ${indexed} API domain${indexed === 1 ? '' : 's'}`;
  if (version) msg += ` from IfcOpenShell v${version}`;
  if (errors > 0) msg += ` (${errors} domain${errors === 1 ? '' : 's'} failed)`;
  return { ok: true, message: msg };
}

/** "ifcopenshell.api.wall" -> "wall" (chip label for an indexed domain doc). */
export function domainLabel(docName: string | null | undefined): string {
  if (!docName) return '?';
  const parts = docName.split('.');
  return parts[parts.length - 1] || docName;
}

/** Human label for the search mode the index will use. */
export function searchModeLabel(semantic: ReferenceDocsSemanticStatus): string {
  if (semantic.built) return 'Hybrid (semantic + keyword)';
  if (semantic.available) return 'Keyword (BM25) - semantic index not built yet';
  return 'Keyword (BM25) only';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  /** Last known status, owned by ChatManagerPanel so the nav tile count and
   *  this tab stay in sync. Null = not loaded yet. */
  status: ReferenceDocsStatus | null;
  onStatusChange: (s: ReferenceDocsStatus) => void;
}

export default function KnowledgeSection({ status, onStatusChange }: Props) {
  const [fetching, setFetching] = useState(false);
  const [fetchResult, setFetchResult] = useState<FetchOutcome | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  // Revalidate on open - the endpoint is a cheap local read, and this also
  // recovers when the panel-level fetch failed (backend restart etc.).
  useEffect(() => {
    getReferenceDocsStatus()
      .then((s) => { setStatusError(null); onStatusChange(s); })
      .catch((err: unknown) => {
        setStatusError(err instanceof Error ? err.message : String(err));
      });
    // onStatusChange is a useState setter in the parent - stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onFetch = useCallback(async () => {
    setFetching(true);
    setFetchResult(null);
    try {
      const raw = await fetchReferenceDocs('ifcopenshell');
      setFetchResult(summarizeFetchResult(raw));
    } catch (err: unknown) {
      setFetchResult({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // Refresh the status card (and the nav tile) whatever happened.
      try {
        onStatusChange(await getReferenceDocsStatus());
        setStatusError(null);
      } catch { /* keep the previous status */ }
      setFetching(false);
    }
  }, [onStatusChange]);

  const indexed = status?.indexed === true;
  const domains = (status?.documents ?? [])
    .map(domainLabel)
    .filter((d) => d !== '?')
    .sort();

  return (
    <div className="cm-knowledge">
      <div className="cm-knowledge-header">
        <h3 className="cm-knowledge-title">Knowledge</h3>
        <p className="cm-knowledge-hint">
          Reference material the AI consults through its knowledge tools before
          answering or writing code - separate from your uploaded documents in
          the <strong>Documents</strong> tab.
        </p>
      </div>

      {/* --- IfcOpenShell API reference index --------------------------- */}
      <div className="cm-knowledge-card">
        <div className="cm-knowledge-card-head">
          <span className={`cm-knowledge-dot${indexed ? ' cm-knowledge-dot--on' : ''}`} />
          <div className="cm-knowledge-card-title-block">
            <span className="cm-knowledge-card-title">IfcOpenShell API reference</span>
            <span className="cm-knowledge-card-status">
              {status === null ? 'checking…' : indexed ? 'indexed' : 'not indexed'}
            </span>
          </div>
          <button
            type="button"
            className="cm-pill-btn cm-pill-btn--primary"
            disabled={fetching}
            onClick={onFetch}
            title="Index the installed IfcOpenShell package's API docstrings (takes a few seconds)"
          >
            <Icon name="refresh" size={12} className={fetching ? 'cm-knowledge-spin' : undefined} />
            {fetching
              ? 'Fetching…'
              : indexed
                ? 'Re-fetch IfcOpenShell API docs'
                : 'Fetch IfcOpenShell API docs'}
          </button>
        </div>

        <p className="cm-knowledge-card-desc">
          Local index of the installed IfcOpenShell Python API docstrings,
          grouped per domain (<code>wall</code>, <code>pset</code>,{' '}
          <code>geometry</code>, …). The <code>get_docs</code> tool consults it
          before the AI writes IfcOpenShell code, so the calls match the
          installed version.
        </p>

        {statusError && status === null ? (
          <div className="cm-knowledge-msg cm-knowledge-msg--err">
            <Icon name="alert-circle" size={12} /> Could not load index status: {statusError}
          </div>
        ) : status !== null && !indexed ? (
          <div className="cm-knowledge-warn">
            <Icon name="alert-circle" size={14} strokeWidth={1.8} />
            <div>
              <div className="cm-knowledge-warn-title">Not indexed yet</div>
              <div className="cm-knowledge-warn-text">
                The <code>get_docs</code> tool will return{' '}
                <code>not_indexed</code> until you fetch. Click{' '}
                <strong>Fetch IfcOpenShell API docs</strong> above to build the
                index (a few seconds, no network needed - it reads the installed
                package).
              </div>
            </div>
          </div>
        ) : status !== null ? (
          <>
            <div className="cm-skills-chips cm-knowledge-chips">
              <span className="cm-skills-chip">
                <span className="cm-skills-chip-label">API domains</span>
                <span className="cm-skills-chip-val">{status.doc_count}</span>
              </span>
              <span className="cm-skills-chip">
                <span className="cm-skills-chip-label">Chunks</span>
                <span className="cm-skills-chip-val">{status.semantic.chunk_count}</span>
              </span>
              <span className="cm-skills-chip">
                <span className="cm-skills-chip-label">Search</span>
                <span className="cm-skills-chip-val">{searchModeLabel(status.semantic)}</span>
              </span>
            </div>
            {domains.length > 0 && (
              <details className="cm-knowledge-domains">
                <summary>Show {domains.length} indexed domain{domains.length === 1 ? '' : 's'}</summary>
                <div className="cm-knowledge-domain-list">
                  {domains.map((d) => (
                    <code key={d} className="cm-knowledge-domain">{d}</code>
                  ))}
                </div>
              </details>
            )}
          </>
        ) : (
          <div className="cm-loading"><Icon name="refresh" size={14} /> Loading status…</div>
        )}

        {fetchResult && (
          <div
            className={`cm-knowledge-msg ${fetchResult.ok ? 'cm-knowledge-msg--ok' : 'cm-knowledge-msg--err'}`}
            role="status"
          >
            <Icon name={fetchResult.ok ? 'check' : 'alert-circle'} size={12} />
            {fetchResult.message}
          </div>
        )}
      </div>

      {/* --- bSDD live API ----------------------------------------------- */}
      <div className="cm-knowledge-card">
        <div className="cm-knowledge-card-head">
          <span className="cm-knowledge-dot cm-knowledge-dot--on" />
          <div className="cm-knowledge-card-title-block">
            <span className="cm-knowledge-card-title">bSDD - buildingSMART Data Dictionary</span>
            <span className="cm-knowledge-card-status">live API</span>
          </div>
        </div>
        <p className="cm-knowledge-card-desc">
          Classification and property lookups (<code>bsdd_search</code>,{' '}
          <code>bsdd_get_class</code>, <code>bsdd_get_properties</code>) query
          the live buildingSMART bSDD web API directly, with automatic 6-hour
          caching of results on the backend. Nothing to fetch or manage here -
          it just needs an internet connection.
        </p>
      </div>

      <div className="cm-knowledge-footer">
        Both sources feed the agent's <code>Read - Knowledge</code> tools. You can
        also rebuild the IfcOpenShell index from a terminal with{' '}
        <code>python scripts/fetch_reference_docs.py</code>.
      </div>
    </div>
  );
}
