import { describe, expect, it } from 'vitest';

import {
  ALL_VISIBLE_MAX_ELEMENTS,
  LARGE_MODEL_MIN_ELEMENTS,
  resolveLodTier,
  resolveModelGraphicsQuality,
} from '../lodTierPolicy';

describe('resolveLodTier', () => {
  it('classifies the three tiers with exclusive upper bounds', () => {
    expect(resolveLodTier(0)).toBe('small');
    expect(resolveLodTier(ALL_VISIBLE_MAX_ELEMENTS - 1)).toBe('small');
    expect(resolveLodTier(ALL_VISIBLE_MAX_ELEMENTS)).toBe('medium');
    expect(resolveLodTier(LARGE_MODEL_MIN_ELEMENTS - 1)).toBe('medium');
    expect(resolveLodTier(LARGE_MODEL_MIN_ELEMENTS)).toBe('large');
    expect(resolveLodTier(1_000_000)).toBe('large');
  });
});

describe('resolveModelGraphicsQuality', () => {
  const IDLE = 0.85;
  const NAV = 0.6;

  it('pins every tier to the idle level during navigation (measured floor rule)', () => {
    // The 0.6 nav drop is a measured orbit-FPS regression (wire-tile churn
    // outweighs the culled triangles) - no tier may inherit it.
    expect(resolveModelGraphicsQuality('small', NAV, IDLE)).toBe(IDLE);
    expect(resolveModelGraphicsQuality('medium', NAV, IDLE)).toBe(IDLE);
    expect(resolveModelGraphicsQuality('large', NAV, IDLE)).toBe(IDLE);
  });

  it('keeps explicit quality-mode idle levels on all tiers', () => {
    expect(resolveModelGraphicsQuality('medium', 1.0, 1.0)).toBe(1.0);
    expect(resolveModelGraphicsQuality('small', 0.85, 0.85)).toBe(0.85);
    expect(resolveModelGraphicsQuality('large', 1.0, 1.0)).toBe(1.0);
  });
});
