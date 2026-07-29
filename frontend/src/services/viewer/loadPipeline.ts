import type * as FRAGS from '@thatopen/fragments';
import {
  EXPECTED_FRAGMENTS_FORMAT_VERSION,
  type ServerConvertCapabilities,
} from '../ifc/serverConvert';
import type { ParseProfile } from './parseProfiles';

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

/**
 * Size-scaled timeout helpers for the IFC load pipeline.
 *
 * The previous implementation used a single 15-second timeout for the
 * server-converted fragment load path and NO timeout for the worker-parse
 * or live-parse fallbacks. On large models (3,800+ elements / 100+ MB IFC)
 * a broken FragmentsManager worker would cause the viewer to hang
 * indefinitely at "Finalizing fragment model 92 %" because:
 *
 *   1. `loadFragmentsWithTimeout` fires its 15 s timeout on the server path
 *   2. Fall through to worker-parse, which loads fragments via the SAME
 *      broken FragmentsManager worker → also times out
 *   3. Fall through to live-parse (`ifcLoader.load`), which has NO timeout
 *      → hangs forever
 *
 * These helpers scale timeouts by file size so legitimate slow loads on
 * big models still succeed, while broken workers fail cleanly within a
 * bounded budget.
 */

/**
 * Base timeout for the server-converted fragment `core.load(bytes)` step.
 *
 * Set to 60 s so a large server-converted model does not fall through to
 * the (much slower) worker-parse fallback: a 3 800-element / 100+ MB IFC
 * needs this headroom. Server-converted fragments
 * are pre-processed so the in-browser parse should be quick (typically
 * 2-10 s), but big models genuinely need more headroom. The hard timeout
 * still protects against a permanently broken FragmentsManager worker.
 */
export const FRAGMENT_LOAD_BASE_TIMEOUT_MS = 60_000;

/**
 * Compute a size-scaled fragment-load timeout for server-converted bytes.
 * Fragments are pre-processed so loading is ~0.5 s per MB of fragment, but
 * we keep the 60 s floor for first-load setup overhead.
 */
export function computeFragmentLoadTimeoutMs(fragBytesLength: number): number {
  if (!Number.isFinite(fragBytesLength) || fragBytesLength <= 0) {
    return FRAGMENT_LOAD_BASE_TIMEOUT_MS;
  }
  const mb = fragBytesLength / (1024 * 1024);
  const scaled = mb * 500; // 0.5 s per MB of fragment binary
  return Math.max(FRAGMENT_LOAD_BASE_TIMEOUT_MS, scaled);
}

/** Per-element coordinate-system reset is fast - storey previews stay short. */
export const STOREY_FRAGMENT_LOAD_TIMEOUT_MS = 5_000;

/** Lower bound for the live-parse timeout. Even tiny files need WASM setup. */
export const LIVE_PARSE_MIN_TIMEOUT_MS = 60_000;

/** Upper bound - anything past this is a hang, not a slow load. */
export const LIVE_PARSE_MAX_TIMEOUT_MS = 600_000;

/**
 * Compute a size-scaled timeout for the worker-parse / live-parse fallback
 * paths. These paths run the full WASM CSG pipeline in the browser, so the
 * wall-clock cost grows roughly linearly with file size. We allow ~3 seconds
 * per MB of IFC plus a one-minute setup floor.
 *
 * Examples:
 *   -   5 MB  →  60 s   (floor)
 *   -  50 MB  → 150 s
 *   - 100 MB  → 300 s
 *   - 200 MB  → 600 s   (clamped to max)
 */
export function computeLiveParseTimeoutMs(fileSizeBytes: number): number {
  if (!Number.isFinite(fileSizeBytes) || fileSizeBytes <= 0) {
    return LIVE_PARSE_MIN_TIMEOUT_MS;
  }
  const mb = fileSizeBytes / (1024 * 1024);
  const scaled = mb * 3_000; // ~3 s per MB of IFC
  const total = Math.max(LIVE_PARSE_MIN_TIMEOUT_MS, scaled);
  return Math.min(LIVE_PARSE_MAX_TIMEOUT_MS, total);
}

/**
 * Race an arbitrary promise against a hard timeout. Used to wrap
 * `workerClient.convert()` and `ifcLoader.load()` so the viewer never
 * hangs indefinitely when WASM workers break or stall.
 */
export async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorLabel: string,
): Promise<T> {
  if (timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${errorLabel} timed out after ${(timeoutMs / 1000).toFixed(0)} s`));
      }, timeoutMs);
    });
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Fragment-cache fingerprint helpers.
// SubtleCrypto SHA-1 when available; FNV + rolling mix fallback otherwise.

export function buildFnvFingerprint(bytes: Uint8Array): string {
  const length = bytes.length;
  if (length === 0) return '0-0';

  let h1 = 2166136261;
  let h2 = 2246822519;
  for (let i = 0; i < length; i++) {
    const b = bytes[i];
    h1 ^= b;
    h1 = Math.imul(h1, 16777619);
    h2 ^= (b + (i & 0xff));
    h2 = Math.imul(h2, 1597334677);
  }

  return `${length.toString(16)}-${(h1 >>> 0).toString(16)}-${(h2 >>> 0).toString(16)}`;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += (b < 16 ? '0' : '') + b.toString(16);
  }
  return out;
}

export async function buildFragmentCacheFingerprint(bytes: Uint8Array): Promise<string> {
  const length = bytes.length;
  if (length === 0) return '0-0';

  const subtle =
    typeof globalThis !== 'undefined'
      ? (globalThis.crypto as Crypto | undefined)?.subtle
      : undefined;

  if (subtle && typeof subtle.digest === 'function') {
    try {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const digest = await subtle.digest('SHA-1', copy);
      const digestBytes = new Uint8Array(digest);
      return `${length.toString(16)}-${bytesToHex(digestBytes)}`;
    } catch {
      // Fall through to FNV below.
    }
  }

  return buildFnvFingerprint(bytes);
}


// Cache keys use a stable prefix so they can be invalidated by version bumps.
export const FRAGMENT_CACHE_PREFIX = '/__ifc_frag_cache__/';
/**
 * Binary artifact compatibility identity shared by browser parses and
 * sidecar-produced fragments. Bump the final parse revision whenever importer
 * settings or coordinate policy change, even if dependency versions do not.
 */
export const FRAGMENT_ARTIFACT_COMPATIBILITY =
  `v2-fragments-${EXPECTED_FRAGMENTS_FORMAT_VERSION}-web-ifc-0.0.77-parse-r2`;

export interface ViewerLoadProgress {
  title: string;
  detail: string;
  progress: number;
  sourceHint: string;
}

export type ViewerModelLoadSource =
  | 'ifc-parse'
  | 'fragments-cache'
  | 'server-convert'
  | 'server-cache'
  | 'worker-parse'
  | 'geometry-patch';

export type ServerFragmentSource = 'cache' | 'sidecar';

export const MIN_VALID_SERVER_FRAGMENT_BYTES = 4 * 1024;
export const SERVER_FRAGMENT_LOAD_RETRIES = 3;
export const VIEWER_PERF_LOG_STORAGE_KEY = 'ifc-viewer-perf-log';
export const VIEWER_PERF_LOG_LIMIT = 50;

export type ViewerLoadStageTimingKey =
  | 'cacheReadMs'
  | 'cacheLoadMs'
  | 'ifcSetupMs'
  | 'parseMs'
  | 'sidecarMs';

export type ViewerLoadStageTimings = Partial<Record<ViewerLoadStageTimingKey, number>>;

export interface ViewerPerfLogEntry {
  ts: number;
  source: ViewerModelLoadSource;
  ttfrMs: number;
  ttfgMs: number;
  loadMs: number | null;
}

export interface ViewerReadyMetrics {
  ttfrMs: number;
  loadMs: number | null;
  cacheHitRate: number;
}

export const IMPORT_STAGE_LABELS: Record<FRAGS.ProgressData['process'], string> = {
  geometries: 'Streaming geometry batches',
  attributes: 'Indexing element attributes',
  relations: 'Linking model relations',
  // Fragments emits `conversion:start` before WASM init/OpenModel and does not
  // finish it until compression, so "finalizing" is misleading for most of
  // this potentially long stage.
  conversion: 'Processing model data',
};

export type FragmentManagerWithCore = {
  core: {
    settings: { autoCoordinate: boolean; graphicsQuality: number };
    load: (
      bytes: Uint8Array,
      options: { modelId: string },
    ) => Promise<FRAGS.FragmentsModel>;
    _data?: { _modelThread?: Map<string, unknown> };
  };
};

export function isBackendShaFingerprint(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

export function normalizeImportProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  const pct = progress <= 1 ? progress * 100 : progress;
  return Math.max(0, Math.min(100, pct));
}

export function formatImportProgressDetail(data: FRAGS.ProgressData): string {
  const stateLabel =
    data.state === 'start'
      ? 'starting'
      : data.state === 'finish'
        ? 'done'
        : 'in progress';

  const details: string[] = [stateLabel];
  if (data.class) {
    details.push(data.class);
  }
  if (typeof data.entitiesProcessed === 'number') {
    details.push(`${data.entitiesProcessed.toLocaleString()} entities`);
  }
  return details.join(' • ');
}

export async function buildFragmentCacheKey(
  bytes: Uint8Array,
  profile: ParseProfile,
): Promise<string> {
  const fingerprint = await buildFragmentCacheFingerprint(bytes);
  const coordinatePolicy = profile === 'quality' || profile === 'balanced'
    ? 'auto-coordinate'
    : 'local-origin';
  return `${FRAGMENT_CACHE_PREFIX}${FRAGMENT_ARTIFACT_COMPATIBILITY}-${profile}-${coordinatePolicy}-${fingerprint}.frag`;
}

export function makeViewerModelId(prefix = 'ifc'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function serverCapabilityWaitMs(fileSizeBytes: number): number {
  return fileSizeBytes >= 40 * 1024 * 1024 ? 22_000 : 6_000;
}

export function shouldUseServerFragmentManifest(inputs: {
  hasFileBytes: boolean;
  fingerprint: string | null | undefined;
  serverConvertAvailable: boolean | undefined;
}): inputs is {
  hasFileBytes: false;
  fingerprint: string;
  serverConvertAvailable: true;
} {
  return (
    !inputs.hasFileBytes &&
    isBackendShaFingerprint(inputs.fingerprint) &&
    inputs.serverConvertAvailable === true
  );
}

export function shouldWaitForServerPrebuild(inputs: {
  caps: ServerConvertCapabilities | null | undefined;
  fingerprint: string | null | undefined;
  timeoutMs: number;
}): inputs is {
  caps: ServerConvertCapabilities | null | undefined;
  fingerprint: string;
  timeoutMs: number;
} {
  return (
    isRecoverableServerConvertFailure(inputs.caps) &&
    isBackendShaFingerprint(inputs.fingerprint) &&
    inputs.timeoutMs > 0
  );
}

export function isSuspiciousServerFragmentBytes(
  bytes: Uint8Array | ArrayBuffer | null | undefined,
): bytes is Uint8Array | ArrayBuffer {
  return !!bytes && bytes.byteLength < MIN_VALID_SERVER_FRAGMENT_BYTES;
}

export function modelLoadSourceForServerFragmentSource(
  source: ServerFragmentSource,
): ViewerModelLoadSource {
  return source === 'cache' ? 'server-cache' : 'server-convert';
}

export function isCacheHitModelLoadSource(source: ViewerModelLoadSource): boolean {
  return source === 'fragments-cache' || source === 'server-cache';
}

export function isPrebuiltGeometrySource(source: ViewerModelLoadSource): boolean {
  return isCacheHitModelLoadSource(source) || source === 'server-convert';
}

export function modelLoadSourceHint(source: ViewerModelLoadSource): string {
  if (isCacheHitModelLoadSource(source)) return 'Cache hit';
  if (source === 'server-convert') return 'Server convert';
  if (source === 'worker-parse') return 'Worker parse';
  return 'Live parse';
}

export function attachGeometryTitle(source: ViewerModelLoadSource): string {
  return isPrebuiltGeometrySource(source)
    ? 'Attaching pre-built geometry'
    : 'Attaching parsed geometry';
}

export function modelLoadSourceLabel(source: ViewerModelLoadSource): string {
  const labels: Record<ViewerModelLoadSource, string> = {
    'fragments-cache': 'local-fragment-cache',
    'server-cache': 'server-cache',
    'server-convert': 'server-convert',
    'worker-parse': 'worker-parse',
    'ifc-parse': 'live-parse',
    'geometry-patch': 'Geometry delta patch',
  };
  return labels[source];
}

export function nextCacheHitRate(
  previousRate: number | null | undefined,
  source: ViewerModelLoadSource,
): number {
  const hitSample = isCacheHitModelLoadSource(source) ? 100 : 0;
  return previousRate == null
    ? hitSample
    : (previousRate * 0.8) + (hitSample * 0.2);
}

export function computeViewerReadyMetrics(inputs: {
  source: ViewerModelLoadSource;
  initStartMs: number;
  nowMs: number;
  loadStartTs: number | null | undefined;
  wallClockNowMs: number;
  previousCacheHitRate: number | null | undefined;
}): ViewerReadyMetrics {
  return {
    ttfrMs: inputs.nowMs - inputs.initStartMs,
    loadMs: inputs.loadStartTs ? inputs.wallClockNowMs - inputs.loadStartTs : null,
    cacheHitRate: nextCacheHitRate(inputs.previousCacheHitRate, inputs.source),
  };
}

export function buildViewerPerfLogEntry(inputs: {
  timestampMs: number;
  source: ViewerModelLoadSource;
  ttfrMs: number;
  ttfgMs: number;
  loadMs: number | null;
}): ViewerPerfLogEntry {
  return {
    ts: inputs.timestampMs,
    source: inputs.source,
    ttfrMs: Math.round(inputs.ttfrMs),
    ttfgMs: Math.round(inputs.ttfgMs),
    loadMs: inputs.loadMs ? Math.round(inputs.loadMs) : null,
  };
}

export function prependViewerPerfLogEntry(
  existing: unknown[],
  entry: ViewerPerfLogEntry,
  limit = VIEWER_PERF_LOG_LIMIT,
): unknown[] {
  return [entry, ...existing].slice(0, limit);
}

export function formatStageTimings(timings: ViewerLoadStageTimings): string {
  const timingTuples: Array<[string, number | undefined]> = [
    ['cache read', timings.cacheReadMs],
    ['sidecar', timings.sidecarMs],
    ['cache load', timings.cacheLoadMs],
    ['ifc setup', timings.ifcSetupMs],
    ['parse', timings.parseMs],
  ];
  return timingTuples
    .filter(([, ms]) => typeof ms === 'number')
    .map(([label, ms]) => `${label}: ${(ms as number).toFixed(0)} ms`)
    .join(' | ');
}

export function formatViewerReadySummary(
  source: ViewerModelLoadSource,
  ttfrMs: number,
  ttfgMs: number,
): string {
  return `${modelLoadSourceLabel(source)} ready in ${ttfrMs.toFixed(0)} ms (TTFR), first geometry ${ttfgMs.toFixed(0)} ms (TTFG)`;
}

export function formatUnknownLoadError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const obj = error as Record<string, unknown>;
    return JSON.stringify({
      message: obj.message,
      type: obj.type,
      error: obj.error,
      reason: obj.reason,
      filename: obj.filename,
      lineno: obj.lineno,
    });
  }
  return String(error);
}

export function clearFragmentThreadPlaceholder(
  fragmentsManager: FragmentManagerWithCore,
  modelId: string,
): void {
  try {
    fragmentsManager.core._data?._modelThread?.delete(modelId);
  } catch {
    // Best-effort cleanup for @thatopen/fragments load failures.
  }
}

export async function loadFragmentsWithTimeout(
  fragmentsManager: FragmentManagerWithCore,
  bytes: Uint8Array | ArrayBuffer,
  modelId: string,
  options: {
    timeoutMs?: number;
    autoCoordinate?: boolean;
    /**
     * Load-time graphics-quality seed. The engine copies
     * core.settings.graphicsQuality onto the model exactly once during
     * load() (the engine DEFAULT is 0 = lowest quality), so without an
     * explicit seed the model's quality depends on whatever the interaction
     * ladder happened to write last. Bracketed save/restore, same pattern
     * as autoCoordinate above.
     */
    graphicsQuality?: number;
  } = {},
): Promise<FRAGS.FragmentsModel> {
  const timeoutMs = options.timeoutMs ?? FRAGMENT_LOAD_BASE_TIMEOUT_MS;
  const prevAutoCoordinate = fragmentsManager.core.settings.autoCoordinate;
  const hasAutoCoordinateOverride = typeof options.autoCoordinate === 'boolean';
  if (hasAutoCoordinateOverride) {
    fragmentsManager.core.settings.autoCoordinate = options.autoCoordinate!;
  }
  const prevGraphicsQuality = fragmentsManager.core.settings.graphicsQuality;
  const hasGraphicsQualityOverride = typeof options.graphicsQuality === 'number';
  if (hasGraphicsQualityOverride) {
    fragmentsManager.core.settings.graphicsQuality = options.graphicsQuality!;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  let loadPromise: Promise<FRAGS.FragmentsModel> | null = null;
  try {
    const fragmentBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    loadPromise = fragmentsManager.core.load(fragmentBytes, { modelId });
    if (timeoutMs <= 0) return await loadPromise;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        clearFragmentThreadPlaceholder(fragmentsManager, modelId);
        reject(new Error(`Fragment load timed out after ${timeoutMs} ms`));
      }, timeoutMs);
    });
    return await Promise.race([loadPromise, timeoutPromise]);
  } catch (error) {
    if (timedOut && loadPromise) {
      // Fragments does not currently expose an AbortSignal for load(). A late
      // success after our timeout would otherwise register an orphan model
      // beside the fresh retry and leak its worker/GPU resources. Quarantine
      // that unique model id and dispose the result as soon as it arrives.
      void loadPromise.then(
        async (lateModel) => {
          try { await lateModel.dispose(); } catch { /* already detached */ }
          clearFragmentThreadPlaceholder(fragmentsManager, modelId);
        },
        () => clearFragmentThreadPlaceholder(fragmentsManager, modelId),
      );
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (hasAutoCoordinateOverride) {
      fragmentsManager.core.settings.autoCoordinate = prevAutoCoordinate;
    }
    if (hasGraphicsQualityOverride) {
      fragmentsManager.core.settings.graphicsQuality = prevGraphicsQuality;
    }
  }
}

/**
 * Presentation layer for the viewer load overlay.
 *
 * The load pipeline in ViewerPanel reports raw technical checkpoints
 * (title, detail, progress, sourceHint). This module translates them into
 * what a person actually sees:
 *
 *   - a four-stage journey with plain-language names,
 *   - a display percent that is monotonic, never frozen, and paced by how
 *     long each phase is expected to take (so the bar tracks wall-clock
 *     time instead of jumping between far-apart checkpoints),
 *   - an honest time line: elapsed always, a remaining estimate only when
 *     this machine's own load history backs it up.
 *
 * Everything here is pure data-in data-out so it can be unit tested without
 * React or the viewer.
 */


// ── Stage model ────────────────────────────────────────────────────────────

export type LoadStageId = 'open' | 'prepare' | 'build' | 'finish';

export interface LoadStageInfo {
  id: LoadStageId;
  /** 0-based position in the journey; drives the stepper UI. */
  index: number;
  /** Short user-facing name. Sentence case, no jargon. */
  label: string;
}

export const LOAD_STAGES: readonly LoadStageInfo[] = [
  { id: 'open', index: 0, label: 'Opening file' },
  { id: 'prepare', index: 1, label: 'Building 3D model' },
  { id: 'build', index: 2, label: 'Preparing view' },
  { id: 'finish', index: 3, label: 'Almost ready' },
] as const;

const STAGE_BY_ID: Record<LoadStageId, LoadStageInfo> = {
  open: LOAD_STAGES[0],
  prepare: LOAD_STAGES[1],
  build: LOAD_STAGES[2],
  finish: LOAD_STAGES[3],
};

/**
 * Map a raw pipeline checkpoint to its user-facing stage.
 *
 * The raw percent values are stable constants of the load pipeline
 * (4/10/16/22/26 startup, 28-70 conversion, 70-94 fragment load, 94-100
 * finalize), so percent plus the sourceHint is enough to classify without
 * touching the ~30 call sites in ViewerPanel.
 */
export function deriveLoadStage(progress: number, sourceHint: string): LoadStageInfo {
  if (progress >= 97) return STAGE_BY_ID.finish;
  const hint = sourceHint.toLowerCase();
  // Browser parse paths stay in "prepare" until their 94% handoff: the
  // 28-92 band is all parse work, not view preparation.
  if (hint.includes('parse')) {
    return progress >= 93 ? STAGE_BY_ID.build : progressAtLeast(progress, 24, 'prepare');
  }
  // Waiting on a server pre-build is conversion work, even at raw 22 -
  // but its raw-70 checkpoint is the fetched-fragment load, which is
  // view preparation like every other 70+ checkpoint.
  if (hint.includes('pre-build')) {
    return progress >= 70 ? STAGE_BY_ID.build : STAGE_BY_ID.prepare;
  }
  // Fetching or loading already-built fragments is view preparation.
  if (progress >= 50 && (
    hint.includes('manifest') || hint.includes('cache') || hint.includes('storey')
  )) {
    return STAGE_BY_ID.build;
  }
  if (progress >= 70) return STAGE_BY_ID.build;
  if (progress >= 26) return STAGE_BY_ID.prepare;
  return STAGE_BY_ID.open;
}

function progressAtLeast(progress: number, threshold: number, id: LoadStageId): LoadStageInfo {
  return progress >= threshold ? STAGE_BY_ID[id] : STAGE_BY_ID.open;
}

// ── Friendly copy ──────────────────────────────────────────────────────────

/**
 * Plain-language names for the converter's internal phase tokens. Both the
 * worker-parse path (raw.title) and the sidecar progress snapshots
 * (raw.detail, after the ViewerPanel callback passes the token through)
 * surface these raw strings; without this map users literally see
 * "geometries" as a headline.
 */
const PROCESS_STAGE_COPY: Record<string, string> = {
  geometries: 'Building shapes',
  attributes: 'Reading element data',
  relations: 'Linking elements',
  // `conversion` spans importer initialization, OpenModel, geometry work, and
  // final compression; it is not a signal that only packing remains.
  conversion: 'Processing model data',
  parsing: 'Reading the file',
  // The live-parse path titles checkpoints with IMPORT_STAGE_LABELS values
  // rather than raw process tokens; translate those too.
  'streaming geometry batches': 'Building shapes',
  'indexing element attributes': 'Reading element data',
  'linking model relations': 'Linking elements',
  'processing model data': 'Processing model data',
};

export function humanizeProcessStage(token: string | null | undefined): string | null {
  if (!token) return null;
  return PROCESS_STAGE_COPY[token.trim().toLowerCase()] ?? null;
}

export interface LoadPresentation {
  stage: LoadStageInfo;
  /** Big line: what is happening, in plain words. */
  title: string;
  /** Supporting line: one concrete, human sentence. */
  detail: string;
  /** Eyebrow chip naming the load kind, or null while unknown. */
  chip: string | null;
  /** One-line reassurance shown on cold loads, or null. */
  caption: string | null;
  /** Raw pipeline detail, for the small technical sub-line. */
  techDetail: string;
}

/**
 * Recover the inner work percent from the raw band mappings so the copy can
 * say "62% done" without threading extra state through the pipeline.
 * Bands: server convert maps pct into 30-70, worker/live parse into 28-92.
 */
export function innerWorkPercent(progress: number, sourceHint: string): number | null {
  const hint = sourceHint.toLowerCase();
  if (hint.includes('convert') && progress >= 30 && progress < 70) {
    return Math.round(Math.min(100, Math.max(0, (progress - 30) / 0.4)));
  }
  if (hint.includes('parse') && progress >= 28 && progress < 93) {
    return Math.round(Math.min(100, Math.max(0, (progress - 28) / 0.64)));
  }
  return null;
}

const COLD_LOAD_CAPTION = 'First open builds a cache, later opens are faster';

/** Compose the user-facing strings for a raw pipeline report. */
export function presentLoadProgress(
  raw: ViewerLoadProgress,
  context: {
    fileName?: string | null;
    fileSizeMB?: number | null;
    cachesEnabled?: boolean;
  } = {},
): LoadPresentation {
  const stage = deriveLoadStage(raw.progress, raw.sourceHint);
  const hint = raw.sourceHint.toLowerCase();
  const kind = pathKindForSourceHint(raw.sourceHint);
  const fileLabel = context.fileName
    ? context.fileSizeMB && context.fileSizeMB >= 1
      ? `${context.fileName} (${context.fileSizeMB.toFixed(0)} MB)`
      : context.fileName
    : null;

  let title: string = stage.label;
  let detail = '';

  switch (stage.id) {
    case 'open': {
      detail = fileLabel ? `Reading ${fileLabel}` : 'Reading the model file';
      break;
    }
    case 'prepare': {
      const pct = innerWorkPercent(raw.progress, raw.sourceHint);
      const subStage =
        humanizeProcessStage(raw.detail) ?? humanizeProcessStage(raw.title);
      const work = subStage ?? 'Turning the file into 3D shapes';
      if (hint.includes('pre-build')) {
        detail = 'The server is converting this file, first open can take a minute';
      } else if (pct != null && pct > 0) {
        detail = `${work}, ${pct}% done`;
      } else {
        detail = work;
      }
      break;
    }
    case 'build': {
      detail = kind === 'cached'
        ? 'Found a saved copy, loading it now'
        : 'Loading the model into the viewer';
      break;
    }
    case 'finish': {
      if (raw.progress >= 100) title = 'Ready';
      detail = 'Setting up the camera and controls';
      break;
    }
  }

  const chip =
    kind === 'cached' ? 'From cache'
      : kind === 'server-convert' ? 'First load'
        : kind === 'browser-parse' ? 'In-browser'
          : null;

  const caption =
    context.cachesEnabled !== false
      && (kind === 'server-convert' || kind === 'browser-parse')
      && stage.id === 'prepare'
      ? COLD_LOAD_CAPTION
      : null;

  return { stage, title, detail, chip, caption, techDetail: raw.detail };
}

// ── Expected-duration model (priors + this machine's history) ─────────────

export type LoadPathKind = 'cached' | 'server-convert' | 'browser-parse' | 'unknown';

/** Classify the active load path from the pipeline's sourceHint. */
export function pathKindForSourceHint(sourceHint: string): LoadPathKind {
  const hint = sourceHint.toLowerCase();
  if (hint.includes('parse')) return 'browser-parse';
  if (hint.includes('convert') || hint.includes('pre-build')) return 'server-convert';
  // Only confirmed hits/serves count as the cached path; probe hints like
  // "Cache check" or "Manifest check" must stay unknown or the chip lies
  // on cold loads ('Server manifest' is the confirmed-hit hint).
  if (
    hint.includes('cache hit')
    || hint.includes('server manifest')
    || hint.includes('server cache')
    || hint.includes('fragment-cache')
    || hint.includes('fragments-cache')
  ) {
    return 'cached';
  }
  return 'unknown';
}

const PATH_SOURCES: Record<Exclude<LoadPathKind, 'unknown'>, string[]> = {
  cached: ['server-cache', 'fragments-cache'],
  'server-convert': ['server-convert'],
  'browser-parse': ['worker-parse', 'ifc-parse'],
};

/** Fallback expectations (ms) when this machine has no history yet. */
const PRIOR_TOTAL_MS: Record<LoadPathKind, number> = {
  cached: 12_000,
  'server-convert': 30_000,
  'browser-parse': 45_000,
  unknown: 25_000,
};

export interface ExpectedTotal {
  ms: number;
  /** True when the estimate comes from real samples on this machine. */
  fromHistory: boolean;
}

/**
 * Expected total load duration for a path, using the median of this
 * machine's recent loads of the same kind (from the localStorage perf log)
 * and falling back to fixed priors. History wins because the dominant cost
 * (CPU geometry conversion) is machine-specific. `fromHistory` is only true
 * with 2+ samples, which also gates whether the UI shows a remaining-time
 * estimate at all.
 */
export function estimateExpectedTotal(
  kind: LoadPathKind,
  history: ViewerPerfLogEntry[] | null | undefined,
): ExpectedTotal {
  if (kind === 'unknown' || !history?.length) {
    return { ms: PRIOR_TOTAL_MS[kind], fromHistory: false };
  }
  const sources = PATH_SOURCES[kind];
  const samples = history
    .filter((e) => e && sources.includes(e.source) && Number.isFinite(e.ttfrMs) && e.ttfrMs > 0)
    .slice(0, 5)
    .map((e) => e.ttfrMs)
    .sort((a, b) => a - b);
  if (!samples.length) return { ms: PRIOR_TOTAL_MS[kind], fromHistory: false };
  const median = samples[Math.floor(samples.length / 2)];
  // Clamp to a sane window so one corrupted sample cannot wedge the pacing.
  return {
    ms: Math.min(600_000, Math.max(1_500, median)),
    fromHistory: samples.length >= 2,
  };
}

// ── Pace model ─────────────────────────────────────────────────────────────
//
// Between checkpoints the displayed percent approaches a ceiling just below
// the next known checkpoint, with a time constant proportional to how much
// of the total load that gap is expected to take. The result:
//   - always moving (no frozen bar),
//   - never overtakes reality by more than one checkpoint,
//   - long phases advance slowly and honestly instead of stalling,
//   - when a real checkpoint lands early the bar sweeps up fast, which
//     reads as the load "speeding up" near completion.

export interface PaceMilestone {
  /** Raw checkpoint band start (inclusive). */
  from: number;
  /** Display ceiling while inside this band. */
  ceiling: number;
  /** Expected share of total load time spent inside this band. */
  share: number;
}

/**
 * Band table for the production pipeline. `from` values mirror the raw
 * checkpoint constants in ViewerPanel's init(). The conversion band (28-70)
 * receives continuous raw updates, so its ceiling rides a few points above
 * the latest raw value instead of a fixed number.
 */
export const PACE_MILESTONES: readonly PaceMilestone[] = [
  { from: 0, ceiling: 12, share: 0.04 },
  { from: 10, ceiling: 18, share: 0.04 },
  { from: 14, ceiling: 24, share: 0.04 },
  { from: 22, ceiling: 32, share: 0.06 },
  { from: 28, ceiling: 69.5, share: 0.42 },
  { from: 70, ceiling: 93.5, share: 0.22 },
  { from: 94, ceiling: 95.5, share: 0.06 },
  { from: 96, ceiling: 97.5, share: 0.06 },
  { from: 98, ceiling: 99.4, share: 0.06 },
] as const;

function milestoneFor(anchor: number): PaceMilestone {
  let current = PACE_MILESTONES[0];
  for (const m of PACE_MILESTONES) {
    if (anchor >= m.from) current = m;
    else break;
  }
  return current;
}

export interface PaceState {
  /** Latest raw checkpoint from the pipeline. */
  anchor: number;
  /** Displayed percent (monotonic). */
  display: number;
  /** Expected total load duration driving the time constants. */
  expectedTotalMs: number;
}

export function createPaceState(initialRaw: number, expectedTotalMs: number): PaceState {
  const raw = clampPct(initialRaw);
  return { anchor: raw, display: raw, expectedTotalMs };
}

function clampPct(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

/** How fast the display closes the gap to a freshly-raised checkpoint. */
const CATCH_UP_MS = 450;

/**
 * Token motion (0.5% per minute) used when the pipeline has regressed
 * below the anchor (a server path was abandoned and a browser parse
 * restarted): the bar must not climb toward a ceiling the pipeline
 * abandoned, but must also never look frozen.
 */
const FALLBACK_CRAWL_PCT_PER_MS = 0.5 / 60_000;

/**
 * Advance the pace model by `dtMs`. Pure: returns the next state.
 *
 * `rawPct` below the current anchor is ignored (fallback branches can
 * re-report lower checkpoints; the user must never see the bar move back).
 * `rawPct >= 100` snaps to 100 so completion lands cleanly.
 */
export function advancePace(state: PaceState, rawPct: number, dtMs: number): PaceState {
  const raw = clampPct(rawPct);
  const anchor = Math.max(state.anchor, raw);
  if (anchor >= 100) {
    return { ...state, anchor: 100, display: 100 };
  }
  const dt = Math.max(0, dtMs);
  let display = state.display;

  if (display < anchor) {
    // A real checkpoint moved ahead of the display: sweep up quickly.
    const gap = anchor - display;
    display += gap * Math.min(1, dt / CATCH_UP_MS);
  } else {
    // Drift toward the band ceiling with a duration-aware time constant.
    const band = milestoneFor(anchor);
    const inConversionBand = anchor >= 28 && anchor < 70;
    const ceiling = inConversionBand
      ? Math.min(band.ceiling, anchor + 6)
      : band.ceiling;
    const headroom = ceiling - display;
    if (headroom > 0.05) {
      if (raw < anchor) {
        // Fallback regime: the pipeline re-reported below the anchor.
        // Crawl instead of drifting so the bar stays honest until the
        // restarted path catches back up.
        display += Math.min(headroom, dt * FALLBACK_CRAWL_PCT_PER_MS);
      } else {
        // Reach ~63% of the remaining headroom over the band's expected
        // duration, with a floor so very fast machines still see motion.
        const tau = Math.max(700, state.expectedTotalMs * band.share);
        display += headroom * (1 - Math.exp(-dt / tau));
      }
    } else if (display < 99.4) {
      // Band ceiling saturated (a stalled phase, or fallback regressions
      // wedged the anchor in a band whose ceiling the display already
      // reached): glacial creep toward the global cap so the bar is never
      // frozen. Floored at 60 s so short expected loads do not race to 99.
      const creepTau = Math.max(60_000, state.expectedTotalMs * 3);
      display += (99.4 - display) * (1 - Math.exp(-dt / creepTau));
    }
  }

  display = Math.min(99.4, Math.max(display, state.display));
  return { ...state, anchor, display };
}

// ── Time line ──────────────────────────────────────────────────────────────

export interface EtaText {
  /** e.g. "about 20s left" or "32s elapsed" or null when too early to say. */
  text: string | null;
  /** True once the load has overrun the estimate (switches to elapsed). */
  overrun: boolean;
}

function formatElapsed(elapsedMs: number): string {
  const elapsedSec = Math.floor(elapsedMs / 1000);
  return elapsedSec < 60
    ? `${elapsedSec}s elapsed`
    : `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s elapsed`;
}

/**
 * Honest time line. Quiet for the first moments. With history backing, a
 * remaining estimate rounded to 5s so it never counts down digit by digit;
 * once the estimate is blown (or without history), plain elapsed time,
 * because predictability beats optimism.
 */
export function formatEta(
  elapsedMs: number,
  expectedTotalMs: number,
  fromHistory: boolean,
): EtaText {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 3_000) return { text: null, overrun: false };
  const remainingMs = expectedTotalMs - elapsedMs;
  if (!fromHistory || remainingMs <= 2_000) {
    return { text: formatElapsed(elapsedMs), overrun: remainingMs <= 2_000 };
  }
  const remainingSec = Math.max(5, Math.round(remainingMs / 5000) * 5);
  if (remainingSec >= 90) {
    return { text: `about ${Math.round(remainingSec / 60)} min left`, overrun: false };
  }
  return { text: `about ${remainingSec}s left`, overrun: false };
}
