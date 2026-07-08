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
