// Lazy enrichment layer for the multi-field model search.
//
// Walks the already-loaded spatial tree (cheap - ModelService caches it),
// bulk-fetches element details in small chunks with an event-loop yield
// between chunks, and feeds ObjectType / property sets / classifications
// into the model's SearchIndex. Strictly on demand: nothing in this module
// runs at model load; the SearchPanel triggers it the first time a
// pset:/class: filter is typed or via its "Index properties" affordance.

import { modelService } from './ModelService';
import type {
  ClassificationGroup,
  PropertySet,
  SearchResult,
  SpatialNode,
} from '../../types/ifc';
import type {
  ClassificationEnrichment,
  PsetEnrichment,
  SearchIndex,
} from './searchIndex';
import type { ParsedQuery } from './searchQuery';

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
