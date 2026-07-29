/**
 * Progressive storey-reveal for the IFC viewer.
 *
 * Cosmetic reveal - after the full IFC model loads, isolate elements
 *   storey-by-storey so the user perceives a "streaming" load effect. No
 *   extra network round-trips.
 *
 * True per-storey streaming - via separate FragmentsModel loads. The backend
 *   produces a minimal sub-IFC per storey via copy_deep and converts it
 *   through the Node sidecar. The frontend loads storey[0] immediately to
 *   achieve TTFR < 1s, then loads the full model in parallel.
 *
 * True-streaming API:
 *   fetchStoreyFragment(sha, idx, signal?) → raw bytes + metadata
 *   createStoreyStreamingLoader(sha, opts)  → cancellable async loader
 *   StoreyFragmentResult / StoreyStreamingSession types
 */

import type { SpatialNode } from '../../types/ifc';
import { collectLeavesUnder } from './spatialTreeHelpers';
import { apiUrl } from '../../lib/platform';

// ── True-streaming backend types (storey-manifest endpoint) ──────────────────

export interface StoreyManifestEntry {
  idx: number;
  name: string;
  elevation: number;
  element_ids: number[];
  element_count: number;
}

export interface BackendStoreyManifest {
  source_sha256: string;
  total_elements: number;
  storeys: StoreyManifestEntry[];
}

/** Fetch the per-storey element-ID manifest from the backend.
 *  Requires the backend model to be loaded (call after backend upload). */
export async function fetchStoreyManifest(): Promise<BackendStoreyManifest> {
  const resp = await fetch(apiUrl('/api/ifc/storey-manifest'), { method: 'POST' });
  if (!resp.ok) {
    throw new Error(`storey-manifest request failed (${resp.status})`);
  }
  return resp.json() as Promise<BackendStoreyManifest>;
}

// ── Cosmetic progressive-reveal helpers ──────────────────────────────────────

/**
 * Walk the spatial tree and return all IfcBuildingStorey nodes in depth-first
 * order (which matches the elevation order the backend uses when building the
 * tree: ground floor first, top floor last).
 */
export function extractStoreyNodes(root: SpatialNode | null): SpatialNode[] {
  if (!root) return [];
  const storeys: SpatialNode[] = [];
  const walk = (node: SpatialNode) => {
    if (node.ifc_type.toLowerCase() === 'ifcbuildingstorey') {
      storeys.push(node);
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
  return storeys;
}

// ── true per-storey fragment streaming ───────────────────────────────────────

/** Result of a successful storey-fragment fetch. */
export interface StoreyFragmentResult {
  /** Raw fragment or sub-IFC bytes returned by the backend. */
  bytes: ArrayBuffer;
  /** Where the bytes came from (cache | sidecar | sub-ifc). */
  source: string;
  /** IfcBuildingStorey.Name from the loaded model. */
  storeyName: string;
}

/**
 * Fetch binary bytes for one IfcBuildingStorey from the backend.
 *
 * Calls `GET /api/ifc/fragments/storey?sha=<sha>&idx=<idx>`.
 *
 * Returns a `StoreyFragmentResult` on success.
 * Throws if:
 *  - The response is 204 (storey has no elements).
 *  - The response is not OK (SHA mismatch, out-of-range idx, sidecar error).
 *  - `signal` is aborted before or during the fetch.
 */
export async function fetchStoreyFragment(
  sha: string,
  idx: number,
  signal?: AbortSignal,
): Promise<StoreyFragmentResult> {
  const url = apiUrl(`/api/ifc/fragments/storey?sha=${encodeURIComponent(sha)}&idx=${idx}`);
  const resp = await fetch(url, { signal });

  if (resp.status === 204) {
    throw new Error(`Storey ${idx} has no elements (204 No Content)`);
  }
  if (!resp.ok) {
    let detail = resp.statusText;
    try {
      const body = await resp.json() as { detail?: string };
      detail = body.detail ?? detail;
    } catch {
      // ignore parse failures
    }
    throw new Error(`storey fragment ${idx}: ${detail} (HTTP ${resp.status})`);
  }

  return {
    bytes: await resp.arrayBuffer(),
    source: resp.headers.get('X-Fragment-Source') ?? 'unknown',
    storeyName: resp.headers.get('X-Fragment-Storey-Name') ?? `Storey ${idx}`,
  };
}
