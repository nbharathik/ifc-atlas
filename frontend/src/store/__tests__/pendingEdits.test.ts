/**
 * Vitest coverage for the Invariant-4 pending-edit reducers on the Zustand
 * store (upsertPendingEdit / removePendingEdit / setActivePendingEditId).
 *
 * The reducers are small but load-bearing - they drive which DiffPreviewPanel
 * surfaces, whether the Apply button is live, and whether a CommandPalette
 * entry can reopen a dismissed edit. Regressions here look like "the panel
 * never shows up after a sandbox proposal" or "apply works once, then stops".
 * We want them caught in CI, not in a live edit session.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { useStore } from '../useStore';
import type { PendingEditEnvelope } from '../../types/ifc';

function env(edit_id: string, summary = `edit ${edit_id}`): PendingEditEnvelope {
  return {
    edit_id,
    created_at: Date.now(),
    base_model_version: 1,
    base_model_fingerprint: 'fp-base',
    sandbox_fingerprint: `fp-sandbox-${edit_id}`,
    summary,
    operations: [],
    changes: [],
    counts: { total: 0 },
  };
}

function reset() {
  // Clear just the pending-edit slice; avoid calling reset() which wipes
  // cached prefs and can dirty subsequent tests sharing the module.
  useStore.setState({ pendingEdits: [], activePendingEditId: null });
}

describe('pending-edit reducers', () => {
  beforeEach(reset);

  describe('upsertPendingEdit', () => {
    it('inserts a new envelope and auto-focuses it', () => {
      const { upsertPendingEdit } = useStore.getState();
      upsertPendingEdit(env('A'));

      const s = useStore.getState();
      expect(s.pendingEdits).toHaveLength(1);
      expect(s.pendingEdits[0].edit_id).toBe('A');
      expect(s.activePendingEditId).toBe('A');
    });

    it('prepends newer edits (newest-first ordering)', () => {
      const { upsertPendingEdit } = useStore.getState();
      upsertPendingEdit(env('A'));
      upsertPendingEdit(env('B'));
      upsertPendingEdit(env('C'));

      const ids = useStore.getState().pendingEdits.map((e) => e.edit_id);
      // Newest-first - the freshly-proposed edit surfaces at the top so
      // the DiffPreviewPanel always opens to the right one.
      expect(ids).toEqual(['C', 'B', 'A']);
    });

    it('auto-focus moves with every fresh insert', () => {
      const { upsertPendingEdit } = useStore.getState();
      upsertPendingEdit(env('A'));
      expect(useStore.getState().activePendingEditId).toBe('A');
      upsertPendingEdit(env('B'));
      expect(useStore.getState().activePendingEditId).toBe('B');
    });

    it('refreshes an existing envelope in place without re-focusing', () => {
      const { upsertPendingEdit, setActivePendingEditId } = useStore.getState();
      upsertPendingEdit(env('A', 'v1'));
      upsertPendingEdit(env('B', 'v1'));
      // User dismissed the panel - activePendingEditId cleared.
      setActivePendingEditId(null);

      // Backend re-publishes A (e.g. fingerprint changed). This is an
      // update, not a fresh proposal - it must NOT yank focus back.
      upsertPendingEdit(env('A', 'v2'));

      const s = useStore.getState();
      const a = s.pendingEdits.find((e) => e.edit_id === 'A');
      expect(a?.summary).toBe('v2');
      // Order preserved: no re-shuffle on refresh.
      expect(s.pendingEdits.map((e) => e.edit_id)).toEqual(['B', 'A']);
      // Critical: a refresh must not surprise the user by reopening a
      // modal they actively dismissed.
      expect(s.activePendingEditId).toBeNull();
    });
  });

  describe('removePendingEdit', () => {
    it('drops the envelope from the list', () => {
      const { upsertPendingEdit, removePendingEdit } = useStore.getState();
      upsertPendingEdit(env('A'));
      upsertPendingEdit(env('B'));
      removePendingEdit('A');

      const s = useStore.getState();
      expect(s.pendingEdits.map((e) => e.edit_id)).toEqual(['B']);
    });

    it('clears activePendingEditId only when it matches the removed id', () => {
      const { upsertPendingEdit, removePendingEdit, setActivePendingEditId } =
        useStore.getState();
      upsertPendingEdit(env('A'));
      upsertPendingEdit(env('B'));
      // focus stays on whichever was inserted last - B
      expect(useStore.getState().activePendingEditId).toBe('B');

      // Removing a non-active edit must leave the active one alone.
      removePendingEdit('A');
      expect(useStore.getState().activePendingEditId).toBe('B');

      // Removing the active one drops focus to null.
      removePendingEdit('B');
      expect(useStore.getState().activePendingEditId).toBeNull();

      // Idempotent - removing something that doesn't exist is a no-op.
      setActivePendingEditId(null);
      removePendingEdit('ghost');
      expect(useStore.getState().pendingEdits).toHaveLength(0);
    });
  });

  describe('dismiss-then-reopen flow', () => {
    it('lets a dismissed edit be re-focused via setActivePendingEditId', () => {
      const { upsertPendingEdit, setActivePendingEditId } = useStore.getState();
      upsertPendingEdit(env('A'));
      // User dismisses the modal - envelope stays in the list.
      setActivePendingEditId(null);
      expect(useStore.getState().pendingEdits).toHaveLength(1);
      expect(useStore.getState().activePendingEditId).toBeNull();

      // CommandPalette / activity-log click re-focuses.
      setActivePendingEditId('A');
      expect(useStore.getState().activePendingEditId).toBe('A');
    });
  });
});
