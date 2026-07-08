export type RuntimeViewerQuality = 'interactive' | 'balanced' | 'quality';

export interface RuntimeQualitySettings {
  readonly profile: RuntimeViewerQuality;
  readonly pixelRatioCap: number;
  readonly graphicsQuality: number;
  /** Reserved for idle-only AO via PostproductionAspect - not yet
   *  consumed; ghost postproduction handles its own nav-gating today. */
  readonly postprocessing: 'off' | 'fast' | 'full';
  /** Consumed by the hover raycast policy: Performance mode suppresses
   *  hover-only raycasts so the fragments worker queue stays clear for
   *  clicks. Measuring is exempt. */
  readonly hoverRaycastEnabled: boolean;
  /** Reserved for culler updates through the scheduler - not yet
   *  consumed; the settle handler gates hide-passes on its own today. */
  readonly cullerHideEnabled: boolean;
}

export interface InteractionQualityState {
  readonly target: RuntimeViewerQuality;
  readonly active: RuntimeViewerQuality;
  readonly navigating: boolean;
  readonly slowFrameStreak: number;
  readonly stableFrameStreak: number;
}

export type InteractionQualityEvent =
  | { readonly type: 'navigation-start' }
  | { readonly type: 'navigation-end' }
  | { readonly type: 'frame'; readonly ms: number }
  | { readonly type: 'set-target'; readonly target: RuntimeViewerQuality };

export const RUNTIME_QUALITY_SETTINGS: Readonly<Record<RuntimeViewerQuality, RuntimeQualitySettings>> = {
  interactive: {
    profile: 'interactive',
    // pixelRatioCap 1.0 / graphicsQuality 0.6 keep orbit byte-identical to the
    // pre-ladder navigation binary (navigationPixelRatioCap=1.0, GQ_ORBIT=0.6)
    // and are the cheapest navigation settings - the correct direction for the
    // orbit-FPS target.
    pixelRatioCap: 1.0,
    graphicsQuality: 0.6,
    postprocessing: 'off',
    hoverRaycastEnabled: false,
    cullerHideEnabled: false,
  },
  balanced: {
    profile: 'balanced',
    pixelRatioCap: 1.5,
    graphicsQuality: 0.85,
    postprocessing: 'fast',
    hoverRaycastEnabled: true,
    cullerHideEnabled: true,
  },
  quality: {
    profile: 'quality',
    pixelRatioCap: 2,
    graphicsQuality: 1,
    postprocessing: 'full',
    hoverRaycastEnabled: true,
    cullerHideEnabled: true,
  },
};

export const DEFAULT_INTERACTION_QUALITY_STATE: InteractionQualityState = {
  target: 'balanced',
  active: 'balanced',
  navigating: false,
  slowFrameStreak: 0,
  stableFrameStreak: 0,
};

const ORDER: readonly RuntimeViewerQuality[] = ['interactive', 'balanced', 'quality'];

function stepDown(profile: RuntimeViewerQuality): RuntimeViewerQuality {
  const idx = ORDER.indexOf(profile);
  return ORDER[Math.max(0, idx - 1)];
}

function stepTowardTarget(active: RuntimeViewerQuality, target: RuntimeViewerQuality): RuntimeViewerQuality {
  const activeIdx = ORDER.indexOf(active);
  const targetIdx = ORDER.indexOf(target);
  if (activeIdx >= targetIdx) return active;
  return ORDER[activeIdx + 1];
}

export function getRuntimeQualitySettings(
  profile: RuntimeViewerQuality,
): RuntimeQualitySettings {
  return RUNTIME_QUALITY_SETTINGS[profile];
}

export function reduceInteractionQuality(
  state: InteractionQualityState,
  event: InteractionQualityEvent,
): InteractionQualityState {
  switch (event.type) {
    case 'navigation-start':
      return {
        ...state,
        active: 'interactive',
        navigating: true,
        slowFrameStreak: 0,
        stableFrameStreak: 0,
      };
    case 'navigation-end':
      return {
        ...state,
        navigating: false,
        slowFrameStreak: 0,
        stableFrameStreak: 0,
      };
    case 'set-target':
      return {
        ...state,
        target: event.target,
        active: state.navigating ? 'interactive' : event.target,
        slowFrameStreak: 0,
        stableFrameStreak: 0,
      };
    case 'frame': {
      if (!Number.isFinite(event.ms) || event.ms <= 0) return state;
      if (state.navigating) return state;

      if (event.ms > 33) {
        const slowFrameStreak = state.slowFrameStreak + 1;
        if (slowFrameStreak >= 2) {
          return {
            ...state,
            active: stepDown(state.active),
            slowFrameStreak: 0,
            stableFrameStreak: 0,
          };
        }
        return { ...state, slowFrameStreak, stableFrameStreak: 0 };
      }

      if (event.ms <= 18) {
        const stableFrameStreak = state.stableFrameStreak + 1;
        if (stableFrameStreak >= 8) {
          return {
            ...state,
            active: stepTowardTarget(state.active, state.target),
            slowFrameStreak: 0,
            stableFrameStreak: 0,
          };
        }
        return { ...state, slowFrameStreak: 0, stableFrameStreak };
      }

      return { ...state, slowFrameStreak: 0, stableFrameStreak: 0 };
    }
  }
}

export interface HoverRaycastPolicyInput {
  readonly measuring: boolean;
  readonly hoverHighlightEnabled: boolean;
  readonly cameraNavigating: boolean;
  /** D6a - the active quality tier's `hoverRaycastEnabled` knob. Optional so
   *  existing callers/tests keep their behavior; `false` suppresses
   *  hover-only raycasts (Performance mode), measuring stays exempt because
   *  it is explicit tool input. */
  readonly hoverQualityEnabled?: boolean;
}

export const HOVER_INTENT_DELAY_MS = 60;

export function shouldRunHoverRaycast(input: HoverRaycastPolicyInput): boolean {
  if (input.measuring) return true;
  if (!input.hoverHighlightEnabled) return false;
  if (input.hoverQualityEnabled === false) return false;
  return !input.cameraNavigating;
}

export function shouldDelayHoverRaycast(input: HoverRaycastPolicyInput): boolean {
  return (
    input.hoverHighlightEnabled
    && !input.measuring
    && !input.cameraNavigating
  );
}
