/**
 * Pure math helpers for the two-click wall drawing tool (master-plan B5).
 *
 * Coordinate convention (verified against production code, not assumed)
 * ====================================================================
 *
 * The three.js scene is Y-up; IFC is Z-up. The authoritative mapping already
 * ships in `backend/app/services/bcf_service.py` (used by BCF export/import):
 *
 *     viewer (x, y, z) -> IFC (x, -z, y)   [viewer_to_ifc_coords]
 *     IFC (x, y, z)    -> viewer (x, z, -y) [ifc_to_viewer_coords]
 *
 * and ViewerPanel.tsx confirms the vertical part when aligning the grid:
 * "IFC models are usually exported with their ground at z=0 in IFC space,
 * which maps to y=0 in the viewer's Y-up Three.js scene".
 *
 * So for a point picked on a horizontal work plane at world height y:
 *   IFC x = world.x
 *   IFC y = -world.z
 *   IFC z = world.y  (the storey elevation)
 *
 * Everything here is unit-testable in a plain node environment - no THREE,
 * no DOM.
 */

/** IFC XY pair in metres (the payload `create_wall` expects). */
export type IfcXY = [number, number];

/** Grid snap applied to every picked point. Always on for v1. */
export const GRID_SNAP_M = 0.1;

/**
 * Reject walls shorter than this before calling the backend. Mirrors
 * `MIN_SEGMENT_LENGTH_M` in backend/app/services/element_factory.py so a
 * double-click never round-trips just to get a ValueError back.
 */
export const MIN_WALL_SEGMENT_M = 1e-3;

/** Defaults mirroring backend element_factory.py (DEFAULT_WALL_*). */
export const DEFAULT_WALL_HEIGHT_M = 3.0;
export const DEFAULT_WALL_THICKNESS_M = 0.2;

/** One storey option for the work-plane selector. Elevation is IFC Z metres. */
export interface StoreyOption {
  name: string;
  elevation: number;
}

/** Negate without minting −0 (which would leak into backend JSON). */
function negate(v: number): number {
  return v === 0 ? 0 : -v;
}

/**
 * Convert a world-space point on a horizontal plane to IFC XY metres.
 * Only x/z matter - the plane height is the storey elevation (IFC Z).
 */
export function worldToIfcXY(worldX: number, worldZ: number): IfcXY {
  return [worldX, negate(worldZ)];
}

/**
 * Inverse of {@link worldToIfcXY}: IFC XY -> world [x, z] (for drawing the
 * snapped preview exactly on the grid the backend will receive).
 */
export function ifcXYToWorldXZ(ifcX: number, ifcY: number): [number, number] {
  return [ifcX, negate(ifcY)];
}

/**
 * Storey elevation (IFC Z metres) -> world Y for the drawing plane.
 *
 * Best-evidence choice: identity (see module docstring). Known caveat: a
 * model re-based by the fragments engine's `autoCoordinate` setting (large
 * site offsets) would shift world space away from IFC space; v1 accepts
 * that, matching what the BCF exporter already assumes.
 */
export function ifcElevationToWorldY(elevationM: number): number {
  return elevationM;
}

/**
 * Snap a scalar to the nearest multiple of `stepM`. `stepM <= 0` (or
 * non-finite input) returns the value unchanged. The result is cleaned of
 * binary float noise (0.30000000000000004 -> 0.3) so params sent to the
 * backend and shown in labels are exact.
 */
export function snapValue(value: number, stepM: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(stepM) || stepM <= 0) return value;
  // Clean the quotient before rounding: 0.15 / 0.1 is 1.4999999999999998 in
  // IEEE754, which would round DOWN; 9 decimals restores the intended 1.5
  // without disturbing genuinely-near values.
  const quotient = Number((value / stepM).toFixed(9));
  const snapped = Math.round(quotient) * stepM;
  // 6 decimals is far below GRID_SNAP_M yet enough to erase IEEE noise.
  return Number(snapped.toFixed(6));
}

/** Snap an IFC XY point onto the drawing grid. */
export function snapIfcXY(point: IfcXY, stepM: number = GRID_SNAP_M): IfcXY {
  return [snapValue(point[0], stepM), snapValue(point[1], stepM)];
}

/** Euclidean length in metres between two IFC XY points. */
export function wallLengthM(start: IfcXY, end: IfcXY): number {
  return Math.hypot(end[0] - start[0], end[1] - start[1]);
}

/** Display string for the live length label, e.g. "3.40 m". */
export function formatWallLength(lengthM: number): string {
  return `${lengthM.toFixed(2)} m`;
}

/**
 * Pick the default work plane: the lowest-elevation storey. Deterministic
 * (first wins on ties) and mirrors the backend's `find_storey` default so
 * the preview plane matches where an unnamed wall would actually land.
 */
export function lowestStorey<T extends StoreyOption>(storeys: readonly T[]): T | null {
  let best: T | null = null;
  for (const s of storeys) {
    if (best === null || s.elevation < best.elevation) best = s;
  }
  return best;
}

/**
 * Parse a height/thickness text-input value. Non-numeric, non-finite, or
 * non-positive input falls back to `fallback`; the result is clamped to a
 * sane band so a stray "3000" (mm habits) cannot create a 3 km wall.
 */
export function parseDimension(
  raw: string,
  fallback: number,
  min: number = 0.01,
  max: number = 100,
): number {
  const v = Number.parseFloat(raw);
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.min(Math.max(v, min), max);
}
