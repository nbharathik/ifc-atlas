import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';

// Stub three-mesh-bvh so the test doesn't require the native extension.
// The mock attaches / removes a sentinel `boundsTree` on the geometry instance
// exactly as the real library does.
vi.mock('three-mesh-bvh', () => ({
  acceleratedRaycast: vi.fn(),
  computeBoundsTree: function (this: THREE.BufferGeometry) {
    (this as unknown as Record<string, unknown>).boundsTree = { _mock: true };
  },
  disposeBoundsTree: function (this: THREE.BufferGeometry) {
    delete (this as unknown as Record<string, unknown>).boundsTree;
  },
}));

import {
  installBVH,
  isBVHInstalled,
  computeSceneBVH,
  disposeSceneBVH,
  getBVHCoverage,
} from '../bvhSetup';

// Install once for the whole suite - idempotent.
installBVH();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMesh(vertexCount = 9): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(new Float32Array(vertexCount), 3),
  );
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
}

// ---------------------------------------------------------------------------

describe('installBVH', () => {
  it('is idempotent - multiple calls stay stable', () => {
    installBVH();
    installBVH();
    expect(isBVHInstalled()).toBe(true);
  });

  it('patches computeBoundsTree onto BufferGeometry.prototype', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((THREE.BufferGeometry.prototype as any).computeBoundsTree).toBeTypeOf('function');
  });

  it('patches disposeBoundsTree onto BufferGeometry.prototype', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((THREE.BufferGeometry.prototype as any).disposeBoundsTree).toBeTypeOf('function');
  });
});

// ---------------------------------------------------------------------------

describe('computeSceneBVH', () => {
  it('computes BVH for a regular Mesh with ≥3 vertices', () => {
    const scene = new THREE.Scene();
    const mesh = makeMesh(9);
    scene.add(mesh);

    const count = computeSceneBVH(scene);
    expect(count).toBeGreaterThanOrEqual(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mesh.geometry as any).boundsTree).toBeDefined();
  });

  it('skips meshes with fewer than 3 vertices', () => {
    const scene = new THREE.Scene();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3)); // 1 vertex
    const mesh = new THREE.Mesh(geo);
    scene.add(mesh);

    const before = computeSceneBVH(new THREE.Scene()); // empty → 0
    expect(before).toBe(0);

    // Mesh with 1 vertex should be skipped
    const count = computeSceneBVH(scene);
    expect(count).toBe(0);
  });

  it('skips InstancedMesh', () => {
    const scene = new THREE.Scene();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(9), 3));
    const im = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial(), 4);
    scene.add(im);

    const count = computeSceneBVH(scene);
    expect(count).toBe(0);
  });

  it('skips geometries that already have a boundsTree', () => {
    const scene = new THREE.Scene();
    const mesh = makeMesh(9);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mesh.geometry as any).boundsTree = { pre: true };
    scene.add(mesh);

    const count = computeSceneBVH(scene);
    expect(count).toBe(0);
    // Pre-existing boundsTree must be untouched
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mesh.geometry as any).boundsTree.pre).toBe(true);
  });

  it('returns total count for nested scenes', () => {
    const scene = new THREE.Scene();
    const group = new THREE.Group();
    group.add(makeMesh(9));
    group.add(makeMesh(9));
    scene.add(group);
    scene.add(makeMesh(9));

    const count = computeSceneBVH(scene);
    expect(count).toBe(3);
  });
});

// ---------------------------------------------------------------------------

describe('disposeSceneBVH', () => {
  it('removes boundsTree from all geometries', () => {
    const scene = new THREE.Scene();
    const mesh = makeMesh(9);
    scene.add(mesh);
    computeSceneBVH(scene);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mesh.geometry as any).boundsTree).toBeDefined();

    disposeSceneBVH(scene);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mesh.geometry as any).boundsTree).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe('getBVHCoverage', () => {
  it('returns zero coverage for empty scene', () => {
    const cov = getBVHCoverage(new THREE.Scene());
    expect(cov.totalMeshes).toBe(0);
    expect(cov.coveragePct).toBe(0);
  });

  it('returns 100% when all meshes have boundsTree', () => {
    const scene = new THREE.Scene();
    const mesh = makeMesh(9);
    scene.add(mesh);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mesh.geometry as any).boundsTree = { _mock: true };

    const cov = getBVHCoverage(scene);
    expect(cov.coveragePct).toBe(100);
    expect(cov.bvhMeshes).toBe(1);
    expect(cov.totalMeshes).toBe(1);
  });

  it('returns partial coverage when some meshes lack boundsTree', () => {
    const scene = new THREE.Scene();
    const m1 = makeMesh(9);
    const m2 = makeMesh(9);
    scene.add(m1);
    scene.add(m2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m1.geometry as any).boundsTree = { _mock: true };

    const cov = getBVHCoverage(scene);
    expect(cov.totalMeshes).toBe(2);
    expect(cov.bvhMeshes).toBe(1);
    expect(cov.coveragePct).toBeCloseTo(50);
  });

  it('excludes InstancedMesh from totalMeshes count', () => {
    const scene = new THREE.Scene();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(9), 3));
    const im = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial(), 2);
    scene.add(im);

    const cov = getBVHCoverage(scene);
    expect(cov.totalMeshes).toBe(0);
  });
});
