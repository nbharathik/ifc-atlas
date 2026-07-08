import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyEntityDelta } from '../entityDeltaHandler';
import type { EntityDeltaEvent, EntityDeltaDeps } from '../entityDeltaHandler';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeDeps(): { deps: EntityDeltaDeps; flashCalls: number[][]; invalidateCalls: number[][] } {
  const flashCalls: number[][] = [];
  const invalidateCalls: number[][] = [];
  const deps: EntityDeltaDeps = {
    flashHighlight: (ids) => flashCalls.push([...ids]),
    invalidateElementDetails: (ids) => invalidateCalls.push([...ids]),
  };
  return { deps, flashCalls, invalidateCalls };
}

function makeEvent(overrides: Partial<EntityDeltaEvent> = {}): EntityDeltaEvent {
  return {
    type: 'entity_delta',
    changed_ids: [1, 2],
    dirty_ids: [1, 2, 3],
    delta_type: 'metadata',
    ...overrides,
  };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('applyEntityDelta', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns noop for empty changed_ids and dirty_ids', async () => {
    const { deps, flashCalls, invalidateCalls } = makeDeps();
    const result = await applyEntityDelta(
      { type: 'entity_delta', changed_ids: [], dirty_ids: [], delta_type: 'metadata' },
      deps,
    );
    expect(result.handledAs).toBe('noop');
    expect(result.affectedCount).toBe(0);
    expect(flashCalls).toHaveLength(0);
    expect(invalidateCalls).toHaveLength(0);
  });

  it('returns noop when changed_ids and dirty_ids are absent (defaults to empty)', async () => {
    const { deps } = makeDeps();
    const result = await applyEntityDelta({ type: 'entity_delta' }, deps);
    expect(result.handledAs).toBe('noop');
    expect(result.affectedCount).toBe(0);
  });

  it('invalidates the union of changed + dirty IDs', async () => {
    const { deps, invalidateCalls } = makeDeps();
    await applyEntityDelta(makeEvent({ changed_ids: [1, 2], dirty_ids: [2, 3, 4] }), deps);
    expect(invalidateCalls).toHaveLength(1);
    // Union = {1, 2, 3, 4} - order may vary
    expect(invalidateCalls[0].sort()).toEqual([1, 2, 3, 4]);
  });

  it('flash-highlights only the directly changed IDs', async () => {
    const { deps, flashCalls } = makeDeps();
    await applyEntityDelta(makeEvent({ changed_ids: [10, 11], dirty_ids: [10, 11, 12, 13] }), deps);
    expect(flashCalls).toHaveLength(1);
    expect(flashCalls[0]).toEqual([10, 11]);
  });

  it('does not flash when changed_ids is empty but dirty_ids has entries', async () => {
    const { deps, flashCalls, invalidateCalls } = makeDeps();
    await applyEntityDelta(makeEvent({ changed_ids: [], dirty_ids: [5, 6] }), deps);
    expect(flashCalls).toHaveLength(0);
    // Invalidate should still cover dirty_ids
    expect(invalidateCalls[0].sort()).toEqual([5, 6]);
  });

  it('returns metadata result for delta_type metadata', async () => {
    const { deps } = makeDeps();
    const result = await applyEntityDelta(makeEvent({ delta_type: 'metadata' }), deps);
    expect(result.handledAs).toBe('metadata');
    expect(result.affectedCount).toBe(3); // union of [1,2] + [1,2,3] = {1,2,3}
  });

  it('returns metadata result when delta_type is geometry but no frag_delta_url', async () => {
    const { deps } = makeDeps();
    const result = await applyEntityDelta(
      makeEvent({ delta_type: 'geometry' /* no frag_delta_url */ }),
      deps,
    );
    // Without a URL, geometry path skipped → falls back to metadata
    expect(result.handledAs).toBe('metadata');
  });

  it('calls loadFragmentDelta for geometry delta with all required deps', async () => {
    const { deps, flashCalls } = makeDeps();
    const getLocalId = vi.fn().mockResolvedValue(100);
    const editorEdit = vi.fn().mockResolvedValue([100]);
    deps.getLocalId = getLocalId;
    deps.editorEdit = editorEdit;

    const repData = { bbox: [0, 0, 0, 1, 1, 1] };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ representations: { '1': repData, '2': repData } }),
    } as unknown as Response);

    const result = await applyEntityDelta(
      makeEvent({
        delta_type: 'geometry',
        frag_delta_url: 'http://backend/frag-delta',
        model_id: 'model-xyz',
        changed_ids: [1, 2],
        dirty_ids: [1, 2, 3],
      }),
      deps,
    );

    expect(result.handledAs).toBe('geometry');
    expect(result.affectedCount).toBe(3);
    expect(result.geometryPatchCount).toBe(2);
    expect(flashCalls).toHaveLength(1);
    expect(flashCalls[0]).toEqual([1, 2]);
    expect(editorEdit).toHaveBeenCalledOnce();
  });

  it('degrades gracefully when geometry fetch fails (returns geometry with 0 patch count)', async () => {
    const { deps, invalidateCalls, flashCalls } = makeDeps();
    deps.getLocalId = vi.fn().mockResolvedValue(100);
    deps.editorEdit = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('net error'));

    const result = await applyEntityDelta(
      makeEvent({
        delta_type: 'geometry',
        frag_delta_url: 'http://backend/frag-delta',
        model_id: 'model-xyz',
        changed_ids: [1, 2],
        dirty_ids: [1, 2, 3],
      }),
      deps,
    );

    // loadFragmentDelta handles the error internally - returns 0 count, no throw.
    // Entity delta handler returns geometry path with 0 patched.
    expect(result.handledAs).toBe('geometry');
    expect(result.geometryPatchCount).toBe(0);
    expect(result.affectedCount).toBe(3);
    // Invalidate + flash still ran before the geometry path
    expect(invalidateCalls).toHaveLength(1);
    expect(flashCalls).toHaveLength(1);
  });

  it('deduplicates overlapping changed_ids and dirty_ids in affectedCount', async () => {
    const { deps } = makeDeps();
    const result = await applyEntityDelta(
      makeEvent({ changed_ids: [5, 5, 6], dirty_ids: [5, 6, 7] }),
      deps,
    );
    // Union = {5, 6, 7} → 3
    expect(result.affectedCount).toBe(3);
  });

  it('treats unknown delta_type as metadata', async () => {
    const { deps } = makeDeps();
    const result = await applyEntityDelta(
      makeEvent({ delta_type: 'storey_reassignment' }),
      deps,
    );
    // Unknown type → not geometry path → metadata
    expect(result.handledAs).toBe('metadata');
  });

  it('does not throw when invalidateElementDetails throws (degrades gracefully)', async () => {
    const { deps, flashCalls } = makeDeps();
    deps.invalidateElementDetails = () => { throw new Error('store reset'); };
    // applyEntityDelta must never throw - the docstring guarantees this.
    const result = await applyEntityDelta(makeEvent({ changed_ids: [1], dirty_ids: [1] }), deps);
    // Returns metadata; flash was still attempted (after the failing invalidate).
    expect(result.handledAs).toBe('metadata');
    expect(flashCalls).toHaveLength(1);
  });

  it('returns metadata even when only dirty_ids are present (no changed_ids)', async () => {
    const { deps, flashCalls, invalidateCalls } = makeDeps();
    const result = await applyEntityDelta(
      { type: 'entity_delta', dirty_ids: [10, 20, 30] },
      deps,
    );
    expect(result.handledAs).toBe('metadata');
    expect(result.affectedCount).toBe(3);
    // No directly changed IDs → no flash
    expect(flashCalls).toHaveLength(0);
    expect(invalidateCalls[0].sort()).toEqual([10, 20, 30]);
  });
});
