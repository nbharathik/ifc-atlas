/**
 * Client helper for the server-side fragment pre-conversion
 * endpoint. See `docs/architecture/AI_NATIVE_ENGINE.md`.
 *
 * Flow consumed by `ViewerPanel`:
 *
 *   const caps = await getServerCapabilities();
 *   if (caps.server_convert) {
 *     const frag = await convertIfcOnServer(file, profile);
 *     await fragmentsManager.core.load(frag.bytes, { modelId });
 *   } else {
 *     // existing live-parse path
 *   }
 *
 * Kept independent of React state so it can be called from outside the
 * viewer (prewarming, CLI tools, tests). When the caller provides
 * `onProgress`, the helper also polls `/api/ifc/convert/progress/{modelId}`
 * in parallel with the POST.
 */

import { apiUrl } from '../../lib/platform';
import type { components } from '../../generated/api-schema';

/** Exact binary runtime expected by the browser-side FragmentsManager. */
export const EXPECTED_FRAGMENTS_FORMAT_VERSION = '3.4.3';

export function assertCompatibleFragmentsFormatVersion(
  actual: string | null | undefined,
): string {
  const normalized = actual?.trim() ?? '';
  if (!normalized) {
    throw new Error(
      `Server fragment response has no format version; expected @thatopen/fragments ${EXPECTED_FRAGMENTS_FORMAT_VERSION}`,
    );
  }
  if (normalized !== EXPECTED_FRAGMENTS_FORMAT_VERSION) {
    throw new Error(
      `Incompatible server fragment format ${normalized}; viewer requires ${EXPECTED_FRAGMENTS_FORMAT_VERSION}`,
    );
  }
  return normalized;
}

export interface ServerConvertCapabilities {
  server_convert: boolean;
  available?: boolean;
  recoverable?: boolean;
  reason?: string;
  version?: string;
  wasmDir?: string;
  uptimeMs?: number;
}

export interface ServerConvertProbeOptions {
  /**
   * Bound this caller's wait without aborting the shared background probe.
   * The first viewer load can keep moving while the app-level probe still
   * finishes and warms the result for the next load.
   */
  timeoutMs?: number;
  /** Ignore any in-flight probe and start a fresh one. */
  force?: boolean;
}

export interface ConvertResult {
  bytes: Uint8Array;
  source: 'cache' | 'sidecar';
  profile: string;
  elapsedMs: number;
  sourceSha256: string;
  fragmentsFormatVersion: string;
}

export interface ConvertProgressSnapshot {
  model_id: string;
  in_flight: boolean;
  stage?: string;
  progress?: number;
  updated_at?: number;
}

export interface ConvertProgressPollOptions {
  onProgress?: (snapshot: ConvertProgressSnapshot) => void;
  pollIntervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ConvertIfcOnServerOptions {
  onProgress?: (snapshot: ConvertProgressSnapshot) => void;
  progressPollIntervalMs?: number;
  signal?: AbortSignal;
  /** When true, ask the backend to bypass its on-disk fragment cache:
   *  skip the cache-hit short-circuit, skip the inflight-prebuild wait,
   *  and skip writing the converted bytes back to disk. Forces a fresh
   *  sidecar conversion every call. */
  bypassCache?: boolean;
}

/**
 * Probe `GET /api/ifc/features` to see whether the Node sidecar is up
 * and ready to convert. Safe to call repeatedly; backend caches internally.
 * Never throws - network / backend errors return `{ server_convert: false }`.
 */
let cachedCapabilities: ServerConvertCapabilities | null = null;
let inFlightCapabilitiesProbe: Promise<ServerConvertCapabilities> | null = null;
const CAPABILITY_FETCH_TIMEOUT_MS = 20_000;
const VERBOSE_SERVER_CONVERT_LOGS =
  import.meta.env.DEV &&
  (() => {
    try { return window.localStorage.getItem('pref.verboseServerConvertLogs') === '1'; }
    catch { return false; }
  })();

function logServerConvertInfo(message: string, payload?: unknown): void {
  if (!VERBOSE_SERVER_CONVERT_LOGS) return;
  if (payload === undefined) console.info(message);
  else console.info(message, payload);
}

/** Delay before the single bounded probe retry (see probeServerCapabilities). */
const CAPABILITY_PROBE_RETRY_DELAY_MS = 1_200;

/**
 * One probe attempt, then on a TRANSPORT-LEVEL failure a single delayed
 * retry. Rationale: a dev-proxy hiccup or a just-restarted backend can answer
 * the first probe with an aborted fetch, a network error, or an HTML error
 * page - and the HTML case is classified hard-unrecoverable ("static host
 * without backend"), which silently demotes every load in the session to the
 * minutes-long in-browser parse. Confirm transport failures twice before
 * reporting them. An authoritative JSON envelope from the backend (even
 * `server_convert: false`) is trusted as-is and never retried.
 */
async function probeServerCapabilities(): Promise<ServerConvertCapabilities> {
  const first = await probeServerCapabilitiesOnce();
  if (first.caps.server_convert || first.authoritative) return first.caps;
  await new Promise((res) => globalThis.setTimeout(res, CAPABILITY_PROBE_RETRY_DELAY_MS));
  return (await probeServerCapabilitiesOnce()).caps;
}

interface CapabilityProbeAttempt {
  caps: ServerConvertCapabilities;
  /** True when the backend answered with a parsed JSON envelope; false for
   *  transport-level failures (HTTP error status, non-JSON body, abort,
   *  network error) that a retry may resolve. */
  authoritative: boolean;
}

async function probeServerCapabilitiesOnce(): Promise<CapabilityProbeAttempt> {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => {
    controller.abort();
  }, CAPABILITY_FETCH_TIMEOUT_MS);
  const started = performance.now();
  logServerConvertInfo('[serverConvert] probing /api/ifc/features');
  try {
    const resp = await fetch(apiUrl('/api/ifc/features'), {
      method: 'GET',
      signal: controller.signal,
    });
    if (!resp.ok) {
      return {
        authoritative: false,
        caps: {
          server_convert: false,
          available: false,
          recoverable: resp.status >= 500,
          reason: `HTTP ${resp.status}`,
        },
      };
    }
    // Static hosts with SPA rewrites answer /api/* with 200 + index.html.
    // Treating that as a recoverable error would send the full IFC body to a
    // /api/ifc/convert that doesn't exist - an HTML answer means there is no
    // backend at this origin, so mark it hard-unrecoverable. (A dev-proxy
    // error page looks the same, which is why the caller re-probes once
    // before trusting this.)
    const contentType = resp.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('application/json')) {
      return {
        authoritative: false,
        caps: {
          server_convert: false,
          available: false,
          recoverable: false,
          reason: `non-JSON response (${contentType || 'no content-type'}) - static host without backend?`,
        },
      };
    }
    const caps = (await resp.json()) as ServerConvertCapabilities;
    if (caps.server_convert) cachedCapabilities = caps;
    logServerConvertInfo('[serverConvert] /api/ifc/features result', {
      ...caps,
      elapsedMs: Math.round(performance.now() - started),
    });
    return { authoritative: true, caps };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      console.warn('[serverConvert] /api/ifc/features aborted', {
        elapsedMs: Math.round(performance.now() - started),
      });
      return {
        authoritative: false,
        caps: {
          server_convert: false,
          available: false,
          recoverable: true,
          reason: `capability probe aborted after ${CAPABILITY_FETCH_TIMEOUT_MS} ms`,
        },
      };
    }
    const reason = err instanceof Error ? err.message : String(err);
    console.warn('[serverConvert] /api/ifc/features failed', {
      reason,
      elapsedMs: Math.round(performance.now() - started),
    });
    return {
      authoritative: false,
      caps: {
        server_convert: false,
        available: false,
        recoverable: true,
        reason,
      },
    };
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

export async function getServerCapabilities(
  options: ServerConvertProbeOptions = {},
): Promise<ServerConvertCapabilities> {
  if (!options.force && cachedCapabilities) {
    return cachedCapabilities;
  }

  if (options.force || !inFlightCapabilitiesProbe) {
    inFlightCapabilitiesProbe = probeServerCapabilities().finally(() => {
      inFlightCapabilitiesProbe = null;
    });
  }

  const probe = inFlightCapabilitiesProbe;
  if (!probe) {
    return {
      server_convert: false,
      available: false,
      recoverable: true,
      reason: 'capability probe unavailable',
    };
  }
  if (!options.timeoutMs || options.timeoutMs <= 0) {
    return probe;
  }

  return Promise.race([
    probe,
    new Promise<ServerConvertCapabilities>((resolve) => {
      globalThis.setTimeout(() => {
        resolve({
          server_convert: false,
          available: false,
          recoverable: true,
          reason: `capability probe timed out after ${options.timeoutMs} ms`,
        });
      }, options.timeoutMs);
    }),
  ]);
}

// Fragment manifest helpers - skip 50 MB IFC re-upload on remount when the
// server already has cached fragments for the fingerprint.

export interface FragmentManifest {
  cached: boolean;
  fingerprint: string;
  profile: string;
  size_bytes: number | null;
  serve_url: string | null;
  fragments_format_version?: string;
  /** Versioned engine-neutral contract; compatibility fields above are
   * retained while callers migrate. */
  artifact_manifest: components['schemas']['ArtifactManifestV1'] | null;
}

type ArtifactManifestLookup =
  components['schemas']['ArtifactManifestLookupV1'];

const EMPTY_FRAGMENT_MANIFEST = (
  fingerprint: string,
  profile: string,
): FragmentManifest => ({
  cached: false,
  fingerprint,
  profile,
  size_bytes: null,
  serve_url: null,
  artifact_manifest: null,
});

/**
 * Ask the server whether it has cached fragments for the given SHA-256
 * fingerprint. Returns quickly - no IFC bytes are sent.
 * Never throws; on network error returns `{ cached: false, … }`.
 */
export async function checkFragmentManifest(
  fingerprint: string,
  profile: string,
): Promise<FragmentManifest> {
  try {
    const resp = await fetch(
      apiUrl(`/api/ifc/artifact-manifest?fingerprint=${encodeURIComponent(fingerprint)}&profile=${encodeURIComponent(profile)}`),
      { method: 'GET' },
    );
    if (!resp.ok) return EMPTY_FRAGMENT_MANIFEST(fingerprint, profile);
    const lookup = (await resp.json()) as ArtifactManifestLookup;
    const manifest = lookup.manifest ?? null;
    return {
      cached: lookup.cached && manifest !== null,
      fingerprint: lookup.fingerprint,
      profile: lookup.profile,
      size_bytes: manifest?.artifact.byte_length ?? null,
      serve_url: manifest?.artifact.serve_url ?? null,
      fragments_format_version: manifest?.fragments_format_version,
      artifact_manifest: manifest,
    };
  } catch {
    return EMPTY_FRAGMENT_MANIFEST(fingerprint, profile);
  }
}

/**
 * Download pre-cached fragment bytes by fingerprint - no IFC upload needed.
 * Only call after `checkFragmentManifest` confirms `cached: true`.
 * Throws if the server returns non-200 (caller should fall back to normal convert path).
 */
export async function fetchFragmentByFingerprint(
  fingerprint: string,
  profile: string,
): Promise<ConvertResult> {
  const resp = await fetch(
    apiUrl(`/api/ifc/fragments/serve?fingerprint=${encodeURIComponent(fingerprint)}&profile=${encodeURIComponent(profile)}`),
  );
  if (!resp.ok) throw new Error(`fragment serve failed: HTTP ${resp.status}`);
  const fragmentsFormatVersion = assertCompatibleFragmentsFormatVersion(
    resp.headers.get('X-Fragments-Format-Version'),
  );
  const buf = await resp.arrayBuffer();
  return {
    bytes: new Uint8Array(buf),
    source: 'cache',
    profile: resp.headers.get('X-Fragment-Profile') ?? profile,
    elapsedMs: 0,
    sourceSha256: fingerprint,
    fragmentsFormatVersion,
  };
}

// Pre-build status.
// The upload route fires a background pre-conversion. Before re-uploading a
// 50 MB IFC to `/convert`, the viewer probes / awaits this status - if the
// pre-build is in flight, we wait for it instead of doubling the work.

export type FragmentPrebuildState = 'idle' | 'inflight' | 'complete' | 'failed';

export interface FragmentPrebuildStatus {
  status: FragmentPrebuildState;
  fingerprint: string;
  profile: string;
  started_at: number | null;
  elapsed_ms: number | null;
  size_bytes: number | null;
  error: string | null;
  serve_url: string | null;
}

const PREBUILD_IDLE = (
  fingerprint: string,
  profile: string,
  reason?: string,
): FragmentPrebuildStatus => ({
  status: 'idle',
  fingerprint,
  profile,
  started_at: null,
  elapsed_ms: null,
  size_bytes: null,
  error: reason ?? null,
  serve_url: null,
});

/**
 * One-shot status probe. Never throws - network / backend errors collapse to
 * `{ status: 'idle', error: <reason> }` so the caller's fall-back path is
 * trivially the same as for a server that simply has no record of this
 * fingerprint.
 */
export async function getFragmentPrebuildStatus(
  fingerprint: string,
  profile: string,
  opts?: { waitMs?: number },
): Promise<FragmentPrebuildStatus> {
  const waitMs = opts?.waitMs ?? 0;
  const qs = new URLSearchParams({
    fingerprint,
    profile,
    wait_ms: String(waitMs),
  });
  try {
    const resp = await fetch(apiUrl(`/api/ifc/convert-status?${qs.toString()}`), {
      method: 'GET',
    });
    if (!resp.ok) {
      return PREBUILD_IDLE(fingerprint, profile, `HTTP ${resp.status}`);
    }
    const body = (await resp.json()) as Partial<FragmentPrebuildStatus> & {
      status: FragmentPrebuildState;
    };
    return {
      status: body.status ?? 'idle',
      fingerprint: body.fingerprint ?? fingerprint,
      profile: body.profile ?? profile,
      started_at: body.started_at ?? null,
      elapsed_ms: body.elapsed_ms ?? null,
      size_bytes: body.size_bytes ?? null,
      error: body.error ?? null,
      serve_url: body.serve_url ?? null,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return PREBUILD_IDLE(fingerprint, profile, reason);
  }
}

export interface WaitForFragmentReadyOptions {
  /** Hard wall-clock limit across all polls combined. Default 8 000 ms. */
  timeoutMs?: number;
  /** Per-request wait_ms passed to the backend; smaller values let the caller
   *  cancel sooner. Default 1 000 ms. */
  pollIntervalMs?: number;
  /** Aborts the wait early - e.g. when the React component unmounts. */
  signal?: AbortSignal;
}

/**
 * Poll `convert-status` until the pre-build resolves or the timeout fires.
 *
 * Each poll uses the long-poll `wait_ms` query so a fast-completing task
 * resolves on the very first response without an extra round-trip. The total
 * wall-clock budget across all polls is `timeoutMs`; if exceeded, the function
 * resolves with whatever the most recent status was (typically still
 * `inflight`) so the caller can decide whether to fall back to `/convert`.
 *
 * Aborts cleanly: an aborted signal makes the function resolve immediately
 * with the last known status. The function never throws.
 */
export async function waitForFragmentReady(
  fingerprint: string,
  profile: string,
  options: WaitForFragmentReadyOptions = {},
): Promise<FragmentPrebuildStatus> {
  const timeoutMs = Math.max(0, options.timeoutMs ?? 8_000);
  const pollIntervalMs = Math.max(100, options.pollIntervalMs ?? 1_000);
  const signal = options.signal;
  const deadline = performance.now() + timeoutMs;

  let last = await getFragmentPrebuildStatus(fingerprint, profile, {
    waitMs: Math.min(pollIntervalMs, timeoutMs),
  });
  if (last.status === 'complete' || last.status === 'failed' || last.status === 'idle') {
    return last;
  }
  if (signal?.aborted) return last;

  while (performance.now() < deadline) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    const waitMs = Math.min(pollIntervalMs, Math.max(0, Math.floor(remaining)));
    last = await getFragmentPrebuildStatus(fingerprint, profile, { waitMs });
    if (last.status === 'complete' || last.status === 'failed') return last;
    if (signal?.aborted) return last;
    // ``idle`` mid-poll means the registry forgot about the task - no point
    // hammering the endpoint, bail out and let the caller upload.
    if (last.status === 'idle') return last;
  }
  return last;
}

export async function getConvertProgress(
  modelId: string,
  signal?: AbortSignal,
): Promise<ConvertProgressSnapshot> {
  try {
    const resp = await fetch(apiUrl(`/api/ifc/convert/progress/${encodeURIComponent(modelId)}`), {
      method: 'GET',
      signal,
    });
    if (!resp.ok) {
      return { model_id: modelId, in_flight: false };
    }
    const body = (await resp.json()) as Partial<ConvertProgressSnapshot>;
    return {
      model_id: typeof body.model_id === 'string' ? body.model_id : modelId,
      in_flight: body.in_flight === true,
      stage: typeof body.stage === 'string' ? body.stage : undefined,
      progress: typeof body.progress === 'number' ? body.progress : undefined,
      updated_at: typeof body.updated_at === 'number' ? body.updated_at : undefined,
    };
  } catch {
    return { model_id: modelId, in_flight: false };
  }
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) {
      resolve();
      return;
    }
    const timer = globalThis.setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        globalThis.clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

// 500 ms keeps the loader bar visibly alive through multi-second sidecar
// conversions; the backend snapshot updates far more often than this, and
// the request is a tiny in-memory JSON read.
const DEFAULT_CONVERT_PROGRESS_POLL_MS = 500;

export async function pollConvertProgress(
  modelId: string,
  options: ConvertProgressPollOptions = {},
): Promise<ConvertProgressSnapshot> {
  // Keep the loader progress live without turning long conversions into a
  // steady stream of tiny HTTP requests.
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_CONVERT_PROGRESS_POLL_MS);
  const timeoutMs = Math.max(0, options.timeoutMs ?? 120_000);
  const deadline = timeoutMs > 0 ? performance.now() + timeoutMs : Number.POSITIVE_INFINITY;
  let last: ConvertProgressSnapshot = { model_id: modelId, in_flight: false };
  let sawInFlight = false;
  let lastEmittedKey = '';

  while (!options.signal?.aborted && performance.now() <= deadline) {
    last = await getConvertProgress(modelId, options.signal);
    if (last.in_flight) {
      sawInFlight = true;
      const emittedKey = `${last.stage ?? ''}:${last.progress ?? ''}:${last.updated_at ?? ''}`;
      if (emittedKey !== lastEmittedKey) {
        lastEmittedKey = emittedKey;
        options.onProgress?.(last);
      }
    } else if (sawInFlight) {
      return last;
    }
    await sleep(pollIntervalMs, options.signal);
  }

  return last;
}

/**
 * Upload IFC bytes to the backend convert endpoint; receive a
 * pre-built fragment binary. The binary is ready to hand straight to
 * `fragmentsManager.core.load(bytes, { modelId })`.
 */
export async function convertIfcOnServer(
  bytes: Uint8Array,
  profile: 'quality' | 'balanced' | 'performance' | 'ultra_fast',
  modelId: string,
  options: ConvertIfcOnServerOptions = {},
): Promise<ConvertResult> {
  const started = performance.now();
  const progressController = new AbortController();
  const progressSignal = progressController.signal;
  const progressTask = options.onProgress
    ? pollConvertProgress(modelId, {
      onProgress: options.onProgress,
      pollIntervalMs: options.progressPollIntervalMs,
      signal: progressSignal,
    })
    : null;

  try {
    logServerConvertInfo('[serverConvert] POST /api/ifc/convert start', {
      profile,
      modelId,
      bytes: bytes.byteLength,
      bypassCache: options.bypassCache === true,
    });
    const params = new URLSearchParams({ profile, modelId });
    if (options.bypassCache) params.set('no_cache', '1');
    const resp = await fetch(
      apiUrl(`/api/ifc/convert?${params.toString()}`),
      {
        method: 'POST',
        body: bytes,
        headers: { 'Content-Type': 'application/octet-stream' },
        signal: options.signal,
      },
    );
    if (!resp.ok) {
      let errorText: string;
      try {
        const data = (await resp.json()) as { error?: string };
        errorText = data.error ?? `HTTP ${resp.status}`;
      } catch {
        errorText = `HTTP ${resp.status}`;
      }
      console.warn('[serverConvert] POST /api/ifc/convert failed', {
        status: resp.status,
        errorText,
        elapsedMs: Math.round(performance.now() - started),
      });
      throw new Error(`Server convert failed: ${errorText}`);
    }
    const fragmentsFormatVersion = assertCompatibleFragmentsFormatVersion(
      resp.headers.get('X-Fragments-Format-Version'),
    );
    const buf = await resp.arrayBuffer();
    logServerConvertInfo('[serverConvert] POST /api/ifc/convert done', {
      status: resp.status,
      source: resp.headers.get('X-Fragment-Source'),
      profile: resp.headers.get('X-Fragment-Profile') ?? profile,
      outputBytes: buf.byteLength,
      elapsedMs: Math.round(performance.now() - started),
      sidecarMs: resp.headers.get('X-Fragment-Elapsed-Ms') ?? '0',
    });
    return {
      bytes: new Uint8Array(buf),
      source: (resp.headers.get('X-Fragment-Source') as 'cache' | 'sidecar') ?? 'sidecar',
      profile: resp.headers.get('X-Fragment-Profile') ?? profile,
      elapsedMs: Number(resp.headers.get('X-Fragment-Elapsed-Ms') ?? '0'),
      sourceSha256: resp.headers.get('X-Fragment-Source-Sha256') ?? '',
      fragmentsFormatVersion,
    };
  } finally {
    progressController.abort();
    await progressTask?.catch(() => undefined);
  }
}
