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
