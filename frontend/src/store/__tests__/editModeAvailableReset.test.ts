/**
 * editModeAvailable survives reset().
 *
 * The flag mirrors the BACKEND's EDIT_MODE_ENABLED setting, probed once on
 * mount in App.tsx (deps `[]`). Closing a model calls reset(), which spreads
 * initialState - so before this was pinned, a close -> open cycle set the flag
 * back to false and nothing ever re-probed it: <App> does not remount, and the
 * refreshEditState() callers all sit on paths that a plain close/open never
 * reaches. The whole edit surface (New project in Menubar, the Edit toggle,
 * editable properties, undo/redo) stayed hidden until a full page reload.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../useStore';

describe('editModeAvailable across reset()', () => {
  beforeEach(() => {
    useStore.getState().reset();
  });

  it('keeps the backend edit capability when the model is closed', () => {
    useStore.getState().setEditModeAvailable(true);
    expect(useStore.getState().editModeAvailable).toBe(true);

    // "Close model" / opening a different IFC both funnel through reset().
    useStore.getState().reset();

    expect(useStore.getState().editModeAvailable).toBe(true);
  });

  it('still reflects a backend without editing enabled', () => {
    useStore.getState().setEditModeAvailable(false);
    useStore.getState().reset();

    expect(useStore.getState().editModeAvailable).toBe(false);
  });

  it('clears model-scoped state on reset even though the capability persists', () => {
    useStore.setState({ editModeAvailable: true, modelDirty: true, modelLoaded: true });

    useStore.getState().reset();

    // The capability describes the backend and survives...
    expect(useStore.getState().editModeAvailable).toBe(true);
    // ...but anything describing the model itself must not.
    expect(useStore.getState().modelDirty).toBe(false);
    expect(useStore.getState().modelLoaded).toBe(false);
  });
});
