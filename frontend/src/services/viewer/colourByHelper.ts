import * as THREE from 'three';
import type { SpatialNode } from '../../types/ifc';
import type { ColourByProperty } from '../../store/useStore';

/** IFC spatial-structure classes excluded from colour grouping. */
const SPATIAL_IFC_TYPES = new Set([
  'IfcProject', 'IfcSite', 'IfcBuilding', 'IfcBuildingStorey', 'IfcSpace',
]);

/**
 * Fixed palette for small group counts (≤ 12) - stable tailwind-family hues.
 *
 * Deliberately excludes the viewer's reserved highlight colours (selection
 * amber 0xf59e0b, hover amber 0xfbbf24, chat cyan 0x00d2ff) so a colour-by
 * group can never read as "selected" or "chat-highlighted". Adjacency is
 * ordered for deuteranopia/protanopia: blue/violet/pink/teal entries
 * interleave the greens (emerald, teal, lime) and the red (rose).
 */
export const PALETTE: THREE.Color[] = [
  new THREE.Color(0x3b82f6), // blue
  new THREE.Color(0x10b981), // emerald
  new THREE.Color(0x8b5cf6), // violet
  new THREE.Color(0xf43f5e), // rose
  new THREE.Color(0x14b8a6), // teal
  new THREE.Color(0xd946ef), // fuchsia
  new THREE.Color(0x84cc16), // lime
  new THREE.Color(0x6366f1), // indigo
  new THREE.Color(0xec4899), // pink
  new THREE.Color(0x38bdf8), // sky
  new THREE.Color(0xa855f7), // purple
  new THREE.Color(0xa8a29e), // stone
];

export interface ColourGroup {
  label: string;
  color: THREE.Color;
  ids: number[];
}

/**
 * Deterministic hash of a string to an HSL colour.
 *
 * Converts the string to a 32-bit integer via djb2 hash then maps to an HSL
 * triple with fixed saturation + lightness so the palette is always readable
 * on dark backgrounds.  Two strings that share the same hash bucket get the
 * same colour - acceptable for colour-by-property where labels are usually
 * unique within a model.
 */
export function hashStringToHSL(s: string): THREE.Color {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return new THREE.Color().setHSL(hue / 360, 0.60, 0.58);
}

/**
 * Choose a colour for a group label.
 *
 * Uses the fixed PALETTE for the first 12 groups (stable, visually distinct)
 * then falls back to `hashStringToHSL` for additional groups so that
 * large property sets (e.g. many material types) still get unique colours.
 */
function groupColor(label: string, sortedIndex: number): THREE.Color {
  return sortedIndex < PALETTE.length
    ? PALETTE[sortedIndex]
    : hashStringToHSL(label);
}

/**
 * Extract a "material family" label from an element name.
 *
 * IFC element names from authoring tools (Revit, ArchiCAD, etc.) often
 * encode the material or type family using colon-separated tokens, e.g.:
 *   "Basic Wall:Concrete Block 200mm:1234567"  → "Concrete Block 200mm"
 *   "Structural Column:Steel Column IPE300:98765" → "Steel Column IPE300"
 *   "Concrete Wall" (no colon) → "Concrete Wall"
 *
 * The heuristic: split on ":", return the second token (index 1) if it
 * exists and is non-trivial (not a plain integer), otherwise the first token.
 */
export function extractNameGroup(name: string): string {
  if (!name || !name.trim()) return 'Unknown';
  const parts = name.split(':');
  if (parts.length >= 2) {
    const mid = parts[1].trim();
    // Reject trivial tokens that are pure integers (Revit instance IDs)
    if (mid && !/^\d+$/.test(mid)) return mid;
  }
  return parts[0].trim() || 'Unknown';
}

/**
 * Walk the spatial tree and group leaf-element express IDs by `property`.
 * Returns an ordered array of groups (largest first for the legend).
 *
 * - `'type'`     - group by IfcType (IfcWall, IfcBeam, …)
 * - `'storey'`   - group by building storey name
 * - `'material'` - group by element name family (heuristic; see extractNameGroup)
 */
export function buildColourGroups(
  root: SpatialNode | null,
  property: Exclude<ColourByProperty, 'off'>,
): ColourGroup[] {
  if (!root) return [];

  const buckets = new Map<string, number[]>();

  function walk(node: SpatialNode, currentStorey: string): void {
    const storey =
      node.ifc_type === 'IfcBuildingStorey' ? node.name : currentStorey;

    if (!SPATIAL_IFC_TYPES.has(node.ifc_type) && node.id) {
      let key: string;
      if (property === 'type') {
        key = node.ifc_type;
      } else if (property === 'storey') {
        key = storey || 'Unknown';
      } else {
        // 'material' - use name-family heuristic
        key = extractNameGroup(node.name || '');
      }
      let arr = buckets.get(key);
      if (!arr) { arr = []; buckets.set(key, arr); }
      arr.push(node.id);
    }

    for (const child of node.children) {
      walk(child, storey);
    }
  }

  walk(root, 'Unknown');

  // Sort labels alphabetically for deterministic colour assignment
  const sorted = [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  return sorted
    .map(([label, ids], i) => ({
      label,
      color: groupColor(label, i),
      ids,
    }))
    .sort((a, b) => b.ids.length - a.ids.length);
}

/** Shorten an IFC type string for display. IfcWallStandardCase → Wall */
export function shortIfcType(ifcType: string): string {
  return ifcType.replace(/^Ifc/, '').replace(/StandardCase$/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
}
