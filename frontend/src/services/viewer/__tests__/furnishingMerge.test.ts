import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  collectFurnishingLocalIds,
  buildMergedFurnishingGeometry,
  applyFurnishingMerge,
} from '../furnishingMerge';

// ---------------------------------------------------------------------------
// Mock @thatopen/fragments FragmentsModel
// ---------------------------------------------------------------------------

function makeMeshData(
  positions: Float32Array,
  indices: Uint16Array,
  transform = new THREE.Matrix4(),
) {
  return { positions, indices, transform };
}

function makeModel(opts: {
  categories?: Record<string, number[]>;
  geometry?: (localIds: number[]) => { positions?: Float32Array; indices?: Uint16Array; transform: THREE.Matrix4 }[][];
  setVisibleError?: boolean;
}) {
  return {
    getItemsOfCategories: vi.fn().mockResolvedValue(opts.categories ?? {}),
    getItemsGeometry: vi.fn().mockImplementation(
      async (ids: number[]) => opts.geometry ? opts.geometry(ids) : ids.map(() => []),
    ),
    setVisible: opts.setVisibleError
      ? vi.fn().mockRejectedValue(new Error('visibility error'))
      : vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------

describe('collectFurnishingLocalIds', () => {
  it('returns local IDs for FURNISHING categories', async () => {
    const model = makeModel({
      categories: { IFCFURNISHINGELEMENT: [10, 20, 30], IFCFURNITURE: [40] },
    });
    const ids = await collectFurnishingLocalIds(model as any);
    expect(ids).toEqual(expect.arrayContaining([10, 20, 30, 40]));
    expect(ids).toHaveLength(4);
  });

  it('returns empty array when no furnishing elements found', async () => {
    const model = makeModel({ categories: { IFCWALL: [1, 2, 3] } });
    const ids = await collectFurnishingLocalIds(model as any);
    expect(ids).toEqual([]);
  });

  it('returns empty array when getItemsOfCategories throws', async () => {
    const model = {
      getItemsOfCategories: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const ids = await collectFurnishingLocalIds(model as any);
    expect(ids).toEqual([]);
  });

  it('caps result at 2000 items', async () => {
    const bigList = Array.from({ length: 3000 }, (_, i) => i);
    const model = makeModel({ categories: { IFCFURNISHINGELEMENT: bigList } });
    const ids = await collectFurnishingLocalIds(model as any);
    expect(ids).toHaveLength(2000);
  });
});

// ---------------------------------------------------------------------------

describe('buildMergedFurnishingGeometry', () => {
  it('returns null for empty local IDs', async () => {
    const model = makeModel({});
    const result = await buildMergedFurnishingGeometry(model as any, []);
    expect(result).toBeNull();
  });

  it('returns null when getItemsGeometry throws', async () => {
    const model = {
      getItemsGeometry: vi.fn().mockRejectedValue(new Error('no geom')),
    };
    const result = await buildMergedFurnishingGeometry(model as any, [1, 2]);
    expect(result).toBeNull();
  });

  it('returns null when all items have no geometry data', async () => {
    const model = makeModel({ geometry: () => [[]] });
    const result = await buildMergedFurnishingGeometry(model as any, [1]);
    expect(result).toBeNull();
  });

  it('returns a merged BufferGeometry for valid mesh data', async () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indices = new Uint16Array([0, 1, 2]);
    const model = makeModel({
      geometry: () => [[makeMeshData(positions, indices)]],
    });
    const result = await buildMergedFurnishingGeometry(model as any, [1]);
    expect(result).not.toBeNull();
    expect(result).toBeInstanceOf(THREE.BufferGeometry);
    expect(result?.getAttribute('position')).toBeDefined();
    result?.dispose();
  });

  it('bakes transform into positions', async () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indices = new Uint16Array([0, 1, 2]);
    const transform = new THREE.Matrix4().makeTranslation(10, 0, 0);
    const model = makeModel({
      geometry: () => [[makeMeshData(positions, indices, transform)]],
    });
    const result = await buildMergedFurnishingGeometry(model as any, [1]);
    expect(result).not.toBeNull();
    const posAttr = result!.getAttribute('position') as THREE.BufferAttribute;
    // First vertex x should be 0 + 10 = 10 after translation
    expect(posAttr.getX(0)).toBeCloseTo(10, 4);
    result!.dispose();
  });
});

// ---------------------------------------------------------------------------

describe('applyFurnishingMerge', () => {
  let scene: THREE.Scene;

  beforeEach(() => {
    scene = new THREE.Scene();
  });

  it('returns empty result when no furnishing elements found', async () => {
    const model = makeModel({ categories: {} });
    const result = await applyFurnishingMerge(model as any, scene);
    expect(result.furnishingLocalIds).toHaveLength(0);
    expect(result.mergedMesh).toBeNull();
    expect(scene.children).toHaveLength(0);
    await result.dispose();
  });

  it('adds merged mesh to scene when geometry is available', async () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indices = new Uint16Array([0, 1, 2]);
    const model = makeModel({
      categories: { IFCFURNISHINGELEMENT: [1] },
      geometry: () => [[makeMeshData(positions, indices)]],
    });
    const result = await applyFurnishingMerge(model as any, scene);
    expect(result.mergedMesh).not.toBeNull();
    expect(scene.children).toContain(result.mergedMesh);
    await result.dispose();
    expect(scene.children).not.toContain(result.mergedMesh);
  });

  it('dispose restores original visibility', async () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indices = new Uint16Array([0, 1, 2]);
    const model = makeModel({
      categories: { IFCFURNISHINGELEMENT: [1, 2] },
      geometry: () => [[makeMeshData(positions, indices)]],
    });
    const result = await applyFurnishingMerge(model as any, scene);
    expect(model.setVisible).toHaveBeenCalledWith([1, 2], false);
    await result.dispose();
    expect(model.setVisible).toHaveBeenCalledWith([1, 2], true);
  });

  it('still hides originals even when geometry fetch fails', async () => {
    const model = {
      getItemsOfCategories: vi.fn().mockResolvedValue({ IFCFURNISHINGELEMENT: [5, 6] }),
      getItemsGeometry: vi.fn().mockRejectedValue(new Error('no geom')),
      setVisible: vi.fn().mockResolvedValue(undefined),
    };
    const result = await applyFurnishingMerge(model as any, scene);
    // Geometry unavailable → no merged mesh, but originals still hidden
    expect(result.mergedMesh).toBeNull();
    expect(model.setVisible).toHaveBeenCalledWith([5, 6], false);
    await result.dispose();
  });

  it('handles setVisible errors gracefully', async () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indices = new Uint16Array([0, 1, 2]);
    const model = makeModel({
      categories: { IFCFURNISHINGELEMENT: [1] },
      geometry: () => [[makeMeshData(positions, indices)]],
      setVisibleError: true,
    });
    // Should not throw even when setVisible errors
    await expect(applyFurnishingMerge(model as any, scene)).resolves.toBeDefined();
  });

  it('merged mesh has raycast no-op (non-selectable)', async () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indices = new Uint16Array([0, 1, 2]);
    const model = makeModel({
      categories: { IFCFURNISHINGELEMENT: [1] },
      geometry: () => [[makeMeshData(positions, indices)]],
    });
    const result = await applyFurnishingMerge(model as any, scene);
    expect(result.mergedMesh).not.toBeNull();
    // raycast should be a no-op function that returns nothing
    const raycaster = new THREE.Raycaster();
    const intersections: THREE.Intersection[] = [];
    result.mergedMesh!.raycast(raycaster, intersections);
    expect(intersections).toHaveLength(0);
    await result.dispose();
  });
});
