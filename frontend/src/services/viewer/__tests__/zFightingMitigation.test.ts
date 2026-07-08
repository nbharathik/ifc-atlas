import { beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  applyFragmentZFightingMitigation,
  hasPendingFragmentZFightingMitigation,
  resetFragmentZFightingTracking,
} from '../zFightingMitigation';

type ShaderPatchTarget = {
  vertexShader: string;
  fragmentShader: string;
  uniforms: Record<string, unknown>;
};

function mesh(material: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
}

function elementMesh(material: THREE.Material, ids: number[]): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const values = new Float32Array(geometry.attributes.position.count);
  for (let i = 0; i < values.length; i++) values[i] = ids[i % ids.length];
  geometry.setAttribute('id', new THREE.BufferAttribute(values, 1));
  const result = new THREE.Mesh(geometry, material);
  result.userData.itemIds = new Set(ids);
  return result;
}

describe('applyFragmentZFightingMitigation', () => {
  // Tracking is module-level (it survives across onViewUpdated calls in the
  // viewer); reset it so each test starts from an untracked scene.
  beforeEach(() => {
    resetFragmentZFightingTracking();
  });

  it('assigns bounded per-mesh polygon offsets', () => {
    const root = new THREE.Group();
    const meshes = [
      mesh(new THREE.MeshStandardMaterial()),
      mesh(new THREE.MeshStandardMaterial()),
      mesh(new THREE.MeshStandardMaterial()),
    ];
    meshes.forEach((m) => root.add(m));

    const stats = applyFragmentZFightingMitigation(root, { bucketCount: 2, baseUnits: 1, bucketStep: 1 });

    expect(stats.meshCount).toBe(3);
    expect(stats.materialSlots).toBe(3);
    for (const m of meshes) {
      const mat = m.material as THREE.Material;
      expect(mat.polygonOffset).toBe(true);
      expect(mat.polygonOffsetUnits).toBeGreaterThanOrEqual(1);
      expect(mat.polygonOffsetUnits).toBeLessThanOrEqual(2);
      expect(m.renderOrder).toBe(mat.polygonOffsetUnits);
    }
  });

  it('clones a shared material when meshes need different offsets', () => {
    const root = new THREE.Group();
    const shared = new THREE.MeshStandardMaterial();
    const a = mesh(shared);
    const b = mesh(shared);
    // Force the two meshes into distinct hash buckets so the
    // clone path runs deterministically (uuid hash is otherwise random).
    a.uuid = '00000000-0000-0000-0000-00000000000a';
    b.uuid = '00000000-0000-0000-0000-00000000000b';
    root.add(a, b);

    const stats = applyFragmentZFightingMitigation(root, { bucketCount: 2 });

    expect(stats.sharedSourceMaterials).toBe(1);
    expect(stats.clonedMaterials).toBe(2);
    expect(a.material).not.toBe(shared);
    expect(b.material).not.toBe(shared);
    expect(a.material).not.toBe(b.material);
    expect((a.material as THREE.Material).polygonOffsetUnits).not.toBe(
      (b.material as THREE.Material).polygonOffsetUnits,
    );
  });

  it('falls back to onBeforeRender when material.clone() throws', () => {
    const root = new THREE.Group();
    // Simulate a @thatopen/fragments LodMaterial whose clone() throws.
    class UncloneableMaterial extends THREE.MeshStandardMaterial {
      clone(): this {
        throw new TypeError("Cannot read properties of undefined (reading 'color')");
      }
    }
    const shared = new UncloneableMaterial();
    const a = mesh(shared);
    const b = mesh(shared);
    a.uuid = '00000000-0000-0000-0000-00000000000a';
    b.uuid = '00000000-0000-0000-0000-00000000000b';
    root.add(a, b);

    const stats = applyFragmentZFightingMitigation(root, { bucketCount: 2, baseUnits: 4, factor: 1 });

    expect(stats.clonedMaterials).toBe(0);
    expect(a.material).toBe(shared);
    expect(b.material).toBe(shared);
    expect(typeof a.onBeforeRender).toBe('function');
    expect(typeof b.onBeforeRender).toBe('function');

    // Simulate the renderer calling onBeforeRender - mesh A's hook should
    // mutate the shared material to its per-mesh units, then mesh B's hook
    // overwrites with its own units before B's draw.
    (a.onBeforeRender as Function).call(a, {}, {}, {}, a.geometry, shared, null);
    const aUnits = shared.polygonOffsetUnits;
    (b.onBeforeRender as Function).call(b, {}, {}, {}, b.geometry, shared, null);
    const bUnits = shared.polygonOffsetUnits;
    expect(aUnits).not.toBe(bUnits);
    expect(shared.polygonOffset).toBe(true);
    expect(shared.polygonOffsetFactor).toBe(1);
  });

  it('installs per-element fragment depth bias for fragment id attributes', () => {
    const root = new THREE.Group();
    const material = new THREE.MeshLambertMaterial();
    const m = elementMesh(material, [101, 202]);
    root.add(m);

    const stats = applyFragmentZFightingMitigation(root);
    const shader: ShaderPatchTarget = {
      vertexShader: THREE.ShaderLib.lambert.vertexShader,
      fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
      uniforms: {},
    };

    const compile = material.onBeforeCompile as unknown as (
      shader: ShaderPatchTarget,
      renderer: THREE.WebGLRenderer,
    ) => void;
    compile(shader, {} as THREE.WebGLRenderer);

    expect(stats.idAttributeMeshes).toBe(1);
    expect(stats.multiElementMeshes).toBe(1);
    expect(stats.elementDepthBiasMaterialSlots).toBe(1);
    expect(shader.vertexShader).toContain('attribute float id;');
    expect(shader.vertexShader).toContain('vIfcAtlasElementId = id;');
    expect(shader.fragmentShader).toContain('ifc-atlas-element-depth-bias-fragment');
    expect(shader.fragmentShader).toContain('gl_FragDepth = min(1.0, ifcAtlasBaseDepth + ifcAtlasDepthBias);');
    expect(material.customProgramCacheKey()).toContain('ifc-atlas-fragment-depth-v1');
  });

  it('reports pending mitigation when an id mesh has polygon offset but no element depth bias', () => {
    const root = new THREE.Group();
    const material = new THREE.MeshLambertMaterial();
    const m = elementMesh(material, [1, 2, 3]);
    root.add(m);
    material.polygonOffset = true;
    material.polygonOffsetFactor = 4;
    material.polygonOffsetUnits = 8;
    material.userData.__ifcAtlasZFightingUnits = 8;
    material.userData.__ifcAtlasZFightingFactor = 4;

    expect(hasPendingFragmentZFightingMitigation(root, { bucketCount: 1 })).toBe(true);

    applyFragmentZFightingMitigation(root, { bucketCount: 1 });

    expect(hasPendingFragmentZFightingMitigation(root, { bucketCount: 1 })).toBe(false);
  });

  it('is idempotent for already-biased materials', () => {
    const root = new THREE.Group();
    const a = mesh(new THREE.MeshStandardMaterial());
    const b = mesh(new THREE.MeshStandardMaterial());
    root.add(a, b);

    applyFragmentZFightingMitigation(root);
    const firstA = a.material;
    const firstB = b.material;
    const second = applyFragmentZFightingMitigation(root);

    expect(a.material).toBe(firstA);
    expect(b.material).toBe(firstB);
    expect(second.clonedMaterials).toBe(0);
  });

  it('skips processed meshes on repeat passes without touching materials', () => {
    const root = new THREE.Group();
    const meshes = [
      mesh(new THREE.MeshStandardMaterial()),
      mesh(new THREE.MeshStandardMaterial()),
      mesh(new THREE.MeshStandardMaterial()),
    ];
    meshes.forEach((m) => root.add(m));

    applyFragmentZFightingMitigation(root);
    const before = meshes.map((m) => {
      const mat = m.material as THREE.Material;
      return { mat, version: mat.version, userData: mat.userData };
    });

    const second = applyFragmentZFightingMitigation(root);

    expect(second.meshCount).toBe(0);
    expect(second.materialSlots).toBe(0);
    for (const snapshot of before) {
      // needsUpdate = true bumps material.version; the repeat pass must not.
      expect(snapshot.mat.version).toBe(snapshot.version);
      // configureDepthBias re-spreads userData when it runs; an identical
      // reference proves the already-applied path made zero writes.
      expect(snapshot.mat.userData).toBe(snapshot.userData);
    }
  });

  it('re-processes a mesh after its material reference is swapped', () => {
    const root = new THREE.Group();
    const m = mesh(new THREE.MeshStandardMaterial());
    root.add(m);

    applyFragmentZFightingMitigation(root);
    expect(applyFragmentZFightingMitigation(root).meshCount).toBe(0);

    // Fragments swaps mesh materials during LOD updates - the new material
    // must get its own bias even though the mesh was processed before.
    const replacement = new THREE.MeshStandardMaterial();
    m.material = replacement;
    const stats = applyFragmentZFightingMitigation(root);

    expect(stats.meshCount).toBe(1);
    expect(stats.materialSlots).toBe(1);
    expect(replacement.polygonOffset).toBe(true);
    expect(replacement.polygonOffsetUnits).toBe(m.renderOrder);
  });

  it('re-processes a mesh when one slot of a material array is swapped', () => {
    const root = new THREE.Group();
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [
      new THREE.MeshStandardMaterial(),
      new THREE.MeshStandardMaterial(),
    ]);
    root.add(m);

    applyFragmentZFightingMitigation(root);
    expect(applyFragmentZFightingMitigation(root).meshCount).toBe(0);

    const replacement = new THREE.MeshStandardMaterial();
    (m.material as THREE.Material[])[1] = replacement;
    const stats = applyFragmentZFightingMitigation(root);

    expect(stats.meshCount).toBe(1);
    expect(replacement.polygonOffset).toBe(true);
  });

  it('reports no pending work for processed meshes and pending for new ones', () => {
    const root = new THREE.Group();
    root.add(mesh(new THREE.MeshStandardMaterial()));

    applyFragmentZFightingMitigation(root);
    expect(hasPendingFragmentZFightingMitigation(root)).toBe(false);

    root.add(mesh(new THREE.MeshStandardMaterial()));
    expect(hasPendingFragmentZFightingMitigation(root)).toBe(true);
  });

  it('resetFragmentZFightingTracking forces a full re-process', () => {
    const root = new THREE.Group();
    const m = mesh(new THREE.MeshStandardMaterial());
    root.add(m);

    applyFragmentZFightingMitigation(root);
    expect(applyFragmentZFightingMitigation(root).meshCount).toBe(0);

    resetFragmentZFightingTracking();
    const stats = applyFragmentZFightingMitigation(root);

    expect(stats.meshCount).toBe(1);
    expect(stats.materialSlots).toBe(1);
    expect((m.material as THREE.Material).polygonOffset).toBe(true);
  });

  it('skips transparent materials by default', () => {
    const root = new THREE.Group();
    const transparent = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.4 });
    const m = mesh(transparent);
    root.add(m);

    const stats = applyFragmentZFightingMitigation(root);

    expect(stats.materialSlots).toBe(0);
    expect(transparent.polygonOffset).toBe(false);
  });
});
