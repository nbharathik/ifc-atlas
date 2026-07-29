import { shallow } from 'zustand/shallow';
import { apiUrl } from '../../lib/platform';
import { useStore } from '../../store/useStore';
import { BROWSER_ONLY } from '../../config/featureFlags';

// Viewer bridge: a tiny module-level registry that lets non-viewer code
// (BCF topics, the viewer command executor, the viewer state reporter)
// capture or apply 3D view state without importing ViewerPanel.
//
// ViewerPanel registers its capabilities once the world is ready and
// unregisters on dispose. Consumers must tolerate a null registry: the
// viewer may not be mounted (no model loaded, panel unmounted) or the
// capability may be absent on older registrations.

export interface ViewerCameraState {
  /** World-space camera position. */
  pos: [number, number, number];
  /** World-space look-at target. */
  target: [number, number, number];
}

export interface CapturedViewState {
  camera: ViewerCameraState;
  isolatedIds: number[];
  hiddenIds: number[];
  selectedId: number | null;
  highlightedIds: number[];
  /** JPEG data URL (image/jpeg) when a snapshot was requested, else null. */
  snapshotDataUrl: string | null;
}

export interface CaptureOptions {
  /** Capture a snapshot downscaled to at most this many pixels wide. */
  snapshotMaxPx?: number;
}

export interface ApplyViewStateRequest {
  camera?: ViewerCameraState;
  isolatedIds?: number[];
  hiddenIds?: number[];
  selectedId?: number | null;
  highlightedIds?: number[];
}

export type CameraPreset =
  | 'front'
  | 'back'
  | 'left'
  | 'right'
  | 'top'
  | 'iso'
  | 'fit';

export interface ViewerBridgeCapabilities {
  /** Snapshot the current camera, visibility, selection and (optionally) canvas. */
  captureViewState(opts?: CaptureOptions): Promise<CapturedViewState | null>;
  /** Restore camera/visibility/selection in one pass (smooth camera move). */
  applyViewState(state: ApplyViewStateRequest): Promise<void>;
  /** Move the camera to a named preset orientation, or fit the model. */
  applyCameraPreset(preset: CameraPreset): Promise<void>;
}

let registry: ViewerBridgeCapabilities | null = null;

export function registerViewerBridge(caps: ViewerBridgeCapabilities): void {
  registry = caps;
}

export function unregisterViewerBridge(caps: ViewerBridgeCapabilities): void {
  if (registry === caps) registry = null;
}

export function getViewerBridge(): ViewerBridgeCapabilities | null {
  return registry;
}

/**
 * HTTP client for the viewer bridge: pushes what the browser viewer is
 * showing to the backend (POST /api/viewer/state) and fulfils snapshot
 * requests (POST /api/viewer/state/snapshot) so the CLI and external LLM
 * clients over MCP can see the live viewer.
 *
 * Both POST helpers are fire-and-forget on purpose: the backend may simply
 * not be running (web demo, dev session without a backend), so failures are
 * logged at debug level and never thrown or retried.
 */

/** Loaded-model summary inside the reported state (all-null when no model). */
export interface ViewerStateModel {
  file_name: string | null;
  fingerprint: string | null;
  element_count: number | null;
}

/** Wire shape of POST /api/viewer/state - mirrored by the backend route. */
export interface ViewerStatePayload {
  camera: ViewerCameraState | null;
  selected_id: number | null;
  selected_ids: number[];
  isolated_count: number;
  hidden_count: number;
  highlighted_count: number;
  model: ViewerStateModel;
  tab_visible: boolean;
}

/** Explicit inputs for {@link buildViewerStatePayload} (camelCase app-side names). */
export interface ViewerStateInputs {
  camera: ViewerCameraState | null;
  selectedId: number | null;
  selectedIds: readonly number[];
  isolatedIds: readonly number[];
  hiddenIds: readonly number[];
  highlightedIds: readonly number[];
  model: {
    fileName: string | null;
    fingerprint: string | null;
    elementCount: number | null;
  };
  tabVisible: boolean;
}

/**
 * Pure assembly of the wire payload from explicit inputs. Kept free of store
 * and DOM access so the contract shape is unit-testable in isolation.
 */
export function buildViewerStatePayload(inputs: ViewerStateInputs): ViewerStatePayload {
  return {
    camera: inputs.camera,
    selected_id: inputs.selectedId,
    selected_ids: [...inputs.selectedIds],
    isolated_count: inputs.isolatedIds.length,
    hidden_count: inputs.hiddenIds.length,
    highlighted_count: inputs.highlightedIds.length,
    model: {
      file_name: inputs.model.fileName,
      fingerprint: inputs.model.fingerprint,
      element_count: inputs.model.elementCount,
    },
    tab_visible: inputs.tabVisible,
  };
}

// Only base64 data URLs are accepted - the viewer bridge always produces
// canvas.toDataURL output, which is base64 by construction.
const DATA_URL_RE = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/;

/**
 * Split a base64 data URL into its mime type and raw base64 payload.
 * Returns null for anything that is not a well-formed base64 data URL.
 */
export function splitDataUrl(dataUrl: string): { mime: string; base64: string } | null {
  const match = DATA_URL_RE.exec(dataUrl);
  if (!match) return null;
  return { mime: match[1], base64: match[2] };
}

/** Report the current viewer state. Never throws; errors go to console.debug. */
export async function postViewerState(payload: ViewerStatePayload): Promise<void> {
  try {
    const res = await fetch(apiUrl('/api/viewer/state'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.debug(`[viewerBridge] state report rejected: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.debug('[viewerBridge] state report failed (backend offline?):', err);
  }
}

/**
 * Fulfil a pending snapshot request with the captured canvas data URL.
 * Never throws; errors go to console.debug.
 */
export async function postViewerSnapshot(requestId: string, dataUrl: string): Promise<void> {
  const parts = splitDataUrl(dataUrl);
  if (!parts) {
    console.debug('[viewerBridge] snapshot skipped: not a base64 data URL');
    return;
  }
  try {
    const res = await fetch(apiUrl('/api/viewer/state/snapshot'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request_id: requestId,
        image_base64: parts.base64,
        mime: parts.mime,
      }),
    });
    if (!res.ok) {
      console.debug(`[viewerBridge] snapshot post rejected: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.debug('[viewerBridge] snapshot post failed (backend offline?):', err);
  }
}

export interface ViewerSelectionState {
  readonly selectedId: number | null;
  readonly highlightedIds: readonly number[];
}

export interface ViewerVisibilityState {
  readonly isolatedIds: readonly number[];
  readonly hiddenIds: readonly number[];
}

export interface ViewerSelectionCapability {
  select(expressId: number | null): void;
  highlight(expressIds: readonly number[]): void;
  apply(state: ViewerSelectionState): void;
}

export interface ViewerVisibilityCapability {
  isolate(expressIds: readonly number[]): void;
  hide(expressIds: readonly number[]): void;
  showAll(): void;
  apply(state: ViewerVisibilityState): void;
}

export interface ViewerStateCapabilities {
  readonly selection: ViewerSelectionCapability;
  readonly visibility: ViewerVisibilityCapability;
  dispose(): void;
}

interface ViewerCommandState {
  selectElement(id: number | null): void;
  setHighlightedIds(ids: number[]): void;
  setIsolatedIds(ids: number[]): void;
  setHiddenIds(ids: number[]): void;
  clearVisibility(): void;
}

/**
 * Typed command boundary between UI integrations and the viewer store.
 *
 * Rendering remains owned by RenderStateCoordinator subscriptions. Callers
 * describe selection or visibility intent instead of writing engine state.
 */
export function createViewerStateCapabilities(
  getState: () => ViewerCommandState,
): ViewerStateCapabilities {
  let active = true;
  const run = (command: (state: ViewerCommandState) => void) => {
    if (active) command(getState());
  };

  const selection: ViewerSelectionCapability = {
    select: (expressId) => run((state) => state.selectElement(expressId)),
    highlight: (expressIds) => run(
      (state) => state.setHighlightedIds([...expressIds]),
    ),
    apply: ({ selectedId, highlightedIds }) => run((state) => {
      state.setHighlightedIds([...highlightedIds]);
      state.selectElement(selectedId);
    }),
  };

  const visibility: ViewerVisibilityCapability = {
    isolate: (expressIds) => run(
      (state) => state.setIsolatedIds([...expressIds]),
    ),
    hide: (expressIds) => run(
      (state) => state.setHiddenIds([...expressIds]),
    ),
    showAll: () => run((state) => state.clearVisibility()),
    apply: ({ isolatedIds, hiddenIds }) => run((state) => {
      if (isolatedIds.length > 0) {
        state.setIsolatedIds([...isolatedIds]);
      } else if (hiddenIds.length > 0) {
        state.setHiddenIds([...hiddenIds]);
      } else {
        state.clearVisibility();
      }
    }),
  };

  return {
    selection,
    visibility,
    dispose: () => {
      active = false;
    },
  };
}

/**
 * Viewer state reporter: a singleton that tells the backend what the viewer
 * is currently showing (camera, selection, visibility counts, loaded model)
 * so the CLI and MCP clients can read it via GET /api/viewer/state.
 *
 * Event-driven by design: it reacts to store changes (debounced) and to
 * document visibility flips. Hard rules: no setInterval polling, no
 * requestAnimationFrame, nothing on the render path.
 */

/** Quiet period after the last watched store change before a report fires. */
export const REPORT_DEBOUNCE_MS = 600;

// Store slice the reporter reacts to. Arrays compare by reference under
// shallow equality - store actions always replace changed arrays, so this
// is both correct and cheap.
function selectWatchedState(s: ReturnType<typeof useStore.getState>) {
  return {
    selectedElementId: s.selectedElementId,
    selectedIds: s.selectedIds,
    highlightedIds: s.highlightedIds,
    isolatedIds: s.isolatedIds,
    hiddenIds: s.hiddenIds,
    modelLoaded: s.modelLoaded,
    modelFingerprint: s.modelFingerprint,
    project: s.project,
    stats: s.stats,
  };
}

let started = false;
let unsubscribe: (() => void) | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function clearDebounce(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

function scheduleReport(): void {
  clearDebounce();
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void reportNow();
  }, REPORT_DEBOUNCE_MS);
}

// tab_visible flips matter immediately (snapshot requests against a hidden
// tab would stall), so visibility changes skip the debounce. Hidden tabs
// also throttle timers, making a debounced report unreliable here.
function onVisibilityChange(): void {
  void reportNow();
}

async function reportNow(): Promise<void> {
  if (BROWSER_ONLY) return;
  // Absorb any pending debounced report - this call supersedes it.
  clearDebounce();

  let camera: ViewerCameraState | null = null;
  try {
    // Cheap capture: no snapshot option, so no canvas readback happens.
    const captured = await getViewerBridge()?.captureViewState();
    camera = captured?.camera ?? null;
  } catch (err) {
    console.debug('[viewerBridge] camera capture failed:', err);
  }

  const s = useStore.getState();
  const payload = buildViewerStatePayload({
    camera,
    selectedId: s.selectedElementId,
    selectedIds: s.selectedIds,
    isolatedIds: s.isolatedIds,
    hiddenIds: s.hiddenIds,
    highlightedIds: s.highlightedIds,
    model: {
      fileName: s.project?.name ?? null,
      fingerprint: s.modelFingerprint,
      elementCount: s.stats?.total_elements ?? null,
    },
    tabVisible: typeof document !== 'undefined'
      ? document.visibilityState === 'visible'
      : true,
  });
  await postViewerState(payload);
}

export const viewerStateReporter = {
  /**
   * Begin reporting. Idempotent - a second call while running is a no-op.
   * Does nothing in browser-only builds (there is no backend to report to).
   */
  start(): void {
    if (BROWSER_ONLY || started) return;
    started = true;
    unsubscribe = useStore.subscribe(selectWatchedState, scheduleReport, {
      equalityFn: shallow,
    });
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
  },

  /** Stop reporting and cancel any pending debounced report. */
  stop(): void {
    if (!started) return;
    started = false;
    clearDebounce();
    unsubscribe?.();
    unsubscribe = null;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
  },

  /**
   * Report immediately, bypassing (and absorbing) the debounce. Called by the
   * command executor after every applied command so the backend sees the
   * effect without waiting for the store-change debounce.
   */
  reportNow,
};

/**
 * Viewer command executor: applies commands the backend broadcasts over the
 * model-sync WebSocket as {"type": "viewer_command", "payload": {...}}.
 * The CLI and external LLMs (over MCP) drive the viewer through this path.
 *
 * Dispatches through useStore actions and the viewer bridge registry, then
 * reports the resulting viewer state so the backend sees the effect
 * immediately. Never throws - a bad command must not kill the WS handler.
 */

export type ViewerCommandAction =
  | 'select'
  | 'isolate'
  | 'highlight'
  | 'show_all'
  | 'camera_preset'
  | 'zoom_to_element'
  | 'snapshot'
  | 'clear_selection'
  | 'clip_to_element'
  | 'set_section_box'
  | 'set_colour_layer'
  | 'clear_colour_layers';

/** One colour bucket of a set_colour_layer command (backend-validated caps). */
export interface ViewerColourEntry {
  color: string;
  element_ids: number[];
  label?: string;
}

/** Payload of a viewer_command model-sync event (POST /api/viewer/command body). */
export interface ViewerCommandPayload {
  action: ViewerCommandAction;
  /** Required for select / isolate / highlight (backend-validated). */
  element_ids?: number[];
  /** Required for zoom_to_element / clip_to_element (backend-validated). */
  element_id?: number;
  /** Required for camera_preset (backend-validated). */
  preset?: CameraPreset;
  /** Snapshot correlation id - the fulfilment POST echoes it back. */
  request_id?: string;
  /** Required for set_section_box (backend-validated). */
  enabled?: boolean;
  /** set_colour_layer: layer key (defaults to 'ai' backend-side). */
  layer_id?: string;
  /** Required for set_colour_layer (backend-validated). */
  entries?: ViewerColourEntry[];
}

async function dispatch(payload: ViewerCommandPayload): Promise<void> {
  const state = useStore.getState();
  switch (payload.action) {
    case 'select': {
      const ids = payload.element_ids ?? [];
      if (ids.length === 0) {
        console.warn('[viewerCommand] select ignored: no element_ids');
        return;
      }
      // Primary selection first (history, tree expansion, properties), then
      // replace the multi-select set so a multi-id command is a REAL
      // multi-select instead of the old primary+highlight approximation.
      state.selectElement(ids[0]);
      if (ids.length > 1) state.setSelectedIds(ids);
      return;
    }
    case 'clear_selection':
      state.selectElement(null);
      state.clearSelectedIds();
      return;
    case 'isolate':
      state.setIsolatedIds(payload.element_ids ?? []);
      return;
    case 'highlight':
      state.setHighlightedIds(payload.element_ids ?? []);
      return;
    case 'show_all':
      state.clearVisibility();
      state.setHighlightedIds([]);
      return;
    case 'zoom_to_element': {
      if (typeof payload.element_id !== 'number') {
        console.warn('[viewerCommand] zoom_to_element ignored: no element_id');
        return;
      }
      // Store thin wrapper: no-ops gracefully while ViewerPanel has not
      // registered zoomToElementFn (no model loaded / viewer unmounted).
      state.zoomToElement(payload.element_id);
      return;
    }
    case 'camera_preset': {
      if (!payload.preset) {
        console.warn('[viewerCommand] camera_preset ignored: no preset');
        return;
      }
      await getViewerBridge()?.applyCameraPreset(payload.preset);
      return;
    }
    case 'snapshot': {
      const captured = await getViewerBridge()?.captureViewState({ snapshotMaxPx: 1024 });
      if (captured?.snapshotDataUrl && payload.request_id) {
        await postViewerSnapshot(payload.request_id, captured.snapshotDataUrl);
      }
      return;
    }
    case 'clip_to_element': {
      if (typeof payload.element_id !== 'number') {
        console.warn('[viewerCommand] clip_to_element ignored: no element_id');
        return;
      }
      // Store thin wrapper: no-ops gracefully while ViewerPanel has not
      // registered clipToElementFn (no model loaded / viewer unmounted).
      state.clipToElement(payload.element_id);
      return;
    }
    case 'set_section_box': {
      if (typeof payload.enabled !== 'boolean') {
        console.warn('[viewerCommand] set_section_box ignored: no enabled flag');
        return;
      }
      state.setSectionBoxEnabled(payload.enabled);
      return;
    }
    case 'set_colour_layer': {
      const raw = Array.isArray(payload.entries) ? payload.entries : [];
      const entries = raw
        .filter(
          (e) =>
            typeof e?.color === 'string'
            && e.color.trim() !== ''
            && Array.isArray(e?.element_ids)
            && e.element_ids.length > 0,
        )
        .map((e) => ({ color: e.color, ids: e.element_ids }));
      if (entries.length === 0) {
        console.warn('[viewerCommand] set_colour_layer ignored: no valid entries');
        return;
      }
      const legend = raw
        .filter((e) => typeof e?.label === 'string' && e.label.trim() !== '')
        .map((e) => ({ color: e.color, label: e.label as string }));
      state.setColourLayer(payload.layer_id || 'ai', {
        entries,
        legend: legend.length > 0 ? legend : undefined,
        name: 'AI',
      });
      return;
    }
    case 'clear_colour_layers':
      state.clearAllColourLayers();
      return;
    default:
      console.warn(
        '[viewerCommand] unknown action ignored:',
        (payload as { action: string }).action,
      );
  }
}

/**
 * Apply one backend-issued viewer command. Always resolves: failures are
 * logged, and the state report runs regardless so the backend stays in sync.
 */
export async function executeViewerCommand(payload: ViewerCommandPayload): Promise<void> {
  try {
    await dispatch(payload);
  } catch (err) {
    console.warn('[viewerCommand] command failed:', payload.action, err);
  } finally {
    await viewerStateReporter.reportNow();
  }
}
