/**
 * LOD navigation swap: decimated model while orbiting, crisp model at rest.
 *
 * Profiling proved big-model orbit FPS is vertex/geometry-throughput bound
 * (GPU linear in triangle count). A backend decimation pass produces a
 * lower-poly ".frag" (e.g. 5.68M -> 1.77M tris on a large model). This controller renders
 * the DECIMATED model while the camera is moving - when the roughness of
 * topology-ignoring simplification is invisible - and swaps back to the FULL,
 * crisp model the moment the camera comes to rest. Verified: ~38 ms -> ~5 ms
 * GPU per frame during motion on a large model.
 *
 * The swap is pure container-visibility toggling on the two model objects; the
 * fragments engine keeps managing both. It never touches per-mesh (isolate /
 * hide / ghost) visibility, so that state survives a swap untouched - but the
 * decimated model does NOT mirror it, so the caller must DISABLE the swap
 * whenever any per-element visibility or appearance override is active (else
 * orbiting would flash the unstyled whole building). Small/medium models never
 * get a proxy, so their WebGL baseline does not change.
 */
import type * as THREE from 'three';
import { apiUrl } from '../../lib/platform';

const NAV_TO_LOD_MS = 90; // sustained motion before showing the LOD (no flicker on clicks/nudges)
const REST_TO_FULL_MS = 60; // small delay before restoring the crisp model at rest
// Watchdog: while the LOD is showing, every onNavigate() signal refreshes this
// timer; if NO signal arrives for this long the controller restores the full
// model on its own. Guarantees the decimated model can never get stuck on
// screen even if a camera-controls 'rest'/'sleep' event is missed (the caller
// feeds continuous 'update' events, so an active drag refreshes every frame).
const LOD_HOLD_TIMEOUT_MS = 700;

export class LodSwapController {
  private full: THREE.Object3D | null = null;
  private lod: THREE.Object3D | null = null;
  private enabled = false;
  private navigating = false;
  private restTimer: ReturnType<typeof setTimeout> | null = null;
  private navStartTimer: ReturnType<typeof setTimeout> | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private lastNavigateAt = 0;

  constructor(private readonly onVisibilityChange?: () => void) {}

  setTargets(full: THREE.Object3D | null, lod: THREE.Object3D | null): void {
    this.full = full;
    this.lod = lod;
    this.apply();
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      // Snap back to the full model immediately when the gate closes.
      this.clearTimers();
      this.navigating = false;
    }
    this.apply();
  }

  /** True when a swap can actually happen (enabled + both models present). */
  get active(): boolean {
    return this.enabled && !!this.full && !!this.lod;
  }

  /** Camera started/continues moving. Safe to call at frame rate. */
  onNavigate(): void {
    if (!this.active) return;
    if (this.restTimer !== null) {
      clearTimeout(this.restTimer);
      this.restTimer = null;
    }
    if (this.navigating) {
      this.refreshHoldTimer();
      return;
    }
    if (this.navStartTimer !== null) return;
    this.navStartTimer = setTimeout(() => {
      this.navStartTimer = null;
      if (!this.active) return;
      this.navigating = true;
      this.apply();
      this.refreshHoldTimer();
    }, NAV_TO_LOD_MS);
  }

  /** Belt-and-braces: restore the full model when nav signals stop flowing. */
  private refreshHoldTimer(): void {
    this.lastNavigateAt = Date.now();
    if (this.holdTimer !== null) return;
    const check = () => {
      this.holdTimer = null;
      if (!this.navigating) return;
      const remaining = LOD_HOLD_TIMEOUT_MS - (Date.now() - this.lastNavigateAt);
      if (remaining > 0) {
        this.holdTimer = setTimeout(check, remaining);
        return;
      }
      this.navigating = false;
      this.apply();
    };
    this.holdTimer = setTimeout(check, LOD_HOLD_TIMEOUT_MS);
  }

  /** Camera came to rest. */
  onRest(): void {
    if (this.navStartTimer !== null) {
      clearTimeout(this.navStartTimer);
      this.navStartTimer = null;
    }
    if (!this.navigating || this.restTimer !== null) return;
    this.restTimer = setTimeout(() => {
      this.restTimer = null;
      if (this.holdTimer !== null) {
        clearTimeout(this.holdTimer);
        this.holdTimer = null;
      }
      this.navigating = false;
      this.apply();
    }, REST_TO_FULL_MS);
  }

  private apply(): void {
    const fullWasVisible = this.full?.visible;
    const lodWasVisible = this.lod?.visible;
    if (!this.active) {
      if (this.full) this.full.visible = true;
      if (this.lod) this.lod.visible = false;
    } else {
      const showLod = this.navigating;
      this.full!.visible = !showLod;
      this.lod!.visible = showLod;
    }
    if (
      fullWasVisible !== this.full?.visible
      || lodWasVisible !== this.lod?.visible
    ) {
      this.onVisibilityChange?.();
    }
  }

  private clearTimers(): void {
    if (this.restTimer !== null) {
      clearTimeout(this.restTimer);
      this.restTimer = null;
    }
    if (this.navStartTimer !== null) {
      clearTimeout(this.navStartTimer);
      this.navStartTimer = null;
    }
    if (this.holdTimer !== null) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    this.lastNavigateAt = 0;
  }

  dispose(): void {
    this.clearTimers();
    // Never leave the viewer showing only a decimated model.
    if (this.full) this.full.visible = true;
    if (this.lod) this.lod.visible = false;
    this.full = null;
    this.lod = null;
  }
}

interface FragmentManagerCore {
  core: {
    settings: { autoCoordinate: boolean };
    load: (
      bytes: Uint8Array,
      opts: { modelId: string },
    ) => Promise<{
      object: THREE.Object3D;
      useCamera?: (camera: THREE.Camera) => void;
      setLodMode?: (mode: number) => Promise<void> | void;
    }>;
    disposeModel: (modelId: string) => Promise<void> | void;
  };
}

type FragmentManagerCoreApi = FragmentManagerCore['core'];

// Fragments exposes coordinate policy as mutable manager-wide state rather
// than a per-load option. Lazy LOD loads may overlap when the preference is
// toggled quickly, so serialize the setting/load/restore critical section for
// each manager. Without this, an older completion can restore a stale value
// while a replacement load is still reading the setting.
const lodLoadTails = new WeakMap<object, Promise<void>>();

async function waitForLoadTurn(
  previous: Promise<void>,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!signal) {
    await previous;
    return true;
  }
  if (signal.aborted) return false;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(ready);
    };
    const onAbort = () => finish(false);
    signal.addEventListener('abort', onAbort, { once: true });
    void previous.then(() => finish(true));
  });
}

async function loadWithCoordinatePolicy(
  core: FragmentManagerCoreApi,
  bytes: Uint8Array,
  modelId: string,
  autoCoordinate: boolean,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<FragmentManagerCoreApi['load']>> | null> {
  const previousTail = lodLoadTails.get(core) ?? Promise.resolve();
  const previousReady = previousTail.catch(() => undefined);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const currentTail = previousReady.then(() => gate);
  lodLoadTails.set(core, currentTail);

  try {
    const turnReady = await waitForLoadTurn(previousReady, signal);
    if (!turnReady || signal?.aborted) return null;
    const previousAutoCoordinate = core.settings.autoCoordinate;
    core.settings.autoCoordinate = autoCoordinate;
    try {
      return await core.load(bytes, { modelId });
    } finally {
      core.settings.autoCoordinate = previousAutoCoordinate;
    }
  } finally {
    release();
    // An aborted waiter may return before its predecessor settles. Keep its
    // tail in the map until then so later requests cannot bypass the active
    // critical section, while allowing the aborted call (and its bytes) to be
    // released immediately.
    void currentTail.finally(() => {
      if (lodLoadTails.get(core) === currentTail) lodLoadTails.delete(core);
    });
  }
}

export interface AttachedLod {
  lodModelId: string;
  lodObject: THREE.Object3D;
  dispose: () => void;
}

/**
 * Fetch the decimated ".frag" for the currently loaded model from the backend
 * and load it as a hidden secondary model overlaying the full one. Returns
 * null (and logs at debug) when there is no LOD - small model, sidecar down,
 * BROWSER_ONLY, or any error - so the caller silently keeps the full model.
 *
 * Overlay: the decimated geometry has identical coordinates to the full
 * model. Fragments applies the manager's current coordinate policy; load()
 * itself does not accept a per-model coordinate option.
 */
export async function loadAndAttachLod(opts: {
  fragmentsManager: FragmentManagerCore;
  worldScene: THREE.Object3D;
  fullModelId: string;
  /** Retained for caller compatibility; Fragments reads this from core settings. */
  autoCoordinate: boolean;
  /** Camera used by the fragments model for tile/view updates. */
  camera?: THREE.Camera;
  /** Optional unique id for overlapping/retried lazy loads. */
  lodModelId?: string;
  /** SHA-256 the convert path cached the full frag under; required by the route. */
  fingerprint: string | null;
  /** Graphics profile the full frag was cached under (cache-key component). */
  profile: string;
  signal?: AbortSignal;
  /**
   * FRAGS.LodMode.ALL_VISIBLE, passed in so this module stays free of a
   * @thatopen/fragments value import. When set, the decimated model is pinned
   * to it after load so the motion view never coverage-culls its own elements.
   */
  allVisibleLodMode?: number;
}): Promise<AttachedLod | null> {
  const {
    fragmentsManager, worldScene, fullModelId, camera, fingerprint, profile, signal,
    lodModelId: requestedLodModelId,
    allVisibleLodMode,
  } = opts;
  if (!fingerprint) return null; // no fingerprint -> cannot address the cached full frag
  try {
    const query = `?fingerprint=${encodeURIComponent(fingerprint)}&profile=${encodeURIComponent(profile)}`;
    const resp = await fetch(apiUrl(`/api/ifc/lod${query}`), { signal });
    if (!resp.ok) return null; // 503 = no LOD available; treat as "use full model"
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (bytes.byteLength === 0 || signal?.aborted) return null;
    const lodModelId = requestedLodModelId ?? `${fullModelId}__lod`;
    const core = fragmentsManager.core;
    const lodModel = await loadWithCoordinatePolicy(
      core,
      bytes,
      lodModelId,
      opts.autoCoordinate,
      signal,
    );
    if (!lodModel) return null;
    let disposed = false;
    let abortListener: (() => void) | null = null;

    const detachObject = (): void => {
      try { lodModel.object.parent?.remove(lodModel.object); } catch { /* best-effort */ }
    };
    const disposeLoadedModel = (): void => {
      // Always detach first. Repeated cleanup remains safe even if another
      // owner briefly re-attached the object, while the registered Fragments
      // model is still disposed exactly once.
      detachObject();
      if (disposed) return;
      disposed = true;
      if (signal && abortListener) signal.removeEventListener('abort', abortListener);
      abortListener = null;
      try {
        void Promise.resolve(core.disposeModel(lodModelId)).catch(() => undefined);
      } catch { /* best-effort */ }
    };

    abortListener = () => disposeLoadedModel();
    signal?.addEventListener('abort', abortListener, { once: true });

    if (signal?.aborted) {
      disposeLoadedModel();
      return null;
    }

    try {
      if (camera) lodModel.useCamera?.(camera);
      // Keep the decimated model in ALL_VISIBLE: it is drawn in full during
      // motion (that is the whole point of the low-poly swap), so its own
      // view-time coverage cull must be off or it flickers like the full model.
      if (typeof allVisibleLodMode === 'number') {
        try {
          await lodModel.setLodMode?.(allVisibleLodMode);
        } catch { /* best-effort; LOD mode is an optimization, never fatal */ }
      }
      if (disposed || signal?.aborted) {
        disposeLoadedModel();
        return null;
      }
      lodModel.object.visible = false;
      worldScene.add(lodModel.object);
      if (disposed || signal?.aborted) {
        disposeLoadedModel();
        return null;
      }
      return {
        lodModelId,
        lodObject: lodModel.object,
        dispose: disposeLoadedModel,
      };
    } catch {
      disposeLoadedModel();
      return null;
    }
  } catch {
    return null; // network/abort/parse - degrade to the full model
  }
}
