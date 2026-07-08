import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IfcConvertWorker } from '../ifcConvertWorker';

// ── Mock the Vite worker import ───────────────────────────────────────────────
//
// The `?worker` suffix is a Vite-specific specifier that resolves to a Worker
// constructor at build time. In the Node.js test environment (vitest) there is
// no Vite bundler, so the import would fail. We mock the entire module with a
// controllable fake Worker that lets us drive message round-trips synchronously.

interface FakeWorker {
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  /** Test helper - fire an outbound message as if the worker posted it. */
  _emit(data: unknown): void;
  /** Test helper - fire an error event. */
  _error(message: string): void;
}

function makeFakeWorker(): FakeWorker {
  const w: FakeWorker = {
    postMessage: vi.fn(),
    terminate: vi.fn(),
    onmessage: null,
    onerror: null,
    _emit(data: unknown) {
      if (w.onmessage) w.onmessage({ data } as MessageEvent);
    },
    _error(message: string) {
      if (w.onerror) w.onerror({ message } as ErrorEvent);
    },
  };
  return w;
}

let latestWorker: FakeWorker | null = null;

vi.mock('../../../workers/ifc-convert.worker?worker', () => ({
  default: vi.fn(() => {
    latestWorker = makeFakeWorker();
    return latestWorker;
  }),
}));

// ─────────────────────────────────────────────────────────────────────────────

const mkBuffer = (size = 8) => new ArrayBuffer(size);

describe('IfcConvertWorker', () => {
  beforeEach(() => {
    latestWorker = null;
    vi.clearAllMocks();
  });

  it('spawns the worker on first convert() call', async () => {
    const client = new IfcConvertWorker();
    expect(client.alive).toBe(false);

    const buf = mkBuffer();
    const promise = client.convert(buf);
    expect(client.alive).toBe(true);
    expect(latestWorker).not.toBeNull();

    // Simulate worker responding with done
    const resultBuffer = mkBuffer(32);
    latestWorker!._emit({ type: 'done', id: '0', buffer: resultBuffer, parseMs: 42 });
    const result = await promise;
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.byteLength).toBe(32);
    client.dispose();
  });

  it('sends correct postMessage payload', async () => {
    const client = new IfcConvertWorker();
    const buf = mkBuffer(16);
    const promise = client.convert(buf, 'performance', '/public/');
    expect(latestWorker!.postMessage).toHaveBeenCalledOnce();
    const [payload, transferList] = latestWorker!.postMessage.mock.calls[0];
    expect(payload.type).toBe('convert');
    expect(payload.profile).toBe('performance');
    expect(payload.wasmPath).toBe('/public/');
    expect(Array.isArray(transferList)).toBe(true);

    // Resolve the promise so the test doesn't leak
    latestWorker!._emit({ type: 'done', id: '0', buffer: mkBuffer(4), parseMs: 10 });
    await promise;
    client.dispose();
  });

  it('defaults to balanced profile and / wasmPath', async () => {
    const client = new IfcConvertWorker();
    const promise = client.convert(mkBuffer());
    const [payload] = latestWorker!.postMessage.mock.calls[0];
    expect(payload.profile).toBe('balanced');
    expect(payload.wasmPath).toBe('/');
    latestWorker!._emit({ type: 'done', id: '0', buffer: mkBuffer(), parseMs: 5 });
    await promise;
    client.dispose();
  });

  it('forwards progress events to the onProgress callback without resolving', async () => {
    const client = new IfcConvertWorker();
    const progEvents: { stage: string; pct: number }[] = [];
    const promise = client.convert(mkBuffer(), 'ultra_fast', '/', (stage, pct) => {
      progEvents.push({ stage, pct });
    });

    latestWorker!._emit({ type: 'progress', id: '0', stage: 'geometry', pct: 50 });
    latestWorker!._emit({ type: 'progress', id: '0', stage: 'geometry', pct: 80 });
    // Promise not yet resolved after progress events
    let resolved = false;
    void promise.then(() => { resolved = true; });
    await Promise.resolve(); // flush micro-task queue
    expect(resolved).toBe(false);
    expect(progEvents).toHaveLength(2);
    expect(progEvents[0]).toEqual({ stage: 'geometry', pct: 50 });

    latestWorker!._emit({ type: 'done', id: '0', buffer: mkBuffer(), parseMs: 100 });
    await promise;
    expect(resolved).toBe(true);
    client.dispose();
  });

  it('rejects when the worker emits an error message', async () => {
    const client = new IfcConvertWorker();
    const promise = client.convert(mkBuffer());
    latestWorker!._emit({ type: 'error', id: '0', message: 'WASM OOM' });
    await expect(promise).rejects.toThrow('WASM OOM');
    client.dispose();
  });

  it('rejects when the worker fires an onerror event', async () => {
    const client = new IfcConvertWorker();
    const promise = client.convert(mkBuffer());
    latestWorker!._error('worker crashed');
    await expect(promise).rejects.toThrow('worker crashed');
    client.dispose();
  });

  it('supports multiple concurrent calls identified by id', async () => {
    const client = new IfcConvertWorker();
    const p1 = client.convert(mkBuffer(8));
    const p2 = client.convert(mkBuffer(16));

    const ids = latestWorker!.postMessage.mock.calls.map(([p]) => p.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);

    // Resolve in reverse order
    const buf2 = mkBuffer(20);
    latestWorker!._emit({ type: 'done', id: ids[1], buffer: buf2, parseMs: 9 });
    const buf1 = mkBuffer(10);
    latestWorker!._emit({ type: 'done', id: ids[0], buffer: buf1, parseMs: 5 });

    const [res1, res2] = await Promise.all([p1, p2]);
    expect(res1.byteLength).toBe(10);
    expect(res2.byteLength).toBe(20);
    client.dispose();
  });

  it('rejects all in-flight calls on dispose()', async () => {
    const client = new IfcConvertWorker();
    const p1 = client.convert(mkBuffer());
    const p2 = client.convert(mkBuffer());
    // Attach rejection handlers BEFORE calling dispose to avoid unhandled rejection
    // timing: dispose() calls reject() synchronously, so handlers must exist first.
    const r1 = expect(p1).rejects.toThrow('disposed');
    const r2 = expect(p2).rejects.toThrow('disposed');
    client.dispose();
    await r1;
    await r2;
    expect(latestWorker!.terminate).toHaveBeenCalledOnce();
  });

  it('alive becomes false after dispose()', async () => {
    const client = new IfcConvertWorker();
    // Attach rejection handler before dispose to avoid unhandled rejection
    const pending = client.convert(mkBuffer()).catch(() => { /* expected */ });
    expect(client.alive).toBe(true);
    client.dispose();
    await pending;
    expect(client.alive).toBe(false);
  });

  it('worker is not spawned before first convert()', () => {
    const _ = new IfcConvertWorker();
    expect(latestWorker).toBeNull();
  });
});
