import * as THREE from 'three';
import {
  GRID_SNAP_M,
  MIN_WALL_SEGMENT_M,
  formatWallLength,
  ifcElevationToWorldY,
  ifcXYToWorldXZ,
  snapIfcXY,
  wallLengthM,
  worldToIfcXY,
  type IfcXY,
} from './wallDrawHelpers';

/**
 * Two-click wall drawing controller (master-plan B5, first drawing tool).
 *
 * Owns, while armed:
 *   - its own capture-phase `Escape` listener (cancel pending / exit tool)
 *   - a THREE.Group with the preview visuals (start marker, rubber-band
 *     line, floating length label) - disposed with the controller
 *
 * Does NOT own:
 *   - left-click delivery. ViewerPanel is the single pointer-click hub
 *     (drag-vs-click detection lives there); it calls `handleClick()` ahead
 *     of selection, exactly like the MeasurementController seam.
 *   - the create_wall call. Committing raises the `onCommit` callback with
 *     snapped IFC XY metres; the EditToolbar owns params + applyOperation.
 *
 * Points are picked by raycasting a horizontal THREE.Plane at the active
 * storey elevation - never against model geometry - so walls can be drawn
 * on empty ground. Grid snap (GRID_SNAP_M) is always on for v1.
 */

export interface WallDrawCommitEvent {
  /** Snapped IFC XY metres - pass straight to create_wall. */
  start: IfcXY;
  end: IfcXY;
  lengthM: number;
}

export interface WallDrawState {
  armed: boolean;
  hasStart: boolean;
  /** Live snapped length of the in-flight segment, or null. */
  lengthM: number | null;
}

export interface WallDrawControllerOptions {
  scene: THREE.Scene;
  /** Renderer canvas - pointer target and NDC reference frame. */
  dom: HTMLElement;
  /** Resolved per raycast so projection-mode switches stay correct. */
  getCamera: () => THREE.Camera;
  /** Request a viewer frame after preview buffers change. */
  onPreviewChange?: () => void;
  /** Allow the viewer to deactivate mutually-exclusive tools. */
  onArm?: () => void;
}

/** Tag stamped on every THREE object the controller owns (leak diagnosis). */
const WALL_DRAW_TAG = 'ifc-viewer/wall-draw';

/** Preview colour - green, distinct from the amber/cyan measurement family. */
const PREVIEW_COLOUR = 0x4ade80;

const LABEL_CANVAS_W = 256;
const LABEL_CANVAS_H = 64;

export class WallDrawController {
  private readonly scene: THREE.Scene;
  private readonly dom: HTMLElement;
  private readonly getCamera: () => THREE.Camera;
  private readonly onPreviewChange: (() => void) | undefined;
  private readonly onArm: (() => void) | undefined;

  private readonly group: THREE.Group;
  private readonly raycaster = new THREE.Raycaster();
  /** Horizontal work plane: normal +Y, `constant = -planeWorldY`. */
  private readonly plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private planeWorldY = 0;

  private armed = false;
  private startIfc: IfcXY | null = null;
  private cursorIfc: IfcXY | null = null;
  private disposed = false;

  private readonly startMarker: THREE.Points;
  private readonly previewLine: THREE.Line;
  private readonly markerPositions = new Float32Array(3);
  private readonly linePositions = new Float32Array(6);
  private readonly ndc = new THREE.Vector2();
  private readonly hitPoint = new THREE.Vector3();
  private readonly startWorld = new THREE.Vector3();
  private readonly endWorld = new THREE.Vector3();
  private readonly midpoint = new THREE.Vector3();
  private pendingMove: { x: number; y: number } | null = null;
  private moveRaf: number | null = null;
  private label: THREE.Sprite | null = null;
  private labelCanvas: HTMLCanvasElement | null = null;
  private labelTexture: THREE.CanvasTexture | null = null;
  private lastLabelText = '';
  private lastEmitted: WallDrawState | null = null;

  private onCommit: ((e: WallDrawCommitEvent) => void) | null = null;
  private onStateChange: ((s: WallDrawState) => void) | null = null;

  constructor(opts: WallDrawControllerOptions) {
    this.scene = opts.scene;
    this.dom = opts.dom;
    this.getCamera = opts.getCamera;
    this.onPreviewChange = opts.onPreviewChange;
    this.onArm = opts.onArm;
    this.group = new THREE.Group();
    this.group.name = WALL_DRAW_TAG;
    this.group.renderOrder = 999;
    const markerGeometry = new THREE.BufferGeometry();
    markerGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(this.markerPositions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this.startMarker = new THREE.Points(
      markerGeometry,
      new THREE.PointsMaterial({
        color: PREVIEW_COLOUR,
        size: 10,
        sizeAttenuation: false,
        depthTest: false,
        transparent: true,
        opacity: 0.95,
      }),
    );
    this.startMarker.name = WALL_DRAW_TAG + '/start';
    this.startMarker.renderOrder = 1000;
    this.startMarker.frustumCulled = false;
    this.startMarker.visible = false;

    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(this.linePositions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this.previewLine = new THREE.Line(
      lineGeometry,
      new THREE.LineBasicMaterial({
        color: PREVIEW_COLOUR,
        depthTest: false,
        transparent: true,
        opacity: 0.95,
      }),
    );
    this.previewLine.name = WALL_DRAW_TAG + '/line';
    this.previewLine.renderOrder = 999;
    this.previewLine.frustumCulled = false;
    this.previewLine.visible = false;
    this.group.add(this.startMarker, this.previewLine);
    this.scene.add(this.group);
  }

  /** EditToolbar registers these; ViewerPanel never touches them. */
  setCommitHandler(fn: ((e: WallDrawCommitEvent) => void) | null): void {
    this.onCommit = fn;
  }

  setStateChangeHandler(fn: ((s: WallDrawState) => void) | null): void {
    this.onStateChange = fn;
    this.lastEmitted = null; // next emit always reaches the new subscriber
  }

  isArmed(): boolean {
    return this.armed;
  }

  /**
   * Move the work plane to a storey elevation (IFC Z metres). An in-flight
   * first point is discarded - mixing points from two planes would commit
   * a wall the user never saw.
   */
  setPlaneElevation(ifcElevationM: number): void {
    const y = ifcElevationToWorldY(ifcElevationM);
    if (y === this.planeWorldY) return;
    this.planeWorldY = y;
    this.plane.constant = -y;
    if (this.startIfc) this.cancelPending();
  }

  /** Activate the tool: crosshair cursor, move preview + Escape listeners. */
  arm(): void {
    if (this.armed || this.disposed) return;
    this.onArm?.();
    this.armed = true;
    window.addEventListener('keydown', this.handleKeyDown, true);
    this.dom.style.cursor = 'crosshair';
    this.emit();
  }

  /** Deactivate: discard in-flight point, remove listeners, restore cursor. */
  disarm(): void {
    if (!this.armed) return;
    this.armed = false;
    this.startIfc = null;
    this.cursorIfc = null;
    this.teardownListeners();
    this.refreshPreview();
    this.onPreviewChange?.();
    this.emit();
  }

  /** Drop only the pending first point; the tool stays armed. */
  cancelPending(): void {
    if (!this.startIfc && !this.cursorIfc) return;
    this.startIfc = null;
    this.cursorIfc = null;
    this.refreshPreview();
    this.onPreviewChange?.();
    this.emit();
  }

  /**
   * Left-click from ViewerPanel's pointer hub (already drag-filtered).
   * Returns true when the click was consumed (tool armed), so the caller
   * skips selection - mirrors MeasurementController.handleClick.
   *
   * Click 1 places the start point; click 2 commits via `onCommit` and
   * immediately re-arms for the next wall (continuous drawing).
   */
  handleClick(clientX: number, clientY: number): boolean {
    if (!this.armed) return false;
    const picked = this.pickIfcPoint(clientX, clientY);
    if (!picked) return true; // grazing ray missed the plane - consumed, no-op

    if (!this.startIfc) {
      this.startIfc = picked;
      this.cursorIfc = picked;
      this.refreshPreview();
      this.onPreviewChange?.();
      this.emit();
      return true;
    }

    const lengthM = wallLengthM(this.startIfc, picked);
    if (lengthM < MIN_WALL_SEGMENT_M) return true; // double-click on the start point

    const event: WallDrawCommitEvent = { start: this.startIfc, end: picked, lengthM };
    this.startIfc = null;
    this.cursorIfc = null;
    this.refreshPreview();
    this.onPreviewChange?.();
    this.emit();
    this.onCommit?.(event);
    return true;
  }

  /** Read-only snapshot for consumers that poll instead of subscribing. */
  snapshot(): WallDrawState {
    const lengthM =
      this.startIfc && this.cursorIfc ? wallLengthM(this.startIfc, this.cursorIfc) : null;
    return { armed: this.armed, hasStart: this.startIfc !== null, lengthM };
  }

  /**
   * Feed live pointer coordinates from ViewerPanel's single pointer hub.
   * Work is coalesced to one update per animation frame and ignored until the
   * first wall point exists.
   */
  handlePointerMove(clientX: number, clientY: number): void {
    if (!this.armed || !this.startIfc || this.disposed) return;
    this.pendingMove = { x: clientX, y: clientY };
    if (this.moveRaf !== null) return;
    this.moveRaf = window.requestAnimationFrame(() => {
      this.moveRaf = null;
      const pending = this.pendingMove;
      this.pendingMove = null;
      if (!pending || !this.armed || !this.startIfc || this.disposed) return;
      const next = this.pickIfcPoint(pending.x, pending.y);
      if (
        this.cursorIfc
        && next
        && this.cursorIfc[0] === next[0]
        && this.cursorIfc[1] === next[1]
      ) return;
      if (this.cursorIfc === null && next === null) return;
      this.cursorIfc = next;
      this.refreshPreview();
      this.onPreviewChange?.();
      this.emit();
    });
  }

  /** Tear down listeners + scene objects. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.armed) {
      this.armed = false;
      this.teardownListeners();
    }
    this.startIfc = null;
    this.cursorIfc = null;
    this.onCommit = null;
    this.onStateChange = null;
    this.scene.remove(this.group);
    this.onPreviewChange?.();
    this.group.traverse((obj) => {
      const anyObj = obj as unknown as {
        geometry?: THREE.BufferGeometry;
        material?: THREE.Material | THREE.Material[];
      };
      anyObj.geometry?.dispose();
      if (Array.isArray(anyObj.material)) anyObj.material.forEach((m) => m.dispose());
      else anyObj.material?.dispose();
    });
    this.labelTexture?.dispose();
    this.labelTexture = null;
    this.label = null;
  }

  // ───────────────────── internals ─────────────────────

  private teardownListeners(): void {
    window.removeEventListener('keydown', this.handleKeyDown, true);
    if (this.moveRaf !== null) {
      window.cancelAnimationFrame(this.moveRaf);
      this.moveRaf = null;
    }
    this.pendingMove = null;
    this.dom.style.cursor = 'default';
  }

  private handleKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape' || !this.armed) return;
    ev.stopPropagation();
    if (this.startIfc) this.cancelPending();
    else this.disarm(); // second Escape (nothing pending) exits the tool
  };

  /** Raycast the work plane and return the grid-snapped IFC XY, or null. */
  private pickIfcPoint(clientX: number, clientY: number): IfcXY | null {
    const rect = this.dom.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    this.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, this.getCamera());
    if (!this.raycaster.ray.intersectPlane(this.plane, this.hitPoint)) return null;
    return snapIfcXY(worldToIfcXY(this.hitPoint.x, this.hitPoint.z), GRID_SNAP_M);
  }

  /** Snapped IFC XY back to a world point on the work plane. */
  private ifcToWorld(p: IfcXY, target: THREE.Vector3): THREE.Vector3 {
    const [wx, wz] = ifcXYToWorldXZ(p[0], p[1]);
    return target.set(wx, this.planeWorldY, wz);
  }

  /** Notify the toolbar - deduplicated so pointermove doesn't spam React. */
  private emit(): void {
    if (!this.onStateChange) return;
    const s = this.snapshot();
    const prev = this.lastEmitted;
    if (
      prev
      && prev.armed === s.armed
      && prev.hasStart === s.hasStart
      && prev.lengthM === s.lengthM
    ) {
      return;
    }
    this.lastEmitted = s;
    this.onStateChange(s);
  }

  /**
   * Update the persistent preview buffers. Geometry/material objects are
   * created once in the constructor and disposed once with the controller.
   */
  private refreshPreview(): void {
    this.previewLine.visible = false;
    this.startMarker.visible = false;
    if (this.label) this.label.visible = false;

    if (!this.startIfc) return;

    const startWorld = this.ifcToWorld(this.startIfc, this.startWorld);
    this.markerPositions[0] = startWorld.x;
    this.markerPositions[1] = startWorld.y;
    this.markerPositions[2] = startWorld.z;
    (this.startMarker.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.startMarker.visible = true;

    if (!this.cursorIfc) return;
    const lengthM = wallLengthM(this.startIfc, this.cursorIfc);
    if (lengthM < MIN_WALL_SEGMENT_M) return;

    const endWorld = this.ifcToWorld(this.cursorIfc, this.endWorld);
    this.linePositions[0] = startWorld.x;
    this.linePositions[1] = startWorld.y;
    this.linePositions[2] = startWorld.z;
    this.linePositions[3] = endWorld.x;
    this.linePositions[4] = endWorld.y;
    this.linePositions[5] = endWorld.z;
    (this.previewLine.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.previewLine.visible = true;

    this.midpoint.copy(startWorld).add(endWorld).multiplyScalar(0.5);
    this.updateLabel(formatWallLength(lengthM), this.midpoint);
  }

  /** Screen-constant sprite label (canvas texture, redrawn on text change). */
  private updateLabel(text: string, position: THREE.Vector3): void {
    if (!this.label) {
      this.labelCanvas = document.createElement('canvas');
      this.labelCanvas.width = LABEL_CANVAS_W;
      this.labelCanvas.height = LABEL_CANVAS_H;
      this.labelTexture = new THREE.CanvasTexture(this.labelCanvas);
      const material = new THREE.SpriteMaterial({
        map: this.labelTexture,
        depthTest: false,
        transparent: true,
        sizeAttenuation: false,
      });
      this.label = new THREE.Sprite(material);
      this.label.name = WALL_DRAW_TAG + '/label';
      this.label.renderOrder = 1001;
      // sizeAttenuation:false → scale is a viewport-height fraction; 4:1
      // matches the canvas aspect so the text is never stretched.
      this.label.scale.set(0.16, 0.04, 1);
      this.label.center.set(0.5, 0); // sit just above the line midpoint
      this.group.add(this.label);
    }
    if (text !== this.lastLabelText && this.labelCanvas && this.labelTexture) {
      const ctx = this.labelCanvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, LABEL_CANVAS_W, LABEL_CANVAS_H);
        ctx.fillStyle = 'rgba(15, 18, 26, 0.85)';
        const r = 12;
        ctx.beginPath();
        ctx.moveTo(r, 0);
        ctx.lineTo(LABEL_CANVAS_W - r, 0);
        ctx.quadraticCurveTo(LABEL_CANVAS_W, 0, LABEL_CANVAS_W, r);
        ctx.lineTo(LABEL_CANVAS_W, LABEL_CANVAS_H - r);
        ctx.quadraticCurveTo(LABEL_CANVAS_W, LABEL_CANVAS_H, LABEL_CANVAS_W - r, LABEL_CANVAS_H);
        ctx.lineTo(r, LABEL_CANVAS_H);
        ctx.quadraticCurveTo(0, LABEL_CANVAS_H, 0, LABEL_CANVAS_H - r);
        ctx.lineTo(0, r);
        ctx.quadraticCurveTo(0, 0, r, 0);
        ctx.fill();
        ctx.font = '600 30px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#4ade80';
        ctx.fillText(text, LABEL_CANVAS_W / 2, LABEL_CANVAS_H / 2 + 1);
      }
      this.labelTexture.needsUpdate = true;
      this.lastLabelText = text;
    }
    this.label.position.copy(position);
    this.label.visible = true;
  }
}
