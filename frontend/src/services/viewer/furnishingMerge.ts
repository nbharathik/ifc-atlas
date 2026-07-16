/**
 * Furnishing element static merge.
 *
 * After IFC load, IfcFurnishingElement instances (chairs, tables, sofas)
 * live inside @thatopen InstancedMeshes and contribute ~3-5 draw calls on
 * BasicHouse and ~10-30 on larger models.
 *
 * This module merges their geometry into a single THREE.Mesh (1 draw call),
 * hides the originals via model.setVisible(), and returns a dispose() that
 * reverses the operation - safe to toggle on/off.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type * as FRAGS from '@thatopen/fragments';
import type { VisibilityMutationTarget } from './renderStateCoordinator';

/** Maximum furnishing items to include in the merge to prevent UI stall. */
const MERGE_CAP = 2000;

/** Category patterns matched by getItemsOfCategories. */
const FURNISHING_PATTERNS = [
  /FURNISHING/i,
  /FURNITURE/i,
  /SYSTEMFURNITURE/i,
];

export interface FurnishingMergeResult {
  mergedMesh: THREE.Mesh | null;
  furnishingLocalIds: number[];
  /**
   * Undo the merge: acknowledge originals visible, then remove the replacement.
   * A failed visibility restore rejects and may be retried.
   */
  dispose: () => Promise<void>;
}

export interface FurnishingMergeLifecycleOptions {
  /** Starts a merge. The implementation should observe the supplied signal. */
  apply: (signal: AbortSignal) => Promise<FurnishingMergeResult>;
  /** Re-assert fragment visibility/appearance after source ids are restored. */
  afterUnmerge?: () => Promise<void> | void;
  /** Called whenever desired/current/pending state changes. */
  onStateChange?: () => void;
}

function makeAbortError(): Error {
  const error = new Error('Furnishing merge aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw makeAbortError();
}

function disposeMergedMesh(scene: THREE.Scene, mesh: THREE.Mesh): void {
  scene.remove(mesh);
  mesh.geometry.dispose();
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const material of materials) material.dispose();
}

/**
 * Serializes furnishing merge application and disposal while allowing UI state
 * to change freely. Every desired-state change invalidates the work currently
 * in flight; an implementation that cannot stop immediately is still safe
 * because its stale result is disposed before the next operation starts.
 */
export class FurnishingMergeLifecycle {
  private desired = false;
  private current: FurnishingMergeResult | null = null;
  private pending = false;
  private revision = 0;
  private stopped = false;
  private activeApply: AbortController | null = null;
  private queue: Promise<void> = Promise.resolve();
  private shutdownPromise: Promise<void> | null = null;

  constructor(private readonly options: FurnishingMergeLifecycleOptions) {}

  get blocksNavigationLod(): boolean {
    return this.current !== null || this.pending;
  }

  get currentResult(): FurnishingMergeResult | null {
    return this.current;
  }

  get isPending(): boolean {
    return this.pending;
  }

  /** Set the latest requested merge state. Calls are safe to fire-and-forget. */
  setDesired(enabled: boolean): Promise<void> {
    if (this.stopped) return this.queue;
    if (enabled === this.desired) {
      // A failed restore deliberately keeps the replacement as current. A
      // repeated disable is the caller's explicit retry request.
      if (!enabled && this.current && !this.pending) return this.enqueueReconcile();
      return this.queue;
    }

    this.desired = enabled;
    this.revision += 1;
    this.activeApply?.abort();
    // Close the replacement-geometry gate synchronously; reconcile starts in
    // a microtask and must not leave a one-frame window for navigation LOD.
    if (enabled && !this.current) this.pending = true;
    this.emitStateChange();
    return this.enqueueReconcile();
  }

  /** Permanently stop the coordinator and dispose any current or stale merge. */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;

    if (!this.stopped) {
      this.stopped = true;
      this.desired = false;
      this.revision += 1;
      this.activeApply?.abort();
      this.emitStateChange();
    }

    const operation = this.enqueueReconcile();
    const tracked = operation.finally(() => {
      // Successful shutdown stays idempotent. If restoring originals failed,
      // keep ownership of the mounted replacement and allow shutdown() to be
      // called again to retry its now-retryable dispose operation.
      if (this.shutdownPromise === tracked && this.current) {
        this.shutdownPromise = null;
      }
    });
    this.shutdownPromise = tracked;
    return tracked;
  }

  private enqueueReconcile(): Promise<void> {
    const operation = this.queue.then(
      () => this.reconcile(),
      () => this.reconcile(),
    );
    // A failed consumer-supplied apply/dispose must not poison future work.
    this.queue = operation.catch(() => {});
    return operation;
  }

  private async reconcile(): Promise<void> {
    if (this.stopped || !this.desired) {
      await this.disposeCurrent();
      return;
    }

    if (this.current) {
      // A retained replacement from a failed disable remains a valid active
      // result if the latest desired state switched back to enabled.
      this.setPending(false);
      return;
    }

    const operationRevision = this.revision;
    const controller = new AbortController();
    this.activeApply = controller;
    this.setPending(true);

    let result: FurnishingMergeResult | null = null;
    try {
      result = await this.options.apply(controller.signal);
    } catch {
      // Aborts are expected when desired state changes. Other apply failures
      // leave the originals untouched and may be retried by a later toggle.
    } finally {
      if (this.activeApply === controller) this.activeApply = null;
    }

    const stale = controller.signal.aborted
      || this.stopped
      || !this.desired
      || operationRevision !== this.revision;

    if (stale) {
      if (result) {
        try {
          await result.dispose();
        } catch {
          // Disposal could not acknowledge the originals as visible. Retain
          // ownership of a mounted replacement so it cannot disappear from
          // lifecycle state while still present in the scene.
          if (result.mergedMesh) {
            this.current = result;
            this.emitStateChange();
          }
        }
      }
      if (!this.current) await this.runAfterUnmerge();
      // A newer enable may already be queued behind this stale cleanup. Keep
      // the gate closed until that replacement reconcile starts.
      this.setPending(this.desired && !this.stopped);
      return;
    }

    if (result?.mergedMesh) {
      this.current = result;
      this.setPending(false, true);
      return;
    }

    // No furnishings, unavailable geometry, or a visibility rollback is not
    // an active merge and must not permanently disable navigation LOD.
    if (result) {
      try { await result.dispose(); } catch { /* no-op/rollback cleanup */ }
      // A failed visibility write may have partially hidden then restored the
      // source ids. Reassert external visibility/culler ownership whenever a
      // no-op attempt had furnishing ids to touch.
      if (result.furnishingLocalIds.length > 0) await this.runAfterUnmerge();
    }
    this.setPending(false);
  }

  private async disposeCurrent(): Promise<void> {
    if (!this.current) {
      // A true -> false toggle can happen before the queued apply even starts.
      // Release the synchronous enable gate in that no-current path.
      this.setPending(this.desired && !this.stopped);
      return;
    }

    this.setPending(true);
    const result = this.current;
    try {
      await result.dispose();
      // Keep the result current until restore acknowledgement succeeds. This
      // preserves both scene ownership and the navigation-LOD gate on failure.
      if (this.current === result) {
        this.current = null;
        this.emitStateChange();
      }
      await this.runAfterUnmerge();
    } catch {
      // The result's retryable dispose keeps its replacement mounted. Leave it
      // current so a repeated disable or shutdown can safely retry restoration.
    } finally {
      this.setPending(this.desired && !this.stopped);
    }
  }

  private async runAfterUnmerge(): Promise<void> {
    try {
      await this.options.afterUnmerge?.();
    } catch {
      // Repair failure must not poison later toggle operations.
    }
  }

  private setPending(pending: boolean, currentChanged = false): void {
    if (this.pending === pending && !currentChanged) return;
    this.pending = pending;
    this.emitStateChange();
  }

  private emitStateChange(): void {
    this.options.onStateChange?.();
  }
}

/**
 * Collect local IDs of all furnishing elements in the model.
 * Returns an empty array if none are found or the API is unavailable.
 */
export async function collectFurnishingLocalIds(
  model: FRAGS.FragmentsModel,
): Promise<number[]> {
  try {
    const catMap = await model.getItemsOfCategories(FURNISHING_PATTERNS);
    // Defensive: only collect categories whose names actually match at least
    // one of the furnishing patterns (real API filters, mocks may not).
    const ids: number[] = [];
    for (const [cat, localIds] of Object.entries(catMap)) {
      if (FURNISHING_PATTERNS.some((re) => re.test(cat))) {
        ids.push(...(localIds as number[]));
      }
    }
    return ids.slice(0, MERGE_CAP);
  } catch {
    return [];
  }
}

/**
 * Build a merged THREE.BufferGeometry from the given local IDs.
 * Returns null if no valid geometry is found.
 *
 * Implementation note: positions are baked into world space by applying
 * each MeshData.transform before merge. Normals are skipped - the merged
 * mesh uses flatShading which computes face normals on the GPU.
 */
export async function buildMergedFurnishingGeometry(
  model: FRAGS.FragmentsModel,
  localIds: number[],
): Promise<THREE.BufferGeometry | null> {
  if (localIds.length === 0) return null;
  let meshDataPerItem: { transform: THREE.Matrix4; indices?: ArrayLike<number>; positions?: Float32Array | Float64Array }[][];
  try {
    meshDataPerItem = await model.getItemsGeometry(localIds);
  } catch {
    return null;
  }

  const geometries: THREE.BufferGeometry[] = [];
  for (const itemMeshData of meshDataPerItem) {
    if (!itemMeshData) continue;
    for (const md of itemMeshData) {
      if (!md?.positions || !md?.indices) continue;
      try {
        const geo = new THREE.BufferGeometry();
        const positions = new Float32Array(md.positions);
        const posAttr = new THREE.Float32BufferAttribute(positions, 3);
        posAttr.applyMatrix4(md.transform);
        geo.setAttribute('position', posAttr);
        const indices = md.indices;
        geo.setIndex(new THREE.BufferAttribute(
          indices instanceof Uint32Array ? indices :
          indices instanceof Uint16Array ? indices :
          new Uint32Array(indices),
          1,
        ));
        geo.computeVertexNormals();
        geometries.push(geo);
      } catch {
        // Skip malformed mesh data
      }
    }
  }

  if (geometries.length === 0) return null;
  try {
    return mergeGeometries(geometries, false);
  } finally {
    for (const g of geometries) g.dispose();
  }
}

/**
 * Apply furnishing merge to the scene:
 * 1. Collects furnishing local IDs
 * 2. Builds merged geometry from their mesh data
 * 3. Adds the merged mesh to the scene
 * 4. Hides originals through the acknowledged visibility boundary
 *
 * Returns a FurnishingMergeResult with a dispose() to undo everything.
 */
export async function applyFurnishingMerge(
  model: FRAGS.FragmentsModel,
  scene: THREE.Scene,
  signal?: AbortSignal,
  visibility: VisibilityMutationTarget = model,
): Promise<FurnishingMergeResult> {
  throwIfAborted(signal);
  const localIds = await collectFurnishingLocalIds(model);
  throwIfAborted(signal);

  const noOpDispose = async () => {};

  if (localIds.length === 0) {
    return { mergedMesh: null, furnishingLocalIds: [], dispose: noOpDispose };
  }

  const geometry = await buildMergedFurnishingGeometry(model, localIds);
  if (signal?.aborted) {
    geometry?.dispose();
    throw makeAbortError();
  }

  // Without replacement geometry the originals must remain visible.
  if (!geometry) {
    return { mergedMesh: null, furnishingLocalIds: localIds, dispose: noOpDispose };
  }

  const material = new THREE.MeshStandardMaterial({
    color: 0x8a7560,
    flatShading: true,
    roughness: 0.9,
    metalness: 0.0,
  });
  const mergedMesh = new THREE.Mesh(geometry, material);
  mergedMesh.name = '__furnishing_merged__';
  // Non-selectable: don't participate in raycasting for element selection
  mergedMesh.raycast = () => {};

  let restoreRequired = false;
  let disposed = false;
  let disposePromise: Promise<void> | null = null;

  const dispose = () => {
    if (disposed) return Promise.resolve();
    if (disposePromise) return disposePromise;

    const operation = (async () => {
      if (restoreRequired) {
        // Do not remove the replacement until the visibility coordinator has
        // acknowledged that source fragments are rendered again.
        await visibility.setVisible(localIds, true);
        restoreRequired = false;
      }
      disposeMergedMesh(scene, mergedMesh);
      disposed = true;
    })();
    disposePromise = operation;
    operation.then(
      () => {
        if (disposePromise === operation) disposePromise = null;
      },
      () => {
        // A rejected restore keeps both scene ownership and retryability.
        if (disposePromise === operation) disposePromise = null;
      },
    );
    return operation;
  };

  const activeResult: FurnishingMergeResult = {
    mergedMesh,
    furnishingLocalIds: localIds,
    dispose,
  };

  // Mount the replacement before the originals are hidden. The visibility
  // coordinator's acknowledged refresh can therefore never paint a frame in
  // which both representations are absent.
  scene.add(mergedMesh);
  try {
    throwIfAborted(signal);
    // A visibility call can mutate fragment state before rejecting. From this
    // point onward, conservatively require an acknowledged show before removal.
    restoreRequired = true;
    await visibility.setVisible(localIds, false);
    throwIfAborted(signal);
  } catch {
    try {
      await dispose();
    } catch {
      // Rollback did not reach the visibility acknowledgement boundary. Hand
      // ownership of the still-mounted replacement to the lifecycle so a
      // stale/aborted apply can retry without leaking or painting a blank frame.
      return activeResult;
    }
    throwIfAborted(signal);
    return { mergedMesh: null, furnishingLocalIds: localIds, dispose: noOpDispose };
  }

  return activeResult;
}
