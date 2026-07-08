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

import { loadFragmentDelta, type GetLocalIdFn, type EditorEditFn } from './fragmentDeltaLoader';

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
