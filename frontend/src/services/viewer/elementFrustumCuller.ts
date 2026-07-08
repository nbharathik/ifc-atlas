/**
 * Element-level AABB frustum culling for IFC models.
 *
 * Companion to StoreyFrustumCuller: the storey culler is a coarse pre-filter
 * that hides entire storeys. This culler provides fine-grained culling of
 * individual elements within visible storeys.
 *
 * Strategy:
 *   - Build one THREE.Box3 per element from model.getItemsGeometry() - async,
 *     one-time, fetched in chunks of 64 ids per worker round-trip with a
 *     macrotask yield between chunks.
 *   - On each camera settle, test THREE.Frustum.intersectsBox() per element AABB.
 *   - Elements outside the frustum are hidden via model.setVisible([localId], false).
 *   - Skip elements whose storey is already culled (storey culler owns those).
 *   - Gate: only runs when isolatedIds.length === 0 && hiddenIds.length === 0.
 *
 * Performance characteristics (BasicHouse.ifc, 149 elements):
 *   - Build: ~120-250 ms async (does not block rendering)
 *   - Tick: <1 ms frustum tests, O(N) setVisible calls grouped by change
 *   - Cap: MAX_ELEMENTS = 1500 to keep build time ≤ 3 s on typical models
 */

import * as THREE from 'three';
import type * as FRAGS from '@thatopen/fragments';

const MAX_ELEMENTS = 1_500;

/**
 * Geometry-fetch batch size. One
 * getItemsGeometry call per 64 ids instead of one per id collapses up to
 * 1 500 sequential worker round-trips into ≤ 24, and the macrotask yield
 * between chunks lets first clicks / camera work interleave with the build.
 */
const GEOMETRY_CHUNK = 64;

interface ElementRecord {
  localId: number;
  box: THREE.Box3;
  autoCulled: boolean;
}

export interface ElementFrustumCullerOptions {
  /**
   * Inflate each element AABB by `padFraction * modelDiag` after build, so
   * elements just outside the camera frustum are not culled. Eliminates the
   * "small pan → tiny element pops in/out" churn on the show path. Default
   * 0 (no padding) preserves the unpadded behaviour the existing tests
   * pin. ViewerPanel passes ~0.03 (3 % of model diagonal - ~1.5 m on a 50 m
   * BasicHouse).
   */
  padFraction?: number;
}

export class ElementFrustumCuller {
  private records: ElementRecord[] = [];
  private _built = false;
  private _disposed = false;
  private frustum = new THREE.Frustum();
  private projScreenMatrix = new THREE.Matrix4();
  private readonly padFraction: number;

  constructor(opts: ElementFrustumCullerOptions = {}) {
    this.padFraction = Math.max(0, opts.padFraction ?? 0);
  }

  get isBuilt(): boolean { return this._built && !this._disposed; }
  get elementCount(): number { return this.records.length; }

  /**
   * Local IDs currently `autoCulled === true`. Used by the eager show-pass
   * during orbit (ViewerPanel.tsx) - the show-pass only needs to test the
   * subset that is currently hidden, not every record. Trivial helper kept
   * here to avoid leaking the private `records` field.
   */
  getCulledLocalIds(): number[] {
    if (!this._built || this._disposed) return [];
    const out: number[] = [];
    for (const r of this.records) if (r.autoCulled) out.push(r.localId);
    return out;
  }

  /**
   * Build per-element AABBs from the model geometry.
   *
   * Geometry is fetched in chunks of GEOMETRY_CHUNK ids (one worker
   * round-trip per chunk instead of one per element), with a macrotask
   * yield between chunks so clicks/camera work can interleave with the
   * build (D1). A failed chunk fetch silently skips that chunk's elements.
   *
   * @param model      The loaded FragmentsModel.
   * @param localIds   All element local IDs to include (subset or all model IDs).
   *                   Pass the subset from visible storeys for best perf.
   *                   Already local-id space - the caller resolves express→
   *                   local before calling; no per-id round-trips happen here.
   */
  async build(
    model: FRAGS.FragmentsModel,
    localIds: number[],
  ): Promise<void> {
    if (this._disposed) return;

    const capped = localIds.slice(0, MAX_ELEMENTS);
    const tmp = new THREE.Vector3();

    for (let start = 0; start < capped.length; start += GEOMETRY_CHUNK) {
      if (this._disposed) return;

      // Yield between chunks (not before the first) so user input and the
      // render loop get a turn between worker round-trips.
      if (start > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (this._disposed) return;
      }

      const chunk = capped.slice(start, start + GEOMETRY_CHUNK);
      try {
        // Result is parallel to the input: perItem[i] holds the mesh face
        // groups for chunk[i] (getItemsGeometry(localIds) → MeshData[][]).
        const perItem = await model.getItemsGeometry(chunk) as Array<Array<{
          positions?: Float32Array | Float64Array;
          indices?: ArrayLike<number>;
          transform: THREE.Matrix4;
        }> | null>;
        if (!perItem) continue;

        for (let i = 0; i < chunk.length; i++) {
          if (this._disposed) return;
          const itemMeshes = perItem[i];
          if (!itemMeshes) continue;

          const box = new THREE.Box3();
          for (const md of itemMeshes) {
            if (!md?.positions) continue;
            const pos = md.positions;
            const mat = md.transform as THREE.Matrix4;
            for (let j = 0; j < pos.length; j += 3) {
              tmp.set(pos[j], pos[j + 1], pos[j + 2]).applyMatrix4(mat);
              box.expandByPoint(tmp);
            }
          }
          if (!box.isEmpty()) {
            this.records.push({ localId: chunk[i], box, autoCulled: false });
          }
        }
      } catch { /* chunk geometry unavailable - its elements skipped */ }
    }

    // Frustum margin: inflate each element AABB by a fraction of
    // the model diagonal so a small pan doesn't cause edge elements to flap
    // hidden↔visible. The 5-15 ms `setVisible(true)` + fragments LOD-tile
    // refetch on every flap is the dominant "objects pop in late" cost on
    // small/medium models. Padding adds at most ~10 % more draws per frame
    // at idle (measured on BasicHouse: 149→~160 visible), an imperceptible
    // GPU cost in exchange for a smooth show path.
    if (this.padFraction > 0 && this.records.length > 0 && !this._disposed) {
      const union = new THREE.Box3();
      for (const r of this.records) union.union(r.box);
      const size = new THREE.Vector3();
      union.getSize(size);
      const diag = size.length();
      const padMeters = diag * this.padFraction;
      if (padMeters > 0) {
        for (const r of this.records) r.box.expandByScalar(padMeters);
      }
    }

    this._built = !this._disposed;
  }

  /**
   * Test the current camera frustum against element AABBs and hide/show accordingly.
   *
   * @param camera     THREE.Camera from the @thatopen world.
   * @param model      FragmentsModel for setVisible calls.
   * @param excludeIds Optional set of local IDs whose storey is currently
   *                   `autoCulled` by `StoreyFrustumCuller`. Coordination
   *                   rule ❷: these elements are owned by the storey culler
   *                   for this tick. For each excluded record we reset
   *                   `autoCulled = false` so this culler's book-keeping
   *                   does not drift while the storey culler manages
   *                   visibility (the secondary `staleAutoCulled`
   *                   drift bug). Excluded records
   *                   are then skipped from the frustum test - no
   *                   `setVisible` write fires for them this tick.
   * @returns          Number of elements currently culled by this culler
   *                   (storey-owned records do not count even if they
   *                   were marked culled by us on a prior tick).
   */
  async tick(
    camera: THREE.Camera,
    model: FRAGS.FragmentsModel,
    excludeIds?: ReadonlySet<number>,
  ): Promise<number> {
    if (!this._built || this._disposed || this.records.length === 0) return 0;

    camera.updateMatrixWorld();
    this.projScreenMatrix.multiplyMatrices(
      (camera as THREE.PerspectiveCamera).projectionMatrix,
      camera.matrixWorldInverse,
    );
    this.frustum.setFromProjectionMatrix(this.projScreenMatrix);

    const toHide: number[] = [];
    const toShow: number[] = [];

    for (const r of this.records) {
      if (this._disposed) return 0;
      if (excludeIds?.has(r.localId)) {
        // Storey culler owns this element this tick. Reset our flag so it
        // doesn't claim a phantom culling state for a record we are not
        // touching. Skip the frustum test.
        r.autoCulled = false;
        continue;
      }
      const inFrustum = this.frustum.intersectsBox(r.box);
      if (!inFrustum && !r.autoCulled) {
        toHide.push(r.localId);
        r.autoCulled = true;
      } else if (inFrustum && r.autoCulled) {
        toShow.push(r.localId);
        r.autoCulled = false;
      }
    }

    // Batch setVisible calls for efficiency (one call per direction)
    if (toHide.length > 0) {
      try { await model.setVisible(toHide, false); } catch { /* best-effort */ }
    }
    if (toShow.length > 0) {
      try { await model.setVisible(toShow, true); } catch { /* best-effort */ }
    }

    return this.records.filter((r) => r.autoCulled).length;
  }

  /**
   * Cheap show-only pass for use DURING orbit. Iterates only the
   * subset currently `autoCulled` and un-hides any whose padded AABB has
   * re-entered the frustum. No hide writes - hiding can wait for the full
   * settle tick. This is the asymmetric-culling fix: hides are imperceptible
   * when delayed, but late shows look like "objects loading slowly" to the
   * user.
   *
   * Cost: one frustum.intersectsBox per currently-hidden record + one
   * batched setVisible(true). With the 5 % frustum margin, the show set is
   * typically 0-3 elements per rAF tick on BasicHouse. Safe to call on
   * every animation frame during orbit.
   *
   * @param excludeIds Same semantics as tick(): storey-owned elements are
   *                   skipped and their autoCulled flag is reset to avoid
   *                   book-keeping drift.
   * @returns          Count of elements un-hidden this call.
   */
  async showPass(
    camera: THREE.Camera,
    model: FRAGS.FragmentsModel,
    excludeIds?: ReadonlySet<number>,
  ): Promise<number> {
    if (!this._built || this._disposed || this.records.length === 0) return 0;

    // Cheap pre-check: if nothing is currently culled, there is nothing to
    // show. Avoids the frustum matrix rebuild on every rAF tick when the
    // user is panning entirely within a fully-visible region.
    let anyCulled = false;
    for (const r of this.records) {
      if (r.autoCulled) { anyCulled = true; break; }
    }
    if (!anyCulled) return 0;

    camera.updateMatrixWorld();
    this.projScreenMatrix.multiplyMatrices(
      (camera as THREE.PerspectiveCamera).projectionMatrix,
      camera.matrixWorldInverse,
    );
    this.frustum.setFromProjectionMatrix(this.projScreenMatrix);

    const toShow: number[] = [];
    for (const r of this.records) {
      if (this._disposed) return 0;
      if (excludeIds?.has(r.localId)) {
        r.autoCulled = false;
        continue;
      }
      if (!r.autoCulled) continue;
      if (this.frustum.intersectsBox(r.box)) {
        toShow.push(r.localId);
        r.autoCulled = false;
      }
    }

    if (toShow.length > 0) {
      try { await model.setVisible(toShow, true); } catch { /* best-effort */ }
    }
    return toShow.length;
  }

  /**
   * Restore all auto-culled elements without clearing records.
   * Call before user activates isolation to avoid visibility conflicts.
   */
  async clearCull(model: FRAGS.FragmentsModel): Promise<void> {
    const culled = this.records.filter((r) => r.autoCulled).map((r) => r.localId);
    if (culled.length > 0) {
      try { await model.setVisible(culled, true); } catch { /* best-effort */ }
    }
    this.records.forEach((r) => { r.autoCulled = false; });
  }

  /** Release all resources and restore visibility. */
  async dispose(model?: FRAGS.FragmentsModel): Promise<void> {
    this._disposed = true;
    if (model) await this.clearCull(model);
    this.records = [];
  }
}
