import * as THREE from 'three';

/**
 * Returns a clone of `box` with each face padded outward by `factor * fullExtent`.
 *
 * Example: factor=0.1 expands every face by 10 % of the box's own size on that axis,
 * yielding a result box that is 20 % larger per axis than the input.
 *
 * Returns a new THREE.Box3; the input is not mutated.
 */
export function padBox(box: THREE.Box3, factor: number): THREE.Box3 {
  const result = box.clone();
  const size = new THREE.Vector3();
  result.getSize(size);
  const pad = size.multiplyScalar(factor);
  result.min.sub(pad);
  result.max.add(pad);
  return result;
}
