import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  shouldPersistIDB,
  selectEvictionCandidates,
  readFragmentCacheIDB,
  writeRawFragmentCacheIDB,
  clearFragmentCacheIDB,
  getFragmentCacheIDBStats,
  _resetIDBPromiseForTests,
  _getRecencyStateForTests,
  _getEvictionOrderForTests,
} from '../fragmentCacheIDB';

const MB = 1024 * 1024;
const BALANCED_MAX = 512 * MB;
const IDB_MAX = 500 * MB;
const HOUR = 60 * 60 * 1000;
const SIX_HOURS = 6 * HOUR;

// ---- IDB environment setup ------------------------------------------
// Each describe block that needs IDB resets the promise + installs a
// fresh IDBFactory so tests don't share DB state.

function installFreshIDB() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).indexedDB = new IDBFactory();
  _resetIDBPromiseForTests();
}

// ---- shouldPersistIDB -----------------------------------------------

describe('shouldPersistIDB', () => {
  it('returns false for policy=off regardless of size', () => {
    expect(shouldPersistIDB(0, 'off')).toBe(false);
    expect(shouldPersistIDB(100 * MB, 'off')).toBe(false);
    expect(shouldPersistIDB(600 * MB, 'off')).toBe(false);
  });

  it('returns true for policy=aggressive regardless of size', () => {
    expect(shouldPersistIDB(0, 'aggressive')).toBe(true);
    expect(shouldPersistIDB(600 * MB, 'aggressive')).toBe(true);
  });

  it('returns true for policy=balanced when size <= 512 MB', () => {
    expect(shouldPersistIDB(BALANCED_MAX, 'balanced')).toBe(true);
    expect(shouldPersistIDB(BALANCED_MAX - 1, 'balanced')).toBe(true);
    expect(shouldPersistIDB(0, 'balanced')).toBe(true);
  });

  it('returns false for policy=balanced when size > 512 MB', () => {
    expect(shouldPersistIDB(BALANCED_MAX + 1, 'balanced')).toBe(false);
    expect(shouldPersistIDB(600 * MB, 'balanced')).toBe(false);
  });
});

// ---- selectEvictionCandidates ----------------------------------------

describe('selectEvictionCandidates', () => {
  const entry = (key: string, ts: number, size: number) => ({ key, ts, size });

  it('returns empty when total + new is within cap', () => {
    const entries = [entry('a', 1, 100 * MB), entry('b', 2, 100 * MB)];
    // total=200MB, new=100MB → 300MB < 500MB cap
    expect(selectEvictionCandidates(entries, 100 * MB, 200 * MB)).toEqual([]);
  });

  it('evicts oldest entries first (lowest ts)', () => {
    const entries = [
      entry('oldest', 1, 200 * MB),
      entry('middle', 2, 200 * MB),
      entry('newest', 3, 200 * MB),
    ];
    // total=600MB, new=50MB → need to free 150MB
    // oldest (200MB) is enough to free the 150MB overage
    const result = selectEvictionCandidates(entries, 50 * MB, 600 * MB);
    expect(result).toContain('oldest');
    expect(result).not.toContain('newest');
  });

  it('evicts multiple entries when one is not enough', () => {
    const entries = [
      entry('a', 1, 100 * MB),
      entry('b', 2, 100 * MB),
      entry('c', 3, 400 * MB),
    ];
    // total=600MB, new=100MB → 700MB, cap=500MB, need to free 200MB
    // a(100MB) + b(100MB) = 200MB freed - exactly enough
    const result = selectEvictionCandidates(entries, 100 * MB, 600 * MB);
    expect(result).toContain('a');
    expect(result).toContain('b');
    expect(result).not.toContain('c');
  });

  it('evicts all entries when total+new still exceeds cap after all', () => {
    const entries = [
      entry('x', 1, 50 * MB),
      entry('y', 2, 50 * MB),
    ];
    // total=100MB, new=450MB → 550MB, cap=500MB, need 50MB freed
    // x(50MB) alone is enough
    const result = selectEvictionCandidates(entries, 450 * MB, 100 * MB);
    expect(result).toContain('x');
    expect(result).not.toContain('y');
  });

  it('stops evicting as soon as enough space is freed', () => {
    const entries = [
      entry('big', 1, 300 * MB),
      entry('mid', 2, 100 * MB),
      entry('small', 3, 50 * MB),
    ];
    // total=450MB, new=100MB → 550MB > 500MB cap → need 50MB
    // big(300MB) alone clears it
    const result = selectEvictionCandidates(entries, 100 * MB, 450 * MB);
    expect(result).toEqual(['big']);
  });

  it('uses default 500MB cap when maxBytes omitted', () => {
    const entries = [entry('old', 1, 300 * MB)];
    // total=400MB, new=200MB → 600MB > 500MB cap
    const result = selectEvictionCandidates(entries, 200 * MB, 400 * MB);
    expect(result).toContain('old');
  });

  it('handles empty entry list without throwing', () => {
    expect(selectEvictionCandidates([], 100 * MB, 600 * MB, IDB_MAX)).toEqual([]);
  });

  it('respects a custom maxBytes cap', () => {
    const entries = [entry('x', 1, 50 * MB)];
    const customCap = 100 * MB;
    // total=80MB, new=30MB → 110MB > 100MB cap, need 10MB → evict x
    expect(selectEvictionCandidates(entries, 30 * MB, 80 * MB, customCap)).toEqual(['x']);
    // total=60MB, new=30MB → 90MB < 100MB cap - no eviction
    expect(selectEvictionCandidates(entries, 30 * MB, 60 * MB, customCap)).toEqual([]);
  });
});

// ---- IDB integration tests ------------------------------------------
// These tests require the fake-indexeddb polyfill and exercise the full
// read/write/clear/stats API against a real IDBFactory instance.

describe('readFragmentCacheIDB', () => {
  beforeEach(installFreshIDB);

  it('returns null on cache miss (empty store)', async () => {
    const result = await readFragmentCacheIDB('key-miss', 'aggressive');
    expect(result).toBeNull();
  });

  it('returns null when policy is off', async () => {
    // Write a value first, then read with policy=off
    const bytes = new Uint8Array([1, 2, 3]);
    await writeRawFragmentCacheIDB('k', bytes, 'aggressive');
    const result = await readFragmentCacheIDB('k', 'off');
    expect(result).toBeNull();
  });

  it('returns the stored bytes on a cache hit', async () => {
    const bytes = new Uint8Array([10, 20, 30, 40]);
    await writeRawFragmentCacheIDB('k-hit', bytes, 'aggressive');
    const result = await readFragmentCacheIDB('k-hit', 'aggressive');
    expect(result).not.toBeNull();
    expect(Array.from(result!)).toEqual([10, 20, 30, 40]);
  });
});

describe('writeRawFragmentCacheIDB', () => {
  beforeEach(installFreshIDB);

  it('writes bytes and they are retrievable', async () => {
    const bytes = new Uint8Array([7, 8, 9]);
    await writeRawFragmentCacheIDB('w-key', bytes, 'aggressive');
    const read = await readFragmentCacheIDB('w-key', 'aggressive');
    expect(read).not.toBeNull();
    expect(Array.from(read!)).toEqual([7, 8, 9]);
  });

  it('skips write when policy=off', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await writeRawFragmentCacheIDB('w-off', bytes, 'off');
    const read = await readFragmentCacheIDB('w-off', 'aggressive');
    expect(read).toBeNull();
  });

  it('overwrites an existing entry with the same key', async () => {
    const v1 = new Uint8Array([1]);
    const v2 = new Uint8Array([2, 3]);
    await writeRawFragmentCacheIDB('overwrite', v1, 'aggressive');
    await writeRawFragmentCacheIDB('overwrite', v2, 'aggressive');
    const read = await readFragmentCacheIDB('overwrite', 'aggressive');
    expect(Array.from(read!)).toEqual([2, 3]);
  });

  it('updates totalBytes stats after writing', async () => {
    const bytes = new Uint8Array(1024); // 1 KB
    await writeRawFragmentCacheIDB('stats-key', bytes, 'aggressive');
    const stats = await getFragmentCacheIDBStats();
    expect(stats.count).toBe(1);
    expect(stats.totalBytes).toBe(1024);
  });
});

describe('getFragmentCacheIDBStats', () => {
  beforeEach(installFreshIDB);

  it('returns zero count and bytes for empty cache', async () => {
    const stats = await getFragmentCacheIDBStats();
    expect(stats).toEqual({ count: 0, totalBytes: 0 });
  });

  it('counts multiple entries correctly', async () => {
    await writeRawFragmentCacheIDB('a', new Uint8Array(100), 'aggressive');
    await writeRawFragmentCacheIDB('b', new Uint8Array(200), 'aggressive');
    const stats = await getFragmentCacheIDBStats();
    expect(stats.count).toBe(2);
    expect(stats.totalBytes).toBe(300);
  });
});

describe('clearFragmentCacheIDB', () => {
  beforeEach(installFreshIDB);

  it('removes all entries and resets totalBytes to 0', async () => {
    await writeRawFragmentCacheIDB('del-a', new Uint8Array(512), 'aggressive');
    await writeRawFragmentCacheIDB('del-b', new Uint8Array(256), 'aggressive');

    const before = await getFragmentCacheIDBStats();
    expect(before.count).toBe(2);

    await clearFragmentCacheIDB();

    const after = await getFragmentCacheIDBStats();
    expect(after.count).toBe(0);
    expect(after.totalBytes).toBe(0);
  });

  it('subsequent reads return null after clear', async () => {
    await writeRawFragmentCacheIDB('clr', new Uint8Array([5, 6]), 'aggressive');
    await clearFragmentCacheIDB();
    const result = await readFragmentCacheIDB('clr', 'aggressive');
    expect(result).toBeNull();
  });
});

// ---- recency side store (LRU bookkeeping) ----------------------------
// Cache hits must NOT re-write the multi-MB blob record just to bump the
// LRU timestamp; recency lives in tiny {key, ts} side records instead.

describe('recency side store', () => {
  beforeEach(installFreshIDB);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const T0 = 1_000_000;

  it('stale read bumps the side record and leaves the blob record untouched', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(T0);
    await writeRawFragmentCacheIDB('bump', new Uint8Array([1, 2]), 'aggressive');

    nowSpy.mockReturnValue(T0 + SIX_HOURS + HOUR);
    const read = await readFragmentCacheIDB('bump', 'aggressive');
    expect(Array.from(read!)).toEqual([1, 2]);

    const state = await _getRecencyStateForTests('bump');
    expect(state.blobTs).toBe(T0); // blob record NOT rewritten
    expect(state.recencyTs).toBe(T0 + SIX_HOURS + HOUR);
  });

  it('recent read (within 6h) skips the side-record write entirely', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(T0);
    await writeRawFragmentCacheIDB('fresh', new Uint8Array([3]), 'aggressive');

    nowSpy.mockReturnValue(T0 + HOUR);
    const read = await readFragmentCacheIDB('fresh', 'aggressive');
    expect(read).not.toBeNull();

    const state = await _getRecencyStateForTests('fresh');
    expect(state.blobTs).toBe(T0);
    expect(state.recencyTs).toBeNull(); // no write happened
  });

  it('a second stale read within 6h of the bump does not write again', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(T0);
    await writeRawFragmentCacheIDB('twice', new Uint8Array([4]), 'aggressive');

    const firstBump = T0 + SIX_HOURS + HOUR;
    nowSpy.mockReturnValue(firstBump);
    await readFragmentCacheIDB('twice', 'aggressive');

    nowSpy.mockReturnValue(firstBump + HOUR);
    await readFragmentCacheIDB('twice', 'aggressive');

    const state = await _getRecencyStateForTests('twice');
    expect(state.recencyTs).toBe(firstBump);
  });

  it('eviction order consults side-record recency over blob ts', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(T0);
    await writeRawFragmentCacheIDB('a', new Uint8Array(10), 'aggressive');
    nowSpy.mockReturnValue(T0 + 1000);
    await writeRawFragmentCacheIDB('b', new Uint8Array(10), 'aggressive');

    // 'a' is older by blob ts, but a later read bumps its side record
    nowSpy.mockReturnValue(T0 + SIX_HOURS + HOUR);
    await readFragmentCacheIDB('a', 'aggressive');

    const order = await _getEvictionOrderForTests();
    expect(order.map((e) => e.key)).toEqual(['b', 'a']);

    // composed with the real candidate selector: 'b' gets evicted first
    // total=20, new=15 -> 35 > cap 30, freeing 'b' (10) is enough
    const victims = selectEvictionCandidates(order, 15, 20, 30);
    expect(victims).toEqual(['b']);
  });

  it('entries with no side record fall back to blob ts for eviction', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(T0);
    await writeRawFragmentCacheIDB('old', new Uint8Array(10), 'aggressive');
    nowSpy.mockReturnValue(T0 + 5000);
    await writeRawFragmentCacheIDB('newer', new Uint8Array(10), 'aggressive');

    const order = await _getEvictionOrderForTests();
    expect(order.map((e) => e.key)).toEqual(['old', 'newer']);
    const victims = selectEvictionCandidates(order, 15, 20, 30);
    expect(victims).toEqual(['old']);
  });

  it('upgrades a v1 database in place; pre-migration entries stay readable and evictable', async () => {
    // Hand-build the shipped v1 schema (fragments + meta only, no recency).
    const dbV1 = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('ifc-fragment-cache-v1', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        const store = db.createObjectStore('fragments', { keyPath: 'key' });
        store.createIndex('ts', 'ts', { unique: false });
        db.createObjectStore('meta', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = dbV1.transaction(['fragments', 'meta'], 'readwrite');
      tx.objectStore('fragments').put({
        key: 'legacy',
        data: new Uint8Array([9]),
        ts: 1234,
        size: 1,
      });
      tx.objectStore('meta').put({ id: 'totalBytes', value: 1 });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    dbV1.close();
    _resetIDBPromiseForTests(); // module reopens at v2 -> upgrade runs

    // Eviction order before any read: blob ts fallback applies.
    const order = await _getEvictionOrderForTests();
    expect(order).toEqual([{ key: 'legacy', ts: 1234, size: 1 }]);
    expect(selectEvictionCandidates(order, 30, 1, 20)).toEqual(['legacy']);

    const read = await readFragmentCacheIDB('legacy', 'aggressive');
    expect(Array.from(read!)).toEqual([9]);
  });

  it('clearFragmentCacheIDB wipes side records too', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(T0);
    await writeRawFragmentCacheIDB('c', new Uint8Array([1]), 'aggressive');
    nowSpy.mockReturnValue(T0 + SIX_HOURS + HOUR);
    await readFragmentCacheIDB('c', 'aggressive');
    expect((await _getRecencyStateForTests('c')).recencyTs).not.toBeNull();

    await clearFragmentCacheIDB();

    const state = await _getRecencyStateForTests('c');
    expect(state.blobTs).toBeNull();
    expect(state.recencyTs).toBeNull();
  });
});

describe('_resetIDBPromiseForTests', () => {
  it('allows a fresh DB to be opened after reset (no stale promise)', async () => {
    installFreshIDB();
    await writeRawFragmentCacheIDB('reset-test', new Uint8Array([99]), 'aggressive');
    const { count: c1 } = await getFragmentCacheIDBStats();
    expect(c1).toBe(1);

    // Reinstall a fresh factory + reset promise → should see an empty DB
    installFreshIDB();
    const { count: c2 } = await getFragmentCacheIDBStats();
    expect(c2).toBe(0);
  });
});
