/**
 * Unit tests for the FastModelPicker miss-guard pattern.
 *
 * The miss-guard calls fastPicker.getModelAt(mouse) before model.raycast().
 * When getModelAt returns null (empty space), raycast is skipped. These tests
 * verify that logic with a mock picker.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock FastModelPicker: controllable getModelAt return value.
interface MockFastPicker {
  getModelAt: ReturnType<typeof vi.fn>;
}

function makePicker(hitModelId: string | null): MockFastPicker {
  return { getModelAt: vi.fn().mockResolvedValue(hitModelId) };
}

// Minimal mock for model.raycast - tracks whether it was called.
function makeModel() {
  return {
    raycast: vi.fn().mockResolvedValue({ itemId: 42, localId: 7 }),
  };
}

// Simulate the miss-guard logic from onPointerUp / runMovePreview.
async function runClickGuard(
  picker: MockFastPicker | null,
  model: ReturnType<typeof makeModel>,
  mouse: { x: number; y: number },
  selectElement: ReturnType<typeof vi.fn>,
  hasExistingSelection: boolean,
): Promise<'missed' | 'hit'> {
  const THREE_Vec = { x: mouse.x, y: mouse.y };

  if (picker) {
    const hitModelId = await picker.getModelAt(THREE_Vec);
    if (!hitModelId) {
      if (hasExistingSelection) selectElement(null);
      return 'missed';
    }
  }

  await model.raycast({ camera: {}, mouse: THREE_Vec, dom: {} });
  return 'hit';
}

async function runHoverGuard(
  picker: MockFastPicker | null,
  model: ReturnType<typeof makeModel>,
  mouse: { x: number; y: number },
  prevHoverLocalId: number | null,
  resetHighlight: ReturnType<typeof vi.fn>,
): Promise<'missed' | 'hit'> {
  const THREE_Vec = { x: mouse.x, y: mouse.y };

  if (picker) {
    const hitModelId = await picker.getModelAt(THREE_Vec);
    if (!hitModelId) {
      if (prevHoverLocalId !== null) {
        resetHighlight([prevHoverLocalId]);
      }
      return 'missed';
    }
  }

  await model.raycast({ camera: {}, mouse: THREE_Vec, dom: {} });
  return 'hit';
}

describe('FastModelPicker miss-guard - click path', () => {
  let model: ReturnType<typeof makeModel>;
  let selectElement: ReturnType<typeof vi.fn>;
  const mouse = { x: 400, y: 300 };

  beforeEach(() => {
    model = makeModel();
    selectElement = vi.fn();
  });

  it('skips raycast and clears selection on miss', async () => {
    const picker = makePicker(null);
    const outcome = await runClickGuard(picker, model, mouse, selectElement, true);
    expect(outcome).toBe('missed');
    expect(model.raycast).not.toHaveBeenCalled();
    expect(selectElement).toHaveBeenCalledWith(null);
  });

  it('proceeds to raycast on model hit', async () => {
    const picker = makePicker('model-uuid-abc');
    const outcome = await runClickGuard(picker, model, mouse, selectElement, false);
    expect(outcome).toBe('hit');
    expect(model.raycast).toHaveBeenCalledOnce();
    expect(selectElement).not.toHaveBeenCalled();
  });

  it('does not clear selection on miss when nothing was selected', async () => {
    const picker = makePicker(null);
    await runClickGuard(picker, model, mouse, selectElement, false);
    expect(selectElement).not.toHaveBeenCalled();
    expect(model.raycast).not.toHaveBeenCalled();
  });

  it('falls through to raycast when picker is null (disabled)', async () => {
    const outcome = await runClickGuard(null, model, mouse, selectElement, true);
    expect(outcome).toBe('hit');
    expect(model.raycast).toHaveBeenCalledOnce();
  });

  it('calls getModelAt with the mouse coordinates', async () => {
    const picker = makePicker('some-model');
    await runClickGuard(picker, model, mouse, selectElement, false);
    expect(picker.getModelAt).toHaveBeenCalledWith(mouse);
  });
});

describe('FastModelPicker miss-guard - hover path', () => {
  let model: ReturnType<typeof makeModel>;
  let resetHighlight: ReturnType<typeof vi.fn>;
  const mouse = { x: 200, y: 150 };

  beforeEach(() => {
    model = makeModel();
    resetHighlight = vi.fn();
  });

  it('skips raycast and resets hover on miss with existing hover', async () => {
    const picker = makePicker(null);
    const outcome = await runHoverGuard(picker, model, mouse, 99, resetHighlight);
    expect(outcome).toBe('missed');
    expect(model.raycast).not.toHaveBeenCalled();
    expect(resetHighlight).toHaveBeenCalledWith([99]);
  });

  it('skips raycast and does not call resetHighlight when no prior hover', async () => {
    const picker = makePicker(null);
    const outcome = await runHoverGuard(picker, model, mouse, null, resetHighlight);
    expect(outcome).toBe('missed');
    expect(model.raycast).not.toHaveBeenCalled();
    expect(resetHighlight).not.toHaveBeenCalled();
  });

  it('proceeds to raycast when GPU detects model under cursor', async () => {
    const picker = makePicker('model-uuid-xyz');
    const outcome = await runHoverGuard(picker, model, mouse, null, resetHighlight);
    expect(outcome).toBe('hit');
    expect(model.raycast).toHaveBeenCalledOnce();
  });

  it('falls through to raycast when picker is null', async () => {
    const outcome = await runHoverGuard(null, model, mouse, 5, resetHighlight);
    expect(outcome).toBe('hit');
    expect(resetHighlight).not.toHaveBeenCalled();
    expect(model.raycast).toHaveBeenCalledOnce();
  });

  it('getModelAt is called with correct mouse vec on hover', async () => {
    const picker = makePicker('model-abc');
    await runHoverGuard(picker, model, mouse, null, resetHighlight);
    expect(picker.getModelAt).toHaveBeenCalledWith(mouse);
  });
});

describe('FastModelPicker miss-guard - performance invariant', () => {
  it('miss path calls getModelAt exactly once (no redundant GPU reads)', async () => {
    const model = makeModel();
    const picker = makePicker(null);
    await runClickGuard(picker, model, { x: 0, y: 0 }, vi.fn(), false);
    expect(picker.getModelAt).toHaveBeenCalledTimes(1);
  });

  it('hit path calls getModelAt exactly once then raycast once', async () => {
    const model = makeModel();
    const picker = makePicker('model-id');
    await runClickGuard(picker, model, { x: 0, y: 0 }, vi.fn(), false);
    expect(picker.getModelAt).toHaveBeenCalledTimes(1);
    expect(model.raycast).toHaveBeenCalledTimes(1);
  });
});
