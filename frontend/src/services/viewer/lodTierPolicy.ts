/**
 * Model-size tiers + per-model graphics-quality policy.
 *
 * Stable-geometry contract (the IFCLite / Dalux approach): EVERY model, at
 * every size, renders ONE static representation - LodMode.ALL_VISIBLE. The
 * fragments worker's camera-driven pipeline (screen-coverage cull, frustum
 * cull, wireframe LOD swap) is disabled outright, so no element ever pops
 * in/out or changes detail during orbit, zoom, click, or after the camera
 * rests. ViewerPanel sets ALL_VISIBLE synchronously at model load.
 *
 * The triangle/memory budget is controlled where it cannot cause pop:
 *   - at CONVERSION time (parseProfiles.ts: CIRCLE_SEGMENTS tessellation,
 *     category drops, geometry welding on faster profiles), and
 *   - by the opt-in decimated navigation proxy for large models (lodSwap.ts,
 *     `largeModelLod` preference, off by default).
 *
 * The tiers below remain for the two things that still scale with model
 * size: whether the decimated navigation proxy is worth its memory
 * (large only), and the per-model graphicsQuality write (kept so the
 * user's Performance-mode choice reaches the worker; under ALL_VISIBLE the
 * classifier early-returns, so quality can never hide geometry).
 *
 * Engine background (verified against @thatopen/fragments 3.4.0): the
 * worker's coverage classifier scales its pixel thresholds by
 * `factor = -1.5 * model.graphicsQuality + 2` - but only in DEFAULT /
 * ALL_GEOMETRY modes, which this app no longer uses anywhere.
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
