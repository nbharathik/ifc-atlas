/**
 * Vitest for the LOD navigation swap controller.
 * State machine: show the decimated (lod) model during sustained motion, the
 * full model at rest, gated by enabled + both targets present.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LodSwapController, loadAndAttachLod } from '../lodSwap';

type Obj = { visible: boolean };

function make(): { c: LodSwapController; full: Obj; lod: Obj } {
  const full: Obj = { visible: true };
  const lod: Obj = { visible: true };
  const c = new LodSwapController();
  c.setTargets(full as never, lod as never);
  return { c, full, lod };
}

describe('LodSwapController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts with full visible, lod hidden (disabled)', () => {
    const { full, lod } = make();
    expect(full.visible).toBe(true);
    expect(lod.visible).toBe(false);
  });

  it('is not active until enabled AND both targets present', () => {
    const c = new LodSwapController();
    c.setEnabled(true);
    expect(c.active).toBe(false); // no targets
    const full: Obj = { visible: true };
    c.setTargets(full as never, null);
    expect(c.active).toBe(false); // no lod
  });

  it('shows the lod after sustained motion, full at rest', () => {
    const { c, full, lod } = make();
    c.setEnabled(true);
    c.onNavigate();
    // Before the sustain threshold nothing swaps (no flicker on clicks).
    vi.advanceTimersByTime(50);
    expect(full.visible).toBe(true);
    expect(lod.visible).toBe(false);
    // After the threshold the decimated model takes over.
    vi.advanceTimersByTime(60);
    expect(full.visible).toBe(false);
    expect(lod.visible).toBe(true);
    // Rest snaps back to full after its short delay.
    c.onRest();
    vi.advanceTimersByTime(100);
    expect(full.visible).toBe(true);
    expect(lod.visible).toBe(false);
  });

  it('a quick nav then rest before the threshold never swaps', () => {
    const { c, full, lod } = make();
    c.setEnabled(true);
    c.onNavigate();
    vi.advanceTimersByTime(30);
    c.onRest();
    vi.advanceTimersByTime(200);
    expect(full.visible).toBe(true);
    expect(lod.visible).toBe(false);
  });

  it('disabling mid-motion snaps back to full immediately', () => {
    const { c, full, lod } = make();
    c.setEnabled(true);
    c.onNavigate();
    vi.advanceTimersByTime(120);
    expect(lod.visible).toBe(true);
    c.setEnabled(false);
    expect(full.visible).toBe(true);
    expect(lod.visible).toBe(false);
  });

  it('does nothing while disabled', () => {
    const { c, full, lod } = make();
    c.onNavigate();
    vi.advanceTimersByTime(200);
    expect(full.visible).toBe(true);
    expect(lod.visible).toBe(false);
  });

  it('dispose leaves the full model visible', () => {
    const { c, full, lod } = make();
    c.setEnabled(true);
    c.onNavigate();
    vi.advanceTimersByTime(120);
    c.dispose();
    expect(full.visible).toBe(true);
    expect(lod.visible).toBe(false);
  });

  it('invalidates rendering when a delayed visibility swap occurs', () => {
    const invalidate = vi.fn();
    const full: Obj = { visible: true };
    const lod: Obj = { visible: true };
    const c = new LodSwapController(invalidate);
    c.setTargets(full as never, lod as never);
    invalidate.mockClear();
    c.setEnabled(true);
    c.onNavigate();
    vi.advanceTimersByTime(120);
    expect(invalidate).toHaveBeenCalledTimes(1);
    c.onRest();
    vi.advanceTimersByTime(100);
    expect(invalidate).toHaveBeenCalledTimes(2);
  });
});

describe('LodSwapController watchdog', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('restores the full model when nav signals stop without a rest event', () => {
    const { c, full, lod } = make();
    c.setEnabled(true);
    c.onNavigate();
    vi.advanceTimersByTime(120); // LOD showing
    expect(lod.visible).toBe(true);
    // No further onNavigate signals and NO onRest: the watchdog restores.
    vi.advanceTimersByTime(800);
    expect(full.visible).toBe(true);
    expect(lod.visible).toBe(false);
  });

  it('continuous nav signals keep the LOD showing past the hold timeout', () => {
    const { c, full, lod } = make();
    c.setEnabled(true);
    c.onNavigate();
    vi.advanceTimersByTime(120);
    expect(lod.visible).toBe(true);
    // Simulate frame-rate update signals for 2s: watchdog keeps refreshing.
    for (let i = 0; i < 40; i++) {
      c.onNavigate();
      vi.advanceTimersByTime(50);
    }
    expect(lod.visible).toBe(true);
    expect(full.visible).toBe(false);
  });
});

type LodObject = {
  visible: boolean;
  parent: LodParent | null;
};

type LodParent = {
  remove: (object: LodObject) => void;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function makeLoadHarness(signal?: AbortSignal, lodModelId?: string) {
  const lodObject: LodObject = { visible: true, parent: null };
  const worldScene = {
    add: vi.fn((object: LodObject) => {
      object.parent = worldScene;
    }),
    remove: vi.fn((object: LodObject) => {
      if (object.parent === worldScene) object.parent = null;
    }),
  };
  const setLodMode = vi.fn().mockResolvedValue(undefined);
  const useCamera = vi.fn();
  const settings = { autoCoordinate: false };
  const loadObservation: { autoCoordinate: boolean | null } = { autoCoordinate: null };
  const load = vi.fn().mockImplementation(async () => {
    loadObservation.autoCoordinate = settings.autoCoordinate;
    return { object: lodObject, setLodMode, useCamera };
  });
  const disposeModel = vi.fn().mockResolvedValue(undefined);
  const fragmentsManager = { core: { settings, load, disposeModel } };

  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    arrayBuffer: vi.fn().mockResolvedValue(Uint8Array.of(1, 2, 3).buffer),
  }));

  const result = loadAndAttachLod({
    fragmentsManager: fragmentsManager as never,
    worldScene: worldScene as never,
    fullModelId: 'full-model',
    lodModelId,
    autoCoordinate: true,
    camera: {} as never,
    fingerprint: 'fingerprint',
    profile: 'balanced',
    signal,
    allVisibleLodMode: 2,
  });

  return {
    result,
    lodObject,
    worldScene,
    settings,
    loadObservation,
    setLodMode,
    useCamera,
    load,
    disposeModel,
  };
}

describe('loadAndAttachLod resource lifecycle', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('detaches and disposes the registered model exactly once', async () => {
    const abort = new AbortController();
    const {
      result, lodObject, worldScene, settings, loadObservation, useCamera, load, disposeModel,
    } = makeLoadHarness(abort.signal);
    const attached = await result;

    expect(attached).not.toBeNull();
    expect(load).toHaveBeenCalledWith(expect.any(Uint8Array), {
      modelId: 'full-model__lod',
    });
    expect(loadObservation.autoCoordinate).toBe(true);
    expect(settings.autoCoordinate).toBe(false);
    expect(useCamera).toHaveBeenCalledOnce();
    expect(lodObject.parent).toBe(worldScene);

    attached!.dispose();
    attached!.dispose();
    abort.abort();

    expect(lodObject.parent).toBeNull();
    expect(worldScene.remove).toHaveBeenCalledTimes(1);
    expect(disposeModel).toHaveBeenCalledTimes(1);
    expect(disposeModel).toHaveBeenCalledWith('full-model__lod');
  });

  it('aborting an attached LOD removes and disposes it exactly once', async () => {
    const abort = new AbortController();
    const { result, lodObject, worldScene, disposeModel } = makeLoadHarness(abort.signal);
    const attached = await result;

    expect(attached).not.toBeNull();
    abort.abort();
    attached!.dispose();

    expect(lodObject.parent).toBeNull();
    expect(worldScene.remove).toHaveBeenCalledTimes(1);
    expect(disposeModel).toHaveBeenCalledTimes(1);
  });

  it('uses a caller-provided generation id so stale cleanup cannot hit a replacement', async () => {
    const { result, load, disposeModel } = makeLoadHarness(undefined, 'full-model__lod_7');
    const attached = await result;

    expect(load).toHaveBeenCalledWith(expect.any(Uint8Array), {
      modelId: 'full-model__lod_7',
    });
    attached!.dispose();
    expect(disposeModel).toHaveBeenCalledWith('full-model__lod_7');
  });

  it('serializes overlapping loads while applying the manager-wide coordinate policy', async () => {
    const settings = { autoCoordinate: false };
    const firstLoad = deferred<{ object: LodObject }>();
    const secondLoad = deferred<{ object: LodObject }>();
    const observations: boolean[] = [];
    const load = vi.fn().mockImplementation(() => {
      observations.push(settings.autoCoordinate);
      return load.mock.calls.length === 1 ? firstLoad.promise : secondLoad.promise;
    });
    const disposeModel = vi.fn().mockResolvedValue(undefined);
    const fragmentsManager = { core: { settings, load, disposeModel } };
    const worldScene = {
      add: vi.fn((object: LodObject) => { object.parent = worldScene; }),
      remove: vi.fn((object: LodObject) => {
        if (object.parent === worldScene) object.parent = null;
      }),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: vi.fn().mockResolvedValue(Uint8Array.of(1).buffer),
    }));
    const invoke = (lodModelId: string, autoCoordinate: boolean) => loadAndAttachLod({
      fragmentsManager: fragmentsManager as never,
      worldScene: worldScene as never,
      fullModelId: 'full-model',
      lodModelId,
      autoCoordinate,
      fingerprint: 'fingerprint',
      profile: 'balanced',
    });

    const firstResult = invoke('full-model__lod_1', true);
    const secondResult = invoke('full-model__lod_2', false);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    expect(observations).toEqual([true]);

    const firstObject: LodObject = { visible: true, parent: null };
    firstLoad.resolve({ object: firstObject });
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(observations).toEqual([true, false]);

    const secondObject: LodObject = { visible: true, parent: null };
    secondLoad.resolve({ object: secondObject });
    const [firstAttached, secondAttached] = await Promise.all([firstResult, secondResult]);
    expect(settings.autoCoordinate).toBe(false);
    expect(firstAttached).not.toBeNull();
    expect(secondAttached).not.toBeNull();

    firstAttached!.dispose();
    secondAttached!.dispose();
    expect(disposeModel).toHaveBeenCalledTimes(2);
  });

  it('releases an aborted queue waiter without letting later loads bypass its predecessor', async () => {
    const settings = { autoCoordinate: false };
    const firstLoad = deferred<{ object: LodObject }>();
    const thirdLoad = deferred<{ object: LodObject }>();
    const load = vi.fn().mockImplementation(() => (
      load.mock.calls.length === 1 ? firstLoad.promise : thirdLoad.promise
    ));
    const disposeModel = vi.fn().mockResolvedValue(undefined);
    const fragmentsManager = { core: { settings, load, disposeModel } };
    const worldScene = {
      add: vi.fn((object: LodObject) => { object.parent = worldScene; }),
      remove: vi.fn((object: LodObject) => {
        if (object.parent === worldScene) object.parent = null;
      }),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: vi.fn().mockResolvedValue(Uint8Array.of(1).buffer),
    }));
    const invoke = (lodModelId: string, signal?: AbortSignal) => loadAndAttachLod({
      fragmentsManager: fragmentsManager as never,
      worldScene: worldScene as never,
      fullModelId: 'full-model',
      lodModelId,
      autoCoordinate: true,
      fingerprint: 'fingerprint',
      profile: 'balanced',
      signal,
    });

    const firstResult = invoke('full-model__lod_1');
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));

    const secondAbort = new AbortController();
    const addAbortListener = vi.spyOn(secondAbort.signal, 'addEventListener');
    const secondResult = invoke('full-model__lod_2', secondAbort.signal);
    await vi.waitFor(() => {
      expect(addAbortListener).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
    });
    secondAbort.abort();
    await expect(secondResult).resolves.toBeNull();
    expect(load).toHaveBeenCalledTimes(1);

    const thirdResult = invoke('full-model__lod_3');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(load).toHaveBeenCalledTimes(1);

    const firstObject: LodObject = { visible: true, parent: null };
    firstLoad.resolve({ object: firstObject });
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    const thirdObject: LodObject = { visible: true, parent: null };
    thirdLoad.resolve({ object: thirdObject });

    const [firstAttached, thirdAttached] = await Promise.all([firstResult, thirdResult]);
    expect(firstAttached).not.toBeNull();
    expect(thirdAttached).not.toBeNull();
    expect(settings.autoCoordinate).toBe(false);
    firstAttached!.dispose();
    thirdAttached!.dispose();
  });
});
