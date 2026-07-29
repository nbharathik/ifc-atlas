import * as THREE from 'three';
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import {
  consumeGeometryStream,
  createNdjsonAccumulator,
  decodeMeshBatch,
  decodeMeshEntry,
  parseChunkedStream,
  parseGeometryStreamLine,
  streamNativeGeometry,
  type DecodedMesh,
  type GeometryStreamEvent,
  type SerialisedMesh,
  appendBatchToGroup,
  createStreamingMaterialCache,
  disposeStreamingPreview,
  firstTriangleElapsedMs,
  getOrCreateStreamingMaterial,
  extractStoreyNodes,
  fetchStoreyFragment,
  type StoreyFragmentResult,
} from '../streaming';
import type { SpatialNode } from '../../../types/ifc';

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

const enc = new TextEncoder();

function bytes(...lines: string[]): Uint8Array {
  return enc.encode(lines.join(''));
}

function base64FromTypedArray(arr: Float32Array | Uint32Array): string {
  const view = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let s = '';
  for (let i = 0; i < view.length; i++) s += String.fromCharCode(view[i]!);
  // node and browser both expose btoa for ASCII strings
  return btoa(s);
}

function makeMesh(
  expressId: number,
  positions: Float32Array,
  indices: Uint32Array,
  ifcType = 'IFCWALL',
  name: string | null = null,
): SerialisedMesh {
  return {
    expressId,
    ifcType,
    name,
    positions: base64FromTypedArray(positions),
    indices: base64FromTypedArray(indices),
    bbox: [0, 0, 0, 1, 1, 1],
  };
}

function streamFromBuffers(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (i < chunks.length) {
        ctrl.enqueue(chunks[i++]!);
      } else {
        ctrl.close();
      }
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. createNdjsonAccumulator - chunk-boundary handling
// ─────────────────────────────────────────────────────────────────────────────

describe('createNdjsonAccumulator', () => {
  it('emits a whole line when a single chunk contains it', () => {
    const acc = createNdjsonAccumulator();
    expect(acc.push(bytes('{"a":1}\n'))).toEqual(['{"a":1}']);
    expect(acc.flush()).toBe('');
  });

  it('buffers a line that is split across two chunks (boundary mid-record)', () => {
    const acc = createNdjsonAccumulator();
    expect(acc.push(bytes('{"x":'))).toEqual([]);
    expect(acc.push(bytes('42}\n'))).toEqual(['{"x":42}']);
  });

  it('emits multiple lines that arrive in a single chunk', () => {
    const acc = createNdjsonAccumulator();
    const out = acc.push(bytes('{"a":1}\n', '{"b":2}\n', '{"c":3}\n'));
    expect(out).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it('returns an empty array for chunks containing only whitespace / newlines', () => {
    const acc = createNdjsonAccumulator();
    expect(acc.push(bytes('\n'))).toEqual([]);
    expect(acc.push(bytes('\n\n'))).toEqual([]);
  });

  it('preserves trailing fragment until flush', () => {
    const acc = createNdjsonAccumulator();
    expect(acc.push(bytes('{"a":1}\n{"b":'))).toEqual(['{"a":1}']);
    expect(acc.flush()).toBe('{"b":');
  });

  it('handles a 4-byte UTF-8 codepoint split across the boundary', () => {
    // "🏠" is U+1F3E0 → F0 9F 8F A0 (4 bytes)
    const full = enc.encode('{"name":"🏠"}\n');
    const split = full.length - 5; // boundary inside the 4-byte codepoint
    const a = full.slice(0, split);
    const b = full.slice(split);
    const acc = createNdjsonAccumulator();
    const partial = acc.push(a);
    expect(partial).toEqual([]);
    const finished = acc.push(b);
    expect(finished).toEqual(['{"name":"🏠"}']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. parseGeometryStreamLine - strict typing + tolerance to junk
// ─────────────────────────────────────────────────────────────────────────────

describe('parseGeometryStreamLine', () => {
  it('returns null for blank input', () => {
    expect(parseGeometryStreamLine('')).toBeNull();
    expect(parseGeometryStreamLine('   ')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseGeometryStreamLine('{not-json')).toBeNull();
  });

  it('returns null for unknown event type', () => {
    expect(parseGeometryStreamLine('{"type":"progress","pct":42}')).toBeNull();
  });

  it('returns the parsed object for known event types', () => {
    const ev = parseGeometryStreamLine('{"type":"start","modelId":"m","batchSize":100}');
    expect(ev).toEqual({ type: 'start', modelId: 'm', batchSize: 100 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. parseChunkedStream - end-to-end boundary scenarios
// ─────────────────────────────────────────────────────────────────────────────

describe('parseChunkedStream', () => {
  it('preserves event order across many small chunks', () => {
    const events = parseChunkedStream([
      bytes('{"type":"start","modelId":"m","batchSize":2}\n'),
      bytes('{"type":"batch","batchIndex":0,"meshes":[]}\n'),
      bytes('{"type":"batch","batchIndex":1,"meshes":[]}\n'),
      bytes(
        '{"type":"summary","meshCount":0,"attempted":0,"skipped":0,',
        '"batchCount":2,"geoElapsedMs":1,"totalElapsedMs":2}\n',
      ),
    ]);
    expect(events.map((e) => e.type)).toEqual(['start', 'batch', 'batch', 'summary']);
    expect((events[1] as { batchIndex: number }).batchIndex).toBe(0);
    expect((events[2] as { batchIndex: number }).batchIndex).toBe(1);
  });

  it('captures a terminal error event', () => {
    const events = parseChunkedStream([
      bytes('{"type":"start","modelId":"m","batchSize":100}\n'),
      bytes('{"type":"error","message":"sidecar oom"}\n'),
    ]);
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ type: 'error', message: 'sidecar oom' });
  });

  it('parses a final line that has no trailing newline (via flush)', () => {
    const events = parseChunkedStream([
      bytes('{"type":"start","modelId":"m","batchSize":100}\n'),
      bytes('{"type":"summary","meshCount":0,"attempted":0,"skipped":0,'),
      bytes('"batchCount":0,"geoElapsedMs":0,"totalElapsedMs":0}'),
    ]);
    expect(events).toHaveLength(2);
    expect(events[1]?.type).toBe('summary');
  });

  it('skips malformed lines without aborting the stream', () => {
    const events = parseChunkedStream([
      bytes('{"type":"start","modelId":"m","batchSize":100}\n'),
      bytes('garbage line\n'),
      bytes('{"type":"summary","meshCount":0,"attempted":0,"skipped":0,'),
      bytes('"batchCount":0,"geoElapsedMs":0,"totalElapsedMs":0}\n'),
    ]);
    expect(events.map((e) => e.type)).toEqual(['start', 'summary']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. decodeMeshEntry / decodeMeshBatch - byte-exact reconstruction
// ─────────────────────────────────────────────────────────────────────────────

describe('decodeMeshEntry', () => {
  it('round-trips Float32Array positions byte-for-byte', () => {
    const positions = new Float32Array([1, 2, 3, 4.5, -7.25, 999.125]);
    const indices = new Uint32Array([0, 1, 2]);
    const decoded = decodeMeshEntry(makeMesh(42, positions, indices));
    expect(Array.from(decoded.positions)).toEqual(Array.from(positions));
    expect(Array.from(decoded.indices)).toEqual(Array.from(indices));
    expect(decoded.expressId).toBe(42);
    expect(decoded.bbox).toEqual([0, 0, 0, 1, 1, 1]);
  });

  it('handles zero-length payloads without throwing', () => {
    const decoded = decodeMeshEntry(makeMesh(7, new Float32Array(), new Uint32Array()));
    expect(decoded.positions.length).toBe(0);
    expect(decoded.indices.length).toBe(0);
  });
});

describe('decodeMeshBatch', () => {
  it('drops entries with empty positions or indices but keeps the rest', () => {
    const good = makeMesh(1, new Float32Array([1, 2, 3]), new Uint32Array([0]));
    const empty = makeMesh(2, new Float32Array(), new Uint32Array());
    const decoded = decodeMeshBatch([good, empty, good]);
    expect(decoded).toHaveLength(2);
    expect(decoded.map((d) => d.expressId)).toEqual([1, 1]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. consumeGeometryStream - orchestrator over a synthetic ReadableStream
// ─────────────────────────────────────────────────────────────────────────────

describe('consumeGeometryStream', () => {
  it('invokes onStart, onBatch (in batchIndex order), and onSummary; reports completed=true', async () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const indices = new Uint32Array([0, 1, 2]);
    const m1 = makeMesh(101, positions, indices, 'IFCWALL');
    const m2 = makeMesh(102, positions, indices, 'IFCSLAB');

    const start = bytes('{"type":"start","modelId":"abc","batchSize":1}\n');
    const b0 = bytes(`{"type":"batch","batchIndex":0,"meshes":[${JSON.stringify(m1)}]}\n`);
    const b1 = bytes(`{"type":"batch","batchIndex":1,"meshes":[${JSON.stringify(m2)}]}\n`);
    const sum = bytes(
      '{"type":"summary","modelId":"abc","meshCount":2,"attempted":2,"skipped":0,',
      '"batchCount":2,"geoElapsedMs":5,"totalElapsedMs":7}\n',
    );

    const onStart = vi.fn();
    const onBatch = vi.fn<(i: number, decoded: DecodedMesh[]) => void>();
    const onSummary = vi.fn();
    const onError = vi.fn();

    const result = await consumeGeometryStream(
      streamFromBuffers([start, b0, b1, sum]),
      { onStart, onBatch, onSummary, onError },
    );

    expect(result.completed).toBe(true);
    expect(result.errorMessage).toBeNull();
    expect(result.batchCount).toBe(2);
    expect(result.meshCount).toBe(2);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onBatch).toHaveBeenCalledTimes(2);
    expect(onBatch.mock.calls[0]![0]).toBe(0);
    expect(onBatch.mock.calls[1]![0]).toBe(1);
    expect(onSummary).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();

    // Decoded mesh round-trips byte-for-byte from the synthetic NDJSON.
    const firstDecoded = onBatch.mock.calls[0]![1][0]!;
    expect(Array.from(firstDecoded.positions)).toEqual(Array.from(positions));
    expect(Array.from(firstDecoded.indices)).toEqual(Array.from(indices));
    expect(firstDecoded.expressId).toBe(101);
  });

  it('reports completed=false and errorMessage on terminal error event', async () => {
    const onError = vi.fn();
    const result = await consumeGeometryStream(
      streamFromBuffers([
        bytes('{"type":"start","modelId":"x","batchSize":100}\n'),
        bytes('{"type":"error","message":"sidecar segfault"}\n'),
      ]),
      { onError },
    );
    expect(result.completed).toBe(false);
    expect(result.errorMessage).toBe('sidecar segfault');
    expect(onError).toHaveBeenCalledWith({ type: 'error', message: 'sidecar segfault' });
  });

  it('awaits async onBatch callbacks before reading the next chunk', async () => {
    let resolveBatch: (() => void) | null = null;
    const order: string[] = [];
    const onBatch = vi.fn((_idx: number) => {
      order.push('batch-start');
      return new Promise<void>((res) => {
        resolveBatch = () => {
          order.push('batch-end');
          res();
        };
      });
    });
    const onSummary = vi.fn(() => {
      order.push('summary');
    });

    const m = makeMesh(1, new Float32Array([0, 0, 0]), new Uint32Array([0]));
    const stream = streamFromBuffers([
      bytes('{"type":"start","modelId":"m","batchSize":1}\n'),
      bytes(`{"type":"batch","batchIndex":0,"meshes":[${JSON.stringify(m)}]}\n`),
      bytes(
        '{"type":"summary","meshCount":1,"attempted":1,"skipped":0,',
        '"batchCount":1,"geoElapsedMs":0,"totalElapsedMs":0}\n',
      ),
    ]);
    const finalP = consumeGeometryStream(stream, { onBatch, onSummary });
    // Yield enough microtasks for the ReadableStream pump to deliver
    // the start + first batch line to the orchestrator. ~20 turns is
    // ample on every JS engine vitest runs against; the assertion is
    // that batch-end / summary have NOT fired before resolveBatch().
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(order).toEqual(['batch-start']);
    resolveBatch!();
    await finalP;
    expect(order).toEqual(['batch-start', 'batch-end', 'summary']);
  });

  it('cancels the reader cooperatively when signal is aborted before the first read', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const onBatch = vi.fn();
    const onSummary = vi.fn();
    const result = await consumeGeometryStream(
      streamFromBuffers([
        bytes('{"type":"start","modelId":"m","batchSize":100}\n'),
      ]),
      { onBatch, onSummary },
      ctrl.signal,
    );
    expect(result.completed).toBe(false);
    expect(onBatch).not.toHaveBeenCalled();
    expect(onSummary).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. streamNativeGeometry - fetch wrapper (mocked global.fetch)
// ─────────────────────────────────────────────────────────────────────────────

describe('streamNativeGeometry', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockOkResponse(chunks: Uint8Array[]): Response {
    return new Response(streamFromBuffers(chunks), { status: 200, statusText: 'OK' });
  }

  it('POSTs to /api/ifc/geometry/stream with FormData and drains the streamed body', async () => {
    const m = makeMesh(99, new Float32Array([0, 0, 0]), new Uint32Array([0]));
    const chunks = [
      bytes('{"type":"start","modelId":"m","batchSize":1}\n'),
      bytes(`{"type":"batch","batchIndex":0,"meshes":[${JSON.stringify(m)}]}\n`),
      bytes(
        '{"type":"summary","meshCount":1,"attempted":1,"skipped":0,',
        '"batchCount":1,"geoElapsedMs":1,"totalElapsedMs":2}\n',
      ),
    ];
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(mockOkResponse(chunks));

    const onBatch = vi.fn();
    const onSummary = vi.fn();
    const result = await streamNativeGeometry(
      { ifcBytes: new Uint8Array([1, 2, 3, 4]) },
      { onBatch, onSummary },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/api/ifc/geometry/stream');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(FormData);
    expect(result?.completed).toBe(true);
    expect(onBatch).toHaveBeenCalledTimes(1);
    expect(onSummary).toHaveBeenCalledTimes(1);
  });

  it('appends modelId + batchSize as query params when supplied', async () => {
    const chunks = [
      bytes('{"type":"start","modelId":"abc","batchSize":250}\n'),
      bytes(
        '{"type":"summary","meshCount":0,"attempted":0,"skipped":0,',
        '"batchCount":0,"geoElapsedMs":0,"totalElapsedMs":0}\n',
      ),
    ];
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(mockOkResponse(chunks));

    await streamNativeGeometry(
      { ifcBytes: new Uint8Array(8), modelId: 'abc', batchSize: 250 },
      {},
    );

    const url = String(fetchSpy.mock.calls[0]![0]);
    expect(url.startsWith('/api/ifc/geometry/stream?')).toBe(true);
    expect(url).toContain('modelId=abc');
    expect(url).toContain('batchSize=250');
  });

  it('returns null when the response is not ok', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('boom', { status: 500, statusText: 'Internal' }),
    );
    const result = await streamNativeGeometry({ ifcBytes: new Uint8Array(4) }, {});
    expect(result).toBeNull();
  });

  it('returns null when the response body is missing', async () => {
    // Manually fabricate an "ok but no body" - Response constructed without body has null .body.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200, statusText: 'OK' }),
    );
    const result = await streamNativeGeometry({ ifcBytes: new Uint8Array(4) }, {});
    expect(result).toBeNull();
  });

  it('returns null when fetch itself throws (network error / abort)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('NetworkError'));
    const result = await streamNativeGeometry({ ifcBytes: new Uint8Array(4) }, {});
    expect(result).toBeNull();
  });

  it('omits the query string when no modelId / batchSize is given', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(mockOkResponse([
        bytes('{"type":"summary","meshCount":0,"attempted":0,"skipped":0,'),
        bytes('"batchCount":0,"geoElapsedMs":0,"totalElapsedMs":0}\n'),
      ]));
    await streamNativeGeometry({ ifcBytes: new Uint8Array(4) }, {});
    expect(fetchSpy.mock.calls[0]![0]).toBe('/api/ifc/geometry/stream');
  });
});

function makeDecoded(
  expressId: number,
  ifcType = 'IFCWALL',
  positions: Float32Array = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: Uint32Array = new Uint32Array([0, 1, 2]),
): DecodedMesh {
  return {
    expressId,
    ifcType,
    name: null,
    positions,
    indices,
    bbox: [0, 0, 0, 1, 1, 1],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// getOrCreateStreamingMaterial / cache
// ─────────────────────────────────────────────────────────────────────────────

describe('getOrCreateStreamingMaterial', () => {
  it('returns the same material instance for repeated lookups of the same type', () => {
    const cache = createStreamingMaterialCache();
    const a = getOrCreateStreamingMaterial(cache, 'IFCWALL');
    const b = getOrCreateStreamingMaterial(cache, 'IFCWALL');
    expect(a).toBe(b);
    expect(cache.size).toBe(1);
  });

  it('normalises ifc-type casing so case-variants share one material', () => {
    const cache = createStreamingMaterialCache();
    const a = getOrCreateStreamingMaterial(cache, 'ifcwall');
    const b = getOrCreateStreamingMaterial(cache, 'IfcWall');
    expect(a).toBe(b);
    expect(cache.size).toBe(1);
  });

  it('creates a separate material per distinct type', () => {
    const cache = createStreamingMaterialCache();
    getOrCreateStreamingMaterial(cache, 'IFCWALL');
    getOrCreateStreamingMaterial(cache, 'IFCSLAB');
    getOrCreateStreamingMaterial(cache, 'IFCDOOR');
    expect(cache.size).toBe(3);
  });

  it('uses MeshLambertMaterial with DoubleSide / opaque defaults', () => {
    const cache = createStreamingMaterialCache();
    const mat = getOrCreateStreamingMaterial(cache, 'IFCWALL');
    expect(mat).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect(mat.side).toBe(THREE.DoubleSide);
    expect(mat.transparent).toBe(false);
    expect(mat.opacity).toBe(1.0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// appendBatchToGroup
// ─────────────────────────────────────────────────────────────────────────────

describe('appendBatchToGroup', () => {
  it('appends one mesh per decoded entry with the correct geometry attributes', () => {
    const group = new THREE.Group();
    const cache = createStreamingMaterialCache();
    const result = appendBatchToGroup(group, cache, [makeDecoded(1), makeDecoded(2)]);
    expect(result.appended).toBe(2);
    expect(result.skipped).toBe(0);
    expect(group.children).toHaveLength(2);

    const mesh = group.children[0] as THREE.Mesh;
    expect(mesh).toBeInstanceOf(THREE.Mesh);
    const geom = mesh.geometry;
    const pos = geom.getAttribute('position');
    expect(pos.count).toBe(3);
    // Index buffer present
    expect(geom.getIndex()?.count).toBe(3);
    // Normals computed via computeVertexNormals
    expect(geom.getAttribute('normal')).toBeDefined();
  });

  it('skips entries with empty positions or empty indices and reports counts', () => {
    const group = new THREE.Group();
    const cache = createStreamingMaterialCache();
    const result = appendBatchToGroup(group, cache, [
      makeDecoded(1),
      makeDecoded(2, 'IFCWALL', new Float32Array(), new Uint32Array([0, 1, 2])),
      makeDecoded(3, 'IFCWALL', new Float32Array([0, 0, 0]), new Uint32Array()),
      makeDecoded(4),
    ]);
    expect(result.appended).toBe(2);
    expect(result.skipped).toBe(2);
    expect(group.children).toHaveLength(2);
    expect((group.children[0] as THREE.Mesh).userData.expressId).toBe(1);
    expect((group.children[1] as THREE.Mesh).userData.expressId).toBe(4);
  });

  it('reuses one material per ifc-type across an entire batch (cache size matches distinct types)', () => {
    const group = new THREE.Group();
    const cache = createStreamingMaterialCache();
    appendBatchToGroup(group, cache, [
      makeDecoded(1, 'IFCWALL'),
      makeDecoded(2, 'IFCWALL'),
      makeDecoded(3, 'IFCSLAB'),
      makeDecoded(4, 'IFCWALL'),
    ]);
    expect(cache.size).toBe(2);
    expect((group.children[0] as THREE.Mesh).material).toBe(
      (group.children[1] as THREE.Mesh).material,
    );
    expect((group.children[0] as THREE.Mesh).material).not.toBe(
      (group.children[2] as THREE.Mesh).material,
    );
  });

  it('sets mesh.name and userData fields the picker / select path can read', () => {
    const group = new THREE.Group();
    const cache = createStreamingMaterialCache();
    appendBatchToGroup(group, cache, [makeDecoded(987, 'IFCDOOR')]);
    const mesh = group.children[0] as THREE.Mesh;
    expect(mesh.name).toBe('native-preview-987');
    expect(mesh.userData).toEqual({ expressId: 987, ifcType: 'IFCDOOR' });
  });

  it('appends across multiple invocations to the same group (streaming model)', () => {
    const group = new THREE.Group();
    const cache = createStreamingMaterialCache();
    appendBatchToGroup(group, cache, [makeDecoded(1), makeDecoded(2)]);
    appendBatchToGroup(group, cache, [makeDecoded(3)]);
    expect(group.children).toHaveLength(3);
  });

  it('returns zero counts and leaves the group empty for an empty batch', () => {
    const group = new THREE.Group();
    const cache = createStreamingMaterialCache();
    const result = appendBatchToGroup(group, cache, []);
    expect(result).toEqual({ appended: 0, skipped: 0 });
    expect(group.children).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// disposeStreamingPreview
// ─────────────────────────────────────────────────────────────────────────────

describe('disposeStreamingPreview', () => {
  it('disposes every mesh geometry, every material, and empties the group + cache', () => {
    const group = new THREE.Group();
    const cache = createStreamingMaterialCache();
    appendBatchToGroup(group, cache, [makeDecoded(1, 'IFCWALL'), makeDecoded(2, 'IFCSLAB')]);
    const geoms = group.children.map((c) => (c as THREE.Mesh).geometry);
    const mats = Array.from(cache.values());
    const geomDispose = geoms.map((g) => {
      const spy = vi.fn();
      g.dispose = spy as unknown as typeof g.dispose;
      return spy;
    });
    const matDispose = mats.map((m) => {
      const spy = vi.fn();
      m.dispose = spy as unknown as typeof m.dispose;
      return spy;
    });

    disposeStreamingPreview(group, cache);

    expect(group.children).toHaveLength(0);
    expect(cache.size).toBe(0);
    for (const spy of geomDispose) expect(spy).toHaveBeenCalledTimes(1);
    for (const spy of matDispose) expect(spy).toHaveBeenCalledTimes(1);
  });

  it('is safe to call twice without throwing', () => {
    const group = new THREE.Group();
    const cache = createStreamingMaterialCache();
    appendBatchToGroup(group, cache, [makeDecoded(1)]);
    disposeStreamingPreview(group, cache);
    expect(() => disposeStreamingPreview(group, cache)).not.toThrow();
  });

  it('is a no-op on an already-empty group + cache', () => {
    const group = new THREE.Group();
    const cache = createStreamingMaterialCache();
    expect(() => disposeStreamingPreview(group, cache)).not.toThrow();
    expect(group.children).toHaveLength(0);
    expect(cache.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// firstTriangleElapsedMs
// ---------------------------------------------------------------------------

describe('firstTriangleElapsedMs', () => {
  it('returns elapsed ms on the first batch that appends', () => {
    const result = { appended: 5, skipped: 0 };
    const ms = firstTriangleElapsedMs(1000, false, result, 1234);
    expect(ms).toBe(234);
  });

  it('returns null when no triangles appended in this batch', () => {
    const result = { appended: 0, skipped: 3 };
    const ms = firstTriangleElapsedMs(1000, false, result, 1234);
    expect(ms).toBeNull();
  });

  it('returns null when first triangle already recorded', () => {
    const result = { appended: 10, skipped: 0 };
    const ms = firstTriangleElapsedMs(1000, true, result, 1500);
    expect(ms).toBeNull();
  });

  it('clamps negative deltas to 0 (clock skew defence)', () => {
    const result = { appended: 1, skipped: 0 };
    const ms = firstTriangleElapsedMs(1500, false, result, 1000);
    expect(ms).toBe(0);
  });

  it('returns 0 exactly when now == startTs and a triangle appended', () => {
    const result = { appended: 1, skipped: 0 };
    const ms = firstTriangleElapsedMs(2000, false, result, 2000);
    expect(ms).toBe(0);
  });

  it('handles skip-only-then-append sequence', () => {
    // Batch 1: only skipped entries - no first triangle yet.
    const ms1 = firstTriangleElapsedMs(1000, false, { appended: 0, skipped: 5 }, 1100);
    expect(ms1).toBeNull();
    // Batch 2: first real append → first triangle.
    const ms2 = firstTriangleElapsedMs(1000, false, { appended: 3, skipped: 1 }, 1250);
    expect(ms2).toBe(250);
    // Subsequent batches with `already=true` return null even if appended.
    const ms3 = firstTriangleElapsedMs(1000, true, { appended: 50, skipped: 0 }, 1800);
    expect(ms3).toBeNull();
  });
});

// ── helpers ───────────────────────────────────────────────────────────────────

function makeNode(
  id: number,
  ifc_type: string,
  children: SpatialNode[] = [],
  name = `node${id}`,
): SpatialNode {
  return { id, ifc_type, name, children, global_id: '' };
}

function makeTree(): SpatialNode {
  // Project → Site → Building → [Ground Floor, First Floor]
  const gfWall1 = makeNode(10, 'IfcWall', [], 'GFWall1');
  const gfWall2 = makeNode(11, 'IfcWall', [], 'GFWall2');
  const gfDoor  = makeNode(12, 'IfcDoor', [], 'GFDoor');
  const groundFloor = makeNode(2, 'IfcBuildingStorey', [gfWall1, gfWall2, gfDoor], 'Ground Floor');

  const ffWall  = makeNode(20, 'IfcWall', [], 'FFWall');
  const ffWindow = makeNode(21, 'IfcWindow', [], 'FFWindow');
  const firstFloor = makeNode(3, 'IfcBuildingStorey', [ffWall, ffWindow], 'First Floor');

  const building = makeNode(1, 'IfcBuilding', [groundFloor, firstFloor]);
  const site = makeNode(0, 'IfcSite', [building]);
  return makeNode(-1, 'IfcProject', [site]);
}

// ── extractStoreyNodes ────────────────────────────────────────────────────────

describe('extractStoreyNodes', () => {
  it('returns [] for null root', () => {
    expect(extractStoreyNodes(null)).toEqual([]);
  });

  it('returns [] when no storeys in tree', () => {
    const root = makeNode(1, 'IfcProject', [makeNode(2, 'IfcSite', [])]);
    expect(extractStoreyNodes(root)).toEqual([]);
  });

  it('extracts storey nodes in depth-first order', () => {
    const tree = makeTree();
    const storeys = extractStoreyNodes(tree);
    expect(storeys).toHaveLength(2);
    expect(storeys[0].name).toBe('Ground Floor');
    expect(storeys[1].name).toBe('First Floor');
  });

  it('extracts single storey', () => {
    const gf = makeNode(2, 'IfcBuildingStorey', [], 'GF');
    const root = makeNode(0, 'IfcProject', [makeNode(1, 'IfcBuilding', [gf])]);
    const storeys = extractStoreyNodes(root);
    expect(storeys).toHaveLength(1);
    expect(storeys[0]).toBe(gf);
  });

  it('handles ifc_type case-insensitively', () => {
    const gf = makeNode(2, 'IFCBUILDINGSTOREY', [], 'GF');
    const root = makeNode(0, 'ifcproject', [gf]);
    expect(extractStoreyNodes(root)).toHaveLength(1);
  });

  it('does not include IfcProject itself even if type is storey', () => {
    // Edge: a single root node that IS a storey
    const root = makeNode(1, 'IfcBuildingStorey', []);
    const storeys = extractStoreyNodes(root);
    expect(storeys).toHaveLength(1);
    expect(storeys[0]).toBe(root);
  });
});

// ── buildRevealSequence ───────────────────────────────────────────────────────

// ── revealStoreyByStorey ──────────────────────────────────────────────────────

// ── fetchStoreyFragment + createStoreyStreamingLoader ────────────────────────


describe('fetchStoreyFragment', () => {
  const mockFetch = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    const resp = new Response(
      typeof body === 'string' ? body : JSON.stringify(body),
      {
        status,
        headers: {
          'Content-Type': status === 200 ? 'application/octet-stream' : 'application/json',
          ...headers,
        },
      },
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp));
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns bytes + source + storeyName on 200', async () => {
    mockFetch(200, 'FRAG_BYTES', {
      'X-Fragment-Source': 'sidecar',
      'X-Fragment-Storey-Name': 'Ground Floor',
    });
    const result = await fetchStoreyFragment('sha123', 0);
    expect(result.source).toBe('sidecar');
    expect(result.storeyName).toBe('Ground Floor');
    expect(result.bytes.byteLength).toBeGreaterThan(0);
  });

  it('throws on 204 (empty storey)', async () => {
    // Response constructor rejects 204 in test env; use a plain mock object.
    const resp204 = { status: 204, ok: false, headers: new Headers() };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp204));
    await expect(fetchStoreyFragment('sha123', 0)).rejects.toThrow('204');
  });

  it('throws on 404 with detail message', async () => {
    mockFetch(404, { detail: 'SHA mismatch' });
    await expect(fetchStoreyFragment('sha123', 0)).rejects.toThrow('SHA mismatch');
  });

  it('includes HTTP status in error message on non-OK response', async () => {
    mockFetch(503, { detail: 'sidecar error' });
    await expect(fetchStoreyFragment('sha123', 0)).rejects.toThrow('503');
  });

  it('builds the correct URL with sha + idx', async () => {
    mockFetch(200, 'BYTES', { 'X-Fragment-Source': 'cache', 'X-Fragment-Storey-Name': 'GF' });
    await fetchStoreyFragment('deadbeef', 2);
    const fetchMock = vi.mocked(fetch);
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain('sha=deadbeef');
    expect(calledUrl).toContain('idx=2');
  });

  it('uses "unknown" source when X-Fragment-Source header is absent', async () => {
    const resp = new Response('BYTES', { status: 200 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp));
    const result = await fetchStoreyFragment('sha', 0);
    expect(result.source).toBe('unknown');
  });
});
