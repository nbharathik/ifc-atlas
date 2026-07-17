/**
 * Describes every viewer-side override the user has applied to the model, so
 * one control can list and undo them. Pure: callers feed a store snapshot and
 * clear via existing store actions. Not listed: perf cullers (not user
 * intent), persisted settings (preferences, not filters), and plain selection
 * (a cursor; listing it would light the badge on every click, though Reset all
 * still clears it).
 */

import type { ColourByProperty, MeasurementMode } from '../../store/useStore';

export type AppliedFilterId =
  | 'visibility'
  | 'ghost'
  | 'clip-planes'
  | 'section-box'
  | 'colour-by'
  | 'colour-layers'
  | 'highlights'
  | 'measurements'
  | 'measure-mode'
  | 'pick-plane';

export interface AppliedFiltersInput {
  isolatedCount: number;
  hiddenCount: number;
  ghostModeOn: boolean;
  /** Planes with `enabled: true` only - a disabled plane changes nothing. */
  enabledClipPlaneCount: number;
  sectionBoxEnabled: boolean;
  hasSectionWorkspace: boolean;
  colourBy: ColourByProperty;
  colourLayerCount: number;
  highlightedCount: number;
  /** Committed measurements owned by MeasurementController (not the store). */
  measurementCount: number;
  measurementMode: MeasurementMode;
  pickPlaneMode: boolean;
}

export interface AppliedFilter {
  id: AppliedFilterId;
  /** Short noun phrase for the row. */
  label: string;
  /** Concrete count/mode so the row says what it actually did. */
  detail: string;
}

const COLOUR_BY_LABEL: Record<Exclude<ColourByProperty, 'off'>, string> = {
  type: 'IFC type',
  storey: 'Storey',
  material: 'Material',
};

const MEASURE_MODE_LABEL: Record<Exclude<MeasurementMode, 'off'>, string> = {
  linear: 'Distance',
  area: 'Area',
  box: 'Rectangle',
  angle: 'Angle',
  height: 'Height',
  clearance: 'Clearance',
  position: 'Position',
};

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * Every override currently applied, in the order a user would want to undo it
 * (visibility first - it is the most disorienting - then section, then paint,
 * then annotation). Empty array means the model is in its as-loaded state.
 */
export function describeAppliedFilters(input: AppliedFiltersInput): AppliedFilter[] {
  const out: AppliedFilter[] = [];

  // isolatedIds and hiddenIds are mutually exclusive in the store (setting one
  // clears the other), so they are one row, not two.
  if (input.isolatedCount > 0) {
    out.push({
      id: 'visibility',
      label: 'Isolated elements',
      detail: `${plural(input.isolatedCount, 'element')} shown, rest hidden`,
    });
  } else if (input.hiddenCount > 0) {
    out.push({
      id: 'visibility',
      label: 'Hidden elements',
      detail: plural(input.hiddenCount, 'element'),
    });
  }

  // Ghost only reads as "applied" alongside an isolation - on its own it paints
  // nothing (isGhostModeEligible in ghostModeHelpers.ts agrees).
  if (input.ghostModeOn && input.isolatedCount > 0) {
    out.push({ id: 'ghost', label: 'Ghost xray', detail: 'Context shown transparent' });
  }

  if (input.enabledClipPlaneCount > 0) {
    out.push({
      id: 'clip-planes',
      label: 'Section planes',
      detail: plural(input.enabledClipPlaneCount, 'plane'),
    });
  }

  if (input.sectionBoxEnabled || input.hasSectionWorkspace) {
    out.push({
      id: 'section-box',
      label: 'Section box',
      detail: input.sectionBoxEnabled ? 'Cropping the model' : 'Fitted bounds saved',
    });
  }

  if (input.colourBy !== 'off') {
    out.push({
      id: 'colour-by',
      label: 'Colour by',
      detail: COLOUR_BY_LABEL[input.colourBy],
    });
  }

  if (input.colourLayerCount > 0) {
    out.push({
      id: 'colour-layers',
      label: 'Colour overlays',
      detail: plural(input.colourLayerCount, 'layer'),
    });
  }

  if (input.highlightedCount > 0) {
    out.push({
      id: 'highlights',
      label: 'Highlights',
      detail: plural(input.highlightedCount, 'element'),
    });
  }

  if (input.measurementCount > 0) {
    out.push({
      id: 'measurements',
      label: 'Measurements',
      detail: plural(input.measurementCount, 'dimension'),
    });
  }

  if (input.measurementMode !== 'off') {
    out.push({
      id: 'measure-mode',
      label: 'Measure tool',
      detail: `${MEASURE_MODE_LABEL[input.measurementMode]} armed`,
    });
  }

  if (input.pickPlaneMode) {
    out.push({ id: 'pick-plane', label: 'Pick section plane', detail: 'Waiting for a surface click' });
  }

  return out;
}

/** Badge count. 0 means the model is as-loaded and the control can hide. */
export function countAppliedFilters(input: AppliedFiltersInput): number {
  return describeAppliedFilters(input).length;
}
