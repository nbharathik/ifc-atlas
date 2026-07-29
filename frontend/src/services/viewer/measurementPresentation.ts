import * as THREE from 'three';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import {
  type CommittedMeasurement,
  formatMeasurementValue,
  type MeasurementUnit,
  formatAngle,
  formatArea,
  formatCoordinate,
  formatLength,
  type MeasurementLiveReadout,
  type MeasurementSnapKind,
} from './measurementController';
import { exportFilename } from '../exportFilename';

/**
 * Screen-space dimension labels for committed measurements.
 *
 * Uses Three.js CSS2DRenderer so labels are DOM elements positioned via
 * CSS `transform: translate3d()`, not WebGL sprites. This means:
 *  - Labels always render above the 3D scene (no occlusion by geometry).
 *  - Labels can be styled with CSS (Atlas tokens).
 *  - `pointer-events: none` on the overlay preserves raycasting.
 *
 * Lifecycle: create once when the measurement controller is created, call
 * `setSize` in the ResizeObserver, call `render()` in the animation loop
 * (after the WebGL renderer.render()), and `dispose()` on teardown.
 */
export class MeasurementLabelRenderer {
  private readonly css2dRenderer: CSS2DRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.Camera;
  private readonly labels = new Map<string, CSS2DObject>();
  /** Parallel map of measurement id → the value text span, for O(1) text updates. */
  private readonly labelSpans = new Map<string, { textContent: string | null }>();
  private visible = true;

  constructor(
    scene: THREE.Scene,
    camera: THREE.Camera,
    container: HTMLElement,
    w: number,
    h: number,
  ) {
    this.scene = scene;
    this.camera = camera;

    this.css2dRenderer = new CSS2DRenderer();
    this.css2dRenderer.setSize(w, h);
    const el = this.css2dRenderer.domElement;
    el.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;overflow:hidden;';
    container.appendChild(el);
  }

  /** Must be called whenever the canvas/container resizes. */
  setSize(w: number, h: number): void {
    this.css2dRenderer.setSize(w, h);
  }

  /** Call after each WebGL renderer.render() in the animation loop. */
  render(): void {
    if (!this.visible && this.labels.size === 0) return;
    this.css2dRenderer.render(this.scene, this.camera);
  }

  /** Toggle all label visibility (e.g. `L` shortcut). */
  setVisible(v: boolean): void {
    this.visible = v;
    this.labels.forEach((obj) => { obj.visible = v; });
  }

  isVisible(): boolean { return this.visible; }

  /**
   * Sync the label set to the current committed measurement list.
   * Add labels for new IDs, remove labels for IDs that disappeared.
   */
  syncCommitted(committed: CommittedMeasurement[], unit: MeasurementUnit): void {
    const alive = new Set(committed.map((m) => m.id));

    // Remove stale
    for (const [id, obj] of this.labels) {
      if (!alive.has(id)) {
        this.scene.remove(obj);
        obj.element.remove();
        this.labels.delete(id);
        this.labelSpans.delete(id);
      }
    }

    // Add / update
    for (const m of committed) {
      const text = formatMeasurementValue(m, unit);

      if (this.labels.has(m.id)) {
        // Update text if unit changed - O(1) via stored span ref
        const span = this.labelSpans.get(m.id);
        if (span && span.textContent !== text) span.textContent = text;
      } else {
        const { obj, span } = this.createLabel(m, text);
        this.labels.set(m.id, obj);
        this.labelSpans.set(m.id, span);
        this.scene.add(obj);
        obj.visible = this.visible;
      }
    }
  }

  /** Remove all labels (e.g. after `MeasurementController.clear()`). */
  clearAll(): void {
    for (const [, obj] of this.labels) {
      this.scene.remove(obj);
      obj.element.remove();
    }
    this.labels.clear();
    this.labelSpans.clear();
  }

  /** Remove label for a single measurement id. */
  removeById(id: string): void {
    const obj = this.labels.get(id);
    if (!obj) return;
    this.scene.remove(obj);
    obj.element.remove();
    this.labels.delete(id);
    this.labelSpans.delete(id);
  }

  dispose(): void {
    this.clearAll();
    this.css2dRenderer.domElement.remove();
  }

  // ─── internals ───────────────────────────────────────────────────────────

  private createLabel(m: CommittedMeasurement, text: string): { obj: CSS2DObject; span: HTMLElement } {
    const anchor = labelAnchorWorld(m);

    const div = document.createElement('div');
    div.className = 'measure-label';

    const valueSpan = document.createElement('span');
    valueSpan.className = 'measure-label__value';
    valueSpan.textContent = text;
    div.appendChild(valueSpan);

    // Exact results stay compact; only inferred values carry the GUIDE badge
    // so a field user knows the number is not a snapped construction point.
    // Exactness is fixed at commit time, so the badge never needs syncing.
    if (m.exact === false) {
      const badge = document.createElement('span');
      badge.className = 'measure-label__provenance';
      badge.textContent = 'GUIDE';
      div.appendChild(badge);
    }

    const obj = new CSS2DObject(div);
    obj.center.set(0.5, 0);
    obj.position.copy(anchor);
    return { obj, span: valueSpan };
  }
}

/**
 * Compute the world-space anchor point for a label:
 *  - Linear: midpoint of the segment + 0.1 m Y-lift
 *  - Area: centroid of all vertices + 0.1 m Y-lift
 */
export function labelAnchorWorld(m: CommittedMeasurement): THREE.Vector3 {
  if (
    (m.kind === 'linear' || m.kind === 'height' || m.kind === 'clearance')
    && m.points.length >= 2
  ) {
    return new THREE.Vector3()
      .addVectors(m.points[0], m.points[1])
      .multiplyScalar(0.5)
      .setY(((m.points[0].y + m.points[1].y) / 2) + 0.1);
  }
  // area or fallback: centroid
  const centroid = m.points.reduce(
    (acc, p) => acc.add(p),
    new THREE.Vector3(),
  ).divideScalar(Math.max(m.points.length, 1));
  centroid.y += 0.1;
  return centroid;
}

/** Convert a raw measurement value (metres / m² / degrees) to the display unit's numeric value. */
function toDisplayValue(m: CommittedMeasurement, unit: MeasurementUnit): number {
  if (
    m.kind === 'linear'
    || m.kind === 'height'
    || m.kind === 'clearance'
    || m.kind === 'position'
  ) {
    switch (unit) {
      case 'mm': return m.value * 1000;
      case 'ft': return m.value * 3.28084;
      default:   return m.value;
    }
  }
  if (m.kind === 'angle') return m.value; // degrees, unit-independent
  // area
  switch (unit) {
    case 'mm': return m.value * 1_000_000;
    case 'ft': return m.value * 10.7639;
    default:   return m.value;
  }
}

/** Return the unit label string for the given kind + unit combination. */
function unitLabel(m: CommittedMeasurement, unit: MeasurementUnit): string {
  if (m.kind === 'angle') return 'deg';
  if (m.kind !== 'area') {
    return unit === 'mm' ? 'mm' : unit === 'ft' ? 'ft' : 'm';
  }
  return unit === 'mm' ? 'mm²' : unit === 'ft' ? 'ft²' : 'm²';
}

function csvCell(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/** UTF-8 byte-order mark so Excel decodes non-ASCII unit labels (m²) correctly. */
const UTF8_BOM = String.fromCharCode(0xfeff);

function coordinateValues(
  measurement: CommittedMeasurement,
  unit: MeasurementUnit,
): [string, string, string] {
  if (measurement.kind !== 'position') return ['', '', ''];
  const point = measurement.coordinates?.local ?? measurement.points[0];
  if (!point) return ['', '', ''];
  const factor = unit === 'mm' ? 1000 : unit === 'ft' ? 3.28084 : 1;
  const decimals = unit === 'mm' ? 1 : 3;
  return [point.x, point.y, point.z].map((value) => (value * factor).toFixed(decimals)) as [
    string,
    string,
    string,
  ];
}

/** Serialise committed measurements to CSV text.
 *  The first five columns stay backward-compatible; construction provenance
 *  and position coordinates are appended for lossless round-tripping.
 */
export function measurementsToCsv(
  measurements: CommittedMeasurement[],
  unit: MeasurementUnit,
): string {
  const header = 'index,kind,value,unit,timestamp,x,y,z,coordinate_space,exact,source';
  const rows = measurements.map((m, i) => {
    const num = toDisplayValue(m, unit);
    const decimals = m.kind === 'angle' ? 1 : m.kind === 'area' && unit === 'mm' ? 0 : 3;
    const valueStr = m.kind === 'position' ? '' : num.toFixed(decimals);
    const ts = m.timestamp ?? '';
    const [x, y, z] = coordinateValues(m, unit);
    return [
      String(i + 1),
      m.kind,
      valueStr,
      unitLabel(m, unit),
      csvCell(ts),
      x,
      y,
      z,
      csvCell(m.coordinates?.reference ?? ''),
      m.exact === undefined ? '' : String(m.exact),
      csvCell(m.source ?? ''),
    ].join(',');
  });
  return UTF8_BOM + [header, ...rows].join('\n');
}

/** Trigger a browser download of the CSV file. */
export function downloadMeasurementsCsv(
  measurements: CommittedMeasurement[],
  unit: MeasurementUnit,
): void {
  const csv = measurementsToCsv(measurements, unit);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = exportFilename('measurements', 'csv');
  a.click();
  URL.revokeObjectURL(url);
}

// Export helpers for testing
export { toDisplayValue, unitLabel };

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

/**
 * External store for the cursor-following measurement tip.
 *
 * Same shape as hoverTooltipBridge and for the same reason: the tip updates on
 * every pointer move while measuring, and routing that through ViewerPanel
 * state would reconcile the whole viewer per move. The move handler writes
 * here; the leaf MeasurementCursorTip component is the only React subscriber.
 */

export interface MeasurementTipData {
  x: number;
  y: number;
  /** Main value, already formatted: "2.348 m", "12.4 m2", "34.2deg". */
  primary: string | null;
  /** Extra context: slope for distances, perimeter for areas. */
  secondary: string | null;
  /** What to do next, shown until a value exists: "Click start point". */
  hint: string | null;
  snap: { label: string; exact: boolean } | null;
}

let current: MeasurementTipData | null = null;
const listeners = new Set<() => void>();

export function setMeasurementTip(next: MeasurementTipData | null): void {
  if (next === null && current === null) return;
  current = next;
  for (const listener of listeners) listener();
}

export function getMeasurementTip(): MeasurementTipData | null {
  return current;
}

export function subscribeMeasurementTip(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
