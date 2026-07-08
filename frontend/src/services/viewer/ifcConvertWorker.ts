// Typed client for ifc-convert.worker.ts.
// Manages worker lifecycle and serialises concurrent convert() calls by id.
// The worker is spawned lazily on the first convert() call and kept alive so
// WASM init cost is paid once.

import IfcConvertWorkerCtor from '../../workers/ifc-convert.worker?worker';
import type { ParseProfile } from './parseProfiles';

// ── Response shapes from the worker ───────────────────────────────────────

interface WorkerDone {
  type: 'done';
  id: string;
  buffer: ArrayBuffer;
  parseMs: number;
}

interface WorkerProgress {
  type: 'progress';
  id: string;
  stage: string;
  pct: number;
}

interface WorkerError {
  type: 'error';
  id: string;
  message: string;
}

type WorkerMsg = WorkerDone | WorkerProgress | WorkerError;

type ProgressCallback = (stage: string, pct: number) => void;

interface PendingCall {
  resolve: (bytes: Uint8Array) => void;
  reject: (err: Error) => void;
  onProgress?: ProgressCallback;
}

// ── Client class ──────────────────────────────────────────────────────────

export class IfcConvertWorker {
  private _worker: Worker | null = null;
  private readonly _pending = new Map<string, PendingCall>();
  private _nextId = 0;

  /** Whether the worker has been spawned (does not imply WASM is ready). */
  get alive(): boolean {
    return this._worker !== null;
  }

  /**
   * Convert raw IFC bytes to compressed fragment bytes in the worker thread.
   *
   * `bytes` ArrayBuffer is transferred zero-copy; the caller must not use
   * the original buffer after this call.
   *
   * @param bytes     Raw IFC file bytes (ArrayBuffer, transferred)
   * @param profile   Parse profile matching the main-thread IfcLoader config
   * @param wasmPath  Path where web-ifc WASM files are served (default '/')
   * @param onProgress Optional callback for parse progress updates
   */
  convert(
    bytes: ArrayBuffer,
    profile: ParseProfile = 'balanced',
    wasmPath = '/',
    onProgress?: ProgressCallback,
  ): Promise<Uint8Array> {
    const id = String(this._nextId++);
    const worker = this._ensureWorker();
    return new Promise<Uint8Array>((resolve, reject) => {
      this._pending.set(id, { resolve, reject, onProgress });
      worker.postMessage({ id, type: 'convert', bytes, profile, wasmPath }, [bytes]);
    });
  }

  /** Terminate the worker and reject all in-flight calls. */
  dispose(): void {
    if (this._worker) {
      this._worker.terminate();
      this._worker = null;
    }
    const err = new Error('IfcConvertWorker disposed');
    for (const p of this._pending.values()) p.reject(err);
    this._pending.clear();
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private _ensureWorker(): Worker {
    if (this._worker) return this._worker;
    const w = new IfcConvertWorkerCtor();
    w.onmessage = (e: MessageEvent<WorkerMsg>) => this._handleMessage(e.data);
    w.onerror = (e) => {
      const msg = `ifc-convert worker error: ${e.message ?? 'unknown'}`;
      this._rejectAll(new Error(msg));
    };
    this._worker = w;
    return w;
  }

  private _handleMessage(msg: WorkerMsg): void {
    const pending = this._pending.get(msg.id);
    if (!pending) return;

    if (msg.type === 'progress') {
      pending.onProgress?.(msg.stage, msg.pct);
      return; // do not delete from pending
    }

    this._pending.delete(msg.id);
    if (msg.type === 'done') {
      pending.resolve(new Uint8Array(msg.buffer));
    } else {
      pending.reject(new Error(msg.message));
    }
  }

  private _rejectAll(err: Error): void {
    for (const p of this._pending.values()) p.reject(err);
    this._pending.clear();
  }
}
