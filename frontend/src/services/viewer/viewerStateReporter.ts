/**
 * Viewer state reporter: a singleton that tells the backend what the viewer
 * is currently showing (camera, selection, visibility counts, loaded model)
 * so the CLI and MCP clients can read it via GET /api/viewer/state.
 *
 * Event-driven by design: it reacts to store changes (debounced) and to
 * document visibility flips. Hard rules: no setInterval polling, no
 * requestAnimationFrame, nothing on the render path.
 */
import { shallow } from 'zustand/shallow';
import { useStore } from '../../store/useStore';
import { BROWSER_ONLY } from '../../config/featureFlags';
import { getViewerBridge, type ViewerCameraState } from './viewerBridge';
import { buildViewerStatePayload, postViewerState } from '../features/viewerBridgeApi';

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
