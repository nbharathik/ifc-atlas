/**
 * Graphics-profile transition decision.
 *
 * `setGraphicsProfile(...)` persists a parse-time preference. While a model
 * is loaded, SettingsModal routes changes through this helper and asks the
 * user to confirm because the current scene cannot be re-profiled in place.
 * The confirmed preference applies to the next reload or IFC drop.
 *
 * Framework-free decision layer (no THREE.js / @thatopen / Zustand imports).
 */

import type { ParseProfile } from './parseProfiles';

/**
 * Knob label vocabulary. Each label names a single tunable surface that
 * differs across the 4 profiles. The labels are stable strings (used in
 * tests + telemetry); do not rename without updating both.
 *
 * Today every knob is parse-time. `tweak-in-place` is currently
 * unreachable because no profile differs ONLY on renderer-side knobs; the
 * label vocabulary leaves room for future LOD / edge-detection / shadow
 * settings that could flip without a re-parse.
 */
export type ProfileKnob =
  | 'circle-segments'
  | 'drops-non-visual-categories'
  | 'drops-property-classes'
  | 'drops-mep-and-furnishing'
  | 'geometry-thresholds'
  | 'memory-limit';

export interface ProfileKnobs {
  readonly circleSegments: number;
  readonly dropsNonVisualCategories: boolean;
  readonly dropsPropertyClasses: boolean;
  readonly dropsMepAndFurnishing: boolean;
  readonly geometryThresholds: 'default' | 'performance' | 'ultra_fast';
  readonly memoryLimitMb: number | null;
}

/**
 * Per-profile knob snapshot. Mirrors `parseProfiles.ts` /
 * `backend/sidecar/src/profiles.ts`. The values are the *behavioural*
 * shape, not byte-equal to the @thatopen IfcImporter calls, because
 * the decision helper only needs to know whether knobs differ, not what
 * the runtime calls them.
 *
 * Keep in lock-step with `parseProfiles.ts`. A future codegen pass could
 * derive this from the importer config directly.
 */
export const PROFILE_KNOBS: Readonly<Record<ParseProfile, ProfileKnobs>> = {
  quality: {
    circleSegments: 24,
    dropsNonVisualCategories: false,
    dropsPropertyClasses: false,
    dropsMepAndFurnishing: false,
    geometryThresholds: 'default',
    memoryLimitMb: null,
  },
  balanced: {
    circleSegments: 18,
    dropsNonVisualCategories: true,
    dropsPropertyClasses: false,
    dropsMepAndFurnishing: false,
    geometryThresholds: 'default',
    memoryLimitMb: null,
  },
  performance: {
    circleSegments: 14,
    dropsNonVisualCategories: true,
    dropsPropertyClasses: true,
    dropsMepAndFurnishing: false,
    geometryThresholds: 'performance',
    memoryLimitMb: 384,
  },
  ultra_fast: {
    circleSegments: 6,
    dropsNonVisualCategories: true,
    dropsPropertyClasses: true,
    dropsMepAndFurnishing: true,
    geometryThresholds: 'ultra_fast',
    memoryLimitMb: 1024,
  },
};

/**
 * Compare two profiles' knob sets. Returns the list of knob labels that
 * differ, in a deterministic order so test assertions don't have to sort.
 * Identical profiles return `[]`.
 */
export function diffProfileKnobs(a: ParseProfile, b: ParseProfile): ProfileKnob[] {
  if (a === b) return [];
  const ka = PROFILE_KNOBS[a];
  const kb = PROFILE_KNOBS[b];
  const out: ProfileKnob[] = [];
  if (ka.circleSegments !== kb.circleSegments) out.push('circle-segments');
  if (ka.dropsNonVisualCategories !== kb.dropsNonVisualCategories) {
    out.push('drops-non-visual-categories');
  }
  if (ka.dropsPropertyClasses !== kb.dropsPropertyClasses) {
    out.push('drops-property-classes');
  }
  if (ka.dropsMepAndFurnishing !== kb.dropsMepAndFurnishing) {
    out.push('drops-mep-and-furnishing');
  }
  if (ka.geometryThresholds !== kb.geometryThresholds) out.push('geometry-thresholds');
  if (ka.memoryLimitMb !== kb.memoryLimitMb) out.push('memory-limit');
  return out;
}

/**
 * Every knob in the vocabulary is parse-time today. Listed explicitly so a
 * future renderer-side knob (LOD threshold, edge detection, shadow
 * quality) can be added as `'in-place'` without touching call sites.
 */
const KNOB_REBUILD_REQUIREMENT: Readonly<Record<ProfileKnob, 'parse-time' | 'in-place'>> = {
  'circle-segments': 'parse-time',
  'drops-non-visual-categories': 'parse-time',
  'drops-property-classes': 'parse-time',
  'drops-mep-and-furnishing': 'parse-time',
  'geometry-thresholds': 'parse-time',
  'memory-limit': 'parse-time',
};

export type ProfileTransitionKind =
  | 'noop'
  | 'noop-no-model'
  | 'tweak-in-place'
  | 'reload-required';

export interface ProfileTransitionInput {
  readonly prev: ParseProfile;
  readonly next: ParseProfile;
  readonly modelLoaded: boolean;
}

export interface ProfileTransitionPlan {
  readonly kind: ProfileTransitionKind;
  readonly reason: string;
  readonly changedKnobs: readonly ProfileKnob[];
}

/**
 * Decide what should happen for a (prev → next) profile change.
 *
 * - `noop` - prev === next; nothing to do.
 * - `noop-no-model` - no model loaded yet; just persist the pref. The
 *   next load picks the new profile up at startup (current behaviour of
 *   `ViewerPanel.tsx`'s `startupState.graphicsProfile` capture).
 * - `tweak-in-place` - only in-place knobs differ; renderer can apply
 *   without a re-parse. Not reachable today (every knob is parse-time);
 *   reserved for future LOD / edge / shadow settings.
 * - `reload-required` - at least one parse-time knob differs; the
 *   fragment scene needs a re-parse. Today this fires for every
 *   cross-profile transition while a model is loaded.
 */
export function decideProfileTransition(
  input: ProfileTransitionInput,
): ProfileTransitionPlan {
  const { prev, next, modelLoaded } = input;

  if (prev === next) {
    return { kind: 'noop', reason: 'same-profile', changedKnobs: [] };
  }

  const changedKnobs = diffProfileKnobs(prev, next);

  if (!modelLoaded) {
    return {
      kind: 'noop-no-model',
      reason: 'no-model-loaded-pref-only',
      changedKnobs,
    };
  }

  const anyParseTime = changedKnobs.some(
    (k) => KNOB_REBUILD_REQUIREMENT[k] === 'parse-time',
  );

  if (anyParseTime) {
    return {
      kind: 'reload-required',
      reason: 'parse-time-knobs-differ',
      changedKnobs,
    };
  }

  return {
    kind: 'tweak-in-place',
    reason: 'only-in-place-knobs-differ',
    changedKnobs,
  };
}

/**
 * Counter shape for telemetry over a stream of transition plans. Pin
 * exists so a future wire-up that introduces unexpected `reload-required`
 * fires (e.g. for `prev === next`) can be caught by a regression test.
 */
export interface ProfileTransitionTally {
  readonly noop: number;
  readonly noopNoModel: number;
  readonly tweakInPlace: number;
  readonly reloadRequired: number;
  readonly total: number;
}

export function tallyProfileTransitions(
  stream: readonly ProfileTransitionPlan[],
): ProfileTransitionTally {
  let noop = 0;
  let noopNoModel = 0;
  let tweakInPlace = 0;
  let reloadRequired = 0;
  for (const plan of stream) {
    switch (plan.kind) {
      case 'noop':
        noop += 1;
        break;
      case 'noop-no-model':
        noopNoModel += 1;
        break;
      case 'tweak-in-place':
        tweakInPlace += 1;
        break;
      case 'reload-required':
        reloadRequired += 1;
        break;
    }
  }
  return {
    noop,
    noopNoModel,
    tweakInPlace,
    reloadRequired,
    total: stream.length,
  };
}

/**
 * Notice shape for the SettingsModal wire-up.
 *
 * `kind` matches the existing Toast vocabulary (`'success' | 'error' | 'info'`)
 * in `useStore.ts`. We never escalate the profile-change toast past `info`;
 * a settings-pref change is not an error, even when it won't take effect
 * until reload. `null` means no toast should fire.
 *
 * `message` is user-facing copy. Keep it short enough to fit the toast
 * stack (one line on a standard 1440-wide window).
 */
export interface ProfileTransitionNotice {
  readonly kind: 'info' | null;
  readonly message: string | null;
}

/**
 * Map a transition plan to the toast notice the SettingsModal should fire
 * when the user changes the Graphics profile dropdown.
 *
 * - `noop` (prev === next): the React `onChange` handler shouldn't have
 *   fired, but defensively return null so no toast appears.
 * - `noop-no-model`: silently persist the pref; the next model load picks
 *   it up at startup. No toast - users haven't loaded anything yet, so
 *   there's nothing to surface.
 * - `tweak-in-place`: the renderer can apply the change without a re-parse.
 *   Currently unreachable (every knob is parse-time); reserved for future
 *   LOD / edge / shadow settings. We surface a confirm-style "applied"
 *   toast so users know the new pref is live.
 * - `reload-required`: the pref is saved but the currently-rendered scene
 *   still uses the previous profile. Tell the user to reload, and list the
 *   knobs that changed so the choice doesn't feel arbitrary.
 *
 * The `next` profile name is included verbatim - callers pass the same
 * string that drives the `<select>` (e.g. `'performance'`), so the toast
 * matches the dropdown label exactly.
 */
export function formatProfileTransitionNotice(
  plan: ProfileTransitionPlan,
  next: ParseProfile,
): ProfileTransitionNotice {
  switch (plan.kind) {
    case 'noop':
    case 'noop-no-model':
      return { kind: null, message: null };
    case 'tweak-in-place':
      return {
        kind: 'info',
        message: `Graphics profile applied: ${next}.`,
      };
    case 'reload-required': {
      const knobs = plan.changedKnobs.join(', ');
      return {
        kind: 'info',
        message: `Re-load the model to apply the ${next} graphics profile (changed: ${knobs}).`,
      };
    }
  }
}

/**
 * UI flow vocabulary for the SettingsModal Graphics-profile dropdown.
 *
 * - `silent`: persist the pref immediately, no UI surface. Used for
 *   `noop` (same profile selected again - should not happen normally
 *   because React `onChange` doesn't fire on equal values, but defensive)
 *   and `noop-no-model` (no model loaded yet, so reload is irrelevant).
 * - `immediate`: persist immediately + fire an "applied" info toast. Used
 *   for `tweak-in-place` (currently unreachable, reserved for future
 *   renderer-side knobs that don't need a re-parse).
 * - `confirm`: hold the change behind a user confirmation modal. The
 *   pref is NOT persisted yet - the modal asks the user "Apply the
 *   {next} profile? You'll need to re-load the model to see the change."
 *   On Confirm → persist + show a follow-up info toast telling them to
 *   re-drop the IFC. On Cancel → do nothing (the dropdown reverts to
 *   `prev`). Used for `reload-required`.
 */
export type ProfileChangeFlow = 'silent' | 'immediate' | 'confirm';

export interface ProfileChangeFlowDecision {
  readonly flow: ProfileChangeFlow;
  /** Title text for the confirm modal. Only present when flow=confirm. */
  readonly confirmTitle: string | null;
  /** Body text for the confirm modal. Only present when flow=confirm. */
  readonly confirmBody: string | null;
}

/**
 * Map a transition plan to the UI flow the dropdown should follow.
 *
 * The split exists so the modal's copy lives next to the toast's copy in
 * a single pure helper. SettingsModal reads `flow` to decide whether to
 * persist + toast immediately (`silent` / `immediate`) or hold the
 * change behind the modal (`confirm`).
 */
export function decideProfileChangeFlow(
  plan: ProfileTransitionPlan,
  next: ParseProfile,
): ProfileChangeFlowDecision {
  switch (plan.kind) {
    case 'noop':
    case 'noop-no-model':
      return { flow: 'silent', confirmTitle: null, confirmBody: null };
    case 'tweak-in-place':
      return { flow: 'immediate', confirmTitle: null, confirmBody: null };
    case 'reload-required': {
      const knobs = plan.changedKnobs.join(', ');
      return {
        flow: 'confirm',
        confirmTitle: `Switch to '${next}' graphics profile?`,
        confirmBody:
          `This profile differs in ${knobs}. Re-drop your IFC after ` +
          `confirming to render with the new profile. Cancel to keep ` +
          `the current profile.`,
      };
    }
  }
}
