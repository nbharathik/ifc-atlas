/**
 * IndexedDB fragment cache (v5).
 * Replaces the CacheStorage-based cache that lived inline in ViewerPanel.
 *
 * Why IDB over CacheStorage:
 *   - binary blobs stored directly as Uint8Array (no HTTP Response wrapper)
 *   - LRU eviction enforced at 500 MB so the quota stays predictable
 *   - timestamp index enables true oldest-first eviction
 *   - survives across refreshes and tab restores
 *
 * Drop-in API surface:
 *   readFragmentCacheIDB     ← readFragmentCache
 *   writeRawFragmentCacheIDB ← writeRawFragmentCache
 *   clearFragmentCacheIDB    ← window.caches.delete(FRAGMENT_CACHE_NAME)
 *   getFragmentCacheIDBStats ← window.caches.open(...).keys()
 *   scheduleFragmentCacheIDBPersist ← scheduleFragmentCachePersist
 */

import type * as FRAGS from '@thatopen/fragments';

// ---- constants -------------------------------------------------------

// IDB_NAME identifies the cache CONTENT generation - renaming it orphans
// every cached blob. Bookkeeping-only schema changes (like the recency
// side store) bump IDB_VERSION instead and leave IDB_NAME alone.
const IDB_NAME = 'ifc-fragment-cache-v1';
const IDB_VERSION = 2; // v2: adds the 'recency' side store
const STORE_FRAGS = 'fragments';
const STORE_META = 'meta';
// Tiny {key, ts} records live here so a cache-hit read can bump LRU
// recency without re-writing the multi-MB blob record through IndexedDB.
const STORE_RECENCY = 'recency';
const META_TOTAL_KEY = 'totalBytes';
const IDB_MAX_BYTES = 500 * 1024 * 1024; // 500 MB hard cap
const BALANCED_CACHE_MAX_BYTES = 512 * 1024 * 1024; // balanced-policy per-file cap
// Skip the recency write entirely when the entry was already touched
// within this window - keeps back-to-back warm loads write-free.
const RECENCY_FRESH_MS = 6 * 60 * 60 * 1000;

export type FragmentCachePolicy = 'aggressive' | 'balanced' | 'off';

// ---- pure helpers (exported for vitest) ------------------------------

/** True if the file should be written to cache under the given policy. */
export function shouldPersistIDB(
  bytesLength: number,
  policy: FragmentCachePolicy,
): boolean {
  if (policy === 'off') return false;
  if (policy === 'aggressive') return true;
  return bytesLength <= BALANCED_CACHE_MAX_BYTES;
}

/** Given a list of entries sorted ascending by `ts`, return the keys to
 *  delete so that `currentTotal + newBytes` fits within `maxBytes`. */
export function selectEvictionCandidates(
  entries: ReadonlyArray<{ key: string; ts: number; size: number }>,
  newBytes: number,
  currentTotal: number,
  maxBytes: number = IDB_MAX_BYTES,
): string[] {
  if (currentTotal + newBytes <= maxBytes) return [];
  const toDelete: string[] = [];
  let freed = 0;
  for (const e of entries) {
    if (currentTotal + newBytes - freed <= maxBytes) break;
    toDelete.push(e.key);
    freed += e.size;
  }
  return toDelete;
}

// ---- IDB schema types -----------------------------------------------

interface FragEntry {
  key: string;
  data: Uint8Array;
  ts: number;
  size: number;
}

interface MetaEntry {
  id: string;
  value: number;
}

interface RecencyEntry {
  key: string;
  ts: number;
}

// ---- lazy DB init ---------------------------------------------------

let _dbPromise: Promise<IDBDatabase> | null = null;

function openIDB(): Promise<IDBDatabase> {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      _dbPromise = null;
      reject(new Error('IndexedDB not available'));
      return;
    }
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);

    req.onupgradeneeded = (ev) => {
      const db = (ev.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_FRAGS)) {
        const store = db.createObjectStore(STORE_FRAGS, { keyPath: 'key' });
        store.createIndex('ts', 'ts', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'id' });
      }
      // v2: recency side store. Existing blob records are NOT migrated -
      // their own ts stays the recency fallback until first stale read.
      if (!db.objectStoreNames.contains(STORE_RECENCY)) {
        db.createObjectStore(STORE_RECENCY, { keyPath: 'key' });
      }
    };

    req.onsuccess = (ev) => resolve((ev.target as IDBOpenDBRequest).result);

    req.onerror = (ev) => {
      _dbPromise = null;
      reject((ev.target as IDBOpenDBRequest).error);
    };

    req.onblocked = () => {
      // Another tab has an older version open; wait.
    };
  });
  return _dbPromise;
}

// ---- internal IDB helpers ------------------------------------------

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getTotalBytes(db: IDBDatabase): Promise<number> {
  const tx = db.transaction(STORE_META, 'readonly');
  const store = tx.objectStore(STORE_META);
  const entry = await idbRequest<MetaEntry | undefined>(store.get(META_TOTAL_KEY));
  return entry?.value ?? 0;
}

async function setTotalBytes(db: IDBDatabase, value: number): Promise<void> {
  const tx = db.transaction(STORE_META, 'readwrite');
  tx.objectStore(STORE_META).put({ id: META_TOTAL_KEY, value } satisfies MetaEntry);
  await new Promise<void>((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

/** Fetch lightweight index (key, ts, size) for all cached entries sorted by
 *  effective recency asc. Recency comes from the side store when present;
 *  the blob record's own ts is the fallback for entries written before the
 *  v2 'recency' store existed (and for blobs never read since writing). */
async function getIndexEntries(
  db: IDBDatabase,
): Promise<Array<{ key: string; ts: number; size: number }>> {
  const blobs = await new Promise<Array<{ key: string; ts: number; size: number }>>(
    (resolve, reject) => {
      const tx = db.transaction(STORE_FRAGS, 'readonly');
      const index = tx.objectStore(STORE_FRAGS).index('ts');
      const results: Array<{ key: string; ts: number; size: number }> = [];
      const req = index.openCursor(null, 'next');
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const { key, ts, size } = cursor.value as FragEntry;
          results.push({ key, ts, size });
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      req.onerror = () => reject(req.error);
    },
  );
  const recencyTx = db.transaction(STORE_RECENCY, 'readonly');
  const recencyRows = await idbRequest<RecencyEntry[]>(
    recencyTx.objectStore(STORE_RECENCY).getAll(),
  );
  const recency = new Map(recencyRows.map((r) => [r.key, r.ts]));
  // max() guards against a stale side record surviving a blob overwrite:
  // a blob written after its last recency bump must count as newer.
  return blobs
    .map((e) => ({ ...e, ts: Math.max(e.ts, recency.get(e.key) ?? 0) }))
    .sort((a, b) => a.ts - b.ts);
}

/** Bump the side-store recency record for a cache hit. Skips the write
 *  entirely when the entry was touched within RECENCY_FRESH_MS. `blobTs`
 *  is the recency fallback for entries without a side record yet. */
async function bumpRecencyIfStale(
  db: IDBDatabase,
  key: string,
  blobTs: number,
): Promise<void> {
  const now = Date.now();
  const tx = db.transaction(STORE_RECENCY, 'readwrite');
  const store = tx.objectStore(STORE_RECENCY);
  const existing = await idbRequest<RecencyEntry | undefined>(store.get(key));
  const effectiveTs = Math.max(blobTs, existing?.ts ?? 0);
  if (now - effectiveTs < RECENCY_FRESH_MS) return;
  store.put({ key, ts: now } satisfies RecencyEntry);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Delete specified keys and update totalBytes atomically. */
async function deleteEntriesAndUpdateMeta(
  db: IDBDatabase,
  keys: string[],
  freedBytes: number,
  currentTotal: number,
): Promise<void> {
  if (keys.length === 0) return;
  const newTotal = Math.max(0, currentTotal - freedBytes);
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_FRAGS, STORE_META, STORE_RECENCY], 'readwrite');
    const fragStore = tx.objectStore(STORE_FRAGS);
    const metaStore = tx.objectStore(STORE_META);
    const recencyStore = tx.objectStore(STORE_RECENCY);
    for (const key of keys) {
      fragStore.delete(key);
      recencyStore.delete(key);
    }
    metaStore.put({ id: META_TOTAL_KEY, value: newTotal } satisfies MetaEntry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---- public API ----------------------------------------------------

/** Read fragment bytes from IDB cache. Returns null on miss or policy=off. */
export async function readFragmentCacheIDB(
  key: string,
  policy: FragmentCachePolicy,
): Promise<Uint8Array | null> {
  if (policy === 'off') return null;
  try {
    const db = await openIDB();
    const tx = db.transaction(STORE_FRAGS, 'readonly');
    const store = tx.objectStore(STORE_FRAGS);
    const entry = await idbRequest<FragEntry | undefined>(store.get(key));
    if (!entry?.data.byteLength) return null;
    // LRU recency lives in the tiny side store - never re-write the
    // multi-MB blob record just to bump a timestamp.
    try {
      await bumpRecencyIfStale(db, key, entry.ts);
    } catch {
      // recency bookkeeping is best-effort; the read itself succeeded
    }
    return entry.data;
  } catch {
    return null;
  }
}

/** Write raw fragment bytes to IDB cache. LRU evicts oldest if cap exceeded. */
export async function writeRawFragmentCacheIDB(
  key: string,
  bytes: Uint8Array,
  policy: FragmentCachePolicy,
): Promise<void> {
  if (!shouldPersistIDB(bytes.byteLength, policy)) return;
  try {
    const db = await openIDB();
    const total = await getTotalBytes(db);
    const indexEntries = await getIndexEntries(db);
    const candidates = selectEvictionCandidates(indexEntries, bytes.byteLength, total);

    if (candidates.length > 0) {
      const freed = indexEntries
        .filter((e) => candidates.includes(e.key))
        .reduce((s, e) => s + e.size, 0);
      await deleteEntriesAndUpdateMeta(db, candidates, freed, total);
    }

    const newTotal = Math.max(0, total - candidates.reduce((s, k) => {
      const e = indexEntries.find((x) => x.key === k);
      return s + (e?.size ?? 0);
    }, 0)) + bytes.byteLength;

    const entry: FragEntry = { key, data: bytes, ts: Date.now(), size: bytes.byteLength };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_FRAGS, STORE_META], 'readwrite');
      tx.objectStore(STORE_FRAGS).put(entry);
      tx.objectStore(STORE_META).put({ id: META_TOTAL_KEY, value: newTotal } satisfies MetaEntry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // best-effort
  }
}

/** Persist fragment bytes extracted from a live FragmentsModel. */
export async function persistFragmentCacheIDB(
  key: string,
  model: Pick<FRAGS.FragmentsModel, 'getBuffer'>,
  policy: FragmentCachePolicy,
): Promise<void> {
  if (policy === 'off') return;
  try {
    const buffer = await model.getBuffer(false);
    await writeRawFragmentCacheIDB(key, new Uint8Array(buffer), policy);
  } catch {
    // best-effort
  }
}

/** Schedule a low-priority persist (runs during idle time). */
export function scheduleFragmentCacheIDBPersist(
  key: string,
  model: Pick<FRAGS.FragmentsModel, 'getBuffer'>,
  policy: FragmentCachePolicy,
): void {
  if (policy === 'off') return;
  const run = () => { void persistFragmentCacheIDB(key, model, policy); };
  const ric = (typeof window !== 'undefined')
    ? (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback
    : undefined;
  if (ric) ric(run, { timeout: 4000 });
  else if (typeof window !== 'undefined') window.setTimeout(run, 600);
}

/** Delete all cached fragments and reset the totalBytes meta. */
export async function clearFragmentCacheIDB(): Promise<void> {
  try {
    const db = await openIDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_FRAGS, STORE_META, STORE_RECENCY], 'readwrite');
      tx.objectStore(STORE_FRAGS).clear();
      tx.objectStore(STORE_RECENCY).clear();
      tx.objectStore(STORE_META).put({ id: META_TOTAL_KEY, value: 0 } satisfies MetaEntry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // best-effort
  }
}

/** Return aggregate cache stats (entry count + total bytes). */
export async function getFragmentCacheIDBStats(): Promise<{
  count: number;
  totalBytes: number;
}> {
  try {
    const db = await openIDB();
    const tx = db.transaction([STORE_FRAGS, STORE_META], 'readonly');
    const countReq = tx.objectStore(STORE_FRAGS).count();
    const metaReq = tx.objectStore(STORE_META).get(META_TOTAL_KEY);
    const [count, meta] = await Promise.all([
      idbRequest<number>(countReq),
      idbRequest<MetaEntry | undefined>(metaReq),
    ]);
    return { count, totalBytes: meta?.value ?? 0 };
  } catch {
    return { count: 0, totalBytes: 0 };
  }
}

/** Reset the cached DB promise (used in tests to re-open after clear). */
export function _resetIDBPromiseForTests(): void {
  _dbPromise = null;
}

/** Test-only: raw blob-record ts + side-store recency ts for a key. */
export async function _getRecencyStateForTests(
  key: string,
): Promise<{ blobTs: number | null; recencyTs: number | null }> {
  const db = await openIDB();
  const tx = db.transaction([STORE_FRAGS, STORE_RECENCY], 'readonly');
  const [frag, rec] = await Promise.all([
    idbRequest<FragEntry | undefined>(tx.objectStore(STORE_FRAGS).get(key)),
    idbRequest<RecencyEntry | undefined>(tx.objectStore(STORE_RECENCY).get(key)),
  ]);
  return { blobTs: frag?.ts ?? null, recencyTs: rec?.ts ?? null };
}

/** Test-only: the merged (key, ts, size) list eviction actually consults. */
export async function _getEvictionOrderForTests(): Promise<
  Array<{ key: string; ts: number; size: number }>
> {
  const db = await openIDB();
  return getIndexEntries(db);
}

// ---- storage-persistence promotion ----------------------------------
//
// Browsers treat IndexedDB by default as "best-effort": the user agent
// may evict an origin's data under storage pressure or after long
// inactivity. Calling navigator.storage.persist() promotes the origin
// to "persistent" storage - only an explicit user-action (clear site
// data) can evict afterwards. This is exactly what we want for the
// fragment cache: a 500 MB hard cap that survives across sessions is
// only useful if the cache survives across sessions.

/** Promotion outcome reported back to the store. `null` means we have
 *  not yet attempted the request. */
export type PersistedState = 'persistent' | 'best-effort' | 'unavailable';

/** Minimal subset of the StorageManager interface we depend on. Lets
 *  vitest inject a fake without polyfilling `navigator.storage`. */
export interface StorageManagerLike {
  persisted(): Promise<boolean>;
  persist(): Promise<boolean>;
}

function resolveStorageManager(): StorageManagerLike | null {
  if (typeof navigator === 'undefined') return null;
  const storage = (navigator as Navigator).storage as
    | (StorageManager & Partial<StorageManagerLike>)
    | undefined;
  if (!storage) return null;
  if (typeof storage.persist !== 'function') return null;
  if (typeof storage.persisted !== 'function') return null;
  return storage as unknown as StorageManagerLike;
}

/** Request persistent storage from the user agent. Returns:
 *  - `'persistent'`  - already granted or just-granted; IDB won't be evicted silently.
 *  - `'best-effort'` - request was made but the UA denied (or hasn't decided);
 *                      fragment cache is still functional, just evictable.
 *  - `'unavailable'` - API not present (Safari < 16, very old browsers, etc.).
 *
 *  Pass `storage = null` to force the unavailable branch in tests; omit the
 *  argument to fall back to `navigator.storage`. */
export async function requestPersistentStorage(
  storage?: StorageManagerLike | null,
): Promise<PersistedState> {
  const sm = storage === undefined ? resolveStorageManager() : storage;
  if (!sm) return 'unavailable';
  try {
    if (await sm.persisted()) return 'persistent';
    const granted = await sm.persist();
    return granted ? 'persistent' : 'best-effort';
  } catch {
    return 'unavailable';
  }
}

let _persistOncePromise: Promise<PersistedState> | null = null;

/** Once-per-page-lifetime wrapper around `requestPersistentStorage`.
 *  Multiple concurrent callers share the same in-flight promise; later
 *  callers get the cached resolved value without re-prompting. */
export function requestPersistentStorageOnce(
  storage?: StorageManagerLike | null,
): Promise<PersistedState> {
  if (!_persistOncePromise) {
    _persistOncePromise = requestPersistentStorage(storage);
  }
  return _persistOncePromise;
}

/** Reset the once-only request gate (used by vitest between cases). */
export function _resetPersistOnceForTests(): void {
  _persistOncePromise = null;
}

/** Pure label helper consumed by the Settings panel badge + vitest. */
export function persistedStateLabel(state: PersistedState | null): {
  text: string;
  tone: 'good' | 'warn' | 'dim';
} {
  switch (state) {
    case 'persistent':
      return { text: 'Persistent', tone: 'good' };
    case 'best-effort':
      return { text: 'Best-effort', tone: 'warn' };
    case 'unavailable':
      return { text: 'Unavailable', tone: 'dim' };
    default:
      return { text: 'Checking…', tone: 'dim' };
  }
}
