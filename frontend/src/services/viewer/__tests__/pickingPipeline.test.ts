import { describe, expect, it } from 'vitest';
import {
  createPickRequestToken,
  decideVoidClick,
  isNoopSameElementClick,
  isStalePickResult,
} from '../pickingPipeline';

describe('pickingPipeline helpers', () => {
  it('marks out-of-order pick results as stale', () => {
    const token = createPickRequestToken(4);

    expect(isStalePickResult({
      requestGeneration: token.generation,
      currentGeneration: 5,
    })).toBe(true);
    expect(isStalePickResult({
      requestGeneration: token.generation,
      currentGeneration: 4,
    })).toBe(false);
  });

  it('clears selection on void click when shift is not held', () => {
    expect(decideVoidClick({
      shiftKey: false,
      selectedElementId: 12,
      fastPickerAvailable: true,
      fastPickerHit: false,
      exactHit: false,
    })).toEqual({
      clearSelection: true,
      skipExactRaycastNextTime: true,
    });
  });

  it('keeps selection on shift void click', () => {
    expect(decideVoidClick({
      shiftKey: true,
      selectedElementId: 12,
      fastPickerAvailable: true,
      fastPickerHit: false,
      exactHit: false,
    }).clearSelection).toBe(false);
  });

  it('does not treat a real exact hit as a void click when FastModelPicker misses', () => {
    expect(decideVoidClick({
      shiftKey: false,
      selectedElementId: 12,
      fastPickerAvailable: true,
      fastPickerHit: false,
      exactHit: true,
    })).toEqual({
      clearSelection: false,
      skipExactRaycastNextTime: false,
    });
  });

  it('detects no-op same-element click in single selection mode', () => {
    expect(isNoopSameElementClick({
      clickedExpressId: 8,
      selectedElementId: 8,
      selectedIds: [],
      shiftKey: false,
    })).toBe(true);
  });

  it('does not treat shift-click as no-op because it toggles multi-selection', () => {
    expect(isNoopSameElementClick({
      clickedExpressId: 8,
      selectedElementId: 8,
      selectedIds: [],
      shiftKey: true,
    })).toBe(false);
  });
});
