import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../store/useStore';
import {
  registerViewerBridge,
  unregisterViewerBridge,
  type CapturedViewState,
  type ViewerBridgeCapabilities,
} from './viewerBridge';
import { REPORT_DEBOUNCE_MS, viewerStateReporter } from './viewerStateReporter';
import {
  buildViewerStatePayload,
  splitDataUrl,
  type ViewerStatePayload,
} from '../features/viewerBridgeApi';

function makeCaptured(overrides: Partial<CapturedViewState> = {}): CapturedViewState {
  return {
    camera: { pos: [10, 20, 30], target: [0, 0, 0] },
    isolatedIds: [],
    hiddenIds: [],
    selectedId: null,
    highlightedIds: [],
    snapshotDataUrl: null,
    ...overrides,
  };
}

function makeBridge(overrides: Partial<ViewerBridgeCapabilities> = {}): ViewerBridgeCapabilities {
  return {
    captureViewState: vi.fn().mockResolvedValue(makeCaptured()),
    applyViewState: vi.fn().mockResolvedValue(undefined),
    applyCameraPreset: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('buildViewerStatePayload', () => {
  it('assembles the exact wire contract shape from explicit inputs', () => {
    const payload = buildViewerStatePayload({
      camera: { pos: [1, 2, 3], target: [4, 5, 6] },
      selectedId: 42,
      selectedIds: [42, 43],
      isolatedIds: [1, 2, 3],
      hiddenIds: [9],
      highlightedIds: [42, 43, 44],
      model: { fileName: 'BasicHouse.ifc', fingerprint: 'abc123', elementCount: 149 },
      tabVisible: true,
    });
    expect(payload).toEqual({
      camera: { pos: [1, 2, 3], target: [4, 5, 6] },
      selected_id: 42,
      selected_ids: [42, 43],
      isolated_count: 3,
      hidden_count: 1,
      highlighted_count: 3,
      model: { file_name: 'BasicHouse.ifc', fingerprint: 'abc123', element_count: 149 },
      tab_visible: true,
    });
  });

  it('passes nulls through for camera and model info (nothing loaded)', () => {
    const payload = buildViewerStatePayload({
      camera: null,
      selectedId: null,
      selectedIds: [],
      isolatedIds: [],
      hiddenIds: [],
      highlightedIds: [],
      model: { fileName: null, fingerprint: null, elementCount: null },
      tabVisible: false,
    });
    expect(payload).toEqual({
      camera: null,
      selected_id: null,
      selected_ids: [],
      isolated_count: 0,
      hidden_count: 0,
      highlighted_count: 0,
      model: { file_name: null, fingerprint: null, element_count: null },
      tab_visible: false,
    });
  });

  it('copies selected_ids so later input mutation cannot leak into the payload', () => {
    const selectedIds = [1, 2];
    const payload = buildViewerStatePayload({
      camera: null,
      selectedId: 1,
      selectedIds,
      isolatedIds: [],
      hiddenIds: [],
      highlightedIds: [],
      model: { fileName: null, fingerprint: null, elementCount: null },
      tabVisible: true,
    });
    selectedIds.push(3);
    expect(payload.selected_ids).toEqual([1, 2]);
  });
});

describe('splitDataUrl', () => {
  it('splits a base64 jpeg data URL into mime and payload', () => {
    expect(splitDataUrl('data:image/jpeg;base64,QUJDRA==')).toEqual({
      mime: 'image/jpeg',
      base64: 'QUJDRA==',
    });
  });

  it('returns null for malformed or non-base64 data URLs', () => {
    expect(splitDataUrl('not a data url')).toBeNull();
    expect(splitDataUrl('data:image/jpeg,rawbytes')).toBeNull();
    expect(splitDataUrl('data:image/jpeg;base64,')).toBeNull();
  });
});

describe('viewerStateReporter', () => {
  let bridge: ViewerBridgeCapabilities | null = null;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response('{"ok":true}', { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    useStore.setState({
      selectedElementId: null,
      selectedIds: [],
      highlightedIds: [],
      isolatedIds: [],
      hiddenIds: [],
      modelLoaded: false,
      modelFingerprint: null,
      project: null,
      stats: null,
    });
  });

  afterEach(() => {
    viewerStateReporter.stop();
    if (bridge) {
      unregisterViewerBridge(bridge);
      bridge = null;
    }
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function postedBody(callIndex = 0): ViewerStatePayload {
    const init = fetchMock.mock.calls[callIndex][1] as RequestInit;
    return JSON.parse(init.body as string) as ViewerStatePayload;
  }

  it('debounces rapid store changes into a single state POST', async () => {
    viewerStateReporter.start();
    useStore.getState().selectElement(11);
    useStore.getState().setHighlightedIds([1, 2]);
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS + 50);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url.endsWith('/api/viewer/state')).toBe(true);
    const body = postedBody();
    expect(body.selected_id).toBe(11);
    expect(body.highlighted_count).toBe(2);
    // No bridge registered, so the camera is unknown.
    expect(body.camera).toBeNull();
  });

  it('start() is idempotent - a double start still posts once per change burst', async () => {
    viewerStateReporter.start();
    viewerStateReporter.start();
    useStore.getState().selectElement(5);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS + 50);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stop() cancels the pending report and unsubscribes from the store', async () => {
    viewerStateReporter.start();
    useStore.getState().selectElement(5);
    viewerStateReporter.stop();
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS * 2);
    expect(fetchMock).not.toHaveBeenCalled();

    useStore.getState().selectElement(6);
    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS * 2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reportNow() posts camera from the bridge and model info from the store', async () => {
    bridge = makeBridge();
    registerViewerBridge(bridge);
    useStore.setState({
      project: {
        name: 'BasicHouse',
        description: null,
        schema_version: 'IFC4',
        author: null,
        organization: null,
      },
      stats: { total_elements: 149, by_type: {}, storeys: [], materials: [] },
      modelLoaded: true,
      modelFingerprint: 'fp-1',
      selectedElementId: 7,
      selectedIds: [],
      isolatedIds: [1, 2],
      hiddenIds: [],
      highlightedIds: [7],
    });

    await viewerStateReporter.reportNow();

    // Cheap capture: must be called WITHOUT a snapshot option.
    expect(bridge.captureViewState).toHaveBeenCalledWith();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = postedBody();
    expect(body.camera).toEqual({ pos: [10, 20, 30], target: [0, 0, 0] });
    expect(body.selected_id).toBe(7);
    expect(body.isolated_count).toBe(2);
    expect(body.highlighted_count).toBe(1);
    expect(body.model).toEqual({
      file_name: 'BasicHouse',
      fingerprint: 'fp-1',
      element_count: 149,
    });
    // No document in the node test environment: treated as visible.
    expect(body.tab_visible).toBe(true);
  });

  it('an explicit reportNow() absorbs the pending debounced report', async () => {
    viewerStateReporter.start();
    useStore.getState().selectElement(3);
    await viewerStateReporter.reportNow();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(REPORT_DEBOUNCE_MS * 2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reportNow() survives a bridge capture failure and posts a null camera', async () => {
    bridge = makeBridge({
      captureViewState: vi.fn().mockRejectedValue(new Error('world disposed')),
    });
    registerViewerBridge(bridge);
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    await viewerStateReporter.reportNow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(postedBody().camera).toBeNull();
    debugSpy.mockRestore();
  });

  it('swallows network errors so a dead backend never surfaces to callers', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    await expect(viewerStateReporter.reportNow()).resolves.toBeUndefined();

    debugSpy.mockRestore();
  });
});
