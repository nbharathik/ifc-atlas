import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';

import type { DecodedMesh } from '../streamingGeometryConsumer';
import {
  appendBatchToGroup,
  createStreamingMaterialCache,
  disposeStreamingPreview,
  firstTriangleElapsedMs,
  getOrCreateStreamingMaterial,
} from '../streamingPreviewBuilder';

function makeDecoded(
  expressId: number,
  ifcType = 'IFCWALL',
  positions: Float32Array = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: Uint32Array = new Uint32Array([0, 1, 2]),
): DecodedMesh {
  return {
    expressId,
    ifcType,
    name: null,
    positions,
    indices,
    bbox: [0, 0, 0, 1, 1, 1],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// getOrCreateStreamingMaterial / cache
// ─────────────────────────────────────────────────────────────────────────────

describe('getOrCreateStreamingMaterial', () => {
  it('returns the same material instance for repeated lookups of the same type', () => {
    const cache = createStreamingMaterialCache();
    const a = getOrCreateStreamingMaterial(cache, 'IFCWALL');
    const b = getOrCreateStreamingMaterial(cache, 'IFCWALL');
    expect(a).toBe(b);
    expect(cache.size).toBe(1);
  });

  it('normalises ifc-type casing so case-variants share one material', () => {
    const cache = createStreamingMaterialCache();
    const a = getOrCreateStreamingMaterial(cache, 'ifcwall');
    const b = getOrCreateStreamingMaterial(cache, 'IfcWall');
    expect(a).toBe(b);
    expect(cache.size).toBe(1);
  });

  it('creates a separate material per distinct type', () => {
    const cache = createStreamingMaterialCache();
    getOrCreateStreamingMaterial(cache, 'IFCWALL');
    getOrCreateStreamingMaterial(cache, 'IFCSLAB');
    getOrCreateStreamingMaterial(cache, 'IFCDOOR');
    expect(cache.size).toBe(3);
  });

  it('uses MeshLambertMaterial with DoubleSide / opaque defaults', () => {
    const cache = createStreamingMaterialCache();
    const mat = getOrCreateStreamingMaterial(cache, 'IFCWALL');
    expect(mat).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect(mat.side).toBe(THREE.DoubleSide);
    expect(mat.transparent).toBe(false);
    expect(mat.opacity).toBe(1.0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// appendBatchToGroup
// ─────────────────────────────────────────────────────────────────────────────

describe('appendBatchToGroup', () => {
  it('appends one mesh per decoded entry with the correct geometry attributes', () => {
    const group = new THREE.Group();
    const cache = createStreamingMaterialCache();
    const result = appendBatchToGroup(group, cache, [makeDecoded(1), makeDecoded(2)]);
    expect(result.appended).toBe(2);
    expect(result.skipped).toBe(0);
    expect(group.children).toHaveLength(2);

    const mesh = group.children[0] as THREE.Mesh;
    expect(mesh).toBeInstanceOf(THREE.Mesh);
    const geom = mesh.geometry;
    const pos = geom.getAttribute('position');
    expect(pos.count).toBe(3);
    // Index buffer present
    expect(geom.getIndex()?.count).toBe(3);
    // Normals computed via computeVertexNormals
    expect(geom.getAttribute('normal')).toBeDefined();
  });

  it('skips entries with empty positions or empty indices and reports counts', () => {
    const group = new THREE.Group();
    const cache = createStreamingMaterialCache();
    const result = appendBatchToGroup(group, cache, [
      makeDecoded(1),
      makeDecoded(2, 'IFCWALL', new Float32Array(), new Uint32Array([0, 1, 2])),
      makeDecoded(3, 'IFCWALL', new Float32Array([0, 0, 0]), new Uint32Array()),
      makeDecoded(4),
    ]);
    expect(result.appended).toBe(2);
    expect(result.skipped).toBe(2);
    expect(group.children).toHaveLength(2);
    expect((group.children[0] as THREE.Mesh).userData.expressId).toBe(1);
    expect((group.children[1] as THREE.Mesh).userData.expressId).toBe(4);
  });

  it('reuses one material per ifc-type across an entire batch (cache size matches distinct types)', () => {
    const group = new THREE.Group();
    const cache = createStreamingMaterialCache();
    appendBatchToGroup(group, cache, [
      makeDecoded(1, 'IFCWALL'),
      makeDecoded(2, 'IFCWALL'),
      makeDecoded(3, 'IFCSLAB'),
      makeDecoded(4, 'IFCWALL'),
    ]);
    expect(cache.size).toBe(2);
    expect((group.children[0] as THREE.Mesh).material).toBe(
      (group.children[1] as THREE.Mesh).material,
    );
    expect((group.children[0] as THREE.Mesh).material).not.toBe(
      (group.children[2] as THREE.Mesh).material,
    );
  });

  it('sets mesh.name and userData fields the picker / select path can read', () => {
    const group = new THREE.Group();
    const cache = createStreamingMaterialCache();
    appendBatchToGroup(group, cache, [makeDecoded(987, 'IFCDOOR')]);
    const mesh = group.children[0] as THREE.Mesh;
    expect(mesh.name).toBe('native-preview-987');
    expect(mesh.userData).toEqual({ expressId: 987, ifcType: 'IFCDOOR' });
  });

  it('appends across multiple invocations to the same group (streaming model)', () => {
    const group = new THREE.Group();
    const cache = createStreamingMaterialCache();
    appendBatchToGroup(group, cache, [makeDecoded(1), makeDecoded(2)]);
    appendBatchToGroup(group, cache, [makeDecoded(3)]);
    expect(group.children).toHaveLength(3);
  });

  it('returns zero counts and leaves the group empty for an empty batch', () => {
    const group = new THREE.Group();
    const cache = createStreamingMaterialCache();
    const result = appendBatchToGroup(group, cache, []);
    expect(result).toEqual({ appended: 0, skipped: 0 });
    expect(group.children).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// disposeStreamingPreview
// ─────────────────────────────────────────────────────────────────────────────

describe('disposeStreamingPreview', () => {
  it('disposes every mesh geometry, every material, and empties the group + cache', () => {
    const group = new THREE.Group();
    const cache = createStreamingMaterialCache();
    appendBatchToGroup(group, cache, [makeDecoded(1, 'IFCWALL'), makeDecoded(2, 'IFCSLAB')]);
    const geoms = group.children.map((c) => (c as THREE.Mesh).geometry);
    const mats = Array.from(cache.values());
    const geomDispose = geoms.map((g) => {
      const spy = vi.fn();
      g.dispose = spy as unknown as typeof g.dispose;
      return spy;
    });
    const matDispose = mats.map((m) => {
      const spy = vi.fn();
      m.dispose = spy as unknown as typeof m.dispose;
      return spy;
    });

    disposeStreamingPreview(group, cache);

    expect(group.children).toHaveLength(0);
    expect(cache.size).toBe(0);
    for (const spy of geomDispose) expect(spy).toHaveBeenCalledTimes(1);
    for (const spy of matDispose) expect(spy).toHaveBeenCalledTimes(1);
  });

  it('is safe to call twice without throwing', () => {
    const group = new THREE.Group();
    const cache = createStreamingMaterialCache();
    appendBatchToGroup(group, cache, [makeDecoded(1)]);
    disposeStreamingPreview(group, cache);
    expect(() => disposeStreamingPreview(group, cache)).not.toThrow();
  });

  it('is a no-op on an already-empty group + cache', () => {
    const group = new THREE.Group();
    const cache = createStreamingMaterialCache();
    expect(() => disposeStreamingPreview(group, cache)).not.toThrow();
    expect(group.children).toHaveLength(0);
    expect(cache.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// firstTriangleElapsedMs
// ---------------------------------------------------------------------------

describe('firstTriangleElapsedMs', () => {
  it('returns elapsed ms on the first batch that appends', () => {
    const result = { appended: 5, skipped: 0 };
    const ms = firstTriangleElapsedMs(1000, false, result, 1234);
    expect(ms).toBe(234);
  });

  it('returns null when no triangles appended in this batch', () => {
    const result = { appended: 0, skipped: 3 };
    const ms = firstTriangleElapsedMs(1000, false, result, 1234);
    expect(ms).toBeNull();
  });

  it('returns null when first triangle already recorded', () => {
    const result = { appended: 10, skipped: 0 };
    const ms = firstTriangleElapsedMs(1000, true, result, 1500);
    expect(ms).toBeNull();
  });

  it('clamps negative deltas to 0 (clock skew defence)', () => {
    const result = { appended: 1, skipped: 0 };
    const ms = firstTriangleElapsedMs(1500, false, result, 1000);
    expect(ms).toBe(0);
  });

  it('returns 0 exactly when now == startTs and a triangle appended', () => {
    const result = { appended: 1, skipped: 0 };
    const ms = firstTriangleElapsedMs(2000, false, result, 2000);
    expect(ms).toBe(0);
  });

  it('handles skip-only-then-append sequence', () => {
    // Batch 1: only skipped entries - no first triangle yet.
    const ms1 = firstTriangleElapsedMs(1000, false, { appended: 0, skipped: 5 }, 1100);
    expect(ms1).toBeNull();
    // Batch 2: first real append → first triangle.
    const ms2 = firstTriangleElapsedMs(1000, false, { appended: 3, skipped: 1 }, 1250);
    expect(ms2).toBe(250);
    // Subsequent batches with `already=true` return null even if appended.
    const ms3 = firstTriangleElapsedMs(1000, true, { appended: 50, skipped: 0 }, 1800);
    expect(ms3).toBeNull();
  });
});

