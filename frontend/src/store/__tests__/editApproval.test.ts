/**
 * Edit approval: inline Approve/Discard + auto mode, replacing the modal.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/api', () => ({
  undoLastEdit: vi.fn(),
  executeOperation: vi.fn(),
  undoOperation: vi.fn(),
  redoOperation: vi.fn(),
  getEditState: vi.fn(async () => ({ loaded: true, dirty: false, edit_mode_enabled: true })),
  applyPendingEditWithRetry: vi.fn(async () => ({ edit_id: 'E1' })),
  discardPendingEdit: vi.fn(async () => ({ edit_id: 'E1' })),
}));

import { useStore } from '../useStore';
import * as api from '../../services/api';
import type { PendingEditEnvelope } from '../../types/ifc';

function env(edit_id: string): PendingEditEnvelope {
  return {
    edit_id, created_at: 0, base_model_version: 1, base_model_fingerprint: 'fp',
    sandbox_fingerprint: 'fp2', summary: 's', operations: [], changes: [], counts: {},
  };
}

describe('editApprovalMode', () => {
  beforeEach(() => {
    useStore.setState({ editApprovalMode: 'ask', pendingEdits: [], pendingEditOutcomes: {} });
  });

  it('defaults to ask and is settable', () => {
    expect(useStore.getState().editApprovalMode).toBe('ask');
    useStore.getState().setEditApprovalMode('auto');
    expect(useStore.getState().editApprovalMode).toBe('auto');
  });
});

describe('resolvePendingEdit', () => {
  beforeEach(() => {
    useStore.setState({ pendingEdits: [env('E1')], pendingEditOutcomes: {}, toasts: [] });
    vi.clearAllMocks();
  });

  it('apply calls the API, records the outcome, and removes the pending edit', async () => {
    await useStore.getState().resolvePendingEdit('E1', 'apply');
    expect(api.applyPendingEditWithRetry).toHaveBeenCalledWith('E1');
    expect(useStore.getState().pendingEditOutcomes.E1).toBe('applied');
    expect(useStore.getState().pendingEdits.some((e) => e.edit_id === 'E1')).toBe(false);
  });

  it('discard calls the discard API and records the outcome', async () => {
    await useStore.getState().resolvePendingEdit('E1', 'discard');
    expect(api.discardPendingEdit).toHaveBeenCalledWith('E1');
    expect(useStore.getState().pendingEditOutcomes.E1).toBe('discarded');
  });

  it('is idempotent per id (already-resolved edits are skipped)', async () => {
    useStore.setState({ pendingEditOutcomes: { E1: 'applied' } });
    await useStore.getState().resolvePendingEdit('E1', 'apply');
    expect(api.applyPendingEditWithRetry).not.toHaveBeenCalled();
  });

  it('records an error outcome and toasts on failure', async () => {
    vi.mocked(api.applyPendingEditWithRetry).mockRejectedValueOnce(new Error('boom'));
    await useStore.getState().resolvePendingEdit('E1', 'apply');
    expect(useStore.getState().pendingEditOutcomes.E1).toBe('error');
    expect(useStore.getState().toasts.some((t) => t.kind === 'error')).toBe(true);
  });
});
