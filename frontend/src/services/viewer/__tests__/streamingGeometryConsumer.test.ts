import { afterEach, describe, it, expect, vi } from 'vitest';
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
} from '../streamingGeometryConsumer';

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
