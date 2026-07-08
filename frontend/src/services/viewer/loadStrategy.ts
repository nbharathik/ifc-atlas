/**
 * Cold-load fallback strategy.
 *
 * Purpose: surface the cold-load decision tree as **pure, testable helpers** so
 * the ViewerPanel cold-load branch can stop carrying its own ad-hoc gates. The
 * The goal, "flip server-convert from opt-in to always-on", is
 * implemented here by making the default-when-caps-unknown branch *attempt*
 * server-convert instead of skipping straight to worker-parse.
 *
 * Order of steps in `chooseColdLoadOrder` matches the runtime fallback chain
 * in `ViewerPanel.init()`:
 *
 *   1. `fragment-manifest` - server-side manifest fast-path (no IFC upload).
 *   2. `prebuild-wait`    - long-poll `/api/ifc/convert-status` if upload
 *                           scheduled a fire-and-forget pre-build.
 *   3. `server-convert`   - POST `/api/ifc/convert` (default; flipped here).
 *   4. `idb-cache`        - IndexedDB-cached fragment bytes for this fingerprint.
 *   5. `worker-parse`     - `IfcConvertWorker` web-worker parse.
 *   6. `live-parse`       - `OBC.IfcLoader` blocking main-thread parse.
 *
 * The order is fixed; the helper only decides which steps the runtime is
 * allowed to *attempt* given the inputs. `live-parse` is the universal safety
 * net - when `fileBytes` is present, it is always at the tail.
 */

import type { ServerConvertCapabilities } from '../ifc/serverConvert';

export type ColdLoadStep =
  | 'idb-cache'
  | 'fragment-manifest'
  | 'prebuild-wait'
  | 'server-convert'
  | 'worker-parse'
  | 'live-parse';

export interface ColdLoadInputs {
  /** Local IDB fragment-cache key is known and the cache policy is not 'off'. */
  hasCacheKey: boolean;
  /** Caller fetched IFC bytes and can re-upload them if needed. */
  hasFileBytes: boolean;
  /** Backend capability probe has completed (regardless of outcome). */
  capsKnown: boolean;
  /** Last-known capability snapshot from the backend, if any. */
  caps: ServerConvertCapabilities | null | undefined;
  /** Caller has a SHA-256 fingerprint of the IFC body for manifest / prebuild routes. */
  hasShaFingerprint: boolean;
  /** Prebuild-wait timeout is > 0 (user preference / store setting). */
  prebuildWaitAllowed: boolean;
  /**
   * Static viewer-only build (`BROWSER_ONLY`) - no backend exists, so every
   * server step is skipped and the order is idb-cache → worker-parse →
   * live-parse. Optional so existing callers/tests are unchanged.
   */
  browserOnly?: boolean;
}

/**
 * The "should attempt server-convert" gate. It defaults to attempting the
 * convert rather than requiring an explicit opt-in:
 *
 *  - If caps haven't been probed yet → ATTEMPT (the runtime can still probe
 *    inline with a short timeout; default behaviour is to try).
 *  - If caps say `server_convert: true` → ATTEMPT.
 *  - If caps say `server_convert: false` but the failure is recoverable →
 *    ATTEMPT (transient; treat as unknown).
 *  - If caps say `server_convert: false` with `recoverable: false` → SKIP
 *    (hard local setup failure; don't waste a round-trip).
 *
 * Always returns `false` when `hasFileBytes` is `false` - without bytes the
 * `POST /api/ifc/convert` body would be empty.
 */
export function shouldAttemptServerConvert(
  caps: ServerConvertCapabilities | null | undefined,
  hasFileBytes: boolean,
): boolean {
  if (!hasFileBytes) return false;
  if (!caps) return true;
  if (caps.server_convert) return true;
  return isRecoverableServerConvertFailure(caps);
}

/**
 * Should the runtime re-probe `/api/ifc/features` before attempting
 * server-convert? `true` when capabilities are unknown or the last probe
 * was recoverable/transient (treat as unknown, retry).
 */
export function shouldRepromoteCapabilities(
  caps: ServerConvertCapabilities | null | undefined,
): boolean {
  if (!caps) return true;
  if (caps.server_convert) return false;
  return isRecoverableServerConvertFailure(caps);
}

export function isRecoverableServerConvertFailure(
  caps: ServerConvertCapabilities | null | undefined,
): boolean {
  if (!caps) return true;
  if (caps.server_convert) return true;
  if (caps.recoverable === true) return true;
  if (caps.recoverable === false) return false;
  return isCapabilityProbeTimeoutReason(caps.reason) || isHttpServerErrorReason(caps.reason);
}

/**
 * Recognise a probe-timeout reason string. Kept in sync with the strings
 * produced by `getServerCapabilities` in `serverConvert.ts`. Case-insensitive
 * because reasons sometimes round-trip via HTTP and capitalisation can drift.
 */
export function isCapabilityProbeTimeoutReason(reason: string | undefined): boolean {
  if (!reason) return false;
  const lower = reason.toLowerCase();
  return lower.includes('timed out') || lower.includes('aborted after');
}

export function isHttpServerErrorReason(reason: string | undefined): boolean {
  if (!reason) return false;
  return /^http\s+5\d\d\b/i.test(reason.trim());
}

/**
 * Return the ordered list of cold-load steps the runtime is allowed to attempt
 * given the inputs. The returned list is non-empty when `hasFileBytes === true`
 * (live-parse is always the final safety net for that case); it can be empty
 * when there are no bytes AND no cached representation to load from.
 */
export function chooseColdLoadOrder(inputs: ColdLoadInputs): ColdLoadStep[] {
  const order: ColdLoadStep[] = [];

  if (inputs.browserOnly) {
    if (inputs.hasCacheKey) order.push('idb-cache');
    if (inputs.hasFileBytes) {
      order.push('worker-parse');
      order.push('live-parse');
    }
    return order;
  }

  if (inputs.hasShaFingerprint) order.push('fragment-manifest');

  if (
    inputs.hasShaFingerprint &&
    inputs.prebuildWaitAllowed &&
    isRecoverableServerConvertFailure(inputs.caps)
  ) {
    order.push('prebuild-wait');
  }

  if (shouldAttemptServerConvert(inputs.caps, inputs.hasFileBytes)) {
    order.push('server-convert');
  }

  if (inputs.hasCacheKey) order.push('idb-cache');

  if (inputs.hasFileBytes) {
    order.push('worker-parse');
    order.push('live-parse');
  }

  return order;
}

/**
 * Convenience: which of the *parsing* paths (server-convert, worker-parse,
 * live-parse) is the runtime's default first attempt? Useful for the
 * "Server convert chosen as default" activity-log entry - the activity log
 * should call out the *default flip* explicitly so a user reading the log
 * after a regression can see at a glance which path was tried first.
 */
export function defaultParsePathLabel(
  caps: ServerConvertCapabilities | null | undefined,
  hasFileBytes: boolean,
): 'server-convert' | 'worker-parse' | 'live-parse' | 'none' {
  if (!hasFileBytes) return 'none';
  if (shouldAttemptServerConvert(caps, hasFileBytes)) return 'server-convert';
  return 'worker-parse';
}
