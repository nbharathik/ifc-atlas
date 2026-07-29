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
import type { VisibilityMutationTarget } from './renderStateCoordinator';

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
  /** Last-invoked operation owns bookkeeping after its async mutation settles. */
  private ownershipEpoch = 0;

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
        // The worker computes per-item boxes directly; transferring raw vertex
        // buffers to rebuild them on the main thread cost 120-250 ms per model.
        const boxes = await model.getBoxes(chunk);
        for (let i = 0; i < chunk.length; i++) {
          if (this._disposed) return;
          const box = boxes[i];
          if (!box || box.isEmpty()) continue;
          this.records.push({ localId: chunk[i], box: box.clone(), autoCulled: false });
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
    visibility: VisibilityMutationTarget = model,
  ): Promise<number> {
    if (!this._built || this._disposed || this.records.length === 0) return 0;
    const operationEpoch = ++this.ownershipEpoch;

    camera.updateMatrixWorld();
    this.projScreenMatrix.multiplyMatrices(
      (camera as THREE.PerspectiveCamera).projectionMatrix,
      camera.matrixWorldInverse,
    );
    this.frustum.setFromProjectionMatrix(this.projScreenMatrix);

    const toHide: ElementRecord[] = [];
    const toShow: ElementRecord[] = [];

    for (const r of this.records) {
      if (this._disposed) return 0;
      if (excludeIds?.has(r.localId)) {
        // Storey culler owns this element this tick. Reset our flag so it
        // doesn't claim a phantom culling state for a record we are not
        // touching. Skip the frustum test.
        if (r.autoCulled) toShow.push(r);
        continue;
      }
      const inFrustum = this.frustum.intersectsBox(r.box);
      if (!inFrustum && !r.autoCulled) {
        toHide.push(r);
      } else if (inFrustum && r.autoCulled) {
        toShow.push(r);
      }
    }

    // Publish local desired ownership before awaiting the worker/coordinator.
    // The coordinator updates its named mask synchronously, then resolves only
    // after a rendered acknowledgement. A navigation show-pass can therefore
    // overlap this await and must already see the pending hide. Roll back only
    // when this operation is still the newest owner; a newer show/tick wins.
    if (toHide.length > 0 || toShow.length > 0) {
      for (const record of toHide) record.autoCulled = true;
      for (const record of toShow) record.autoCulled = false;
      try {
        const hideIds = toHide.map((record) => record.localId);
        const showIds = toShow.map((record) => record.localId);
        if (visibility.applyVisibilityDelta) {
          await visibility.applyVisibilityDelta(hideIds, showIds);
        } else {
          if (showIds.length > 0) await visibility.setVisible(showIds, true);
          if (hideIds.length > 0) await visibility.setVisible(hideIds, false);
        }
      } catch {
        if (operationEpoch === this.ownershipEpoch && !this._disposed) {
          for (const record of toHide) record.autoCulled = false;
          for (const record of toShow) record.autoCulled = true;
        }
        /* best-effort; rolled-back flags make the next pass retry */
      }
    }

    return this.records.filter((r) => r.autoCulled).length;
  }

  /**
   * Cheap show-only pass for use DURING orbit. It iterates only the desired
   * `autoCulled` subset. Settle ticks publish that local desired ownership
   * before awaiting the renderer, so this includes hides whose rendered
   * acknowledgement is still in flight without sending every visible element
   * through the coordinator on each navigation pass.
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
    visibility: VisibilityMutationTarget = model,
  ): Promise<number> {
    if (!this._built || this._disposed || this.records.length === 0) return 0;
    const operationEpoch = ++this.ownershipEpoch;

    let anyCulled = false;
    for (const record of this.records) {
      if (record.autoCulled) {
        anyCulled = true;
        break;
      }
    }
    if (!anyCulled) return 0;

    camera.updateMatrixWorld();
    this.projScreenMatrix.multiplyMatrices(
      (camera as THREE.PerspectiveCamera).projectionMatrix,
      camera.matrixWorldInverse,
    );
    this.frustum.setFromProjectionMatrix(this.projScreenMatrix);

    const toShow: ElementRecord[] = [];
    for (const r of this.records) {
      if (this._disposed) return 0;
      if (excludeIds?.has(r.localId)) {
        if (r.autoCulled) toShow.push(r);
        continue;
      }
      if (r.autoCulled && this.frustum.intersectsBox(r.box)) {
        toShow.push(r);
      }
    }

    if (toShow.length > 0) {
      for (const record of toShow) record.autoCulled = false;
      try {
        await visibility.setVisible(toShow.map((record) => record.localId), true);
      } catch {
        if (operationEpoch === this.ownershipEpoch && !this._disposed) {
          for (const record of toShow) record.autoCulled = true;
        }
        return 0;
      }
    }
    return toShow.length;
  }

  /**
   * Restore all auto-culled elements without clearing records.
   * Call before user activates isolation to avoid visibility conflicts.
   */
  async clearCull(
    model: FRAGS.FragmentsModel,
    visibility: VisibilityMutationTarget = model,
  ): Promise<void> {
    const operationEpoch = ++this.ownershipEpoch;
    const culledRecords = this.records.filter((record) => record.autoCulled);
    const culled = culledRecords.map((record) => record.localId);
    for (const record of culledRecords) record.autoCulled = false;
    // A coordinator target is authoritative even when local flags are stale
    // because an older async tick has not acknowledged yet.
    try {
      if (visibility.clearVisibility) {
        await visibility.clearVisibility();
      } else if (culled.length > 0) {
        await visibility.setVisible(culled, true);
      }
      if (operationEpoch === this.ownershipEpoch) {
        this.records.forEach((r) => { r.autoCulled = false; });
      }
    } catch (error) {
      if (operationEpoch === this.ownershipEpoch && !this._disposed) {
        for (const record of culledRecords) record.autoCulled = true;
      }
      throw error;
    }
  }

  /** Release all resources and restore visibility. */
  async dispose(
    model?: FRAGS.FragmentsModel,
    visibility?: VisibilityMutationTarget,
  ): Promise<void> {
    this._disposed = true;
    if (model) await this.clearCull(model, visibility ?? model);
    this.records = [];
  }

  /**
   * Forget culler ownership without mutating renderer visibility. Used when a
   * semantic user mask atomically clears the coordinator layer itself.
   */
  releaseOwnership(): void {
    this.ownershipEpoch += 1;
    for (const record of this.records) record.autoCulled = false;
  }
}
