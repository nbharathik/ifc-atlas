import * as THREE from 'three';
import type { ClipAxis } from '../../store/useStore';

/**
 * Convert an axis + invert flag to the outward-pointing plane normal.
 *
 * Convention: the normal points into the *kept* half-space - the side of
 * the plane that stays visible after clipping. Defaults ("not inverted"):
 *   y → cut off the top → normal points down (−Y)
 *   x → cut off the +X half → normal points −X
 *   z → cut off the +Z half → normal points −Z
 * Inverting flips the kept side without rebuilding any geometry.
 */
export function axisNormal(axis: ClipAxis, inverted: boolean): THREE.Vector3 {
  const sign = inverted ? 1 : -1;
  switch (axis) {
    case 'x': return new THREE.Vector3(sign, 0, 0);
    case 'y': return new THREE.Vector3(0, sign, 0);
    case 'z': return new THREE.Vector3(0, 0, sign);
  }
}

/**
 * Project a world-space origin point onto the positive axis direction and
 * return the signed scalar distance from a reference centre point.
 *
 * Round-trip safe with axisOriginForOffset:
 *   projectOntoAxis(axis, axisOriginForOffset(axis, centre, d), centre) === d
 */
export function projectOntoAxis(
  axis: ClipAxis,
  origin: THREE.Vector3,
  centre: THREE.Vector3,
): number {
  switch (axis) {
    case 'x': return origin.x - centre.x;
    case 'y': return origin.y - centre.y;
    case 'z': return origin.z - centre.z;
  }
}

/**
 * Return the world-space point at `centre + axis * offset`.
 * Used to position the plane coplanar-point from a scalar offset.
 */
export function axisOriginForOffset(
  axis: ClipAxis,
  centre: THREE.Vector3,
  offset: number,
): THREE.Vector3 {
  const o = centre.clone();
  switch (axis) {
    case 'x': o.x += offset; break;
    case 'y': o.y += offset; break;
    case 'z': o.z += offset; break;
  }
  return o;
}
