import {
  formatAngle,
  formatArea,
  formatCoordinate,
  formatLength,
  type MeasurementLiveReadout,
  type MeasurementSnapKind,
  type MeasurementUnit,
} from './measurementController';

export interface MeasurementTipContent {
  primary: string | null;
  secondary: string | null;
  hint: string | null;
  snap: { label: string; exact: boolean } | null;
}

const SNAP_LABEL: Record<MeasurementSnapKind, string> = {
  endpoint: 'Endpoint',
  vertex: 'Vertex',
  edge: 'Edge',
  midpoint: 'Midpoint',
  face: 'Face',
  axis: 'Axis',
  centre: 'Centre',
};

const STEP_HINTS: Record<string, string[]> = {
  linear: ['Click start point', 'Click end point'],
  height: ['Click base point', 'Click top point'],
  clearance: ['Pick first face', 'Pick second face'],
  position: ['Click to place a marker'],
  box: ['Click first corner', 'Click opposite corner'],
  area: ['Click first vertex', 'Click next vertex', 'Click next vertex'],
  angle: ['Click the corner point', 'Click first arm end', 'Click second arm end'],
};

function stepHint(mode: string, pendingCount: number): string | null {
  const hints = STEP_HINTS[mode];
  if (!hints) return null;
  return hints[Math.min(pendingCount, hints.length - 1)] ?? null;
}

/** Everything the cursor tip shows, derived from the live readout. Pure. */
export function buildMeasurementTip(
  readout: MeasurementLiveReadout,
  unit: MeasurementUnit,
): MeasurementTipContent | null {
  if (readout.mode === 'off') return null;

  const snap = readout.snapKind
    ? { label: SNAP_LABEL[readout.snapKind], exact: readout.snapExact }
    : null;

  let primary: string | null = null;
  let secondary: string | null = null;

  if (readout.mode === 'angle') {
    if (readout.angleDeg !== null) primary = formatAngle(readout.angleDeg);
  } else if (readout.mode === 'position') {
    if (readout.cursorWorld) primary = formatCoordinate(readout.cursorWorld, unit);
  } else if (readout.mode === 'area' || readout.mode === 'box') {
    if (readout.value !== null) primary = formatArea(readout.value, unit);
    if (readout.perimeter !== null) secondary = formatLength(readout.perimeter, unit);
  } else if (readout.value !== null) {
    primary = formatLength(readout.value, unit);
    if (readout.mode === 'linear' && readout.slopeDeg !== null) {
      secondary = `slope ${formatAngle(readout.slopeDeg)}`;
    }
  }

  return {
    primary,
    secondary,
    hint: primary ? null : stepHint(readout.mode, readout.pendingCount),
    snap,
  };
}
