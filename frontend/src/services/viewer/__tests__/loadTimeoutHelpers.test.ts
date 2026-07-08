import { describe, it, expect } from 'vitest';
import {
  LIVE_PARSE_MAX_TIMEOUT_MS,
  LIVE_PARSE_MIN_TIMEOUT_MS,
  computeLiveParseTimeoutMs,
  raceWithTimeout,
} from '../loadTimeoutHelpers';

describe('computeLiveParseTimeoutMs', () => {
  it('returns the floor for zero / negative / NaN', () => {
    expect(computeLiveParseTimeoutMs(0)).toBe(LIVE_PARSE_MIN_TIMEOUT_MS);
    expect(computeLiveParseTimeoutMs(-1)).toBe(LIVE_PARSE_MIN_TIMEOUT_MS);
    expect(computeLiveParseTimeoutMs(Number.NaN)).toBe(LIVE_PARSE_MIN_TIMEOUT_MS);
  });

  it('returns the floor for tiny files where scaled < floor', () => {
    // 5 MB × 3000 ms/MB = 15 000 ms, below the 60 s floor.
    expect(computeLiveParseTimeoutMs(5 * 1024 * 1024)).toBe(LIVE_PARSE_MIN_TIMEOUT_MS);
  });

  it('scales linearly with file size', () => {
    // 50 MB × 3000 ms/MB = 150 000 ms.
    expect(computeLiveParseTimeoutMs(50 * 1024 * 1024)).toBe(150_000);
    // 100 MB → 300 s.
    expect(computeLiveParseTimeoutMs(100 * 1024 * 1024)).toBe(300_000);
  });

  it('clamps oversized files to the ceiling', () => {
    // 500 MB × 3000 ms/MB = 1 500 000 ms; clamped to 10 min ceiling.
    expect(computeLiveParseTimeoutMs(500 * 1024 * 1024)).toBe(LIVE_PARSE_MAX_TIMEOUT_MS);
  });

  it('treats fractional MB correctly', () => {
    // 2.5 MB × 3000 = 7500 ms → floor wins.
    expect(computeLiveParseTimeoutMs(2.5 * 1024 * 1024)).toBe(LIVE_PARSE_MIN_TIMEOUT_MS);
    // 25 MB × 3000 = 75 000 ms > 60 000 ms floor.
    expect(computeLiveParseTimeoutMs(25 * 1024 * 1024)).toBe(75_000);
  });
});

describe('raceWithTimeout', () => {
  it('resolves with the inner promise when it wins', async () => {
    const value = await raceWithTimeout(Promise.resolve('ok'), 1000, 'test');
    expect(value).toBe('ok');
  });

  it('rejects with a labelled error when the timer fires first', async () => {
    const slow = new Promise((resolve) => setTimeout(() => resolve('never'), 5000));
    await expect(raceWithTimeout(slow, 20, 'Live IFC parse')).rejects.toThrow(
      /Live IFC parse timed out after/,
    );
  });

  it('propagates inner-promise rejections without wrapping', async () => {
    const failing = Promise.reject(new Error('boom'));
    await expect(raceWithTimeout(failing, 1000, 'test')).rejects.toThrow('boom');
  });

  it('disables the timeout when timeoutMs <= 0', async () => {
    const value = await raceWithTimeout(Promise.resolve(42), 0, 'never');
    expect(value).toBe(42);
    const value2 = await raceWithTimeout(Promise.resolve(43), -10, 'never');
    expect(value2).toBe(43);
  });

  it('clears the timer when the inner promise wins to avoid leaks', async () => {
    // If the timer wasn't cleared, the rejection would still fire and
    // crash the test runner with an unhandled rejection.
    const fast = await raceWithTimeout(Promise.resolve('done'), 50, 'cleanup');
    expect(fast).toBe('done');
    // Wait past the original 50 ms timeout - no error should surface.
    await new Promise((r) => setTimeout(r, 80));
  });
});
