export type CullerNavigationState = 'navigating' | 'idle';

export type CullerPolicyMode =
  | 'disabled'
  | 'stand-down-user-visibility'
  | 'show-only'
  | 'hide-after-idle';

export interface CullerPolicyInput {
  readonly navigationState: CullerNavigationState;
  readonly elementCount: number;
  readonly isolatedCount: number;
  readonly hiddenCount: number;
  readonly storeyCullerBuilt: boolean;
  readonly elementCullerBuilt: boolean;
  readonly autoCulledCount: number;
  readonly smallModelElementThreshold?: number;
  readonly smallModelStoreyThreshold?: number;
}

export interface CullerPolicyDecision {
  readonly mode: CullerPolicyMode;
  readonly runShowPass: boolean;
  readonly runHidePass: boolean;
  readonly elementCullerEnabled: boolean;
  readonly storeyCullerEnabled: boolean;
}

export function decideCullerPolicy(input: CullerPolicyInput): CullerPolicyDecision {
  const smallModelElementThreshold = input.smallModelElementThreshold ?? 300;
  // Storey-culler gate: below this element count the GPU
  // handles the full draw with headroom to spare, so the only thing the
  // storey cull contributes is a visible pop on zoom-out as Fragments
  // re-inserts the un-hidden storey into its draw lists. The element
  // culler already gates at 300; the storey culler gates higher because
  // it's coarser - a single storey often covers hundreds of elements, so
  // its setVisible(true) round-trip touches more state at once.
  const smallModelStoreyThreshold = input.smallModelStoreyThreshold ?? 1500;
  const elementCullerEnabled =
    input.elementCullerBuilt && input.elementCount >= smallModelElementThreshold;
  const storeyCullerEnabled =
    input.storeyCullerBuilt && input.elementCount >= smallModelStoreyThreshold;
  const anyCullerEnabled = elementCullerEnabled || storeyCullerEnabled;

  if (!anyCullerEnabled) {
    return {
      mode: 'disabled',
      runShowPass: false,
      runHidePass: false,
      elementCullerEnabled,
      storeyCullerEnabled,
    };
  }

  if (input.isolatedCount > 0 || input.hiddenCount > 0) {
    return {
      mode: 'stand-down-user-visibility',
      runShowPass: false,
      runHidePass: false,
      elementCullerEnabled,
      storeyCullerEnabled,
    };
  }

  if (input.navigationState === 'navigating') {
    return {
      mode: 'show-only',
      runShowPass: input.autoCulledCount > 0,
      runHidePass: false,
      elementCullerEnabled,
      storeyCullerEnabled,
    };
  }

  return {
    mode: 'hide-after-idle',
    runShowPass: input.autoCulledCount > 0,
    runHidePass: anyCullerEnabled,
    elementCullerEnabled,
    storeyCullerEnabled,
  };
}
