export interface LocalIdLookupItem {
  getLocalId: () => Promise<number | null | undefined>;
}

export interface LocalIdLookupModel {
  getItem: (expressId: number) => LocalIdLookupItem;
}

export interface PrewarmExpressToLocalCacheOptions {
  readonly batchSize?: number;
  readonly isCancelled?: () => boolean;
  readonly yieldAfterBatch?: () => Promise<void> | void;
}

export interface PrewarmExpressToLocalCacheResult {
  readonly requested: number;
  readonly unique: number;
  readonly skippedCached: number;
  readonly skippedDuplicate: number;
  readonly resolved: number;
  readonly unresolved: number;
  readonly cancelled: boolean;
}

const DEFAULT_BATCH_SIZE = 32;

function normalizeBatchSize(batchSize: number | undefined): number {
  if (batchSize === undefined || !Number.isFinite(batchSize)) return DEFAULT_BATCH_SIZE;
  return Math.max(1, Math.floor(batchSize));
}

type ResolveResult =
  | { kind: 'resolved'; expressId: number; localId: number }
  | { kind: 'unresolved' };

export async function prewarmExpressToLocalCache(
  model: LocalIdLookupModel,
  expressIds: readonly number[],
  cache: Map<number, number>,
  options: PrewarmExpressToLocalCacheOptions = {},
): Promise<PrewarmExpressToLocalCacheResult> {
  const missing: number[] = [];
  const seen = new Set<number>();
  let skippedCached = 0;
  let skippedDuplicate = 0;

  for (const expressId of expressIds) {
    if (seen.has(expressId)) {
      skippedDuplicate += 1;
      continue;
    }
    seen.add(expressId);
    if (cache.has(expressId)) {
      skippedCached += 1;
    } else {
      missing.push(expressId);
    }
  }

  const batchSize = normalizeBatchSize(options.batchSize);
  let resolved = 0;
  let unresolved = 0;
  let cancelled = false;

  for (let start = 0; start < missing.length; start += batchSize) {
    if (options.isCancelled?.()) {
      cancelled = true;
      break;
    }

    const batch = missing.slice(start, start + batchSize);
    const results = await Promise.all(
      batch.map(async (expressId): Promise<ResolveResult> => {
        try {
          const localId = await model.getItem(expressId).getLocalId();
          if (localId == null) return { kind: 'unresolved' };
          return { kind: 'resolved', expressId, localId };
        } catch {
          return { kind: 'unresolved' };
        }
      }),
    );
    if (options.isCancelled?.()) {
      cancelled = true;
      break;
    }

    for (const result of results) {
      if (result.kind === 'resolved') {
        cache.set(result.expressId, result.localId);
        resolved += 1;
      } else {
        unresolved += 1;
      }
    }

    if (start + batchSize < missing.length) {
      await options.yieldAfterBatch?.();
    }
  }

  return {
    requested: expressIds.length,
    unique: seen.size,
    skippedCached,
    skippedDuplicate,
    resolved,
    unresolved,
    cancelled,
  };
}
