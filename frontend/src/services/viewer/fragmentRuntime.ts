import * as OBC from '@thatopen/components';
import type * as FRAGS from '@thatopen/fragments';
import { RENDER_ON_DEMAND } from '../../config/featureFlags';
import {
  createFragmentUpdateScheduler,
  type FragmentUpdateScheduler,
} from './fragmentUpdateScheduler';
import type { ViewerSessionStartContext } from './viewerSession';

export interface FragmentRuntimeOptions {
  readonly renderKick: (milliseconds?: number) => void;
  readonly onForcedUpdateTiming?: (timing: {
    readonly paceWaitMs: number;
    readonly flushMs: number;
  }) => void;
  readonly onClickHighlightRunStart?: (timestamp: number) => void;
}

export interface FragmentRuntime {
  readonly manager: OBC.FragmentsManager;
  readonly scheduler: FragmentUpdateScheduler;
  readonly residentModel: FRAGS.FragmentsModel | null;
  adoptModel(model: FRAGS.FragmentsModel): void;
}

/**
 * Owns FragmentsManager boot, update serialization, worker URL lifetime, and
 * the active model acknowledgement target.
 */
export async function createFragmentRuntime(
  session: ViewerSessionStartContext<OBC.Components>,
  options: FragmentRuntimeOptions,
): Promise<FragmentRuntime> {
  const { engine: components, signal } = session;
  const manager = components.get(OBC.FragmentsManager);
  let residentModel: FRAGS.FragmentsModel | null = null;
  let rawCoreUpdate: ((force?: boolean) => Promise<void>) | null = null;
  let droppedForcedFlushes = 0;
  const acknowledgementPreemptors = new Set<() => void>();

  const readEngineLastUpdate = (): number | null => {
    const enginePacing = manager.core as unknown as { _lastUpdate?: unknown };
    return typeof enginePacing._lastUpdate === 'number'
      ? enginePacing._lastUpdate
      : null;
  };
  const invokeRawCoreUpdate = (force: boolean): Promise<void> => {
    if (rawCoreUpdate) return rawCoreUpdate(force);
    return manager.core.update(force);
  };
  const updatePaced = async (force: boolean): Promise<boolean> => {
    if (!force) {
      const callAt = performance.now();
      await invokeRawCoreUpdate(false);
      const after = readEngineLastUpdate();
      return after === null || after >= callAt;
    }

    const forcedStart = performance.now();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (signal.aborted) throw new Error('viewer-disposed');
      const last = readEngineLastUpdate();
      const rate = manager.core.settings.maxUpdateRate;
      if (last !== null && rate > 0) {
        const since = performance.now() - last;
        if (since < rate) {
          await new Promise((resolve) => {
            window.setTimeout(resolve, Math.max(1, Math.ceil(rate - since) + 1));
          });
        }
      }
      const callAt = performance.now();
      await invokeRawCoreUpdate(true);
      const after = readEngineLastUpdate();
      if (after === null || after >= callAt) {
        options.onForcedUpdateTiming?.({
          paceWaitMs: callAt - forcedStart,
          flushMs: performance.now() - callAt,
        });
        return true;
      }
      droppedForcedFlushes += 1;
      if (import.meta.env.DEV) {
        console.debug(
          '[viewer] forced fragment flush dropped by engine pacing - retrying',
          { attempt: attempt + 1, droppedForcedFlushes },
        );
      }
    }
    throw new Error('fragments forced update dropped by engine pacing (3 attempts)');
  };

  const updatePacedAndAcknowledged = async (force: boolean): Promise<void> => {
    const acknowledgedModel = residentModel;
    if (!acknowledgedModel) {
      await updatePaced(force);
      return;
    }
    let finished = false;
    let acknowledgementTimeout = 0;
    let resolveFinished!: () => void;
    const finish = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });
    const onViewUpdated = () => {
      finished = true;
      resolveFinished();
    };
    acknowledgedModel.onViewUpdated.add(onViewUpdated);
    try {
      const accepted = await updatePaced(force);
      if (accepted && !force && !finished) {
        let preempted = false;
        const preempt = () => {
          preempted = true;
          resolveFinished();
        };
        acknowledgementPreemptors.add(preempt);
        try {
          acknowledgementTimeout = window.setTimeout(resolveFinished, 2_500);
          await finish;
        } finally {
          acknowledgementPreemptors.delete(preempt);
        }
        if (import.meta.env.DEV && !finished) {
          console.debug('[viewer] non-forced view-update acknowledgement released', {
            reason: preempted ? 'preempted-by-immediate-work' : 'no-view-change-timeout',
          });
        }
      }
    } finally {
      window.clearTimeout(acknowledgementTimeout);
      try {
        acknowledgedModel.onViewUpdated.remove(onViewUpdated);
      } catch {
        // The model may already be disposed.
      }
    }
  };

  const scheduler = createFragmentUpdateScheduler({
    raf: (callback) => window.requestAnimationFrame(callback),
    cancelRaf: (handle) => window.cancelAnimationFrame(handle),
    update: updatePacedAndAcknowledged,
    onEnqueue: (request) => {
      if (request.priority === 'idle') return;
      for (const preempt of [...acknowledgementPreemptors]) preempt();
    },
    onRunStart: (run) => {
      options.renderKick(350);
      if (import.meta.env.DEV && run.reasons.includes('click-highlight')) {
        options.onClickHighlightRunStart?.(performance.now());
      }
    },
    onRunEnd: () => options.renderKick(350),
  });

  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__ifcSchedSnapshot =
      () => scheduler.snapshot();
  }
  session.addCleanup(() => {
    residentModel = null;
    scheduler.cancel();
    acknowledgementPreemptors.clear();
    if (import.meta.env.DEV) {
      delete (window as unknown as Record<string, unknown>).__ifcSchedSnapshot;
    }
  });

  const workerHttpUrl = new URL('/worker.mjs', window.location.origin).href;
  let workerInitUrl = workerHttpUrl;
  try {
    const response = await fetch(workerHttpUrl, { signal });
    if (response.ok) {
      const workerText = await response.text();
      workerInitUrl = URL.createObjectURL(
        new Blob([workerText], { type: 'application/javascript' }),
      );
      session.ownObjectUrl(workerInitUrl);
    }
  } catch {
    if (signal.aborted) throw new Error('viewer-disposed');
    // Fall back to the HTTP worker URL when blob preparation fails.
  }
  manager.init(workerInitUrl);
  manager.core.settings.maxUpdateRate = 8;
  manager.core.settings.forceUpdateRate = 1;
  manager.core.settings.forceUpdateBuffer = 2;

  const coreWithLoad = manager.core as unknown as {
    load: (...arguments_: unknown[]) => Promise<unknown>;
  };
  const originalLoad = coreWithLoad.load.bind(manager.core);
  coreWithLoad.load = (...arguments_: unknown[]) => {
    if (signal.aborted) return Promise.reject(new Error('viewer-disposed'));
    return originalLoad(...arguments_);
  };

  try {
    const coreWithUpdate = manager.core as unknown as {
      update: (force?: boolean) => Promise<void>;
    };
    rawCoreUpdate = coreWithUpdate.update.bind(manager.core);
    coreWithUpdate.update = async (force = false) => {
      if (RENDER_ON_DEMAND) options.renderKick(350);
      if (signal.aborted) return;
      try {
        await scheduler.requestAndWait({
          priority: force ? 'visual' : 'camera',
          force,
          reason: 'camera',
        });
      } catch (error) {
        if (!signal.aborted && (error as { name?: string })?.name !== 'AbortError') {
          console.warn('[viewer] scheduled engine update failed', error);
        }
      }
    };
  } catch {
    // Direct application updates still use the scheduler.
  }

  return {
    manager,
    scheduler,
    get residentModel() {
      return residentModel;
    },
    adoptModel: (model) => {
      residentModel = model;
    },
  };
}
