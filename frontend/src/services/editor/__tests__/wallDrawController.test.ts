import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WallDrawController } from '../wallDrawController';

describe('WallDrawController preview lifecycle', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('coalesces pointer moves and reuses preview GPU resources', () => {
    let queuedFrame: FrameRequestCallback | null = null;
    const requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
      queuedFrame = cb;
      return 1;
    });
    const cancelAnimationFrame = vi.fn(() => { queuedFrame = null; });
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      requestAnimationFrame,
      cancelAnimationFrame,
    });
    const context = {
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      quadraticCurveTo: vi.fn(),
      fill: vi.fn(),
      fillText: vi.fn(),
      fillStyle: '',
      font: '',
      textAlign: '',
      textBaseline: '',
    };
    vi.stubGlobal('document', {
      createElement: vi.fn(() => ({
        width: 0,
        height: 0,
        getContext: () => context,
      })),
    });

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 100);
    camera.position.set(0, 10, 0);
    camera.up.set(0, 0, -1);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const dom = {
      style: { cursor: 'default' },
      getBoundingClientRect: () => ({
        left: 0, top: 0, width: 100, height: 100,
        right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}),
      }),
    };
    const invalidate = vi.fn();
    const controller = new WallDrawController({
      scene,
      dom: dom as never,
      getCamera: () => camera,
      onPreviewChange: invalidate,
    });

    const group = scene.children[0] as THREE.Group;
    const marker = group.children[0] as THREE.Points;
    const line = group.children[1] as THREE.Line;
    const markerGeometry = marker.geometry;
    const markerMaterial = marker.material;
    const lineGeometry = line.geometry;
    const lineMaterial = line.material;
    const disposeMarkerGeometry = vi.spyOn(markerGeometry, 'dispose');
    const disposeLineGeometry = vi.spyOn(lineGeometry, 'dispose');

    controller.arm();
    controller.handleClick(50, 50);
    for (let i = 0; i < 99; i += 1) controller.handlePointerMove(50, 50);
    controller.handlePointerMove(60, 50);

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(queuedFrame).not.toBeNull();
    (queuedFrame as FrameRequestCallback)(0);
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(group.children[0]).toBe(marker);
    expect(group.children[1]).toBe(line);
    expect(marker.geometry).toBe(markerGeometry);
    expect(marker.material).toBe(markerMaterial);
    expect(line.geometry).toBe(lineGeometry);
    expect(line.material).toBe(lineMaterial);
    expect(line.visible).toBe(true);
    expect(Array.from(lineGeometry.getAttribute('position').array)).not.toEqual([0, 0, 0, 0, 0, 0]);

    controller.dispose();
    expect(invalidate).toHaveBeenCalledTimes(3);
    expect(disposeMarkerGeometry).toHaveBeenCalledTimes(1);
    expect(disposeLineGeometry).toHaveBeenCalledTimes(1);
  });
});
