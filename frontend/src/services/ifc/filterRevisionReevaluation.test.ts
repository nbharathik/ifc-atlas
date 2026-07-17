import { describe, expect, it } from 'vitest';

import {
  decideFilterRevisionAction,
  type FilterResultContract,
  type FilterRevisionModelState,
} from './filterRevisionReevaluation';

function model(version: number, fingerprint: string | null = 'fp-a', loaded = true): FilterRevisionModelState {
  return { loaded, fingerprint, version };
}

function result(
  version: number,
  fingerprint: string | null = 'fp-a',
  definitionId: string | null = 'def-1',
): FilterResultContract {
  return { fingerprint, version, definitionId };
}

describe('decideFilterRevisionAction', () => {
  it('does nothing without an applied result', () => {
    expect(decideFilterRevisionAction({
      result: null,
      model: model(2),
      activeDefinitionId: 'def-1',
      attempted: null,
    })).toBe('none');
  });

  it('does nothing while the result matches the current revision', () => {
    expect(decideFilterRevisionAction({
      result: result(1),
      model: model(1),
      activeDefinitionId: 'def-1',
      attempted: null,
    })).toBe('none');
  });

  it('re-evaluates a saved-definition result when the model version changes', () => {
    expect(decideFilterRevisionAction({
      result: result(1),
      model: model(2),
      activeDefinitionId: 'def-1',
      attempted: null,
    })).toBe('reevaluate');
  });

  it('re-evaluates when an edit re-fingerprints the working model', () => {
    expect(decideFilterRevisionAction({
      result: result(1, 'fp-a'),
      model: model(1, 'fp-b'),
      activeDefinitionId: 'def-1',
      attempted: null,
    })).toBe('reevaluate');
  });

  it('does not loop when the re-run itself updates the result contract', () => {
    const staleModel = model(2);
    const first = decideFilterRevisionAction({
      result: result(1),
      model: staleModel,
      activeDefinitionId: 'def-1',
      attempted: null,
    });
    expect(first).toBe('reevaluate');
    // Successful re-run adopts the new contract; the state updates it causes
    // must decide 'none' even though the attempt is recorded for revision 2.
    expect(decideFilterRevisionAction({
      result: result(2),
      model: staleModel,
      activeDefinitionId: 'def-1',
      attempted: { fingerprint: 'fp-a', version: 2 },
    })).toBe('none');
  });

  it('clears when the re-run for this revision has already failed', () => {
    // The contract is still stale after the recorded attempt, so a second
    // automatic run is refused in favour of the existing clear behaviour.
    expect(decideFilterRevisionAction({
      result: result(1),
      model: model(2),
      activeDefinitionId: 'def-1',
      attempted: { fingerprint: 'fp-a', version: 2 },
    })).toBe('clear');
  });

  it('re-evaluates again for a further revision after a failed attempt', () => {
    expect(decideFilterRevisionAction({
      result: result(1),
      model: model(3),
      activeDefinitionId: 'def-1',
      attempted: { fingerprint: 'fp-a', version: 2 },
    })).toBe('reevaluate');
  });

  it('clears unsaved draft results on revision change', () => {
    expect(decideFilterRevisionAction({
      result: result(1, 'fp-a', null),
      model: model(2),
      activeDefinitionId: null,
      attempted: null,
    })).toBe('clear');
  });

  it('clears when the panel no longer has the producing definition active', () => {
    expect(decideFilterRevisionAction({
      result: result(1),
      model: model(2),
      activeDefinitionId: 'def-2',
      attempted: null,
    })).toBe('clear');
  });

  it('clears on model unload', () => {
    expect(decideFilterRevisionAction({
      result: result(1),
      model: model(1, 'fp-a', false),
      activeDefinitionId: 'def-1',
      attempted: null,
    })).toBe('clear');
  });

  it('clears when the model has no fingerprint yet', () => {
    expect(decideFilterRevisionAction({
      result: result(1),
      model: model(0, null),
      activeDefinitionId: 'def-1',
      attempted: null,
    })).toBe('clear');
  });
});
