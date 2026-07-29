import { apiUrl } from '../../lib/platform';

/**
 * entityDeltaHandler.
 *
 * Processes `entity_delta` WS events emitted by the backend after
 * `apply_pending_edit`. The handler:
 *   1. Invalidates cached element-detail data for all dirty IDs.
 *   2. Flash-highlights the directly-changed IDs so the user sees the update.
 *   3. For `delta_type: "geometry"` with a `frag_delta_url`, delegates to
 *      `loadFragmentDelta` for a partial fragment re-patch (no full reload).
 *
 * All viewer dependencies are injected so the function is unit-testable
 * without a running viewer.
 */


// ── Types ─────────────────────────────────────────────────────────────────────

export interface EntityDeltaEvent {
  type: 'entity_delta';
  changed_ids?: number[];
  dirty_ids?: number[];
  delta_type?: 'metadata' | 'geometry' | string;
  /** Present only for geometry deltas (not yet emitted). */
  frag_delta_url?: string;
  /** @thatopen model ID - required for geometry patching. */
  model_id?: string;
}

export interface EntityDeltaDeps {
  /**
   * Flash a set of IDs briefly in the viewer to signal the update.
   * Called with the directly `changed_ids` only (not the full dirty set).
   */
  flashHighlight: (ids: number[]) => void;
  /**
   * Evict cached element-detail records so the next property-panel open
   * fetches fresh data. Called with the full dirty set.
   */
  invalidateElementDetails: (ids: number[]) => void;
  /** Required only for geometry delta patching. */
  getLocalId?: GetLocalIdFn;
  /** Required only for geometry delta patching. */
  editorEdit?: EditorEditFn;
}

export type EntityDeltaHandledAs = 'metadata' | 'geometry' | 'noop';

export interface EntityDeltaResult {
  /** How the delta was processed. */
  handledAs: EntityDeltaHandledAs;
  /** Total number of IDs in the union of changed + dirty sets. */
  affectedCount: number;
  /** Only set when `handledAs === 'geometry'`. */
  geometryPatchCount?: number;
}

// ── Handler ───────────────────────────────────────────────────────────────────

/**
 * Process one `entity_delta` event.
 *
 * Never throws - all errors are logged and degrade gracefully to a noop result.
 */
export async function applyEntityDelta(
  event: EntityDeltaEvent,
  deps: EntityDeltaDeps,
): Promise<EntityDeltaResult> {
  const changedIds = event.changed_ids ?? [];
  const dirtyIds   = event.dirty_ids   ?? [];
  const deltaType  = event.delta_type  ?? 'metadata';

  // Union of changed + dirty - everything that might be stale.
  const allAffected = Array.from(new Set([...changedIds, ...dirtyIds]));

  if (allAffected.length === 0) {
    return { handledAs: 'noop', affectedCount: 0 };
  }

  // Invalidate cached properties for all affected IDs.
  try {
    deps.invalidateElementDetails(allAffected);
  } catch (err) {
    console.error('[entityDeltaHandler] invalidateElementDetails failed:', err);
  }

  // Flash-highlight only the directly changed IDs (not transitive dirty set).
  if (changedIds.length > 0) {
    try {
      deps.flashHighlight(changedIds);
    } catch (err) {
      console.error('[entityDeltaHandler] flashHighlight failed:', err);
    }
  }

  // Geometry delta: attempt fragment patch if all required pieces are present.
  if (
    deltaType === 'geometry' &&
    event.frag_delta_url &&
    event.model_id &&
    deps.getLocalId &&
    deps.editorEdit
  ) {
    try {
      const patchResult = await loadFragmentDelta(
        event.frag_delta_url,
        changedIds,
        event.model_id,
        deps.getLocalId,
        deps.editorEdit,
      );
      return {
        handledAs: 'geometry',
        affectedCount: allAffected.length,
        geometryPatchCount: patchResult.updatedCount,
      };
    } catch (err) {
      console.error('[entityDeltaHandler] geometry patch failed:', err);
      // Fall through - metadata path already applied above.
    }
  }

  return { handledAs: 'metadata', affectedCount: allAffected.length };
}

/**
 * fragmentDeltaLoader - lazy geometry reload.
 *
 * When the backend emits a `geometry_changed` patch with a non-null
 * `frag_delta_url`, this module fetches the delta payload and applies it
 * via the @thatopen/fragments `Editor.edit()` API.
 *
 * The delta URL is expected to return JSON conforming to `FragDeltaPayload`:
 *   { "representations": { "<expressId>": <RawRepresentation> } }
 *
 * All viewer dependencies are injected so the function is unit-testable
 * without a running viewer or real WebWorker.
 *
 * EditRequestType.UPDATE_REPRESENTATION = 8 (from @thatopen/fragments enum).
 */


/** Numeric value of EditRequestType.UPDATE_REPRESENTATION from @thatopen/fragments. */
const UPDATE_REPRESENTATION = 8;

/** Expected response shape from the backend frag-delta endpoint. */
export interface FragDeltaPayload {
  representations: Record<string, unknown>; // key = expressId as string
}

/** Result returned by loadFragmentDelta. */
export interface FragDeltaResult {
  /** Number of elements whose geometry was successfully patched. */
  updatedCount: number;
  /** Load source tag for the performance log. */
  source: 'geometry-patch';
}

/**
 * Async function that resolves an IFC express ID to its @thatopen/fragments
 * local ID within the current model.  Returns null when the express ID is
 * not found.
 */
export type GetLocalIdFn = (expressId: number) => Promise<number | null>;

/**
 * Async function that dispatches `UpdateRepresentationRequest` objects to the
 * @thatopen/fragments Editor.  Maps 1:1 to `editor.edit(modelId, requests)`.
 */
export type EditorEditFn = (
  modelId: string,
  requests: Array<{
    type: number; // EditRequestType.UPDATE_REPRESENTATION = 8
    localId: number;
    data: unknown; // RawRepresentation
  }>,
) => Promise<number[]>;

/**
 * Fetch a geometry-delta JSON from `url`, resolve express IDs to local IDs,
 * and apply `UpdateRepresentationRequest` edits via the fragments editor.
 *
 * Failures at any stage degrade gracefully: the function never throws.
 *
 * @param url - The backend frag-delta URL (from `IfcPatch.frag_delta_url`).
 * @param expressIds - Express IDs whose geometry changed (from the patch).
 * @param modelId - The @thatopen model ID.
 * @param getLocalId - Resolves an express ID → local ID for this model.
 * @param editorEdit - Forwards `UpdateRepresentationRequest` to `Editor.edit()`.
 * @returns Count of elements patched and `source: 'geometry-patch'` tag.
 */
export async function loadFragmentDelta(
  url: string,
  expressIds: number[],
  modelId: string,
  getLocalId: GetLocalIdFn,
  editorEdit: EditorEditFn,
): Promise<FragDeltaResult> {
  if (!url || expressIds.length === 0) {
    return { updatedCount: 0, source: 'geometry-patch' };
  }

  let payload: FragDeltaPayload;
  try {
    const response = await fetch(apiUrl(url));
    if (!response.ok) {
      console.warn(`[fragmentDeltaLoader] fetch failed: ${response.status} ${url}`);
      return { updatedCount: 0, source: 'geometry-patch' };
    }
    payload = (await response.json()) as FragDeltaPayload;
  } catch (err) {
    console.warn('[fragmentDeltaLoader] fetch error:', err);
    return { updatedCount: 0, source: 'geometry-patch' };
  }

  const representations = payload?.representations ?? {};
  const requests: Array<{ type: number; localId: number; data: unknown }> = [];

  for (const expressId of expressIds) {
    // Key in the payload is the express ID stringified.
    const repData = representations[String(expressId)];
    if (repData === undefined) continue;

    let localId: number | null = null;
    try {
      localId = await getLocalId(expressId);
    } catch {
      continue;
    }
    if (localId === null) continue;

    requests.push({ type: UPDATE_REPRESENTATION, localId, data: repData });
  }

  if (requests.length === 0) {
    return { updatedCount: 0, source: 'geometry-patch' };
  }

  try {
    await editorEdit(modelId, requests);
  } catch (err) {
    console.error('[fragmentDeltaLoader] editorEdit failed:', err);
    return { updatedCount: 0, source: 'geometry-patch' };
  }

  return { updatedCount: requests.length, source: 'geometry-patch' };
}
