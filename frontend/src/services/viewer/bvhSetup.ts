/**
 * three-mesh-bvh global setup + scene-level BVH computation.
 *
 * Call `installBVH()` once at app boot (before any Three.js raycasting).
 * Call `computeSceneBVH(scene)` after an IFC model is loaded so every
 * BufferGeometry in the scene gets a BVH acceleration structure.
 *
 * Why: THREE.Raycaster.intersectObjects falls back to brute-force triangle
 * tests without BVH.  With BVH patched onto Mesh.prototype the same raycaster
 * call runs an O(log n) tree traversal instead.  For scene-level objects
 * (clip-plane gizmos, snap-dots, measurement helpers, ViewHelper sprites) the
 * speedup is immediate with zero API changes.
 *
 * The @thatopen/components FragmentsModel.raycast() path uses its own async
 * internal pipeline and is unaffected, but any THREE.Raycaster we run
 * ourselves (gizmo picking, clip-plane drag origin, measurement snap) gets
 * the BVH automatically.
 */
import * as THREE from 'three';
import {
  acceleratedRaycast,
  computeBoundsTree,
  disposeBoundsTree,
} from 'three-mesh-bvh';

let _installed = false;

/**
 * Monkey-patch Three.js prototypes for accelerated raycasting.
 * Idempotent - safe to call multiple times.
 */
export function installBVH(): void {
  if (_installed) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (THREE.BufferGeometry.prototype as any).computeBoundsTree = computeBoundsTree;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (THREE.BufferGeometry.prototype as any).disposeBoundsTree = disposeBoundsTree;
  THREE.Mesh.prototype.raycast = acceleratedRaycast;
  _installed = true;
}

/** Returns true once installBVH() has been called. */
export function isBVHInstalled(): boolean {
  return _installed;
}

/**
 * Walk the scene and compute BVH for every BufferGeometry that:
 *   - belongs to a THREE.Mesh (not InstancedMesh - those are managed by @thatopen)
 *   - has at least 3 vertices (non-degenerate)
 *   - does not already have a boundsTree
 *
 * Returns a count of geometries processed.
 */
export function computeSceneBVH(scene: THREE.Object3D): number {
  if (!_installed) installBVH();

  let count = 0;
  scene.traverse((obj) => {
    // Skip InstancedMesh - @thatopen manages those internally.
    if (obj instanceof THREE.InstancedMesh) return;
    if (!(obj instanceof THREE.Mesh)) return;

    const geo = obj.geometry as THREE.BufferGeometry & { boundsTree?: unknown };
    if (!geo?.isBufferGeometry) return;
    if (geo.boundsTree) return;

    const pos = geo.attributes.position;
    if (!pos || pos.count < 3) return;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (geo as any).computeBoundsTree();
      count++;
    } catch {
      // Non-indexed geometries without position data can throw - skip silently.
    }
  });

  return count;
}

/**
 * Dispose BVH from all geometries in the scene to free memory.
 * Call on viewer unmount or model unload.
 */
export function disposeSceneBVH(scene: THREE.Object3D): void {
  scene.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const geo = obj.geometry as THREE.BufferGeometry & { boundsTree?: unknown; disposeBoundsTree?: () => void };
    if (geo?.boundsTree && typeof geo.disposeBoundsTree === 'function') {
      geo.disposeBoundsTree();
    }
  });
}

/**
 * Snapshot BVH coverage in the scene - useful for the performance dashboard.
 *
 * Returns:
 *   - totalMeshes: Mesh count (excluding InstancedMesh)
 *   - bvhMeshes: count with boundsTree
 *   - coveragePct: bvhMeshes / totalMeshes * 100 (0 when totalMeshes === 0)
 */
export function getBVHCoverage(scene: THREE.Object3D): {
  totalMeshes: number;
  bvhMeshes: number;
  coveragePct: number;
} {
  let totalMeshes = 0;
  let bvhMeshes = 0;

  scene.traverse((obj) => {
    if (obj instanceof THREE.InstancedMesh) return;
    if (!(obj instanceof THREE.Mesh)) return;
    totalMeshes++;
    const geo = obj.geometry as THREE.BufferGeometry & { boundsTree?: unknown };
    if (geo?.boundsTree) bvhMeshes++;
  });

  return {
    totalMeshes,
    bvhMeshes,
    coveragePct: totalMeshes === 0 ? 0 : (bvhMeshes / totalMeshes) * 100,
  };
}
