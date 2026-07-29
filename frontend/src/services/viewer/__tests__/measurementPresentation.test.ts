import * as THREE from 'three';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CommittedMeasurement, MeasurementLiveReadout } from '../measurementController';
import {
  labelAnchorWorld,
  MeasurementLabelRenderer,
  measurementsToCsv,
  toDisplayValue,
  unitLabel,
  buildMeasurementTip,
} from '../measurementPresentation';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// vi.mock is hoisted so mock factories must be self-contained via vi.hoisted.
const {
  mockSetSize,
  mockRender,
  mockDomElement,
  mockCSS2DRendererCtor,
  mockCSS2DObjectInstances,
  mockCSS2DObjectCtor,
} = vi.hoisted(() => {
  const mockSetSize = vi.fn();
  const mockRender = vi.fn();
  const mockDomElement = { style: { cssText: '' }, remove: vi.fn() };
  const mockCSS2DRendererCtor = vi.fn(() => ({
    setSize: mockSetSize,
    render: mockRender,
    domElement: mockDomElement,
  }));
  const mockCSS2DObjectInstances: Array<{
    position: { copy: ReturnType<typeof vi.fn> };
    center: { x: number; y: number };
    visible: boolean;
    element: { remove: ReturnType<typeof vi.fn> };
  }> = [];
  const mockCSS2DObjectCtor = vi.fn((el: unknown) => {
    const inst = {
      position: { copy: vi.fn() },
      center: { x: 0.5, y: 0, set: vi.fn(function(this: {x:number;y:number}, x: number, y: number) { this.x = x; this.y = y; }) },
      visible: true,
      element: { remove: vi.fn() },
    };
    void el;
    mockCSS2DObjectInstances.push(inst);
    return inst;
  });
  return {
    mockSetSize,
    mockRender,
    mockDomElement,
    mockCSS2DRendererCtor,
    mockCSS2DObjectInstances,
    mockCSS2DObjectCtor,
  };
});

vi.mock('three/examples/jsm/renderers/CSS2DRenderer.js', () => ({
  CSS2DRenderer: mockCSS2DRendererCtor,
  CSS2DObject: mockCSS2DObjectCtor,
}));

// ─── Import after mocking ─────────────────────────────────────────────────────


// ─── DOM shim for node environment ────────────────────────────────────────────
// The service calls document.createElement('div') in createLabel. Provide a
// minimal stub so tests run without jsdom.
if (typeof globalThis.document === 'undefined') {
  (globalThis as Record<string, unknown>).document = {
    createElement: () => ({
      className: '',
      appendChild: vi.fn(),
      querySelector: vi.fn(() => null),
      remove: vi.fn(),
      textContent: '',
    }),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeScene() {
  const added: unknown[] = [];
  const removed: unknown[] = [];
  return {
    add: (o: unknown) => added.push(o),
    remove: (o: unknown) => removed.push(o),
    _added: added,
    _removed: removed,
  };
}

function makeCamera(): THREE.Camera {
  return new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
}

/** Minimal container stub that satisfies HTMLElement duck-typing used by the renderer. */
function makeContainer() {
  const children: unknown[] = [];
  return {
    appendChild: (child: unknown) => children.push(child),
    contains: (node: unknown) => children.includes(node),
    clientWidth: 800,
    clientHeight: 600,
    _children: children,
  };
}

function linear(id: string, len: number): CommittedMeasurement {
  return {
    id,
    kind: 'linear',
    points: [new THREE.Vector3(0, 0, 0), new THREE.Vector3(len, 0, 0)],
    value: len,
  };
}

function area(id: string): CommittedMeasurement {
  return {
    id,
    kind: 'area',
    points: [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(2, 0, 0),
      new THREE.Vector3(2, 0, 2),
      new THREE.Vector3(0, 0, 2),
    ],
    value: 4,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MeasurementLabelRenderer', () => {
  let scene: ReturnType<typeof makeScene>;
  let container: ReturnType<typeof makeContainer>;
  let renderer: MeasurementLabelRenderer;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCSS2DObjectInstances.length = 0;
    scene = makeScene();
    container = makeContainer();
    renderer = new MeasurementLabelRenderer(
      scene as unknown as THREE.Scene,
      makeCamera(),
      container as unknown as HTMLElement,
      800,
      600,
    );
  });

  it('appends label overlay div to container', () => {
    expect(container._children).toContain(mockDomElement);
  });

  it('syncCommitted adds one CSS2DObject per measurement', () => {
    renderer.syncCommitted([linear('m1', 2)], 'm');
    expect(scene._added).toHaveLength(1);
    expect(mockCSS2DObjectInstances).toHaveLength(1);
  });

  it('syncCommitted handles multiple measurements', () => {
    renderer.syncCommitted([linear('m1', 2), area('m2')], 'm');
    expect(scene._added).toHaveLength(2);
  });

  it('syncCommitted clears stale labels when list empties', () => {
    renderer.syncCommitted([linear('m1', 1)], 'm');
    renderer.syncCommitted([], 'm');
    expect(scene._removed).toHaveLength(1);
  });

  it('syncCommitted removes stale, keeps live labels', () => {
    renderer.syncCommitted([linear('m1', 1), linear('m2', 2)], 'm');
    renderer.syncCommitted([linear('m2', 2)], 'm');
    expect(scene._removed).toHaveLength(1);
    // m2 was NOT removed
    expect(scene._added).toHaveLength(2); // both were added in first sync
  });

  it('removeById removes a single label', () => {
    renderer.syncCommitted([linear('m1', 1), linear('m2', 2)], 'm');
    renderer.removeById('m1');
    expect(scene._removed).toHaveLength(1);
  });

  it('clearAll removes all labels', () => {
    renderer.syncCommitted([linear('m1', 1), area('m2'), linear('m3', 3)], 'm');
    renderer.clearAll();
    expect(scene._removed).toHaveLength(3);
  });

  it('setVisible(false) hides all label objects', () => {
    renderer.syncCommitted([linear('m1', 1), linear('m2', 2)], 'm');
    renderer.setVisible(false);
    expect(mockCSS2DObjectInstances.every((o) => o.visible === false)).toBe(true);
  });

  it('setVisible(true) shows all label objects', () => {
    renderer.syncCommitted([linear('m1', 1)], 'm');
    renderer.setVisible(false);
    renderer.setVisible(true);
    expect(mockCSS2DObjectInstances.every((o) => o.visible === true)).toBe(true);
  });

  it('isVisible() tracks setVisible', () => {
    expect(renderer.isVisible()).toBe(true);
    renderer.setVisible(false);
    expect(renderer.isVisible()).toBe(false);
    renderer.setVisible(true);
    expect(renderer.isVisible()).toBe(true);
  });

  it('render() delegates to CSS2DRenderer each call', () => {
    renderer.render();
    renderer.render();
    expect(mockRender).toHaveBeenCalledTimes(2);
  });

  it('setSize() passes dimensions to CSS2DRenderer', () => {
    renderer.setSize(1920, 1080);
    expect(mockSetSize).toHaveBeenCalledWith(1920, 1080);
  });

  it('dispose() removes the overlay element from DOM', () => {
    renderer.dispose();
    expect(mockDomElement.remove).toHaveBeenCalled();
  });

  it('dispose() removes all scene labels', () => {
    renderer.syncCommitted([linear('m1', 1), area('m2')], 'm');
    renderer.dispose();
    expect(scene._removed).toHaveLength(2);
  });
});

// ─── labelAnchorWorld ─────────────────────────────────────────────────────────

describe('labelAnchorWorld', () => {
  it('linear: anchor at midpoint + 0.1 m Y-lift', () => {
    const m = linear('x', 4);
    const anchor = labelAnchorWorld(m);
    expect(anchor.x).toBeCloseTo(2);
    expect(anchor.y).toBeCloseTo(0.1);
    expect(anchor.z).toBeCloseTo(0);
  });

  it('area: anchor at centroid + 0.1 m Y-lift', () => {
    const m = area('x');
    const anchor = labelAnchorWorld(m);
    expect(anchor.x).toBeCloseTo(1);
    expect(anchor.y).toBeCloseTo(0.1);
    expect(anchor.z).toBeCloseTo(1);
  });

  it('does not mutate measurement points', () => {
    const m = linear('x', 2);
    const origY = m.points[0].y;
    labelAnchorWorld(m);
    expect(m.points[0].y).toBe(origY);
  });
});

/** UTF-8 BOM prepended by measurementsToCsv so Excel decodes m² correctly. */
const BOM = String.fromCharCode(0xfeff);

function makeMeasurement(
  id: string,
  kind: CommittedMeasurement['kind'],
  value: number,
  timestamp = '2026-01-01T00:00:00.000Z',
): CommittedMeasurement {
  return {
    id,
    kind,
    points: [new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0)],
    value,
    timestamp,
  };
}

describe('measurementsToCsv', () => {
  it('preserves the legacy columns and appends construction metadata', () => {
    const csv = measurementsToCsv([], 'm');
    expect(csv).toBe(
      BOM + 'index,kind,value,unit,timestamp,x,y,z,coordinate_space,exact,source',
    );
  });

  it('produces one data row per measurement', () => {
    const ms = [
      makeMeasurement('a', 'linear', 3.5),
      makeMeasurement('b', 'area', 12.0),
    ];
    const rows = measurementsToCsv(ms, 'm').split('\n');
    expect(rows).toHaveLength(3); // header + 2 data rows
  });

  it('indexes measurements from 1', () => {
    const ms = [makeMeasurement('x', 'linear', 1.0)];
    const rows = measurementsToCsv(ms, 'm').split('\n');
    expect(rows[1]).toMatch(/^1,/);
  });

  it('writes linear unit as "m" for metre mode', () => {
    const ms = [makeMeasurement('x', 'linear', 1.5)];
    const row = measurementsToCsv(ms, 'm').split('\n')[1];
    const parts = row.split(',');
    expect(parts[3]).toBe('m');
  });

  it('writes linear unit as "mm" for millimetre mode', () => {
    const ms = [makeMeasurement('x', 'linear', 1.5)];
    const row = measurementsToCsv(ms, 'mm').split('\n')[1];
    const parts = row.split(',');
    expect(parts[3]).toBe('mm');
  });

  it('writes linear unit as "ft" for feet mode', () => {
    const ms = [makeMeasurement('x', 'linear', 1.5)];
    const row = measurementsToCsv(ms, 'ft').split('\n')[1];
    const parts = row.split(',');
    expect(parts[3]).toBe('ft');
  });

  it('writes area unit as "m²" for metre mode', () => {
    const ms = [makeMeasurement('x', 'area', 4.0)];
    const row = measurementsToCsv(ms, 'm').split('\n')[1];
    const parts = row.split(',');
    expect(parts[3]).toBe('m²');
  });

  it('writes kind column correctly', () => {
    const lin = makeMeasurement('a', 'linear', 1.0);
    const area = makeMeasurement('b', 'area', 2.0);
    const rows = measurementsToCsv([lin, area], 'm').split('\n');
    expect(rows[1].split(',')[1]).toBe('linear');
    expect(rows[2].split(',')[1]).toBe('area');
  });

  it('value column is numeric-only (no unit suffix)', () => {
    const ms = [makeMeasurement('x', 'linear', 2.5)];
    const row = measurementsToCsv(ms, 'm').split('\n')[1];
    const parts = row.split(',');
    expect(parts[2]).toMatch(/^[\d.]+$/);
  });

  it('timestamp column matches the measurement timestamp', () => {
    const ts = '2026-05-04T12:00:00.000Z';
    const ms = [makeMeasurement('x', 'linear', 1.0, ts)];
    const row = measurementsToCsv(ms, 'm').split('\n')[1];
    const parts = row.split(',');
    // timestamp is the 5th column (index 4)
    expect(parts[4]).toBe(ts);
  });

  it('empty list produces only header', () => {
    expect(measurementsToCsv([], 'm')).toBe(
      BOM + 'index,kind,value,unit,timestamp,x,y,z,coordinate_space,exact,source',
    );
  });

  it('is deterministic for same inputs', () => {
    const ms = [makeMeasurement('x', 'linear', 1.23)];
    expect(measurementsToCsv(ms, 'm')).toBe(measurementsToCsv(ms, 'm'));
  });

  it('converts mm linear correctly (×1000)', () => {
    const ms = [makeMeasurement('x', 'linear', 1.0)];
    const row = measurementsToCsv(ms, 'mm').split('\n')[1];
    const parts = row.split(',');
    expect(parseFloat(parts[2])).toBeCloseTo(1000, 0);
  });

  it('converts ft linear correctly (×3.28084)', () => {
    const ms = [makeMeasurement('x', 'linear', 1.0)];
    const row = measurementsToCsv(ms, 'ft').split('\n')[1];
    const parts = row.split(',');
    expect(parseFloat(parts[2])).toBeCloseTo(3.28084, 3);
  });

  it('converts mm² area correctly (×1_000_000)', () => {
    const ms = [makeMeasurement('x', 'area', 1.0)];
    const row = measurementsToCsv(ms, 'mm').split('\n')[1];
    const parts = row.split(',');
    expect(parseFloat(parts[2])).toBeCloseTo(1_000_000, 0);
  });
});

describe('toDisplayValue', () => {
  const lin1m = makeMeasurement('a', 'linear', 1.0);
  const area1m2 = makeMeasurement('b', 'area', 1.0);

  it('linear m → 1.0', () => expect(toDisplayValue(lin1m, 'm')).toBe(1.0));
  it('linear mm → 1000', () => expect(toDisplayValue(lin1m, 'mm')).toBe(1000));
  it('linear ft → ~3.28084', () => expect(toDisplayValue(lin1m, 'ft')).toBeCloseTo(3.28084, 4));
  it('area m → 1.0', () => expect(toDisplayValue(area1m2, 'm')).toBe(1.0));
  it('area mm → 1_000_000', () => expect(toDisplayValue(area1m2, 'mm')).toBe(1_000_000));
  it('area ft → ~10.7639', () => expect(toDisplayValue(area1m2, 'ft')).toBeCloseTo(10.7639, 3));
});

describe('unitLabel', () => {
  const lin = makeMeasurement('a', 'linear', 1.0);
  const area = makeMeasurement('b', 'area', 1.0);
  const ang = makeMeasurement('c', 'angle', 90.0);

  it('linear m → m', () => expect(unitLabel(lin, 'm')).toBe('m'));
  it('linear mm → mm', () => expect(unitLabel(lin, 'mm')).toBe('mm'));
  it('linear ft → ft', () => expect(unitLabel(lin, 'ft')).toBe('ft'));
  it('area m → m²', () => expect(unitLabel(area, 'm')).toBe('m²'));
  it('area mm → mm²', () => expect(unitLabel(area, 'mm')).toBe('mm²'));
  it('area ft → ft²', () => expect(unitLabel(area, 'ft')).toBe('ft²'));
  it('angle → deg (unit-independent)', () => {
    expect(unitLabel(ang, 'm')).toBe('deg');
    expect(unitLabel(ang, 'mm')).toBe('deg');
    expect(unitLabel(ang, 'ft')).toBe('deg');
  });
});

describe('toDisplayValue - angle kind', () => {
  const ang = makeMeasurement('a', 'angle', 45.0);

  it('angle value is passed through unchanged regardless of unit', () => {
    expect(toDisplayValue(ang, 'm')).toBe(45.0);
    expect(toDisplayValue(ang, 'mm')).toBe(45.0);
    expect(toDisplayValue(ang, 'ft')).toBe(45.0);
  });
});

describe('measurementsToCsv - angle kind', () => {
  it('writes kind as "angle"', () => {
    const ms = [makeMeasurement('x', 'angle', 90.0)];
    const row = measurementsToCsv(ms, 'm').split('\n')[1];
    expect(row.split(',')[1]).toBe('angle');
  });

  it('writes unit as "deg" for angle', () => {
    const ms = [makeMeasurement('x', 'angle', 90.0)];
    const row = measurementsToCsv(ms, 'm').split('\n')[1];
    expect(row.split(',')[3]).toBe('deg');
  });

  it('writes angle value with 1 decimal', () => {
    const ms = [makeMeasurement('x', 'angle', 45.56)];
    const row = measurementsToCsv(ms, 'm').split('\n')[1];
    expect(row.split(',')[2]).toBe('45.6');
  });

  it('angle value unchanged when unit is mm or ft', () => {
    const ms = [makeMeasurement('x', 'angle', 30.0)];
    const rowM = measurementsToCsv(ms, 'm').split('\n')[1];
    const rowMm = measurementsToCsv(ms, 'mm').split('\n')[1];
    const rowFt = measurementsToCsv(ms, 'ft').split('\n')[1];
    expect(rowM.split(',')[2]).toBe('30.0');
    expect(rowMm.split(',')[2]).toBe('30.0');
    expect(rowFt.split(',')[2]).toBe('30.0');
  });

  it('mixed linear+angle list is serialised in order', () => {
    const ms = [
      makeMeasurement('a', 'linear', 2.0),
      makeMeasurement('b', 'angle', 90.0),
    ];
    const rows = measurementsToCsv(ms, 'm').split('\n');
    expect(rows[1].split(',')[1]).toBe('linear');
    expect(rows[2].split(',')[1]).toBe('angle');
  });
});

describe('measurementsToCsv - construction kinds', () => {
  it.each(['height', 'clearance'] as const)('formats %s as a length', (kind) => {
    const measurement = makeMeasurement('x', kind, 1.25);
    const fields = measurementsToCsv([measurement], 'mm').split('\n')[1].split(',');
    expect(fields[1]).toBe(kind);
    expect(fields[2]).toBe('1250.000');
    expect(fields[3]).toBe('mm');
  });

  it('exports project-local position components and provenance', () => {
    const measurement: CommittedMeasurement = {
      ...makeMeasurement('p', 'position', 0),
      points: [new THREE.Vector3(10, 20, 30)],
      coordinates: {
        world: new THREE.Vector3(10, 20, 30),
        local: new THREE.Vector3(1.25, 2.5, 3.75),
        reference: 'Survey frame',
      },
      exact: true,
      source: 'edge-midpoint',
    };
    const fields = measurementsToCsv([measurement], 'm').split('\n')[1].split(',');
    expect(fields.slice(0, 5)).toEqual([
      '1',
      'position',
      '',
      'm',
      '2026-01-01T00:00:00.000Z',
    ]);
    expect(fields.slice(5, 11)).toEqual([
      '1.250',
      '2.500',
      '3.750',
      'Survey frame',
      'true',
      'edge-midpoint',
    ]);
  });
});

describe('measurementsToCsv - escaping and encoding', () => {
  it('prepends a UTF-8 BOM so Excel detects the encoding', () => {
    expect(measurementsToCsv([], 'm').charCodeAt(0)).toBe(0xfeff);
    expect(measurementsToCsv([makeMeasurement('x', 'area', 1.0)], 'm').charCodeAt(0)).toBe(0xfeff);
  });

  it('escapes coordinate_space values containing CSV metacharacters', () => {
    const measurement: CommittedMeasurement = {
      ...makeMeasurement('p', 'position', 0),
      points: [new THREE.Vector3(1, 2, 3)],
      coordinates: {
        world: new THREE.Vector3(1, 2, 3),
        local: new THREE.Vector3(1, 2, 3),
        reference: 'Survey, "north" datum',
      },
    };
    const row = measurementsToCsv([measurement], 'm').split('\n')[1];
    expect(row).toContain('"Survey, ""north"" datum"');
  });
});

const BASE: MeasurementLiveReadout = {
  mode: 'linear',
  pendingCount: 0,
  hasCursor: false,
  value: null,
  perimeter: null,
  angleDeg: null,
  slopeDeg: null,
  cursorWorld: null,
  snapKind: null,
  snapExact: false,
};

describe('buildMeasurementTip', () => {
  it('returns null when no tool is armed', () => {
    expect(buildMeasurementTip({ ...BASE, mode: 'off' }, 'm')).toBeNull();
  });

  it('shows a step hint until a value exists', () => {
    const tip = buildMeasurementTip(BASE, 'm')!;
    expect(tip.primary).toBeNull();
    expect(tip.hint).toBe('Click start point');

    const second = buildMeasurementTip({ ...BASE, pendingCount: 1 }, 'm')!;
    expect(second.hint).toBe('Click end point');
  });

  it('formats a live distance with slope for linear mode', () => {
    const tip = buildMeasurementTip(
      { ...BASE, pendingCount: 1, hasCursor: true, value: 2.5, slopeDeg: 12.34 },
      'm',
    )!;
    expect(tip.primary).toBe('2.500 m');
    expect(tip.secondary).toBe('slope 12.3°');
    expect(tip.hint).toBeNull();
  });

  it('formats area with perimeter for polygon and rectangle modes', () => {
    const tip = buildMeasurementTip(
      { ...BASE, mode: 'area', pendingCount: 3, value: 12, perimeter: 14 },
      'm',
    )!;
    expect(tip.primary).toBe('12.000 m²');
    expect(tip.secondary).toBe('14.000 m');
  });

  it('formats the live angle in angle mode', () => {
    const tip = buildMeasurementTip(
      { ...BASE, mode: 'angle', pendingCount: 2, angleDeg: 90 },
      'm',
    )!;
    expect(tip.primary).toBe('90.0°');
  });

  it('shows cursor coordinates in position mode', () => {
    const tip = buildMeasurementTip(
      { ...BASE, mode: 'position', cursorWorld: { x: 1, y: 2, z: 3 } },
      'm',
    )!;
    expect(tip.primary).toContain('X 1.000');
    expect(tip.primary).toContain('Z 3.000');
  });

  it('carries the snap kind and exactness through', () => {
    const tip = buildMeasurementTip(
      { ...BASE, snapKind: 'vertex', snapExact: true },
      'm',
    )!;
    expect(tip.snap).toEqual({ label: 'Vertex', exact: true });
  });

  it('respects the unit for lengths', () => {
    const tip = buildMeasurementTip(
      { ...BASE, pendingCount: 1, value: 1 },
      'mm',
    )!;
    expect(tip.primary).toBe('1000.0 mm');
  });
});

describe('MeasurementController.liveReadout', () => {
  it('reports slope for an inclined linear segment', async () => {
    const THREE = await import('three');
    const { MeasurementController } = await import('../measurementController');
    const model = {} as ConstructorParameters<typeof MeasurementController>[1];
    const controller = new MeasurementController(new THREE.Scene(), model, {
      onChange: () => {},
    });
    controller.setMode('linear');
    controller.handleClick(new THREE.Vector3(0, 0, 0));
    controller.handleMove(new THREE.Vector3(1, 1, 0), null);

    const readout = controller.liveReadout();
    expect(readout.value).toBeCloseTo(Math.SQRT2, 5);
    expect(readout.slopeDeg).toBeCloseTo(45, 5);
    controller.dispose();
  });
});
