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
