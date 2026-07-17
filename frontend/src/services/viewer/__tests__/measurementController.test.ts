import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  linearDistance,
  polygonPerimeter,
  newellNormal,
  polygonArea,
  formatLength,
  formatArea,
  formatCoordinate,
  formatMeasurementValue,
  snapToNearest,
  planeBasisFromNormal,
  buildBoxCorners,
  projectPointToPlane,
  MeasurementController,
} from '../measurementController';
import type { CommittedMeasurement } from '../measurementController';

// Helpers
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

// ────────────────────────────────────────────────────────────────────────────
// linearDistance
// ────────────────────────────────────────────────────────────────────────────
describe('linearDistance', () => {
  it('unit distance along X', () => {
    expect(approx(linearDistance(v(0, 0, 0), v(1, 0, 0)), 1)).toBe(true);
  });

  it('unit distance along Y', () => {
    expect(approx(linearDistance(v(0, 0, 0), v(0, 1, 0)), 1)).toBe(true);
  });

  it('unit distance along Z', () => {
    expect(approx(linearDistance(v(0, 0, 0), v(0, 0, 1)), 1)).toBe(true);
  });

  it('3-4-5 right triangle hypotenuse', () => {
    expect(approx(linearDistance(v(0, 0, 0), v(3, 4, 0)), 5)).toBe(true);
  });

  it('zero distance', () => {
    expect(linearDistance(v(5, 5, 5), v(5, 5, 5))).toBe(0);
  });

  it('negative coordinates', () => {
    expect(approx(linearDistance(v(-1, 0, 0), v(1, 0, 0)), 2)).toBe(true);
  });

  it('commutative', () => {
    const a = v(1, 2, 3);
    const b = v(4, 6, 3);
    expect(approx(linearDistance(a, b), linearDistance(b, a))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// polygonPerimeter
// ────────────────────────────────────────────────────────────────────────────
describe('polygonPerimeter', () => {
  it('unit square perimeter = 4', () => {
    const pts = [v(0, 0, 0), v(1, 0, 0), v(1, 1, 0), v(0, 1, 0)];
    expect(approx(polygonPerimeter(pts), 4)).toBe(true);
  });

  it('equilateral triangle side-1 perimeter = 3', () => {
    const h = Math.sqrt(3) / 2;
    const pts = [v(0, 0, 0), v(1, 0, 0), v(0.5, h, 0)];
    expect(approx(polygonPerimeter(pts), 3, 1e-5)).toBe(true);
  });

  it('fewer than 2 points → 0', () => {
    expect(polygonPerimeter([v(0, 0, 0)])).toBe(0);
    expect(polygonPerimeter([])).toBe(0);
  });

  it('two identical points → 0 (degenerate edge)', () => {
    expect(polygonPerimeter([v(0, 0, 0), v(0, 0, 0)])).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// newellNormal
// ────────────────────────────────────────────────────────────────────────────
describe('newellNormal', () => {
  it('xy-plane polygon → normal parallel to ±Z', () => {
    const pts = [v(0, 0, 0), v(1, 0, 0), v(1, 1, 0), v(0, 1, 0)];
    const n = newellNormal(pts);
    expect(n.x).toBeCloseTo(0, 5);
    expect(n.y).toBeCloseTo(0, 5);
    expect(Math.abs(n.z)).toBeCloseTo(1, 5);
  });

  it('xz-plane polygon → normal parallel to ±Y', () => {
    const pts = [v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)];
    const n = newellNormal(pts);
    expect(n.x).toBeCloseTo(0, 5);
    expect(Math.abs(n.y)).toBeCloseTo(1, 5);
    expect(n.z).toBeCloseTo(0, 5);
  });

  it('yz-plane polygon → normal parallel to ±X', () => {
    const pts = [v(0, 0, 0), v(0, 1, 0), v(0, 1, 1), v(0, 0, 1)];
    const n = newellNormal(pts);
    expect(Math.abs(n.x)).toBeCloseTo(1, 5);
    expect(n.y).toBeCloseTo(0, 5);
    expect(n.z).toBeCloseTo(0, 5);
  });

  it('returns a unit vector', () => {
    const pts = [v(0, 0, 0), v(3, 0, 0), v(3, 4, 0), v(0, 4, 0)];
    const n = newellNormal(pts);
    expect(n.length()).toBeCloseTo(1, 5);
  });

  it('fewer than 3 points → fallback (0,1,0)', () => {
    expect(newellNormal([v(0, 0, 0), v(1, 0, 0)]).y).toBe(1);
    expect(newellNormal([]).y).toBe(1);
  });

  it('collinear points → fallback (0,1,0)', () => {
    const pts = [v(0, 0, 0), v(1, 0, 0), v(2, 0, 0)];
    const n = newellNormal(pts);
    expect(n.y).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// polygonArea
// ────────────────────────────────────────────────────────────────────────────
describe('polygonArea', () => {
  it('unit square → area 1', () => {
    const pts = [v(0, 0, 0), v(1, 0, 0), v(1, 1, 0), v(0, 1, 0)];
    expect(approx(polygonArea(pts), 1, 1e-5)).toBe(true);
  });

  it('2×3 rectangle → area 6', () => {
    const pts = [v(0, 0, 0), v(2, 0, 0), v(2, 3, 0), v(0, 3, 0)];
    expect(approx(polygonArea(pts), 6, 1e-5)).toBe(true);
  });

  it('right triangle 3×4 → area 6', () => {
    const pts = [v(0, 0, 0), v(3, 0, 0), v(0, 4, 0)];
    expect(approx(polygonArea(pts), 6, 1e-5)).toBe(true);
  });

  it('equilateral triangle side-2 → area √3 ≈ 1.732', () => {
    const h = Math.sqrt(3);
    const pts = [v(0, 0, 0), v(2, 0, 0), v(1, h, 0)];
    expect(approx(polygonArea(pts), Math.sqrt(3), 1e-5)).toBe(true);
  });

  it('fewer than 3 points → 0', () => {
    expect(polygonArea([v(0, 0, 0), v(1, 0, 0)])).toBe(0);
    expect(polygonArea([v(0, 0, 0)])).toBe(0);
    expect(polygonArea([])).toBe(0);
  });

  it('polygon on xz-plane (not xy) gives correct area', () => {
    // unit square on xz plane
    const pts = [v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)];
    expect(approx(polygonArea(pts), 1, 1e-5)).toBe(true);
  });

  it('non-planar polygon (slight warp) gives a reasonable approximation', () => {
    // slightly warped unit square: one corner lifted 0.05 m - area should
    // still be close to 1.0 (within 5%)
    const pts = [v(0, 0, 0), v(1, 0, 0), v(1, 1, 0.05), v(0, 1, 0)];
    const area = polygonArea(pts);
    expect(area).toBeGreaterThan(0.9);
    expect(area).toBeLessThan(1.1);
  });

  it('zero-area degenerate (all collinear) → ≈ 0', () => {
    const pts = [v(0, 0, 0), v(1, 0, 0), v(2, 0, 0)];
    expect(polygonArea(pts)).toBeCloseTo(0, 5);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// formatLength
// ────────────────────────────────────────────────────────────────────────────
describe('formatLength', () => {
  it('1.0 m → "1.000 m"', () => {
    expect(formatLength(1.0, 'm')).toBe('1.000 m');
  });

  it('0 m → "0.000 m"', () => {
    expect(formatLength(0, 'm')).toBe('0.000 m');
  });

  it('2.5 m → "2.500 m"', () => {
    expect(formatLength(2.5, 'm')).toBe('2.500 m');
  });

  it('1.0 m in mm → "1000.0 mm"', () => {
    expect(formatLength(1.0, 'mm')).toBe('1000.0 mm');
  });

  it('0.001 m in mm → "1.0 mm"', () => {
    expect(formatLength(0.001, 'mm')).toBe('1.0 mm');
  });

  it('1.0 m in ft → correct conversion', () => {
    const result = formatLength(1.0, 'ft');
    expect(result).toMatch(/3\.28\d.*ft/);
  });

  it('0.3048 m ≈ 1 ft', () => {
    const result = formatLength(0.3048, 'ft');
    expect(result).toMatch(/1\.00.*ft/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// formatArea
// ────────────────────────────────────────────────────────────────────────────
describe('formatArea', () => {
  it('1.0 m² → "1.000 m²"', () => {
    expect(formatArea(1.0, 'm')).toBe('1.000 m²');
  });

  it('0 m² → "0.000 m²"', () => {
    expect(formatArea(0, 'm')).toBe('0.000 m²');
  });

  it('1.0 m² in mm² → "1000000 mm²"', () => {
    expect(formatArea(1.0, 'mm')).toBe('1000000 mm²');
  });

  it('0.0001 m² in mm² → "100 mm²"', () => {
    expect(formatArea(0.0001, 'mm')).toBe('100 mm²');
  });

  it('1.0 m² in ft² → correct conversion', () => {
    const result = formatArea(1.0, 'ft');
    expect(result).toMatch(/10\.76.*ft²/);
  });

  it('unit round-trip: area(formatArea) output is correctly labelled', () => {
    const out = formatArea(4.0, 'm');
    expect(out).toBe('4.000 m²');
  });
});

describe('construction measurement formatting', () => {
  const measurement = (
    kind: CommittedMeasurement['kind'],
    value: number,
  ): CommittedMeasurement => ({
    id: kind,
    kind,
    value,
    points: [v(0, 0, 0), v(0, value, 0)],
  });

  it('formats angle labels as degrees rather than square units', () => {
    expect(formatMeasurementValue(measurement('angle', 45.25), 'm')).toBe('45.3°');
  });

  it('formats height and clearance as lengths', () => {
    expect(formatMeasurementValue(measurement('height', 2.5), 'm')).toBe('2.500 m');
    expect(formatMeasurementValue(measurement('clearance', 0.125), 'mm')).toBe('125.0 mm');
  });

  it('formats all project coordinate axes in the selected unit', () => {
    expect(formatCoordinate(v(1, 2, 3), 'mm')).toBe('X 1000.0 · Y 2000.0 · Z 3000.0 mm');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// snapToNearest
// ────────────────────────────────────────────────────────────────────────────
describe('snapToNearest', () => {
  const THRESHOLD = 0.1;

  it('returns null when candidates list is empty', () => {
    expect(snapToNearest(v(0, 0, 0), [], THRESHOLD)).toBeNull();
  });

  it('returns null when threshold is zero', () => {
    expect(snapToNearest(v(0, 0, 0), [v(0, 0, 0)], 0)).toBeNull();
  });

  it('snaps to exact match', () => {
    const cand = v(1, 2, 3);
    const result = snapToNearest(v(1, 2, 3), [cand], THRESHOLD);
    expect(result).not.toBeNull();
    expect(result!.distanceTo(cand)).toBe(0);
  });

  it('snaps to candidate within threshold', () => {
    const cand = v(0, 0, 0);
    const pos = v(0.05, 0, 0); // 0.05 m away, within 0.1 m threshold
    const result = snapToNearest(pos, [cand], THRESHOLD);
    expect(result).not.toBeNull();
  });

  it('returns null when candidate is outside threshold', () => {
    const cand = v(0, 0, 0);
    const pos = v(0.2, 0, 0); // 0.2 m away, outside 0.1 m threshold
    expect(snapToNearest(pos, [cand], THRESHOLD)).toBeNull();
  });

  it('picks the nearest of multiple candidates', () => {
    const near = v(0.04, 0, 0);
    const far = v(0.09, 0, 0);
    const pos = v(0, 0, 0);
    const result = snapToNearest(pos, [far, near], THRESHOLD);
    expect(result).not.toBeNull();
    expect(result!.distanceTo(near)).toBe(0);
  });

  it('ignores candidates outside threshold even when they are the nearest', () => {
    const pos = v(0, 0, 0);
    const c1 = v(0.5, 0, 0);
    const c2 = v(1.0, 0, 0);
    expect(snapToNearest(pos, [c1, c2], THRESHOLD)).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// planeBasisFromNormal + buildBoxCorners (box-mode rectangle helpers)
// ────────────────────────────────────────────────────────────────────────────
describe('planeBasisFromNormal', () => {
  it('Y-up normal (floor/ceiling) → X & Z basis', () => {
    const { u, v: vv } = planeBasisFromNormal(v(0, 1, 0));
    expect(u.equals(v(1, 0, 0))).toBe(true);
    expect(vv.equals(v(0, 0, 1))).toBe(true);
  });

  it('X-axis normal (wall facing ±X) → Y & Z basis', () => {
    const { u, v: vv } = planeBasisFromNormal(v(1, 0, 0));
    expect(u.equals(v(0, 1, 0))).toBe(true);
    expect(vv.equals(v(0, 0, 1))).toBe(true);
  });

  it('Z-axis normal (wall facing ±Z) → X & Y basis', () => {
    const { u, v: vv } = planeBasisFromNormal(v(0, 0, 1));
    expect(u.equals(v(1, 0, 0))).toBe(true);
    expect(vv.equals(v(0, 1, 0))).toBe(true);
  });

  it('mostly-Y normal still picks X/Z basis', () => {
    const { u, v: vv } = planeBasisFromNormal(v(0.2, 0.9, 0.1));
    expect(u.equals(v(1, 0, 0))).toBe(true);
    expect(vv.equals(v(0, 0, 1))).toBe(true);
  });
});

describe('buildBoxCorners', () => {
  it('floor rectangle: 4×3 m on XZ plane', () => {
    const a = v(0, 0, 0);
    const b = v(4, 0, 3);
    const corners = buildBoxCorners(a, b, v(0, 1, 0));
    expect(corners[0].equals(v(0, 0, 0))).toBe(true);
    expect(corners[1].equals(v(4, 0, 0))).toBe(true);
    expect(corners[2].equals(v(4, 0, 3))).toBe(true);
    expect(corners[3].equals(v(0, 0, 3))).toBe(true);
    expect(polygonArea(corners)).toBeCloseTo(12, 5);
  });

  it('wall rectangle: 2×3 m on YZ plane', () => {
    const a = v(5, 0, 0);
    const b = v(5, 2, 3);
    const corners = buildBoxCorners(a, b, v(1, 0, 0));
    expect(polygonArea(corners)).toBeCloseTo(6, 5);
    // All corners share the same X - rectangle lies in the YZ plane.
    expect(corners.every((c) => Math.abs(c.x - 5) < 1e-9)).toBe(true);
  });

  it('negative diagonal still yields a positive area', () => {
    const corners = buildBoxCorners(v(2, 0, 2), v(0, 0, 0), v(0, 1, 0));
    expect(polygonArea(corners)).toBeCloseTo(4, 5);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// MeasurementController interaction: snap priority + provenance voting
// ────────────────────────────────────────────────────────────────────────────
function makeController(): MeasurementController {
  // The model is only used for raycasting by consumers, never by the click /
  // move / commit paths under test, so an empty stub is safe here.
  const model = {} as ConstructorParameters<typeof MeasurementController>[1];
  return new MeasurementController(new THREE.Scene(), model, { onChange: () => {} });
}

describe('MeasurementController snap priority', () => {
  /** Commit one measurement so its endpoints become snap anchors. */
  function withCommittedMeasurement(): MeasurementController {
    const controller = makeController();
    controller.setMode('linear');
    controller.handleClick(v(0, 0, 0));
    controller.handleClick(v(1, 0, 0));
    expect(controller.snapshot().committed).toHaveLength(1);
    return controller;
  }

  it('exposes pending and committed endpoints as snap anchors', () => {
    // The viewer ranks these in screen space alongside real geometry, so they
    // have to be reachable from outside.
    const controller = withCommittedMeasurement();
    const anchors = controller.getSnapAnchors();
    expect(anchors.some((a) => a.equals(v(0, 0, 0)))).toBe(true);
    expect(anchors.some((a) => a.equals(v(1, 0, 0)))).toBe(true);
  });

  it('defers to the caller-resolved snap instead of re-snapping in world space', () => {
    // The caller resolves snaps in SCREEN space against geometry and our own
    // anchors, so it already knows whether an endpoint should win. Overriding
    // it here is what let an endpoint 10 cm away steal an exact vertex sitting
    // under the cursor - and 10 cm is sub-pixel zoomed out, half the screen
    // zoomed in.
    const controller = withCommittedMeasurement();
    const candidate = {
      point: v(0.05, 0, 0.05),
      kind: 'vertex' as const,
      exact: true,
      source: 'engine-point',
    };
    controller.handleMove(v(0.02, 0, 0), candidate);
    expect(controller.snapshot().snapFeedback?.kind).toBe('vertex');

    controller.handleClick(v(0.02, 0, 0), null, candidate);
    const pending = controller.snapshot().pending;
    expect(pending).toHaveLength(1);
    expect(pending[0].equals(v(0.05, 0, 0.05))).toBe(true);
  });

  it('still honours an endpoint when the caller ranks one as the winner', () => {
    // Chaining dimensions and closing polygons must stay exact - the anchor
    // just competes on screen distance now rather than trumping everything.
    const controller = withCommittedMeasurement();
    const candidate = {
      point: v(0, 0, 0),
      kind: 'endpoint' as const,
      exact: true,
      source: 'measurement-endpoint',
    };
    controller.handleMove(v(0.02, 0, 0), candidate);
    expect(controller.snapshot().snapFeedback?.kind).toBe('endpoint');

    controller.handleClick(v(0.02, 0, 0), null, candidate);
    expect(controller.snapshot().pending[0].equals(v(0, 0, 0))).toBe(true);
  });

  it('falls back to a world-space endpoint snap when the caller resolves nothing', () => {
    const controller = withCommittedMeasurement();
    controller.handleMove(v(0.02, 0, 0));
    expect(controller.snapshot().snapFeedback?.kind).toBe('endpoint');

    controller.handleClick(v(0.02, 0, 0));
    expect(controller.snapshot().pending[0].equals(v(0, 0, 0))).toBe(true);
  });

  it('does not treat the in-flight start point as a snap anchor', () => {
    // Otherwise a second click inside the (screen-space) snap radius of the
    // first snaps back onto it, the duplicate-click guard eats the click, and
    // a short measurement can never be placed at all.
    const controller = makeController();
    controller.setMode('linear');
    controller.handleClick(v(5, 0, 0));
    expect(controller.getSnapAnchors()).toEqual([]);

    controller.handleClick(v(5.01, 0, 0));
    expect(controller.snapshot().committed).toHaveLength(1);
    expect(controller.snapshot().committed[0].value).toBeCloseTo(0.01, 6);
  });

  it('ignores a stale preview when the caller explicitly resolved no snap', () => {
    // snapTarget lags the cursor whenever a hover raycast is skipped (camera
    // settling, quality gating, coalesced moves). Inheriting it on click would
    // commit the corner the user hovered a moment ago instead of the bare face
    // they actually clicked.
    const controller = withCommittedMeasurement();
    controller.handleMove(v(0.02, 0, 0), {
      point: v(0, 0, 0),
      kind: 'endpoint',
      exact: true,
      source: 'measurement-endpoint',
    });
    expect(controller.snapshot().snapFeedback?.kind).toBe('endpoint');

    // Cursor moved to bare geometry; the viewer resolved and found nothing.
    controller.handleClick(v(9, 0, 9), null, null);
    expect(controller.snapshot().pending[0].equals(v(9, 0, 9))).toBe(true);
  });

  it('does not re-snap in world space when the caller resolved nothing', () => {
    // The committed endpoint at the origin is 2 cm away - inside the old
    // world-metre threshold - but the caller already ranked it in screen space
    // and rejected it, so it must not be resurrected here.
    const controller = withCommittedMeasurement();
    controller.handleClick(v(0.02, 0, 0), null, null);
    expect(controller.snapshot().pending[0].equals(v(0.02, 0, 0))).toBe(true);
  });

  it('commits exactly the point the preview showed', () => {
    // The invariant that matters to users: the dot you see is the point you get.
    const controller = withCommittedMeasurement();
    const candidate = {
      point: v(0.05, 0, 0.05),
      kind: 'vertex' as const,
      exact: true,
      source: 'engine-point',
    };
    controller.handleMove(v(0.02, 0, 0), candidate);
    const previewed = controller.snapshot().snapFeedback?.point.clone();
    controller.handleClick(v(0.02, 0, 0), null, candidate);
    expect(previewed).toBeDefined();
    expect(controller.snapshot().pending[0].equals(previewed!)).toBe(true);
  });
});

describe('MeasurementController provenance exactness vote', () => {
  it('one exact snap + one raw unsnapped pick is NOT recorded as exact', () => {
    const controller = makeController();
    controller.setMode('linear');
    const exactSnap = {
      point: v(0, 0, 0),
      kind: 'vertex' as const,
      exact: true,
      source: 'triangle-vertex',
    };
    controller.handleClick(v(0, 0, 0), null, exactSnap);
    controller.handleClick(v(5, 0, 0)); // raw pick, far from any snap candidate
    const committed = controller.snapshot().committed;
    expect(committed).toHaveLength(1);
    expect(committed[0].exact).toBe(false);
  });

  it('keeps exact provenance when every pick is an exact snap', () => {
    const controller = makeController();
    controller.setMode('linear');
    const snapA = { point: v(0, 0, 0), kind: 'vertex' as const, exact: true, source: 'triangle-vertex' };
    const snapB = { point: v(5, 0, 0), kind: 'vertex' as const, exact: true, source: 'triangle-vertex' };
    controller.handleClick(v(0, 0, 0), null, snapA);
    controller.handleClick(v(5, 0, 0), null, snapB);
    const committed = controller.snapshot().committed;
    expect(committed).toHaveLength(1);
    expect(committed[0].exact).toBe(true);
  });
});

describe('projectPointToPlane', () => {
  it('point on plane returns itself', () => {
    const p = v(1, 0, 1);
    const projected = projectPointToPlane(p, v(0, 0, 0), v(0, 1, 0));
    expect(projected.equals(p)).toBe(true);
  });

  it('point above plane snaps down to the plane', () => {
    const projected = projectPointToPlane(v(2, 5, 3), v(0, 0, 0), v(0, 1, 0));
    expect(projected.y).toBeCloseTo(0, 5);
    expect(projected.x).toBe(2);
    expect(projected.z).toBe(3);
  });

  it('plane at y=2 catches points correctly', () => {
    const projected = projectPointToPlane(v(1, 10, 4), v(0, 2, 0), v(0, 1, 0));
    expect(projected.y).toBeCloseTo(2, 5);
  });
});
