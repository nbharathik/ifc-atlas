import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { extractStoreyNodes, StoreyFrustumCuller } from '../storeyFrustumCuller';
import type { SpatialNode } from '../../../types/ifc';
import type * as FRAGS from '@thatopen/fragments';
import type { VisibilityMutationTarget } from '../renderStateCoordinator';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(
  id: number,
  ifc_type: string,
  name: string,
  children: SpatialNode[] = [],
): SpatialNode {
  return { id, global_id: `id-${id}`, ifc_type, name, children };
}

function makeTree(): SpatialNode {
  return makeNode(1, 'IfcProject', 'Project', [
    makeNode(2, 'IfcSite', 'Site', [
      makeNode(3, 'IfcBuilding', 'Building', [
        makeNode(10, 'IfcBuildingStorey', 'Ground Floor', [
          makeNode(100, 'IfcWall', 'Wall A', []),
          makeNode(101, 'IfcWall', 'Wall B', []),
        ]),
        makeNode(11, 'IfcBuildingStorey', 'First Floor', [
          makeNode(110, 'IfcSlab', 'Slab', []),
        ]),
        makeNode(12, 'IfcBuildingStorey', 'Second Floor', []),
      ]),
    ]),
  ]);
}

/**
 * Minimal FragmentsModel mock for build() tests. getItem resolves
 * express → local as `expressId + 1000`; getItemsGeometry returns one
 * mesh group per requested id (result parallel to the input array).
 */
function makeModelMock() {
  return {
    setVisible: vi.fn(async () => {}),
    getItem: vi.fn((expressId: number) => ({
      getLocalId: vi.fn(async () => expressId + 1000),
    })),
    getItemsGeometry: vi.fn(async (localIds: number[]) =>
      localIds.map((id) => [
        {
          positions: new Float32Array([id, 0, 0, id + 1, 1, 1]),
          transform: new THREE.Matrix4(), // identity
        },
      ]),
    ),
  } as unknown as FRAGS.FragmentsModel;
}

// ---------------------------------------------------------------------------
// extractStoreyNodes
// ---------------------------------------------------------------------------

describe('extractStoreyNodes', () => {
  it('returns empty array for null root', () => {
    expect(extractStoreyNodes(null)).toEqual([]);
  });

  it('returns empty array when tree has no storeys', () => {
    const root = makeNode(1, 'IfcProject', 'P', [
      makeNode(2, 'IfcSite', 'S', []),
    ]);
    expect(extractStoreyNodes(root)).toHaveLength(0);
  });

  it('extracts all storey nodes from a 3-storey tree', () => {
    const result = extractStoreyNodes(makeTree());
    expect(result).toHaveLength(3);
    expect(result.map((n) => n.id)).toEqual([10, 11, 12]);
  });

  it('extracts storey names correctly', () => {
    const result = extractStoreyNodes(makeTree());
    expect(result[0].name).toBe('Ground Floor');
    expect(result[1].name).toBe('First Floor');
    expect(result[2].name).toBe('Second Floor');
  });

  it('does not include non-storey nodes', () => {
    const result = extractStoreyNodes(makeTree());
    const types = result.map((n) => n.ifc_type.toLowerCase());
    for (const t of types) {
      expect(t).toBe('ifcbuildingstorey');
    }
  });

  it('handles a flat list of storeys at root level', () => {
    const root = makeNode(1, 'IfcProject', 'P', [
      makeNode(10, 'IfcBuildingStorey', 'S1', []),
      makeNode(11, 'IfcBuildingStorey', 'S2', []),
    ]);
    const result = extractStoreyNodes(root);
    expect(result).toHaveLength(2);
  });

  it('does not recurse into storey children for nested-storey models', () => {
    // Degenerate model: storey has another storey as a child.
    const root = makeNode(1, 'IfcProject', 'P', [
      makeNode(10, 'IfcBuildingStorey', 'Parent Storey', [
        makeNode(11, 'IfcBuildingStorey', 'Nested Storey', []),
      ]),
    ]);
    // extractStoreyNodes stops recursion at the first storey level
    const result = extractStoreyNodes(root);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(10);
  });

  it('handles a single-storey model', () => {
    const root = makeNode(1, 'IfcProject', 'P', [
      makeNode(2, 'IfcBuilding', 'B', [
        makeNode(10, 'IfcBuildingStorey', 'Only Floor', [
          makeNode(100, 'IfcWall', 'W', []),
        ]),
      ]),
    ]);
    expect(extractStoreyNodes(root)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// StoreyFrustumCuller.getCulledMemberIds (coordination rule ❷)
// ---------------------------------------------------------------------------
//
// The getter reads `records` directly - it does not require model geometry to
// be built, so we test it by mutating the internal `records` array via a thin
// wrapper. This mirrors the pattern used by the element-culler tests, which
// also bypass `build()` for record-shape verification.

interface StoreyRecord {
  storeyId: number;
  name: string;
  localIds: number[];
  box: unknown;
  autoCulled: boolean;
}

function seedRecords(culler: StoreyFrustumCuller, records: StoreyRecord[]): void {
  // Force `_built = true` and replace records so the getter has data to read.
  // We use the same shape `build()` would produce.
  const internal = culler as unknown as {
    records: StoreyRecord[];
    _built: boolean;
  };
  internal.records = records;
  internal._built = true;
}

describe('StoreyFrustumCuller.getCulledMemberIds', () => {
  it('returns [] before build', () => {
    const culler = new StoreyFrustumCuller();
    expect(culler.getCulledMemberIds()).toEqual([]);
  });

  it('returns [] when all storeys are visible', () => {
    const culler = new StoreyFrustumCuller();
    seedRecords(culler, [
      { storeyId: 1, name: 'A', localIds: [10, 11], box: {}, autoCulled: false },
      { storeyId: 2, name: 'B', localIds: [20, 21], box: {}, autoCulled: false },
    ]);
    expect(culler.getCulledMemberIds()).toEqual([]);
  });

  it('returns local ids of one culled storey', () => {
    const culler = new StoreyFrustumCuller();
    seedRecords(culler, [
      { storeyId: 1, name: 'A', localIds: [10, 11], box: {}, autoCulled: false },
      { storeyId: 2, name: 'B', localIds: [20, 21, 22], box: {}, autoCulled: true },
    ]);
    expect(culler.getCulledMemberIds()).toEqual([20, 21, 22]);
  });

  it('concatenates members across multiple culled storeys in record order', () => {
    const culler = new StoreyFrustumCuller();
    seedRecords(culler, [
      { storeyId: 1, name: 'A', localIds: [10, 11], box: {}, autoCulled: true },
      { storeyId: 2, name: 'B', localIds: [20], box: {}, autoCulled: false },
      { storeyId: 3, name: 'C', localIds: [30, 31], box: {}, autoCulled: true },
    ]);
    expect(culler.getCulledMemberIds()).toEqual([10, 11, 30, 31]);
  });

  it('returns [] after dispose', async () => {
    const culler = new StoreyFrustumCuller();
    seedRecords(culler, [
      { storeyId: 1, name: 'A', localIds: [10, 11], box: {}, autoCulled: true },
    ]);
    expect(culler.getCulledMemberIds()).toEqual([10, 11]);
    await culler.dispose();
    expect(culler.getCulledMemberIds()).toEqual([]);
  });

  it('treats 0 as a real local id (not coerced to empty)', () => {
    const culler = new StoreyFrustumCuller();
    seedRecords(culler, [
      { storeyId: 1, name: 'A', localIds: [0, 1], box: {}, autoCulled: true },
    ]);
    expect(culler.getCulledMemberIds()).toEqual([0, 1]);
  });
});

describe('StoreyFrustumCuller visibility ownership', () => {
  it('ignores a stale hide acknowledgement after ownership is released', async () => {
    const culler = new StoreyFrustumCuller();
    seedRecords(culler, [{
      storeyId: 1,
      name: 'Far storey',
      localIds: [10, 11],
      box: new THREE.Box3(
        new THREE.Vector3(100, 100, 100),
        new THREE.Vector3(101, 101, 101),
      ),
      autoCulled: false,
    }]);
    let acknowledge!: () => void;
    const gate = new Promise<void>((resolve) => { acknowledge = resolve; });
    const target: VisibilityMutationTarget = {
      setVisible: vi.fn(async () => {}),
      applyVisibilityDelta: vi.fn(async () => gate),
      clearVisibility: vi.fn(async () => {}),
    };
    const camera = new THREE.PerspectiveCamera(5, 1, 0.1, 2);
    camera.position.set(0, 0, 1);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    const staleTick = culler.tick(camera, makeModelMock(), target);
    await vi.waitFor(() => expect(target.applyVisibilityDelta).toHaveBeenCalledTimes(1));
    culler.releaseOwnership();
    acknowledge();
    await staleTick;

    expect(culler.getCulledMemberIds()).toEqual([]);
  });

  it('reveals an authoritative storey hide while its acknowledgement is pending', async () => {
    const culler = new StoreyFrustumCuller();
    seedRecords(culler, [{
      storeyId: 1,
      name: 'Far storey',
      localIds: [10, 11],
      box: new THREE.Box3(
        new THREE.Vector3(100, 100, 100),
        new THREE.Vector3(101, 101, 101),
      ),
      autoCulled: false,
    }]);
    const hidden = new Set<number>();
    let acknowledge!: () => void;
    const gate = new Promise<void>((resolve) => { acknowledge = resolve; });
    const target: VisibilityMutationTarget = {
      setVisible: vi.fn(async (ids, visible) => {
        for (const id of ids ?? []) {
          if (visible) hidden.delete(id);
          else hidden.add(id);
        }
      }),
      applyVisibilityDelta: vi.fn(async (toHide, toShow) => {
        for (const id of toShow) hidden.delete(id);
        for (const id of toHide) hidden.add(id);
        await gate;
      }),
      clearVisibility: vi.fn(async () => { hidden.clear(); }),
    };
    const hiddenCamera = new THREE.PerspectiveCamera(5, 1, 0.1, 2);
    hiddenCamera.position.set(0, 0, 1);
    hiddenCamera.lookAt(0, 0, 0);
    hiddenCamera.updateProjectionMatrix();
    hiddenCamera.updateMatrixWorld();
    const visibleCamera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    visibleCamera.position.set(100.5, 100.5, 105);
    visibleCamera.lookAt(100.5, 100.5, 100.5);
    visibleCamera.updateProjectionMatrix();
    visibleCamera.updateMatrixWorld();

    const pendingHide = culler.tick(hiddenCamera, makeModelMock(), target);
    await vi.waitFor(() => expect(target.applyVisibilityDelta).toHaveBeenCalledTimes(1));
    expect([...hidden]).toEqual([10, 11]);
    expect(culler.getCulledMemberIds()).toEqual([10, 11]);

    await culler.showPass(visibleCamera, makeModelMock(), target);
    expect(target.setVisible).toHaveBeenCalledWith([10, 11], true);
    expect([...hidden]).toEqual([]);

    acknowledge();
    await pendingHide;
    expect(culler.getCulledMemberIds()).toEqual([]);
  });

  it('rolls back only the newest failed desired hide and show', async () => {
    const culler = new StoreyFrustumCuller();
    seedRecords(culler, [{
      storeyId: 1,
      name: 'Far storey',
      localIds: [10, 11],
      box: new THREE.Box3(
        new THREE.Vector3(100, 100, 100),
        new THREE.Vector3(101, 101, 101),
      ),
      autoCulled: false,
    }]);
    const hiddenCamera = new THREE.PerspectiveCamera(5, 1, 0.1, 2);
    hiddenCamera.position.set(0, 0, 1);
    hiddenCamera.lookAt(0, 0, 0);
    hiddenCamera.updateProjectionMatrix();
    hiddenCamera.updateMatrixWorld();
    const visibleCamera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    visibleCamera.position.set(100.5, 100.5, 105);
    visibleCamera.lookAt(100.5, 100.5, 100.5);
    visibleCamera.updateProjectionMatrix();
    visibleCamera.updateMatrixWorld();
    const target: VisibilityMutationTarget = {
      setVisible: vi
        .fn<VisibilityMutationTarget['setVisible']>()
        .mockRejectedValueOnce(new Error('show failed'))
        .mockResolvedValue(undefined),
      applyVisibilityDelta: vi
        .fn<NonNullable<VisibilityMutationTarget['applyVisibilityDelta']>>()
        .mockRejectedValueOnce(new Error('hide failed'))
        .mockResolvedValue(undefined),
    };

    expect(await culler.tick(hiddenCamera, makeModelMock(), target)).toBe(0);
    expect(culler.getCulledMemberIds()).toEqual([]);
    expect(await culler.tick(hiddenCamera, makeModelMock(), target)).toBe(1);
    expect(culler.getCulledMemberIds()).toEqual([10, 11]);

    expect(await culler.showPass(visibleCamera, makeModelMock(), target)).toBe(0);
    expect(culler.getCulledMemberIds()).toEqual([10, 11]);
    expect(await culler.showPass(visibleCamera, makeModelMock(), target)).toBe(1);
    expect(culler.getCulledMemberIds()).toEqual([]);
  });

  it('authoritatively clears the target layer with no locally-culled records', async () => {
    const culler = new StoreyFrustumCuller();
    seedRecords(culler, [{
      storeyId: 1,
      name: 'Visible',
      localIds: [10],
      box: new THREE.Box3(),
      autoCulled: false,
    }]);
    const clearVisibility = vi.fn(async () => {});
    const target: VisibilityMutationTarget = {
      setVisible: vi.fn(async () => {}),
      clearVisibility,
    };

    await culler.clearCull(makeModelMock(), target);

    expect(clearVisibility).toHaveBeenCalledTimes(1);
    expect(target.setVisible).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// StoreyFrustumCuller.build - D1 chunked fetches + pre-resolved local ids
// ---------------------------------------------------------------------------

/** Single-storey tree with `count` leaf walls (express ids 1000…1000+count-1). */
function makeWideTree(count: number): { root: SpatialNode; lookup: Map<number, number> } {
  const leaves = Array.from({ length: count }, (_, i) =>
    makeNode(1000 + i, 'IfcWall', `Wall ${i}`),
  );
  const root = makeNode(1, 'IfcProject', 'P', [
    makeNode(10, 'IfcBuildingStorey', 'S', leaves),
  ]);
  // Identity-ish express→local map (local = express, distinct from the
  // mock's +1000 fallback so the two paths are tell-apart-able).
  const lookup = new Map<number, number>(
    leaves.map((n) => [n.id, n.id] as [number, number]),
  );
  return { root, lookup };
}

describe('StoreyFrustumCuller.build', () => {
  it('with localIdLookup performs zero getItem/getLocalId round-trips', async () => {
    const model = makeModelMock();
    const culler = new StoreyFrustumCuller();
    const lookup = new Map<number, number>([
      [100, 1100],
      [101, 1101],
      [110, 1110],
    ]);

    await culler.build(model, extractStoreyNodes(makeTree()), lookup);

    expect(model.getItem).not.toHaveBeenCalled();
    expect(culler.isBuilt).toBe(true);
    expect(culler.storeyCount).toBe(2); // Second Floor has no leaves
    // The lookup-resolved local ids are what the geometry fetch receives.
    const geomMock = model.getItemsGeometry as ReturnType<typeof vi.fn>;
    expect(geomMock.mock.calls.map((c) => c[0])).toEqual([[1100, 1101], [1110]]);
  });

  it('without lookup falls back to per-id getItem().getLocalId() resolution', async () => {
    const model = makeModelMock();
    const culler = new StoreyFrustumCuller();

    await culler.build(model, extractStoreyNodes(makeTree()));

    expect(model.getItem).toHaveBeenCalledTimes(3); // leaves 100, 101, 110
    expect(culler.storeyCount).toBe(2);
    // Fallback-resolved ids (express + 1000) reach the geometry fetch.
    const geomMock = model.getItemsGeometry as ReturnType<typeof vi.fn>;
    expect(geomMock.mock.calls.map((c) => c[0])).toEqual([[1100, 1101], [1110]]);
  });

  it('chunks geometry fetches - a 130-leaf storey issues ceil(130/64) = 3 calls', async () => {
    const { root, lookup } = makeWideTree(130);
    const model = makeModelMock();
    const culler = new StoreyFrustumCuller();

    await culler.build(model, extractStoreyNodes(root), lookup);

    const geomMock = model.getItemsGeometry as ReturnType<typeof vi.fn>;
    expect(geomMock).toHaveBeenCalledTimes(3);
    expect(geomMock.mock.calls.map((c) => (c[0] as number[]).length)).toEqual([64, 64, 2]);
    expect(culler.storeyCount).toBe(1); // chunks accumulate into ONE storey box
  });

  it('dispose() mid-build stops further chunk fetches', async () => {
    const { root, lookup } = makeWideTree(130); // 3 chunks
    const model = makeModelMock();
    const culler = new StoreyFrustumCuller();
    const geomMock = model.getItemsGeometry as ReturnType<typeof vi.fn>;
    geomMock.mockImplementationOnce(async (chunk: number[]) => {
      // Dispose while the first chunk is in flight - chunks 2 and 3 must
      // never be fetched.
      void culler.dispose();
      return chunk.map((id) => [
        {
          positions: new Float32Array([id, 0, 0, id + 1, 1, 1]),
          transform: new THREE.Matrix4(),
        },
      ]);
    });

    await culler.build(model, extractStoreyNodes(root), lookup);

    expect(geomMock).toHaveBeenCalledTimes(1);
    expect(culler.isBuilt).toBe(false);
    expect(culler.storeyCount).toBe(0);
  });
});
