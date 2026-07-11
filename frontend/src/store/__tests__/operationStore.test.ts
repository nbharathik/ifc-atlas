import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the api module so applyOperation doesn't make real HTTP calls.
vi.mock('../../services/api', () => ({
  undoLastEdit: vi.fn(),
  executeOperation: vi.fn(),
  undoOperation: vi.fn(),
  redoOperation: vi.fn(),
  // refreshEditState (fired after any changed op) dynamically imports this.
  getEditState: vi.fn(async () => ({ loaded: true, dirty: true, edit_mode_enabled: true })),
}));

import { useStore } from '../useStore';
import * as api from '../../services/api';
import type { OperationResult } from '../../types/ifc';

const OK_RESULT: OperationResult = {
  op_id: 'op1',
  operation: 'set_name',
  actor: 'user',
  ok: true,
  changed: true,
  changed_ids: [361],
  patch_tier: 'metadata',
  description: 'Renamed',
  edit_id: 'e1',
};

describe('editMode store slice', () => {
  beforeEach(() => {
    useStore.setState({ editMode: false });
  });

  it('setEditMode sets the flag', () => {
    useStore.getState().setEditMode(true);
    expect(useStore.getState().editMode).toBe(true);
  });

  it('toggleEditMode flips the flag', () => {
    expect(useStore.getState().editMode).toBe(false);
    useStore.getState().toggleEditMode();
    expect(useStore.getState().editMode).toBe(true);
    useStore.getState().toggleEditMode();
    expect(useStore.getState().editMode).toBe(false);
  });
});

describe('applyOperation store action', () => {
  beforeEach(() => {
    useStore.setState({ toasts: [] });
    vi.clearAllMocks();
  });

  it('calls executeOperation with the operation name + params', async () => {
    vi.mocked(api.executeOperation).mockResolvedValueOnce(OK_RESULT);
    const result = await useStore
      .getState()
      .applyOperation('set_name', { element_id: 361, new_name: 'X' });
    expect(api.executeOperation).toHaveBeenCalledWith('set_name', {
      element_id: 361,
      new_name: 'X',
    });
    expect(result?.ok).toBe(true);
  });

  it('surfaces an error toast when the op returns ok:false', async () => {
    vi.mocked(api.executeOperation).mockResolvedValueOnce({
      ...OK_RESULT,
      ok: false,
      changed: false,
      changed_ids: [],
      error: 'missing required param',
    });
    await useStore.getState().applyOperation('set_name', {});
    const { toasts } = useStore.getState();
    expect(
      toasts.some((t) => t.kind === 'error' && t.message.includes('missing required param')),
    ).toBe(true);
  });

  it('returns null and toasts on transport failure (e.g. 403 gated)', async () => {
    vi.mocked(api.executeOperation).mockRejectedValueOnce(new Error('API error 403'));
    const result = await useStore.getState().applyOperation('set_name', {});
    expect(result).toBeNull();
    expect(useStore.getState().toasts.some((t) => t.kind === 'error')).toBe(true);
  });

  it('adopts the fresh model contract carried on the result', async () => {
    useStore.setState({ modelVersion: 3, modelFingerprint: 'old-fp' });
    vi.mocked(api.executeOperation).mockResolvedValueOnce({
      ...OK_RESULT,
      model_version: 4,
      model_fingerprint: 'new-fp',
    });
    await useStore.getState().applyOperation('set_name', { element_id: 361, new_name: 'X' });
    expect(useStore.getState().modelFingerprint).toBe('new-fp');
    expect(useStore.getState().modelVersion).toBe(4);
  });
});

describe('editModeAvailable runtime flag', () => {
  it('defaults to false and is settable', () => {
    useStore.setState({ editModeAvailable: false });
    expect(useStore.getState().editModeAvailable).toBe(false);
    useStore.getState().setEditModeAvailable(true);
    expect(useStore.getState().editModeAvailable).toBe(true);
  });
});

describe('undoLastEdit routing', () => {
  beforeEach(() => {
    useStore.setState({ toasts: [], modelLoaded: true, isUndoing: false });
    vi.clearAllMocks();
  });

  it('routes through the operation layer when editModeAvailable', async () => {
    useStore.setState({ editModeAvailable: true });
    vi.mocked(api.undoOperation).mockResolvedValueOnce({
      ...OK_RESULT,
      operation: 'undo',
      description: 'Renamed back',
    });
    await useStore.getState().undoLastEdit();
    expect(api.undoOperation).toHaveBeenCalled();
    expect(api.undoLastEdit).not.toHaveBeenCalled();
    expect(useStore.getState().toasts.some((t) => t.message.includes('Undid'))).toBe(true);
  });

  it('falls back to the legacy undo when edit mode is unavailable', async () => {
    useStore.setState({ editModeAvailable: false });
    vi.mocked(api.undoLastEdit).mockResolvedValueOnce({
      undone: true,
      description: 'Renamed back',
      changed_ids: [1],
    } as Awaited<ReturnType<typeof api.undoLastEdit>>);
    await useStore.getState().undoLastEdit();
    expect(api.undoLastEdit).toHaveBeenCalled();
    expect(api.undoOperation).not.toHaveBeenCalled();
  });

  it('redoLastEdit is a no-op without editModeAvailable', async () => {
    useStore.setState({ editModeAvailable: false });
    await useStore.getState().redoLastEdit();
    expect(api.redoOperation).not.toHaveBeenCalled();
  });

  it('redoLastEdit calls the op layer and toasts', async () => {
    useStore.setState({ editModeAvailable: true });
    vi.mocked(api.redoOperation).mockResolvedValueOnce({
      ...OK_RESULT,
      operation: 'set_name',
      description: 'Renamed again',
    });
    await useStore.getState().redoLastEdit();
    expect(api.redoOperation).toHaveBeenCalled();
    expect(useStore.getState().toasts.some((t) => t.message.includes('Redid'))).toBe(true);
  });

  it('redoLastEdit shows an info toast when there is nothing to redo', async () => {
    useStore.setState({ editModeAvailable: true });
    vi.mocked(api.redoOperation).mockResolvedValueOnce({
      ...OK_RESULT,
      ok: false,
      changed: false,
      changed_ids: [],
      error: 'nothing to redo',
    });
    await useStore.getState().redoLastEdit();
    expect(
      useStore.getState().toasts.some((t) => t.kind === 'info' && t.message.includes('nothing to redo')),
    ).toBe(true);
  });
});

describe('invalidateElementDetails refresh serial', () => {
  it('bumps detailRefreshSerial when the selected element is invalidated', async () => {
    useStore.setState({ selectedElementId: 42, detailRefreshSerial: 0 });
    useStore.getState().invalidateElementDetails([42]);
    // The bump happens after the (dynamically imported) cache clear resolves;
    // the first ModelService import can be slow on a cold run, so give it
    // generous headroom to keep CI deterministic.
    await vi.waitFor(() => {
      expect(useStore.getState().detailRefreshSerial).toBe(1);
    }, { timeout: 5000 });
  });

  it('does not bump the serial for unrelated elements', async () => {
    useStore.setState({ selectedElementId: 42, detailRefreshSerial: 0 });
    useStore.getState().invalidateElementDetails([7]);
    await new Promise((r) => setTimeout(r, 20));
    expect(useStore.getState().detailRefreshSerial).toBe(0);
  });
});
