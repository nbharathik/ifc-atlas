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
 * whenever an isolation/hide/ghost is active (else orbiting a single isolated
 * wall would flash the whole building). Small models never get a LOD, so they
 * are unaffected - the WebGL baseline never changes for them.
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
    if (this.holdTimer !== null) clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      if (!this.navigating) return;
      this.navigating = false;
      this.apply();
    }, LOD_HOLD_TIMEOUT_MS);
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
    if (!this.active) {
      if (this.full) this.full.visible = true;
      if (this.lod) this.lod.visible = false;
      return;
    }
    const showLod = this.navigating;
    this.full!.visible = !showLod;
    this.lod!.visible = showLod;
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
  core: { load: (bytes: Uint8Array, opts: { modelId: string }) => Promise<{ object: THREE.Object3D }> };
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
 * Overlay: the LOD is loaded with the SAME autoCoordinate flag as the full
 * model. The decimated geometry has identical coordinates, so the engine
 * computes the same recentering offset and the two overlay exactly.
 */
export async function loadAndAttachLod(opts: {
  fragmentsManager: FragmentManagerCore;
  worldScene: THREE.Object3D;
  fullModelId: string;
  autoCoordinate: boolean;
  /** SHA-256 the convert path cached the full frag under; required by the route. */
  fingerprint: string | null;
  /** Graphics profile the full frag was cached under (cache-key component). */
  profile: string;
  signal?: AbortSignal;
}): Promise<AttachedLod | null> {
  const { fragmentsManager, worldScene, fullModelId, autoCoordinate, fingerprint, profile, signal } = opts;
  if (!fingerprint) return null; // no fingerprint -> cannot address the cached full frag
  try {
    const query = `?fingerprint=${encodeURIComponent(fingerprint)}&profile=${encodeURIComponent(profile)}`;
    const resp = await fetch(apiUrl(`/api/ifc/lod${query}`), { signal });
    if (!resp.ok) return null; // 503 = no LOD available; treat as "use full model"
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (bytes.byteLength === 0 || signal?.aborted) return null;
    const lodModelId = `${fullModelId}__lod`;
    const lodModel = await (fragmentsManager as unknown as {
      core: {
        load: (b: Uint8Array, o: { modelId: string; camera?: unknown; raw?: boolean; coordinate?: boolean }) => Promise<{ object: THREE.Object3D }>;
      };
    }).core.load(bytes, { modelId: lodModelId, coordinate: autoCoordinate });
    if (signal?.aborted) {
      try { lodModel.object.parent?.remove(lodModel.object); } catch { /* best-effort */ }
      return null;
    }
    lodModel.object.visible = false;
    worldScene.add(lodModel.object);
    return {
      lodModelId,
      lodObject: lodModel.object,
      dispose: () => {
        try { lodModel.object.parent?.remove(lodModel.object); } catch { /* best-effort */ }
      },
    };
  } catch {
    return null; // network/abort/parse - degrade to the full model
  }
}
