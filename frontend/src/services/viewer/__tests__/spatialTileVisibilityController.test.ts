import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';

import { SpatialTileLodService, type SpatialTileManifest } from '../spatialTileLod';
import { SpatialTileVisibilityController } from '../spatialTileVisibilityController';

function makeController() {
  const manifest: SpatialTileManifest = {
    schemaVersion: 1,
    sourceFingerprint: 'model',
    settingsHash: 'test',
    tiles: [
      {
        id: 'root',
        parentId: null,
        bounds: [-2, -2, -8, 2, 2, 8],
        elements: [],
        lods: [],
      },
      {
        id: 'front',
        parentId: 'root',
        bounds: [-1, -1, -6, 1, 1, -4],
        elements: [{ localId: 1, expressId: 101, elementKey: 'model:1' }],
        lods: [{ level: 0, kind: 'exact', geometricError: 0, contentId: 'front:0' }],
      },
      {
        id: 'behind',
        parentId: 'root',
        bounds: [-1, -1, 4, 1, 1, 6],
        elements: [{ localId: 2, expressId: 102, elementKey: 'model:2' }],
        lods: [{ level: 0, kind: 'exact', geometricError: 0, contentId: 'behind:0' }],
      },
    ],
  };
  return new SpatialTileVisibilityController(new SpatialTileLodService(manifest), { padFraction: 0 });
}

function makeCamera() {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
}

function makeVisibility() {
  return {
    setVisible: vi.fn(async () => {}),
    applyVisibilityDelta: vi.fn(async () => {}),
    clearVisibility: vi.fn(async () => {}),
  };
}

describe('SpatialTileVisibilityController', () => {
  it('hides by one stable visibility delta and never removes geometry', async () => {
    const controller = makeController();
    const visibility = makeVisibility();
    const result = await controller.tick(makeCamera(), visibility, { viewportHeightPx: 800 });

    expect(visibility.applyVisibilityDelta).toHaveBeenCalledWith([2], []);
    expect(result.visibleTileIds).toEqual(['front']);
    expect(result.hiddenTileCount).toBe(1);
    expect(result.lodPlan.requests).toEqual([]);
    expect(result.lodPlan.exactPickReady).toBe(true);
  });

  it('uses a show-only navigation pass and defers new hides until idle', async () => {
    const controller = makeController();
    const visibility = makeVisibility();
    const camera = makeCamera();
    await controller.tick(camera, visibility);
    visibility.applyVisibilityDelta.mockClear();
    visibility.setVisible.mockClear();

    camera.lookAt(0, 0, 1);
    camera.updateMatrixWorld(true);
    const moving = await controller.showPass(camera, visibility);

    expect(visibility.setVisible).toHaveBeenCalledWith([2], true);
    expect(visibility.applyVisibilityDelta).not.toHaveBeenCalled();
    expect(moving.newlyHiddenElementCount).toBe(0);

    await controller.tick(camera, visibility);
    expect(visibility.applyVisibilityDelta).toHaveBeenCalledWith([1], []);
  });

  it('pins exact selected geometry even when its tile is outside the frustum', async () => {
    const controller = makeController();
    const visibility = makeVisibility();
    const result = await controller.tick(makeCamera(), visibility, {
      pinnedLocalIds: new Set([2]),
    });

    expect(visibility.applyVisibilityDelta).not.toHaveBeenCalled();
    expect(result.lodPlan.exactPickReady).toBe(true);
    expect(result.visibleTileIds).toEqual(['front', 'behind']);
  });

  it('does not send steady-state visible tile IDs through the reveal target', async () => {
    const controller = makeController();
    const visibility = makeVisibility();
    const result = await controller.showPass(makeCamera(), visibility, {
      pinnedLocalIds: new Set([2]),
    });

    expect(result.visibleTileIds).toEqual(['front', 'behind']);
    expect(result.revealedElementCount).toBe(0);
    expect(visibility.setVisible).not.toHaveBeenCalled();
    expect(visibility.applyVisibilityDelta).not.toHaveBeenCalled();
  });

  it('does not advance ownership when a visibility mutation fails', async () => {
    const controller = makeController();
    const visibility = makeVisibility();
    visibility.applyVisibilityDelta.mockRejectedValueOnce(new Error('worker failed'));

    await expect(controller.tick(makeCamera(), visibility)).rejects.toThrow('worker failed');
    expect(controller.getCulledLocalIds()).toEqual([]);

    await controller.tick(makeCamera(), visibility);
    expect(visibility.applyVisibilityDelta).toHaveBeenLastCalledWith([2], []);
    expect(controller.getCulledLocalIds()).toEqual([2]);
  });

  it('reveals a tile whose authoritative hide acknowledgement is still pending', async () => {
    const controller = makeController();
    const camera = makeCamera();
    const hidden = new Set<number>();
    let acknowledge!: () => void;
    const gate = new Promise<void>((resolve) => { acknowledge = resolve; });
    const visibility = {
      setVisible: vi.fn(async (ids: number[] | undefined, visible: boolean) => {
        for (const id of ids ?? []) {
          if (visible) hidden.delete(id);
          else hidden.add(id);
        }
      }),
      applyVisibilityDelta: vi.fn(async (toHide: readonly number[], toShow: readonly number[]) => {
        for (const id of toShow) hidden.delete(id);
        for (const id of toHide) hidden.add(id);
        await gate;
      }),
      clearVisibility: vi.fn(async () => { hidden.clear(); }),
    };

    const pendingHide = controller.tick(camera, visibility);
    await vi.waitFor(() => expect(visibility.applyVisibilityDelta).toHaveBeenCalledTimes(1));
    expect([...hidden]).toEqual([2]);
    expect(controller.getCulledLocalIds()).toEqual([2]);

    camera.lookAt(0, 0, 1);
    camera.updateMatrixWorld(true);
    await controller.showPass(camera, visibility);
    expect(visibility.setVisible).toHaveBeenCalledWith([2], true);
    expect([...hidden]).toEqual([]);

    acknowledge();
    await pendingHide;
    expect(controller.getCulledLocalIds()).toEqual([]);
  });

  it('reveals a hidden selection and clears only its own mask on dispose', async () => {
    const controller = makeController();
    const visibility = makeVisibility();
    await controller.tick(makeCamera(), visibility);
    visibility.setVisible.mockClear();

    await expect(controller.revealLocalIds(new Set([2]), visibility)).resolves.toBe(1);
    expect(visibility.setVisible).toHaveBeenCalledWith([2], true);
    await controller.dispose(visibility);
    expect(visibility.clearVisibility).toHaveBeenCalledTimes(1);
  });
});
