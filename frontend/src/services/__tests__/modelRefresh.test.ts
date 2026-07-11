import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api', () => ({
  getIfcFileUrl: () => 'http://backend/api/ifc/file',
  getMetaWithMode: vi.fn(),
}));

import { requestModelRefresh, viewerReadyBus } from '../ifc/modelRefresh';
import { getMetaWithMode } from '../api';
import { useStore } from '../../store/useStore';

const META = {
  project: { name: 'P', description: null, schema_version: 'IFC4', author: null, organization: null },
  tree: null,
  stats: null,
  model_version: 7,
  model_fingerprint: 'fp-after-edit',
  edit_id: 'e9',
};

function mockFetchBytes(): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  })));
}

describe('requestModelRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetchBytes();
    vi.mocked(getMetaWithMode).mockResolvedValue(META as never);
    useStore.setState({
      modelLoaded: true,
      loadStartTs: 1000,
      modelFingerprint: 'fp-before',
      getCameraStateFn: () => ({ pos: [1, 2, 3], target: [0, 0, 0] }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('no-ops when no model is loaded', async () => {
    useStore.setState({ modelLoaded: false });
    requestModelRefresh('test');
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('debounces bursts of structural edits into one reload', async () => {
    requestModelRefresh('wall 1');
    requestModelRefresh('wall 2');
    requestModelRefresh('wall 3');
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('adopts the fresh contract and remounts the viewer via loadStartTs', async () => {
    requestModelRefresh('created wall');
    await vi.advanceTimersByTimeAsync(1000);
    const s = useStore.getState();
    expect(s.modelFingerprint).toBe('fp-after-edit');
    expect(s.modelVersion).toBe(7);
    expect(s.loadStartTs).not.toBe(1000);
  });

  it('restores the captured camera when the viewer signals ready', async () => {
    const setLookAt = vi.fn();
    useStore.setState({ setLookAtFn: setLookAt });
    requestModelRefresh('created wall');
    await vi.advanceTimersByTimeAsync(1000);

    viewerReadyBus.dispatchEvent(new CustomEvent('ifc-viewer-ready', {
      detail: { fingerprint: 'fp-after-edit' },
    }));
    // Camera restore waits one animation frame.
    await vi.advanceTimersByTimeAsync(50);
    // In jsdom requestAnimationFrame is timer-based under fake timers.
    expect(setLookAt).toHaveBeenCalledWith([1, 2, 3], [0, 0, 0], false);
  });

  it('logs an error and stays alive when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));
    useStore.setState({ activity: [] });
    requestModelRefresh('bad');
    await vi.advanceTimersByTimeAsync(1000);
    const s = useStore.getState();
    expect(s.activity.some((e) => e.kind === 'error')).toBe(true);
  });
});
