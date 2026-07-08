import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the api module so undoLastEdit doesn't make real HTTP calls
vi.mock('../../services/api', () => ({
  undoLastEdit: vi.fn(),
}));

import { useStore } from '../useStore';
import * as api from '../../services/api';

describe('undoLastEdit store action', () => {
  beforeEach(() => {
    // Reset relevant store state between tests
    useStore.setState({ isUndoing: false, toasts: [], modelLoaded: true });
    vi.clearAllMocks();
  });

  it('sets isUndoing to true while request is in flight', async () => {
    let resolve!: (v: unknown) => void;
    const pending = new Promise((r) => { resolve = r; });
    vi.mocked(api.undoLastEdit).mockReturnValueOnce(pending as ReturnType<typeof api.undoLastEdit>);

    const promise = useStore.getState().undoLastEdit();
    // Immediately after calling, isUndoing should be true
    expect(useStore.getState().isUndoing).toBe(true);

    resolve({ undone: false, reason: 'empty' });
    await promise;
    expect(useStore.getState().isUndoing).toBe(false);
  });

  it('does not call api when already undoing', async () => {
    useStore.setState({ isUndoing: true });
    await useStore.getState().undoLastEdit();
    expect(api.undoLastEdit).not.toHaveBeenCalled();
  });

  it('does not call api when model is not loaded', async () => {
    useStore.setState({ modelLoaded: false, isUndoing: false });
    await useStore.getState().undoLastEdit();
    expect(api.undoLastEdit).not.toHaveBeenCalled();
  });

  it('adds success toast when undone=true', async () => {
    vi.mocked(api.undoLastEdit).mockResolvedValueOnce({
      undone: true,
      description: 'rename wall',
    });
    await useStore.getState().undoLastEdit();
    const { toasts } = useStore.getState();
    expect(toasts.length).toBeGreaterThan(0);
    expect(toasts[0].kind).toBe('success');
    expect(toasts[0].message).toContain('rename wall');
  });

  it('adds info toast when undone=false (stack empty)', async () => {
    vi.mocked(api.undoLastEdit).mockResolvedValueOnce({
      undone: false,
      reason: 'Undo stack is empty',
    });
    await useStore.getState().undoLastEdit();
    const { toasts } = useStore.getState();
    expect(toasts.length).toBeGreaterThan(0);
    expect(toasts[0].kind).toBe('info');
  });

  it('adds error toast when api throws', async () => {
    vi.mocked(api.undoLastEdit).mockRejectedValueOnce(new Error('Network error'));
    await useStore.getState().undoLastEdit();
    const { toasts } = useStore.getState();
    expect(toasts.length).toBeGreaterThan(0);
    expect(toasts[0].kind).toBe('error');
    expect(toasts[0].message).toContain('Undo failed');
  });

  it('resets isUndoing to false even when api throws', async () => {
    vi.mocked(api.undoLastEdit).mockRejectedValueOnce(new Error('fail'));
    await useStore.getState().undoLastEdit();
    expect(useStore.getState().isUndoing).toBe(false);
  });
});

describe('toast store slice', () => {
  beforeEach(() => {
    useStore.setState({ toasts: [] });
  });

  it('addToast adds a toast', () => {
    useStore.getState().addToast('hello', 'info');
    expect(useStore.getState().toasts).toHaveLength(1);
    expect(useStore.getState().toasts[0].message).toBe('hello');
    expect(useStore.getState().toasts[0].kind).toBe('info');
  });

  it('removeToast removes by id', () => {
    useStore.getState().addToast('hello', 'success');
    const id = useStore.getState().toasts[0].id;
    useStore.getState().removeToast(id);
    expect(useStore.getState().toasts).toHaveLength(0);
  });

  it('addToast defaults kind to info', () => {
    useStore.getState().addToast('msg');
    expect(useStore.getState().toasts[0].kind).toBe('info');
  });
});
