/**
 * Vitest coverage for the pre-build wait pref helpers.
 *
 * The store + Settings UI rely on these for clamping any raw input -
 * Settings-form numbers, legacy localStorage payloads, ad-hoc JSON pushed
 * in by other tabs - into a safe `{ timeoutMs, pollIntervalMs }` shape.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREBUILD_WAIT_PREFS,
  PREBUILD_POLL_MAX_MS,
  PREBUILD_POLL_MIN_MS,
  PREBUILD_TIMEOUT_MAX_MS,
  PREBUILD_TIMEOUT_MIN_MS,
  clampPrebuildPref,
  sanitisePrebuildWaitPrefs,
} from '../fragmentPrebuildPrefs';

const TIMEOUT_OPTS = {
  min: PREBUILD_TIMEOUT_MIN_MS,
  max: PREBUILD_TIMEOUT_MAX_MS,
  fallback: DEFAULT_PREBUILD_WAIT_PREFS.timeoutMs,
};

describe('clampPrebuildPref', () => {
  it('returns numbers within range unchanged', () => {
    expect(clampPrebuildPref(5_000, TIMEOUT_OPTS)).toBe(5_000);
  });

  it('rounds fractional values', () => {
    expect(clampPrebuildPref(123.7, TIMEOUT_OPTS)).toBe(124);
  });

  it('clamps below the minimum', () => {
    expect(clampPrebuildPref(-10, TIMEOUT_OPTS)).toBe(PREBUILD_TIMEOUT_MIN_MS);
  });

  it('clamps above the maximum', () => {
    expect(clampPrebuildPref(999_999, TIMEOUT_OPTS)).toBe(PREBUILD_TIMEOUT_MAX_MS);
  });

  it('falls back for NaN', () => {
    expect(clampPrebuildPref(Number.NaN, TIMEOUT_OPTS)).toBe(TIMEOUT_OPTS.fallback);
  });

  it('falls back for ±Infinity', () => {
    expect(clampPrebuildPref(Number.POSITIVE_INFINITY, TIMEOUT_OPTS)).toBe(
      TIMEOUT_OPTS.fallback,
    );
    expect(clampPrebuildPref(Number.NEGATIVE_INFINITY, TIMEOUT_OPTS)).toBe(
      TIMEOUT_OPTS.fallback,
    );
  });

  it('falls back for non-numeric strings', () => {
    expect(clampPrebuildPref('nope', TIMEOUT_OPTS)).toBe(TIMEOUT_OPTS.fallback);
    expect(clampPrebuildPref(null, TIMEOUT_OPTS)).toBe(TIMEOUT_OPTS.fallback);
    expect(clampPrebuildPref(undefined, TIMEOUT_OPTS)).toBe(TIMEOUT_OPTS.fallback);
  });

  it('parses numeric strings (Settings form input)', () => {
    expect(clampPrebuildPref('1500', TIMEOUT_OPTS)).toBe(1500);
  });
});

describe('sanitisePrebuildWaitPrefs', () => {
  it('returns defaults for null / undefined input', () => {
    expect(sanitisePrebuildWaitPrefs(null)).toEqual(DEFAULT_PREBUILD_WAIT_PREFS);
    expect(sanitisePrebuildWaitPrefs(undefined)).toEqual(DEFAULT_PREBUILD_WAIT_PREFS);
  });

  it('returns defaults for an empty object', () => {
    expect(sanitisePrebuildWaitPrefs({})).toEqual(DEFAULT_PREBUILD_WAIT_PREFS);
  });

  it('passes valid prefs straight through', () => {
    expect(
      sanitisePrebuildWaitPrefs({ timeoutMs: 4000, pollIntervalMs: 500 }),
    ).toEqual({ timeoutMs: 4000, pollIntervalMs: 500 });
  });

  it('clamps poll interval to the timeout when poll > timeout', () => {
    expect(
      sanitisePrebuildWaitPrefs({ timeoutMs: 500, pollIntervalMs: 5000 }),
    ).toEqual({ timeoutMs: 500, pollIntervalMs: 500 });
  });

  it('keeps the poll interval intact when timeout is 0 (wait disabled)', () => {
    expect(
      sanitisePrebuildWaitPrefs({ timeoutMs: 0, pollIntervalMs: 750 }),
    ).toEqual({ timeoutMs: 0, pollIntervalMs: 750 });
  });

  it('respects the poll-interval floor', () => {
    const result = sanitisePrebuildWaitPrefs({
      timeoutMs: 6000,
      pollIntervalMs: 50, // below PREBUILD_POLL_MIN_MS
    });
    expect(result.pollIntervalMs).toBe(PREBUILD_POLL_MIN_MS);
  });

  it('respects the poll-interval ceiling', () => {
    const result = sanitisePrebuildWaitPrefs({
      timeoutMs: PREBUILD_TIMEOUT_MAX_MS,
      pollIntervalMs: PREBUILD_POLL_MAX_MS + 99_999,
    });
    expect(result.pollIntervalMs).toBe(PREBUILD_POLL_MAX_MS);
  });

  it('clamps an absurdly large timeout to the ceiling', () => {
    const result = sanitisePrebuildWaitPrefs({
      timeoutMs: 5_000_000,
      pollIntervalMs: 1000,
    });
    expect(result.timeoutMs).toBe(PREBUILD_TIMEOUT_MAX_MS);
  });
});
