import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import { SectionBoxController } from '../sectionBoxController';
import type * as OBC from '@thatopen/components';

// ─── Minimal OBC.Clipper mock ─────────────────────────────────────────────────

function makeClipperMock() {
  const created: Array<{ normal: THREE.Vector3; origin: THREE.Vector3 }> = [];
  const updated: Array<{ normal: THREE.Vector3; origin: THREE.Vector3 }> = [];
  const deleted: string[] = [];
  const planes = new Map<string, {
    visible: boolean;
    normal: THREE.Vector3;
    origin: THREE.Vector3;
    setFromNormalAndCoplanarPoint: ReturnType<typeof vi.fn>;
  }>();
  let idCounter = 0;

  return {
    enabled: false,
    created,
    updated,
    deleted,
    planes,
    createFromNormalAndCoplanarPoint: vi.fn((
      _world: unknown,
      normal: THREE.Vector3,
      origin: THREE.Vector3,
    ) => {
      const uuid = `plane-${++idCounter}`;
      created.push({ normal: normal.clone(), origin: origin.clone() });
      const plane = {
        visible: true,
        normal: normal.clone(),
        origin: origin.clone(),
        setFromNormalAndCoplanarPoint: vi.fn((nextNormal: THREE.Vector3, nextOrigin: THREE.Vector3) => {
          plane.normal.copy(nextNormal);
          plane.origin.copy(nextOrigin);
          updated.push({ normal: nextNormal.clone(), origin: nextOrigin.clone() });
        }),
      };
      planes.set(uuid, plane);
      return uuid;
    }),
    delete: vi.fn((_world: unknown, uuid: string) => {
      deleted.push(uuid);
      planes.delete(uuid);
    }),
    list: {
      get: (uuid: string) => planes.get(uuid),
    },
  };
}

function makeWorldMock() {
  return {} as unknown as OBC.World;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SectionBoxController', () => {
  let clipper: ReturnType<typeof makeClipperMock>;
  let world: OBC.World;
  let ctrl: SectionBoxController;

  beforeEach(() => {
    clipper = makeClipperMock();
    world = makeWorldMock();
    ctrl = new SectionBoxController(
      clipper as unknown as OBC.Clipper,
      world,
    );
  });

  it('starts disabled', () => {
    expect(ctrl.enabled).toBe(false);
    expect(ctrl.bounds).toBeNull();
    expect(clipper.createFromNormalAndCoplanarPoint).not.toHaveBeenCalled();
  });

  it('enable() creates exactly 6 planes', () => {
    const box = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 3, 1));
    ctrl.enable(box);
    expect(ctrl.enabled).toBe(true);
    expect(clipper.createFromNormalAndCoplanarPoint).toHaveBeenCalledTimes(6);
  });

  it('enable() sets clipper.enabled = true', () => {
    const box = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(2, 2, 2));
    ctrl.enable(box);
    expect(clipper.enabled).toBe(true);
  });

  it('enable() creates all 6 axis normals', () => {
    const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    ctrl.enable(box);
    const normals = clipper.created.map((c) => c.normal);
    const hasNormal = (nx: number, ny: number, nz: number) =>
      normals.some((n) => Math.abs(n.x - nx) < 1e-6 && Math.abs(n.y - ny) < 1e-6 && Math.abs(n.z - nz) < 1e-6);
    expect(hasNormal(-1, 0, 0)).toBe(true); // keep x < max.x
    expect(hasNormal(1, 0, 0)).toBe(true);  // keep x > min.x
    expect(hasNormal(0, -1, 0)).toBe(true); // keep y < max.y
    expect(hasNormal(0, 1, 0)).toBe(true);  // keep y > min.y
    expect(hasNormal(0, 0, -1)).toBe(true); // keep z < max.z
    expect(hasNormal(0, 0, 1)).toBe(true);  // keep z > min.z
  });

  it('enable() places planes at box faces', () => {
    const min = new THREE.Vector3(-2, -1, -3);
    const max = new THREE.Vector3(2, 4, 3);
    ctrl.enable(new THREE.Box3(min, max));
    const origins = clipper.created.map((c) => c.origin);
    const hasOrigin = (x: number, y: number, z: number) =>
      origins.some((o) => Math.abs(o.x - x) < 1e-6 && Math.abs(o.y - y) < 1e-6 && Math.abs(o.z - z) < 1e-6);
    expect(hasOrigin(2, 0, 0)).toBe(true);   // +X face at max.x
    expect(hasOrigin(-2, 0, 0)).toBe(true);  // -X face at min.x
    expect(hasOrigin(0, 4, 0)).toBe(true);   // +Y face at max.y
    expect(hasOrigin(0, -1, 0)).toBe(true);  // -Y face at min.y
    expect(hasOrigin(0, 0, 3)).toBe(true);   // +Z face at max.z
    expect(hasOrigin(0, 0, -3)).toBe(true);  // -Z face at min.z
  });

  it('disable() removes all 6 planes', () => {
    ctrl.enable(new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)));
    ctrl.disable();
    expect(ctrl.enabled).toBe(false);
    expect(clipper.delete).toHaveBeenCalledTimes(6);
  });

  it('toggle() enables when disabled', () => {
    const box = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 1));
    ctrl.toggle(box);
    expect(ctrl.enabled).toBe(true);
  });

  it('toggle() disables when enabled', () => {
    const box = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 1));
    ctrl.enable(box);
    ctrl.toggle();
    expect(ctrl.enabled).toBe(false);
  });

  it('setBounds() while enabled updates the stable 6 planes in place', () => {
    const box1 = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    ctrl.enable(box1);
    expect(clipper.createFromNormalAndCoplanarPoint).toHaveBeenCalledTimes(6);

    const box2 = new THREE.Box3(new THREE.Vector3(-5, -5, -5), new THREE.Vector3(5, 5, 5));
    ctrl.setBounds(box2);
    expect(clipper.delete).not.toHaveBeenCalled();
    expect(clipper.createFromNormalAndCoplanarPoint).toHaveBeenCalledTimes(6);
    expect(clipper.updated).toHaveLength(6);
    expect(clipper.planes.get('plane-1')?.origin.x).toBe(5);
    expect(clipper.planes.get('plane-2')?.origin.x).toBe(-5);
  });

  it('does not touch plane equations when identical bounds are republished', () => {
    const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    ctrl.enable(box);
    ctrl.setBounds(box.clone());
    ctrl.enable(box.clone());

    expect(clipper.createFromNormalAndCoplanarPoint).toHaveBeenCalledTimes(6);
    expect(clipper.updated).toHaveLength(0);
    expect(clipper.delete).not.toHaveBeenCalled();
  });

  it('setBounds() while disabled does NOT create planes', () => {
    const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    ctrl.setBounds(box);
    expect(clipper.createFromNormalAndCoplanarPoint).not.toHaveBeenCalled();
    expect(ctrl.bounds).not.toBeNull();
  });

  it('enable() without prior bounds is a no-op', () => {
    ctrl.enable();
    expect(ctrl.enabled).toBe(false);
    expect(clipper.createFromNormalAndCoplanarPoint).not.toHaveBeenCalled();
  });

  it('bounds getter returns a clone (not the internal ref)', () => {
    const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    ctrl.enable(box);
    const b = ctrl.bounds!;
    b.min.set(99, 99, 99);
    expect(ctrl.bounds!.min.x).toBe(-1);
  });

  it('dispose() removes planes and clears state', () => {
    ctrl.enable(new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 1)));
    ctrl.dispose();
    expect(ctrl.enabled).toBe(false);
    expect(ctrl.bounds).toBeNull();
    expect(clipper.delete).toHaveBeenCalledTimes(6);
  });

  it('hides drag handles on created planes', () => {
    ctrl.enable(new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)));
    // All planes in the map should have visible = false
    const allHidden = Array.from(clipper.planes.values()).every((p) => p.visible === false);
    expect(allHidden).toBe(true);
  });
});
