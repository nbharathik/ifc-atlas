import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadFragmentDelta, type GetLocalIdFn, type EditorEditFn } from '../fragmentDeltaLoader';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeLocalIdFn(map: Record<number, number | null>): GetLocalIdFn {
  return async (expressId: number) => map[expressId] ?? null;
}

function makeEditorEditFn(): { fn: EditorEditFn; calls: Array<unknown> } {
  const calls: Array<unknown> = [];
  const fn: EditorEditFn = async (modelId, requests) => {
    calls.push({ modelId, requests });
    return requests.map((r) => r.localId);
  };
  return { fn, calls };
}

function makePayload(representations: Record<string, unknown>): Response {
  return {
    ok: true,
    json: async () => ({ representations }),
  } as unknown as Response;
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('loadFragmentDelta', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns updatedCount=0 for empty url', async () => {
    const edit = makeEditorEditFn();
    const result = await loadFragmentDelta('', [1, 2], 'model-1', makeLocalIdFn({}), edit.fn);
    expect(result.source).toBe('geometry-patch');
    expect(result.updatedCount).toBe(0);
    expect(edit.calls).toHaveLength(0);
  });

  it('returns updatedCount=0 for empty expressIds', async () => {
    const edit = makeEditorEditFn();
    const result = await loadFragmentDelta('http://x/delta', [], 'model-1', makeLocalIdFn({}), edit.fn);
    expect(result.updatedCount).toBe(0);
    expect(edit.calls).toHaveLength(0);
  });

  it('returns updatedCount=0 when fetch fails (non-ok status)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ ok: false, status: 404 } as Response);
    const edit = makeEditorEditFn();
    const result = await loadFragmentDelta('http://x/delta', [1], 'model-1', makeLocalIdFn({ 1: 100 }), edit.fn);
    expect(result.updatedCount).toBe(0);
    expect(edit.calls).toHaveLength(0);
  });

  it('returns updatedCount=0 when fetch throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network error'));
    const edit = makeEditorEditFn();
    const result = await loadFragmentDelta('http://x/delta', [1], 'model-1', makeLocalIdFn({ 1: 100 }), edit.fn);
    expect(result.updatedCount).toBe(0);
  });

  it('calls editorEdit with correct type and localId', async () => {
    const repData = { bbox: [0, 0, 0, 1, 1, 1], representationClass: 1 };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makePayload({ '5': repData }));
    const edit = makeEditorEditFn();

    const result = await loadFragmentDelta(
      'http://x/delta',
      [5],
      'model-A',
      makeLocalIdFn({ 5: 999 }),
      edit.fn,
    );

    expect(result.updatedCount).toBe(1);
    expect(edit.calls).toHaveLength(1);
    const call = edit.calls[0] as { modelId: string; requests: Array<{ type: number; localId: number; data: unknown }> };
    expect(call.modelId).toBe('model-A');
    expect(call.requests).toHaveLength(1);
    expect(call.requests[0].type).toBe(8); // UPDATE_REPRESENTATION
    expect(call.requests[0].localId).toBe(999);
    expect(call.requests[0].data).toEqual(repData);
  });

  it('skips expressIds without a representation in the payload', async () => {
    const repData = { bbox: [0, 0, 0, 1, 1, 1], representationClass: 1 };
    // Only express ID 10 has rep data; 11 does not.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makePayload({ '10': repData }));
    const edit = makeEditorEditFn();

    const result = await loadFragmentDelta(
      'http://x/delta',
      [10, 11],
      'model-B',
      makeLocalIdFn({ 10: 200, 11: 201 }),
      edit.fn,
    );

    expect(result.updatedCount).toBe(1);
    const call = edit.calls[0] as { requests: Array<{ localId: number }> };
    expect(call.requests.map((r) => r.localId)).toEqual([200]);
  });

  it('skips expressIds whose localId is null', async () => {
    const repData = { bbox: [0, 0, 0, 1, 1, 1], representationClass: 1 };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makePayload({ '7': repData, '8': repData }));
    const edit = makeEditorEditFn();

    // Express ID 8 has no local ID mapping.
    const result = await loadFragmentDelta(
      'http://x/delta',
      [7, 8],
      'model-C',
      makeLocalIdFn({ 7: 300, 8: null as unknown as number }),
      edit.fn,
    );

    expect(result.updatedCount).toBe(1);
    const call = edit.calls[0] as { requests: Array<{ localId: number }> };
    expect(call.requests.map((r) => r.localId)).toEqual([300]);
  });

  it('returns updatedCount=0 when all expressIds are missing from payload', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makePayload({}));
    const edit = makeEditorEditFn();

    const result = await loadFragmentDelta(
      'http://x/delta',
      [1, 2, 3],
      'model-D',
      makeLocalIdFn({ 1: 10, 2: 20, 3: 30 }),
      edit.fn,
    );

    expect(result.updatedCount).toBe(0);
    expect(edit.calls).toHaveLength(0);
  });

  it('source is always geometry-patch', async () => {
    const result = await loadFragmentDelta('', [], 'x', makeLocalIdFn({}), async () => []);
    expect(result.source).toBe('geometry-patch');
  });

  it('handles editorEdit throwing gracefully', async () => {
    const repData = { bbox: [0, 0, 0, 1, 1, 1], representationClass: 1 };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makePayload({ '1': repData }));
    const failEdit: EditorEditFn = async () => { throw new Error('editor failed'); };

    const result = await loadFragmentDelta(
      'http://x/delta',
      [1],
      'model-E',
      makeLocalIdFn({ 1: 50 }),
      failEdit,
    );

    expect(result.updatedCount).toBe(0);
    expect(result.source).toBe('geometry-patch');
  });
});
