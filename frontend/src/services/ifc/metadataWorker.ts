// Typed RPC client for the metadata worker (src/workers/metadata.worker.ts).
// Owns the worker lifecycle and multiplexes concurrent getElement calls
// by request id.

import type { ClassificationGroup, ElementDetail } from '../../types/ifc';

import MetadataWorker from '../../workers/metadata.worker.ts?worker';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

interface Response {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export class MetadataWorkerClient {
  private worker: Worker | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, Pending>();
  private _ready: Promise<void> | null = null;
  private _readyResolved = false;
  private _lastError: Error | null = null;

  get ready(): boolean {
    return this.worker !== null && this._readyResolved;
  }

  get initializing(): boolean {
    return this.worker !== null && this._ready !== null && !this._readyResolved;
  }

  get failed(): boolean {
    return this._lastError !== null;
  }

  get lastError(): Error | null {
    return this._lastError;
  }

  async init(bytes: Uint8Array): Promise<void> {
    this.dispose();
    this._lastError = null;
    this._readyResolved = false;
    const worker = new MetadataWorker();
    worker.onmessage = (evt: MessageEvent<Response>) => this._handleMessage(evt);
    // Reject ALL pending requests on worker error / message error.
    // Without this, a worker crash mid-init would leave the init Promise
    // in `pending` forever, hanging every subsequent getElement() call
    // and showing the user "Loading element…" indefinitely.
    worker.onerror = (evt) => {
      const msg = `metadata worker runtime error: ${evt.message || 'unknown'}`;
      console.warn(`[metadata-worker] ${msg}`);
      this._fail(new Error(msg), true);
    };
    worker.onmessageerror = (evt) => {
      const msg = `metadata worker message error: ${(evt as MessageEvent).data || 'unparseable'}`;
      console.warn(`[metadata-worker] ${msg}`);
      this._fail(new Error(msg), true);
    };
    this.worker = worker;
    // Init walks the whole file (OpenModel + containment/owner precompute),
    // so its budget must scale with size: the flat 60 s cap silently killed
    // properties on 60 MB+ models (init timed out → worker marked failed →
    // every later getElement returned null). ~1 ms per KB on top of the base
    // gives a 67 MB file ≈ 128 s before we declare the worker dead.
    const initTimeoutMs =
      MetadataWorkerClient.CALL_TIMEOUT_MS + Math.ceil(bytes.byteLength / 1024);
    this._ready = this._call('init', { bytes }, [bytes.buffer], initTimeoutMs)
      .then(() => {
        this._readyResolved = true;
      })
      .catch((err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        this._fail(error, true);
        throw error;
      });
    await this._ready;
  }

  private _fail(err: Error, terminateWorker: boolean): void {
    this._lastError = err;
    this._ready = null;
    this._readyResolved = false;
    if (terminateWorker && this.worker) {
      try { this.worker.terminate(); } catch { /* noop */ }
      this.worker = null;
    }
    for (const p of this.pending.values()) {
      try { p.reject(err); } catch { /* noop */ }
    }
    this.pending.clear();
  }

  async getElement(expressId: number): Promise<ElementDetail | null> {
    if (!this.worker) return null;
    if (this._ready) await this._ready;
    const result = await this._call('getElement', { expressId });
    return (result as ElementDetail | null) ?? null;
  }

  async getClassifications(): Promise<ClassificationGroup[]> {
    if (!this.worker) return [];
    if (this._ready) await this._ready;
    const result = await this._call('getClassifications', {});
    return (result as ClassificationGroup[]) ?? [];
  }

  async getElements(expressIds: number[]): Promise<(ElementDetail | null)[]> {
    if (!this.worker) return expressIds.map(() => null);
    if (this._ready) await this._ready;
    const result = await this._call('getElementsByIds', { expressIds });
    return (result as (ElementDetail | null)[]) ?? [];
  }

  // Flat [childExpressId, productExpressId, …] pairs. Built in the worker
  // at init time; consumed by ModelService to populate its synchronous
  // resolveOwnerSync() used by the viewer click path.
  async getOwnerMap(): Promise<Uint32Array> {
    if (!this.worker) return new Uint32Array();
    if (this._ready) await this._ready;
    const result = await this._call('getOwnerMap', {});
    return (result as Uint32Array) ?? new Uint32Array();
  }

  // GlobalId ↔ ExpressId entries for every IfcRoot the worker knows about.
  // ModelService composes these with the FragmentsModel's localId→GUID
  // table so each SpatialNode gets a stable expressId for selection sync.
  async getGlobalIdMap(): Promise<Array<{ expressId: number; globalId: string }>> {
    if (!this.worker) return [];
    if (this._ready) await this._ready;
    const result = await this._call('getGlobalIdMap', {});
    return (result as Array<{ expressId: number; globalId: string }>) ?? [];
  }

  dispose(): void {
    if (this.worker) {
      try { this.worker.postMessage({ id: 0, type: 'dispose' }); } catch { /* noop */ }
      try { this.worker.terminate(); } catch { /* noop */ }
      this.worker = null;
    }
    for (const p of this.pending.values()) {
      p.reject(new Error('worker disposed'));
    }
    this.pending.clear();
    this._ready = null;
    this._readyResolved = false;
    this._lastError = null;
  }

  // Hard cap on how long a single worker call may stay pending before
  // we reject it. `init` legitimately takes 1-5 s on large models;
  // 60 s is generous but caps the worst-case "Loading element… forever"
  // failure mode. Per-call kind could specialise this if needed.
  private static readonly CALL_TIMEOUT_MS = 60_000;

  private _call(
    type: string,
    extra: Record<string, unknown>,
    transfer?: Transferable[],
    timeoutMs: number = MetadataWorkerClient.CALL_TIMEOUT_MS,
  ): Promise<unknown> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error('worker not initialized'));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          const err = new Error(`metadata worker call '${type}' timed out after ${timeoutMs} ms`);
          if (type === 'init') {
            this._fail(err, true);
          }
          reject(err);
        }
      }, timeoutMs);
      const wrappedResolve = (v: unknown) => { window.clearTimeout(timeoutId); resolve(v); };
      const wrappedReject = (e: Error) => { window.clearTimeout(timeoutId); reject(e); };
      this.pending.set(id, { resolve: wrappedResolve, reject: wrappedReject });
      try {
        const msg = { id, type, ...extra };
        if (transfer && transfer.length > 0) {
          worker.postMessage(msg, transfer);
        } else {
          worker.postMessage(msg);
        }
      } catch (e) {
        this.pending.delete(id);
        window.clearTimeout(timeoutId);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private _handleMessage(evt: MessageEvent<Response>): void {
    const data = evt.data;
    if (!data || typeof data.id !== 'number') return;
    const pending = this.pending.get(data.id);
    if (!pending) return;
    this.pending.delete(data.id);
    if (data.ok) pending.resolve(data.result);
    else pending.reject(new Error(data.error ?? 'worker error'));
  }
}
