import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  requestPersistentStorage,
  requestPersistentStorageOnce,
  persistedStateLabel,
  _resetPersistOnceForTests,
  type StorageManagerLike,
} from '../fragmentCacheIDB';

// ---- requestPersistentStorage ----------------------------------------
//
// The helper accepts an injectable StorageManagerLike so vitest doesn't have
// to polyfill `navigator.storage`. Passing `null` forces the "unavailable"
// branch; passing `undefined` (or omitting the arg) falls back to the real
// `navigator.storage` if present.

describe('requestPersistentStorage', () => {
  it('returns "unavailable" when storage is explicitly null', async () => {
    expect(await requestPersistentStorage(null)).toBe('unavailable');
  });

  it('returns "persistent" without calling persist() when already persisted', async () => {
    const persist = vi.fn().mockResolvedValue(false);
    const sm: StorageManagerLike = {
      persisted: vi.fn().mockResolvedValue(true),
      persist,
    };
    expect(await requestPersistentStorage(sm)).toBe('persistent');
    expect(persist).not.toHaveBeenCalled();
  });

  it('returns "persistent" when persist() grants the request', async () => {
    const sm: StorageManagerLike = {
      persisted: vi.fn().mockResolvedValue(false),
      persist: vi.fn().mockResolvedValue(true),
    };
    expect(await requestPersistentStorage(sm)).toBe('persistent');
    expect(sm.persist).toHaveBeenCalledOnce();
  });

  it('returns "best-effort" when persist() denies the request', async () => {
    const sm: StorageManagerLike = {
      persisted: vi.fn().mockResolvedValue(false),
      persist: vi.fn().mockResolvedValue(false),
    };
    expect(await requestPersistentStorage(sm)).toBe('best-effort');
  });

  it('returns "unavailable" when persisted() throws', async () => {
    const sm: StorageManagerLike = {
      persisted: vi.fn().mockRejectedValue(new Error('SecurityError')),
      persist: vi.fn(),
    };
    expect(await requestPersistentStorage(sm)).toBe('unavailable');
  });

  it('returns "unavailable" when persist() throws', async () => {
    const sm: StorageManagerLike = {
      persisted: vi.fn().mockResolvedValue(false),
      persist: vi.fn().mockRejectedValue(new Error('SecurityError')),
    };
    expect(await requestPersistentStorage(sm)).toBe('unavailable');
  });
});

// ---- requestPersistentStorageOnce ------------------------------------
//
// Once-only guard: multiple concurrent / sequential callers share the same
// resolved value without re-prompting the user agent.

describe('requestPersistentStorageOnce', () => {
  beforeEach(() => {
    _resetPersistOnceForTests();
  });

  it('only calls persisted()/persist() once across multiple awaits', async () => {
    const persisted = vi.fn().mockResolvedValue(false);
    const persist = vi.fn().mockResolvedValue(true);
    const sm: StorageManagerLike = { persisted, persist };

    const a = requestPersistentStorageOnce(sm);
    const b = requestPersistentStorageOnce(sm);
    const c = requestPersistentStorageOnce(sm);

    const results = await Promise.all([a, b, c]);
    expect(results).toEqual(['persistent', 'persistent', 'persistent']);
    expect(persisted).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledOnce();
  });

  it('shares the same promise reference across concurrent callers', () => {
    const sm: StorageManagerLike = {
      persisted: vi.fn().mockResolvedValue(true),
      persist: vi.fn(),
    };
    const a = requestPersistentStorageOnce(sm);
    const b = requestPersistentStorageOnce(sm);
    expect(a).toBe(b);
  });

  it('re-runs after _resetPersistOnceForTests is called', async () => {
    const persisted = vi.fn().mockResolvedValue(true);
    const sm: StorageManagerLike = { persisted, persist: vi.fn() };
    await requestPersistentStorageOnce(sm);
    expect(persisted).toHaveBeenCalledOnce();
    _resetPersistOnceForTests();
    await requestPersistentStorageOnce(sm);
    expect(persisted).toHaveBeenCalledTimes(2);
  });
});

// ---- persistedStateLabel ---------------------------------------------
//
// Pure label producer rendered alongside the Fragment cache section in
// Settings → Performance.

describe('persistedStateLabel', () => {
  it('returns a green "Persistent" label when granted', () => {
    expect(persistedStateLabel('persistent')).toEqual({
      text: 'Persistent',
      tone: 'good',
    });
  });

  it('returns a warning "Best-effort" label when denied', () => {
    expect(persistedStateLabel('best-effort')).toEqual({
      text: 'Best-effort',
      tone: 'warn',
    });
  });

  it('returns a dimmed "Unavailable" label when the API is absent', () => {
    expect(persistedStateLabel('unavailable')).toEqual({
      text: 'Unavailable',
      tone: 'dim',
    });
  });

  it('returns a dimmed "Checking…" label for the null pre-request state', () => {
    expect(persistedStateLabel(null)).toEqual({
      text: 'Checking…',
      tone: 'dim',
    });
  });
});
