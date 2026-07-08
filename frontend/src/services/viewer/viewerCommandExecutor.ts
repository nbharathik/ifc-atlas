/**
 * Viewer command executor: applies commands the backend broadcasts over the
 * model-sync WebSocket as {"type": "viewer_command", "payload": {...}}.
 * The CLI and external LLMs (over MCP) drive the viewer through this path.
 *
 * Dispatches through useStore actions and the viewer bridge registry, then
 * reports the resulting viewer state so the backend sees the effect
 * immediately. Never throws - a bad command must not kill the WS handler.
 */
import { useStore } from '../../store/useStore';
import { getViewerBridge, type CameraPreset } from './viewerBridge';
import { postViewerSnapshot } from '../features/viewerBridgeApi';
import { viewerStateReporter } from './viewerStateReporter';

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
