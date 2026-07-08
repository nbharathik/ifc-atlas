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

import { apiUrl } from '../../lib/platform';

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
