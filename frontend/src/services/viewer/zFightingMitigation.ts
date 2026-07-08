import * as THREE from 'three';

const MATERIAL_SOURCE_KEY = '__ifcAtlasZFightingSourceUuid';
const MATERIAL_UNITS_KEY = '__ifcAtlasZFightingUnits';
const MATERIAL_FACTOR_KEY = '__ifcAtlasZFightingFactor';
const MESH_HOOK_KEY = '__ifcAtlasZFightingHookInstalled';
const VERTEX_BIAS_KEY = '__ifcAtlasVertexZBiasPatched';
const ELEMENT_DEPTH_BIAS_VERSION = 'fragment-depth-v1';
const ELEMENT_DEPTH_BIAS_MARKER = '// ifc-atlas-element-depth-bias';
const ELEMENT_DEPTH_BUCKETS = 251;
const ELEMENT_DEPTH_BIAS_SCALE = '2.0e-7';

export interface ZFightingMitigationOptions {
  /**
   * Number of stable depth buckets assigned across fragment meshes.
   * Keep this bounded so the bias fixes coplanar ties without visible offsets.
   */
  bucketCount?: number;
  /** Constant polygon offset units added to every processed material. */
  baseUnits?: number;
  /** Slope-based polygon offset. Defaults to 0 to avoid edge shimmer. */
  factor?: number;
  /** Multiplier between adjacent buckets - increases minimum separation. */
  bucketStep?: number;
  /** Base renderOrder for model meshes. Overlay tools use much higher values. */
  renderOrderBase?: number;
  /** Include transparent base materials. Defaults off to avoid transparency sorting churn. */
  includeTransparent?: boolean;
}

export interface ZFightingMitigationStats {
  meshCount: number;
  materialSlots: number;
  clonedMaterials: number;
  sharedSourceMaterials: number;
  idAttributeMeshes: number;
  multiElementMeshes: number;
  elementDepthBiasMaterialSlots: number;
  maxUnits: number;
}

type MeshEntry = {
  mesh: THREE.Mesh;
  units: number;
};

const DEFAULTS = {
  bucketCount: 31,
  baseUnits: 8,
  factor: 4,
  bucketStep: 4,
  renderOrderBase: 0,
  includeTransparent: false,
} as const;

/**
 * Repeat-pass tracking.
 *
 * The mitigation is wired to `model.onViewUpdated`, so it re-runs after every
 * fragment flush (hover, click, ghost, settle). The bias itself is sticky:
 * once a material slot is configured nothing changes unless fragments swaps
 * the mesh material (LOD updates), swaps the geometry, or a late
 * `setItemIds()` adds the per-vertex id attribute. Remember what each mesh
 * was processed with so repeat passes reduce to a WeakMap lookup plus
 * reference compares - no bounding-box hashing, no userData writes, no
 * `needsUpdate` churn.
 */
type ProcessedMeshRecord = {
  /** Final refs after processing (clones included). Arrays are copied so in-place slot swaps are detected. */
  material: THREE.Material | THREE.Material[];
  geometry: THREE.BufferGeometry;
  hadIdAttribute: boolean;
};

let processedMeshes = new WeakMap<THREE.Mesh, ProcessedMeshRecord>();
// Offset units seen per material source across passes. Fragments streams
// meshes in incrementally, so a shared material can gain its second
// (clone-forcing) bucket several flushes after the first mesh was processed.
let trackedSourceUnits = new Map<string, Set<number>>();
// Tracking is only valid for one option set; a different set invalidates it.
let trackedOptionsKey: string | null = null;

/** Drop all repeat-pass tracking, e.g. when the fragments model is swapped. */
export function resetFragmentZFightingTracking(): void {
  processedMeshes = new WeakMap();
  trackedSourceUnits = new Map();
  trackedOptionsKey = null;
}

function trackingKey(opts: Required<ZFightingMitigationOptions>, bucketCount: number): string {
  return `${bucketCount}|${opts.baseUnits}|${opts.factor}|${opts.bucketStep}|${opts.renderOrderBase}|${opts.includeTransparent}`;
}

function isMeshProcessed(mesh: THREE.Mesh): boolean {
  const record = processedMeshes.get(mesh);
  if (!record) return false;
  // A geometry swap changes the bucket hash; a late-added id attribute needs
  // the element depth shader patch. Either forces a re-process.
  if (record.geometry !== mesh.geometry) return false;
  if (hasUsableElementIdAttribute(mesh.geometry) !== record.hadIdAttribute) return false;
  const processed = record.material;
  const current = mesh.material;
  if (Array.isArray(processed)) {
    if (!Array.isArray(current) || current.length !== processed.length) return false;
    for (let i = 0; i < processed.length; i++) {
      if (current[i] !== processed[i]) return false;
    }
    return true;
  }
  return current === processed;
}

function rememberProcessedMesh(mesh: THREE.Mesh): void {
  processedMeshes.set(mesh, {
    material: Array.isArray(mesh.material) ? mesh.material.slice() : mesh.material,
    geometry: mesh.geometry,
    hadIdAttribute: hasUsableElementIdAttribute(mesh.geometry),
  });
}

/**
 * Apply stable depth biasing to fragment meshes.
 *
 * IFC authoring tools often export walls, slabs, finishes, and site patches with
 * overlapping or exactly coplanar faces. The parser should preserve that data;
 * the viewer has to make the GPU depth tie deterministic. A single model-wide
 * polygonOffset does not help because both colliding surfaces move together, so
 * this assigns bounded per-mesh offset buckets. Fragments can also batch
 * several IFC elements into one mesh; when a per-vertex element id is present,
 * the shader gets a tiny per-element fragment-depth offset inside the draw call.
 *
 * Safe to call repeatedly (it runs on every `onViewUpdated`): meshes already
 * processed with unchanged refs are skipped via module-level tracking, and the
 * returned stats only count meshes processed by this pass.
 */
export function applyFragmentZFightingMitigation(
  root: THREE.Object3D,
  options: ZFightingMitigationOptions = {},
): ZFightingMitigationStats {
  const opts = { ...DEFAULTS, ...options };
  const bucketCount = Math.max(1, Math.floor(opts.bucketCount));
  const optionsKey = trackingKey(opts, bucketCount);
  if (optionsKey !== trackedOptionsKey) {
    // Different bias parameters invalidate every earlier application.
    resetFragmentZFightingTracking();
    trackedOptionsKey = optionsKey;
  }
  const entries: MeshEntry[] = [];

  root.traverse((obj) => {
    if (!isRenderableMesh(obj)) return;
    // Hot path - this runs after every fragment flush. Meshes processed with
    // unchanged material/geometry refs are already biased; skip them before
    // any bounding-box hashing or userData work.
    if (isMeshProcessed(obj)) return;
    // Combine geometry bounding-box center with mesh uuid so coplanar
    // meshes at distinct XY positions land in different buckets (most
    // wall/slab Z-fights involve surfaces that share a plane but differ
    // in horizontal position). The uuid still feeds in for spatially
    // identical meshes (e.g., instanced fixtures) so they don't collide.
    const units = opts.baseUnits + hashMeshToBucket(obj, bucketCount) * opts.bucketStep;
    entries.push({ mesh: obj, units });
  });

  const touchedSources = new Set<string>();
  for (const entry of entries) {
    for (const material of materialList(entry.mesh.material)) {
      if (!shouldProcessMaterial(material, opts.includeTransparent)) continue;
      const sourceId = getMaterialSourceId(material);
      touchedSources.add(sourceId);
      let units = trackedSourceUnits.get(sourceId);
      if (!units) {
        units = new Set();
        trackedSourceUnits.set(sourceId, units);
      }
      units.add(entry.units);
    }
  }

  const cloneCache = new Map<string, THREE.Material>();
  let materialSlots = 0;
  let clonedMaterials = 0;
  let idAttributeMeshes = 0;
  let multiElementMeshes = 0;
  let elementDepthBiasMaterialSlots = 0;
  let maxUnits = 0;

  for (const entry of entries) {
    const { mesh, units } = entry;
    const hasElementIdAttribute = hasUsableElementIdAttribute(mesh.geometry);
    if (hasElementIdAttribute) idAttributeMeshes += 1;
    if (hasMultipleItemIds(mesh)) multiElementMeshes += 1;
    maxUnits = Math.max(maxUnits, units);
    mesh.renderOrder = opts.renderOrderBase + units;

    const updateMaterial = (material: THREE.Material): THREE.Material => {
      if (!shouldProcessMaterial(material, opts.includeTransparent)) return material;
      materialSlots += 1;

      const sourceId = getMaterialSourceId(material);
      const requiresClone = (trackedSourceUnits.get(sourceId)?.size ?? 0) > 1;
      let target = material;

      if (requiresClone && !hasDepthBias(material, units, opts.factor)) {
        const cacheKey = `${sourceId}:${units}:${opts.factor}`;
        const cached = cloneCache.get(cacheKey);
        if (cached) {
          target = cached;
        } else {
          // @thatopen/fragments LodMaterial throws on clone() because its
          // constructor requires params. Fall back to mutating the shared
          // material via mesh.onBeforeRender - three.js reads polygonOffset
          // state from the material before every draw, so per-mesh values
          // applied in the hook survive even with shared materials.
          let cloned: THREE.Material | null = null;
          try {
            cloned = material.clone();
          } catch {
            cloned = null;
          }
          if (cloned) {
            target = cloned;
            target.userData = {
              ...target.userData,
              [MATERIAL_SOURCE_KEY]: sourceId,
            };
            cloneCache.set(cacheKey, target);
            clonedMaterials += 1;
          } else {
            installPerDrawOffsetHook(entry.mesh, units, opts.factor);
            configureDepthBias(material, units, opts.factor, sourceId);
            return material;
          }
        }
      }

      configureDepthBias(target, units, opts.factor, sourceId);
      return target;
    };

    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map(updateMaterial);
    } else if (mesh.material) {
      mesh.material = updateMaterial(mesh.material);
    }

    // Fragments batches multiple IFC elements per mesh and writes a
    // per-vertex `id` attribute via setItemIds(). Polygon offset can only
    // differentiate between meshes; this gives elements within one draw call
    // distinct depth values.
    if (hasElementIdAttribute) {
      for (const mat of materialList(mesh.material)) {
        if (!shouldProcessMaterial(mat, opts.includeTransparent)) continue;
        if (installElementDepthBias(mat)) elementDepthBiasMaterialSlots += 1;
      }
    }

    // Snapshot the final refs (clones included) so the next pass can skip
    // this mesh with a single WeakMap lookup.
    rememberProcessedMesh(mesh);
  }

  return {
    meshCount: entries.length,
    materialSlots,
    clonedMaterials,
    sharedSourceMaterials: [...touchedSources].filter((id) => (trackedSourceUnits.get(id)?.size ?? 0) > 1).length,
    idAttributeMeshes,
    multiElementMeshes,
    elementDepthBiasMaterialSlots,
    maxUnits,
  };
}

export function hasPendingFragmentZFightingMitigation(
  root: THREE.Object3D,
  options: ZFightingMitigationOptions = {},
): boolean {
  const opts = { ...DEFAULTS, ...options };
  const bucketCount = Math.max(1, Math.floor(opts.bucketCount));
  // The 1 Hz poll calls this with the same options as the apply pass, so a
  // mesh recorded as processed cannot be pending unless a tracked ref
  // changed - which isMeshProcessed detects. Unprocessed meshes still get
  // the full per-material check below.
  const trackingValid = trackingKey(opts, bucketCount) === trackedOptionsKey;
  let pending = false;

  root.traverse((obj) => {
    if (pending || !isRenderableMesh(obj)) return;
    if (trackingValid && isMeshProcessed(obj)) return;
    const units = opts.baseUnits + hashMeshToBucket(obj, bucketCount) * opts.bucketStep;
    const hasElementIdAttribute = hasUsableElementIdAttribute(obj.geometry);

    for (const material of materialList(obj.material)) {
      if (!shouldProcessMaterial(material, opts.includeTransparent)) continue;
      if (!hasDepthBias(material, units, opts.factor) && !hasPerDrawOffsetHook(obj, units, opts.factor)) {
        pending = true;
        return;
      }
      if (hasElementIdAttribute && !hasElementDepthBias(material)) {
        pending = true;
        return;
      }
    }
  });

  return pending;
}

function isRenderableMesh(obj: THREE.Object3D): obj is THREE.Mesh {
  return (obj as THREE.Mesh).isMesh === true && !!(obj as THREE.Mesh).material;
}

function materialList(material: THREE.Material | THREE.Material[]): THREE.Material[] {
  return Array.isArray(material) ? material : [material];
}

function shouldProcessMaterial(material: THREE.Material, includeTransparent: boolean): boolean {
  return includeTransparent || !material.transparent;
}

function getMaterialSourceId(material: THREE.Material): string {
  const existing = material.userData?.[MATERIAL_SOURCE_KEY];
  if (typeof existing === 'string') return existing;
  return material.uuid;
}

function hasDepthBias(material: THREE.Material, units: number, factor: number): boolean {
  return material.polygonOffset === true
    && material.polygonOffsetUnits === units
    && material.polygonOffsetFactor === factor
    && material.userData?.[MATERIAL_UNITS_KEY] === units
    && material.userData?.[MATERIAL_FACTOR_KEY] === factor;
}

function hasPerDrawOffsetHook(mesh: THREE.Mesh, units: number, factor: number): boolean {
  return mesh.userData?.[MESH_HOOK_KEY] === true
    && mesh.userData?.[MATERIAL_UNITS_KEY] === units
    && mesh.userData?.[MATERIAL_FACTOR_KEY] === factor;
}

function configureDepthBias(
  material: THREE.Material,
  units: number,
  factor: number,
  sourceId: string,
): void {
  // Already applied - skip the userData re-spread and `needsUpdate`, which
  // would otherwise force three.js to revalidate the program of every opaque
  // material on every fragment flush.
  if (material.depthTest && hasDepthBias(material, units, factor)) return;
  material.polygonOffset = true;
  material.polygonOffsetFactor = factor;
  material.polygonOffsetUnits = units;
  material.depthTest = true;
  material.userData = {
    ...material.userData,
    [MATERIAL_SOURCE_KEY]: sourceId,
    [MATERIAL_UNITS_KEY]: units,
    [MATERIAL_FACTOR_KEY]: factor,
  };
  material.needsUpdate = true;
}

function hashUuidToBucket(uuid: string, bucketCount: number): number {
  let h = 0;
  for (let i = 0; i < uuid.length; i++) {
    h = (h * 31 + uuid.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % bucketCount;
}

function hashMeshToBucket(mesh: THREE.Mesh, bucketCount: number): number {
  const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
  if (geometry) {
    if (!geometry.boundingBox) {
      try { geometry.computeBoundingBox(); } catch { /* geometry may be disposed */ }
    }
    const bbox = geometry.boundingBox;
    if (bbox) {
      // Quantise the bbox center to mm so floating-point jitter doesn't
      // change the bucket between apply passes (must be stable).
      const cx = Math.round((bbox.min.x + bbox.max.x) * 500);
      const cy = Math.round((bbox.min.y + bbox.max.y) * 500);
      const cz = Math.round((bbox.min.z + bbox.max.z) * 500);
      let h = (cx * 73856093) ^ (cy * 19349663) ^ (cz * 83492791);
      // Mix uuid in so spatially-identical meshes (e.g., instanced fixtures
      // stamped at the same XY) still resolve to different buckets.
      for (let i = 0; i < mesh.uuid.length; i++) {
        h = (h * 31 + mesh.uuid.charCodeAt(i)) | 0;
      }
      return Math.abs(h) % bucketCount;
    }
  }
  return hashUuidToBucket(mesh.uuid, bucketCount);
}

function hasUsableElementIdAttribute(geometry: THREE.BufferGeometry | undefined): boolean {
  const attribute = geometry?.attributes?.id;
  return !!attribute && attribute.itemSize === 1 && attribute.count > 0;
}

function hasMultipleItemIds(mesh: THREE.Mesh): boolean {
  const itemIds = mesh.userData?.itemIds;
  return itemIds instanceof Set && itemIds.size > 1;
}

function hasElementDepthBias(material: THREE.Material): boolean {
  return material.userData?.[VERTEX_BIAS_KEY] === ELEMENT_DEPTH_BIAS_VERSION;
}

function installElementDepthBias(material: THREE.Material): boolean {
  if (hasElementDepthBias(material)) return false;
  const mat = material as THREE.Material & {
    onBeforeCompile?: (shader: ElementDepthShader, renderer: THREE.WebGLRenderer) => void;
    customProgramCacheKey?: () => string;
  };
  const prevOnBeforeCompile = typeof mat.onBeforeCompile === 'function' ? mat.onBeforeCompile.bind(mat) : null;
  const prevCacheKey = typeof mat.customProgramCacheKey === 'function' ? mat.customProgramCacheKey.bind(mat) : null;

  mat.onBeforeCompile = (shader, renderer) => {
    if (prevOnBeforeCompile) prevOnBeforeCompile(shader, renderer);
    patchElementDepthShader(shader);
  };
  mat.customProgramCacheKey = () => `${prevCacheKey ? prevCacheKey() : ''}|ifc-atlas-${ELEMENT_DEPTH_BIAS_VERSION}`;
  material.userData = { ...material.userData, [VERTEX_BIAS_KEY]: ELEMENT_DEPTH_BIAS_VERSION };
  material.needsUpdate = true;
  return true;
}

type ElementDepthShader = {
  vertexShader: string;
  fragmentShader: string;
};

function patchElementDepthShader(shader: ElementDepthShader): void {
  if (shader.vertexShader.includes(ELEMENT_DEPTH_BIAS_MARKER)) return;

  shader.vertexShader = injectShaderHeader(shader.vertexShader, `
attribute float id;
varying float vIfcAtlasElementId;`);
  shader.vertexShader = injectIntoMain(shader.vertexShader, `
      ${ELEMENT_DEPTH_BIAS_MARKER}-vertex
      vIfcAtlasElementId = id;`);

  shader.fragmentShader = injectShaderHeader(shader.fragmentShader, `
varying float vIfcAtlasElementId;`);
  shader.fragmentShader = injectAfterFirstAvailable(
    shader.fragmentShader,
    ['#include <logdepthbuf_fragment>', '#include <clipping_planes_fragment>'],
    `
      ${ELEMENT_DEPTH_BIAS_MARKER}-fragment
      float ifcAtlasElementId = max(0.0, floor(vIfcAtlasElementId + 0.5));
      float ifcAtlasZBucket = mod(ifcAtlasElementId * 97.0, ${ELEMENT_DEPTH_BUCKETS}.0);
      float ifcAtlasDepthBias = ifcAtlasZBucket * ${ELEMENT_DEPTH_BIAS_SCALE};
      #ifdef USE_LOGARITHMIC_DEPTH_BUFFER
      float ifcAtlasBaseDepth = gl_FragDepth;
      #else
      float ifcAtlasBaseDepth = gl_FragCoord.z;
      #endif
      #ifdef USE_REVERSED_DEPTH_BUFFER
      gl_FragDepth = max(0.0, ifcAtlasBaseDepth - ifcAtlasDepthBias);
      #else
      gl_FragDepth = min(1.0, ifcAtlasBaseDepth + ifcAtlasDepthBias);
      #endif`,
  );
}

function injectShaderHeader(src: string, code: string): string {
  const common = '#include <common>';
  if (src.includes(common)) {
    return src.replace(common, `${common}\n${code.trim()}`);
  }
  return `${code.trim()}\n${src}`;
}

function injectIntoMain(src: string, code: string): string {
  return src.replace(/void\s+main\s*\(\s*\)\s*\{/, (match) => `${match}\n${code}`);
}

function injectAfterFirstAvailable(src: string, markers: string[], code: string): string {
  for (const marker of markers) {
    const idx = src.indexOf(marker);
    if (idx === -1) continue;
    const end = idx + marker.length;
    return src.slice(0, end) + '\n' + code + '\n' + src.slice(end);
  }
  return injectIntoMain(src, code);
}

function installPerDrawOffsetHook(mesh: THREE.Mesh, units: number, factor: number): void {
  const existingUnits = mesh.userData?.[MATERIAL_UNITS_KEY];
  const existingFactor = mesh.userData?.[MATERIAL_FACTOR_KEY];
  if (mesh.userData?.[MESH_HOOK_KEY] === true && existingUnits === units && existingFactor === factor) return;

  const prev = typeof mesh.onBeforeRender === 'function' ? mesh.onBeforeRender : null;
  mesh.onBeforeRender = function (renderer, scene, camera, geometry, material, group) {
    if (prev) prev.call(this, renderer, scene, camera, geometry, material, group);
    const mats = Array.isArray(this.material) ? this.material : [this.material];
    for (const m of mats) {
      if (!m) continue;
      m.polygonOffset = true;
      m.polygonOffsetFactor = factor;
      m.polygonOffsetUnits = units;
    }
  };
  mesh.userData = {
    ...mesh.userData,
    [MESH_HOOK_KEY]: true,
    [MATERIAL_UNITS_KEY]: units,
    [MATERIAL_FACTOR_KEY]: factor,
  };
}
