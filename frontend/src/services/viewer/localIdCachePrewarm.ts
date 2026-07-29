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

export interface ResolveExpressToLocalOptions {
  readonly batchSize?: number;
  /** Second-level cache consulted before falling back to the model. */
  readonly getRemembered?: (expressId: number) => number | null;
}

/**
 * Resolve express IDs to local IDs, in request order, populating `cache`.
 *
 * Unlike {@link prewarmExpressToLocalCache} this returns the ids, so it serves
 * the interactive selection and highlight paths rather than a warm-up pass.
 * Unresolvable ids are omitted rather than represented by a sentinel.
 */
export async function resolveExpressToLocal(
  model: LocalIdLookupModel,
  expressIds: readonly number[],
  cache: Map<number, number>,
  options: ResolveExpressToLocalOptions = {},
): Promise<number[]> {
  const out: number[] = [];
  const misses: number[] = [];
  for (const id of expressIds) {
    const cached = cache.get(id);
    if (cached !== undefined) {
      out.push(cached);
      continue;
    }
    const remembered = options.getRemembered?.(id) ?? null;
    if (remembered !== null) {
      cache.set(id, remembered);
      out.push(remembered);
    } else {
      misses.push(id);
    }
  }
  if (misses.length === 0) return out;

  const batchSize = normalizeBatchSize(options.batchSize ?? 64);
  for (let start = 0; start < misses.length; start += batchSize) {
    const batch = misses.slice(start, start + batchSize);
    const results = await Promise.all(
      batch.map(async (expressId) => {
        try {
          const localId = await model.getItem(expressId).getLocalId();
          return localId == null ? null : { expressId, localId };
        } catch {
          return null;
        }
      }),
    );
    for (const entry of results) {
      if (!entry) continue;
      cache.set(entry.expressId, entry.localId);
      out.push(entry.localId);
    }
    if (start + batchSize < misses.length) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  return out;
}
