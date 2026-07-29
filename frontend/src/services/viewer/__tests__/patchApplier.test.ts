import { describe, it, expect, vi } from 'vitest';
import {
  applyIfcPatchBatch,
  applyNameUpdatesToTree,
  type PatchApplierDeps,
} from '../patchApplier';
import type { IfcPatch } from '../../../types/ifc';
import type { SpatialNode } from '../../../types/ifc';

// ── Helpers ──────────────────────────────────────────────────────────────────

const SHA = 'abc123' as const;
const NOW = Date.now();

function base(overrides: Partial<IfcPatch> = {}): IfcPatch {
  return {
    kind: 'attribute_changed',
    seq: 1,
    source_sha256: SHA,
    timestamp_ms: NOW,
    actor: 'agent',
    agent_id: null,
    express_id: 42,
    attribute: 'Name',
    old_value: 'Old',
    new_value: 'New',
    ...overrides,
  } as IfcPatch;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockDeps = Record<string, any>;

function makeDeps(overrides: Partial<PatchApplierDeps> = {}): MockDeps {
  return {
    spatialTree: null,
    onTreeUpdated: vi.fn(),
    onActivityLogged: vi.fn(),
    onElementsHidden: vi.fn(),
    onFragDelta: vi.fn(),
    ...overrides,
  };
}

// ── applyNameUpdatesToTree ────────────────────────────────────────────────────

describe('applyNameUpdatesToTree', () => {
  const tree: SpatialNode = {
    id: 1,
    global_id: 'g1',
    name: 'Root',
    ifc_type: 'IfcProject',
    children: [
      {
        id: 2,
        global_id: 'g2',
        name: 'Site',
        ifc_type: 'IfcSite',
        children: [
          {
            id: 3,
            global_id: 'g3',
            name: 'Wall A',
            ifc_type: 'IfcWall',
            children: [],
          },
        ],
      },
    ],
  };

  it('returns the same object reference when nothing changes', () => {
    const result = applyNameUpdatesToTree(tree, new Map());
    expect(result).toBe(tree);
  });

  it('renames a leaf node and returns a new tree', () => {
    const result = applyNameUpdatesToTree(tree, new Map([[3, 'Wall B']]));
    expect(result).not.toBe(tree);
    expect(result.children[0].children[0].name).toBe('Wall B');
    // Root and site are still structurally shared
    expect(result.children[0].children[0]).not.toBe(tree.children[0].children[0]);
  });

  it('renames the root node', () => {
    const result = applyNameUpdatesToTree(tree, new Map([[1, 'My Project']]));
    expect(result.name).toBe('My Project');
  });

  it('handles multiple renames in one pass', () => {
    const result = applyNameUpdatesToTree(
      tree,
      new Map([
        [2, 'Campus'],
        [3, 'Wall C'],
      ]),
    );
    expect(result.children[0].name).toBe('Campus');
    expect(result.children[0].children[0].name).toBe('Wall C');
  });

  it('does not rename when new name equals current name', () => {
    const result = applyNameUpdatesToTree(tree, new Map([[3, 'Wall A']]));
    expect(result).toBe(tree); // no change
  });
});

// ── applyIfcPatchBatch - empty ────────────────────────────────────────────────

describe('applyIfcPatchBatch - empty batch', () => {
  it('calls no callbacks for an empty batch', () => {
    const deps = makeDeps();
    applyIfcPatchBatch([], deps);
    expect(deps.onActivityLogged).not.toHaveBeenCalled();
    expect(deps.onTreeUpdated).not.toHaveBeenCalled();
    expect(deps.onElementsHidden).not.toHaveBeenCalled();
  });
});

// ── attribute_changed (Name) ──────────────────────────────────────────────────

describe('applyIfcPatchBatch - attribute_changed / Name', () => {
  const tree: SpatialNode = {
    id: 42,
    global_id: 'gx',
    name: 'Old',
    ifc_type: 'IfcWall',
    children: [],
  };

  it('patches the tree when spatialTree is provided', () => {
    const deps = makeDeps({ spatialTree: tree });
    applyIfcPatchBatch([base()], deps);
    expect(deps.onTreeUpdated).toHaveBeenCalledOnce();
    const updated = deps.onTreeUpdated.mock.calls[0][0] as SpatialNode;
    expect(updated.name).toBe('New');
  });

  it('logs an edit activity entry', () => {
    const deps = makeDeps({ spatialTree: tree });
    applyIfcPatchBatch([base()], deps);
    expect(deps.onActivityLogged).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'edit', summary: expect.stringContaining('renamed') }),
    );
  });

  it('does not call onTreeUpdated when spatialTree is null', () => {
    const deps = makeDeps({ spatialTree: null });
    applyIfcPatchBatch([base()], deps);
    expect(deps.onTreeUpdated).not.toHaveBeenCalled();
  });

  it('batches multiple renames into a single tree walk', () => {
    const bigTree: SpatialNode = {
      id: 1,
      global_id: 'g1',
      name: 'Root',
      ifc_type: 'IfcProject',
      children: [
        { id: 10, global_id: 'a', name: 'A', ifc_type: 'IfcWall', children: [] },
        { id: 11, global_id: 'b', name: 'B', ifc_type: 'IfcWall', children: [] },
      ],
    };
    const deps = makeDeps({ spatialTree: bigTree });
    applyIfcPatchBatch(
      [
        base({ express_id: 10, old_value: 'A', new_value: 'A2' }),
        base({ express_id: 11, old_value: 'B', new_value: 'B2', seq: 2 }),
      ],
      deps,
    );
    // Only one tree walk → onTreeUpdated called once
    expect(deps.onTreeUpdated).toHaveBeenCalledOnce();
    const updated = deps.onTreeUpdated.mock.calls[0][0] as SpatialNode;
    expect(updated.children[0].name).toBe('A2');
    expect(updated.children[1].name).toBe('B2');
  });
});

// ── attribute_changed (other attributes) ─────────────────────────────────────

describe('applyIfcPatchBatch - attribute_changed / other', () => {
  it('logs info for ifc_type attribute', () => {
    const deps = makeDeps();
    applyIfcPatchBatch(
      [base({ attribute: 'ifc_type', old_value: 'IfcBeam', new_value: 'IfcColumn' })],
      deps,
    );
    expect(deps.onActivityLogged).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'info', summary: expect.stringContaining('type changed') }),
    );
  });

  it('logs info for unknown attributes', () => {
    const deps = makeDeps();
    applyIfcPatchBatch(
      [base({ attribute: 'Description', old_value: null, new_value: 'My desc' })],
      deps,
    );
    expect(deps.onActivityLogged).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'info', summary: expect.stringContaining('attribute updated') }),
    );
  });
});

// ── pset_changed ──────────────────────────────────────────────────────────────

describe('applyIfcPatchBatch - pset_changed', () => {
  it('logs an edit activity', () => {
    const deps = makeDeps();
    const patch: IfcPatch = {
      kind: 'pset_changed',
      seq: 1,
      source_sha256: SHA,
      timestamp_ms: NOW,
      actor: 'agent',
      agent_id: null,
      express_id: 7,
      pset_name: 'Pset_WallCommon',
      changes: { IsExternal: true, ThermalTransmittance: 0.8 },
    };
    applyIfcPatchBatch([patch], deps);
    expect(deps.onActivityLogged).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'edit',
        summary: expect.stringContaining('#7'),
        detail: expect.stringContaining('2 property changes'),
      }),
    );
  });
});

// ── element_removed ───────────────────────────────────────────────────────────

describe('applyIfcPatchBatch - element_removed', () => {
  it('calls onElementsHidden with the express id', () => {
    const deps = makeDeps();
    const patch: IfcPatch = {
      kind: 'element_removed',
      seq: 1,
      source_sha256: SHA,
      timestamp_ms: NOW,
      actor: 'agent',
      agent_id: null,
      express_id: 99,
      ifc_type: 'IfcSlab',
    };
    applyIfcPatchBatch([patch], deps);
    expect(deps.onElementsHidden).toHaveBeenCalledWith([99]);
  });

  it('batches multiple removals into a single onElementsHidden call', () => {
    const deps = makeDeps();
    const mkRemoved = (id: number, seq: number): IfcPatch => ({
      kind: 'element_removed',
      seq,
      source_sha256: SHA,
      timestamp_ms: NOW,
      actor: 'agent',
      agent_id: null,
      express_id: id,
      ifc_type: 'IfcWall',
    });
    applyIfcPatchBatch([mkRemoved(1, 1), mkRemoved(2, 2), mkRemoved(3, 3)], deps);
    expect(deps.onElementsHidden).toHaveBeenCalledOnce();
    expect(deps.onElementsHidden).toHaveBeenCalledWith([1, 2, 3]);
  });

  it('logs an edit activity', () => {
    const deps = makeDeps();
    const patch: IfcPatch = {
      kind: 'element_removed',
      seq: 1,
      source_sha256: SHA,
      timestamp_ms: NOW,
      actor: 'agent',
      agent_id: null,
      express_id: 5,
      ifc_type: 'IfcDoor',
    };
    applyIfcPatchBatch([patch], deps);
    expect(deps.onActivityLogged).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'edit', summary: expect.stringContaining('removed') }),
    );
  });
});

// ── element_added ─────────────────────────────────────────────────────────────

describe('applyIfcPatchBatch - element_added', () => {
  it('calls onFragDelta when frag_delta_url is provided', () => {
    const deps = makeDeps();
    const patch: IfcPatch = {
      kind: 'element_added',
      seq: 1,
      source_sha256: SHA,
      timestamp_ms: NOW,
      actor: 'agent',
      agent_id: null,
      express_id: 77,
      ifc_type: 'IfcBeam',
      frag_delta_url: '/api/ifc/frag-delta/77',
    };
    applyIfcPatchBatch([patch], deps);
    expect(deps.onFragDelta).toHaveBeenCalledWith('/api/ifc/frag-delta/77', [77]);
  });

  it('does NOT call onFragDelta when frag_delta_url is null', () => {
    const deps = makeDeps();
    const patch: IfcPatch = {
      kind: 'element_added',
      seq: 1,
      source_sha256: SHA,
      timestamp_ms: NOW,
      actor: 'agent',
      agent_id: null,
      express_id: 88,
      ifc_type: 'IfcBeam',
      frag_delta_url: null,
    };
    applyIfcPatchBatch([patch], deps);
    expect(deps.onFragDelta).not.toHaveBeenCalled();
  });

  it('logs an edit activity', () => {
    const deps = makeDeps();
    const patch: IfcPatch = {
      kind: 'element_added',
      seq: 1,
      source_sha256: SHA,
      timestamp_ms: NOW,
      actor: 'agent',
      agent_id: null,
      express_id: 55,
      ifc_type: 'IfcColumn',
      frag_delta_url: null,
    };
    applyIfcPatchBatch([patch], deps);
    expect(deps.onActivityLogged).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'edit', summary: expect.stringContaining('added') }),
    );
  });
});

// ── geometry_changed ──────────────────────────────────────────────────────────

describe('applyIfcPatchBatch - geometry_changed', () => {
  it('calls onFragDelta with all express_ids', () => {
    const deps = makeDeps();
    const patch: IfcPatch = {
      kind: 'geometry_changed',
      seq: 1,
      source_sha256: SHA,
      timestamp_ms: NOW,
      actor: 'agent',
      agent_id: null,
      express_ids: [1, 2, 3],
      frag_delta_url: '/api/ifc/frag-delta/1,2,3',
    };
    applyIfcPatchBatch([patch], deps);
    expect(deps.onFragDelta).toHaveBeenCalledWith('/api/ifc/frag-delta/1,2,3', [1, 2, 3]);
  });

  it('logs an info activity', () => {
    const deps = makeDeps();
    const patch: IfcPatch = {
      kind: 'geometry_changed',
      seq: 1,
      source_sha256: SHA,
      timestamp_ms: NOW,
      actor: 'agent',
      agent_id: null,
      express_ids: [10, 20],
      frag_delta_url: '/api/ifc/frag-delta/10,20',
    };
    applyIfcPatchBatch([patch], deps);
    expect(deps.onActivityLogged).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'info' }),
    );
  });
});

// ── storey_changed ────────────────────────────────────────────────────────────

describe('applyIfcPatchBatch - storey_changed', () => {
  it('logs an info activity with storey detail', () => {
    const deps = makeDeps();
    const patch: IfcPatch = {
      kind: 'storey_changed',
      seq: 1,
      source_sha256: SHA,
      timestamp_ms: NOW,
      actor: 'agent',
      agent_id: null,
      express_id: 22,
      old_storey_express_id: 100,
      new_storey_express_id: 200,
    };
    applyIfcPatchBatch([patch], deps);
    expect(deps.onActivityLogged).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'info',
        summary: expect.stringContaining('#22'),
        detail: expect.stringContaining('#100'),
      }),
    );
  });

  it('logs without detail when storey IDs are null', () => {
    const deps = makeDeps();
    const patch: IfcPatch = {
      kind: 'storey_changed',
      seq: 1,
      source_sha256: SHA,
      timestamp_ms: NOW,
      actor: 'agent',
      agent_id: null,
      express_id: 33,
      old_storey_express_id: null,
      new_storey_express_id: null,
    };
    applyIfcPatchBatch([patch], deps);
    expect(deps.onActivityLogged).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'info', detail: undefined }),
    );
  });
});

// ── geometry_changed - no onFragDelta dep ─────────────────────────────────────

describe('applyIfcPatchBatch - geometry_changed / no onFragDelta dep', () => {
  it('logs info and does not throw when onFragDelta is absent', () => {
    const deps = makeDeps({ onFragDelta: undefined });
    const patch: IfcPatch = {
      kind: 'geometry_changed',
      seq: 1,
      source_sha256: SHA,
      timestamp_ms: NOW,
      actor: 'agent',
      agent_id: null,
      express_ids: [5, 6],
      frag_delta_url: '/api/ifc/frag-delta/5,6',
    };
    expect(() => applyIfcPatchBatch([patch], deps)).not.toThrow();
    expect(deps.onActivityLogged).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'info' }),
    );
  });
});

// ── robustness - missing optional deps ───────────────────────────────────────

describe('applyIfcPatchBatch - missing optional deps', () => {
  it('does not crash when onFragDelta is absent but patch has a frag_delta_url', () => {
    const deps = makeDeps({ onFragDelta: undefined });
    const patch: IfcPatch = {
      kind: 'element_added',
      seq: 1,
      source_sha256: SHA,
      timestamp_ms: NOW,
      actor: 'agent',
      agent_id: null,
      express_id: 42,
      ifc_type: 'IfcBeam',
      frag_delta_url: '/api/ifc/frag-delta/42',
    };
    expect(() => applyIfcPatchBatch([patch], deps)).not.toThrow();
  });

  it('does not crash when onActivityLogged is absent', () => {
    const deps = makeDeps({ onActivityLogged: undefined });
    expect(() =>
      applyIfcPatchBatch(
        [base()],
        deps,
      ),
    ).not.toThrow();
  });

  it('does not crash when onElementsHidden is absent', () => {
    const deps = makeDeps({ onElementsHidden: undefined });
    const patch: IfcPatch = {
      kind: 'element_removed',
      seq: 1,
      source_sha256: SHA,
      timestamp_ms: NOW,
      actor: 'agent',
      agent_id: null,
      express_id: 7,
      ifc_type: 'IfcWall',
    };
    expect(() => applyIfcPatchBatch([patch], deps)).not.toThrow();
  });

  it('does not update tree when onTreeUpdated is absent', () => {
    const tree: SpatialNode = {
      id: 1,
      global_id: 'g',
      name: 'Wall',
      ifc_type: 'IfcWall',
      children: [],
    };
    const deps = makeDeps({ spatialTree: tree, onTreeUpdated: undefined });
    // Should not throw even though tree has a matching node
    expect(() => applyIfcPatchBatch([base()], deps)).not.toThrow();
  });
});

// ── attribute_changed Name - non-string new_value ────────────────────────────

describe('applyIfcPatchBatch - attribute_changed Name / non-string new_value', () => {
  it('does not add the id to nameUpdates when new_value is null', () => {
    const tree: SpatialNode = {
      id: 42,
      global_id: 'g',
      name: 'Old',
      ifc_type: 'IfcWall',
      children: [],
    };
    const deps = makeDeps({ spatialTree: tree });
    // new_value is null - should NOT update the tree name
    applyIfcPatchBatch(
      [base({ new_value: null })],
      deps,
    );
    // onTreeUpdated should NOT be called because new name is not a string
    expect(deps.onTreeUpdated).not.toHaveBeenCalled();
  });
});

// ── mixed batch ───────────────────────────────────────────────────────────────

describe('applyIfcPatchBatch - mixed batch', () => {
  it('processes all patch kinds in one call', () => {
    const tree: SpatialNode = {
      id: 1,
      global_id: 'g',
      name: 'Wall',
      ifc_type: 'IfcWall',
      children: [],
    };
    const deps = makeDeps({ spatialTree: tree });

    const patches: IfcPatch[] = [
      base({ seq: 1, express_id: 1, old_value: 'Wall', new_value: 'Wall X' }),
      {
        kind: 'element_removed',
        seq: 2,
        source_sha256: SHA,
        timestamp_ms: NOW,
        actor: 'agent',
        agent_id: null,
        express_id: 99,
        ifc_type: 'IfcSlab',
      },
      {
        kind: 'pset_changed',
        seq: 3,
        source_sha256: SHA,
        timestamp_ms: NOW,
        actor: 'agent',
        agent_id: null,
        express_id: 5,
        pset_name: 'Pset_A',
        changes: { Foo: 'bar' },
      },
    ];

    applyIfcPatchBatch(patches, deps);

    expect(deps.onTreeUpdated).toHaveBeenCalledOnce();
    expect(deps.onElementsHidden).toHaveBeenCalledWith([99]);
    expect(deps.onActivityLogged).toHaveBeenCalledTimes(3);
  });
});
