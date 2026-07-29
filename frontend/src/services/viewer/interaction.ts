export interface PickRequestToken {
  readonly generation: number;
}

export interface PickStaleInput {
  readonly requestGeneration: number;
  readonly currentGeneration: number;
}

export interface VoidClickPolicyInput {
  readonly shiftKey: boolean;
  readonly selectedElementId: number | null;
  readonly fastPickerAvailable: boolean;
  readonly fastPickerHit: boolean;
  readonly exactHit: boolean;
}

export interface VoidClickDecision {
  readonly clearSelection: boolean;
  readonly skipExactRaycastNextTime: boolean;
}

export interface SameElementClickInput {
  readonly clickedExpressId: number;
  readonly selectedElementId: number | null;
  readonly selectedIds: readonly number[];
  readonly shiftKey: boolean;
}

export interface PointerGestureInput {
  readonly distancePx: number;
  readonly elapsedMs: number;
  readonly dragThresholdPx?: number;
}

export interface ExactPickOutcomeInput {
  readonly exactHit: boolean;
  readonly error: unknown | null;
}

export interface ExactHoverReuseInput {
  /** The cached hover came from the authoritative fragments worker. */
  readonly exactHit: boolean;
  readonly distancePx: number;
  readonly ageMs: number;
  readonly cameraUnchanged: boolean;
  readonly visibilityUnchanged: boolean;
  readonly fragmentReplacementBlocked: boolean;
  readonly tolerancePx?: number;
  readonly maxAgeMs?: number;
}

export interface PrefetchedPickReuseInput {
  /** Generation captured when the pointer-down prefetch started. */
  readonly requestGeneration: number;
  /** Latest canvas-interaction generation at pointer-up. */
  readonly currentGeneration: number;
  /** Distance from the prefetched screen point to the pointer-up point. */
  readonly distancePx: number;
  readonly cameraUnchanged: boolean;
  readonly visibilityUnchanged: boolean;
  readonly fragmentReplacementBlocked: boolean;
  readonly tolerancePx?: number;
}

export interface PickLeaseCoordinator {
  readonly active: boolean;
  readonly count: number;
  acquire: () => () => void;
}

/** Keep fragment-replacing optimizations suspended across overlapping picks. */
export function createPickLeaseCoordinator(
  onActiveChange: (active: boolean) => void,
): PickLeaseCoordinator {
  let count = 0;
  return {
    get active() {
      return count > 0;
    },
    get count() {
      return count;
    },
    acquire() {
      count += 1;
      if (count === 1) onActiveChange(true);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        count = Math.max(0, count - 1);
        if (count === 0) onActiveChange(false);
      };
    },
  };
}

export function createPickRequestToken(currentGeneration: number): PickRequestToken {
  return { generation: currentGeneration };
}

export function isStalePickResult(input: PickStaleInput): boolean {
  return input.requestGeneration !== input.currentGeneration;
}

export function decideVoidClick(input: VoidClickPolicyInput): VoidClickDecision {
  const noHit = !input.fastPickerHit && !input.exactHit;
  if (!noHit) {
    return { clearSelection: false, skipExactRaycastNextTime: false };
  }
  return {
    clearSelection: !input.shiftKey && input.selectedElementId !== null,
    skipExactRaycastNextTime: input.fastPickerAvailable,
  };
}

export function isNoopSameElementClick(input: SameElementClickInput): boolean {
  if (input.shiftKey) return false;
  if (input.selectedIds.length > 1) return false;
  if (input.selectedIds.length === 1) return input.selectedIds[0] === input.clickedExpressId;
  return input.selectedElementId === input.clickedExpressId;
}

/** Press duration alone must never turn a stationary accessibility click into a drag. */
export function isClickGesture(input: PointerGestureInput): boolean {
  return input.distancePx <= (input.dragThresholdPx ?? 4);
}

/** Only a successful exact raycast with no hit is a confirmed void click. */
export function isConfirmedVoidPick(input: ExactPickOutcomeInput): boolean {
  return input.error === null && !input.exactHit;
}

/**
 * Reuse a fresh authoritative hover result for a click at the same screen
 * position. This removes a redundant worker round-trip for quick clicks but
 * fails closed whenever camera, clipping/visibility, or fragment residency
 * could have changed. A cached miss is never reused as proof of empty space.
 */
export function canReuseExactHoverPick(input: ExactHoverReuseInput): boolean {
  return input.exactHit
    && Number.isFinite(input.distancePx)
    && input.distancePx <= (input.tolerancePx ?? 2)
    && Number.isFinite(input.ageMs)
    && input.ageMs >= 0
    && input.ageMs <= (input.maxAgeMs ?? 150)
    && input.cameraUnchanged
    && input.visibilityUnchanged
    && !input.fragmentReplacementBlocked;
}

/**
 * Reuse a pointer-down exact pick only when it still describes the scene and
 * screen point released by the user. A click may travel farther than an exact
 * raycast's safe reuse radius, so gesture classification alone is insufficient.
 */
export function canReusePrefetchedPick(input: PrefetchedPickReuseInput): boolean {
  return input.requestGeneration === input.currentGeneration
    && Number.isFinite(input.distancePx)
    && input.distancePx >= 0
    && input.distancePx <= (input.tolerancePx ?? 1)
    && input.cameraUnchanged
    && input.visibilityUnchanged
    && !input.fragmentReplacementBlocked;
}

export type RuntimeViewerQuality = 'interactive' | 'balanced' | 'quality';

export interface RuntimeQualitySettings {
  readonly profile: RuntimeViewerQuality;
  readonly pixelRatioCap: number;
  readonly graphicsQuality: number;
  /** Reserved for idle-only AO via PostproductionAspect - not yet
   *  consumed; ghost postproduction handles its own nav-gating today. */
  readonly postprocessing: 'off' | 'fast' | 'full';
  /** Consumed by the hover raycast policy: Performance mode suppresses
   *  hover-only raycasts so the fragments worker queue stays clear for
   *  clicks. Measuring is exempt. */
  readonly hoverRaycastEnabled: boolean;
  /** Reserved for culler updates through the scheduler - not yet
   *  consumed; the settle handler gates hide-passes on its own today. */
  readonly cullerHideEnabled: boolean;
}

export interface InteractionQualityState {
  readonly target: RuntimeViewerQuality;
  readonly active: RuntimeViewerQuality;
  readonly navigating: boolean;
  readonly slowFrameStreak: number;
  readonly stableFrameStreak: number;
}

export type InteractionQualityEvent =
  | { readonly type: 'navigation-start' }
  | { readonly type: 'navigation-end' }
  | { readonly type: 'frame'; readonly ms: number }
  | { readonly type: 'set-target'; readonly target: RuntimeViewerQuality };

export const RUNTIME_QUALITY_SETTINGS: Readonly<Record<RuntimeViewerQuality, RuntimeQualitySettings>> = {
  interactive: {
    profile: 'interactive',
    // pixelRatioCap 1.0 / graphicsQuality 0.6 keep orbit byte-identical to the
    // pre-ladder navigation binary (navigationPixelRatioCap=1.0, GQ_ORBIT=0.6)
    // and are the cheapest navigation settings - the correct direction for the
    // orbit-FPS target.
    pixelRatioCap: 1.0,
    graphicsQuality: 0.6,
    postprocessing: 'off',
    hoverRaycastEnabled: false,
    cullerHideEnabled: false,
  },
  balanced: {
    profile: 'balanced',
    pixelRatioCap: 1.5,
    graphicsQuality: 0.85,
    postprocessing: 'fast',
    hoverRaycastEnabled: true,
    cullerHideEnabled: true,
  },
  quality: {
    profile: 'quality',
    pixelRatioCap: 2,
    graphicsQuality: 1,
    postprocessing: 'full',
    hoverRaycastEnabled: true,
    cullerHideEnabled: true,
  },
};

export const DEFAULT_INTERACTION_QUALITY_STATE: InteractionQualityState = {
  target: 'balanced',
  active: 'balanced',
  navigating: false,
  slowFrameStreak: 0,
  stableFrameStreak: 0,
};

const ORDER: readonly RuntimeViewerQuality[] = ['interactive', 'balanced', 'quality'];

function stepDown(profile: RuntimeViewerQuality): RuntimeViewerQuality {
  const idx = ORDER.indexOf(profile);
  return ORDER[Math.max(0, idx - 1)];
}

function stepTowardTarget(active: RuntimeViewerQuality, target: RuntimeViewerQuality): RuntimeViewerQuality {
  const activeIdx = ORDER.indexOf(active);
  const targetIdx = ORDER.indexOf(target);
  if (activeIdx >= targetIdx) return active;
  return ORDER[activeIdx + 1];
}

export function getRuntimeQualitySettings(
  profile: RuntimeViewerQuality,
): RuntimeQualitySettings {
  return RUNTIME_QUALITY_SETTINGS[profile];
}

export function reduceInteractionQuality(
  state: InteractionQualityState,
  event: InteractionQualityEvent,
): InteractionQualityState {
  switch (event.type) {
    case 'navigation-start':
      return {
        ...state,
        active: 'interactive',
        navigating: true,
        slowFrameStreak: 0,
        stableFrameStreak: 0,
      };
    case 'navigation-end':
      return {
        ...state,
        navigating: false,
        slowFrameStreak: 0,
        stableFrameStreak: 0,
      };
    case 'set-target':
      return {
        ...state,
        target: event.target,
        active: state.navigating ? 'interactive' : event.target,
        slowFrameStreak: 0,
        stableFrameStreak: 0,
      };
    case 'frame': {
      if (!Number.isFinite(event.ms) || event.ms <= 0) return state;
      if (state.navigating) return state;

      if (event.ms > 33) {
        const slowFrameStreak = state.slowFrameStreak + 1;
        if (slowFrameStreak >= 2) {
          return {
            ...state,
            active: stepDown(state.active),
            slowFrameStreak: 0,
            stableFrameStreak: 0,
          };
        }
        return { ...state, slowFrameStreak, stableFrameStreak: 0 };
      }

      if (event.ms <= 18) {
        const stableFrameStreak = state.stableFrameStreak + 1;
        if (stableFrameStreak >= 8) {
          return {
            ...state,
            active: stepTowardTarget(state.active, state.target),
            slowFrameStreak: 0,
            stableFrameStreak: 0,
          };
        }
        return { ...state, slowFrameStreak: 0, stableFrameStreak };
      }

      return { ...state, slowFrameStreak: 0, stableFrameStreak: 0 };
    }
  }
}

export interface HoverRaycastPolicyInput {
  readonly measuring: boolean;
  readonly hoverHighlightEnabled: boolean;
  readonly cameraNavigating: boolean;
  /** D6a - the active quality tier's `hoverRaycastEnabled` knob. Optional so
   *  existing callers/tests keep their behavior; `false` suppresses
   *  hover-only raycasts (Performance mode), measuring stays exempt because
   *  it is explicit tool input. */
  readonly hoverQualityEnabled?: boolean;
}

export const HOVER_INTENT_DELAY_MS = 60;

export function shouldRunHoverRaycast(input: HoverRaycastPolicyInput): boolean {
  if (input.measuring) return true;
  if (!input.hoverHighlightEnabled) return false;
  if (input.hoverQualityEnabled === false) return false;
  return !input.cameraNavigating;
}

export function shouldDelayHoverRaycast(input: HoverRaycastPolicyInput): boolean {
  return (
    input.hoverHighlightEnabled
    && !input.measuring
    && !input.cameraNavigating
  );
}

/**
 * Frame-coalesced, single-flight scheduler for async viewer state writes.
 *
 * A plain rAF scheduler prevents duplicate work within one frame, but it does
 * not prevent the async run started by frame N from overlapping the run
 * started by frame N + 1. That matters for fragment visibility and opacity:
 * two worker requests may finish out of order and briefly restore stale state.
 *
 * This scheduler keeps at most one run in flight. Calls made while that run is
 * active collapse into one follow-up frame, whose callback reads the latest
 * application state. Intermediate snapshots are intentionally discarded.
 */

export interface LatestAsyncRunContext {
  readonly revision: number;
  /** True after a newer schedule/cancel or scheduler shutdown. */
  isSuperseded: () => boolean;
}

export interface LatestAsyncSchedulerOptions {
  raf: (cb: () => void) => number;
  cancelRaf: (handle: number) => void;
  run: (context: LatestAsyncRunContext) => Promise<void> | void;
  onError?: (error: unknown) => void;
}

export interface LatestAsyncScheduler {
  /** Request a run using the latest state. Synchronous bursts coalesce. */
  schedule: () => void;
  /** Cancel queued follow-up work. An already-running task cannot be aborted. */
  cancel: () => void;
  /** Cancel queued work and wait for the current async reader to settle. */
  shutdown: () => Promise<void>;
  /** True when a frame or post-flight rerun is queued. */
  pending: () => boolean;
  /** True while the async callback is executing. */
  inFlight: () => boolean;
}

export function createLatestAsyncScheduler(
  options: LatestAsyncSchedulerOptions,
): LatestAsyncScheduler {
  let frameHandle: number | null = null;
  let running = false;
  let rerunRequested = false;
  let revision = 0;
  let closed = false;
  let shutdownPromise: Promise<void> | null = null;
  let resolveShutdown: (() => void) | null = null;

  const queueFrame = () => {
    if (closed || frameHandle !== null || running || !rerunRequested) return;
    frameHandle = options.raf(() => {
      frameHandle = null;
      if (!rerunRequested || running) return;
      rerunRequested = false;
      running = true;
      const runRevision = revision;
      const context: LatestAsyncRunContext = {
        revision: runRevision,
        isSuperseded: () => closed || revision !== runRevision,
      };
      void (async () => {
        try {
          await options.run(context);
        } catch (error) {
          if (!context.isSuperseded()) options.onError?.(error);
        } finally {
          running = false;
          // State may have changed while the worker request was active. Run
          // once more on a frame boundary, using only the newest snapshot.
          if (closed) {
            resolveShutdown?.();
            resolveShutdown = null;
          } else {
            queueFrame();
          }
        }
      })();
    });
  };

  const schedule = () => {
    if (closed) return;
    revision += 1;
    rerunRequested = true;
    queueFrame();
  };

  const cancel = () => {
    revision += 1;
    rerunRequested = false;
    if (frameHandle !== null) {
      options.cancelRaf(frameHandle);
      frameHandle = null;
    }
  };

  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    closed = true;
    cancel();
    if (!running) {
      shutdownPromise = Promise.resolve();
      return shutdownPromise;
    }
    shutdownPromise = new Promise<void>((resolve) => { resolveShutdown = resolve; });
    return shutdownPromise;
  };

  return {
    schedule,
    cancel,
    shutdown,
    pending: () => frameHandle !== null || rerunRequested,
    inFlight: () => running,
  };
}

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
