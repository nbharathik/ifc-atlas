import * as THREE from 'three';
import type * as OBC from '@thatopen/components';

/**
 * Manages a 6-plane axis-aligned section box crop.
 *
 * Creates one OBC.Clipper plane per face of a THREE.Box3:
 *   ±X → keep inside x-range
 *   ±Y → keep inside y-range
 *   ±Z → keep inside z-range
 *
 * The six planes are kept separate from the user-controlled clip planes
 * managed by ClipPlaneController. ViewerPanel owns both controllers.
 */
export class SectionBoxController {
  private readonly clipper: OBC.Clipper;
  private readonly world: OBC.World;
  private _planeUUIDs: string[] = [];
  private _enabled = false;
  private _bounds: THREE.Box3 | null = null;

  constructor(clipper: OBC.Clipper, world: OBC.World) {
    this.clipper = clipper;
    this.world = world;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  get bounds(): THREE.Box3 | null {
    return this._bounds ? this._bounds.clone() : null;
  }

  /**
   * Update the clip box. If already enabled, immediately re-applies all planes
   * at the new bounds. Call before `enable()` to pre-configure bounds without
   * activating clipping yet.
   */
  setBounds(box: THREE.Box3): void {
    const next = box.clone();
    if (this._bounds?.equals(next)) return;
    this._bounds = next;
    if (this._enabled) this._applyPlanes();
  }

  /**
   * Enable the section box. Optionally accepts a new box to set first.
   * No-op if no bounds have been set and none are provided.
   */
  enable(box?: THREE.Box3): void {
    const next = box?.clone();
    const boundsChanged = !!next && !this._bounds?.equals(next);
    if (next) this._bounds = next;
    if (!this._bounds) return;
    if (this._enabled && !boundsChanged) return;
    this._enabled = true;
    this._applyPlanes();
    this.clipper.enabled = true;
  }

  /** Remove all section-box planes and disable. */
  disable(): void {
    if (!this._enabled && this._planeUUIDs.length === 0) return;
    this._enabled = false;
    this._removePlanes();
  }

  /** Toggle between enabled and disabled states. */
  toggle(box?: THREE.Box3): void {
    if (this._enabled) this.disable();
    else this.enable(box);
  }

  /** Clean up. Called on viewer unmount. */
  dispose(): void {
    this._removePlanes();
    this._bounds = null;
    this._enabled = false;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _applyPlanes(): void {
    if (!this._bounds) return;
    const { min, max } = this._bounds;

    // Six half-spaces that together define an AABB.
    // Each entry: [normal pointing into kept half-space, coplanar origin]
    const defs: Array<[THREE.Vector3, THREE.Vector3]> = [
      [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(max.x, 0, 0)], // keep x < max.x
      [new THREE.Vector3(1, 0, 0),  new THREE.Vector3(min.x, 0, 0)], // keep x > min.x
      [new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, max.y, 0)], // keep y < max.y
      [new THREE.Vector3(0, 1, 0),  new THREE.Vector3(0, min.y, 0)], // keep y > min.y
      [new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, max.z)], // keep z < max.z
      [new THREE.Vector3(0, 0, 1),  new THREE.Vector3(0, 0, min.z)], // keep z > min.z
    ];

    const previousUUIDs = this._planeUUIDs;
    const nextUUIDs: string[] = [];
    for (let index = 0; index < defs.length; index += 1) {
      const [normal, origin] = defs[index]!;
      const existingUUID = previousUUIDs[index];
      const existingPlane = existingUUID ? this.clipper.list.get(existingUUID) : undefined;
      const updatable = existingPlane as unknown as {
        visible?: boolean;
        setFromNormalAndCoplanarPoint?: (normal: THREE.Vector3, origin: THREE.Vector3) => void;
      } | undefined;

      // Bounds sliders can publish every frame. Keep the same six plane
      // objects and update their equations in place so no rendered frame sees
      // an empty/recreated section box.
      if (existingUUID && typeof updatable?.setFromNormalAndCoplanarPoint === 'function') {
        updatable.setFromNormalAndCoplanarPoint(normal, origin);
        if ('visible' in updatable) updatable.visible = false;
        nextUUIDs.push(existingUUID);
        continue;
      }

      if (existingUUID) {
        try { void this.clipper.delete(this.world as unknown as OBC.World, existingUUID); } catch { /* noop */ }
      }
      try {
        const uuid = this.clipper.createFromNormalAndCoplanarPoint(
          this.world, normal, origin,
        );
        nextUUIDs.push(uuid);
        // Hide drag handles - section-box planes are controlled programmatically.
        const plane = this.clipper.list.get(uuid);
        if (plane) {
          try {
            (plane as unknown as { visible: boolean }).visible = false;
          } catch { /* OBC API may vary */ }
        }
      } catch { /* noop - OBC guards against duplicates / invalid args */ }
    }
    for (let index = defs.length; index < previousUUIDs.length; index += 1) {
      try { void this.clipper.delete(this.world as unknown as OBC.World, previousUUIDs[index]!); } catch { /* noop */ }
    }
    this._planeUUIDs = nextUUIDs;
  }

  private _removePlanes(): void {
    for (const uuid of this._planeUUIDs) {
      try {
        void this.clipper.delete(this.world as unknown as OBC.World, uuid);
      } catch { /* noop */ }
    }
    this._planeUUIDs = [];
  }
}
