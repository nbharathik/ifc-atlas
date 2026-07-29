import { useState, useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useStore } from '../../store/useStore';
import * as api from '../../services/api';
import { modelService } from '../../services/ifc/ModelService';
import { getClientIfcFlag } from '../../services/ifc/featureFlags';
import { BROWSER_ONLY } from '../../config/featureFlags';
import { parseSearchQuery, type ParsedQuery } from '../../services/ifc/search';
import {
  enrichmentProgressLabel,
  formatElementLabel,
  groupHeaderLabel,
  groupResultsByClass,
  isolateAriaLabel,
  zoomAriaLabel,
} from './searchPanelHelpers';
import type {
  ClassificationGroup,
  ElementSummary,
  PropertySet,
  SearchResult,
  SpatialNode,
} from '../../types/ifc';

// Grouped view spans several IFC classes, so allow more rows than the old
// flat list while keeping the render cheap (plain divs, no virtualization).
const RESULT_LIMIT = 200;

const QUERY_SYNTAX_HELP: { example: string; text: string }[] = [
  { example: 'south wall', text: 'Fuzzy match on name, IFC class, type and GlobalId; every word must match.' },
  { example: 'type:IfcWall', text: 'Exact IFC class. type:wall matches any class containing "wall".' },
  { example: 'storey:"Ground Floor"', text: 'Storey filter; quotes keep spaces together.' },
  { example: 'pset:Pset_WallCommon.IsExternal=true', text: 'Property value inside a named property set.' },
  { example: 'pset:FireRating', text: 'Elements that carry the property in any set.' },
  { example: 'class:Uniclass.Ss_25_10', text: 'Classification system or code (partial match).' },
];

function SearchResultRow({ el, isSelected }: { el: ElementSummary; isSelected: boolean }) {
  // Actions are read through getState() (stable refs in Zustand 5) so rows
  // carry no store subscriptions - same pattern as the sidebar tree rows.
  const handleClick = (e: React.MouseEvent) => {
    const store = useStore.getState();
    if (e.shiftKey) store.toggleSelectId(el.id);
    else store.selectElement(el.id);
  };

  const handleZoom = (e: React.MouseEvent) => {
    e.stopPropagation();
    useStore.getState().zoomToElement(el.id);
  };

  const handleIsolate = (e: React.MouseEvent) => {
    e.stopPropagation();
    const store = useStore.getState();
    store.setIsolatedIds([el.id]);
    store.logActivity({ kind: 'isolate', summary: `Isolated "${el.name || el.ifc_type}" from search` });
  };

  return (
    <div
      className={`tree-node-row ${isSelected ? 'selected' : ''}`}
      onClick={handleClick}
      style={{ cursor: 'pointer' }}
    >
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
        {formatElementLabel(el)}
      </span>
      {el.storey && (
        <span style={{ fontSize: 10, color: 'var(--f-2)', whiteSpace: 'nowrap', flexShrink: 0 }}>
          {el.storey}
        </span>
      )}
      <span className="tree-row-actions" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="tree-row-action-btn"
          title="Zoom to element"
          aria-label={zoomAriaLabel(el)}
          onClick={handleZoom}
        >
          ⊙
        </button>
        <button
          type="button"
          className="tree-row-action-btn"
          title="Isolate"
          aria-label={isolateAriaLabel(el)}
          onClick={handleIsolate}
        >
          ◎
        </button>
      </span>
    </div>
  );
}

export default function SearchPanel() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ElementSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [searching, setSearching] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const setHighlightedIds = useStore((s) => s.setHighlightedIds);
  const setIsolatedIds = useStore((s) => s.setIsolatedIds);
  const modelLoaded = useStore((s) => s.modelLoaded);
  const modelFingerprint = useStore((s) => s.modelFingerprint);
  const selectedElementId = useStore((s) => s.selectedElementId);
  const selectedIds = useStore((s) => s.selectedIds);

  const enrichment = useSyncExternalStore(subscribeEnrichment, getEnrichmentStatus);
  const parsed = useMemo(() => parseSearchQuery(query), [query]);
  const groups = useMemo(() => groupResultsByClass(results), [results]);
  const clientSearchAvailable = getClientIfcFlag('searchClient') && modelService.ready;

  // Bind the lazy enrichment layer to the loaded model; a model change or
  // unload discards it (and cancels an in-progress build).
  useEffect(() => {
    ensureEnrichmentModel(modelLoaded ? modelFingerprint ?? 'loaded-model' : null);
    if (!modelLoaded) {
      setResults([]);
      setTotal(0);
    }
  }, [modelLoaded, modelFingerprint]);

  const doSearch = useCallback(async (parsedQuery: ParsedQuery): Promise<void> => {
    const useClient = getClientIfcFlag('searchClient') && modelService.ready;
    try {
      let res: SearchResult;
      if (useClient) {
        res = await searchModelParsed(parsedQuery, { limit: RESULT_LIMIT });
        if (baseIndexSize() === 0 && !BROWSER_ONLY) {
          // Nothing client-side to search - same backend fallback the panel
          // used before the in-browser index existed.
          res = await api.search(parsedQuery.raw.trim());
        }
      } else if (!BROWSER_ONLY) {
        res = await api.search(parsedQuery.raw.trim());
      } else {
        res = { elements: [], total: 0, query: parsedQuery.raw };
      }
      setResults(res.elements);
      setTotal(res.total);
      setCollapsedGroups(new Set());
      setHighlightedIds(res.elements.map((e) => e.id));
    } catch (err) {
      console.error('Search failed:', err);
      setResults([]);
      setTotal(0);
    }
  }, [setHighlightedIds]);

  // Client-side search is synchronous and cheap, so run on every keystroke
  // after a 60 ms debounce. pset:/class: queries are the exception: they
  // need the lazily-built property index, so the first such keystroke kicks
  // the build and the search runs on Enter or once the index is ready.
  useEffect(() => {
    if (!modelLoaded) return;
    const useClient = getClientIfcFlag('searchClient') && modelService.ready;
    if (!useClient) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setTotal(0);
      setHighlightedIds([]);
      return;
    }
    if (parsed.needsEnrichment) {
      if (enrichment.state === 'idle') void buildEnrichment();
      if (enrichment.state !== 'ready') return;
    }
    const handle = window.setTimeout(() => { void doSearch(parsed); }, 60);
    return () => window.clearTimeout(handle);
  }, [query, parsed, modelLoaded, enrichment.state, doSearch, setHighlightedIds]);

  const handleSearch = useCallback(async () => {
    if (!query.trim() || !modelLoaded) return;
    if (parsed.needsEnrichment && clientSearchAvailable && enrichment.state !== 'ready') {
      // Kick the property index; the debounced effect re-runs the search
      // automatically when the build lands.
      void buildEnrichment();
      return;
    }
    setSearching(true);
    try {
      await doSearch(parsed);
    } finally {
      setSearching(false);
    }
  }, [query, parsed, modelLoaded, clientSearchAvailable, enrichment.state, doSearch]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') void handleSearch();
  };

  const handleClear = () => {
    setQuery('');
    setResults([]);
    setTotal(0);
    setHighlightedIds([]);
  };

  const handleHighlightAll = () => {
    if (results.length === 0) return;
    setHighlightedIds(results.map((e) => e.id));
  };

  const handleIsolateAll = () => {
    if (results.length === 0) return;
    setIsolatedIds(results.map((e) => e.id));
  };

  const toggleGroup = (ifcType: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(ifcType)) next.delete(ifcType);
      else next.add(ifcType);
      return next;
    });
  };

  const isRowSelected = (id: number): boolean =>
    id === selectedElementId || selectedIds.includes(id);

  const waitingForEnrichment =
    parsed.needsEnrichment && clientSearchAvailable && enrichment.state !== 'ready';

  return (
    <div className="panel" style={{ maxHeight: 300, flexShrink: 0 }}>
      <div className="panel-header" style={{ position: 'relative' }}>
        <span>Search</span>
        <button
          className="btn-icon"
          onClick={() => setHelpOpen((o) => !o)}
          title="Query syntax"
          aria-label="Query syntax help"
          aria-expanded={helpOpen}
          style={{ fontSize: 10, padding: '0 5px' }}
        >
          ?
        </button>
        {helpOpen && (
          <div
            role="note"
            aria-label="Search query syntax"
            style={{
              position: 'absolute',
              top: '100%',
              right: 4,
              zIndex: 40,
              width: 232,
              background: 'var(--s-3)',
              border: '1px solid var(--b-2)',
              borderRadius: 'var(--r-md)',
              padding: 'var(--space-2)',
              textTransform: 'none',
              letterSpacing: 'normal',
              fontWeight: 400,
            }}
          >
            {QUERY_SYNTAX_HELP.map((row) => (
              <div key={row.example} style={{ marginBottom: 'var(--space-1)' }}>
                <code style={{ fontSize: 10, color: 'var(--f-0)' }}>{row.example}</code>
                <div style={{ fontSize: 10, color: 'var(--f-2)' }}>{row.text}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="search-bar" style={{ display: 'flex', gap: 4 }}>
        <input
          type="text"
          placeholder='Search... try type:IfcWall or pset:FireRating'
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!modelLoaded}
          style={{ flex: 1 }}
        />
        {query && (
          <button className="btn-icon" onClick={handleClear} title="Clear">
            x
          </button>
        )}
      </div>
      {modelLoaded && (enrichment.state !== 'ready' || enrichment.capped) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 8px', flexShrink: 0 }}>
          {enrichment.state === 'idle' && clientSearchAvailable && (
            <button
              className="btn-icon"
              onClick={() => void buildEnrichment()}
              title="Build the property index so pset: and class: filters work"
              style={{ fontSize: 10, padding: '1px 5px' }}
            >
              Index properties
            </button>
          )}
          {enrichment.state === 'building' && (
            <span style={{ fontSize: 10, color: 'var(--f-2)' }}>
              {enrichmentProgressLabel(enrichment.processed, enrichment.total)}
            </span>
          )}
          {enrichment.state === 'ready' && enrichment.capped && (
            <span style={{ fontSize: 10, color: 'var(--amber)' }}>
              Property index capped at the first {ENRICHMENT_ELEMENT_CAP.toLocaleString('en-US')} elements.
            </span>
          )}
          {enrichment.state === 'unavailable' && parsed.needsEnrichment && (
            <span style={{ fontSize: 10, color: 'var(--f-2)' }}>
              Property data is unavailable for this model.
            </span>
          )}
        </div>
      )}
      <div className="panel-body">
        {!modelLoaded && (
          <p style={{ fontSize: 12, color: 'var(--text-muted)', padding: 8 }}>
            Load an IFC model first
          </p>
        )}
        {modelLoaded && searching && <div className="loading-spinner" style={{ margin: '8px auto' }} />}
        {modelLoaded && !searching && results.length > 0 && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0, flex: 1 }}>
                {total} result{total !== 1 ? 's' : ''}
              </p>
              <button
                className="btn-icon"
                onClick={handleHighlightAll}
                title="Highlight all search results"
                style={{ fontSize: 10, padding: '1px 5px' }}
              >
                Highlight all
              </button>
              <button
                className="btn-icon"
                onClick={handleIsolateAll}
                title="Isolate all search results"
                style={{ fontSize: 10, padding: '1px 5px' }}
              >
                Isolate all
              </button>
            </div>
            {groups.map((group) => {
              const collapsed = collapsedGroups.has(group.ifcType);
              return (
                <div key={group.ifcType}>
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.ifcType)}
                    aria-expanded={!collapsed}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      width: '100%',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      padding: '3px 2px',
                      fontSize: 11,
                      fontWeight: 600,
                      color: 'var(--f-1)',
                      textAlign: 'left',
                    }}
                  >
                    <span style={{ fontSize: 9, color: 'var(--f-2)' }}>{collapsed ? '▸' : '▾'}</span>
                    {groupHeaderLabel(group)}
                  </button>
                  {!collapsed && group.elements.map((el) => (
                    <SearchResultRow key={el.id} el={el} isSelected={isRowSelected(el.id)} />
                  ))}
                </div>
              );
            })}
          </>
        )}
        {modelLoaded && !searching && results.length === 0 && query.trim() !== '' && !waitingForEnrichment && (
          <p style={{ fontSize: 12, color: 'var(--text-muted)', padding: 8 }}>
            No results found
          </p>
        )}
        {modelLoaded && !searching && results.length === 0 && waitingForEnrichment && enrichment.state !== 'unavailable' && (
          <p style={{ fontSize: 12, color: 'var(--text-muted)', padding: 8 }}>
            Property filters run once indexing finishes.
          </p>
        )}
      </div>
    </div>
  );
}

// Lazy enrichment layer for the multi-field model search.
//
// Walks the already-loaded spatial tree (cheap - ModelService caches it),
// bulk-fetches element details in small chunks with an event-loop yield
// between chunks, and feeds ObjectType / property sets / classifications
// into the model's SearchIndex. Strictly on demand: nothing in this module
// runs at model load; the SearchPanel triggers it the first time a
// pset:/class: filter is typed or via its "Index properties" affordance.

import type {
  ClassificationEnrichment,
  PsetEnrichment,
  SearchIndex,
} from '../../services/ifc/search';

export interface EnrichmentStatus {
  state: 'idle' | 'building' | 'ready' | 'unavailable';
  processed: number;
  total: number;
  /** True when the model exceeded ENRICHMENT_ELEMENT_CAP and only the first slice was indexed. */
  capped: boolean;
}

/** Chunk size for ModelService.getElements - small enough that one chunk stays well under a frame. */
const CHUNK_SIZE = 150;
export const ENRICHMENT_ELEMENT_CAP = 10000;

const IDLE_STATUS: EnrichmentStatus = { state: 'idle', processed: 0, total: 0, capped: false };

let status: EnrichmentStatus = IDLE_STATUS;
// Bumped by reset; the build loop aborts when its generation goes stale.
let generation = 0;
let inFlight: Promise<EnrichmentStatus> | null = null;
// Fingerprint (or other identity key) of the model the layer was built for.
let boundModelKey: string | null = null;
const listeners = new Set<(s: EnrichmentStatus) => void>();

/** Current status snapshot; the reference is stable between changes (safe for useSyncExternalStore). */
export function getEnrichmentStatus(): EnrichmentStatus {
  return status;
}

export function subscribeEnrichment(listener: (s: EnrichmentStatus) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Discards built/building enrichment. Call when the model changes or unloads. */
export function resetEnrichment(): void {
  generation++;
  inFlight = null;
  getModelSearchIndex().clearEnrichment();
  publish(IDLE_STATUS);
}

/**
 * Binds the enrichment layer to the currently-loaded model. A changed key
 * (new model, or null on unload) discards any built/building enrichment.
 * Idempotent for the same key, so panels can call it on every render pass.
 */
export function ensureEnrichmentModel(key: string | null): void {
  if (key === boundModelKey) return;
  boundModelKey = key;
  resetEnrichment();
}

/**
 * Builds the pset/classification layer. Idempotent: while building it returns
 * the in-flight promise, and once ready it resolves immediately. Progress is
 * published to subscribers and to the optional callback.
 */
export function buildEnrichment(
  onProgress?: (s: EnrichmentStatus) => void,
): Promise<EnrichmentStatus> {
  if (status.state === 'ready' || status.state === 'building') {
    if (onProgress) onProgress(status);
    return inFlight ?? Promise.resolve(status);
  }
  const run = runBuild(++generation, onProgress);
  inFlight = run;
  return run;
}

/**
 * Number of elements in the base (name/class/guid) search index.
 * 0 means there is nothing to search client-side and callers should fall
 * back to the backend search route.
 */
export function baseIndexSize(): number {
  return getModelSearchIndex().size;
}

/**
 * Runs a parsed query against the model's search index, building the base
 * layer through the public ModelService API when it has not been built yet.
 * pset:/class: filters only match after buildEnrichment() completed - the
 * SearchPanel gates those queries on EnrichmentStatus.
 */
export async function searchModelParsed(
  parsed: ParsedQuery,
  options: { limit?: number } = {},
): Promise<SearchResult> {
  const index = getModelSearchIndex();
  if (index.size === 0) {
    // ModelService.search() builds the base index before querying; the query
    // string itself is irrelevant for the build side effect.
    await modelService.search('');
  }
  return index.searchParsed(parsed, options);
}

// ── internals ────────────────────────────────────────────────────────────

// ModelService owns its SearchIndex privately and is read-only for this
// module (wiring happens in a separate integration pass). `private` is a
// compile-time constraint only, so a structural cast exposes the instance.
function getModelSearchIndex(): SearchIndex {
  return (modelService as unknown as { searchIndex: SearchIndex }).searchIndex;
}

function publish(next: EnrichmentStatus): void {
  status = next;
  for (const listener of listeners) listener(next);
}

async function runBuild(
  gen: number,
  onProgress?: (s: EnrichmentStatus) => void,
): Promise<EnrichmentStatus> {
  const report = (next: EnrichmentStatus) => {
    if (gen !== generation) return;
    publish(next);
    if (onProgress) onProgress(next);
  };
  const finish = (final: EnrichmentStatus): EnrichmentStatus => {
    report(final);
    if (gen === generation) inFlight = null;
    return status;
  };

  const tree = modelService.ready ? await modelService.getSpatialTree() : null;
  if (gen !== generation) return status;
  if (!tree) {
    return finish({ state: 'unavailable', processed: 0, total: 0, capped: false });
  }

  const allIds = collectElementIds(tree);
  const capped = allIds.length > ENRICHMENT_ELEMENT_CAP;
  const ids = capped ? allIds.slice(0, ENRICHMENT_ELEMENT_CAP) : allIds;
  if (ids.length === 0) {
    return finish({ state: 'unavailable', processed: 0, total: 0, capped: false });
  }

  report({ state: 'building', processed: 0, total: ids.length, capped });

  // One call covers classifications for every member element (cached by
  // ModelService; empty in modes that don't carry classification groups).
  const classificationsById = await fetchClassificationMap();
  if (gen !== generation) return status;

  const index = getModelSearchIndex();
  let enriched = 0;
  for (let offset = 0; offset < ids.length; offset += CHUNK_SIZE) {
    const chunk = ids.slice(offset, offset + CHUNK_SIZE);
    let details: Awaited<ReturnType<typeof modelService.getElements>> = [];
    try {
      details = await modelService.getElements(chunk);
    } catch {
      details = [];
    }
    if (gen !== generation) return status;

    for (let i = 0; i < chunk.length; i++) {
      const detail = details[i] ?? null;
      const classifications = classificationsById.get(chunk[i]) ?? [];
      if (!detail && classifications.length === 0) continue;
      index.setEnrichment(chunk[i], {
        objectType: detail?.object_type ?? null,
        psets: detail ? flattenPsets(detail.property_sets) : [],
        classifications,
      });
      if (detail) enriched++;
    }
    report({
      state: 'building',
      processed: Math.min(offset + chunk.length, ids.length),
      total: ids.length,
      capped,
    });

    // Yield between chunks so the main thread breathes during the build.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (gen !== generation) return status;
  }

  return finish(
    enriched > 0
      ? { state: 'ready', processed: ids.length, total: ids.length, capped }
      : { state: 'unavailable', processed: 0, total: ids.length, capped },
  );
}

const SPATIAL_CONTAINERS = new Set(['ifcproject', 'ifcsite', 'ifcbuilding', 'ifcbuildingstorey']);

// Same leaf-element selection as ModelService.buildSearchIndex: skip
// synthetic roots (id < 0) and spatial containers.
function collectElementIds(tree: SpatialNode): number[] {
  const out: number[] = [];
  const walk = (node: SpatialNode) => {
    if (node.id > 0 && !SPATIAL_CONTAINERS.has(node.ifc_type.toLowerCase())) {
      out.push(node.id);
    }
    for (const child of node.children) walk(child);
  };
  walk(tree);
  return out;
}

function flattenPsets(propertySets: PropertySet[]): PsetEnrichment[] {
  const out: PsetEnrichment[] = [];
  for (const set of propertySets) {
    for (const [prop, value] of Object.entries(set.properties)) {
      out.push({ pset: set.name, prop, value: value === null ? '' : String(value) });
    }
  }
  return out;
}

async function fetchClassificationMap(): Promise<Map<number, ClassificationEnrichment[]>> {
  const map = new Map<number, ClassificationEnrichment[]>();
  let groups: ClassificationGroup[] = [];
  try {
    groups = await modelService.getClassifications();
  } catch {
    groups = [];
  }
  for (const group of groups) {
    for (const item of group.items) {
      const entry: ClassificationEnrichment = {
        system: group.name,
        code: item.code ?? item.name,
      };
      for (const id of item.memberIds) {
        const existing = map.get(id);
        if (existing) existing.push(entry);
        else map.set(id, [entry]);
      }
    }
  }
  return map;
}
