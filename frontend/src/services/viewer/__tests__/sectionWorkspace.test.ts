import { describe, expect, it, vi } from 'vitest';

import {
  LatestSectionWorkspaceController,
  SectionWorkspaceValidationError,
  createSectionWorkspace,
  createSelectionSectionPreset,
  createStoreyCutPlanePreset,
  createStoreySectionBoxPreset,
  fromRelativeClipPlaneStates,
  normalizeSectionWorkspace,
  padSectionBounds,
  parseSectionWorkspace,
  sameSectionWorkspace,
  serializeSectionWorkspace,
  toRelativeClipPlaneStates,
  type SectionWorkspaceApplyContext,
  type SectionWorkspaceDefinition,
} from '../sectionWorkspace';

function workspace(id: string, position = 0): SectionWorkspaceDefinition {
  return createSectionWorkspace({
    id,
    name: `Workspace ${id}`,
    source: 'custom',
    planes: [{
      id: `${id}:plane`,
      enabled: true,
      axis: 'y',
      position,
      inverted: false,
    }],
    box: null,
  });
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function microtasks(turns = 8): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

describe('durable section workspace definitions', () => {
  it('normalizes, freezes, serializes, and restores absolute section state', () => {
    const definition = createSectionWorkspace({
      id: 'saved-1',
      name: 'Plant room cut',
      source: 'saved-view',
      planes: [{
        id: 'top-cut',
        label: 'Ceiling cut',
        enabled: true,
        axis: 'y',
        position: 4.2,
        inverted: false,
      }],
      box: { enabled: true, bounds: [1, 2, 3, 10, 20, 30] },
    });
    const restored = parseSectionWorkspace(serializeSectionWorkspace(definition));

    expect(restored).not.toBeNull();
    expect(sameSectionWorkspace(definition, restored)).toBe(true);
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.planes)).toBe(true);
    expect(Object.isFrozen(definition.box?.bounds)).toBe(true);
  });

  it('rejects invalid versions, duplicate plane IDs, and inverted bounds', () => {
    expect(() => normalizeSectionWorkspace({
      schemaVersion: 2,
      id: 'x',
      name: 'X',
      source: 'custom',
      planes: [],
      box: null,
    })).toThrow(SectionWorkspaceValidationError);

    expect(() => normalizeSectionWorkspace({
      schemaVersion: 1,
      id: 'x',
      name: 'X',
      source: 'custom',
      planes: [
        { id: 'same', enabled: true, axis: 'x', position: 1, inverted: false },
        { id: 'same', enabled: true, axis: 'y', position: 2, inverted: false },
      ],
      box: null,
    })).toThrow(/unique/);

    expect(() => normalizeSectionWorkspace({
      schemaVersion: 1,
      id: 'x',
      name: 'X',
      source: 'custom',
      planes: [],
      box: { enabled: true, bounds: [10, 0, 0, 1, 1, 1] },
    })).toThrow(/minimum/);
    expect(parseSectionWorkspace('{not-json')).toBeNull();
  });

  it('detects semantic changes but treats cloned definitions as equal', () => {
    const first = workspace('a', 2);
    const clone = parseSectionWorkspace(JSON.parse(JSON.stringify(first)))!;
    const changed = workspace('a', 3);

    expect(sameSectionWorkspace(first, clone)).toBe(true);
    expect(sameSectionWorkspace(first, changed)).toBe(false);
  });

  it('converts absolute saved planes to relative UI offsets and back', () => {
    const absolute = workspace('relative', 25);
    const relative = toRelativeClipPlaneStates(absolute, [10, 20, 30]);
    expect(relative).toEqual([{
      id: 'relative:plane',
      enabled: true,
      axis: 'y',
      offset: 5,
      inverted: false,
    }]);

    const restored = fromRelativeClipPlaneStates({
      id: absolute.id,
      name: absolute.name,
      planes: relative,
      modelCentre: [10, 20, 30],
    });
    expect(sameSectionWorkspace(restored, absolute)).toBe(true);
  });
});

describe('section preset helpers', () => {
  it('pads a selection proportionally without mutating its source bounds', () => {
    const source = [1, 2, 3, 3, 6, 9] as const;
    const preset = createSelectionSectionPreset({
      id: 'selection:42',
      bounds: source,
      paddingFraction: 0.1,
      minimumPadding: 0,
    });

    expect(source).toEqual([1, 2, 3, 3, 6, 9]);
    expect(preset.source).toBe('selection');
    expect(preset.box?.bounds).toEqual([0.8, 1.6, 2.4, 3.2, 6.4, 9.6]);
  });

  it('gives point/planar selections a non-degenerate minimum crop', () => {
    expect(padSectionBounds([1, 1, 1, 1, 1, 1], 0.1, 0.25)).toEqual([
      0.75, 0.75, 0.75, 1.25, 1.25, 1.25,
    ]);
  });

  it('builds a storey box from elevations while retaining the model footprint', () => {
    const preset = createStoreySectionBoxPreset({
      id: 'storey:l02',
      name: 'Level 02',
      modelBounds: [0, 0, 0, 10, 30, 10],
      lowerElevation: 10,
      upperElevation: 20,
      horizontalPaddingFraction: 0.1,
      verticalPadding: 0.5,
    });

    expect(preset.source).toBe('storey');
    expect(preset.box?.bounds).toEqual([-1, 9.5, -1, 11, 20.5, 11]);
  });

  it('supports non-Y-up storey boxes and validates elevation order', () => {
    const preset = createStoreySectionBoxPreset({
      id: 'storey:x',
      name: 'X slice',
      modelBounds: [0, 0, 0, 100, 20, 30],
      lowerElevation: 40,
      upperElevation: 50,
      verticalAxis: 'x',
      verticalPadding: 1,
    });
    expect(preset.box?.bounds).toEqual([39, 0, 0, 51, 20, 30]);
    expect(() => createStoreySectionBoxPreset({
      id: 'bad',
      name: 'Bad',
      modelBounds: [0, 0, 0, 1, 1, 1],
      lowerElevation: 2,
      upperElevation: 2,
    })).toThrow(/greater/);
  });

  it('builds below/above storey cut-plane presets with durable positions', () => {
    const below = createStoreyCutPlanePreset({
      id: 'cut:below',
      name: 'Below level',
      elevation: 12.5,
    });
    const above = createStoreyCutPlanePreset({
      id: 'cut:above',
      name: 'Above level',
      elevation: 12.5,
      keep: 'above',
    });

    expect(below.planes[0]).toMatchObject({ axis: 'y', position: 12.5, inverted: false });
    expect(above.planes[0]).toMatchObject({ axis: 'y', position: 12.5, inverted: true });
  });
});

describe('LatestSectionWorkspaceController', () => {
  it('coalesces a synchronous burst into one latest definition', async () => {
    const tasks: Array<() => void> = [];
    const apply = vi.fn();
    const controller = new LatestSectionWorkspaceController({
      apply,
      microtask: (task) => tasks.push(task),
    });

    const first = controller.setDefinition(workspace('a'));
    const second = controller.setDefinition(workspace('b'));
    const third = controller.setDefinition(workspace('c'));
    expect(tasks).toHaveLength(1);
    tasks.shift()!();

    const commits = await Promise.all([first, second, third]);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]![0].id).toBe('c');
    expect(commits.map((commit) => commit.superseded)).toEqual([true, true, false]);
    expect(commits.every((commit) => commit.appliedRevision === 3)).toBe(true);
  });

  it('never overlaps async applies and skips intermediate in-flight definitions', async () => {
    const firstGate = deferred();
    const secondGate = deferred();
    const calls: string[] = [];
    const contexts: SectionWorkspaceApplyContext[] = [];
    let active = 0;
    let maxActive = 0;
    const controller = new LatestSectionWorkspaceController({
      apply: async (definition, context) => {
        calls.push(definition.id);
        contexts.push(context);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await (calls.length === 1 ? firstGate.promise : secondGate.promise);
        active -= 1;
      },
    });

    const first = controller.setDefinition(workspace('a'));
    await microtasks();
    expect(calls).toEqual(['a']);
    const skipped = controller.setDefinition(workspace('b'));
    const latest = controller.setDefinition(workspace('c'));
    expect(contexts[0]!.isSuperseded()).toBe(true);

    firstGate.resolve();
    await microtasks();
    expect(calls).toEqual(['a', 'c']);
    expect(maxActive).toBe(1);
    secondGate.resolve();

    const commits = await Promise.all([first, skipped, latest]);
    expect(commits.map((commit) => commit.appliedRevision)).toEqual([3, 3, 3]);
    expect(controller.snapshot().applied?.id).toBe('c');
  });

  it('avoids a redundant A -> B -> A apply when the first A is still running', async () => {
    const gate = deferred();
    const apply = vi.fn(async () => gate.promise);
    const controller = new LatestSectionWorkspaceController({ apply });
    const a = workspace('a');

    const first = controller.setDefinition(a);
    await microtasks();
    const middle = controller.setDefinition(workspace('b'));
    const latest = controller.setDefinition(a);
    gate.resolve();

    const commits = await Promise.all([first, middle, latest]);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(commits.every((commit) => commit.appliedRevision === 3)).toBe(true);
    expect(controller.snapshot().applied?.id).toBe('a');
  });

  it('returns an immediate unchanged commit for an already-applied definition', async () => {
    const apply = vi.fn();
    const controller = new LatestSectionWorkspaceController({ apply });
    const definition = workspace('same');
    await controller.setDefinition(definition);

    const commit = await controller.setDefinition(definition);
    expect(commit.changed).toBe(false);
    expect(commit.superseded).toBe(false);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('rejects a latest failure and allows the same definition to retry', async () => {
    const error = new Error('clipper unavailable');
    const onError = vi.fn();
    const apply = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(undefined);
    const controller = new LatestSectionWorkspaceController({ apply, onError });
    const definition = workspace('retry');

    await expect(controller.setDefinition(definition)).rejects.toBe(error);
    expect(controller.snapshot().lastError).toBe(error);
    expect(onError).toHaveBeenCalledWith(error);

    await expect(controller.setDefinition(definition)).resolves.toMatchObject({
      appliedRevision: 2,
      changed: true,
    });
    expect(apply).toHaveBeenCalledTimes(2);
    expect(controller.snapshot().lastError).toBeNull();
  });

  it('recovers a stale failure by applying the newer desired definition', async () => {
    const gate = deferred();
    const apply = vi.fn(async (definition: SectionWorkspaceDefinition) => {
      if (definition.id === 'a') await gate.promise;
    });
    const controller = new LatestSectionWorkspaceController({ apply });

    const first = controller.setDefinition(workspace('a'));
    await microtasks();
    const latest = controller.setDefinition(workspace('b'));
    gate.reject(new Error('stale failure'));

    const commits = await Promise.all([first, latest]);
    expect(apply.mock.calls.map((call) => call[0].id)).toEqual(['a', 'b']);
    expect(commits[0].superseded).toBe(true);
    expect(controller.snapshot().applied?.id).toBe('b');
    expect(controller.snapshot().lastError).toBeNull();
  });

  it('rejects queued work on shutdown and waits for an in-flight adapter', async () => {
    const queuedTasks: Array<() => void> = [];
    const queuedApply = vi.fn();
    const queued = new LatestSectionWorkspaceController({
      apply: queuedApply,
      microtask: (task) => queuedTasks.push(task),
    });
    const queuedCommit = queued.setDefinition(workspace('queued'));
    await queued.shutdown();
    await expect(queuedCommit).rejects.toMatchObject({ name: 'AbortError' });
    queuedTasks[0]!();
    expect(queuedApply).not.toHaveBeenCalled();

    const gate = deferred();
    let context: SectionWorkspaceApplyContext | null = null;
    const running = new LatestSectionWorkspaceController({
      apply: async (_definition, applyContext) => {
        context = applyContext;
        await gate.promise;
      },
    });
    const runningCommit = running.setDefinition(workspace('running'));
    await microtasks();
    const shutdown = running.shutdown();
    expect(context!.isSuperseded()).toBe(true);
    gate.resolve();
    await shutdown;
    await expect(runningCommit).rejects.toMatchObject({ name: 'AbortError' });
    await expect(running.setDefinition(workspace('late'))).rejects.toMatchObject({ name: 'AbortError' });
  });
});

