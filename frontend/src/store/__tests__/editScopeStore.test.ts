/**
 * Edit-scope store slice: semantic (no viewer reload) vs structural (reloads).
 * See dev/docs/EDIT_SCOPES.md.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../useStore';

describe('editScope store slice', () => {
  beforeEach(() => {
    useStore.setState({ editScope: 'semantic' });
  });

  it('defaults to semantic (the safe, no-reload scope)', () => {
    expect(useStore.getState().editScope).toBe('semantic');
  });

  it('setEditScope switches to structural and back', () => {
    useStore.getState().setEditScope('structural');
    expect(useStore.getState().editScope).toBe('structural');
    useStore.getState().setEditScope('semantic');
    expect(useStore.getState().editScope).toBe('semantic');
  });
});
