import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  collectFurnishingLocalIds,
  buildMergedFurnishingGeometry,
  applyFurnishingMerge,
  FurnishingMergeLifecycle,
} from '../furnishingMerge';
import type { FurnishingMergeResult } from '../furnishingMerge';

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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeLifecycleResult(dispose = vi.fn().mockResolvedValue(undefined)): FurnishingMergeResult {
  return {
    mergedMesh: new THREE.Mesh(),
    furnishingLocalIds: [1],
    dispose,
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
    vi.restoreAllMocks();
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

  it('keeps originals visible when replacement geometry is unavailable', async () => {
    const model = {
      getItemsOfCategories: vi.fn().mockResolvedValue({ IFCFURNISHINGELEMENT: [5, 6] }),
      getItemsGeometry: vi.fn().mockRejectedValue(new Error('no geom')),
      setVisible: vi.fn().mockResolvedValue(undefined),
    };
    const result = await applyFurnishingMerge(model as any, scene);
    expect(result.mergedMesh).toBeNull();
    expect(model.setVisible).not.toHaveBeenCalled();
    expect(scene.children).toHaveLength(0);
    await result.dispose();
  });

  it('removes and disposes the merged duplicate when hiding originals fails', async () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indices = new Uint16Array([0, 1, 2]);
    const model = makeModel({
      categories: { IFCFURNISHINGELEMENT: [1] },
      geometry: () => [[makeMeshData(positions, indices)]],
      setVisibleError: true,
    });
    const removeSpy = vi.spyOn(scene, 'remove');
    const geometryDisposeSpy = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');

    const result = await applyFurnishingMerge(model as any, scene);

    expect(result.mergedMesh).toBeNull();
    expect(scene.children).toHaveLength(0);
    expect(removeSpy).toHaveBeenCalledOnce();
    const removedMesh = removeSpy.mock.calls[0][0] as THREE.Mesh;
    expect(geometryDisposeSpy.mock.contexts).toContain(removedMesh.geometry);
    expect(model.setVisible).toHaveBeenCalledWith([1], true);
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

  it('disposes built geometry when aborted during geometry extraction', async () => {
    const geometry = deferred<ReturnType<typeof makeMeshData>[][]>();
    const model = {
      getItemsOfCategories: vi.fn().mockResolvedValue({ IFCFURNISHINGELEMENT: [5] }),
      getItemsGeometry: vi.fn(() => geometry.promise),
      setVisible: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new AbortController();
    const geometryDisposeSpy = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    const applying = applyFurnishingMerge(model as any, scene, controller.signal);
    await vi.waitFor(() => expect(model.getItemsGeometry).toHaveBeenCalledOnce());

    controller.abort();
    geometry.resolve([[
      makeMeshData(
        new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        new Uint16Array([0, 1, 2]),
      ),
    ]]);

    await expect(applying).rejects.toMatchObject({ name: 'AbortError' });
    // One temporary source geometry and the final merged geometry are freed.
    expect(geometryDisposeSpy).toHaveBeenCalledTimes(2);
    expect(model.setVisible).not.toHaveBeenCalled();
    expect(scene.children).toHaveLength(0);
  });

  it('dispose is idempotent and removes the mesh before visibility restore settles', async () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indices = new Uint16Array([0, 1, 2]);
    const restore = deferred<void>();
    const model = makeModel({
      categories: { IFCFURNISHINGELEMENT: [1] },
      geometry: () => [[makeMeshData(positions, indices)]],
    });
    model.setVisible.mockImplementation(async (_ids: number[], visible: boolean) => {
      if (visible) await restore.promise;
    });

    const result = await applyFurnishingMerge(model as any, scene);
    const geometryDispose = vi.spyOn(result.mergedMesh!.geometry, 'dispose');
    const materialDispose = vi.spyOn(result.mergedMesh!.material as THREE.Material, 'dispose');

    const firstDispose = result.dispose();
    const secondDispose = result.dispose();

    expect(secondDispose).toBe(firstDispose);
    expect(scene.children).not.toContain(result.mergedMesh);
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
    expect(model.setVisible).toHaveBeenCalledTimes(2);

    restore.resolve();
    await Promise.all([firstDispose, secondDispose]);
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------

describe('FurnishingMergeLifecycle', () => {
  it('releases the gate when disabled before a queued apply starts', async () => {
    const apply = vi.fn().mockResolvedValue(makeLifecycleResult());
    const lifecycle = new FurnishingMergeLifecycle({ apply });

    const enabling = lifecycle.setDesired(true);
    const disabling = lifecycle.setDesired(false);
    expect(lifecycle.blocksNavigationLod).toBe(true);
    await Promise.all([enabling, disabling]);

    expect(apply).not.toHaveBeenCalled();
    expect(lifecycle.isPending).toBe(false);
    expect(lifecycle.blocksNavigationLod).toBe(false);
  });

  it('releases the gate when shutdown wins before a queued apply starts', async () => {
    const apply = vi.fn().mockResolvedValue(makeLifecycleResult());
    const lifecycle = new FurnishingMergeLifecycle({ apply });

    const enabling = lifecycle.setDesired(true);
    const shutdown = lifecycle.shutdown();
    await Promise.all([enabling, shutdown]);

    expect(apply).not.toHaveBeenCalled();
    expect(lifecycle.isPending).toBe(false);
    expect(lifecycle.blocksNavigationLod).toBe(false);
  });

  it('does not treat a no-op merge result as active replacement geometry', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const afterUnmerge = vi.fn().mockResolvedValue(undefined);
    const apply = vi.fn().mockResolvedValue({
      mergedMesh: null,
      furnishingLocalIds: [1],
      dispose,
    } satisfies FurnishingMergeResult);
    const lifecycle = new FurnishingMergeLifecycle({ apply, afterUnmerge });

    const enabling = lifecycle.setDesired(true);
    expect(lifecycle.blocksNavigationLod).toBe(true);
    await enabling;

    expect(dispose).toHaveBeenCalledOnce();
    expect(afterUnmerge).toHaveBeenCalledOnce();
    expect(lifecycle.currentResult).toBeNull();
    expect(lifecycle.isPending).toBe(false);
    expect(lifecycle.blocksNavigationLod).toBe(false);
  });

  it('disposes a stale result when disabled during a pending apply', async () => {
    const pending = deferred<FurnishingMergeResult>();
    let applySignal: AbortSignal | undefined;
    const apply = vi.fn((signal: AbortSignal) => {
      applySignal = signal;
      return pending.promise;
    });
    const staleDispose = vi.fn().mockResolvedValue(undefined);
    const lifecycle = new FurnishingMergeLifecycle({ apply });

    const enabled = lifecycle.setDesired(true);
    await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
    expect(lifecycle.blocksNavigationLod).toBe(true);

    const disabled = lifecycle.setDesired(false);
    expect(applySignal?.aborted).toBe(true);
    expect(lifecycle.blocksNavigationLod).toBe(true);
    pending.resolve(makeLifecycleResult(staleDispose));

    await Promise.all([enabled, disabled]);
    expect(staleDispose).toHaveBeenCalledOnce();
    expect(lifecycle.currentResult).toBeNull();
    expect(lifecycle.isPending).toBe(false);
    expect(lifecycle.blocksNavigationLod).toBe(false);
  });

  it('honours the latest true state after true-false-true during apply', async () => {
    const first = deferred<FurnishingMergeResult>();
    const second = deferred<FurnishingMergeResult>();
    const signals: AbortSignal[] = [];
    const apply = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return signals.length === 1 ? first.promise : second.promise;
    });
    const staleDispose = vi.fn().mockResolvedValue(undefined);
    const activeResult = makeLifecycleResult();
    const lifecycle = new FurnishingMergeLifecycle({ apply });

    const enableFirst = lifecycle.setDesired(true);
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    const disable = lifecycle.setDesired(false);
    const enableLatest = lifecycle.setDesired(true);
    expect(signals[0].aborted).toBe(true);

    first.resolve(makeLifecycleResult(staleDispose));
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
    expect(staleDispose).toHaveBeenCalledOnce();
    expect(signals[1].aborted).toBe(false);

    second.resolve(activeResult);
    await Promise.all([enableFirst, disable, enableLatest]);
    expect(lifecycle.currentResult).toBe(activeResult);
    expect(lifecycle.blocksNavigationLod).toBe(true);
  });

  it('invalidates and disposes a pending result on shutdown', async () => {
    const pending = deferred<FurnishingMergeResult>();
    let applySignal: AbortSignal | undefined;
    const apply = vi.fn((signal: AbortSignal) => {
      applySignal = signal;
      return pending.promise;
    });
    const staleDispose = vi.fn().mockResolvedValue(undefined);
    const lifecycle = new FurnishingMergeLifecycle({ apply });

    const enabled = lifecycle.setDesired(true);
    await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
    const shutdown = lifecycle.shutdown();
    expect(applySignal?.aborted).toBe(true);
    pending.resolve(makeLifecycleResult(staleDispose));

    await Promise.all([enabled, shutdown]);
    expect(staleDispose).toHaveBeenCalledOnce();
    expect(lifecycle.currentResult).toBeNull();
    expect(lifecycle.blocksNavigationLod).toBe(false);

    await lifecycle.setDesired(true);
    expect(apply).toHaveBeenCalledOnce();
  });

  it('clears current before awaiting disposal and serializes the next apply', async () => {
    const disposal = deferred<void>();
    const repair = deferred<void>();
    const firstDispose = vi.fn(() => disposal.promise);
    const afterUnmerge = vi.fn(() => repair.promise);
    const firstResult = makeLifecycleResult(firstDispose);
    const secondResult = makeLifecycleResult();
    const apply = vi.fn()
      .mockResolvedValueOnce(firstResult)
      .mockResolvedValueOnce(secondResult);
    const lifecycle = new FurnishingMergeLifecycle({ apply, afterUnmerge });

    await lifecycle.setDesired(true);
    expect(lifecycle.currentResult).toBe(firstResult);

    const disable = lifecycle.setDesired(false);
    await vi.waitFor(() => expect(firstDispose).toHaveBeenCalledOnce());
    expect(lifecycle.currentResult).toBeNull();
    expect(lifecycle.isPending).toBe(true);
    expect(lifecycle.blocksNavigationLod).toBe(true);

    const enable = lifecycle.setDesired(true);
    expect(apply).toHaveBeenCalledOnce();
    disposal.resolve();
    await vi.waitFor(() => expect(afterUnmerge).toHaveBeenCalledOnce());
    expect(apply).toHaveBeenCalledOnce();
    repair.resolve();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
    await Promise.all([disable, enable]);
    expect(lifecycle.currentResult).toBe(secondResult);
  });
});
