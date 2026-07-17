/**
 * Edit-scope store slice: semantic (no viewer reload) vs structural (reloads).
 * See dev/docs/EDIT_SCOPES.md.
 *
 * Structural is gated off for the v0.1.1 release (STRUCTURAL_EDIT_ENABLED in
 * config/featureFlags.ts). These tests branch on the flag so they keep asserting
 * the right contract when it flips back on, rather than baking in "off" forever.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../useStore';
import { STRUCTURAL_EDIT_ENABLED } from '../../config/featureFlags';

describe('editScope store slice', () => {
  beforeEach(() => {
    useStore.setState({ editScope: 'semantic' });
  });

  it('defaults to semantic (the safe, no-reload scope)', () => {
    expect(useStore.getState().editScope).toBe('semantic');
  });

  it.runIf(STRUCTURAL_EDIT_ENABLED)('setEditScope switches to structural and back', () => {
    useStore.getState().setEditScope('structural');
    expect(useStore.getState().editScope).toBe('structural');
    useStore.getState().setEditScope('semantic');
    expect(useStore.getState().editScope).toBe('semantic');
  });

  it.skipIf(STRUCTURAL_EDIT_ENABLED)('pins the scope to semantic while structural editing is gated off', () => {
    // The geometry-authoring surface (wall draw, structural AI write tools) all
    // gate on editScope === 'structural'. Coercing here is what makes the gate
    // airtight: a persisted `pref.editScope` of 'structural' from an earlier
    // build cannot resurrect it, and no caller can opt back in.
    useStore.getState().setEditScope('structural');
    expect(useStore.getState().editScope).toBe('semantic');
  });
});
