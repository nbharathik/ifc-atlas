/**
 * Tiered LOD / per-model graphics-quality policy.
 *
 * Background (engine contract, verified against @thatopen/fragments 3.4.0):
 * the worker's screen-coverage classifier scales its pixel thresholds by
 * `factor = -1.5 * model.graphicsQuality + 2`, read from the PER-MODEL field
 * on every view refresh. LOWER quality means a HIGHER factor, i.e. wider
 * cull/wire bands and MORE elements vanishing or degrading to wire boxes.
 * `core.settings.graphicsQuality` is only a load-time seed (copied onto the
 * model once); writing it at runtime does nothing for loaded models.
 *
 * The floor rule: the interaction ladder drops quality to 0.6 during
 * navigation, which maps to a ~1.5x wider cull band than the idle 0.85.
 * Wiring that drop naively to every model would make elements visibly
 * vanish during orbit on exactly the models users care about.
 *
 *   small  (< ALL_VISIBLE_MAX_ELEMENTS): ALL_VISIBLE LodMode - the worker
 *          skips coverage/frustum culling entirely, quality is irrelevant.
 *   medium (up to LARGE_MODEL_MIN_ELEMENTS): ALL_VISIBLE LodMode - every
 *          element stays resident and drawable at any camera distance, so
 *          nothing pops during orbit or zoom; quality is irrelevant.
 *   large  (above): DEFAULT coverage classifier with quality pinned to the
 *          ladder's idle level, until per-tile LOD replaces it.
 *
 * Thresholds are provisional pending scaling probes; keep them as named
 * constants so tuning lands in one place.
 */

export type LodTier = 'small' | 'medium' | 'large';

/** Small/medium tier boundary and the element-culler's small-model gate. */
export const ALL_VISIBLE_MAX_ELEMENTS = 300;

/** At or above this element count the model is 'large'. Kept as a distinct
 *  tier so a future policy change (pending a probe on a real >20k-element
 *  fixture) lands in one switch branch. */
export const LARGE_MODEL_MIN_ELEMENTS = 20_000;

export function resolveLodTier(elementCount: number): LodTier {
  if (elementCount < ALL_VISIBLE_MAX_ELEMENTS) return 'small';
  if (elementCount < LARGE_MODEL_MIN_ELEMENTS) return 'medium';
  return 'large';
}

/**
 * Small and medium models bypass the fragments worker's view-dependent LOD
 * entirely: every element stays resident and drawable regardless of camera
 * distance or angle, matching the stable-geometry invariant. The classifier's
 * measured frame-time benefit on this class of model is within noise, while
 * its wire/cull bands make elements visibly pop during orbit and zoom.
 * Large models keep the classifier until per-tile LOD ships; drawing every
 * triangle of a 20k+ element model unculled is a real GPU regression.
 */
export function shouldPinAllVisible(tier: LodTier): boolean {
  return tier === 'small' || tier === 'medium';
}

export function shouldAttachNavigationLod(tier: LodTier, enabled: boolean): boolean {
  return enabled && tier === 'large';
}

export interface NavigationLodAppearanceInput {
  enabled: boolean;
  isolatedCount: number;
  hiddenCount: number;
  ghostModeOn: boolean;
  selectedElementId: number | null;
  selectedCount: number;
  highlightedCount: number;
  colourBy: string;
  colourLayerCount: number;
  furnishingMerged: boolean;
}

export interface FurnishingMergeInteractionInput {
  enabled: boolean;
  isolatedCount: number;
  hiddenCount: number;
  ghostModeOn: boolean;
  selectedElementId: number | null;
  selectedCount: number;
  highlightedCount: number;
  colourBy: string;
  colourLayerCount: number;
  hoverHighlightEnabled: boolean;
  measurementMode: string;
}

/** The proxy is unstyled/unmerged, so durable appearance or merge state keeps the primary visible. */
export function canUseNavigationLod(input: NavigationLodAppearanceInput): boolean {
  return input.enabled
    && input.isolatedCount === 0
    && input.hiddenCount === 0
    && !input.ghostModeOn
    && input.selectedElementId === null
    && input.selectedCount === 0
    && input.highlightedCount === 0
    && input.colourBy === 'off'
    && input.colourLayerCount === 0
    && !input.furnishingMerged;
}

/** A static merged mesh cannot carry fragment-level picking or appearance. */
export function canUseFurnishingMerge(input: FurnishingMergeInteractionInput): boolean {
  return canUseNavigationLod({
    enabled: input.enabled,
    isolatedCount: input.isolatedCount,
    hiddenCount: input.hiddenCount,
    ghostModeOn: input.ghostModeOn,
    selectedElementId: input.selectedElementId,
    selectedCount: input.selectedCount,
    highlightedCount: input.highlightedCount,
    colourBy: input.colourBy,
    colourLayerCount: input.colourLayerCount,
    furnishingMerged: false,
  })
    && !input.hoverHighlightEnabled
    && input.measurementMode === 'off';
}

/**
 * The per-model graphicsQuality to write for a ladder level.
 *
 * MEASURED (2026-06-12, 63.7 MB / 5320-element fixture, warm A/B/A orbit
 * bench): q=0.6 48.7 fps vs q=0.85 48.5 fps - within noise. Lowering
 * quality during navigation buys no measurable frame time on this class of
 * model (the wire band it widens adds tile churn that offsets the culled
 * triangles) while it makes small/far elements visibly degrade or vanish.
 * So every tier pins the ladder's IDLE level; the per-model write still
 * matters because it makes the user's Performance-mode choice (and any
 * future tier policy) actually reach the worker, which the old
 * settings-only write never did.
 *
 * @param tier          the model's load-time tier
 * @param ladderQuality the ladder's current level (0.6 nav / 0.85 / 1.0)
 * @param idleQuality   the ladder's resolved idle (non-navigating) level
 */
export function resolveModelGraphicsQuality(
  tier: LodTier,
  ladderQuality: number,
  idleQuality: number,
): number {
  void ladderQuality;
  switch (tier) {
    case 'small':
      // ALL_VISIBLE ignores coverage thresholds; keep the idle value so a
      // future LodMode change does not inherit a stale nav drop.
      return idleQuality;
    case 'medium':
      // Floor rule: never widen the cull band during navigation.
      return idleQuality;
    case 'large':
      // Same floor until a >20k-element probe shows otherwise (see note).
      return idleQuality;
  }
}
