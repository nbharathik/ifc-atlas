/**
 * Owns the lifetime of one viewer engine instance.
 *
 * React starts the session and publishes capabilities, but it does not own
 * engine teardown details.  All asynchronous capability shutdown work is
 * registered as a barrier; the engine is disposed once, after those barriers
 * settle or the bounded shutdown deadline expires.
 */

export interface ViewerEngine {
  dispose(): void;
}

export type ViewerSessionCleanup = () => void | Promise<void>;

export interface ViewerSessionOptions {
  /** Maximum time to wait for worker reads and capability shutdown. */
  shutdownTimeoutMs?: number;
  /** Injected for deterministic tests and non-browser runtimes. */
  revokeObjectUrl?: (url: string) => void;
}

export type ViewerSessionState = 'active' | 'disposing' | 'disposed';
export type ViewerSessionStartState = 'idle' | 'starting' | 'started' | 'failed';

export interface ViewerSessionStartContext<TEngine extends ViewerEngine> {
  readonly engine: TEngine;
  readonly signal: AbortSignal;
  addCleanup(cleanup: ViewerSessionCleanup): () => void;
  ownObjectUrl(url: string): void;
}

export interface ViewerSessionSnapshot {
  readonly state: ViewerSessionState;
  readonly startState: ViewerSessionStartState;
  readonly pendingBarriers: number;
  readonly registeredCleanups: number;
  readonly ownedObjectUrls: number;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3_000;

export class ViewerSession<TEngine extends ViewerEngine = ViewerEngine> {
  readonly engine: TEngine;
  readonly signal: AbortSignal;

  private readonly abortController = new AbortController();
  private readonly cleanups: ViewerSessionCleanup[] = [];
  private readonly barriers = new Set<Promise<unknown>>();
  private readonly objectUrls = new Set<string>();
  private readonly shutdownTimeoutMs: number;
  private readonly revokeObjectUrl: (url: string) => void;
  private state: ViewerSessionState = 'active';
  private startState: ViewerSessionStartState = 'idle';
  private startPromise: Promise<unknown> | null = null;
  private disposePromise: Promise<void> | null = null;

  constructor(engine: TEngine, options: ViewerSessionOptions = {}) {
    this.engine = engine;
    this.signal = this.abortController.signal;
    this.shutdownTimeoutMs = Math.max(
      0,
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    );
    this.revokeObjectUrl = options.revokeObjectUrl
      ?? ((url) => URL.revokeObjectURL(url));
  }

  get disposed(): boolean {
    return this.state !== 'active';
  }

  /**
   * Start the engine runtime once.
   *
   * Concurrent callers share one startup promise. The initializer receives
   * only session-owned resource hooks, so resources created during startup
   * cannot outlive the engine.
   */
  start<TRuntime>(
    initialize: (context: ViewerSessionStartContext<TEngine>) => Promise<TRuntime> | TRuntime,
  ): Promise<TRuntime> {
    if (this.startPromise) return this.startPromise as Promise<TRuntime>;
    if (this.state !== 'active') {
      return Promise.reject(new Error('Cannot start a disposed viewer session.'));
    }

    this.startState = 'starting';
    const operation = Promise.resolve().then(() => initialize({
      engine: this.engine,
      signal: this.signal,
      addCleanup: (cleanup) => this.addCleanup(cleanup),
      ownObjectUrl: (url) => this.ownObjectUrl(url),
    }));
    this.startPromise = operation.then(
      (runtime) => {
        this.startState = 'started';
        return runtime;
      },
      (error) => {
        this.startState = 'failed';
        throw error;
      },
    );
    this.addBarrier(this.startPromise);
    return this.startPromise as Promise<TRuntime>;
  }

  /**
   * Register synchronous or asynchronous capability cleanup.
   *
   * Cleanups run in reverse registration order, matching resource nesting.
   * The returned function removes a cleanup that a capability already ran.
   */
  addCleanup(cleanup: ViewerSessionCleanup): () => void {
    if (this.state !== 'active') {
      void Promise.resolve().then(cleanup).catch(() => {});
      return () => {};
    }
    this.cleanups.push(cleanup);
    return () => {
      const index = this.cleanups.lastIndexOf(cleanup);
      if (index >= 0) this.cleanups.splice(index, 1);
    };
  }

  /** Keep the engine alive until an in-flight worker/capability task settles. */
  addBarrier<T>(operation: Promise<T>): Promise<T> {
    if (this.state !== 'active') return operation;
    this.barriers.add(operation);
    const release = () => this.barriers.delete(operation);
    void operation.then(release, release);
    return operation;
  }

  /** Revoke a blob-backed worker URL only after engine disposal. */
  ownObjectUrl(url: string): void {
    if (!url) return;
    if (this.state === 'disposed') {
      try {
        this.revokeObjectUrl(url);
      } catch {
        // Best-effort browser resource cleanup.
      }
      return;
    }
    this.objectUrls.add(url);
  }

  snapshot(): ViewerSessionSnapshot {
    return {
      state: this.state,
      startState: this.startState,
      pendingBarriers: this.barriers.size,
      registeredCleanups: this.cleanups.length,
      ownedObjectUrls: this.objectUrls.size,
    };
  }

  /** Abort fetches/readers before the asynchronous disposal barrier begins. */
  abortPendingWork(): void {
    if (!this.abortController.signal.aborted) this.abortController.abort();
  }

  /**
   * Dispose the session exactly once.
   *
   * Repeated callers receive the same promise. Cleanup failures never prevent
   * later resources from being released, and a stuck worker cannot retain the
   * renderer beyond the configured deadline.
   */
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.state = 'disposing';
    this.abortPendingWork();
    this.disposePromise = this.disposeOnce();
    return this.disposePromise;
  }

  private async disposeOnce(): Promise<void> {
    while (this.cleanups.length > 0) {
      const cleanup = this.cleanups.pop();
      if (!cleanup) continue;
      try {
        await cleanup();
      } catch {
        // Continue releasing the rest of the session.
      }
    }

    const pending = [...this.barriers]
      .map((operation) => Promise.resolve(operation).catch(() => {}));

    if (pending.length > 0) {
      await this.waitWithinDeadline(Promise.allSettled(pending));
    }

    try {
      this.engine.dispose();
    } catch {
      // An engine may be partly initialised; object URLs still need release.
    }

    for (const url of this.objectUrls) {
      try {
        this.revokeObjectUrl(url);
      } catch {
        // Best-effort browser resource cleanup.
      }
    }
    this.objectUrls.clear();
    this.barriers.clear();
    this.state = 'disposed';
  }

  private async waitWithinDeadline(operation: Promise<unknown>): Promise<void> {
    if (this.shutdownTimeoutMs === 0) return;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timeoutHandle = globalThis.setTimeout(resolve, this.shutdownTimeoutMs);
    });
    await Promise.race([operation.then(() => {}), timeout]);
    if (timeoutHandle !== undefined) globalThis.clearTimeout(timeoutHandle);
  }
}
