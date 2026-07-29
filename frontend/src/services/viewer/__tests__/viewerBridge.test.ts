import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../store/useStore';
import {
  REPORT_DEBOUNCE_MS,
  buildViewerStatePayload,
  createViewerStateCapabilities,
  executeViewerCommand,
  registerViewerBridge,
  splitDataUrl,
  unregisterViewerBridge,
  viewerStateReporter,
  type CapturedViewState,
  type ViewerBridgeCapabilities,
  type ViewerCommandPayload,
  type ViewerStatePayload,
} from '../viewerBridge';

describe('viewerCommandExecutor', () => {
  function makeCaptured(overrides: Partial<CapturedViewState> = {}): CapturedViewState {
    return {
      camera: { pos: [1, 2, 3], target: [0, 0, 0] },
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

  let bridge: ViewerBridgeCapabilities | null = null;
  let fetchMock: ReturnType<typeof vi.fn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let reportNowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    useStore.setState({
      selectedElementId: null,
      selectedIds: [],
      highlightedIds: [],
      isolatedIds: [],
      hiddenIds: [],
      zoomToElementFn: null,
    });
    fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response('{"ok":true}', { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Isolate the executor from the real reporter: these tests assert that the
    // executor CALLS reportNow after every command, not what reportNow posts.
    reportNowSpy = vi
      .spyOn(viewerStateReporter, 'reportNow')
      .mockResolvedValue(undefined) as ReturnType<typeof vi.spyOn>;
  });

  afterEach(() => {
    if (bridge) {
      unregisterViewerBridge(bridge);
      bridge = null;
    }
    warnSpy.mockRestore();
    reportNowSpy.mockRestore();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe('executeViewerCommand: select', () => {
    it('selects a single element via selectElement', async () => {
      await executeViewerCommand({ action: 'select', element_ids: [42] });
      expect(useStore.getState().selectedElementId).toBe(42);
      expect(useStore.getState().highlightedIds).toEqual([]);
    });

    it('multi-select keeps the first id primary and replaces the multi-select set', async () => {
      await executeViewerCommand({ action: 'select', element_ids: [7, 8, 9] });
      expect(useStore.getState().selectedElementId).toBe(7);
      // Real multi-select now (setSelectedIds); highlights are no longer
      // abused as a multi-select approximation.
      expect(useStore.getState().selectedIds).toEqual([7, 8, 9]);
      expect(useStore.getState().highlightedIds).toEqual([]);
    });

    it('ignores a select with no ids and leaves the selection alone', async () => {
      useStore.setState({ selectedElementId: 5 });
      await executeViewerCommand({ action: 'select', element_ids: [] });
      expect(useStore.getState().selectedElementId).toBe(5);
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe('executeViewerCommand: visibility', () => {
    it('isolate replaces isolatedIds and clears hiddenIds', async () => {
      useStore.setState({ hiddenIds: [99] });
      await executeViewerCommand({ action: 'isolate', element_ids: [1, 2] });
      expect(useStore.getState().isolatedIds).toEqual([1, 2]);
      expect(useStore.getState().hiddenIds).toEqual([]);
    });

    it('highlight replaces highlightedIds', async () => {
      await executeViewerCommand({ action: 'highlight', element_ids: [3, 4, 5] });
      expect(useStore.getState().highlightedIds).toEqual([3, 4, 5]);
    });

    it('show_all clears isolation, hidden and highlight sets', async () => {
      useStore.setState({ isolatedIds: [1], hiddenIds: [2], highlightedIds: [3] });
      await executeViewerCommand({ action: 'show_all' });
      const s = useStore.getState();
      expect(s.isolatedIds).toEqual([]);
      expect(s.hiddenIds).toEqual([]);
      expect(s.highlightedIds).toEqual([]);
    });
  });

  describe('executeViewerCommand: zoom_to_element', () => {
    it('invokes the store-registered zoom function with the element id', async () => {
      const zoomSpy = vi.fn();
      useStore.getState().setZoomToElementFn(zoomSpy);
      await executeViewerCommand({ action: 'zoom_to_element', element_id: 55 });
      expect(zoomSpy).toHaveBeenCalledWith(55);
    });

    it('resolves quietly when no zoom function is registered', async () => {
      await expect(
        executeViewerCommand({ action: 'zoom_to_element', element_id: 55 }),
      ).resolves.toBeUndefined();
    });

    it('warns and skips when element_id is missing', async () => {
      const zoomSpy = vi.fn();
      useStore.getState().setZoomToElementFn(zoomSpy);
      await executeViewerCommand({ action: 'zoom_to_element' });
      expect(zoomSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe('executeViewerCommand: camera_preset', () => {
    it('forwards the preset to the bridge', async () => {
      bridge = makeBridge();
      registerViewerBridge(bridge);
      await executeViewerCommand({ action: 'camera_preset', preset: 'top' });
      expect(bridge.applyCameraPreset).toHaveBeenCalledWith('top');
    });

    it('resolves quietly when no bridge is registered', async () => {
      await expect(
        executeViewerCommand({ action: 'camera_preset', preset: 'iso' }),
      ).resolves.toBeUndefined();
    });
  });

  describe('executeViewerCommand: snapshot', () => {
    it('captures at 1024px and posts the fulfilment with the request id', async () => {
      bridge = makeBridge({
        captureViewState: vi.fn().mockResolvedValue(
          makeCaptured({ snapshotDataUrl: 'data:image/jpeg;base64,QUJDRA==' }),
        ),
      });
      registerViewerBridge(bridge);

      await executeViewerCommand({ action: 'snapshot', request_id: 'req-1' });

      expect(bridge.captureViewState).toHaveBeenCalledWith({ snapshotMaxPx: 1024 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url.endsWith('/api/viewer/state/snapshot')).toBe(true);
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({
        request_id: 'req-1',
        image_base64: 'QUJDRA==',
        mime: 'image/jpeg',
      });
    });

    it('does not post when the command carries no request_id', async () => {
      bridge = makeBridge({
        captureViewState: vi.fn().mockResolvedValue(
          makeCaptured({ snapshotDataUrl: 'data:image/jpeg;base64,QUJDRA==' }),
        ),
      });
      registerViewerBridge(bridge);
      await executeViewerCommand({ action: 'snapshot' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not post when no bridge is registered', async () => {
      await executeViewerCommand({ action: 'snapshot', request_id: 'req-2' });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('executeViewerCommand: robustness', () => {
    it('warns on an unknown action and never throws', async () => {
      await expect(
        executeViewerCommand({ action: 'explode' } as unknown as ViewerCommandPayload),
      ).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
    });

    it('swallows a bridge failure and still reports state', async () => {
      bridge = makeBridge({
        applyCameraPreset: vi.fn().mockRejectedValue(new Error('camera busy')),
      });
      registerViewerBridge(bridge);
      await expect(
        executeViewerCommand({ action: 'camera_preset', preset: 'front' }),
      ).resolves.toBeUndefined();
      expect(viewerStateReporter.reportNow).toHaveBeenCalledTimes(1);
    });

    it('calls reportNow exactly once after every command', async () => {
      const commands: ViewerCommandPayload[] = [
        { action: 'select', element_ids: [1] },
        { action: 'isolate', element_ids: [1] },
        { action: 'highlight', element_ids: [1] },
        { action: 'show_all' },
        { action: 'zoom_to_element', element_id: 1 },
        { action: 'camera_preset', preset: 'fit' },
        { action: 'snapshot' },
        { action: 'unknown_thing' } as unknown as ViewerCommandPayload,
      ];
      let expected = 0;
      for (const cmd of commands) {
        await executeViewerCommand(cmd);
        expected += 1;
        expect(viewerStateReporter.reportNow).toHaveBeenCalledTimes(expected);
      }
    });
  });
});

describe('viewerBridgeApi + viewerStateReporter', () => {
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
});

function createState() {
  return {
    selectElement: vi.fn(),
    setHighlightedIds: vi.fn(),
    setIsolatedIds: vi.fn(),
    setHiddenIds: vi.fn(),
    clearVisibility: vi.fn(),
  };
}

describe('viewer state capabilities', () => {
  it('applies selection through one typed command', () => {
    const state = createState();
    const capabilities = createViewerStateCapabilities(() => state);

    capabilities.selection.apply({
      selectedId: 42,
      highlightedIds: [42, 84],
    });

    expect(state.setHighlightedIds).toHaveBeenCalledWith([42, 84]);
    expect(state.selectElement).toHaveBeenCalledWith(42);
  });

  it('gives isolation precedence over hidden ids', () => {
    const state = createState();
    const capabilities = createViewerStateCapabilities(() => state);

    capabilities.visibility.apply({
      isolatedIds: [7],
      hiddenIds: [8],
    });

    expect(state.setIsolatedIds).toHaveBeenCalledWith([7]);
    expect(state.setHiddenIds).not.toHaveBeenCalled();
  });

  it('clears visibility for an empty policy and ignores work after disposal', () => {
    const state = createState();
    const capabilities = createViewerStateCapabilities(() => state);

    capabilities.visibility.apply({ isolatedIds: [], hiddenIds: [] });
    capabilities.dispose();
    capabilities.visibility.hide([9]);
    capabilities.selection.select(9);

    expect(state.clearVisibility).toHaveBeenCalledTimes(1);
    expect(state.setHiddenIds).not.toHaveBeenCalled();
    expect(state.selectElement).not.toHaveBeenCalled();
  });
});
