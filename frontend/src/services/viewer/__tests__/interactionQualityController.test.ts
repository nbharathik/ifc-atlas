import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INTERACTION_QUALITY_STATE,
  getRuntimeQualitySettings,
  reduceInteractionQuality,
  shouldDelayHoverRaycast,
  shouldRunHoverRaycast,
} from '../interactionQualityController';

describe('reduceInteractionQuality', () => {
  it('drops to interactive quality while navigating', () => {
    const next = reduceInteractionQuality(DEFAULT_INTERACTION_QUALITY_STATE, {
      type: 'navigation-start',
    });

    expect(next).toMatchObject({
      active: 'interactive',
      navigating: true,
      slowFrameStreak: 0,
      stableFrameStreak: 0,
    });
    expect(getRuntimeQualitySettings(next.active)).toMatchObject({
      hoverRaycastEnabled: false,
      cullerHideEnabled: false,
      postprocessing: 'off',
    });
  });

  it('drops one quality level after repeated synthetic slow frames', () => {
    const quality = reduceInteractionQuality(DEFAULT_INTERACTION_QUALITY_STATE, {
      type: 'set-target',
      target: 'quality',
    });

    const firstSlow = reduceInteractionQuality(quality, { type: 'frame', ms: 45 });
    const secondSlow = reduceInteractionQuality(firstSlow, { type: 'frame', ms: 42 });

    expect(firstSlow.active).toBe('quality');
    expect(secondSlow.active).toBe('balanced');
    expect(secondSlow.slowFrameStreak).toBe(0);
  });

  it('restores quality gradually after stable synthetic frames', () => {
    let state = reduceInteractionQuality(DEFAULT_INTERACTION_QUALITY_STATE, {
      type: 'set-target',
      target: 'quality',
    });
    state = reduceInteractionQuality(state, { type: 'frame', ms: 45 });
    state = reduceInteractionQuality(state, { type: 'frame', ms: 42 });
    expect(state.active).toBe('balanced');

    for (let i = 0; i < 8; i += 1) {
      state = reduceInteractionQuality(state, { type: 'frame', ms: 16 });
    }

    expect(state.active).toBe('quality');
  });

  it('ignores frame adaptation during active navigation', () => {
    let state = reduceInteractionQuality(DEFAULT_INTERACTION_QUALITY_STATE, {
      type: 'navigation-start',
    });
    state = reduceInteractionQuality(state, { type: 'frame', ms: 100 });
    state = reduceInteractionQuality(state, { type: 'frame', ms: 100 });

    expect(state.active).toBe('interactive');
    expect(state.slowFrameStreak).toBe(0);
  });
});

describe('shouldRunHoverRaycast', () => {
  it('keeps measurement raycasts active during navigation', () => {
    expect(shouldRunHoverRaycast({
      measuring: true,
      hoverHighlightEnabled: false,
      cameraNavigating: true,
    })).toBe(true);
  });

  it('suppresses hover-only raycasts during navigation', () => {
    expect(shouldRunHoverRaycast({
      measuring: false,
      hoverHighlightEnabled: true,
      cameraNavigating: true,
    })).toBe(false);
  });

  it('allows hover raycasts when idle and enabled', () => {
    expect(shouldRunHoverRaycast({
      measuring: false,
      hoverHighlightEnabled: true,
      cameraNavigating: false,
    })).toBe(true);
  });

  it('delays only hover-only raycasts', () => {
    expect(shouldDelayHoverRaycast({
      measuring: false,
      hoverHighlightEnabled: true,
      cameraNavigating: false,
    })).toBe(true);
    expect(shouldDelayHoverRaycast({
      measuring: true,
      hoverHighlightEnabled: true,
      cameraNavigating: false,
    })).toBe(false);
    expect(shouldDelayHoverRaycast({
      measuring: false,
      hoverHighlightEnabled: true,
      cameraNavigating: true,
    })).toBe(false);
  });
});
