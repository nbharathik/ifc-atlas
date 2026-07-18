// Backend metadata-index consumer (experimental, flag-gated by
// `clientIfc.backendMetadata`).
//
// WHY THIS EXISTS
// ---------------
// Today the browser runs a FULL second parse of the IFC in a web worker
// (`workers/metadata.worker.ts`) on EVERY load, purely to read property sets,
// materials, the GlobalId↔ExpressId map and the geometry→product owner map.
// That is redundant: the backend already parsed the same file once (the Node
// sidecar producing the on-disk metadata index, cached by SHA-256) and serves
// it via `GET /api/ifc/native-index`. This module lets ModelService consume
// that server-built index and SKIP the browser worker entirely - freeing the
// ~50 MB buffer copy + web-ifc parse on the main/worker thread.
//
// WHAT THE INDEX HAS vs LACKS (honest gaps, handled by the caller):
//   ✓ spatial tree, elements (id/type/name/storey), property sets, quantities,
//     materials list, id_by_global_id, by_type / ids_by_type / ids_by_storey.
//   ✗ geometry→product OWNER map. We approximate owner resolution by product-
//     set membership (see `resolveOwnerFromIndex`) and instrument the hit rate
//     so a real browser run tells us empirically whether the full owner walk
//     is ever needed for server-converted fragments.
//   ✗ classifications, per-element material, relating/object/predefined type,
//     tag. Returned as null/[] in this mode; the authoritative
//     `GET /elements/{id}` (IfcOpenShell) remains the fallback for edited
//     elements.
//
// The index reflects the PRISTINE uploaded model. After an edit, the caller
// invalidates the changed express-ids and falls back to the authoritative
// per-element route for those - so this never goes stale mid-session.

import { apiUrl } from '../../lib/platform';
import type { ElementDetail, PropertySet } from '../../types/ifc';

// ── Raw wire shapes (subset of backend/app/models/metadata_index_models.py) ──

export interface RawIndexElement {
  id: number;
  global_id?: string | null;
  type: string;
  name?: string | null;
  description?: string | null;
  storey_id?: number | null;
  storey_name?: string | null;
}

export interface RawIndexPropertyValue {
  name: string;
  value?: string | null;
  value_type?: string | null;
}

export interface RawIndexPropertySet {
  id: number;
  name?: string | null;
  description?: string | null;
  properties: RawIndexPropertyValue[];
}

export interface RawBackendIndex {
  source_sha256?: string;
  // JSON object keys are strings even when the source was an int dict.
  elements?: Record<string, RawIndexElement>;
  id_by_global_id?: Record<string, number>;
  element_psets?: Record<string, RawIndexPropertySet[]>;
  materials?: string[];
}

export interface BackendNativeIndexResponse {
  /** 'ready' | 'pending' | 'failed' | 'mismatch' on current backends; absent on older ones. */
  status?: string;
  sha256?: string | null;
  index: RawBackendIndex | null;
  /** Present when status='failed': why the background parse errored. */
  error?: string | null;
}

// Value-types the sidecar emits for IfcQuantity* properties (see
// backend/sidecar/src/parser/extract.ts). Routed to ElementDetail.quantities
// (numbers) instead of the property_sets map.
export const QUANTITY_VALUE_TYPES: ReadonlySet<string> = new Set([
  'length',
  'area',
  'volume',
  'count',
  'weight',
  'time',
]);

// Value-types that should be coerced to a JS number when they land in a
// property set (everything numeric the STEP layer can emit).
const NUMERIC_VALUE_TYPES: ReadonlySet<string> = new Set([
  'integer',
  'real',
  'ifcinteger',
  'ifcreal',
  'ifccountmeasure',
  'ifclengthmeasure',
  'ifcareameasure',
  'ifcvolumemeasure',
  'ifcmassmeasure',
  'ifcpositivelengthmeasure',
  'ifcthermaltransmittancemeasure',
]);

function coerceValue(
  raw: string | null | undefined,
  valueType: string | null | undefined,
): string | number | boolean | null {
  if (raw === null || raw === undefined) return null;
  const vt = (valueType ?? '').toLowerCase();
  if (vt === 'boolean' || vt === 'ifcboolean' || vt === 'logical') {
    if (raw === 'T' || raw === 'true' || raw === '.T.') return true;
    if (raw === 'F' || raw === 'false' || raw === '.F.') return false;
  }
  if (NUMERIC_VALUE_TYPES.has(vt) || QUANTITY_VALUE_TYPES.has(vt)) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return raw;
}

/**
 * Pure mapping: one index element (+ its property sets) → the frontend
 * `ElementDetail` shape that PropertiesPanel and the LLM client tools expect.
 *
 * Quantities (value_type in {length, area, volume, count, weight, time}) are
 * pulled out into `quantities`; everything else becomes a `property_sets`
 * entry. Fields the index does not carry (material, relating/object/predefined
 * type, tag) are null - documented gaps in backend-metadata mode.
 */
export function indexElementToDetail(
  elem: RawIndexElement,
  psets: RawIndexPropertySet[] | undefined,
): ElementDetail {
  const property_sets: PropertySet[] = [];
  const quantities: Record<string, number> = {};

  for (const ps of psets ?? []) {
    const props: Record<string, string | number | boolean | null> = {};
    let hasProp = false;
    for (const p of ps.properties ?? []) {
      if (!p.name) continue;
      const vt = (p.value_type ?? '').toLowerCase();
      if (QUANTITY_VALUE_TYPES.has(vt)) {
        const n = Number(p.value);
        if (Number.isFinite(n)) {
          quantities[p.name] = n;
          continue;
        }
      }
      props[p.name] = coerceValue(p.value, p.value_type);
      hasProp = true;
    }
    if (hasProp) {
      property_sets.push({ name: ps.name ?? `Pset #${ps.id}`, properties: props });
    }
  }

  return {
    id: elem.id,
    global_id: elem.global_id ?? '',
    name: elem.name ?? null,
    ifc_type: elem.type,
    storey: elem.storey_name ?? null,
    material: null,
    property_sets,
    quantities,
    relating_type: null,
    description: elem.description ?? null,
    object_type: null,
    tag: null,
    predefined_type: null,
  };
}

/**
 * In-memory view over a fetched backend metadata index. Holds the maps the
 * viewer needs at click time and supports per-element invalidation after edits.
 */
export class BackendMetadataIndex {
  readonly sha256: string | null;
  private readonly elementByExpressId = new Map<number, RawIndexElement>();
  private readonly psetsByExpressId = new Map<number, RawIndexPropertySet[]>();
  /** GlobalId → ExpressId (replaces the worker's getGlobalIdMap). */
  readonly expressIdByGlobalId = new Map<string, number>();
  /** Express-ids that are real products (used for owner resolution). */
  private readonly productExpressIds = new Set<number>();
  /** Edited ids - force authoritative fallback instead of the stale index. */
  private readonly invalidated = new Set<number>();

  // Instrumentation for the "do we need the owner map?" experiment.
  ownerResolveHits = 0;
  ownerResolveMisses = 0;

  constructor(raw: RawBackendIndex, sha256: string | null) {
    this.sha256 = sha256 ?? raw.source_sha256 ?? null;
    for (const [key, elem] of Object.entries(raw.elements ?? {})) {
      const eid = Number(key);
      if (!Number.isFinite(eid)) continue;
      this.elementByExpressId.set(eid, elem);
      this.productExpressIds.add(eid);
    }
    for (const [key, psets] of Object.entries(raw.element_psets ?? {})) {
      const eid = Number(key);
      if (Number.isFinite(eid)) this.psetsByExpressId.set(eid, psets);
    }
    for (const [guid, eid] of Object.entries(raw.id_by_global_id ?? {})) {
      if (guid && Number.isFinite(eid)) this.expressIdByGlobalId.set(guid, Number(eid));
    }
  }

  get elementCount(): number {
    return this.elementByExpressId.size;
  }

  /** True if the express-id is a known product (not an edited/unknown id). */
  hasProduct(expressId: number): boolean {
    return this.productExpressIds.has(expressId) && !this.invalidated.has(expressId);
  }

  /**
   * Owner resolution by product-set membership. We can't walk geometry→product
   * without the owner map, so: if the raycast id is itself a known product,
   * return it (hit); otherwise return it unchanged (miss → the panel shows the
   * usual "unavailable" for non-product ids, exactly today's null-owner
   * fallback). Selection/highlight is unaffected (it uses the localId raycast
   * also returns). The hit/miss counters quantify how often a real owner walk
   * would actually be needed for server-converted fragments.
   */
  resolveOwner(expressId: number): number {
    if (this.productExpressIds.has(expressId)) this.ownerResolveHits++;
    else this.ownerResolveMisses++;
    return expressId;
  }

  /** Build an ElementDetail from the index, or null if unknown/invalidated. */
  getElementDetail(expressId: number): ElementDetail | null {
    if (this.invalidated.has(expressId)) return null;
    const elem = this.elementByExpressId.get(expressId);
    if (!elem) return null;
    return indexElementToDetail(elem, this.psetsByExpressId.get(expressId));
  }

  /** Mark edited express-ids so getElementDetail returns null → caller falls
   *  back to the authoritative IfcOpenShell route for fresh data. */
  invalidate(expressIds: Iterable<number>): void {
    for (const id of expressIds) this.invalidated.add(id);
  }

  resolveStats(): { hits: number; misses: number; rate: number } {
    const total = this.ownerResolveHits + this.ownerResolveMisses;
    return {
      hits: this.ownerResolveHits,
      misses: this.ownerResolveMisses,
      rate: total === 0 ? 1 : this.ownerResolveHits / total,
    };
  }
}

/**
 * Outcome of one native-index fetch attempt. The poller needs to tell apart
 * "the backend answered but the index is not (yet) servable" (keep polling -
 * the background parse may still be running) from "the backend is not
 * answering at all" (fail fast to the web-ifc worker fallback).
 */
export type BackendIndexFetchResult =
  | { kind: 'ready'; view: BackendMetadataIndex }
  | { kind: 'pending' }
  | { kind: 'failed' }
  | { kind: 'unreachable' };

/**
 * Fetch the server-built metadata index for the current model. The backend
 * answers with a 200 status envelope: 'ready' carries the index; 'pending'
 * (not built yet) and 'mismatch' (index belongs to another model) carry
 * index=null and map to 'pending' here; 'failed' means the background parse
 * errored and no index will ever arrive for this model - callers must stop
 * polling and fall back to the in-browser worker. Never throws - this path
 * must never break the load.
 */
export async function fetchBackendMetadataIndex(
  fingerprint?: string,
): Promise<BackendIndexFetchResult> {
  try {
    const qs = fingerprint ? `?fingerprint=${encodeURIComponent(fingerprint)}` : '';
    const resp = await fetch(apiUrl(`/api/ifc/native-index${qs}`), {
      headers: { Accept: 'application/json' },
    });
    // Older backends reported the transient states as 4xx - treat any non-ok
    // response as pending so a version-skewed pair still converges.
    if (!resp.ok) return { kind: 'pending' };
    const body = (await resp.json()) as BackendNativeIndexResponse;
    if (body?.status === 'failed') return { kind: 'failed' };
    if (!body || !body.index) return { kind: 'pending' };
    const view = new BackendMetadataIndex(body.index, body.sha256 ?? null);
    // An index with zero elements is useless - treat as a miss so we fall back.
    if (view.elementCount === 0) return { kind: 'pending' };
    return { kind: 'ready', view };
  } catch {
    // fetch() rejects only on network-level failure (backend down, CORS,
    // aborted) - JSON parse errors land here too and are equally "not
    // answering usefully".
    return { kind: 'unreachable' };
  }
}
