import * as THREE from 'three';
import * as OBC from '@thatopen/components';
import type { ClipAxis, ClipPlaneState } from '../../store/useStore';
import { axisNormal, projectOntoAxis, axisOriginForOffset } from './clipPlaneMath';
import type { ClipEdgesService } from './clipEdgesService';

const PLANE_TAG_PREFIX = 'ifc-viewer/clip/';

/** Plane-helper restyle, replacing OBC's magenta debug default (0xBB00FF @ 0.2). */
const PLANE_HELPER_COLOR = 0x0070f3; // app accent blue
const PLANE_HELPER_OPACITY = 0.12;

/**
 * Scratch vectors for the offset-only sync path, which runs once per frame
 * while a clip slider is dragged. Reuse is safe there because
 * SimplePlane.setFromNormalAndCoplanarPoint copies both arguments. Never pass
 * these to clipper.createFromNormalAndCoplanarPoint - the created plane
 * retains the exact Vector3 references it is given.
 */
const _scratchNormal = new THREE.Vector3();
const _scratchOrigin = new THREE.Vector3();

/** Allocation-free twin of clipPlaneMath.axisNormal - writes into `out`. */
function setAxisNormal(out: THREE.Vector3, axis: ClipAxis, inverted: boolean): THREE.Vector3 {
  const sign = inverted ? 1 : -1;
  return out.set(
    axis === 'x' ? sign : 0,
    axis === 'y' ? sign : 0,
    axis === 'z' ? sign : 0,
  );
}

/** Allocation-free twin of clipPlaneMath.axisOriginForOffset - writes into `out`. */
function setAxisOriginForOffset(
  out: THREE.Vector3,
  axis: ClipAxis,
  centre: THREE.Vector3,
  offset: number,
): THREE.Vector3 {
  out.copy(centre);
  if (axis === 'x') out.x += offset;
  else if (axis === 'y') out.y += offset;
  else out.z += offset;
  return out;
}

export interface ClipPlaneHooks {
  onOffsetChanged: (id: string, offset: number) => void;
  clipEdgesService?: ClipEdgesService;
}

interface PlaneEntry {
  uuid: string | null;
  applied: ClipPlaneState | null;
  dragUnsub: (() => void) | null;
}

/**
 * Manages up to N simultaneous OBC.Clipper section planes, one per
 * ClipPlaneState entry. Replaces the old single-plane controller.
 *
 * Usage (identical to the old API, just passing an array):
 *   const ctrl = new ClipPlaneController(clipper, world, centre, hooks);
 *   ctrl.sync(clipPlanes);   // call on every clipPlanes state change
 *   ctrl.dispose();          // call on viewer unmount
 */
export class ClipPlaneController {
  private readonly clipper: OBC.Clipper;
  private readonly world: OBC.World;
  private readonly centre: THREE.Vector3;
  private readonly planeSize: number;
  private readonly hooks: ClipPlaneHooks;
  private entries = new Map<string, PlaneEntry>();

  constructor(
    clipper: OBC.Clipper,
    world: OBC.World,
    centre: THREE.Vector3,
    modelSize: THREE.Vector3,
    hooks: ClipPlaneHooks,
  ) {
    this.clipper = clipper;
    this.world = world;
    this.centre = centre.clone();
    // Side length of the plane quad. The model diagonal covers any
    // axis-aligned cross-section, so the indicator always spans the model.
    this.planeSize = Math.max(1, modelSize.length() * 1.1);
    this.hooks = hooks;
    this.clipper.orthogonalY = true;
    // OBC rescales plane helpers with camera distance by default, which makes
    // the quad shrink to nothing as you zoom toward the cut. Fixed size instead.
    this.clipper.autoScalePlanes = false;
    // Restyle the shared plane-helper material in place (applies to every
    // plane this clipper creates) while keeping OBC's DoubleSide + transparent
    // flags. Nothing in the app calls clipper.setup()/config, so the magenta
    // default is never re-applied.
    this.clipper.material.color.setHex(PLANE_HELPER_COLOR);
    this.clipper.material.opacity = PLANE_HELPER_OPACITY;
  }

  /** Apply the given array of plane states. Idempotent - diffs prev/next. */
  sync(nextPlanes: ClipPlaneState[]): void {
    const nextIds = new Set(nextPlanes.map(p => p.id));

    // Remove planes whose ids are no longer in the list
    for (const [id, entry] of this.entries) {
      if (!nextIds.has(id)) {
        this._destroyEntry(entry);
        this.entries.delete(id);
      }
    }

    // Sync each plane in the new list
    for (const next of nextPlanes) {
      if (!this.entries.has(next.id)) {
        this.entries.set(next.id, { uuid: null, applied: null, dragUnsub: null });
      }
      this._syncPlane(next, this.entries.get(next.id)!);
    }

    // Toggle global clipper based on whether any plane is active
    this.clipper.enabled = nextPlanes.some(p => p.enabled);
  }

  private _syncPlane(next: ClipPlaneState, entry: PlaneEntry): void {
    const prev = entry.applied;

    if (!next.enabled) {
      if (entry.uuid) this._destroyPlaneUUID(entry);
      entry.applied = { ...next };
      return;
    }

    const axisChanged = !prev || prev.axis !== next.axis;
    const invertChanged = !prev || prev.inverted !== next.inverted;
    const offsetChanged = !prev || prev.offset !== next.offset;

    if (!entry.uuid || axisChanged || invertChanged) {
      this._destroyPlaneUUID(entry);
      // Fresh vectors required here: the SimplePlane constructor retains the
      // references it receives (scratch vectors would alias across planes).
      const normal = axisNormal(next.axis, next.inverted);
      const origin = axisOriginForOffset(next.axis, this.centre, next.offset);
      const uuid = this.clipper.createFromNormalAndCoplanarPoint(this.world, normal, origin);
      entry.uuid = uuid;
      this.hooks.clipEdgesService?.createForPlane(uuid);

      const plane = this.clipper.list.get(uuid);
      if (plane) {
        plane.type = PLANE_TAG_PREFIX + next.id;
        plane.size = this.planeSize;
        const id = next.id;
        const handler = () => {
          if (!entry.uuid) return;
          const live = this.clipper.list.get(entry.uuid);
          if (!live) return;
          const offset = projectOntoAxis(next.axis, live.origin, this.centre);
          this.hooks.onOffsetChanged(id, offset);
        };
        plane.onDraggingEnded.add(handler);
        entry.dragUnsub = () => plane.onDraggingEnded.remove(handler);
      }
    } else if (offsetChanged && entry.uuid) {
      const plane = this.clipper.list.get(entry.uuid);
      if (plane) {
        // Per-frame path during slider drags - reuse the module scratch
        // vectors (setFromNormalAndCoplanarPoint copies; see note above).
        plane.setFromNormalAndCoplanarPoint(
          setAxisNormal(_scratchNormal, next.axis, next.inverted),
          setAxisOriginForOffset(_scratchOrigin, next.axis, this.centre, next.offset),
        );
      }
    }

    entry.applied = { ...next };
  }

  private _destroyPlaneUUID(entry: PlaneEntry): void {
    if (entry.dragUnsub) {
      try { entry.dragUnsub(); } catch { /* noop */ }
      entry.dragUnsub = null;
    }
    if (!entry.uuid) return;
    try { void this.clipper.delete(this.world as unknown as OBC.World, entry.uuid); } catch { /* noop */ }
    entry.uuid = null;
  }

  private _destroyEntry(entry: PlaneEntry): void {
    this._destroyPlaneUUID(entry);
    entry.applied = null;
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      this._destroyEntry(entry);
    }
    this.entries.clear();
    this.clipper.enabled = false;
  }
}
