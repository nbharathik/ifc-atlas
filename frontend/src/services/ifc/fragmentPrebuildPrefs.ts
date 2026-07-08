/**
 * Pure helpers for the user-tunable
 * `waitForFragmentReady` budget.
 *
 * Lives outside `serverConvert.ts` so the store + Settings UI can import
 * a tiny, dependency-free module without dragging the fetch helpers into
 * their test surface. Mirrors the pattern used by
 * `fragmentCacheIDB.ts:persistedStateLabel` etc.
 */

export interface PrebuildWaitPrefs {
  /** Hard wall-clock budget across all polls combined (milliseconds). */
  timeoutMs: number;
  /** Per-request `wait_ms` passed to the backend (milliseconds). */
  pollIntervalMs: number;
}

/** Defaults applied when no user pref is stored (and the floor for sanitisation). */
export const DEFAULT_PREBUILD_WAIT_PREFS: PrebuildWaitPrefs = Object.freeze({
  timeoutMs: 30_000,
  pollIntervalMs: 1_000,
});

/** Allowed range for the total wait timeout. 0 disables the wait entirely
 *  (caller falls through to `/convert` immediately). 30 000 ms matches the
 *  backend's hard cap on `wait_ms` (see `ifc_routes.get_convert_status`). */
export const PREBUILD_TIMEOUT_MIN_MS = 0;
export const PREBUILD_TIMEOUT_MAX_MS = 30_000;

/** Poll interval bounds. Lower bound matches `waitForFragmentReady`'s own
 *  floor in `serverConvert.ts` so the user never sees a value that the
 *  helper would silently clamp. Upper bound = max timeout. */
export const PREBUILD_POLL_MIN_MS = 100;
export const PREBUILD_POLL_MAX_MS = 30_000;

export interface ClampOptions {
  min: number;
  max: number;
  fallback: number;
}

/** Clamp a single numeric pref to `[min, max]`, falling back to `fallback`
 *  for NaN / infinity / non-numeric input. Pure - safe for store + UI.
 *
 *  `null` / `undefined` / empty string fall back explicitly because the
 *  default `Number(...)` coercion turns them into `0` / `NaN` respectively,
 *  which would otherwise look like a valid "wait disabled" choice. */
export function clampPrebuildPref(value: unknown, opts: ClampOptions): number {
  if (value === null || value === undefined) return opts.fallback;
  if (typeof value === 'string' && value.trim() === '') return opts.fallback;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return opts.fallback;
  if (n < opts.min) return opts.min;
  if (n > opts.max) return opts.max;
  return Math.round(n);
}

/** Sanitise an arbitrary `{ timeoutMs?, pollIntervalMs? }`-shaped object,
 *  reading from `localStorage` JSON or a Settings form. The poll interval
 *  is additionally capped at the (sanitised) timeout so a misconfigured
 *  pair like `{ timeoutMs: 500, pollIntervalMs: 5_000 }` doesn't make
 *  the helper poll less often than the budget allows. */
export function sanitisePrebuildWaitPrefs(
  raw: Partial<PrebuildWaitPrefs> | null | undefined,
): PrebuildWaitPrefs {
  const timeoutMs = clampPrebuildPref(raw?.timeoutMs, {
    min: PREBUILD_TIMEOUT_MIN_MS,
    max: PREBUILD_TIMEOUT_MAX_MS,
    fallback: DEFAULT_PREBUILD_WAIT_PREFS.timeoutMs,
  });
  const pollRaw = clampPrebuildPref(raw?.pollIntervalMs, {
    min: PREBUILD_POLL_MIN_MS,
    max: PREBUILD_POLL_MAX_MS,
    fallback: DEFAULT_PREBUILD_WAIT_PREFS.pollIntervalMs,
  });
  // When timeoutMs is 0 the user has disabled the wait entirely; keep the
  // pollInterval at its sanitised value so flipping the timeout back on
  // doesn't surprise them with a default-reset poll.
  const pollIntervalMs =
    timeoutMs > 0 && pollRaw > timeoutMs ? timeoutMs : pollRaw;
  return { timeoutMs, pollIntervalMs };
}
