/**
 * Latest-request gate for asynchronous viewer context-menu picks.
 *
 * Worker raycasts may settle out of order. This tiny state machine ensures
 * only the newest request may open a menu, distinguishes an authoritative
 * empty-space miss from a failed pick, and prevents teardown continuations
 * from publishing UI state.
 */

export type ContextMenuPickOutcome<THit> =
  | { status: 'success'; hit: THit | null }
  | { status: 'failure'; error: unknown };

export type ContextMenuPickDecision<THit> =
  | { kind: 'hit'; hit: THit }
  | { kind: 'empty' }
  | {
      kind: 'ignore';
      reason: 'stale' | 'failed' | 'disposed';
      error?: unknown;
    };

export interface ContextMenuPickGuard {
  /** Start a request and return its unique generation token. */
  begin(): number;
  /** Invalidate every request started so far without starting a new one. */
  invalidate(): void;
  /** Resolve a request into the only UI actions the caller may publish. */
  resolve<THit>(
    generation: number,
    outcome: ContextMenuPickOutcome<THit>,
  ): ContextMenuPickDecision<THit>;
  /** Permanently reject pending and future continuations. */
  dispose(): void;
}

export function createContextMenuPickGuard(): ContextMenuPickGuard {
  let currentGeneration = 0;
  let disposed = false;

  return {
    begin() {
      currentGeneration += 1;
      return currentGeneration;
    },

    invalidate() {
      currentGeneration += 1;
    },

    resolve<THit>(
      generation: number,
      outcome: ContextMenuPickOutcome<THit>,
    ): ContextMenuPickDecision<THit> {
      if (disposed) return { kind: 'ignore', reason: 'disposed' };
      if (generation !== currentGeneration) {
        return { kind: 'ignore', reason: 'stale' };
      }
      if (outcome.status === 'failure') {
        return {
          kind: 'ignore',
          reason: 'failed',
          error: outcome.error,
        };
      }
      if (outcome.hit === null) return { kind: 'empty' };
      return { kind: 'hit', hit: outcome.hit };
    },

    dispose() {
      disposed = true;
      currentGeneration += 1;
    },
  };
}
