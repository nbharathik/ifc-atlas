/**
 * Vitest coverage for the saved-viewpoints store slice.
 * Covers saveViewpoint/loadViewpointsForProject persistence round-trips,
 * the section-workspace fields on newer payloads, and legacy payloads
 * (saved before sections existed) restoring without error.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore, type SavedViewpoint } from '../useStore';
import {
  createStoreyCutPlanePreset,
  parseSectionWorkspace,
} from '../../services/viewer/sectionWorkspace';

const VIEWPOINTS_STORAGE_KEY = 'pref.viewpoints.v1';
const PROJECT_KEY = 'Demo project|IFC4';

/** In-memory localStorage stub (vitest default env is `node`, no globals). */
function installLocalStorageStub(): { store: Map<string, string> } {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  });
  return { store };
}

function baseViewpoint(id: string): SavedViewpoint {
  return {
    id,
    projectKey: PROJECT_KEY,
    name: `Viewpoint ${id}`,
    createdAt: 1,
    camera: { pos: [0, 5, 10], target: [0, 0, 0] },
    isolatedIds: [],
    hiddenIds: [],
    selectedId: null,
    highlightedIds: [],
    thumbnail: null,
  };
}

let backing: { store: Map<string, string> };

beforeEach(() => {
  backing = installLocalStorageStub();
  useStore.setState({ viewpoints: [] });
});

describe('viewpoints store slice', () => {
  it('round-trips the section workspace and box flag through persistence', () => {
    const workspace = createStoreyCutPlanePreset({
      id: 'storey:l01',
      name: 'Level 01 cut',
      elevation: 3.2,
    });
    useStore.getState().saveViewpoint({
      ...baseViewpoint('vp-1'),
      sectionWorkspace: workspace,
      sectionBoxEnabled: true,
    });

    useStore.setState({ viewpoints: [] });
    useStore.getState().loadViewpointsForProject(PROJECT_KEY);

    const restored = useStore.getState().viewpoints.find((vp) => vp.id === 'vp-1');
    expect(restored).toBeDefined();
    expect(restored!.sectionBoxEnabled).toBe(true);
    // The persisted payload crossed JSON.stringify/parse; it must still
    // validate as a durable workspace and carry the same plane definition.
    const parsed = parseSectionWorkspace(restored!.sectionWorkspace);
    expect(parsed).not.toBeNull();
    expect(parsed!.planes).toEqual(workspace.planes);
    expect(parsed!.id).toBe('storey:l01');
  });

  it('restores legacy payloads without section fields and without error', () => {
    backing.store.set(VIEWPOINTS_STORAGE_KEY, JSON.stringify({
      [PROJECT_KEY]: [baseViewpoint('vp-legacy')],
    }));

    useStore.getState().loadViewpointsForProject(PROJECT_KEY);

    const restored = useStore.getState().viewpoints.find((vp) => vp.id === 'vp-legacy');
    expect(restored).toBeDefined();
    expect(restored!.sectionWorkspace).toBeUndefined();
    expect(restored!.sectionBoxEnabled).toBeUndefined();
    expect(restored!.camera.pos).toEqual([0, 5, 10]);
  });

  it('keeps a null workspace explicit so restoring clears active sections', () => {
    useStore.getState().saveViewpoint({
      ...baseViewpoint('vp-none'),
      sectionWorkspace: null,
      sectionBoxEnabled: false,
    });

    useStore.setState({ viewpoints: [] });
    useStore.getState().loadViewpointsForProject(PROJECT_KEY);

    const restored = useStore.getState().viewpoints.find((vp) => vp.id === 'vp-none');
    expect(restored).toBeDefined();
    expect(restored!.sectionWorkspace).toBeNull();
    expect(restored!.sectionBoxEnabled).toBe(false);
  });
});
