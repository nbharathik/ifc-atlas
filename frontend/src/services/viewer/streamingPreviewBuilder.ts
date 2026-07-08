/**
 * Streaming preview builder.
 *
 * Pure helpers that build `THREE.BufferGeometry` + `THREE.Mesh` instances
 * from decoded streaming-geometry batches and append them to a single
 * shared `THREE.Group`. Extracted from `ViewerPanel.tsx` so the wiring is
 * unit-testable without spinning up a real Three.js scene, and so the
 * caller can swap material strategies (e.g. an instanced material map)
 * without rewriting the consumer callbacks.
 *
 * Architecture invariant honoured: Invariant 1 (frontend owns rendering).
 */

import * as THREE from 'three';

import { colorForIfcType } from '../ifc/nativeGeometry';
import type { DecodedMesh } from './streamingGeometryConsumer';

/**
 * One material per IFC type. Reused across batches so 100 walls share a
 * single `MeshLambertMaterial` and the GPU sees them as one draw-call
 * group when the merger eventually instances them.
 */
export type StreamingMaterialCache = Map<string, THREE.MeshLambertMaterial>;

export function createStreamingMaterialCache(): StreamingMaterialCache {
  return new Map<string, THREE.MeshLambertMaterial>();
}

/**
 * Get-or-create a `MeshLambertMaterial` for an IFC type. The colour is
 * resolved through {@link colorForIfcType} so both the streaming and
 * non-streaming preview paths share the same palette.
 */
export function getOrCreateStreamingMaterial(
  cache: StreamingMaterialCache,
  ifcType: string,
): THREE.MeshLambertMaterial {
  const key = ifcType.toUpperCase();
  let mat = cache.get(key);
  if (!mat) {
    mat = new THREE.MeshLambertMaterial({
      color: colorForIfcType(key),
      side: THREE.DoubleSide,
      transparent: false,
      opacity: 1.0,
    });
    cache.set(key, mat);
  }
  return mat;
}

export interface BatchAppendResult {
  /** Number of meshes successfully appended (skipped malformed entries are not counted). */
  appended: number;
  /** Number of entries skipped due to empty/invalid buffers. */
  skipped: number;
}

/**
 * Append one streaming batch of decoded meshes to a target THREE.Group.
 * Pure side-effect on `group` and `cache`; returns counts for telemetry.
 *
 * Caller owns the `group` lifecycle (adding to scene, disposing) and the
 * `cache` lifecycle (disposing materials on tear-down).
 *
 * Empty entries (no positions or no indices) are silently skipped to
 * match the non-streaming `fetchNativeGeometryPreview` path.
 */
export function appendBatchToGroup(
  group: THREE.Group,
  cache: StreamingMaterialCache,
  decoded: ReadonlyArray<DecodedMesh>,
): BatchAppendResult {
  let appended = 0;
  let skipped = 0;
  for (const d of decoded) {
    if (d.positions.length === 0 || d.indices.length === 0) {
      skipped++;
      continue;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(d.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(d.indices, 1));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, getOrCreateStreamingMaterial(cache, d.ifcType));
    mesh.name = `native-preview-${d.expressId}`;
    mesh.userData = { expressId: d.expressId, ifcType: d.ifcType };
    group.add(mesh);
    appended++;
  }
  return { appended, skipped };
}

/**
 * First-triangle latency measurement helper.
 *
 * Returns the elapsed ms from ``startTs`` to ``now`` when **this** batch is
 * the first one that successfully appended at least one mesh. Returns
 * ``null`` otherwise (no first-triangle yet, or it already happened).
 *
 * Caller pattern:
 *
 * ```ts
 * const ftMs = firstTriangleElapsedMs(startTs, hadFirstTriangle, result, performance.now());
 * if (ftMs !== null) {
 *   hadFirstTriangle = true;
 *   updatePerfMetrics({ firstTriangleMs: ftMs });
 * }
 * ```
 *
 * Pure / deterministic / framework-free; no clocks or store touches. The
 * caller passes ``now`` so unit tests can drive the math with synthetic
 * timestamps.
 */
export function firstTriangleElapsedMs(
  startTs: number,
  alreadyHadFirstTriangle: boolean,
  result: BatchAppendResult,
  now: number,
): number | null {
  if (alreadyHadFirstTriangle) return null;
  if (result.appended <= 0) return null;
  const elapsed = now - startTs;
  // Defensive: clamp negative deltas (clock skew, replay) to 0 so the
  // chip never shows "-12 ms" on edge cases.
  return elapsed < 0 ? 0 : elapsed;
}

/**
 * Tear-down for a streaming preview group. Disposes every mesh geometry
 * and every cached material, then clears the group. Safe to call more
 * than once.
 */
export function disposeStreamingPreview(
  group: THREE.Group,
  cache: StreamingMaterialCache,
): void {
  for (const child of group.children) {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
  }
  for (const mat of cache.values()) mat.dispose();
  cache.clear();
  group.clear();
}
