/**
 * Vitest coverage for the `prebuildWaitPrefs` store slice.
 *
 * Reducer-level only: the helper sanitisation it relies on is covered in
 * `services/ifc/__tests__/fragmentPrebuildPrefs.test.ts`. These tests
 * verify that the store wires those helpers up correctly and persists
 * through `localStorage`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../useStore';
import {
  DEFAULT_PREBUILD_WAIT_PREFS,
  PREBUILD_POLL_MAX_MS,
  PREBUILD_TIMEOUT_MAX_MS,
} from '../../services/ifc/fragmentPrebuildPrefs';

/** Minimal in-memory localStorage stub so the persistence assertion works
 *  in vitest's default Node environment (no jsdom). The store's setter
 *  routes writes through a try/catch'd `writePref`, so the absence of
 *  `globalThis.localStorage` is silent in production code - we only need
 *  the stub when explicitly asserting on persisted state. */
function installLocalStorageStub(): { store: Map<string, string> } {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  });
  return { store };
}

function reset() {
  useStore.setState({ prebuildWaitPrefs: { ...DEFAULT_PREBUILD_WAIT_PREFS } });
}

describe('prebuildWaitPrefs store slice', () => {
  beforeEach(reset);

  it('initialises to the documented defaults', () => {
    expect(useStore.getState().prebuildWaitPrefs).toEqual(DEFAULT_PREBUILD_WAIT_PREFS);
  });

  it('setPrebuildWaitTimeoutMs clamps below zero to zero (wait disabled)', () => {
    useStore.getState().setPrebuildWaitTimeoutMs(-500);
    expect(useStore.getState().prebuildWaitPrefs.timeoutMs).toBe(0);
  });

  it('setPrebuildWaitTimeoutMs clamps above the ceiling', () => {
    useStore.getState().setPrebuildWaitTimeoutMs(99_999_999);
    expect(useStore.getState().prebuildWaitPrefs.timeoutMs).toBe(PREBUILD_TIMEOUT_MAX_MS);
  });

  it('setPrebuildWaitTimeoutMs caps the poll interval to the new timeout', () => {
    useStore.getState().setPrebuildWaitPollIntervalMs(5_000);
    useStore.getState().setPrebuildWaitTimeoutMs(1_500);
    expect(useStore.getState().prebuildWaitPrefs.pollIntervalMs).toBe(1_500);
  });

  it('setPrebuildWaitTimeoutMs(0) keeps the existing poll interval', () => {
    useStore.getState().setPrebuildWaitPollIntervalMs(750);
    useStore.getState().setPrebuildWaitTimeoutMs(0);
    const state = useStore.getState().prebuildWaitPrefs;
    expect(state.timeoutMs).toBe(0);
    expect(state.pollIntervalMs).toBe(750);
  });

  it('setPrebuildWaitPollIntervalMs clamps to its ceiling', () => {
    useStore.getState().setPrebuildWaitTimeoutMs(PREBUILD_TIMEOUT_MAX_MS);
    useStore.getState().setPrebuildWaitPollIntervalMs(99_999_999);
    expect(useStore.getState().prebuildWaitPrefs.pollIntervalMs).toBe(PREBUILD_POLL_MAX_MS);
  });

  it('setPrebuildWaitPollIntervalMs ignores NaN and falls back to default', () => {
    useStore.getState().setPrebuildWaitPollIntervalMs(Number.NaN);
    expect(useStore.getState().prebuildWaitPrefs.pollIntervalMs).toBe(
      DEFAULT_PREBUILD_WAIT_PREFS.pollIntervalMs,
    );
  });

  it('resetPrebuildWaitPrefs restores defaults', () => {
    useStore.getState().setPrebuildWaitTimeoutMs(1_000);
    useStore.getState().setPrebuildWaitPollIntervalMs(250);
    useStore.getState().resetPrebuildWaitPrefs();
    expect(useStore.getState().prebuildWaitPrefs).toEqual(DEFAULT_PREBUILD_WAIT_PREFS);
  });

  it('persists the updated prefs through localStorage', () => {
    const { store } = installLocalStorageStub();
    useStore.getState().setPrebuildWaitTimeoutMs(4_500);
    useStore.getState().setPrebuildWaitPollIntervalMs(500);
    const stored = store.get('pref.prebuildWait.v1');
    expect(stored).toBeDefined();
    expect(JSON.parse(stored!)).toEqual({ timeoutMs: 4_500, pollIntervalMs: 500 });
    vi.unstubAllGlobals();
  });
});
