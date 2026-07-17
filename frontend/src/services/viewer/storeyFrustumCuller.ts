/**
 * Per-storey AABB frustum culling for multi-storey IFC models.
 *
 * Strategy from the archived WebGPU compute-culling research note:
 *   - Build one THREE.Box3 per storey from model.getItemsGeometry() - one-time
 *     async, ~50-300 ms, fetched in chunks of 64 ids with a macrotask yield
 *     between chunks.
 *   - Each camera settle (debounced 300 ms after camera stop), test THREE.Frustum.intersectsBox().
 *   - Storeys fully outside the frustum are hidden via model.setVisible(localIds, false).
 *   - Only runs when no user isolation is active (isolatedIds.length === 0) to avoid state conflict.
 *   - Dispose restores all auto-culled elements.
 *
 * Limitations:
 *   - Max 5 000 total leaf elements across all storeys (performance guard on large models).
 *   - Does not fight user-set visibility; disabled when user isolates any element.
 *   - Requires the spatial tree to have storey nodes with at least one leaf child.
 */

import * as THREE from 'three';
import type * as FRAGS from '@thatopen/fragments';
import type { SpatialNode } from '../../types/ifc';
import { collectLeavesUnder } from './spatialTreeHelpers';
import type { VisibilityMutationTarget } from './renderStateCoordinator';

const MAX_TOTAL_ELEMENTS = 5_000;

/**
 * Geometry-fetch batch size. Caps a single
 * getItemsGeometry round-trip at 64 ids (a storey can hold thousands) and
 * yields a macrotask between chunks so clicks/camera work can interleave
 * with the build. Mirrors ElementFrustumCuller.
 */
const GEOMETRY_CHUNK = 64;

interface StoreyRecord {
  storeyId: number;
  name: string;
  localIds: number[];
  box: THREE.Box3;
  autoCulled: boolean;
}

export interface StoreyFrustumCullerOptions {
  /**
   * Inflate each storey AABB by `padFraction * modelDiag` after build -
   * keeps storey contents visible when the camera frustum is just outside
   * the storey box. Default 0 (no padding) preserves the unpadded
   * behaviour the existing tests pin. ViewerPanel passes ~0.03.
   */
  padFraction?: number;
}

export class StoreyFrustumCuller {
  private records: StoreyRecord[] = [];
  private _built = false;
  private _disposed = false;
  private frustum = new THREE.Frustum();
  private projScreenMatrix = new THREE.Matrix4();
  private readonly padFraction: number;
  /** Last-invoked operation owns bookkeeping after its async mutation settles. */
  private ownershipEpoch = 0;

  constructor(opts: StoreyFrustumCullerOptions = {}) {
    this.padFraction = Math.max(0, opts.padFraction ?? 0);
  }

  get isBuilt(): boolean { return this._built && !this._disposed; }
  get storeyCount(): number { return this.records.length; }

  /**
   * Flat list of every local ID whose storey is currently `autoCulled`.
   * Read-only; safe to call from any tick - does not touch the model.
   *
   * Coordination rule ❷: the element culler reads this to skip storey-owned
   * elements from its own frustum test (and to keep its `autoCulled` book-
   * keeping in sync with the actual model state).
   */
  getCulledMemberIds(): number[] {
    if (!this._built || this._disposed) return [];
    const out: number[] = [];
    for (const r of this.records) {
      if (r.autoCulled) {
        for (const id of r.localIds) out.push(id);
      }
    }
    return out;
  }

  /** See ElementFrustumCuller.releaseOwnership. */
  releaseOwnership(): void {
    this.ownershipEpoch += 1;
    for (const record of this.records) record.autoCulled = false;
  }

  /**
   * Async one-time build - computes a bounding box per storey from geometry.
   * Safe to await or fire-and-forget (checks `_disposed` throughout).
   *
   * Geometry is fetched in chunks of GEOMETRY_CHUNK ids with a macrotask
   * yield between consecutive worker round-trips (D1) - including across
   * storeys - so the build never monopolizes the worker right after load.
   * A failed chunk fetch only loses that chunk's contribution to the
   * storey box instead of skipping the whole storey.
   *
   * @param localIdLookup Optional pre-resolved express→local id map (built
   *                      by the call-site in one batched round-trip). When
   *                      provided, no per-id `getItem().getLocalId()` calls
   *                      are made; when absent, falls back to the original
   *                      per-element resolution path.
   */
  async build(
    model: FRAGS.FragmentsModel,
    storeyNodes: SpatialNode[],
    localIdLookup?: ReadonlyMap<number, number>,
  ): Promise<void> {
    if (this._disposed) return;

    let totalElements = 0;
    let fetchedOnce = false;
    const tmp = new THREE.Vector3();

    for (const storey of storeyNodes) {
      if (this._disposed) return;

      const expressIds = collectLeavesUnder(storey);
      if (expressIds.length === 0) continue;

      totalElements += expressIds.length;
      if (totalElements > MAX_TOTAL_ELEMENTS) break;

      // Express → local IDs. Prefer the caller's pre-resolved map (zero
      // worker round-trips); otherwise resolve per element (async; uses
      // @thatopen internal map).
      const localIds: number[] = [];
      if (localIdLookup) {
        for (const expId of expressIds) {
          const lid = localIdLookup.get(expId);
          if (lid != null) localIds.push(lid);
        }
      } else {
        for (const expId of expressIds) {
          if (this._disposed) return;
          try {
            const item = model.getItem(expId);
            const lid = await item.getLocalId();
            if (lid != null) localIds.push(lid);
          } catch { /* element may not exist in fragments - skip */ }
        }
      }

      if (localIds.length === 0 || this._disposed) continue;

      // Compute AABB from element geometry, fetched in GEOMETRY_CHUNK-sized
      // batches. model.getItemsGeometry returns Array<Array<{ positions,
      // indices, transform }>> - outer dim is parallel to the requested
      // localIds, inner dim is per mesh face group.
      const box = new THREE.Box3();
      for (let start = 0; start < localIds.length; start += GEOMETRY_CHUNK) {
        if (this._disposed) return;

        // Yield between worker round-trips (also across storeys) so user
        // input and the render loop get a turn.
        if (fetchedOnce) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          if (this._disposed) return;
        }
        fetchedOnce = true;

        const chunk = localIds.slice(start, start + GEOMETRY_CHUNK);
        try {
          const perItem = await model.getItemsGeometry(chunk) as Array<Array<{
            positions?: Float32Array | Float64Array;
            indices?: ArrayLike<number>;
            transform: THREE.Matrix4;
          }> | null>;
          if (!perItem) continue;

          for (const itemMeshes of perItem) {
            if (!itemMeshes) continue;
            for (const md of itemMeshes) {
              if (this._disposed) return;
              if (!md?.positions) continue;
              const pos = md.positions;
              const mat = md.transform as THREE.Matrix4;
              for (let i = 0; i < pos.length; i += 3) {
                tmp.set(pos[i], pos[i + 1], pos[i + 2]).applyMatrix4(mat);
                box.expandByPoint(tmp);
              }
            }
          }
        } catch { /* chunk geometry unavailable - its elements skipped */ }
      }

      if (!box.isEmpty() && !this._disposed) {
        this.records.push({
          storeyId: storey.id,
          name: storey.name,
          localIds,
          box,
          autoCulled: false,
        });
      }
    }

    // Frustum margin: see ElementFrustumCuller for rationale.
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
   * Test the current camera frustum against storey AABBs and hide/show accordingly.
   *
   * @param camera   The THREE.js camera from the @thatopen world.
   * @param model    FragmentsModel for setVisible calls.
   * @returns        Number of storeys currently culled (hidden by this culler).
   */
  async tick(
    camera: THREE.Camera,
    model: FRAGS.FragmentsModel,
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

    const toHide: StoreyRecord[] = [];
    const toShow: StoreyRecord[] = [];

    for (const r of this.records) {
      if (this._disposed) return 0;
      const inFrustum = this.frustum.intersectsBox(r.box);

      if (!inFrustum && !r.autoCulled) {
        toHide.push(r);
      } else if (inFrustum && r.autoCulled) {
        toShow.push(r);
      }
    }

    if (toHide.length > 0 || toShow.length > 0) {
      // Record desired ownership before awaiting the rendered coordinator
      // acknowledgement. Navigation can then reveal a just-published hide
      // without scanning/sending every in-frustum storey on steady frames.
      for (const record of toHide) record.autoCulled = true;
      for (const record of toShow) record.autoCulled = false;
      try {
        const hideIds = toHide.flatMap((record) => record.localIds);
        const showIds = toShow.flatMap((record) => record.localIds);
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
        /* rolled-back flags make a later tick retry */
      }
    }

    return this.records.filter((record) => record.autoCulled).length;
  }

  /**
   * Cheap show-only pass for use DURING orbit. Companion to
   * ElementFrustumCuller.showPass - iterates only desired `autoCulled`
   * storeys. Settle ticks set that desired flag before awaiting the rendered
   * acknowledgement, so pending hides remain revealable without redundant
   * full-model coordinator writes. No hide writes - hides wait for settle.
   */
  async showPass(
    camera: THREE.Camera,
    model: FRAGS.FragmentsModel,
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

    const toShow: StoreyRecord[] = [];
    for (const r of this.records) {
      if (this._disposed) return 0;
      if (r.autoCulled && this.frustum.intersectsBox(r.box)) {
        toShow.push(r);
      }
    }
    if (toShow.length > 0) {
      for (const record of toShow) record.autoCulled = false;
      try {
        await visibility.setVisible(toShow.flatMap((record) => record.localIds), true);
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
   * Clear all auto-culled storeys (restores visibility) without tearing down records.
   * Call before user activates isolation so the two systems don't fight.
   */
  async clearCull(
    model: FRAGS.FragmentsModel,
    visibility: VisibilityMutationTarget = model,
  ): Promise<void> {
    const operationEpoch = ++this.ownershipEpoch;
    const culled = this.records.filter((record) => record.autoCulled);
    for (const record of culled) record.autoCulled = false;
    try {
      if (visibility.clearVisibility) {
        await visibility.clearVisibility();
      } else if (culled.length > 0) {
        await visibility.setVisible(culled.flatMap((record) => record.localIds), true);
      }
      if (operationEpoch === this.ownershipEpoch) {
        for (const record of this.records) record.autoCulled = false;
      }
    } catch (error) {
      if (operationEpoch === this.ownershipEpoch && !this._disposed) {
        for (const record of culled) record.autoCulled = true;
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
}

/**
 * Extract IfcBuildingStorey nodes from the spatial tree root.
 * Returns an empty array if the tree is null or has no storey children.
 */
export function extractStoreyNodes(root: SpatialNode | null): SpatialNode[] {
  if (!root) return [];
  const out: SpatialNode[] = [];

  const walk = (node: SpatialNode) => {
    if (node.ifc_type.toLowerCase() === 'ifcbuildingstorey') {
      out.push(node);
      return; // don't recurse into nested storeys (degenerate models)
    }
    for (const child of node.children ?? []) walk(child);
  };

  walk(root);
  return out;
}
