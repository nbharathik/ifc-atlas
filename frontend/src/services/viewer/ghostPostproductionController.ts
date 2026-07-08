export interface GhostPostproductionTarget<EdgeMode = unknown> {
  enabled: boolean;
  edgesPass: {
    xray: boolean;
    mode?: EdgeMode;
  };
}

export interface GhostPostproductionInput<EdgeMode = unknown> {
  readonly ghostModeOn: boolean;
  readonly navigating: boolean;
  readonly fastEdgeMode: EdgeMode;
}

export interface GhostPostproductionSnapshot<EdgeMode = unknown> {
  readonly enabled: boolean;
  readonly xray: boolean;
  readonly mode: EdgeMode | undefined;
}

/**
 * Ghost mode no longer enables the postproduction composer at all.
 *
 * The composer's default style chain is basePass + outputPass only; the
 * EdgeDetectionPass this controller configures is added to the chain only by
 * the PEN-family styles, which the app never sets. Enabling the composer
 * therefore paid a SECOND full scene render plus two render-target clears
 * and a fullscreen blit per frame while ghost mode was on, for output
 * visually identical to the plain render - the xray edges never drew.
 * Ghost legibility comes entirely from the fragments-side opacity write.
 * The edgesPass configuration is kept so a future edges feature (perf plan
 * LM-R2, which would set a PEN style and gate it on rest) inherits the
 * right xray/mode state, but `enabled` now stays false in every state.
 */
export function applyGhostPostproductionState<EdgeMode>(
  target: GhostPostproductionTarget<EdgeMode> | null,
  input: GhostPostproductionInput<EdgeMode>,
): GhostPostproductionSnapshot<EdgeMode> | null {
  if (!target) return null;

  if (!input.ghostModeOn) {
    target.edgesPass.xray = false;
    target.enabled = false;
    return {
      enabled: target.enabled,
      xray: target.edgesPass.xray,
      mode: target.edgesPass.mode,
    };
  }

  target.edgesPass.xray = true;
  target.edgesPass.mode = input.fastEdgeMode;
  target.enabled = false;

  return {
    enabled: target.enabled,
    xray: target.edgesPass.xray,
    mode: target.edgesPass.mode,
  };
}
