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
import { apiUrl } from '../../lib/platform';
import type { ViewerCameraState } from '../viewer/viewerBridge';

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
