/**
 * modelRefresh - soft in-app reload of the CURRENT backend model.
 *
 * The correct-first display path for structural edits (ADR 005 / plan R5):
 * when an operation creates/deletes geometry, the backend classifies it BULK
 * and broadcasts `rebuild_started`; this module re-fetches the edited working
 * file plus fresh metadata and remounts the viewer via `loadStartTs` - the
 * same remount the upload flow uses - WITHOUT re-uploading (a re-upload would
 * re-fingerprint the model as a brand-new original and orphan its operation
 * log + checkpoint history).
 *
 * UX guarantees:
 *  - camera position/target survive the remount (captured before, restored on
 *    the viewer-ready event) so drawing several walls doesn't yank the view;
 *  - selection ids survive (express ids are stable by contract);
 *  - bursts of structural edits (an AI applying ten walls) coalesce into one
 *    reload via a trailing debounce.
 */

import { getIfcFileUrl, getMetaWithMode } from '../api';
import { useStore } from '../../store/useStore';

const DEBOUNCE_MS = 400;
const CAMERA_RESTORE_TIMEOUT_MS = 60_000;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
let activeFingerprint: string | null = null;
let rerunRequested: { reason: string; fingerprint: string | null } | null = null;

/** Schedule a debounced soft reload (safe to call for every sync event). */
export function requestModelRefresh(reason: string, fingerprint: string | null = null): void {
  const state = useStore.getState();
  if (!state.modelLoaded) return;
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void runRefresh(reason, fingerprint);
  }, DEBOUNCE_MS);
}

async function runRefresh(reason: string, fingerprint: string | null): Promise<void> {
  if (inFlight) {
    // The backend can publish more than one compatibility event for the same
    // edit. Do not turn that into a second full scene reconstruction.
    if (fingerprint && fingerprint === activeFingerprint) return;
    // A genuinely newer structural edit landed while reloading: keep only the
    // latest request and refresh it once the current load settles.
    rerunRequested = { reason, fingerprint };
    return;
  }
  inFlight = true;
  activeFingerprint = fingerprint;
  const state = useStore.getState();
  state.logActivity({
    kind: 'info',
    summary: `Reloading model geometry (${reason})`,
  });

  // Capture the camera BEFORE the viewer unmounts.
  const camera = state.getCameraStateFn?.() ?? null;

  try {
    const [bytes, meta] = await Promise.all([
      fetch(getIfcFileUrl()).then(async (resp) => {
        if (!resp.ok) throw new Error(`fetch model bytes failed (${resp.status})`);
        return new Uint8Array(await resp.arrayBuffer());
      }),
      getMetaWithMode('full'),
    ]);

    const s = useStore.getState();
    if (!s.modelLoaded) return;

    if (camera) restoreCameraWhenReady(camera, meta.model_fingerprint);

    s.setIfcFileBytes(bytes);
    s.setProject(meta.project);
    if (meta.tree) s.setSpatialTree(meta.tree);
    if (meta.stats) s.setStats(meta.stats);
    s.setModelContract({
      model_version: meta.model_version,
      model_fingerprint: meta.model_fingerprint,
      edit_id: meta.edit_id,
    });
    // Remount the viewer: same mechanism as a fresh load, but the model is
    // the backend's edited working copy - history/oplog continuity intact.
    s.setLoadStartTs(Date.now());
  } catch (err) {
    useStore.getState().logActivity({
      kind: 'error',
      summary: 'Model reload after edit failed - the viewer may be stale until the next reload',
      detail: err instanceof Error ? err.message : String(err),
    });
  } finally {
    inFlight = false;
    activeFingerprint = null;
    const followUp = rerunRequested;
    rerunRequested = null;
    if (followUp) {
      requestModelRefresh(followUp.reason || 'follow-up edit', followUp.fingerprint);
    }
  }
}

/** The event target carrying 'ifc-viewer-ready'. `window` in the browser
 *  (ViewerPanel dispatches there); a standalone EventTarget under the node
 *  test environment so tests can drive readiness deterministically. */
export const viewerReadyBus: EventTarget =
  typeof window !== 'undefined'
    ? (window as unknown as EventTarget)
    : new EventTarget();

function restoreCameraWhenReady(
  camera: { pos: [number, number, number]; target: [number, number, number] },
  expectedFingerprint: string,
): void {
  const bus = viewerReadyBus;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const finish = () => {
    if (done) return;
    done = true;
    bus.removeEventListener('ifc-viewer-ready', onReady as EventListener);
    if (timer !== null) clearTimeout(timer);
  };
  const onReady = (event: Event) => {
    const detail = (event as CustomEvent<{ fingerprint?: string | null }>).detail;
    const fp = detail?.fingerprint ?? null;
    if (fp && expectedFingerprint && fp !== expectedFingerprint) return;
    // Give the freshly mounted controls one frame to initialise.
    const raf: (cb: () => void) => void =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (cb) => void setTimeout(cb, 16);
    raf(() => {
      useStore.getState().setLookAtFn?.(camera.pos, camera.target, false);
    });
    finish();
  };
  bus.addEventListener('ifc-viewer-ready', onReady as EventListener);
  timer = setTimeout(finish, CAMERA_RESTORE_TIMEOUT_MS);
}
