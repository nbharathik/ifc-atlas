import { describe, expect, it } from 'vitest';
import {
  canReuseExactHoverPick,
  canReusePrefetchedPick,
  createPickLeaseCoordinator,
  createPickRequestToken,
  decideVoidClick,
  isClickGesture,
  isConfirmedVoidPick,
  isNoopSameElementClick,
  isStalePickResult,
} from '../pickingPipeline';

describe('pickingPipeline helpers', () => {
  it('holds an exact-pick lease until every overlapping pick releases', () => {
    const transitions: boolean[] = [];
    const leases = createPickLeaseCoordinator((active) => transitions.push(active));
    const releaseFirst = leases.acquire();
    const releaseSecond = leases.acquire();

    expect(leases.active).toBe(true);
    expect(leases.count).toBe(2);
    expect(transitions).toEqual([true]);

    releaseFirst();
    releaseFirst();
    expect(leases.active).toBe(true);
    expect(leases.count).toBe(1);

    releaseSecond();
    expect(leases.active).toBe(false);
    expect(leases.count).toBe(0);
    expect(transitions).toEqual([true, false]);
  });

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

  it('accepts a long stationary press and rejects actual pointer travel', () => {
    expect(isClickGesture({ distancePx: 0, elapsedMs: 600 })).toBe(true);
    expect(isClickGesture({ distancePx: 3, elapsedMs: 2_000 })).toBe(true);
    expect(isClickGesture({ distancePx: 5, elapsedMs: 20 })).toBe(false);
  });

  it('does not turn a raycast failure into a void click', () => {
    expect(isConfirmedVoidPick({ exactHit: false, error: null })).toBe(true);
    expect(isConfirmedVoidPick({ exactHit: true, error: null })).toBe(false);
    expect(isConfirmedVoidPick({ exactHit: false, error: new Error('worker failed') })).toBe(false);
  });

  it('reuses only a fresh authoritative hover hit from unchanged viewer state', () => {
    const reusable = {
      exactHit: true,
      distancePx: 1.5,
      ageMs: 80,
      cameraUnchanged: true,
      visibilityUnchanged: true,
      fragmentReplacementBlocked: false,
    };
    expect(canReuseExactHoverPick(reusable)).toBe(true);
    expect(canReuseExactHoverPick({ ...reusable, exactHit: false })).toBe(false);
    expect(canReuseExactHoverPick({ ...reusable, ageMs: 151 })).toBe(false);
    expect(canReuseExactHoverPick({ ...reusable, cameraUnchanged: false })).toBe(false);
    expect(canReuseExactHoverPick({ ...reusable, visibilityUnchanged: false })).toBe(false);
    expect(canReuseExactHoverPick({ ...reusable, fragmentReplacementBlocked: true })).toBe(false);
  });

  it('honours explicit hover-reuse pixel and age budgets', () => {
    expect(canReuseExactHoverPick({
      exactHit: true,
      distancePx: 4,
      ageMs: 300,
      cameraUnchanged: true,
      visibilityUnchanged: true,
      fragmentReplacementBlocked: false,
      tolerancePx: 4,
      maxAgeMs: 300,
    })).toBe(true);
  });

  it('reuses a pointer-down prefetch only at the same release point and scene state', () => {
    const reusable = {
      requestGeneration: 7,
      currentGeneration: 7,
      distancePx: 1,
      cameraUnchanged: true,
      visibilityUnchanged: true,
      fragmentReplacementBlocked: false,
    };

    expect(canReusePrefetchedPick(reusable)).toBe(true);
    // A 4 px gesture is still a click, but its exact ray must be recomputed at
    // pointer-up instead of reusing the pointer-down pixel.
    expect(canReusePrefetchedPick({ ...reusable, distancePx: 4 })).toBe(false);
    expect(canReusePrefetchedPick({ ...reusable, currentGeneration: 8 })).toBe(false);
    expect(canReusePrefetchedPick({ ...reusable, cameraUnchanged: false })).toBe(false);
    expect(canReusePrefetchedPick({ ...reusable, visibilityUnchanged: false })).toBe(false);
    expect(canReusePrefetchedPick({ ...reusable, fragmentReplacementBlocked: true })).toBe(false);
  });

  it('fails prefetched-pick reuse closed for invalid distance and honours a custom radius', () => {
    const base = {
      requestGeneration: 3,
      currentGeneration: 3,
      cameraUnchanged: true,
      visibilityUnchanged: true,
      fragmentReplacementBlocked: false,
    };
    expect(canReusePrefetchedPick({ ...base, distancePx: Number.NaN })).toBe(false);
    expect(canReusePrefetchedPick({ ...base, distancePx: -1 })).toBe(false);
    expect(canReusePrefetchedPick({ ...base, distancePx: 2, tolerancePx: 2 })).toBe(true);
  });
});
