import { describe, expect, it, vi } from 'vitest';

import { resolveExpressToLocal } from '../localIdCachePrewarm';

function modelOf(map: Record<number, number | null>, onGet?: (id: number) => void) {
  return {
    getItem: (expressId: number) => {
      onGet?.(expressId);
      return {
        getLocalId: async () => {
          const v = map[expressId];
          if (v === undefined) throw new Error('missing');
          return v;
        },
      };
    },
  };
}

describe('resolveExpressToLocal', () => {
  it('returns local ids in request order', async () => {
    const cache = new Map<number, number>();
    const out = await resolveExpressToLocal(modelOf({ 1: 10, 2: 20, 3: 30 }), [3, 1, 2], cache);
    expect(out).toEqual([30, 10, 20]);
  });

  it('serves cache hits without touching the model', async () => {
    const seen: number[] = [];
    const cache = new Map<number, number>([[1, 11]]);
    const out = await resolveExpressToLocal(modelOf({ 2: 20 }, (id) => seen.push(id)), [1, 2], cache);
    expect(out).toEqual([11, 20]);
    expect(seen).toEqual([2]);
  });

  it('consults getRemembered before the model and populates the cache', async () => {
    const seen: number[] = [];
    const cache = new Map<number, number>();
    const getRemembered = vi.fn((id: number) => (id === 7 ? 77 : null));
    const out = await resolveExpressToLocal(
      modelOf({ 8: 88 }, (id) => seen.push(id)),
      [7, 8],
      cache,
      { getRemembered },
    );
    expect(out).toEqual([77, 88]);
    expect(seen).toEqual([8]);
    expect(cache.get(7)).toBe(77);
  });

  it('omits ids the model cannot resolve rather than emitting a sentinel', async () => {
    const cache = new Map<number, number>();
    const out = await resolveExpressToLocal(modelOf({ 1: 10, 2: null, 3: 30 }), [1, 2, 3, 4], cache);
    expect(out).toEqual([10, 30]);
    expect(cache.has(2)).toBe(false);
    expect(cache.has(4)).toBe(false);
  });

  it('resolves across batch boundaries', async () => {
    const map: Record<number, number> = {};
    const ids: number[] = [];
    for (let i = 1; i <= 150; i++) {
      map[i] = i * 2;
      ids.push(i);
    }
    const cache = new Map<number, number>();
    const out = await resolveExpressToLocal(modelOf(map), ids, cache, { batchSize: 16 });
    expect(out).toHaveLength(150);
    expect(out[0]).toBe(2);
    expect(out[149]).toBe(300);
    expect(cache.size).toBe(150);
  });

  it('returns an empty list for no input without calling the model', async () => {
    const seen: number[] = [];
    const out = await resolveExpressToLocal(modelOf({}, (id) => seen.push(id)), [], new Map());
    expect(out).toEqual([]);
    expect(seen).toEqual([]);
  });
});
