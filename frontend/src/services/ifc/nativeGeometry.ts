/**
 * Native IFC geometry preview.
 *
 * Requests pre-extracted mesh geometry from the backend sidecar, decodes
 * the base64 buffers, and builds THREE.js BufferGeometry meshes that can
 * be added to the scene immediately - before the slow @thatopen/fragments
 * conversion completes.
 *
 * Covers ~40-80 % of elements per model (walls, slabs, columns, beams via
 * IfcExtrudedAreaSolid). Furniture/windows/doors load via the normal path
 * in parallel.
 */

import * as THREE from 'three';
import { apiUrl } from '../../lib/platform';

// ─────────────────────────────────────────────────────────────────────────────
// Types matching the sidecar /geometry response
// ─────────────────────────────────────────────────────────────────────────────

interface MeshEntry {
  expressId: number;
  ifcType: string;
  name: string | null;
  /** base64-encoded Float32Array (XYZ world-space positions) */
  positions: string;
  /** base64-encoded Uint32Array (triangle indices) */
  indices: string;
  /** [minX,minY,minZ,maxX,maxY,maxZ] */
  bbox: number[];
}

interface GeometryResponse {
  meshCount: number;
  attempted: number;
  skipped: number;
  geoElapsedMs: number;
  totalElapsedMs: number;
  meshes: MeshEntry[];
}

// ─────────────────────────────────────────────────────────────────────────────
// IFC-type colour palette
// ─────────────────────────────────────────────────────────────────────────────

const TYPE_COLORS: Record<string, number> = {
  IFCWALL:               0xd4c5a9,
  IFCWALLSTANDARDCASE:   0xd4c5a9,
  IFCWALLTYPE:           0xd4c5a9,
  IFCSLAB:               0xaaaaaa,
  IFCSLABSTANDARDCASE:   0xaaaaaa,
  IFCBEAM:               0x8888bb,
  IFCBEAMSTANDARDCASE:   0x8888bb,
  IFCCOLUMN:             0x9999cc,
  IFCCOLUMNSTANDARDCASE: 0x9999cc,
  IFCROOF:               0x886644,
  IFCSTAIR:              0xbbaa99,
  IFCSTAIRFLIGHT:        0xbbaa99,
  IFCRAMP:               0xbbaa99,
  IFCRAMPFLIGHT:         0xbbaa99,
  IFCCOVERING:           0xccccaa,
  IFCRAILING:            0x888888,
  IFCPLATE:              0x999999,
  IFCMEMBER:             0x9999bb,
  IFCFOOTING:            0x999988,
  IFCPILE:               0x888888,
  IFCCURTAINWALL:        0xaaccdd,
  IFCDOOR:               0xcc9966,
  IFCWINDOW:             0x99ccdd,
  IFCFURNISHINGELEMENT:  0xddbb99,
  DEFAULT:               0x9ca3af,
};

/** Exported so the streaming preview path shares
 *  one palette with the non-streaming path. Single source of truth. */
export function colorForIfcType(ifcType: string): THREE.Color {
  const hex = TYPE_COLORS[ifcType.toUpperCase()] ?? TYPE_COLORS['DEFAULT']!;
  return new THREE.Color(hex);
}

function colorForType(ifcType: string): THREE.Color {
  return colorForIfcType(ifcType);
}

// ─────────────────────────────────────────────────────────────────────────────
// Buffer decode
// ─────────────────────────────────────────────────────────────────────────────

function decodeBase64F32(b64: string): Float32Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

function decodeBase64U32(b64: string): Uint32Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Uint32Array(bytes.buffer);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface NativeGeometryPreview {
  /** THREE.Group added to the scene. Call dispose() when done. */
  group: THREE.Group;
  meshCount: number;
  elapsedMs: number;
  dispose: () => void;
}

/**
 * Fetch mesh geometry from the backend, build THREE.js preview meshes, and
 * return a group ready to add to the scene.
 *
 * This should be called concurrently with the main fragment loading path -
 * do NOT await it before kicking off the sidecar convert. Fire both in
 * parallel so preview meshes appear while the heavy conversion runs.
 *
 * @param ifcBytes  The raw IFC file bytes (same buffer used for fragment load)
 * @param signal    AbortController signal - call when the viewer unmounts or the real model loads
 */
export async function fetchNativeGeometryPreview(
  ifcBytes: Uint8Array,
  signal?: AbortSignal,
): Promise<NativeGeometryPreview | null> {
  try {
    const formData = new FormData();
    const blob = new Blob([ifcBytes], { type: 'application/octet-stream' });
    formData.append('file', blob, 'model.ifc');

    const resp = await fetch(apiUrl('/api/ifc/geometry'), {
      method: 'POST',
      body: formData,
      signal,
    });
    if (!resp.ok) return null;

    const data = (await resp.json()) as GeometryResponse;
    if (!data.meshes || data.meshes.length === 0) return null;

    if (signal?.aborted) return null;

    // Build meshes
    const group = new THREE.Group();
    group.name = 'native-geometry-preview';

    // Shared material per type (keyed by type for instancing potential)
    const matCache = new Map<string, THREE.MeshLambertMaterial>();
    const getMat = (type: string): THREE.MeshLambertMaterial => {
      if (!matCache.has(type)) {
        matCache.set(type, new THREE.MeshLambertMaterial({
          color: colorForType(type),
          side: THREE.DoubleSide,
          transparent: false,
          opacity: 1.0,
        }));
      }
      return matCache.get(type)!;
    };

    for (const entry of data.meshes) {
      if (signal?.aborted) break;
      try {
        const positions = decodeBase64F32(entry.positions);
        const indices = decodeBase64U32(entry.indices);
        if (positions.length === 0 || indices.length === 0) continue;

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));
        geometry.computeVertexNormals();

        const mesh = new THREE.Mesh(geometry, getMat(entry.ifcType));
        mesh.name = `native-preview-${entry.expressId}`;
        mesh.userData = { expressId: entry.expressId, ifcType: entry.ifcType };
        group.add(mesh);
      } catch {
        // Skip malformed entry
      }
    }

    const dispose = () => {
      for (const child of group.children) {
        const mesh = child as THREE.Mesh;
        mesh.geometry?.dispose();
      }
      for (const mat of matCache.values()) mat.dispose();
      group.clear();
    };

    return {
      group,
      meshCount: group.children.length,
      elapsedMs: data.totalElapsedMs,
      dispose,
    };
  } catch {
    return null;
  }
}

/**
 * Remove and dispose a native preview group from the scene gracefully.
 * Safe to call multiple times or with a null/undefined preview.
 */
export function removeNativePreview(
  scene: THREE.Scene,
  preview: NativeGeometryPreview | null | undefined,
): void {
  if (!preview) return;
  scene.remove(preview.group);
  preview.dispose();
}
