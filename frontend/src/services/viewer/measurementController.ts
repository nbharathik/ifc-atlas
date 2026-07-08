import * as THREE from 'three';
import * as FRAGS from '@thatopen/fragments';

/** Measurement interaction mode.
 *
 *  - `off`: the controller ignores pointer events; selection works normally.
 *  - `linear`: two-click ruler; first click sets A, second sets B, distance
 *     is reported and the measurement is committed to the scene.
 *  - `area`: polygon mode; each click appends a vertex, `commit()` (double-
 *     click / Enter / toolbar "Finish") closes the polygon and reports area.
 *  - `box`: two-click rectangle. First click captures the face normal; the
 *     rectangle is axis-aligned in the plane of that normal so the user can
 *     just slap down two opposite corners on a floor/wall/ceiling.
 *  - `angle`: three-click angle; click vertex first, then two arm endpoints.
 *     The angle at the vertex between the two arms is reported in degrees.
 */
export type MeasurementMode = 'off' | 'linear' | 'area' | 'box' | 'angle';

/** Display units. `m` is metres (IFC native); `mm` and `ft` are derived
 *  conversions. Area readouts square the linear unit (m² / mm² / ft²).
 *  All internal math stays in world units (metres for Y-up models). */
export type MeasurementUnit = 'm' | 'mm' | 'ft';

/** A single committed measurement kept on the scene until the user clears
 *  or switches off measurement mode. Stored world-space so we can re-label
 *  it from any camera angle without re-raycasting. */
export interface CommittedMeasurement {
  id: string;
  kind: 'linear' | 'area' | 'angle';
  /** World-space points. Linear has 2, area has 3+, angle has 3: [vertex, arm1, arm2]. */
  points: THREE.Vector3[];
  /** Computed scalar - metres for linear, m² for area, degrees for angle. */
  value: number;
  /** ISO-8601 timestamp set when the measurement was committed. */
  timestamp?: string;
}

/** Payload fed back to the React HUD after every pointer interaction so
 *  it can render the live distance / perimeter / area readout. */
export interface MeasurementSnapshot {
  mode: MeasurementMode;
  /** Currently-being-drawn point list. Empty if nothing in flight. */
  pending: THREE.Vector3[];
  /** Live value of the in-flight measurement - distance for linear, area
   *  for polygon, degrees for angle. `null` if there aren't enough points yet. */
  pendingValue: number | null;
  /** Auxiliary live value: perimeter for polygon while drawing. `null`
   *  for linear and angle. */
  pendingPerimeter: number | null;
  /** Live angle in degrees while the second arm is being drawn (angle mode
   *  with 2 pending points + cursor). `null` otherwise. */
  pendingAngleDeg: number | null;
  /** Live cursor hit position (world space) for the preview segment. */
  cursor: THREE.Vector3 | null;
  /** Non-null when the cursor is within SNAP_THRESHOLD_METRES of a candidate
   *  endpoint (polygon first-vertex or committed endpoint). The HUD can use
   *  this to show a "snap active" indicator. */
  snapTarget: THREE.Vector3 | null;
  /** Recently-committed measurements, newest first. */
  committed: CommittedMeasurement[];
}

export interface MeasurementHooks {
  /** Fired whenever the visible state changes so the HUD can re-render. */
  onChange: (snapshot: MeasurementSnapshot) => void;
}

/** Convert a world-space metre value to the requested display unit. */
export function formatLength(metres: number, unit: MeasurementUnit): string {
  const v = metres;
  switch (unit) {
    case 'mm': return `${(v * 1000).toFixed(1)} mm`;
    case 'ft': return `${(v * 3.28084).toFixed(3)} ft`;
    case 'm':
    default:   return `${v.toFixed(3)} m`;
  }
}

/** Convert a world-space square-metre value to the requested display unit. */
export function formatArea(squareMetres: number, unit: MeasurementUnit): string {
  const v = squareMetres;
  switch (unit) {
    case 'mm': return `${(v * 1_000_000).toFixed(0)} mm²`;
    case 'ft': return `${(v * 10.7639).toFixed(3)} ft²`;
    case 'm':
    default:   return `${v.toFixed(3)} m²`;
  }
}

/** Angle at `vertex` between the two arms defined by `arm1` and `arm2` (degrees).
 *  Returns 0 if either arm has zero length (degenerate). */
export function computeAngleDeg(
  vertex: THREE.Vector3,
  arm1: THREE.Vector3,
  arm2: THREE.Vector3,
): number {
  const u = new THREE.Vector3().subVectors(arm1, vertex);
  const v = new THREE.Vector3().subVectors(arm2, vertex);
  const lenU = u.length();
  const lenV = v.length();
  if (lenU < 1e-9 || lenV < 1e-9) return 0;
  const cosTheta = Math.max(-1, Math.min(1, u.dot(v) / (lenU * lenV)));
  return (Math.acos(cosTheta) * 180) / Math.PI;
}

/** Format an angle in degrees to a display string. */
export function formatAngle(degrees: number): string {
  return `${degrees.toFixed(1)}°`;
}

/** Linear distance in metres between two world-space points. */
export function linearDistance(a: THREE.Vector3, b: THREE.Vector3): number {
  return a.distanceTo(b);
}

/** Polygon perimeter (closed) in metres. */
export function polygonPerimeter(points: THREE.Vector3[]): number {
  if (points.length < 2) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.distanceTo(b);
  }
  return sum;
}

/** Compute the Newell normal of a polygon - robust even if the polygon is
 *  not perfectly planar. Returns a **unit** vector. Zero-length polygons
 *  return a safe `(0, 1, 0)` fallback so the caller never divides by zero. */
export function newellNormal(points: THREE.Vector3[]): THREE.Vector3 {
  const n = new THREE.Vector3(0, 0, 0);
  const len = points.length;
  if (len < 3) return new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < len; i++) {
    const cur = points[i];
    const nxt = points[(i + 1) % len];
    n.x += (cur.y - nxt.y) * (cur.z + nxt.z);
    n.y += (cur.z - nxt.z) * (cur.x + nxt.x);
    n.z += (cur.x - nxt.x) * (cur.y + nxt.y);
  }
  if (n.lengthSq() < 1e-12) return new THREE.Vector3(0, 1, 0);
  return n.normalize();
}

/** Planar polygon area via the shoelace formula projected onto the polygon's
 *  best-fit plane (Newell normal). For a perfectly planar polygon this is
 *  exact; for a slightly non-planar polygon (e.g. user clicks on a slightly
 *  warped slab) it's a principled approximation - the area of the polygon
 *  after projecting onto its own Newell plane.
 *
 *  Math: |Σ (pᵢ × pᵢ₊₁) · n| / 2, where n is the unit Newell normal.
 *  This is equivalent to the 2D shoelace formula applied after projection.
 *
 *  Needs ≥ 3 points, returns 0 otherwise.
 */
export function polygonArea(points: THREE.Vector3[]): number {
  if (points.length < 3) return 0;
  const normal = newellNormal(points);
  const cross = new THREE.Vector3();
  const accum = new THREE.Vector3();
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    cross.crossVectors(a, b);
    accum.add(cross);
  }
  return Math.abs(accum.dot(normal)) * 0.5;
}

/**
 * Vertex-snap helper: returns the candidate nearest to `worldPos` whose
 * distance is within `thresholdMetres`, or `null` if none qualifies.
 *
 * Pure function - no THREE scene state, trivially testable.
 * Used internally by MeasurementController to snap to:
 *   - the first pending vertex (polygon close)
 *   - any committed measurement endpoint
 */
export function snapToNearest(
  worldPos: THREE.Vector3,
  candidates: THREE.Vector3[],
  thresholdMetres: number,
): THREE.Vector3 | null {
  if (candidates.length === 0 || thresholdMetres <= 0) return null;
  let best: THREE.Vector3 | null = null;
  let bestDist = thresholdMetres;
  for (const c of candidates) {
    const d = worldPos.distanceTo(c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

/** Pick the two basis vectors that span the plane whose normal is `normal`,
 *  snapping to world axes (so box-mode rectangles read as "floor", "wall N",
 *  "ceiling" rather than tilted shapes). The dominant component of the
 *  normal becomes the out-of-plane axis. */
export function planeBasisFromNormal(
  normal: THREE.Vector3,
): { u: THREE.Vector3; v: THREE.Vector3 } {
  const ax = Math.abs(normal.x);
  const ay = Math.abs(normal.y);
  const az = Math.abs(normal.z);
  if (ay >= ax && ay >= az) {
    return { u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 0, 1) };
  }
  if (ax >= az) {
    return { u: new THREE.Vector3(0, 1, 0), v: new THREE.Vector3(0, 0, 1) };
  }
  return { u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 1, 0) };
}

/** Build the four corners of an axis-aligned rectangle in the plane defined
 *  by `normal` through `a`, with `a` and `b` as opposite (diagonal) corners.
 *  Returned in winding order so the polygon area / shoelace stays positive. */
export function buildBoxCorners(
  a: THREE.Vector3,
  b: THREE.Vector3,
  normal: THREE.Vector3,
): [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3] {
  const { u, v } = planeBasisFromNormal(normal);
  const ab = new THREE.Vector3().subVectors(b, a);
  const du = ab.dot(u);
  const dv = ab.dot(v);
  const c1 = a.clone();
  const c2 = a.clone().addScaledVector(u, du);
  const c3 = a.clone().addScaledVector(u, du).addScaledVector(v, dv);
  const c4 = a.clone().addScaledVector(v, dv);
  return [c1, c2, c3, c4];
}

/** Project `point` onto the plane through `planePoint` with `planeNormal`.
 *  Returns a new vector - leaves the inputs untouched. */
export function projectPointToPlane(
  point: THREE.Vector3,
  planePoint: THREE.Vector3,
  planeNormal: THREE.Vector3,
): THREE.Vector3 {
  const diff = new THREE.Vector3().subVectors(point, planePoint);
  const d = diff.dot(planeNormal);
  return new THREE.Vector3().copy(point).addScaledVector(planeNormal, -d);
}

/** Build world-space arc points between two arms of an angle measurement.
 *  The arc is drawn at a radius = min(arm lengths) * 0.25, clamped to
 *  [0.05, 0.5] m so it stays visible without overwhelming small models.
 *  Returns an empty array if either arm has zero length.
 */
export function buildAngleArc(
  vertex: THREE.Vector3,
  arm1: THREE.Vector3,
  arm2: THREE.Vector3,
  segments: number = 20,
): THREE.Vector3[] {
  const u = new THREE.Vector3().subVectors(arm1, vertex);
  const v = new THREE.Vector3().subVectors(arm2, vertex);
  const lenU = u.length();
  const lenV = v.length();
  if (lenU < 1e-9 || lenV < 1e-9) return [];

  const radius = Math.min(Math.max(Math.min(lenU, lenV) * 0.25, 0.05), 0.5);
  const uHat = u.clone().normalize();
  const vHat = v.clone().normalize();

  // Use slerp-style interpolation: lerp + renormalise gives equal angular spacing.
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const dir = new THREE.Vector3().lerpVectors(uHat, vHat, t).normalize();
    pts.push(new THREE.Vector3().copy(vertex).addScaledVector(dir, radius));
  }
  return pts;
}

/** Tag we stamp on every THREE object we own so diagnostics can spot
 *  measurement debris if something leaks. */
const MEASUREMENT_TAG = 'ifc-viewer/measurement';

/** World-space distance (in metres) below which two consecutive clicks are
 *  treated as the same vertex. Guards against accidental double-clicks and
 *  against the raycaster snapping to the same fragment twice when the user
 *  pauses before the second click. 1 mm is well below any measurement the
 *  tool can usefully resolve and well above floating-point jitter. */
const DUPLICATE_CLICK_EPSILON_METRES = 1e-3;

/** Snap-to-vertex threshold in world metres. Within this radius the cursor
 *  snaps to the nearest candidate endpoint (polygon first-vertex or committed
 *  endpoint). 0.1 m = 10 cm - comfortable on BIM models (walls, slabs) where
 *  vertices are typically at sub-centimetre precision. */
const SNAP_THRESHOLD_METRES = 0.1;

/** Small helper that builds a low-allocation LineBasicMaterial. The colour
 *  is chosen to read against both AMOLED-black and light backgrounds. */
function lineMaterial(opts: { dashed?: boolean; colour?: number } = {}): THREE.Material {
  const colour = opts.colour ?? 0xffcc33;
  if (opts.dashed) {
    return new THREE.LineDashedMaterial({
      color: colour,
      dashSize: 0.08,
      gapSize: 0.06,
      depthTest: false,
      transparent: true,
      opacity: 0.95,
    });
  }
  return new THREE.LineBasicMaterial({
    color: colour,
    depthTest: false,
    transparent: true,
    opacity: 0.95,
  });
}

function pointMaterial(colour = 0xffcc33): THREE.PointsMaterial {
  return new THREE.PointsMaterial({
    color: colour,
    size: 10,
    sizeAttenuation: false,
    depthTest: false,
    transparent: true,
    opacity: 0.95,
  });
}

/**
 * Frontend-only measurement controller.
 *
 * Owns:
 *   - mode state (off / linear / area)
 *   - pending (in-flight) vertex list
 *   - committed measurement list
 *   - THREE.Group attached to the scene for all visuals
 *
 * Does NOT own:
 *   - the pointer-event listeners. ViewerPanel is the single pointer-event
 *     hub, and calls `handleClick`, `handleMove`, `commit`, `cancel`. That
 *     way selection + clip plane + measurement never fight over the canvas.
 *
 * All work is world-space - no round-trip to the backend, consistent with
 * Invariant 8 (frontend-first for viewer-only features).
 */
export class MeasurementController {
  private readonly scene: THREE.Scene;
  private readonly model: FRAGS.FragmentsModel;
  private readonly hooks: MeasurementHooks;

  /** Container group for every THREE object the controller creates. Makes
   *  `dispose()` trivially correct - detach + recursively free. */
  private readonly group: THREE.Group;
  /** Live "rubber band" line from the last committed vertex to the cursor. */
  private previewLine: THREE.Line | null = null;
  /** Live close-edge line (area mode only) - visualises how the polygon
   *  would close if the user finished right now. Keeps polygon UX honest. */
  private previewCloseLine: THREE.Line | null = null;
  /** Snap indicator dot: shown at the snapped vertex when cursor is within
   *  SNAP_THRESHOLD_METRES of a candidate endpoint (white) or within the
   *  screen-space vertex threshold of a mesh face vertex (blue). */
  private snapDot: THREE.Points | null = null;

  private mode: MeasurementMode = 'off';
  private pending: THREE.Vector3[] = [];
  private cursor: THREE.Vector3 | null = null;
  /** Currently-active snap target, or null when not snapping. */
  private snapTarget: THREE.Vector3 | null = null;
  /** Whether the active snap is a mesh vertex snap (blue dot) vs an endpoint
   *  snap (white dot). Only meaningful when snapTarget is non-null. */
  private isVertexSnap = false;
  /** Face normal captured at click 1 in `box` mode - locks the rectangle's
   *  plane so click 2 (and the live preview) stays coplanar with corner A. */
  private boxNormal: THREE.Vector3 | null = null;
  private committed: CommittedMeasurement[] = [];
  private nextId = 1;

  constructor(scene: THREE.Scene, model: FRAGS.FragmentsModel, hooks: MeasurementHooks) {
    this.scene = scene;
    this.model = model;
    this.hooks = hooks;
    this.group = new THREE.Group();
    this.group.name = MEASUREMENT_TAG;
    this.group.renderOrder = 999;
    this.scene.add(this.group);
  }

  getMode(): MeasurementMode { return this.mode; }

  /** Switch mode. Discards any in-flight pending points - a user flipping
   *  from `linear` to `area` mid-draw expects a clean slate. */
  setMode(mode: MeasurementMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.pending = [];
    this.cursor = null;
    this.snapTarget = null;
    this.isVertexSnap = false;
    this.boxNormal = null;
    this.updateSnapDot();
    this.refreshPreview();
    this.emit();
  }

  /** Remove every committed + pending measurement and reset mode to `off`. */
  clear(): void {
    this.pending = [];
    this.cursor = null;
    this.snapTarget = null;
    this.isVertexSnap = false;
    this.boxNormal = null;
    this.updateSnapDot();
    for (const m of this.committed) this.disposeCommitted(m);
    this.committed = [];
    this.refreshPreview();
    this.emit();
  }

  /** Drop only the pending in-flight points. Committed ones stay. */
  cancel(): void {
    if (this.pending.length === 0 && !this.cursor) return;
    this.pending = [];
    this.cursor = null;
    this.snapTarget = null;
    this.isVertexSnap = false;
    this.boxNormal = null;
    this.updateSnapDot();
    this.refreshPreview();
    this.emit();
  }

  /**
   * Pointer-move update: ViewerPanel raycasts on hover and passes the
   * world-space hit in (or null if the cursor is over empty space).
   *
   * @param world - Raw raycast hit position, or null on miss.
   * @param vertexSnap - Optional screen-space nearest face-vertex (from
   *   `snapToFaceVertex()`). When provided, it takes priority over the raw
   *   world point as the cursor position, shown with a blue snap dot.
   *   Endpoint snaps (polygon close / committed endpoint) override even
   *   vertex snaps and are shown with a white dot.
   */
  handleMove(world: THREE.Vector3 | null, vertexSnap?: THREE.Vector3 | null): void {
    if (this.mode === 'off') return;
    if (this.pending.length === 0) return;
    if (!world) {
      this.cursor = null;
      this.snapTarget = null;
      this.isVertexSnap = false;
      this.updateSnapDot();
      this.refreshPreview();
      this.emit();
      return;
    }
    // Box mode: lock the cursor to the plane of corner A so the live
    // rectangle preview never tilts away when the user grazes a different
    // face. Endpoint/vertex snaps are skipped in box mode - a rectangle
    // doesn't need to snap to other measurements' endpoints.
    if (this.mode === 'box' && this.boxNormal && this.pending.length === 1) {
      this.cursor = projectPointToPlane(world, this.pending[0], this.boxNormal);
      this.snapTarget = null;
      this.isVertexSnap = false;
      this.updateSnapDot();
      this.refreshPreview();
      this.emit();
      return;
    }
    // Endpoint snap takes priority over vertex snap.
    const endpointSnap = this.computeSnap(world);
    if (endpointSnap) {
      this.cursor = endpointSnap.clone();
      this.snapTarget = endpointSnap;
      this.isVertexSnap = false;
    } else if (vertexSnap) {
      this.cursor = vertexSnap.clone();
      this.snapTarget = vertexSnap;
      this.isVertexSnap = true;
    } else {
      this.cursor = world.clone();
      this.snapTarget = null;
      this.isVertexSnap = false;
    }
    this.updateSnapDot();
    this.refreshPreview();
    this.emit();
  }

  /** Build candidate list for snap: first pending vertex + all committed
   *  endpoints. Returns the nearest within threshold, or null. */
  private computeSnap(world: THREE.Vector3): THREE.Vector3 | null {
    const candidates: THREE.Vector3[] = [];
    if (this.pending.length > 0) candidates.push(this.pending[0]);
    for (const m of this.committed) {
      if (m.points.length > 0) candidates.push(m.points[0]);
      if (m.points.length > 1) candidates.push(m.points[m.points.length - 1]);
    }
    return snapToNearest(world, candidates, SNAP_THRESHOLD_METRES);
  }

  /** Show / hide the snap indicator dot.
   *  Endpoint snaps render white (0xffffff); vertex snaps render blue (0x4499ff). */
  private updateSnapDot(): void {
    const VERTEX_SNAP_COLOUR = 0x4499ff;
    const ENDPOINT_SNAP_COLOUR = 0xffffff;
    if (this.snapTarget) {
      const colour = this.isVertexSnap ? VERTEX_SNAP_COLOUR : ENDPOINT_SNAP_COLOUR;
      if (!this.snapDot) {
        const geom = new THREE.BufferGeometry();
        geom.setFromPoints([this.snapTarget]);
        this.snapDot = new THREE.Points(
          geom,
          new THREE.PointsMaterial({
            color: colour,
            size: 14,
            sizeAttenuation: false,
            depthTest: false,
            transparent: true,
            opacity: 1,
          }),
        );
        this.snapDot.name = MEASUREMENT_TAG + '/snap';
        this.snapDot.renderOrder = 1000;
        this.group.add(this.snapDot);
      } else {
        (this.snapDot.material as THREE.PointsMaterial).color.setHex(colour);
        (this.snapDot.geometry as THREE.BufferGeometry).setFromPoints([this.snapTarget]);
        this.snapDot.geometry.attributes['position'].needsUpdate = true;
        this.snapDot.visible = true;
      }
    } else if (this.snapDot) {
      this.snapDot.visible = false;
    }
  }

  /**
   * Pointer-click: append a vertex. Returns true if the click was consumed
   * by the controller (so ViewerPanel's selection handler should bail), or
   * false if measurement mode is off.
   *
   * In `linear` mode the second click auto-commits the measurement and
   * leaves the controller ready for a new pair.
   */
  handleClick(world: THREE.Vector3, worldNormal?: THREE.Vector3 | null): boolean {
    if (this.mode === 'off') return false;

    // Box mode: click 1 stores the face normal so click 2 / preview lock to
    // its plane. Click 2 gets projected onto that plane before being
    // appended so the rectangle is exact even if the raycast hit a sibling
    // surface a millimetre off.
    if (this.mode === 'box') {
      if (this.pending.length === 0) {
        const n = worldNormal && worldNormal.lengthSq() > 1e-9
          ? worldNormal.clone().normalize()
          : new THREE.Vector3(0, 1, 0);
        this.boxNormal = n;
        this.pending.push(world.clone());
        this.cursor = world.clone();
        this.refreshPreview();
        this.emit();
        return true;
      }
      // Click 2: project onto plane and auto-commit.
      const a = this.pending[0];
      const n = this.boxNormal ?? new THREE.Vector3(0, 1, 0);
      const b = projectPointToPlane(world, a, n);
      if (b.distanceTo(a) < DUPLICATE_CLICK_EPSILON_METRES) return true;
      this.pending.push(b);
      this.cursor = b.clone();
      this.commit();
      return true;
    }

    // Apply snap: if the click lands within threshold of a candidate, use
    // the candidate position so the user can close polygons precisely.
    const snapped = this.pending.length > 0
      ? (this.computeSnap(world) ?? world)
      : world;

    // Reject duplicate consecutive clicks so an accidental double-click (or
    // a slow click where the raycaster returns the same world point twice)
    // doesn't commit a zero-length ruler or inject a degenerate edge into
    // a polygon. Still counts as "consumed" so the selection handler
    // doesn't get a stray fall-through.
    const last = this.pending[this.pending.length - 1];
    if (last && last.distanceTo(snapped) < DUPLICATE_CLICK_EPSILON_METRES) {
      return true;
    }

    this.pending.push(snapped.clone());
    this.cursor = snapped.clone();

    if (this.mode === 'linear' && this.pending.length >= 2) {
      this.commit();
      return true;
    }

    if (this.mode === 'angle' && this.pending.length >= 3) {
      this.commit();
      return true;
    }

    this.refreshPreview();
    this.emit();
    return true;
  }

  /**
   * Commit the pending points - distance for linear, area for polygon.
   * Polygon requires ≥ 3 pending points; otherwise this is a no-op.
   */
  commit(): CommittedMeasurement | null {
    if (this.mode === 'off') return null;

    if (this.mode === 'linear' && this.pending.length >= 2) {
      const pts = this.pending.slice(0, 2);
      const value = linearDistance(pts[0], pts[1]);
      const m: CommittedMeasurement = {
        id: `m-${this.nextId++}`,
        kind: 'linear',
        points: pts,
        value,
        timestamp: new Date().toISOString(),
      };
      this.buildVisual(m);
      this.committed.unshift(m);
      this.pending = [];
      this.cursor = null;
      this.refreshPreview();
      this.emit();
      return m;
    }

    if (this.mode === 'area' && this.pending.length >= 3) {
      const pts = this.pending.slice();
      const value = polygonArea(pts);
      const m: CommittedMeasurement = {
        id: `m-${this.nextId++}`,
        kind: 'area',
        points: pts,
        value,
        timestamp: new Date().toISOString(),
      };
      this.buildVisual(m);
      this.committed.unshift(m);
      this.pending = [];
      this.cursor = null;
      this.refreshPreview();
      this.emit();
      return m;
    }

    if (this.mode === 'box' && this.pending.length >= 2 && this.boxNormal) {
      const [a, b] = this.pending.slice(0, 2);
      const corners = buildBoxCorners(a, b, this.boxNormal);
      const value = polygonArea(corners);
      const m: CommittedMeasurement = {
        id: `m-${this.nextId++}`,
        kind: 'area',
        points: corners,
        value,
        timestamp: new Date().toISOString(),
      };
      this.buildVisual(m);
      this.committed.unshift(m);
      this.pending = [];
      this.cursor = null;
      this.boxNormal = null;
      this.refreshPreview();
      this.emit();
      return m;
    }

    if (this.mode === 'angle' && this.pending.length >= 3) {
      const [vertex, arm1, arm2] = this.pending.slice(0, 3);
      const value = computeAngleDeg(vertex, arm1, arm2);
      const m: CommittedMeasurement = {
        id: `m-${this.nextId++}`,
        kind: 'angle',
        points: [vertex, arm1, arm2],
        value,
        timestamp: new Date().toISOString(),
      };
      this.buildVisual(m);
      this.committed.unshift(m);
      this.pending = [];
      this.cursor = null;
      this.refreshPreview();
      this.emit();
      return m;
    }

    return null;
  }

  /** Remove a single committed measurement by id. No-op if not found. */
  remove(id: string): void {
    const idx = this.committed.findIndex((m) => m.id === id);
    if (idx < 0) return;
    const [m] = this.committed.splice(idx, 1);
    this.disposeCommitted(m);
    this.emit();
  }

  /** Build a read-only snapshot of the current state. */
  snapshot(): MeasurementSnapshot {
    const pendingWithCursor: THREE.Vector3[] = this.cursor
      ? [...this.pending, this.cursor]
      : this.pending.slice();

    let pendingValue: number | null = null;
    let pendingPerimeter: number | null = null;
    let pendingAngleDeg: number | null = null;

    if (this.mode === 'linear' && pendingWithCursor.length >= 2) {
      pendingValue = linearDistance(pendingWithCursor[0], pendingWithCursor[1]);
    } else if (this.mode === 'area' && pendingWithCursor.length >= 3) {
      pendingValue = polygonArea(pendingWithCursor);
      pendingPerimeter = polygonPerimeter(pendingWithCursor);
    } else if (this.mode === 'area' && pendingWithCursor.length === 2) {
      pendingPerimeter = linearDistance(pendingWithCursor[0], pendingWithCursor[1]);
    } else if (this.mode === 'box' && this.boxNormal && pendingWithCursor.length >= 2) {
      const corners = buildBoxCorners(pendingWithCursor[0], pendingWithCursor[1], this.boxNormal);
      pendingValue = polygonArea(corners);
      pendingPerimeter = polygonPerimeter(corners);
    } else if (this.mode === 'angle' && pendingWithCursor.length >= 3) {
      pendingAngleDeg = computeAngleDeg(
        pendingWithCursor[0],
        pendingWithCursor[1],
        pendingWithCursor[2],
      );
      pendingValue = pendingAngleDeg;
    }

    return {
      mode: this.mode,
      pending: this.pending.slice(),
      pendingValue,
      pendingPerimeter,
      pendingAngleDeg,
      cursor: this.cursor ? this.cursor.clone() : null,
      snapTarget: this.snapTarget ? this.snapTarget.clone() : null,
      committed: this.committed.slice(),
    };
  }

  /** Access the FragmentsModel used for raycasting - consumers can share
   *  this for their own cursor raycasts without needing a second reference. */
  getModel(): FRAGS.FragmentsModel {
    return this.model;
  }

  /** Tear down: remove group, free materials/geometries, clear listeners. */
  dispose(): void {
    this.scene.remove(this.group);
    this.group.traverse((obj) => {
      const mesh = obj as THREE.Mesh | THREE.Line | THREE.Points;
      const anyMesh = mesh as unknown as { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
      if (anyMesh.geometry) anyMesh.geometry.dispose();
      if (anyMesh.material) {
        if (Array.isArray(anyMesh.material)) anyMesh.material.forEach((m) => m.dispose());
        else anyMesh.material.dispose();
      }
    });
    this.pending = [];
    this.cursor = null;
    this.committed = [];
  }

  // ───────────────────── internals ─────────────────────

  private emit(): void {
    this.hooks.onChange(this.snapshot());
  }

  /** Rebuild the preview (rubber-band) line + optional close edge. Called
   *  on every pointer move and every pending-points mutation. Previews are
   *  cheap to rebuild, just 1-2 `Line` objects, so no need to diff. */
  private refreshPreview(): void {
    if (this.previewLine) {
      this.group.remove(this.previewLine);
      this.previewLine.geometry.dispose();
      (this.previewLine.material as THREE.Material).dispose();
      this.previewLine = null;
    }
    if (this.previewCloseLine) {
      this.group.remove(this.previewCloseLine);
      this.previewCloseLine.geometry.dispose();
      (this.previewCloseLine.material as THREE.Material).dispose();
      this.previewCloseLine = null;
    }
    if (this.mode === 'off' || this.pending.length === 0 || !this.cursor) return;

    if (this.mode === 'box' && this.boxNormal) {
      // Live rectangle outline: 4 corners on the plane of click 1.
      const corners = buildBoxCorners(this.pending[0], this.cursor, this.boxNormal);
      const loop = [...corners, corners[0]];
      const geom = new THREE.BufferGeometry().setFromPoints(loop);
      this.previewLine = new THREE.Line(geom, lineMaterial({ dashed: true, colour: 0xffcc33 }));
      this.previewLine.computeLineDistances();
      this.previewLine.renderOrder = 999;
      this.group.add(this.previewLine);
      return;
    }

    if (this.mode === 'angle') {
      if (this.pending.length === 1) {
        // Arm1 not placed yet: rubber-band from vertex to cursor.
        const vertex = this.pending[0];
        const geom = new THREE.BufferGeometry().setFromPoints([vertex, this.cursor]);
        this.previewLine = new THREE.Line(geom, lineMaterial({ dashed: true, colour: 0xffcc33 }));
        this.previewLine.renderOrder = 999;
        this.group.add(this.previewLine);
      } else if (this.pending.length === 2) {
        // Arm1 placed: show vertex→arm1 solid + vertex→cursor dashed for arm2.
        const vertex = this.pending[0];
        const arm1 = this.pending[1];
        const solidGeom = new THREE.BufferGeometry().setFromPoints([vertex, arm1]);
        this.previewCloseLine = new THREE.Line(solidGeom, lineMaterial({ colour: 0xffcc33 }));
        this.previewCloseLine.renderOrder = 999;
        this.group.add(this.previewCloseLine);

        const dashGeom = new THREE.BufferGeometry().setFromPoints([vertex, this.cursor]);
        this.previewLine = new THREE.Line(dashGeom, lineMaterial({ dashed: true, colour: 0xffcc33 }));
        this.previewLine.computeLineDistances();
        this.previewLine.renderOrder = 999;
        this.group.add(this.previewLine);
      }
      return;
    }

    // Rubber-band from the last placed vertex to the cursor.
    const last = this.pending[this.pending.length - 1];
    const geom = new THREE.BufferGeometry().setFromPoints([last, this.cursor]);
    this.previewLine = new THREE.Line(geom, lineMaterial({ dashed: false, colour: 0xffcc33 }));
    this.previewLine.renderOrder = 999;
    this.group.add(this.previewLine);

    // Area mode: show the close edge (first vertex ↔ cursor) dashed so the
    // user knows how the polygon closes before committing.
    if (this.mode === 'area' && this.pending.length >= 2) {
      const first = this.pending[0];
      const closeGeom = new THREE.BufferGeometry().setFromPoints([this.cursor, first]);
      const mat = lineMaterial({ dashed: true, colour: 0xffcc33 });
      this.previewCloseLine = new THREE.Line(closeGeom, mat);
      (this.previewCloseLine as THREE.Line).computeLineDistances();
      this.previewCloseLine.renderOrder = 999;
      this.group.add(this.previewCloseLine);
    }
  }

  /** Create the committed visual: a solid polyline and point sprites. */
  private buildVisual(m: CommittedMeasurement): void {
    if (m.kind === 'angle') {
      this.buildAngleVisual(m);
      return;
    }
    const loop = m.kind === 'area';
    const pts = loop ? [...m.points, m.points[0]] : m.points;
    const lineGeom = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(lineGeom, lineMaterial({ dashed: false, colour: 0x66ddff }));
    line.renderOrder = 999;
    line.userData.measurementId = m.id;
    this.group.add(line);

    const pointGeom = new THREE.BufferGeometry().setFromPoints(m.points);
    const points = new THREE.Points(pointGeom, pointMaterial(0x66ddff));
    points.renderOrder = 1000;
    points.userData.measurementId = m.id;
    this.group.add(points);
  }

  /** Build the angle measurement visual: two arms from vertex + small arc. */
  private buildAngleVisual(m: CommittedMeasurement): void {
    const [vertex, arm1, arm2] = m.points;
    const colour = 0xffa040; // orange-amber to distinguish from linear/area

    // Two arm lines.
    for (const endPt of [arm1, arm2]) {
      const geom = new THREE.BufferGeometry().setFromPoints([vertex, endPt]);
      const line = new THREE.Line(geom, lineMaterial({ colour }));
      line.renderOrder = 999;
      line.userData.measurementId = m.id;
      this.group.add(line);
    }

    // Small arc between the two arms to indicate the angle visually.
    const arcPts = buildAngleArc(vertex, arm1, arm2, 20);
    if (arcPts.length >= 2) {
      const arcGeom = new THREE.BufferGeometry().setFromPoints(arcPts);
      const arc = new THREE.Line(arcGeom, lineMaterial({ colour }));
      arc.renderOrder = 999;
      arc.userData.measurementId = m.id;
      this.group.add(arc);
    }

    // Vertex + arm endpoint dots.
    const dotGeom = new THREE.BufferGeometry().setFromPoints([vertex, arm1, arm2]);
    const dots = new THREE.Points(dotGeom, pointMaterial(colour));
    dots.renderOrder = 1000;
    dots.userData.measurementId = m.id;
    this.group.add(dots);
  }

  private disposeCommitted(m: CommittedMeasurement): void {
    const toRemove: THREE.Object3D[] = [];
    this.group.traverse((obj) => {
      if (obj.userData?.measurementId === m.id) toRemove.push(obj);
    });
    for (const obj of toRemove) {
      this.group.remove(obj);
      const anyObj = obj as unknown as { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
      if (anyObj.geometry) anyObj.geometry.dispose();
      if (anyObj.material) {
        if (Array.isArray(anyObj.material)) anyObj.material.forEach((mat) => mat.dispose());
        else anyObj.material.dispose();
      }
    }
  }
}
