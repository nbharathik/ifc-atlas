/**
 * Frontend streaming geometry consumer.
 *
 * Reads the NDJSON response from `POST /api/ifc/geometry/stream` using
 * `fetch().body.getReader()` + a line accumulator, decodes each batch's
 * base64 mesh buffers into typed arrays, and hands them to a per-batch
 * callback so the viewer can build `THREE.BufferGeometry` instances and
 * push them into the scene as soon as they arrive.
 *
 * The pure helpers in this file have no DOM / THREE.js dependencies so
 * they can be unit-tested in the node vitest environment. The orchestrator
 * `consumeGeometryStream` accepts a pre-fetched `Response` (or a stand-in
 * `ReadableStream<Uint8Array>`) so its caller decides where the bytes
 * come from - production hits the FastAPI route; tests pipe a synthetic
 * stream.
 *
 * Architecture invariants honoured:
 *   - Invariant 1 (frontend owns rendering): meshes go straight into the
 *     scene; the backend never sends fully-built fragments.
 *   - Invariant 8 (frontend-first for new viewer work): no new backend
 *     endpoint - slice 1 already exposes it.
 */

import { apiUrl } from '../../lib/platform';

// ─────────────────────────────────────────────────────────────────────────────
// Types - mirror the sidecar event shapes verbatim
// ─────────────────────────────────────────────────────────────────────────────

export interface SerialisedMesh {
  expressId: number;
  ifcType: string;
  name: string | null;
  /** base64-encoded little-endian Float32Array bytes (XYZ positions). */
  positions: string;
  /** base64-encoded little-endian Uint32Array bytes (triangle indices). */
  indices: string;
  /** [minX, minY, minZ, maxX, maxY, maxZ] in world space. */
  bbox: number[];
}

export interface DecodedMesh {
  expressId: number;
  ifcType: string;
  name: string | null;
  positions: Float32Array;
  indices: Uint32Array;
  bbox: number[];
}

export type GeometryStreamEvent =
  | { type: 'start'; modelId: string; batchSize: number }
  | { type: 'batch'; batchIndex: number; meshes: SerialisedMesh[] }
  | {
      type: 'summary';
      modelId?: string;
      meshCount: number;
      attempted: number;
      skipped: number;
      batchCount: number;
      geoElapsedMs: number;
      totalElapsedMs: number;
    }
  | { type: 'error'; message: string };

// ─────────────────────────────────────────────────────────────────────────────
// NDJSON line accumulator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stateful line-buffer for NDJSON streamed over `getReader()`. Each chunk
 * may contain zero, partial, or many newline-delimited JSON objects, and a
 * record may straddle two chunks. Push raw `Uint8Array` chunks via `push`;
 * the accumulator emits whole lines (without their terminating `\n`) as
 * UTF-8 strings. `flush()` returns whatever remains in the buffer; callers
 * may parse it as the final line if the producer ended without a trailing
 * newline.
 */
export interface NdjsonAccumulator {
  push(chunk: Uint8Array): string[];
  flush(): string;
}

export function createNdjsonAccumulator(): NdjsonAccumulator {
  let buffer = '';
  const decoder = new TextDecoder('utf-8', { fatal: false });

  return {
    push(chunk: Uint8Array): string[] {
      // `stream: true` lets the decoder hold onto a partial multi-byte
      // codepoint that straddles a chunk boundary.
      buffer += decoder.decode(chunk, { stream: true });
      const out: string[] = [];
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.length > 0) out.push(line);
        nl = buffer.indexOf('\n');
      }
      return out;
    },
    flush(): string {
      // Drain any trailing decoder state (no-op for ASCII).
      buffer += decoder.decode();
      const trailing = buffer;
      buffer = '';
      return trailing;
    },
  };
}

/**
 * Parse a single NDJSON line into a typed event. Returns `null` if the
 * line is blank, malformed JSON, or has an unknown `type` - callers
 * should ignore those rather than abort the stream (the producer is
 * expected to emit a terminal `error` event for real failures).
 */
export function parseGeometryStreamLine(line: string): GeometryStreamEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const e = obj as { type?: unknown };
  switch (e.type) {
    case 'start':
    case 'batch':
    case 'summary':
    case 'error':
      return obj as GeometryStreamEvent;
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Mesh decode (pure - no THREE.js, fully unit-testable)
// ─────────────────────────────────────────────────────────────────────────────

function decodeBase64Bytes(b64: string): Uint8Array {
  // Browser + node both expose `atob`. The sidecar emits standard base64
  // (no urlsafe alphabet) so this is portable.
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function decodeMeshEntry(entry: SerialisedMesh): DecodedMesh {
  const posBytes = decodeBase64Bytes(entry.positions);
  const idxBytes = decodeBase64Bytes(entry.indices);
  // The sidecar serialises `Float32Array.buffer` and `Uint32Array.buffer`
  // directly - wrap, don't copy, to keep the hot path cheap. Slicing is
  // necessary only when the underlying ArrayBuffer's byteLength is not a
  // multiple of 4 (shouldn't happen, but guard anyway).
  const positions = posBytes.byteLength % 4 === 0
    ? new Float32Array(posBytes.buffer, posBytes.byteOffset, posBytes.byteLength / 4)
    : new Float32Array(0);
  const indices = idxBytes.byteLength % 4 === 0
    ? new Uint32Array(idxBytes.buffer, idxBytes.byteOffset, idxBytes.byteLength / 4)
    : new Uint32Array(0);
  return {
    expressId: entry.expressId,
    ifcType: entry.ifcType,
    name: entry.name,
    positions,
    indices,
    bbox: entry.bbox,
  };
}

export function decodeMeshBatch(meshes: SerialisedMesh[]): DecodedMesh[] {
  const out: DecodedMesh[] = [];
  for (const m of meshes) {
    const decoded = decodeMeshEntry(m);
    if (decoded.positions.length === 0 || decoded.indices.length === 0) continue;
    out.push(decoded);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience - drain a synthetic / canned stream
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Test-friendly: parse an array of pre-chunked byte buffers as if they
 * came off the wire. Returns the events in emit order. Used in unit tests
 * to assert chunk-boundary splitting + parse correctness without needing
 * a real `fetch`.
 */
export function parseChunkedStream(chunks: Uint8Array[]): GeometryStreamEvent[] {
  const acc = createNdjsonAccumulator();
  const events: GeometryStreamEvent[] = [];
  for (const chunk of chunks) {
    for (const line of acc.push(chunk)) {
      const ev = parseGeometryStreamLine(line);
      if (ev) events.push(ev);
    }
  }
  const trailing = acc.flush();
  if (trailing.length > 0) {
    const ev = parseGeometryStreamLine(trailing);
    if (ev) events.push(ev);
  }
  return events;
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator - consumes a Response.body stream end-to-end
// ─────────────────────────────────────────────────────────────────────────────

export interface StreamConsumerCallbacks {
  onStart?: (ev: Extract<GeometryStreamEvent, { type: 'start' }>) => void;
  /**
   * Called once per `batch` event, with the meshes pre-decoded. The
   * caller owns the decoded typed arrays and may either copy them into
   * THREE.BufferAttribute (preferred, since BufferAttribute may take
   * ownership) or pass them through directly.
   */
  onBatch?: (
    batchIndex: number,
    decoded: DecodedMesh[],
    raw: SerialisedMesh[],
  ) => void | Promise<void>;
  onSummary?: (ev: Extract<GeometryStreamEvent, { type: 'summary' }>) => void;
  onError?: (ev: Extract<GeometryStreamEvent, { type: 'error' }>) => void;
}

export interface StreamConsumerResult {
  startedAt: number;
  finishedAt: number;
  batchCount: number;
  meshCount: number;
  /** True iff a terminal `summary` event was observed. */
  completed: boolean;
  /** Set if a terminal `error` event was observed. */
  errorMessage: string | null;
}

/**
 * Drain a `ReadableStream<Uint8Array>` (typically `response.body`),
 * decode batches as they arrive, and invoke the supplied callbacks. The
 * returned promise resolves when the stream ends - either via a
 * `summary` event (success) or `error` event (terminal).
 *
 * The reader is released on every exit path. `signal.aborted` cancels
 * the stream cooperatively (the reader itself is also cancelled).
 */
export async function consumeGeometryStream(
  body: ReadableStream<Uint8Array>,
  callbacks: StreamConsumerCallbacks = {},
  signal?: AbortSignal,
): Promise<StreamConsumerResult> {
  const startedAt = Date.now();
  const reader = body.getReader();
  const acc = createNdjsonAccumulator();
  let batchCount = 0;
  let meshCount = 0;
  let completed = false;
  let errorMessage: string | null = null;

  const handleEvent = async (ev: GeometryStreamEvent): Promise<void> => {
    if (ev.type === 'start') {
      callbacks.onStart?.(ev);
      return;
    }
    if (ev.type === 'batch') {
      batchCount++;
      meshCount += ev.meshes.length;
      const decoded = decodeMeshBatch(ev.meshes);
      const cb = callbacks.onBatch;
      if (cb) {
        const r = cb(ev.batchIndex, decoded, ev.meshes);
        if (r && typeof (r as Promise<void>).then === 'function') await r;
      }
      return;
    }
    if (ev.type === 'summary') {
      completed = true;
      callbacks.onSummary?.(ev);
      return;
    }
    if (ev.type === 'error') {
      errorMessage = ev.message;
      callbacks.onError?.(ev);
    }
  };

  try {
    while (true) {
      if (signal?.aborted) {
        try { await reader.cancel('aborted'); } catch { /* noop */ }
        break;
      }
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      for (const line of acc.push(value)) {
        const ev = parseGeometryStreamLine(line);
        if (ev) await handleEvent(ev);
      }
    }
    const trailing = acc.flush();
    if (trailing.length > 0) {
      const ev = parseGeometryStreamLine(trailing);
      if (ev) await handleEvent(ev);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* noop */ }
  }

  return {
    startedAt,
    finishedAt: Date.now(),
    batchCount,
    meshCount,
    completed,
    errorMessage,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch wrapper - production entry point
// ─────────────────────────────────────────────────────────────────────────────

export interface StreamGeometryRequest {
  ifcBytes: Uint8Array;
  /** Filename surfaced to the FastAPI route (must end in `.ifc`). */
  filename?: string;
  /** Opaque caller tag mirrored back in stream events. */
  modelId?: string;
  /** Meshes per batch - clamped server-side to [1, 1000]. */
  batchSize?: number;
  signal?: AbortSignal;
}

/**
 * Fire `POST /api/ifc/geometry/stream` and consume the NDJSON response
 * via `consumeGeometryStream`. Returns `null` if the response is not
 * OK (callers fall back to the non-streaming path), or the stream
 * consumer's terminal stats on success.
 */
export async function streamNativeGeometry(
  req: StreamGeometryRequest,
  callbacks: StreamConsumerCallbacks = {},
): Promise<StreamConsumerResult | null> {
  const { ifcBytes, filename = 'model.ifc', modelId, batchSize, signal } = req;
  const params = new URLSearchParams();
  if (modelId) params.set('modelId', modelId);
  if (batchSize !== undefined) params.set('batchSize', String(batchSize));
  const qs = params.toString();
  const url = apiUrl(`/api/ifc/geometry/stream${qs ? `?${qs}` : ''}`);

  const formData = new FormData();
  const blob = new Blob([ifcBytes], { type: 'application/octet-stream' });
  formData.append('file', blob, filename);

  let resp: Response;
  try {
    resp = await fetch(url, { method: 'POST', body: formData, signal });
  } catch {
    return null;
  }
  if (!resp.ok || !resp.body) return null;
  return consumeGeometryStream(resp.body, callbacks, signal);
}
