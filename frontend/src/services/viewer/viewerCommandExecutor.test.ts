import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../store/useStore';
import {
  registerViewerBridge,
  unregisterViewerBridge,
  type CapturedViewState,
  type ViewerBridgeCapabilities,
} from './viewerBridge';
import { executeViewerCommand, type ViewerCommandPayload } from './viewerCommandExecutor';
import { viewerStateReporter } from './viewerStateReporter';

// Isolate the executor from the real reporter: these tests assert that the
// executor CALLS reportNow after every command, not what reportNow posts.
vi.mock('./viewerStateReporter', () => ({
  viewerStateReporter: {
    start: vi.fn(),
    stop: vi.fn(),
    reportNow: vi.fn().mockResolvedValue(undefined),
  },
}));

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
});

afterEach(() => {
  if (bridge) {
    unregisterViewerBridge(bridge);
    bridge = null;
  }
  warnSpy.mockRestore();
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
