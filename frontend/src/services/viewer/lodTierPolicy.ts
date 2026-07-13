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
 * NOTE (2026-07): ViewerPanel now pins EVERY model to ALL_VISIBLE LodMode,
 * not just the small tier, because DEFAULT-mode coverage culling made
 * elements flicker and vanish during orbit at any size (a regression against
 * the original viewer). Large models get their motion-time budget from the
 * decimated LOD swap instead. The tier below therefore only drives the
 * per-model graphicsQuality writes, which are inert under ALL_VISIBLE but
 * kept so the plumbing stays correct. Original tier rationale retained:
 *
 *   small  (< ALL_VISIBLE_MAX_ELEMENTS): ALL_VISIBLE LodMode - the worker
 *          skips coverage/frustum culling entirely, quality is irrelevant.
 *   medium (up to LARGE_MODEL_MIN_ELEMENTS): quality PINNED to the ladder's
 *          idle level at all times - navigation must not widen the cull band.
 *   large  (above): the nav drop is allowed (the alternative is dropped
 *          frames), and the resting level is capped at LARGE_TIER_MAX_QUALITY
 *          to keep the per-frame coverage budget bounded.
 *
 * Thresholds are provisional pending scaling probes; keep them as named
 * constants so tuning lands in one place.
 */

export type LodTier = 'small' | 'medium' | 'large';

/** Small/medium tier boundary and the element-culler's small-model gate.
 *  ViewerPanel now runs ALL_VISIBLE at every tier (see the NOTE above), so
 *  this no longer gates ALL_VISIBLE; it still classifies the tier used for
 *  the per-model quality writes and the frustum-culler enablement. */
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
