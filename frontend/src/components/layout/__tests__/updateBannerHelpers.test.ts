import { describe, expect, it } from 'vitest';

import {
  NOTES_MAX_LEN,
  UPDATE_SKIPPED_VERSION_KEY,
  UPDATE_SNOOZED_VERSION_KEY,
  readStoredVersion,
  shouldPromptForUpdate,
  skipVersion,
  snoozeVersion,
  truncateNotes,
  writeStoredVersion,
  type BannerStorage,
} from '../updateBannerHelpers';

function makeStorage(initial: Record<string, string> = {}): BannerStorage {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    getItem(key) {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key, value) {
      store.set(key, value);
    },
  };
}

function makeThrowingStorage(): BannerStorage {
  return {
    getItem() {
      throw new Error('storage disabled');
    },
    setItem() {
      throw new Error('storage disabled');
    },
  };
}

describe('updateBannerHelpers - version storage', () => {
  it('readStoredVersion returns null for null storage, missing keys, and empty values', () => {
    expect(readStoredVersion(null, UPDATE_SKIPPED_VERSION_KEY)).toBeNull();
    expect(readStoredVersion(makeStorage(), UPDATE_SKIPPED_VERSION_KEY)).toBeNull();
    expect(
      readStoredVersion(makeStorage({ [UPDATE_SKIPPED_VERSION_KEY]: '' }), UPDATE_SKIPPED_VERSION_KEY),
    ).toBeNull();
  });

  it('readStoredVersion returns null (not crash) when storage throws', () => {
    expect(readStoredVersion(makeThrowingStorage(), UPDATE_SKIPPED_VERSION_KEY)).toBeNull();
  });

  it('writeStoredVersion round-trips through readStoredVersion', () => {
    const storage = makeStorage();
    writeStoredVersion(storage, UPDATE_SKIPPED_VERSION_KEY, '2.0.0');
    expect(readStoredVersion(storage, UPDATE_SKIPPED_VERSION_KEY)).toBe('2.0.0');
  });

  it('writeStoredVersion is a silent no-op for null / throwing storage', () => {
    expect(() => writeStoredVersion(null, UPDATE_SKIPPED_VERSION_KEY, '2.0.0')).not.toThrow();
    expect(() => writeStoredVersion(makeThrowingStorage(), UPDATE_SKIPPED_VERSION_KEY, '2.0.0')).not.toThrow();
  });

  it('skipVersion / snoozeVersion write to their distinct keys', () => {
    const storage = makeStorage();
    skipVersion(storage, '3.1.0');
    snoozeVersion(storage, '3.2.0');
    expect(readStoredVersion(storage, UPDATE_SKIPPED_VERSION_KEY)).toBe('3.1.0');
    expect(readStoredVersion(storage, UPDATE_SNOOZED_VERSION_KEY)).toBe('3.2.0');
  });
});

describe('updateBannerHelpers - shouldPromptForUpdate', () => {
  const fresh = () => ({ skipped: makeStorage(), snoozed: makeStorage() });

  it('returns false when there is no result', () => {
    expect(shouldPromptForUpdate(null, fresh())).toBe(false);
  });

  it('returns false when no update is available', () => {
    expect(shouldPromptForUpdate({ available: false, version: '2.0.0' }, fresh())).toBe(false);
  });

  it('returns false when available but the version is missing', () => {
    expect(shouldPromptForUpdate({ available: true }, fresh())).toBe(false);
    expect(shouldPromptForUpdate({ available: true, version: null }, fresh())).toBe(false);
  });

  it('returns true for a fresh available version', () => {
    expect(shouldPromptForUpdate({ available: true, version: '2.0.0' }, fresh())).toBe(true);
  });

  it('returns false when the exact version was permanently skipped', () => {
    expect(
      shouldPromptForUpdate(
        { available: true, version: '2.0.0' },
        { skipped: makeStorage({ [UPDATE_SKIPPED_VERSION_KEY]: '2.0.0' }), snoozed: makeStorage() },
      ),
    ).toBe(false);
  });

  it('returns false when the exact version was snoozed this run', () => {
    expect(
      shouldPromptForUpdate(
        { available: true, version: '2.0.0' },
        { skipped: makeStorage(), snoozed: makeStorage({ [UPDATE_SNOOZED_VERSION_KEY]: '2.0.0' }) },
      ),
    ).toBe(false);
  });

  it('still prompts for a NEW version even after an older one was skipped', () => {
    // A skip is version-scoped: skipping 2.0.0 must not suppress 2.1.0.
    expect(
      shouldPromptForUpdate(
        { available: true, version: '2.1.0' },
        { skipped: makeStorage({ [UPDATE_SKIPPED_VERSION_KEY]: '2.0.0' }), snoozed: makeStorage() },
      ),
    ).toBe(true);
  });

  it('still prompts for a NEW version even after an older one was snoozed', () => {
    expect(
      shouldPromptForUpdate(
        { available: true, version: '2.1.0' },
        { skipped: makeStorage(), snoozed: makeStorage({ [UPDATE_SNOOZED_VERSION_KEY]: '2.0.0' }) },
      ),
    ).toBe(true);
  });

  it('flips true -> false after skipVersion on the same storage', () => {
    const skipped = makeStorage();
    const opts = { skipped, snoozed: makeStorage() };
    const res = { available: true as const, version: '2.0.0' };
    expect(shouldPromptForUpdate(res, opts)).toBe(true);
    skipVersion(skipped, '2.0.0');
    expect(shouldPromptForUpdate(res, opts)).toBe(false);
  });

  it('flips true -> false after snoozeVersion on the same storage', () => {
    const snoozed = makeStorage();
    const opts = { skipped: makeStorage(), snoozed };
    const res = { available: true as const, version: '2.0.0' };
    expect(shouldPromptForUpdate(res, opts)).toBe(true);
    snoozeVersion(snoozed, '2.0.0');
    expect(shouldPromptForUpdate(res, opts)).toBe(false);
  });

  it('prompts (does not crash) when both storages throw', () => {
    expect(
      shouldPromptForUpdate(
        { available: true, version: '2.0.0' },
        { skipped: makeThrowingStorage(), snoozed: makeThrowingStorage() },
      ),
    ).toBe(true);
  });
});

describe('updateBannerHelpers - truncateNotes', () => {
  it('returns null for empty / whitespace / nullish notes', () => {
    expect(truncateNotes(null)).toBeNull();
    expect(truncateNotes(undefined)).toBeNull();
    expect(truncateNotes('')).toBeNull();
    expect(truncateNotes('   \n  ')).toBeNull();
  });

  it('returns a short single-line note unchanged', () => {
    expect(truncateNotes('Fixes a crash on load.')).toBe('Fixes a crash on load.');
  });

  it('keeps only the first paragraph and collapses whitespace', () => {
    const notes = 'First   line here.\n\nSecond paragraph that should be dropped.';
    expect(truncateNotes(notes)).toBe('First line here.');
  });

  it('clamps to NOTES_MAX_LEN and appends an ellipsis', () => {
    const long = 'a'.repeat(NOTES_MAX_LEN + 50);
    const out = truncateNotes(long)!;
    expect(out.length).toBe(NOTES_MAX_LEN);
    expect(out.endsWith('…')).toBe(true);
  });
});
