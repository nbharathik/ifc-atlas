import { describe, expect, it, vi } from 'vitest';
import type { MaterialDefinition } from '@thatopen/fragments';
import {
  RenderStateCoordinator,
  type FragmentRenderStateModel,
} from '../renderStateCoordinator';

type Call =
  | { kind: 'visible'; ids: number[] | undefined; value: boolean }
  | { kind: 'reset-visible' }
  | { kind: 'opacity'; ids: number[] | undefined; value: number }
  | { kind: 'reset-opacity'; ids: number[] | undefined }
  | { kind: 'highlight'; ids: number[] | undefined; style: string }
  | { kind: 'reset-highlight'; ids: number[] | undefined };

function fakeMaterial(style: string): MaterialDefinition {
  return {
    color: { getHexString: () => style, r: 0, g: 0, b: 0 },
    opacity: 1,
    transparent: false,
    renderedFaces: 0,
    customId: style,
  } as unknown as MaterialDefinition;
}

function createModel() {
  const calls: Call[] = [];
  const model: FragmentRenderStateModel = {
    setVisible: async (ids, value) => {
      calls.push({ kind: 'visible', ids: ids?.slice(), value });
    },
    resetVisible: async () => {
      calls.push({ kind: 'reset-visible' });
    },
    setOpacity: async (ids, value) => {
      calls.push({ kind: 'opacity', ids: ids?.slice(), value });
    },
    resetOpacity: async (ids) => {
      calls.push({ kind: 'reset-opacity', ids: ids?.slice() });
    },
    highlight: async (ids, material) => {
      calls.push({
        kind: 'highlight',
        ids: ids?.slice(),
        style: material.customId ?? 'unknown',
      });
    },
    resetHighlight: async (ids) => {
      calls.push({ kind: 'reset-highlight', ids: ids?.slice() });
    },
  };
  return { model, calls };
}

describe('RenderStateCoordinator', () => {
  it('composes independent visibility masks without one owner revealing another', async () => {
    const { model, calls } = createModel();
    const coordinator = new RenderStateCoordinator({ model });

    await coordinator.setVisibilityLayer('user', [1, 2], { urgency: 'visual' });
    await coordinator.setVisibilityLayer('culler', [2, 3], { urgency: 'visual' });
    await coordinator.setVisibilityLayer('user', null, { urgency: 'visual' });
    await coordinator.setVisibilityLayer('culler', null, { urgency: 'visual' });

    expect(calls).toEqual([
      { kind: 'visible', ids: [1, 2], value: false },
      { kind: 'visible', ids: [3], value: false },
      { kind: 'visible', ids: [1], value: true },
      { kind: 'visible', ids: [2, 3], value: true },
    ]);
    expect(coordinator.snapshot().effectiveHiddenCount).toBe(0);
  });

  it('uses the lowest opacity across layers and restores only changed IDs', async () => {
    const { model, calls } = createModel();
    const coordinator = new RenderStateCoordinator({ model });

    await coordinator.setOpacityLayer('focus', [1, 2], 0.4, { urgency: 'visual' });
    await coordinator.setOpacityLayer('isolate', [2, 3], 0.2, { urgency: 'visual' });
    await coordinator.setOpacityLayer('isolate', null, 1, { urgency: 'visual' });
    await coordinator.setOpacityLayer('focus', null, 1, { urgency: 'visual' });

    expect(calls).toEqual([
      { kind: 'opacity', ids: [1, 2], value: 0.4 },
      { kind: 'opacity', ids: [2, 3], value: 0.2 },
      { kind: 'reset-highlight', ids: [3] },
      { kind: 'opacity', ids: [2], value: 0.4 },
      { kind: 'reset-highlight', ids: [1, 2] },
    ]);
  });

  it('repaints the winning highlight layer without a reset-first gap', async () => {
    const { model, calls } = createModel();
    const coordinator = new RenderStateCoordinator({ model });
    const blue = fakeMaterial('blue');
    const amber = fakeMaterial('amber');

    await coordinator.update({
      highlights: [
        {
          layer: 'base',
          definition: {
            layer: 'base',
            priority: 10,
            entries: [{ styleKey: 'blue', ids: [1, 2], material: blue }],
          },
        },
        {
          layer: 'selection',
          definition: {
            layer: 'selection',
            priority: 40,
            entries: [{ styleKey: 'amber', ids: [2], material: amber }],
          },
        },
      ],
    }, { urgency: 'visual' });

    calls.length = 0;
    await coordinator.setHighlightLayer({
      layer: 'selection',
      priority: 40,
      entries: [{ styleKey: 'amber', ids: [3], material: amber }],
    }, { urgency: 'visual' });

    expect(calls).toEqual([
      { kind: 'highlight', ids: [2], style: 'blue' },
      { kind: 'highlight', ids: [3], style: 'amber' },
    ]);
    expect(calls.some((call) => call.kind === 'reset-highlight')).toBe(false);

    calls.length = 0;
    await coordinator.clearHighlightLayer('selection', { urgency: 'visual' });
    expect(calls).toEqual([
      { kind: 'reset-highlight', ids: [3] },
    ]);
  });

  it('collapses a synchronous burst to the latest generation', async () => {
    const { model, calls } = createModel();
    const coordinator = new RenderStateCoordinator({ model });
    const pending: Array<Promise<unknown>> = [];

    for (let id = 1; id <= 100; id += 1) {
      pending.push(coordinator.setVisibilityLayer('user', [id], { urgency: 'visual' }));
    }
    await Promise.all(pending);

    expect(calls).toEqual([
      { kind: 'visible', ids: [100], value: false },
    ]);
    expect(coordinator.snapshot()).toMatchObject({
      generation: 100,
      appliedGeneration: 100,
      renderedGeneration: 100,
      effectiveHiddenCount: 1,
    });
  });

  it('never overlaps worker mutations and converges after an in-flight change', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let first = true;
    let active = 0;
    let maxActive = 0;
    const calls: Call[] = [];
    const model = createModel().model;
    model.setVisible = async (ids, value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push({ kind: 'visible', ids: ids?.slice(), value });
      if (first) {
        first = false;
        await firstGate;
      }
      active -= 1;
    };
    const coordinator = new RenderStateCoordinator({ model });

    const firstCommit = coordinator.setVisibilityLayer('user', [1], { urgency: 'visual' });
    await Promise.resolve();
    const latestCommit = coordinator.setVisibilityLayer('user', [2], { urgency: 'visual' });
    releaseFirst();
    await Promise.all([firstCommit, latestCommit]);

    expect(maxActive).toBe(1);
    expect(calls).toEqual([
      { kind: 'visible', ids: [1], value: false },
      { kind: 'visible', ids: [1], value: true },
      { kind: 'visible', ids: [2], value: false },
    ]);
    expect(coordinator.snapshot().effectiveHiddenCount).toBe(1);
  });

  it('reveals an incoming isolate set before hiding the outgoing set', async () => {
    const visible = new Set([1, 2]);
    const visibleCounts: number[] = [];
    const { model, calls } = createModel();
    model.setVisible = async (ids, value) => {
      calls.push({ kind: 'visible', ids: ids?.slice(), value });
      for (const id of ids ?? []) {
        if (value) visible.add(id);
        else visible.delete(id);
      }
      visibleCounts.push(visible.size);
    };
    const coordinator = new RenderStateCoordinator({ model });
    await coordinator.setVisibilityLayer('user', [2], { urgency: 'visual' });
    calls.length = 0;
    visibleCounts.length = 0;

    await coordinator.setVisibilityLayer('user', [1], { urgency: 'visual' });

    expect(calls).toEqual([
      { kind: 'visible', ids: [2], value: true },
      { kind: 'visible', ids: [1], value: false },
    ]);
    expect(visibleCounts).toEqual([2, 1]);
  });

  it('resolves a generation only after its render acknowledgement', async () => {
    const { model } = createModel();
    let acknowledge!: () => void;
    const renderGate = new Promise<void>((resolve) => { acknowledge = resolve; });
    const requestRender = vi.fn(() => renderGate);
    const coordinator = new RenderStateCoordinator({ model, requestRender });
    let resolved = false;

    const commit = coordinator
      .setVisibilityLayer('user', [7], { urgency: 'visual', reason: 'test-visibility' })
      .then(() => { resolved = true; });
    await vi.waitFor(() => {
      expect(requestRender).toHaveBeenCalledWith(1, 'test-visibility');
    });
    expect(resolved).toBe(false);
    acknowledge();
    await commit;
    expect(coordinator.snapshot().renderedGeneration).toBe(1);
  });

  it('keeps the render reason correlated with the generation captured before worker awaits', async () => {
    const { model, calls } = createModel();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let first = true;
    model.setVisible = async (ids, value) => {
      calls.push({ kind: 'visible', ids: ids?.slice(), value });
      if (first) {
        first = false;
        await firstGate;
      }
    };
    const rendered: Array<[number, string]> = [];
    const coordinator = new RenderStateCoordinator({
      model,
      requestRender: async (generation, reason) => { rendered.push([generation, reason]); },
    });

    const firstCommit = coordinator.setVisibilityLayer(
      'user',
      [1],
      { urgency: 'visual', reason: 'selection:first' },
    );
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const secondCommit = coordinator.setVisibilityLayer(
      'user',
      [2],
      { urgency: 'visual', reason: 'culler-hide:second' },
    );
    releaseFirst();
    await Promise.all([firstCommit, secondCommit]);

    expect(rendered).toEqual([
      [2, 'culler-hide:second'],
    ]);
  });

  it('does not present a superseded generation while preserving its dirty refresh', async () => {
    const { model } = createModel();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let first = true;
    let enteredFirst = false;
    model.setVisible = async () => {
      if (first) {
        first = false;
        enteredFirst = true;
        await firstGate;
      }
    };
    const requestRender = vi.fn();
    const coordinator = new RenderStateCoordinator({ model, requestRender });

    const firstCommit = coordinator.setVisibilityLayer(
      'user',
      [1],
      { urgency: 'visual', reason: 'selection:first' },
    );
    await vi.waitFor(() => expect(enteredFirst).toBe(true));
    const latestCommit = coordinator.setVisibilityLayer(
      'duplicate-effective-mask',
      [1],
      { urgency: 'visual', reason: 'selection:latest-equivalent' },
    );
    releaseFirst();
    await Promise.all([firstCommit, latestCommit]);

    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(requestRender).toHaveBeenCalledWith(2, 'selection:latest-equivalent');
  });

  it('keeps the commit pending through one ownership-scoped automatic repair', async () => {
    const { model, calls } = createModel();
    let failFirst = true;
    model.setVisible = async (ids, value) => {
      calls.push({ kind: 'visible', ids: ids?.slice(), value });
      if (failFirst) {
        failFirst = false;
        throw new Error('worker mutation failed');
      }
    };
    const requestRender = vi.fn();
    const coordinator = new RenderStateCoordinator({ model, requestRender });

    const original = coordinator.setVisibilityLayer(
      'user',
      [8],
      { urgency: 'visual', reason: 'user-isolate' },
    );
    await expect(original).resolves.toMatchObject({
      generation: 1,
      renderedGeneration: 2,
    });

    expect(calls).toEqual([
      { kind: 'visible', ids: [8], value: false },
      { kind: 'visible', ids: [8], value: true },
      { kind: 'visible', ids: [8], value: false },
    ]);
    expect(requestRender).toHaveBeenCalledWith(2, 'user-isolate:auto-repair');
    expect(coordinator.snapshot()).toMatchObject({
      appliedGeneration: 2,
      renderedGeneration: 2,
      lastError: null,
    });
  });

  it('rejects after the bounded automatic repair also fails', async () => {
    const { model } = createModel();
    model.setVisible = async () => { throw new Error('persistent worker failure'); };
    const coordinator = new RenderStateCoordinator({ model });

    await expect(coordinator.setVisibilityLayer(
      'user',
      [9],
      { urgency: 'visual', reason: 'persistent' },
    )).rejects.toThrow('persistent worker failure');
    await coordinator.whenIdle();

    expect(coordinator.snapshot()).toMatchObject({
      generation: 2,
      appliedGeneration: 0,
      renderedGeneration: 0,
    });
  });

  it('confines global resets to explicit repair boundaries', async () => {
    const { model, calls } = createModel();
    const coordinator = new RenderStateCoordinator({ model });
    await coordinator.update({
      visibility: [{ layer: 'user', hiddenIds: [1] }],
      opacity: [{ layer: 'focus', ids: [2], opacity: 0.3 }],
      highlights: [{
        layer: 'selection',
        definition: {
          layer: 'selection',
          priority: 40,
          entries: [{ styleKey: 'amber', ids: [3], material: fakeMaterial('amber') }],
        },
      }],
    }, { urgency: 'visual' });

    calls.length = 0;
    await coordinator.repair({ urgency: 'visual' });

    expect(calls.slice(0, 2)).toEqual([
      { kind: 'visible', ids: [1], value: true },
      { kind: 'reset-highlight', ids: [2, 3] },
    ]);
    expect(calls.slice(2)).toEqual([
      { kind: 'visible', ids: [1], value: false },
      { kind: 'opacity', ids: [2], value: 0.3 },
      { kind: 'highlight', ids: [3], style: 'amber' },
    ]);
  });

  it('uses visual show acknowledgement and idle hide acknowledgement for culler targets', async () => {
    const { model } = createModel();
    const reasons: string[] = [];
    const frames: Array<() => void> = [];
    const coordinator = new RenderStateCoordinator({
      model,
      raf: (callback) => { frames.push(callback); return callback; },
      cancelRaf: () => {},
      requestRender: async (_generation, reason) => { reasons.push(reason); },
    });
    const target = coordinator.createVisibilityTarget(
      'culler:element',
      { urgency: 'idle', reason: 'culler-hide:element' },
      { urgency: 'visual', reason: 'culler-show:element' },
    );

    const hidden = target.setVisible([4], false);
    expect(frames).toHaveLength(1);
    frames.shift()!();
    await hidden;

    // A show is dispatched on the visual microtask path, not held for a frame.
    await target.setVisible([4], true);
    expect(reasons).toEqual(['culler-hide:element', 'culler-show:element']);
  });

  it('waits for an in-flight worker mutation before shutdown completes', async () => {
    const { model } = createModel();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    model.setVisible = async () => gate;
    const requestRender = vi.fn();
    const coordinator = new RenderStateCoordinator({ model, requestRender });

    const commit = coordinator.setVisibilityLayer('user', [1], { urgency: 'visual' });
    const rejectedCommit = expect(commit).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    const shutdown = coordinator.shutdown();
    let shutdownComplete = false;
    void shutdown.then(() => { shutdownComplete = true; });
    await Promise.resolve();
    expect(shutdownComplete).toBe(false);

    release();
    await shutdown;
    await rejectedCommit;
    expect(requestRender).not.toHaveBeenCalled();
    expect(shutdownComplete).toBe(true);
  });

  it('keeps highlight colour and ghost opacity in one effective material slot', async () => {
    const { model, calls } = createModel();
    const coordinator = new RenderStateCoordinator({ model });
    const blue = fakeMaterial('blue');

    await coordinator.update({
      opacity: [{ layer: 'ghost', ids: [1], opacity: 0.2 }],
      highlights: [{
        layer: 'base',
        definition: {
          layer: 'base',
          priority: 10,
          entries: [{ styleKey: 'same-key', ids: [1], material: blue }],
        },
      }],
    }, { urgency: 'visual' });

    // Combined state is emitted as one full highlight; a separate setOpacity
    // would replace the colour in @thatopen/fragments' single material slot.
    expect(calls).toEqual([{ kind: 'highlight', ids: [1], style: 'blue' }]);
    calls.length = 0;

    await coordinator.setOpacityLayer('ghost', [1], 0.35, { urgency: 'visual' });
    expect(calls).toEqual([{ kind: 'highlight', ids: [1], style: 'blue' }]);
    calls.length = 0;

    await coordinator.clearHighlightLayer('base', { urgency: 'visual' });
    expect(calls).toEqual([
      { kind: 'reset-highlight', ids: [1] },
      { kind: 'opacity', ids: [1], value: 0.35 },
    ]);
  });

  it('fingerprints material values even when a caller reuses the same style key', async () => {
    const { model, calls } = createModel();
    const coordinator = new RenderStateCoordinator({ model });
    await coordinator.setHighlightLayer({
      layer: 'base',
      priority: 10,
      entries: [{ styleKey: 'reused', ids: [1], material: fakeMaterial('blue') }],
    }, { urgency: 'visual' });
    calls.length = 0;

    await coordinator.setHighlightLayer({
      layer: 'base',
      priority: 10,
      entries: [{ styleKey: 'reused', ids: [1], material: fakeMaterial('red') }],
    }, { urgency: 'visual' });

    expect(calls).toEqual([{ kind: 'highlight', ids: [1], style: 'red' }]);
  });

  it('re-emits durable appearance after a resident tile is replaced', async () => {
    const { model, calls } = createModel();
    const coordinator = new RenderStateCoordinator({ model });
    await coordinator.setHighlightLayer({
      layer: 'selection',
      priority: 40,
      entries: [{ styleKey: 'amber', ids: [1, 2], material: fakeMaterial('amber') }],
    }, { urgency: 'visual' });
    calls.length = 0;

    await coordinator.invalidateAppearance([2], {
      urgency: 'visual',
      reason: 'tile-residency-repair',
    });

    expect(calls).toEqual([{ kind: 'highlight', ids: [2], style: 'amber' }]);
    expect(coordinator.snapshot().effectiveHighlightCount).toBe(2);
  });
});
