import * as THREE from 'three';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { CommittedMeasurement } from './measurementController';
import { formatLength, formatArea, type MeasurementUnit } from './measurementController';

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
      const text = m.kind === 'linear'
        ? formatLength(m.value, unit)
        : formatArea(m.value, unit);

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
  if (m.kind === 'linear' && m.points.length >= 2) {
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
