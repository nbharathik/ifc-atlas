export interface PickRequestToken {
  readonly generation: number;
}

export interface PickStaleInput {
  readonly requestGeneration: number;
  readonly currentGeneration: number;
}

export interface VoidClickPolicyInput {
  readonly shiftKey: boolean;
  readonly selectedElementId: number | null;
  readonly fastPickerAvailable: boolean;
  readonly fastPickerHit: boolean;
  readonly exactHit: boolean;
}

export interface VoidClickDecision {
  readonly clearSelection: boolean;
  readonly skipExactRaycastNextTime: boolean;
}

export interface SameElementClickInput {
  readonly clickedExpressId: number;
  readonly selectedElementId: number | null;
  readonly selectedIds: readonly number[];
  readonly shiftKey: boolean;
}

export interface PointerGestureInput {
  readonly distancePx: number;
  readonly elapsedMs: number;
  readonly dragThresholdPx?: number;
}

export interface ExactPickOutcomeInput {
  readonly exactHit: boolean;
  readonly error: unknown | null;
}

export interface ExactHoverReuseInput {
  /** The cached hover came from the authoritative fragments worker. */
  readonly exactHit: boolean;
  readonly distancePx: number;
  readonly ageMs: number;
  readonly cameraUnchanged: boolean;
  readonly visibilityUnchanged: boolean;
  readonly fragmentReplacementBlocked: boolean;
  readonly tolerancePx?: number;
  readonly maxAgeMs?: number;
}

export interface PrefetchedPickReuseInput {
  /** Generation captured when the pointer-down prefetch started. */
  readonly requestGeneration: number;
  /** Latest canvas-interaction generation at pointer-up. */
  readonly currentGeneration: number;
  /** Distance from the prefetched screen point to the pointer-up point. */
  readonly distancePx: number;
  readonly cameraUnchanged: boolean;
  readonly visibilityUnchanged: boolean;
  readonly fragmentReplacementBlocked: boolean;
  readonly tolerancePx?: number;
}

export interface PickLeaseCoordinator {
  readonly active: boolean;
  readonly count: number;
  acquire: () => () => void;
}

/** Keep fragment-replacing optimizations suspended across overlapping picks. */
export function createPickLeaseCoordinator(
  onActiveChange: (active: boolean) => void,
): PickLeaseCoordinator {
  let count = 0;
  return {
    get active() {
      return count > 0;
    },
    get count() {
      return count;
    },
    acquire() {
      count += 1;
      if (count === 1) onActiveChange(true);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        count = Math.max(0, count - 1);
        if (count === 0) onActiveChange(false);
      };
    },
  };
}

export function createPickRequestToken(currentGeneration: number): PickRequestToken {
  return { generation: currentGeneration };
}

export function isStalePickResult(input: PickStaleInput): boolean {
  return input.requestGeneration !== input.currentGeneration;
}

export function decideVoidClick(input: VoidClickPolicyInput): VoidClickDecision {
  const noHit = !input.fastPickerHit && !input.exactHit;
  if (!noHit) {
    return { clearSelection: false, skipExactRaycastNextTime: false };
  }
  return {
    clearSelection: !input.shiftKey && input.selectedElementId !== null,
    skipExactRaycastNextTime: input.fastPickerAvailable,
  };
}

export function isNoopSameElementClick(input: SameElementClickInput): boolean {
  if (input.shiftKey) return false;
  if (input.selectedIds.length > 1) return false;
  if (input.selectedIds.length === 1) return input.selectedIds[0] === input.clickedExpressId;
  return input.selectedElementId === input.clickedExpressId;
}

/** Press duration alone must never turn a stationary accessibility click into a drag. */
export function isClickGesture(input: PointerGestureInput): boolean {
  return input.distancePx <= (input.dragThresholdPx ?? 4);
}

/** Only a successful exact raycast with no hit is a confirmed void click. */
export function isConfirmedVoidPick(input: ExactPickOutcomeInput): boolean {
  return input.error === null && !input.exactHit;
}

/**
 * Reuse a fresh authoritative hover result for a click at the same screen
 * position. This removes a redundant worker round-trip for quick clicks but
 * fails closed whenever camera, clipping/visibility, or fragment residency
 * could have changed. A cached miss is never reused as proof of empty space.
 */
export function canReuseExactHoverPick(input: ExactHoverReuseInput): boolean {
  return input.exactHit
    && Number.isFinite(input.distancePx)
    && input.distancePx <= (input.tolerancePx ?? 2)
    && Number.isFinite(input.ageMs)
    && input.ageMs >= 0
    && input.ageMs <= (input.maxAgeMs ?? 150)
    && input.cameraUnchanged
    && input.visibilityUnchanged
    && !input.fragmentReplacementBlocked;
}

/**
 * Reuse a pointer-down exact pick only when it still describes the scene and
 * screen point released by the user. A click may travel farther than an exact
 * raycast's safe reuse radius, so gesture classification alone is insufficient.
 */
export function canReusePrefetchedPick(input: PrefetchedPickReuseInput): boolean {
  return input.requestGeneration === input.currentGeneration
    && Number.isFinite(input.distancePx)
    && input.distancePx >= 0
    && input.distancePx <= (input.tolerancePx ?? 1)
    && input.cameraUnchanged
    && input.visibilityUnchanged
    && !input.fragmentReplacementBlocked;
}
