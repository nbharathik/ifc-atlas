/**
 * Revision policy for applied named-filter results.
 *
 * Express IDs are model-local, so a painted result is only valid for the
 * exact model fingerprint/version that produced it. When the semantic
 * revision changes, a result that came from the currently active saved
 * definition is re-evaluated once against the new revision; every other
 * stale result (unsaved drafts, switched definitions, unloaded models, an
 * already-attempted revision) falls back to the existing clear behaviour.
 */

export type FilterRevisionAction = 'none' | 'reevaluate' | 'clear';

export interface FilterResultContract {
  readonly fingerprint: string | null;
  readonly version: number;
  /** Saved definition the result was applied from; null for unsaved drafts. */
  readonly definitionId: string | null;
}

export interface FilterRevisionModelState {
  readonly loaded: boolean;
  readonly fingerprint: string | null;
  readonly version: number;
}

export interface FilterRevisionDecisionInput {
  /** Contract captured when the current result was applied; null = no result. */
  readonly result: FilterResultContract | null;
  readonly model: FilterRevisionModelState;
  /** Saved definition currently active in the panel (null = unsaved draft). */
  readonly activeDefinitionId: string | null;
  /** Model contract of the last automatic re-evaluation attempt, successful
   * or not. Guarantees at most one automatic re-run per revision change. */
  readonly attempted: { fingerprint: string | null; version: number } | null;
}

export function decideFilterRevisionAction(input: FilterRevisionDecisionInput): FilterRevisionAction {
  const { result, model, activeDefinitionId, attempted } = input;
  if (!result) return 'none';
  if (
    model.loaded
    && result.fingerprint === model.fingerprint
    && result.version === model.version
  ) {
    return 'none';
  }
  if (!model.loaded || model.fingerprint === null) return 'clear';
  if (result.definitionId === null || activeDefinitionId !== result.definitionId) return 'clear';
  // One shot per revision: a re-run that already happened for this exact
  // revision and still left a stale contract has failed, so clear instead of
  // looping on the same request.
  if (
    attempted
    && attempted.fingerprint === model.fingerprint
    && attempted.version === model.version
  ) {
    return 'clear';
  }
  return 'reevaluate';
}
