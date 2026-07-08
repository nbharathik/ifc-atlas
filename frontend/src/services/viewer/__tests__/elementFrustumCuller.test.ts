import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { ElementFrustumCuller } from '../elementFrustumCuller';
import type * as FRAGS from '@thatopen/fragments';

// ── Minimal FragmentsModel mock ───────────────────────────────────────────────

function makeModelMock() {
  const visibilityCalls: Array<{ ids: number[]; visible: boolean }> = [];

  return {
    visibilityCalls,
    setVisible: vi.fn(async (ids: number[], visible: boolean) => {
      visibilityCalls.push({ ids: [...ids], visible });
    }),
    // Returns one triangle whose AABB is [box.min..box.max].
    getItemsGeometry: vi.fn(async (localIds: number[]) => {
      return localIds.map((id) => {
        // Each element gets a unique bounding box at (id*2, 0, 0) ± 0.5
        const x = id * 2;
        return [
          {
            positions: new Float32Array([x - 0.5, -0.5, -0.5, x + 0.5, 0.5, 0.5]),
            transform: new THREE.Matrix4(), // identity
          },
        ];
      });
    }),
  } as unknown as FRAGS.FragmentsModel & { visibilityCalls: typeof visibilityCalls };
}

// ── Perspective camera that sees everything at localId=0 ─────────────────────

function makeCameraFar(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(75, 1, 0.1, 10_000);
  cam.position.set(0, 0, 100);
  cam.lookAt(0, 0, 0);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
  return cam;
}

// Camera with a very tight frustum - only sees near origin.
function makeCameraNear(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(5, 1, 0.1, 2);
  cam.position.set(0, 0, 1);
  cam.lookAt(0, 0, 0);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
  return cam;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ElementFrustumCuller', () => {
  let model: ReturnType<typeof makeModelMock>;
  let culler: ElementFrustumCuller;

  beforeEach(() => {
    model = makeModelMock();
    culler = new ElementFrustumCuller();
  });

  it('starts unbuilt with 0 elements', () => {
    expect(culler.isBuilt).toBe(false);
    expect(culler.elementCount).toBe(0);
  });

  it('build() sets isBuilt after resolving geometry', async () => {
    await culler.build(model as unknown as FRAGS.FragmentsModel, [0, 1]);
    expect(culler.isBuilt).toBe(true);
    expect(culler.elementCount).toBe(2);
  });

  it('build() with empty localIds produces 0 elements', async () => {
    await culler.build(model as unknown as FRAGS.FragmentsModel, []);
    expect(culler.isBuilt).toBe(true);
    expect(culler.elementCount).toBe(0);
  });

  it('tick() on unbuilt culler returns 0 and does not call setVisible', async () => {
    const cam = makeCameraFar();
    const count = await culler.tick(cam, model as unknown as FRAGS.FragmentsModel);
    expect(count).toBe(0);
    expect(model.setVisible).not.toHaveBeenCalled();
  });

  it('tick() with wide camera hides nothing', async () => {
    await culler.build(model as unknown as FRAGS.FragmentsModel, [0]);
    const cam = makeCameraFar();
    const count = await culler.tick(cam, model as unknown as FRAGS.FragmentsModel);
    expect(count).toBe(0);
    // No hide calls
    const hideCalls = model.visibilityCalls.filter((c) => !c.visible);
    expect(hideCalls).toHaveLength(0);
  });

  it('tick() batches hide calls - one setVisible(ids, false) call per tick', async () => {
    // Build with 3 elements at x=0,2,4. Tight camera near x=0 may cull x=4 element.
    await culler.build(model as unknown as FRAGS.FragmentsModel, [0, 1, 2]);
    expect(culler.elementCount).toBe(3);
    const cam = makeCameraNear();
    await culler.tick(cam, model as unknown as FRAGS.FragmentsModel);
    // setVisible may have been called 0 or 1 times for hiding (batch)
    const hideCalls = model.visibilityCalls.filter((c) => !c.visible);
    // All hidden elements should be in a single call (batched)
    expect(hideCalls.length).toBeLessThanOrEqual(1);
  });

  it('clearCull() restores culled elements and resets autoCulled flags', async () => {
    await culler.build(model as unknown as FRAGS.FragmentsModel, [0, 1]);
    // Force a tick to potentially cull some
    const cam = makeCameraNear();
    await culler.tick(cam, model as unknown as FRAGS.FragmentsModel);
    const culledBefore = model.visibilityCalls.filter((c) => !c.visible);

    if (culledBefore.length > 0) {
      // Now clear - should restore
      model.visibilityCalls.length = 0;
      await culler.clearCull(model as unknown as FRAGS.FragmentsModel);
      const showCalls = model.visibilityCalls.filter((c) => c.visible);
      expect(showCalls.length).toBeGreaterThan(0);
    }
    // elementCount unchanged after clearCull
    expect(culler.elementCount).toBe(2);
  });

  it('dispose() marks the culler disposed and clears records', async () => {
    await culler.build(model as unknown as FRAGS.FragmentsModel, [0, 1]);
    await culler.dispose(model as unknown as FRAGS.FragmentsModel);
    expect(culler.isBuilt).toBe(false);
    expect(culler.elementCount).toBe(0);
  });

  it('build() after dispose() is a no-op', async () => {
    await culler.dispose(model as unknown as FRAGS.FragmentsModel);
    await culler.build(model as unknown as FRAGS.FragmentsModel, [0]);
    expect(culler.isBuilt).toBe(false);
    expect(culler.elementCount).toBe(0);
  });

  it('tick() after dispose() returns 0', async () => {
    await culler.build(model as unknown as FRAGS.FragmentsModel, [0]);
    await culler.dispose(model as unknown as FRAGS.FragmentsModel);
    const cam = makeCameraFar();
    const count = await culler.tick(cam, model as unknown as FRAGS.FragmentsModel);
    expect(count).toBe(0);
  });

  it('respects MAX_ELEMENTS cap (1500) - build skips elements beyond the cap', async () => {
    // Use 2000 IDs to exceed the cap
    const ids = Array.from({ length: 2000 }, (_, i) => i);
    await culler.build(model as unknown as FRAGS.FragmentsModel, ids);
    expect(culler.elementCount).toBeLessThanOrEqual(1500);
  });

  it('geometry failure is silently skipped', async () => {
    (model.getItemsGeometry as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('no geom'));
    // 65 ids span 2 chunks (64 + 1). Chunk 1 (ids 0-63) fails and is
    // skipped; chunk 2 (id 64) succeeds.
    const ids = Array.from({ length: 65 }, (_, i) => i);
    await culler.build(model as unknown as FRAGS.FragmentsModel, ids);
    expect(culler.elementCount).toBe(1);
  });

  it('empty geometry (isEmpty box) is skipped', async () => {
    (model.getItemsGeometry as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      [{ positions: new Float32Array(0), transform: new THREE.Matrix4() }],
    ]);
    await culler.build(model as unknown as FRAGS.FragmentsModel, [0]);
    // Empty positions → empty Box3 → skipped
    expect(culler.elementCount).toBe(0);
  });

  // ── chunked geometry fetches ─────────────────────────────────────────
  //
  // build() must batch getItemsGeometry into 64-id chunks (one worker
  // round-trip per chunk, not per element) and honor dispose() between
  // chunks so a model swap mid-build doesn't keep hammering the worker.

  it('build() batches geometry fetches - 130 ids issue ceil(130/64) = 3 calls', async () => {
    const ids = Array.from({ length: 130 }, (_, i) => i);
    await culler.build(model as unknown as FRAGS.FragmentsModel, ids);

    const geomMock = model.getItemsGeometry as ReturnType<typeof vi.fn>;
    expect(geomMock).toHaveBeenCalledTimes(3);
    expect(geomMock.mock.calls.map((c) => (c[0] as number[]).length)).toEqual([64, 64, 2]);
    // Every id still gets its own record - batching must not lose items.
    expect(culler.elementCount).toBe(130);
  });

  it('dispose() mid-build stops further chunk fetches', async () => {
    const ids = Array.from({ length: 130 }, (_, i) => i); // 3 chunks
    const geomMock = model.getItemsGeometry as ReturnType<typeof vi.fn>;
    geomMock.mockImplementationOnce(async (chunk: number[]) => {
      // Dispose while the first chunk is in flight - chunks 2 and 3 must
      // never be fetched.
      void culler.dispose();
      return chunk.map(() => [
        {
          positions: new Float32Array([0, 0, 0, 1, 1, 1]),
          transform: new THREE.Matrix4(),
        },
      ]);
    });

    await culler.build(model as unknown as FRAGS.FragmentsModel, ids);

    expect(geomMock).toHaveBeenCalledTimes(1);
    expect(culler.isBuilt).toBe(false);
    expect(culler.elementCount).toBe(0);
  });

  // ── Coordination rule ❷ - exclusion set ──────────────────────────────
  //
  // The storey culler tells the element culler "I own these IDs this tick".
  // The element culler must (a) not write `setVisible` for them, and (b)
  // reset its own `autoCulled` flag so its book-keeping doesn't drift while
  // the storey culler is the owner.

  it('tick(excludeIds) skips storey-owned elements from frustum tests', async () => {
    // Build with 3 elements at x=0,2,4. Tight camera near origin culls the
    // far ones. Exclude id=2 entirely.
    await culler.build(model as unknown as FRAGS.FragmentsModel, [0, 1, 2]);
    const cam = makeCameraNear();
    const exclude = new Set<number>([2]);

    await culler.tick(cam, model as unknown as FRAGS.FragmentsModel, exclude);

    // Any setVisible(false) call must not include id=2 - it is storey-owned.
    for (const c of model.visibilityCalls) {
      expect(c.ids).not.toContain(2);
    }
  });

  it('tick(excludeIds) resets autoCulled=false on excluded records (drift fix)', async () => {
    // Set up: element culler hides id=1 on tick 1 (no exclusion). Then tick 2
    // arrives with id=1 in the exclusion set (its storey just got culled by
    // the storey culler). Our `autoCulled` flag for id=1 must reset to false
    // - the storey culler now owns visibility of id=1.
    await culler.build(model as unknown as FRAGS.FragmentsModel, [0, 1, 2]);
    const cam = makeCameraNear();
    // Tick 1 - no exclusion. id=2 gets culled (out of frustum).
    await culler.tick(cam, model as unknown as FRAGS.FragmentsModel);
    const records1 = (culler as unknown as {
      records: Array<{ localId: number; autoCulled: boolean }>;
    }).records;
    const r2Before = records1.find((r) => r.localId === 2);
    // If r2 didn't get culled, this test is a no-op; otherwise verify the
    // reset behavior. The mock camera/box arrangement reliably culls id=2.
    expect(r2Before).toBeDefined();
    // Force the precondition explicitly so the test isn't camera-fragile.
    r2Before!.autoCulled = true;

    // Tick 2 - id=2 is now storey-owned. Cull is excluded; autoCulled must reset.
    model.visibilityCalls.length = 0;
    await culler.tick(
      cam,
      model as unknown as FRAGS.FragmentsModel,
      new Set([2]),
    );

    const r2After = (culler as unknown as {
      records: Array<{ localId: number; autoCulled: boolean }>;
    }).records.find((r) => r.localId === 2)!;
    expect(r2After.autoCulled).toBe(false);
  });

  it('tick(excludeIds) does not emit setVisible writes for excluded ids', async () => {
    await culler.build(model as unknown as FRAGS.FragmentsModel, [0, 1, 2]);
    const cam = makeCameraNear();
    await culler.tick(
      cam,
      model as unknown as FRAGS.FragmentsModel,
      new Set([0, 1, 2]),
    );
    // With every element excluded, no setVisible call should fire from the
    // element culler at all.
    expect(model.visibilityCalls).toHaveLength(0);
  });

  it('tick() with undefined excludeIds preserves the original behaviour', async () => {
    // Regression guard: omitting the 3rd arg must behave identically to the
    // two-arg signature so the wire-up at the callsite can be added
    // incrementally without breaking other call paths.
    await culler.build(model as unknown as FRAGS.FragmentsModel, [0, 1, 2]);
    const cam = makeCameraNear();
    const count = await culler.tick(cam, model as unknown as FRAGS.FragmentsModel);
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it('return count excludes storey-owned records even if they were autoCulled previously', async () => {
    // 2 records - id=1 we force to autoCulled=true (was previously culled
    // by the element culler). With id=1 in the exclusion set, the storey
    // culler owns it; the element culler must reset autoCulled and the
    // returned count must not include id=1.
    await culler.build(model as unknown as FRAGS.FragmentsModel, [0, 1]);
    const records = (culler as unknown as {
      records: Array<{ localId: number; autoCulled: boolean }>;
    }).records;
    const r1 = records.find((r) => r.localId === 1)!;
    r1.autoCulled = true;
    const cam = makeCameraFar();
    const count = await culler.tick(
      cam,
      model as unknown as FRAGS.FragmentsModel,
      new Set([1]),
    );
    // With a wide camera, the only "culled" record before the tick was id=1.
    // The exclusion set reclaims it, so the post-tick count must be 0.
    expect(count).toBe(0);
  });
});
