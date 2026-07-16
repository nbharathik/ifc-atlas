/**
 * IFC Atlas Native Engine: fragment-conversion sidecar HTTP server.
 *
 * - Listens on localhost:$SIDECAR_PORT (default 9100).
 * - GET  /health               → { ok, wasmDir, uptime, version }
 * - POST /convert              → accepts raw IFC bytes (application/octet-stream),
 *                                 query params: profile, modelId.
 *                                 Returns the fragment binary in one response
 *                                 with progress + timing in headers.
 * - POST /decimate             → accepts raw `.frag` bytes (application/octet-stream),
 *                                 query params: ratio, error, modelId.
 *                                 Returns a smaller LOD `.frag` (fewer triangles,
 *                                 same element identity) for the navigation proxy.
 *
 * Part of the IFC Atlas native engine. Python spawns this process via
 * `backend/app/services/sidecar_manager.py` and proxies convert requests
 * through `POST /api/ifc/convert` with SSE progress.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';

import { convert, ConversionCancelledError, getWasmDir } from './converter.js';
import { decimateFragments, type DecimateStats } from './decimate.js';
import { parseIfc, parseIfcStatsOnly, scanSections } from './parser/index.js';
import { decodeSubsetEnvelope, subsetFragments, type SubsetRequestEnvelope } from './subset.js';
import {
  extractGeometry,
  extractGeometryStreaming,
  buildProductMaps,
  type ElementMesh,
} from './parser/geometry.js';
import type { ParseProfile } from './profiles.js';

const PORT = Number(process.env.SIDECAR_PORT ?? 9100);
const HOST = process.env.SIDECAR_HOST ?? '127.0.0.1';
const VERSION = '1.0.0';
const STARTED_AT = Date.now();

const VALID_PROFILES = new Set<ParseProfile>(['quality', 'balanced', 'performance', 'ultra_fast']);

function jsonResponse(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

// ─────────────────────────────────────────────────────────────────────────────
// Geometry-extraction helpers shared by `/geometry` and `/geometry/stream`
// ─────────────────────────────────────────────────────────────────────────────

/** Product-element filter applied to the raw V1 entity table. */
const ELEMENT_FILTER = {
  skipPrefixes: ['IFCREL', 'IFCPROPERTY', 'IFCQUANTITY', 'IFCPHYSICAL', 'IFCELEMENTQUANTITY'] as const,
  skipSuffixes: ['TYPE', 'STYLE', 'PROPERTIES', 'PORT'] as const,
  spatialTypes: new Set(['IFCPROJECT','IFCSITE','IFCBUILDING','IFCBUILDINGSTOREY','IFCSPACE']),
  skipExplicit: new Set(['IFCOPENINGELEMENT','IFCOPENINGSTANDARDCASE','IFCVIRTUALELEMENT','IFCANNOTATION','IFCGRID']),
} as const;

/**
 * Collect express ids of "product" elements (anything that could have a
 * geometric representation) from the raw entity table. Mirrors the filter
 * used in the V1 metadata index so the two paths see the same set.
 */
function collectProductElementIds(
  entities: Map<number, import('./parser/types.js').EntityRecord>,
): number[] {
  const out: number[] = [];
  for (const [id, entity] of entities) {
    const t = entity.type;
    if (ELEMENT_FILTER.spatialTypes.has(t) || ELEMENT_FILTER.skipExplicit.has(t)) continue;
    if (ELEMENT_FILTER.skipPrefixes.some((p) => t.startsWith(p))) continue;
    if (ELEMENT_FILTER.skipSuffixes.some((s) => t.endsWith(s))) continue;
    out.push(id);
  }
  return out;
}

/** Base64-encode an ElementMesh's typed-array buffers for JSON transport. */
function serialiseMesh(m: import('./parser/geometry.js').ElementMesh): {
  expressId: number;
  ifcType: string;
  name: string | null;
  positions: string;
  indices: string;
  bbox: number[];
} {
  return {
    expressId: m.expressId,
    ifcType: m.ifcType,
    name: m.name,
    positions: Buffer.from(m.positions.buffer).toString('base64'),
    indices: Buffer.from(m.indices.buffer).toString('base64'),
    bbox: Array.from(m.bbox),
  };
}

async function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let received = 0;
  return new Promise((resolve, reject) => {
    req.on('data', (chunk: Buffer) => {
      received += chunk.byteLength;
      if (received > maxBytes) {
        reject(new Error(`request body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

const MAX_IFC_BYTES = 1024 * 1024 * 1024; // 1 GB upper bound

/**
 * Abort when the client disconnects before the response finished. Queued heavy
 * jobs check the signal at the head of the FIFO so a disconnected client's
 * job is skipped instead of occupying the importer.
 *
 * An aborting client (undici/fetch, httpx) half-closes with FIN; Node keeps a
 * half-closed connection alive while a response is pending, so `res` emits
 * 'close' only after the response is written. The socket's 'end' event is the
 * early disconnect signal; 'close' still covers hard resets.
 */
function watchClientDisconnect(req: IncomingMessage, res: ServerResponse): AbortSignal {
  const cancel = new AbortController();
  const socket = req.socket;
  const onDisconnect = () => {
    if (!res.writableFinished) cancel.abort();
  };
  socket.once('end', onDisconnect);
  res.on('close', () => {
    // Keep-alive sockets outlive the response; drop the listener so serving
    // many requests over one connection does not accumulate handlers.
    socket.removeListener('end', onDisconnect);
    onDisconnect();
  });
  return cancel.signal;
}

async function handleConvert(req: IncomingMessage, res: ServerResponse, parsedUrl: URL) {
  const profileParam = (parsedUrl.searchParams.get('profile') ?? 'balanced') as ParseProfile;
  const modelId = parsedUrl.searchParams.get('modelId') ?? 'sidecar-model';
  if (!VALID_PROFILES.has(profileParam)) {
    jsonResponse(res, 400, { error: `invalid profile '${profileParam}'` });
    return;
  }

  let bytes: Uint8Array;
  try {
    bytes = await readRequestBody(req, MAX_IFC_BYTES);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'body read failed';
    jsonResponse(res, 413, { error: message });
    return;
  }

  if (bytes.byteLength === 0) {
    jsonResponse(res, 400, { error: 'empty body' });
    return;
  }

  // The HTTP path is one-shot: Python forwards the whole IFC, waits for
  // the whole .frag. Progress is emitted to stderr so the manager can
  // forward it as SSE to the frontend.
  const clientGone = watchClientDisconnect(req, res);
  const stageLog: string[] = [];
  const onProgress = (stage: string, progress: number) => {
    // Structured line; Python parses by prefix.
    const line = `SIDECAR_PROGRESS ${JSON.stringify({ stage, progress, modelId })}`;
    process.stderr.write(line + '\n');
    stageLog.push(`${stage}:${Math.round(progress)}`);
  };

  try {
    const result = await convert(bytes, {
      profile: profileParam,
      onProgress,
      signal: clientGone,
    });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Sidecar-Profile', result.effectiveProfile);
    res.setHeader('X-Sidecar-Elapsed-Ms', String(result.elapsedMs));
    res.setHeader('X-Sidecar-Input-Bytes', String(bytes.byteLength));
    res.setHeader('X-Sidecar-Output-Bytes', String(result.bytes.byteLength));
    // Respond with the binary fragment.
    res.end(Buffer.from(result.bytes));
    process.stderr.write(
      `SIDECAR_DONE ${JSON.stringify({
        modelId,
        profile: result.effectiveProfile,
        elapsedMs: result.elapsedMs,
        inputBytes: bytes.byteLength,
        outputBytes: result.bytes.byteLength,
      })}\n`,
    );
  } catch (err) {
    if (err instanceof ConversionCancelledError) {
      // Client is gone; there is nobody to answer.
      process.stderr.write(`SIDECAR_CANCELLED ${JSON.stringify({ modelId, endpoint: 'convert' })}\n`);
      return;
    }
    const message = err instanceof Error ? err.message : 'conversion failed';
    process.stderr.write(`SIDECAR_ERROR ${JSON.stringify({ modelId, message })}\n`);
    jsonResponse(res, 500, { error: message, stageLog });
  }
}

/**
 * LOD decimation: accept an already-converted `.frag`, return a smaller one.
 *
 * Body: raw `.frag` bytes (application/octet-stream).
 * Query params:
 *   ?ratio=…    target fraction of each shell's original triangle count (0-1).
 *   ?error=…    relative error ceiling for the sloppy simplifier.
 *   ?modelId=…  opaque caller tag, mirrored in stderr telemetry.
 *
 * Response: binary LOD `.frag` bytes, with sizes + triangle counts in headers.
 * Errors (empty body / non-shell-only model / internal failure) return a JSON
 * error so the Python caller can degrade to serving the full model.
 */
async function handleDecimate(req: IncomingMessage, res: ServerResponse, parsedUrl: URL) {
  const modelId = parsedUrl.searchParams.get('modelId') ?? 'lod-model';
  const ratioRaw = parsedUrl.searchParams.get('ratio');
  const errorRaw = parsedUrl.searchParams.get('error');
  const ratio = ratioRaw !== null ? Number.parseFloat(ratioRaw) : undefined;
  const error = errorRaw !== null ? Number.parseFloat(errorRaw) : undefined;

  let bytes: Uint8Array;
  try {
    bytes = await readRequestBody(req, MAX_IFC_BYTES);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'body read failed';
    jsonResponse(res, 413, { error: message });
    return;
  }
  if (bytes.byteLength === 0) {
    jsonResponse(res, 400, { error: 'empty body' });
    return;
  }

  const onProgress = (stage: string, progress: number) => {
    process.stderr.write(
      `SIDECAR_PROGRESS ${JSON.stringify({ stage, progress, modelId })}\n`,
    );
  };

  try {
    let stats: DecimateStats | undefined;
    const out = await decimateFragments(bytes, {
      ratio,
      error,
      onProgress,
      onStats: (s) => {
        stats = s;
      },
    });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Sidecar-Input-Bytes', String(bytes.byteLength));
    res.setHeader('X-Sidecar-Output-Bytes', String(out.byteLength));
    if (stats) {
      res.setHeader('X-Sidecar-Tris-Before', String(stats.trisBefore));
      res.setHeader('X-Sidecar-Tris-After', String(stats.trisAfter));
      res.setHeader('X-Sidecar-Shells-Decimated', String(stats.decimated));
      res.setHeader('X-Sidecar-Elapsed-Ms', String(stats.elapsedMs));
      res.setHeader('X-Sidecar-Lod-Target-Ratio', String(stats.targetRatio));
      res.setHeader('X-Sidecar-Lod-Target-Error', String(stats.targetError));
      res.setHeader('X-Sidecar-Lod-Max-Error', String(stats.achievedMaxError));
      res.setHeader(
        'X-Sidecar-Lod-Mean-Error',
        String(stats.achievedWeightedMeanError),
      );
      res.setHeader('X-Sidecar-Identity-Count', String(stats.identityCount));
      res.setHeader('X-Sidecar-Identity-Sha256', stats.identitySha256);
      res.setHeader('X-Sidecar-Identity-Verified', String(stats.identityVerified));
    }
    res.end(Buffer.from(out));
    process.stderr.write(
      `SIDECAR_DECIMATE_DONE ${JSON.stringify({
        modelId,
        inputBytes: bytes.byteLength,
        outputBytes: out.byteLength,
        trisBefore: stats?.trisBefore ?? 0,
        trisAfter: stats?.trisAfter ?? 0,
        decimated: stats?.decimated ?? 0,
        achievedMaxError: stats?.achievedMaxError ?? 0,
        identityCount: stats?.identityCount ?? 0,
        identitySha256: stats?.identitySha256 ?? null,
        identityVerified: stats?.identityVerified ?? false,
        elapsedMs: stats?.elapsedMs ?? 0,
      })}\n`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'decimation failed';
    process.stderr.write(`SIDECAR_DECIMATE_ERROR ${JSON.stringify({ modelId, message })}\n`);
    jsonResponse(res, 500, { error: message });
  }
}

/**
 * Create a standalone spatial/storey fragment subset from a cached full model.
 * The length-prefixed identity table avoids URL/header limits for large tiles.
 */
async function handleSubset(req: IncomingMessage, res: ServerResponse, parsedUrl: URL) {
  const modelId = parsedUrl.searchParams.get('modelId') ?? 'subset-model';
  let envelopeBytes: Uint8Array;
  try {
    envelopeBytes = await readRequestBody(req, MAX_IFC_BYTES);
  } catch (err) {
    jsonResponse(res, 413, {
      error: err instanceof Error ? err.message : 'body read failed',
    });
    return;
  }
  if (envelopeBytes.byteLength === 0) {
    jsonResponse(res, 400, { error: 'empty body' });
    return;
  }

  // Envelope decoding failures (bad magic, truncation, unsupported schema,
  // invalid items) are malformed client requests → 400, matching /convert
  // and /decimate; only authoring failures below are sidecar faults (500).
  let envelope: SubsetRequestEnvelope;
  try {
    envelope = decodeSubsetEnvelope(envelopeBytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid subset envelope';
    jsonResponse(res, 400, { error: message });
    return;
  }

  const clientGone = watchClientDisconnect(req, res);
  try {
    const result = await subsetFragments(envelope.fragmentBytes, envelope.items, clientGone);
    const { stats } = result;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Sidecar-Input-Bytes', String(stats.inputBytes));
    res.setHeader('X-Sidecar-Output-Bytes', String(stats.outputBytes));
    res.setHeader('X-Sidecar-Subset-Requested', String(stats.requestedCount));
    res.setHeader('X-Sidecar-Subset-Resolved', String(stats.resolvedCount));
    res.setHeader('X-Sidecar-Subset-Guid-Remaps', String(stats.guidRemapCount));
    res.setHeader('X-Sidecar-Identity-Count', String(stats.identityCount));
    res.setHeader('X-Sidecar-Identity-Sha256', stats.identitySha256);
    res.setHeader('X-Sidecar-Identity-Verified', String(stats.identityVerified));
    res.setHeader('X-Sidecar-Content-Sha256', stats.contentSha256);
    res.setHeader('X-Sidecar-Content-Verified', String(stats.contentVerified));
    res.setHeader('X-Sidecar-Elapsed-Ms', String(stats.elapsedMs));
    res.end(Buffer.from(result.bytes));
    process.stderr.write(
      `SIDECAR_SUBSET_DONE ${JSON.stringify({ modelId, ...stats })}\n`,
    );
  } catch (err) {
    if (err instanceof ConversionCancelledError) {
      process.stderr.write(`SIDECAR_CANCELLED ${JSON.stringify({ modelId, endpoint: 'subset' })}\n`);
      return;
    }
    const message = err instanceof Error ? err.message : 'subset authoring failed';
    process.stderr.write(`SIDECAR_SUBSET_ERROR ${JSON.stringify({ modelId, message })}\n`);
    jsonResponse(res, 500, { error: message });
  }
}

/**
 * Extract mesh geometry for elements with IfcExtrudedAreaSolid.
 *
 * Returns a JSON object whose `meshes` array contains one entry per
 * element with successfully extracted geometry:
 *
 *   { expressId, ifcType, name,
 *     positions: "<base64 Float32Array>",
 *     indices:   "<base64 Uint32Array>",
 *     bbox:      [minX,minY,minZ,maxX,maxY,maxZ] }
 *
 * The frontend decodes the base64 blobs back to typed arrays, builds
 * THREE.BufferGeometry from them, and renders preview meshes before the
 * full @thatopen/fragments model is ready, eliminating the "9-minute
 * blank screen" for the common architectural element types.
 *
 * Query params:
 *   ?modelId=…   opaque caller tag for telemetry
 */
async function handleGeometry(req: IncomingMessage, res: ServerResponse, parsedUrl: URL) {
  const modelId = parsedUrl.searchParams.get('modelId') ?? 'geo-model';
  let bytes: Uint8Array;
  try {
    bytes = await readRequestBody(req, MAX_IFC_BYTES);
  } catch (err) {
    jsonResponse(res, 413, { error: err instanceof Error ? err.message : 'body read failed' });
    return;
  }
  if (bytes.byteLength === 0) {
    jsonResponse(res, 400, { error: 'empty body' });
    return;
  }

  const wallStart = Date.now();
  try {
    // Step 1: run the V1 lexer once to build the raw entity table.
    // We use scanSections directly (not parseIfc) so we only pay the lex
    // cost once and avoid building the full MetadataIndex which isn't needed
    // for geometry extraction.
    const rawEntities = new Map<number, import('./parser/types.js').EntityRecord>();
    scanSections(bytes, {
      onEntity: (e) => rawEntities.set(e.expressId, e),
      onHeaderRaw: () => {},
    });

    // Step 2: collect product elements (anything with potential geometry).
    const elementIds = collectProductElementIds(rawEntities);

    // Step 3: build product maps (placement IDs + representation IDs).
    const { placementIds, repIds, elementTypes, elementNames } = buildProductMaps(
      rawEntities, elementIds,
    );

    // Step 4: extract geometry.
    const geoResult = extractGeometry(
      rawEntities, elementIds, elementTypes, elementNames, placementIds, repIds,
    );

    // Step 5: serialise. Encode Float32Array + Uint32Array as base64 strings
    // so they survive JSON serialisation without precision loss.
    const serialised = geoResult.meshes.map(serialiseMesh);

    const elapsedMs = Date.now() - wallStart;
    const body = JSON.stringify({
      meshCount: serialised.length,
      attempted: geoResult.attempted,
      skipped: geoResult.skipped,
      geoElapsedMs: geoResult.elapsedMs,
      totalElapsedMs: elapsedMs,
      meshes: serialised,
    });

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Sidecar-Elapsed-Ms', String(elapsedMs));
    res.setHeader('X-Sidecar-Mesh-Count', String(serialised.length));
    res.setHeader('X-Sidecar-Attempted', String(geoResult.attempted));
    res.setHeader('X-Sidecar-Skipped', String(geoResult.skipped));
    res.end(body);

    process.stderr.write(
      `SIDECAR_GEO_DONE ${JSON.stringify({
        modelId, meshCount: serialised.length, attempted: geoResult.attempted,
        skipped: geoResult.skipped, elapsedMs,
      })}\n`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'geometry extraction failed';
    process.stderr.write(`SIDECAR_GEO_ERROR ${JSON.stringify({ modelId, message })}\n`);
    jsonResponse(res, 500, { error: message });
  }
}

/**
 * Streaming mesh extractor.
 *
 * Same input as `/geometry`, but the response is `application/x-ndjson`
 * over HTTP chunked transfer encoding. Each line is a JSON event:
 *
 *   {"type":"start","modelId":"...","batchSize":N}
 *   {"type":"batch","batchIndex":0,"meshes":[{...},{...}]}
 *   {"type":"batch","batchIndex":1,"meshes":[...]}
 *   ...
 *   {"type":"summary","meshCount":X,"attempted":Y,"skipped":Z,
 *    "batchCount":B,"geoElapsedMs":G,"totalElapsedMs":T}
 *
 * Or on error after `start`:
 *
 *   {"type":"error","message":"..."}
 *
 * Goal: first triangle on screen scales with `batchSize × per-element-cost`
 * (single-digit seconds for a 50 MB IFC), not total model size.
 *
 * Query params:
 *   ?modelId=…       opaque caller tag
 *   ?batchSize=…     meshes per batch (default 100, clamped to [1, 1000])
 */
async function handleGeometryStream(req: IncomingMessage, res: ServerResponse, parsedUrl: URL) {
  const modelId = parsedUrl.searchParams.get('modelId') ?? 'geo-stream-model';
  const rawBatchSize = parsedUrl.searchParams.get('batchSize');
  let batchSize = 100;
  if (rawBatchSize !== null) {
    const parsed = Number.parseInt(rawBatchSize, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      batchSize = Math.min(1000, Math.max(1, parsed));
    }
  }

  let bytes: Uint8Array;
  try {
    bytes = await readRequestBody(req, MAX_IFC_BYTES);
  } catch (err) {
    jsonResponse(res, 413, { error: err instanceof Error ? err.message : 'body read failed' });
    return;
  }
  if (bytes.byteLength === 0) {
    jsonResponse(res, 400, { error: 'empty body' });
    return;
  }

  // Switch to chunked transfer + NDJSON. Setting status + headers BEFORE
  // the first `res.write` commits them; subsequent writes flush as chunks.
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Sidecar-Batch-Size', String(batchSize));

  const writeLine = (obj: unknown): void => {
    res.write(JSON.stringify(obj) + '\n');
  };

  // Emit `start` before any heavy work so the client knows the stream
  // is alive and what the batch contract is.
  writeLine({ type: 'start', modelId, batchSize });

  const wallStart = Date.now();
  try {
    // Build the entity table + product maps once, same as `/geometry`.
    const rawEntities = new Map<number, import('./parser/types.js').EntityRecord>();
    scanSections(bytes, {
      onEntity: (e) => rawEntities.set(e.expressId, e),
      onHeaderRaw: () => {},
    });

    const elementIds = collectProductElementIds(rawEntities);
    const { placementIds, repIds, elementTypes, elementNames } = buildProductMaps(
      rawEntities, elementIds,
    );

    const summary = await extractGeometryStreaming(
      rawEntities, elementIds, elementTypes, elementNames, placementIds, repIds,
      {
        batchSize,
        onBatch: (meshes: ElementMesh[], batchIndex: number) => {
          writeLine({ type: 'batch', batchIndex, meshes: meshes.map(serialiseMesh) });
        },
      },
    );

    const totalElapsedMs = Date.now() - wallStart;
    writeLine({
      type: 'summary',
      modelId,
      meshCount: summary.meshCount,
      attempted: summary.attempted,
      skipped: summary.skipped,
      batchCount: summary.batchCount,
      geoElapsedMs: summary.elapsedMs,
      totalElapsedMs,
    });
    res.end();

    process.stderr.write(
      `SIDECAR_GEO_STREAM_DONE ${JSON.stringify({
        modelId, meshCount: summary.meshCount, attempted: summary.attempted,
        skipped: summary.skipped, batchCount: summary.batchCount,
        batchSize, totalElapsedMs,
      })}\n`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'geometry stream failed';
    process.stderr.write(`SIDECAR_GEO_STREAM_ERROR ${JSON.stringify({ modelId, message })}\n`);
    // Headers have already been sent → cannot switch to a JSON error
    // response. Emit a terminal `error` line + end the stream.
    try {
      writeLine({ type: 'error', message });
    } catch {
      // Connection already torn down; nothing we can do.
    }
    res.end();
  }
}

function handleHealth(res: ServerResponse) {
  jsonResponse(res, 200, {
    ok: true,
    version: VERSION,
    wasmDir: getWasmDir(),
    uptimeMs: Date.now() - STARTED_AT,
    pid: process.pid,
    parserVersion: VERSION, // native-parser is bundled alongside; version-locked to sidecar
  });
}

/**
 * Parse IFC bytes and return the metadata-index JSON.
 *
 * Query params:
 *   ?statsOnly=1  → skip the index build, return only entity stats.
 *   ?modelId=…    → opaque caller tag, mirrored back in stderr telemetry.
 *
 * Response:
 *   200  { schema, header, project, spatial, elements, ... }
 *   400  { error }   (bad params, empty body, …)
 *   500  { error }   (parse failed)
 */
async function handleParse(req: IncomingMessage, res: ServerResponse, parsedUrl: URL) {
  const statsOnly = parsedUrl.searchParams.get('statsOnly') === '1';
  const modelId = parsedUrl.searchParams.get('modelId') ?? 'sidecar-model';

  let bytes: Uint8Array;
  try {
    bytes = await readRequestBody(req, MAX_IFC_BYTES);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'body read failed';
    jsonResponse(res, 413, { error: message });
    return;
  }

  if (bytes.byteLength === 0) {
    jsonResponse(res, 400, { error: 'empty body' });
    return;
  }

  const wallStart = Date.now();
  try {
    if (statsOnly) {
      const stats = parseIfcStatsOnly(bytes);
      const elapsedMs = Date.now() - wallStart;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-Sidecar-Elapsed-Ms', String(elapsedMs));
      res.setHeader('X-Sidecar-Input-Bytes', String(bytes.byteLength));
      res.end(JSON.stringify({ statsOnly: true, stats, elapsedMs }));
      process.stderr.write(
        `SIDECAR_PARSE_DONE ${JSON.stringify({ modelId, mode: 'statsOnly', elapsedMs, inputBytes: bytes.byteLength })}\n`,
      );
      return;
    }

    const index = parseIfc(bytes, { producerVersion: VERSION });
    const elapsedMs = Date.now() - wallStart;
    const body = JSON.stringify(index);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Sidecar-Elapsed-Ms', String(elapsedMs));
    res.setHeader('X-Sidecar-Input-Bytes', String(bytes.byteLength));
    res.setHeader('X-Sidecar-Index-Bytes', String(Buffer.byteLength(body, 'utf8')));
    res.setHeader('X-Sidecar-Element-Count', String(index.stats.element_count));
    res.setHeader('X-Sidecar-Storey-Count', String(index.stats.storey_count));
    res.end(body);
    process.stderr.write(
      `SIDECAR_PARSE_DONE ${JSON.stringify({
        modelId,
        mode: 'full',
        elapsedMs,
        inputBytes: bytes.byteLength,
        elementCount: index.stats.element_count,
        storeyCount: index.stats.storey_count,
        schema: index.schema,
      })}\n`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'parse failed';
    process.stderr.write(`SIDECAR_PARSE_ERROR ${JSON.stringify({ modelId, message })}\n`);
    jsonResponse(res, 500, { error: message });
  }
}

const server = createServer(async (req, res) => {
  if (!req.url || !req.method) {
    jsonResponse(res, 400, { error: 'bad request' });
    return;
  }
  const parsedUrl = new URL(req.url, `http://${req.headers.host ?? `${HOST}:${PORT}`}`);

  try {
    if (req.method === 'GET' && parsedUrl.pathname === '/health') {
      handleHealth(res);
      return;
    }
    if (req.method === 'POST' && parsedUrl.pathname === '/convert') {
      await handleConvert(req, res, parsedUrl);
      return;
    }
    if (req.method === 'POST' && parsedUrl.pathname === '/decimate') {
      await handleDecimate(req, res, parsedUrl);
      return;
    }
    if (req.method === 'POST' && parsedUrl.pathname === '/subset') {
      await handleSubset(req, res, parsedUrl);
      return;
    }
    if (req.method === 'POST' && parsedUrl.pathname === '/parse') {
      await handleParse(req, res, parsedUrl);
      return;
    }
    if (req.method === 'POST' && parsedUrl.pathname === '/geometry') {
      await handleGeometry(req, res, parsedUrl);
      return;
    }
    if (req.method === 'POST' && parsedUrl.pathname === '/geometry/stream') {
      await handleGeometryStream(req, res, parsedUrl);
      return;
    }
    jsonResponse(res, 404, { error: `no route ${req.method} ${parsedUrl.pathname}` });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'internal error';
    jsonResponse(res, 500, { error: message });
  }
});

server.listen(PORT, HOST, () => {
  process.stderr.write(
    `SIDECAR_READY ${JSON.stringify({
      host: HOST,
      port: PORT,
      version: VERSION,
      pid: process.pid,
    })}\n`,
  );
});

function shutdown(signal: string) {
  process.stderr.write(`SIDECAR_SHUTDOWN ${signal}\n`);
  server.close(() => process.exit(0));
  // Belt-and-braces: hard exit after 3s if server.close() hangs.
  setTimeout(() => process.exit(1), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
