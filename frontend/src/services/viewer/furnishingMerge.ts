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
): Promise<FurnishingMergeResult> {
  const localIds = await collectFurnishingLocalIds(model);

  const noOpDispose = async () => {};

  if (localIds.length === 0) {
    return { mergedMesh: null, furnishingLocalIds: [], dispose: noOpDispose };
  }

  const geometry = await buildMergedFurnishingGeometry(model, localIds);

  let mergedMesh: THREE.Mesh | null = null;
  if (geometry) {
    const material = new THREE.MeshStandardMaterial({
      color: 0x8a7560,
      flatShading: true,
      roughness: 0.9,
      metalness: 0.0,
    });
    mergedMesh = new THREE.Mesh(geometry, material);
    mergedMesh.name = '__furnishing_merged__';
    // Non-selectable: don't participate in raycasting for element selection
    mergedMesh.raycast = () => {};
    scene.add(mergedMesh);
  }

  // Hide originals in the @thatopen fragment system
  try {
    await model.setVisible(localIds, false);
  } catch {
    // Visibility API unavailable - still return the merged mesh
  }

  const dispose = async () => {
    // Restore originals
    try {
      await model.setVisible(localIds, true);
    } catch { /* ignore */ }
    // Remove merged mesh
    if (mergedMesh) {
      scene.remove(mergedMesh);
      mergedMesh.geometry.dispose();
      (mergedMesh.material as THREE.Material).dispose();
    }
  };

  return { mergedMesh, furnishingLocalIds: localIds, dispose };
}
