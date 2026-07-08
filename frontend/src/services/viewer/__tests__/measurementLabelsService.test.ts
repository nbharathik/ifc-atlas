import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';
import type { CommittedMeasurement } from '../measurementController';
import { labelAnchorWorld } from '../measurementLabels';

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

import { MeasurementLabelRenderer } from '../measurementLabels';

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
