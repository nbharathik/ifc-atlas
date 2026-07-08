// Per-capability rollout flags for the frontend-first IFC migration.
// Each flag flips one panel/tool from backend-backed to ModelService-backed.
// These can be removed once every consumer is client-side.

import { BROWSER_ONLY } from '../../config/featureFlags';

export interface ClientIfcFlags {
  statsClient: boolean;
  treeClient: boolean;
  propsClient: boolean;
  searchClient: boolean;
  toolsClient: boolean;
  // Default ON. When true, ModelService consumes the
  // backend's already-built metadata index (GET /api/ifc/native-index) and
  // SKIPS the redundant web-ifc metadata worker - freeing the ~50 MB buffer
  // copy + parse on the client. Owner resolution degrades to product-set
  // membership (instrumented); classifications + per-element material are not
  // available in this mode (authoritative fallback covers edited elements).
  // Disable only for fallback diagnostics:
  //   setClientIfcFlag('backendMetadata', false)  // then reload + load a model
  backendMetadata: boolean;
}

const STORAGE_KEY = 'pref.clientIfc.v1';

// Defaults are all on. Consumers check the flag synchronously so each
// capability can be toggled independently.
const DEFAULT_FLAGS: ClientIfcFlags = {
  statsClient: true,      // stats
  treeClient: true,       // spatial tree
  propsClient: true,      // element properties
  searchClient: true,     // full-text search
  toolsClient: true,      // LLM tools
  backendMetadata: true,  // Backend metadata is default; browser parsing is fallback.
};

let cached: ClientIfcFlags | null = null;

function read(): ClientIfcFlags {
  if (cached) return cached;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ClientIfcFlags>;
      cached = { ...DEFAULT_FLAGS, ...parsed, backendMetadata: parsed.backendMetadata ?? true };
      return cached;
    }
  } catch {
    // fall through
  }
  cached = { ...DEFAULT_FLAGS, backendMetadata: true };
  return cached;
}

function write(next: ClientIfcFlags): void {
  cached = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // fall through
  }
}

export function getClientIfcFlag<K extends keyof ClientIfcFlags>(key: K): ClientIfcFlags[K] {
  // Browser-only build has no backend: the native-index source can never
  // serve, so the metadata worker must stay the primary source regardless of
  // any persisted localStorage preference.
  if (BROWSER_ONLY && key === 'backendMetadata') {
    return false as ClientIfcFlags[K];
  }
  return read()[key];
}

export function setClientIfcFlag<K extends keyof ClientIfcFlags>(
  key: K,
  value: ClientIfcFlags[K],
): void {
  write({ ...read(), [key]: value });
}

export function getAllClientIfcFlags(): ClientIfcFlags {
  return { ...read() };
}

export function setAllClientIfcFlags(next: Partial<ClientIfcFlags>): void {
  write({ ...read(), ...next });
}
