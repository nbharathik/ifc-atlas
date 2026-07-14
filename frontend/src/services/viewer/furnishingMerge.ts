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
  /** Call to undo the merge: shows originals, removes merged mesh from scene. */
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
    if (this.stopped || enabled === this.desired) return this.queue;

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

    this.stopped = true;
    this.desired = false;
    this.revision += 1;
    this.activeApply?.abort();
    this.emitStateChange();
    this.shutdownPromise = this.enqueueReconcile();
    return this.shutdownPromise;
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

    if (this.current) return;

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
          // Continue reconciliation even if an external visibility API fails.
        }
      }
      await this.runAfterUnmerge();
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
    // Clear first so state observers never treat a result being disposed as
    // current and so a newer desired state cannot reuse it.
    const result = this.current;
    this.current = null;
    this.emitStateChange();
    try {
      await result.dispose();
    } catch {
      // Disposal is best-effort; the queue must remain usable.
    } finally {
      await this.runAfterUnmerge();
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
 * 3. Hides originals via model.setVisible()
 * 4. Adds merged mesh to scene
 *
 * Returns a FurnishingMergeResult with a dispose() to undo everything.
 */
export async function applyFurnishingMerge(
  model: FRAGS.FragmentsModel,
  scene: THREE.Scene,
  signal?: AbortSignal,
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

  let originalsHidden = false;
  try {
    throwIfAborted(signal);
    await model.setVisible(localIds, false);
    originalsHidden = true;
    throwIfAborted(signal);
  } catch {
    // A merged duplicate is unsafe if the originals could not be hidden.
    disposeMergedMesh(scene, mergedMesh);
    try {
      await model.setVisible(localIds, true);
    } catch { /* best-effort rollback */ }
    throwIfAborted(signal);
    return { mergedMesh: null, furnishingLocalIds: localIds, dispose: noOpDispose };
  }

  scene.add(mergedMesh);

  let disposePromise: Promise<void> | null = null;
  const dispose = () => {
    if (disposePromise) return disposePromise;

    // Remove the replacement synchronously before restoring originals so a
    // slow visibility call cannot leave both copies rendered together.
    disposeMergedMesh(scene, mergedMesh);
    disposePromise = (async () => {
      if (!originalsHidden) return;
      originalsHidden = false;
      try {
        await model.setVisible(localIds, true);
      } catch { /* ignore */ }
    })();
    return disposePromise;
  };

  return { mergedMesh, furnishingLocalIds: localIds, dispose };
}
