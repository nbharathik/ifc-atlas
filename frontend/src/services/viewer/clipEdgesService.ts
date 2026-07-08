import * as THREE from 'three';
import * as OBC from '@thatopen/components';
import * as OBCF from '@thatopen/components-front';

const FILL_STYLE = 'ifc-viewer/cap-fill';

/**
 * Manages ClipStyler (from @thatopen/components-front) in sync with the
 * ClipPlaneController. When a section plane is created, this service creates
 * a matching ClipEdges instance that renders a solid filled cap on the cut
 * surface. Linked planes auto-update on drag and auto-dispose on deletion.
 */
export class ClipEdgesService {
  private readonly styler: OBCF.ClipStyler;
  private modelId: string | null = null;

  constructor(components: OBC.Components, world: OBC.World) {
    this.styler = components.get(OBCF.ClipStyler);
    this.styler.world = world;
    this.styler.styles.set(FILL_STYLE, {
      fillsMaterial: new THREE.MeshBasicMaterial({
        color: 0x707788, // cool slate cap fill - make theme-aware once a theme hook reaches this service
        side: THREE.DoubleSide,
        transparent: false,
        depthWrite: true,
      }),
    });
  }

  /**
   * Register the loaded model so ClipEdges know which model to section.
   * Call this once after the model finishes loading. Also retroactively
   * applies to any ClipEdges already created before the model was known.
   */
  setModel(modelId: string): void {
    this.modelId = modelId;
    for (const [, edges] of this.styler.list) {
      if (!edges.items.has(modelId)) {
        edges.items.set(modelId, { style: FILL_STYLE });
        void edges.update();
      }
    }
  }

  /**
   * Create a ClipEdges instance linked to the SimplePlane identified by
   * planeId (from OBC.Clipper.list). The `link: true` option means the edges
   * will auto-update on drag-end and auto-dispose when the plane is deleted.
   */
  createForPlane(planeId: string): void {
    try {
      const items = this.modelId
        ? { [this.modelId]: { style: FILL_STYLE } }
        : undefined;
      this.styler.createFromClipping(planeId, { link: true, items });
    } catch (err) {
      console.warn('[ClipEdgesService] createForPlane failed:', err);
    }
  }

  /** Set visibility of all clip edge fills. */
  setVisible(visible: boolean): void {
    this.styler.visible = visible;
  }

  /**
   * Clear all ClipEdges instances when a model is unloaded or a new model
   * is about to load. The styler and fill-style registration stay alive so
   * the next setModel() + createForPlane() pair works immediately.
   */
  reset(): void {
    try {
      for (const [id, edges] of [...this.styler.list]) {
        try { edges.dispose(); } catch { /* noop */ }
        this.styler.list.delete(id);
      }
    } catch { /* noop */ }
    this.modelId = null;
  }

  dispose(): void {
    this.reset();
    try { this.styler.dispose(); } catch { /* noop */ }
  }
}
