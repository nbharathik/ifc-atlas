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

/**
 * Build the accumulated element-ID arrays for a progressive reveal sequence.
 *
 * Returns one array per storey step where each array contains all element IDs
 * that should be *visible* after that step (ground floor first, additive).
 *
 * Example with 2 storeys each having 3 elements:
 *   step 0 → [1,2,3]
 *   step 1 → [1,2,3,4,5,6]
 */
export function buildRevealSequence(storeyNodes: SpatialNode[]): number[][] {
  const steps: number[][] = [];
  const accumulated: number[] = [];
  for (const storey of storeyNodes) {
    const ids = collectLeavesUnder(storey);
    accumulated.push(...ids);
    steps.push([...accumulated]);
  }
  return steps;
}

// ── Cancellable reveal controller ────────────────────────────────────────────

export interface RevealController {
  /** Immediately stops the animation and clears isolation. */
  cancel: () => void;
}

export interface RevealCallbacks {
  setIsolatedIds: (ids: number[]) => void;
  clearVisibility: () => void;
  onProgress?: (step: number, total: number) => void;
}

export interface RevealOptions {
  /** Milliseconds to wait between revealing each storey (default: 400). */
  delayMs?: number;
  /** Don't animate if the building has fewer than this many storeys (default: 2). */
  minStoreys?: number;
}

/**
 * Progressively reveal an IFC model storey-by-storey after full load.
 *
 * - Starts by showing only ground-floor elements (isolatedIds = storey[0])
 * - Adds each successive storey after `delayMs` milliseconds
 * - Clears isolation when all storeys are visible (full model shown)
 * - Returns a controller with a `cancel()` method to abort mid-animation
 *
 * If the tree has fewer than `minStoreys` storeys, clears visibility
 * immediately (no animation - not worth showing for a single-storey shed).
 */
export function revealStoreyByStorey(
  root: SpatialNode | null,
  callbacks: RevealCallbacks,
  options: RevealOptions = {},
): RevealController {
  const { delayMs = 400, minStoreys = 2 } = options;
  const { setIsolatedIds, clearVisibility, onProgress } = callbacks;

  let cancelled = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const storeyNodes = extractStoreyNodes(root);

  // Not enough storeys to animate - show everything immediately
  if (storeyNodes.length < minStoreys) {
    clearVisibility();
    return { cancel: () => { /* nothing to cancel */ } };
  }

  const steps = buildRevealSequence(storeyNodes);
  const total = steps.length;

  const revealStep = (idx: number) => {
    if (cancelled) return;
    if (idx >= total) {
      // All storeys revealed - lift isolation so full model is shown
      clearVisibility();
      onProgress?.(total, total);
      return;
    }
    setIsolatedIds(steps[idx]);
    onProgress?.(idx + 1, total);
    timeoutId = setTimeout(() => revealStep(idx + 1), delayMs);
  };

  // Start with ground floor visible
  revealStep(0);

  return {
    cancel: () => {
      cancelled = true;
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      clearVisibility();
    },
  };
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

/** Callbacks for a streaming session (called from ViewerPanel). */
export interface StoreyStreamingCallbacks {
  /** Called when storey[0] bytes are ready; caller loads them into fragModels. */
  onStoreyReady: (result: StoreyFragmentResult, idx: number) => void;
  /** Called when the session is aborted or a fetch error occurs. */
  onError?: (err: Error) => void;
  /** Called when dispose() completes so caller can clean up sub-models. */
  onDispose?: () => void;
}

/** Handle returned by `createStoreyStreamingLoader`. */
export interface StoreyStreamingSession {
  /** SHA fingerprint this session was created for. */
  sha: string;
  /** Abort the in-flight fetch and mark session as disposed. */
  cancel: () => void;
  /** Whether cancel() has been called. */
  cancelled: boolean;
}

/**
 * Start an async storey-fragment fetch for storey[0].
 *
 * Kicks off `fetchStoreyFragment(sha, 0)` in the background.
 * Reports results via `callbacks.onStoreyReady` so the caller
 * (ViewerPanel) can load the bytes into `fragModels.core.load()`.
 *
 * Returns a `StoreyStreamingSession` with a `cancel()` method.
 * Safe to call cancel() before or after onStoreyReady fires.
 *
 * Feature-gated: only active when `serverConvertCaps.available` is true.
 */
export function createStoreyStreamingLoader(
  sha: string,
  callbacks: StoreyStreamingCallbacks,
): StoreyStreamingSession {
  const controller = new AbortController();
  const session: StoreyStreamingSession = {
    sha,
    cancelled: false,
    cancel() {
      if (session.cancelled) return;
      session.cancelled = true;
      controller.abort();
      callbacks.onDispose?.();
    },
  };

  // Fire-and-forget; errors reported via callbacks.onError.
  void (async () => {
    try {
      const result = await fetchStoreyFragment(sha, 0, controller.signal);
      if (!session.cancelled) {
        callbacks.onStoreyReady(result, 0);
      }
    } catch (err) {
      if (!session.cancelled) {
        callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  })();

  return session;
}
