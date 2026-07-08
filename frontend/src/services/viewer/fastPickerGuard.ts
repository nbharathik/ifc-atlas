/**
 * Fast miss-guard for GPU color-coded picking.
 *
 * FastModelPicker renders a flat-shaded color-coded frame and reads back one
 * pixel, O(1) regardless of triangle count. We use it to skip the expensive
 * model.raycast() when the cursor is over empty space.
 *
 * Error handling: if getModelAt throws (WebGL context loss, picker disposed
 * mid-frame, etc.) we return a non-null sentinel so callers fall through to
 * the full raycast and preserve existing behavior.
 */

import { Vector2 } from 'three';

/** Minimal structural type: matches OBC.FastModelPicker without importing @thatopen/components. */
export interface FastPickerLike {
  getModelAt(pos?: Vector2): Promise<string | null>;
}

export interface CanvasBoundsLike {
  getBoundingClientRect(): Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>;
}

export interface ClientPoint {
  x: number;
  y: number;
}

/**
 * FastModelPicker expects normalized device coordinates, not raw client
 * pixels. Keep this conversion in one place so click, hover, and context-menu
 * picking agree with @thatopen/components' picker contract.
 */
export function clientPointToNdc(point: ClientPoint, canvas: CanvasBoundsLike): ClientPoint {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return { x: 0, y: 0 };
  }
  const x = ((point.x - rect.left) / rect.width) * 2 - 1;
  const y = -(((point.y - rect.top) / rect.height) * 2 - 1);
  return { x, y };
}

/** Sentinel returned on error: truthy so callers fall through to raycast. */
const PICKER_ERROR_SENTINEL = '__picker_error__';

/**
 * Queries the GPU color-coded picker.
 *
 * @returns model UUID if geometry is under `pos`, `null` for a clear miss,
 *   or a non-null error sentinel when the picker throws.
 */
export async function queryFastPicker(
  picker: FastPickerLike,
  pos: { x: number; y: number },
): Promise<string | null> {
  try {
    return await picker.getModelAt(new Vector2(pos.x, pos.y));
  } catch {
    return PICKER_ERROR_SENTINEL;
  }
}

/** Returns true when the caller should proceed to raycast (hit or error). */
export function shouldRaycast(result: string | null): boolean {
  return result !== null;
}
