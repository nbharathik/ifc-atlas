import { describe, expect, it } from 'vitest';
import { prewarmExpressToLocalCache, type LocalIdLookupModel } from '../localIdCachePrewarm';

function makeModel(values: Map<number, number | null | Error>) {
  const calls: number[] = [];
  const model: LocalIdLookupModel = {
    getItem: (expressId) => {
      calls.push(expressId);
      return {
        getLocalId: async () => {
          const value = values.get(expressId);
          if (value instanceof Error) throw value;
          return value ?? null;
        },
      };
    },
  };
  return { model, calls };
}

describe('prewarmExpressToLocalCache', () => {
  it('resolves misses, skips cached IDs, and deduplicates requests', async () => {
    const { model, calls } = makeModel(new Map([
      [2, 202],
      [3, 303],
    ]));
    const cache = new Map([[1, 101]]);

    const result = await prewarmExpressToLocalCache(model, [1, 2, 3, 2], cache, {
      batchSize: 2,
    });

    expect(result).toEqual({
      requested: 4,
      unique: 3,
      skippedCached: 1,
      skippedDuplicate: 1,
      resolved: 2,
      unresolved: 0,
      cancelled: false,
    });
    expect(calls).toEqual([2, 3]);
    expect(cache.get(1)).toBe(101);
    expect(cache.get(2)).toBe(202);
    expect(cache.get(3)).toBe(303);
  });

  it('treats null local IDs and thrown lookups as unresolved without throwing', async () => {
    const { model, calls } = makeModel(new Map([
      [4, null],
      [5, new Error('lookup failed')],
    ]));
    const cache = new Map<number, number>();

    const result = await prewarmExpressToLocalCache(model, [4, 5], cache);

    expect(result).toMatchObject({
      resolved: 0,
      unresolved: 2,
      cancelled: false,
    });
    expect(calls).toEqual([4, 5]);
    expect(cache.size).toBe(0);
  });

  it('stops before starting the next batch when cancelled', async () => {
    const { model, calls } = makeModel(new Map([
      [1, 101],
      [2, 202],
    ]));
    const cache = new Map<number, number>();
    let cancellationChecks = 0;

    const result = await prewarmExpressToLocalCache(model, [1, 2], cache, {
      batchSize: 1,
      isCancelled: () => {
        cancellationChecks += 1;
        return cancellationChecks > 2;
      },
    });

    expect(result).toMatchObject({
      resolved: 1,
      unresolved: 0,
      cancelled: true,
    });
    expect(calls).toEqual([1]);
    expect(cache.get(1)).toBe(101);
    expect(cache.has(2)).toBe(false);
  });

  it('does not commit a finished batch after cancellation flips', async () => {
    const { model, calls } = makeModel(new Map([[1, 101]]));
    const cache = new Map<number, number>();
    let cancellationChecks = 0;

    const result = await prewarmExpressToLocalCache(model, [1], cache, {
      batchSize: 1,
      isCancelled: () => {
        cancellationChecks += 1;
        return cancellationChecks > 1;
      },
    });

    expect(result).toMatchObject({
      resolved: 0,
      unresolved: 0,
      cancelled: true,
    });
    expect(calls).toEqual([1]);
    expect(cache.size).toBe(0);
  });

  it('yields between batches after committing the current batch', async () => {
    const { model } = makeModel(new Map([
      [1, 101],
      [2, 202],
      [3, 303],
    ]));
    const cache = new Map<number, number>();
    const cacheSizesAfterYield: number[] = [];

    await prewarmExpressToLocalCache(model, [1, 2, 3], cache, {
      batchSize: 1,
      yieldAfterBatch: () => {
        cacheSizesAfterYield.push(cache.size);
      },
    });

    expect(cacheSizesAfterYield).toEqual([1, 2]);
    expect(cache.size).toBe(3);
  });
});
