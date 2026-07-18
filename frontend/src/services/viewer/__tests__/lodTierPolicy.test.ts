import { describe, expect, it } from 'vitest';

import {
  ALL_VISIBLE_MAX_ELEMENTS,
  canUseFurnishingMerge,
  canUseNavigationLod,
  LARGE_MODEL_MIN_ELEMENTS,
  resolveLodTier,
  resolveModelGraphicsQuality,
  shouldAttachNavigationLod,
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

describe('navigation LOD policy', () => {
  const cleanAppearance = {
    enabled: true,
    isolatedCount: 0,
    hiddenCount: 0,
    ghostModeOn: false,
    selectedElementId: null,
    selectedCount: 0,
    highlightedCount: 0,
    colourBy: 'off',
    colourLayerCount: 0,
    furnishingMerged: false,
  };

  it('does not allocate a duplicate proxy for medium models', () => {
    expect(shouldAttachNavigationLod(resolveLodTier(1_032), true)).toBe(false);
    expect(shouldAttachNavigationLod('large', true)).toBe(true);
    expect(shouldAttachNavigationLod('large', false)).toBe(false);
  });

  it('keeps the styled primary visible for selection, chat, and painting', () => {
    expect(canUseNavigationLod(cleanAppearance)).toBe(true);
    expect(canUseNavigationLod({ ...cleanAppearance, selectedElementId: 7 })).toBe(false);
    expect(canUseNavigationLod({ ...cleanAppearance, selectedCount: 2 })).toBe(false);
    expect(canUseNavigationLod({ ...cleanAppearance, highlightedCount: 1 })).toBe(false);
    expect(canUseNavigationLod({ ...cleanAppearance, colourBy: 'storey' })).toBe(false);
    expect(canUseNavigationLod({ ...cleanAppearance, colourLayerCount: 1 })).toBe(false);
    expect(canUseNavigationLod({ ...cleanAppearance, furnishingMerged: true })).toBe(false);
  });

  it('suspends furnishing merge for fragment-level interaction state', () => {
    const clean = {
      ...cleanAppearance,
      hoverHighlightEnabled: false,
      measurementMode: 'off',
    };
    expect(canUseFurnishingMerge(clean)).toBe(true);
    expect(canUseFurnishingMerge({ ...clean, selectedElementId: 7 })).toBe(false);
    expect(canUseFurnishingMerge({ ...clean, hiddenCount: 1 })).toBe(false);
    expect(canUseFurnishingMerge({ ...clean, isolatedCount: 1 })).toBe(false);
    expect(canUseFurnishingMerge({ ...clean, ghostModeOn: true })).toBe(false);
    expect(canUseFurnishingMerge({ ...clean, highlightedCount: 1 })).toBe(false);
    expect(canUseFurnishingMerge({ ...clean, colourLayerCount: 1 })).toBe(false);
    expect(canUseFurnishingMerge({ ...clean, hoverHighlightEnabled: true })).toBe(false);
    expect(canUseFurnishingMerge({ ...clean, measurementMode: 'length' })).toBe(false);
  });
});

// Stable-geometry contract: there is deliberately NO per-tier LodMode policy
// anymore. ViewerPanel pins FRAGS.LodMode.ALL_VISIBLE for every model at load
// so the fragments worker never culls or LOD-swaps geometry; the triangle
// budget lives in parseProfiles.ts (conversion-time tessellation) instead.

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
