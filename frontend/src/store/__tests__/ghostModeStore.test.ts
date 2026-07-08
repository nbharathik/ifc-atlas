/**
 * Vitest coverage for the ghost-mode store slice.
 * Tests ghostModeOn state, setGhostModeOn action, and clearVisibility reset.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../useStore';

function resetSlice() {
  useStore.setState({ ghostModeOn: false, isolatedIds: [], hiddenIds: [] });
}

describe('ghostMode store slice', () => {
  beforeEach(resetSlice);

  describe('initial state', () => {
    it('starts with ghost mode off', () => {
      expect(useStore.getState().ghostModeOn).toBe(false);
    });
  });

  describe('setGhostModeOn', () => {
    it('enables ghost mode', () => {
      useStore.getState().setGhostModeOn(true);
      expect(useStore.getState().ghostModeOn).toBe(true);
    });

    it('disables ghost mode', () => {
      useStore.getState().setGhostModeOn(true);
      useStore.getState().setGhostModeOn(false);
      expect(useStore.getState().ghostModeOn).toBe(false);
    });

    it('is idempotent - setting false when already false is a no-op', () => {
      useStore.getState().setGhostModeOn(false);
      expect(useStore.getState().ghostModeOn).toBe(false);
    });

    it('is idempotent - setting true when already true stays true', () => {
      useStore.getState().setGhostModeOn(true);
      useStore.getState().setGhostModeOn(true);
      expect(useStore.getState().ghostModeOn).toBe(true);
    });
  });

  describe('clearVisibility resets ghost mode', () => {
    it('clears ghost mode when visibility is cleared', () => {
      useStore.getState().setGhostModeOn(true);
      useStore.getState().clearVisibility();
      expect(useStore.getState().ghostModeOn).toBe(false);
    });

    it('also clears isolatedIds and hiddenIds', () => {
      useStore.setState({ isolatedIds: [1, 2], hiddenIds: [3] });
      useStore.getState().setGhostModeOn(true);
      useStore.getState().clearVisibility();
      expect(useStore.getState().isolatedIds).toHaveLength(0);
      expect(useStore.getState().hiddenIds).toHaveLength(0);
      expect(useStore.getState().ghostModeOn).toBe(false);
    });
  });

  describe('ghost mode persists across isolation changes', () => {
    it('setIsolatedIds preserves existing ghost mode', () => {
      useStore.getState().setGhostModeOn(true);
      useStore.getState().setIsolatedIds([10, 20, 30]);
      expect(useStore.getState().ghostModeOn).toBe(true);
    });

    it('ghost mode is independent of hiddenIds', () => {
      useStore.getState().setGhostModeOn(true);
      useStore.getState().setHiddenIds([5, 6]);
      expect(useStore.getState().ghostModeOn).toBe(true);
    });
  });

  describe('reset() clears ghost mode', () => {
    it('resets ghost mode via store reset', () => {
      useStore.getState().setGhostModeOn(true);
      useStore.getState().reset();
      expect(useStore.getState().ghostModeOn).toBe(false);
    });
  });
});
