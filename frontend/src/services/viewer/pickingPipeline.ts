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
