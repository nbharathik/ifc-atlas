import type * as FRAGS from '@thatopen/fragments';
import type { ServerConvertCapabilities } from '../ifc/serverConvert';
import { buildFragmentCacheFingerprint } from './fragmentCacheFingerprint';
import { isRecoverableServerConvertFailure } from './loadStrategy';
import { FRAGMENT_LOAD_BASE_TIMEOUT_MS } from './loadTimeoutHelpers';
import type { ParseProfile } from './parseProfiles';

// Cache keys use a stable prefix so they can be invalidated by version bumps.
export const FRAGMENT_CACHE_PREFIX = '/__ifc_frag_cache__/';

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
  conversion: 'Finalizing fragment model',
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
  return `${FRAGMENT_CACHE_PREFIX}${profile}-${fingerprint}.frag`;
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
  try {
    const fragmentBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const loadPromise = fragmentsManager.core.load(fragmentBytes, { modelId });
    if (timeoutMs <= 0) return await loadPromise;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        clearFragmentThreadPlaceholder(fragmentsManager, modelId);
        reject(new Error(`Fragment load timed out after ${timeoutMs} ms`));
      }, timeoutMs);
    });
    return await Promise.race([loadPromise, timeoutPromise]);
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
