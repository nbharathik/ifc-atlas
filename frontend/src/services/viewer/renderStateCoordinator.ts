import type { MaterialDefinition } from '@thatopen/fragments';

/**
 * The fragment worker exposes imperative, asynchronous appearance methods.
 * Calling those methods from independent React effects makes completion order
 * part of the visible result.  RenderStateCoordinator turns those writes into
 * one model-scoped desired state and is the only normal-path writer to the
 * fragment model.
 *
 * The coordinator deliberately keeps semantic owners separate:
 *
 * - visibility is the union of named hidden masks;
 * - opacity is the lowest requested opacity across named layers;
 * - highlight material is selected by layer priority, then layer insertion
 *   order, with later entries inside a layer winning.
 *
 * A subsystem can therefore release its own state without undoing another
 * subsystem.  Geometry stays mounted; reconciliation only changes render
 * state for IDs whose effective value changed.
 */

export type RenderStateUrgency = 'visual' | 'frame' | 'idle';

export interface FragmentRenderStateModel {
  setVisible(localIds: number[] | undefined, visible: boolean): Promise<void>;
  resetVisible?: () => Promise<void>;
  setOpacity(localIds: number[] | undefined, opacity: number): Promise<void>;
  resetOpacity(localIds: number[] | undefined): Promise<void>;
  highlight(localIds: number[] | undefined, material: MaterialDefinition): Promise<void>;
  resetHighlight(localIds?: number[]): Promise<void>;
}

export interface HighlightLayerEntry {
  /** Stable visual identity. Change this key whenever the material changes. */
  readonly styleKey: string;
  readonly ids: Iterable<number>;
  readonly material: MaterialDefinition;
}

export interface HighlightLayerDefinition {
  readonly layer: string;
  readonly priority: number;
  readonly entries: readonly HighlightLayerEntry[];
}

export interface VisibilityLayerPatch {
  readonly layer: string;
  /** Empty/null removes the layer. */
  readonly hiddenIds: Iterable<number> | null;
}

export interface OpacityLayerPatch {
  readonly layer: string;
  /** Empty/null removes the layer. */
  readonly ids: Iterable<number> | null;
  readonly opacity: number;
}

export interface HighlightLayerPatch {
  readonly layer: string;
  /** Empty/null removes the layer. */
  readonly definition: HighlightLayerDefinition | null;
}

export interface RenderStatePatch {
  readonly visibility?: readonly VisibilityLayerPatch[];
  readonly opacity?: readonly OpacityLayerPatch[];
  readonly highlights?: readonly HighlightLayerPatch[];
}

export interface RenderStateUpdateOptions {
  readonly urgency?: RenderStateUrgency;
  readonly reason?: string;
}

export interface RenderStateCommit {
  readonly generation: number;
  readonly appliedGeneration: number;
  readonly renderedGeneration: number;
  readonly changed: boolean;
}

export interface RenderStateSnapshot {
  readonly generation: number;
  readonly appliedGeneration: number;
  readonly renderedGeneration: number;
  readonly inFlight: boolean;
  readonly scheduled: boolean;
  readonly visibilityLayers: Readonly<Record<string, number>>;
  readonly opacityLayers: Readonly<Record<string, { count: number; opacity: number }>>;
  readonly highlightLayers: Readonly<Record<string, { count: number; priority: number }>>;
  readonly effectiveHiddenCount: number;
  readonly effectiveOpacityCount: number;
  readonly effectiveHighlightCount: number;
  readonly lastReason: string | null;
  readonly lastError: unknown | null;
}

export interface RenderStateCoordinatorOptions {
  readonly model: FragmentRenderStateModel;
  /**
   * Must resolve after the fragment refresh containing the mutations has
   * completed.  This is the rendered-generation acknowledgement boundary.
   */
  readonly requestRender?: (generation: number, reason: string) => Promise<void> | void;
  readonly raf?: (callback: () => void) => unknown;
  readonly cancelRaf?: (handle: unknown) => void;
  readonly microtask?: (callback: () => void) => void;
  readonly onError?: (error: unknown) => void;
}

export interface VisibilityMutationTarget {
  setVisible(localIds: number[] | undefined, visible: boolean): Promise<void>;
  /** Apply both sides as one desired-state generation. */
  applyVisibilityDelta?: (
    toHide: readonly number[],
    toShow: readonly number[],
  ) => Promise<void>;
  /** Release every ID owned by this target. */
  clearVisibility?: () => Promise<void>;
}

type StoredOpacityLayer = {
  ids: Set<number>;
  opacity: number;
};

type StoredHighlightEntry = {
  styleKey: string;
  ids: Set<number>;
  material: MaterialDefinition;
};

type StoredHighlightLayer = {
  priority: number;
  order: number;
  entries: StoredHighlightEntry[];
};

type EffectiveHighlight = {
  styleKey: string;
  material: MaterialDefinition;
};

type EffectiveAppearance =
  | {
      kind: 'opacity';
      fingerprint: string;
      opacity: number;
    }
  | {
      kind: 'highlight';
      fingerprint: string;
      material: MaterialDefinition;
    };

type DesiredState = {
  hidden: Set<number>;
  opacity: Map<number, number>;
  highlights: Map<number, EffectiveHighlight>;
};

type Waiter = {
  generation: number;
  resolve: (commit: RenderStateCommit) => void;
  reject: (error: unknown) => void;
};

const urgencyRank: Record<RenderStateUrgency, number> = {
  idle: 0,
  frame: 1,
  visual: 2,
};

function toIdSet(values: Iterable<number> | null): Set<number> {
  const result = new Set<number>();
  if (!values) return result;
  for (const value of values) {
    if (Number.isInteger(value) && value >= 0) result.add(value);
  }
  return result;
}

function sameSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function clampOpacity(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value));
}

function defaultRaf(callback: () => void): unknown {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
  return setTimeout(callback, 0);
}

function defaultCancelRaf(handle: unknown): void {
  if (typeof cancelAnimationFrame === 'function' && typeof handle === 'number') {
    cancelAnimationFrame(handle);
    return;
  }
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export class RenderStateCoordinator {
  private readonly model: FragmentRenderStateModel;
  private readonly requestRender?: RenderStateCoordinatorOptions['requestRender'];
  private readonly raf: NonNullable<RenderStateCoordinatorOptions['raf']>;
  private readonly cancelRaf: NonNullable<RenderStateCoordinatorOptions['cancelRaf']>;
  private readonly microtask: NonNullable<RenderStateCoordinatorOptions['microtask']>;
  private readonly onError?: RenderStateCoordinatorOptions['onError'];

  private readonly visibilityLayers = new Map<string, Set<number>>();
  private readonly opacityLayers = new Map<string, StoredOpacityLayer>();
  private readonly highlightLayers = new Map<string, StoredHighlightLayer>();
  private highlightLayerOrder = 0;

  private appliedHidden = new Set<number>();
  private appliedAppearance = new Map<number, EffectiveAppearance>();
  /** IDs ever touched by this coordinator, including partially failed runs. */
  private readonly ownedVisibilityIds = new Set<number>();
  private readonly ownedAppearanceIds = new Set<number>();

  private generation = 0;
  private appliedGeneration = 0;
  private renderedGeneration = 0;
  private waiters: Waiter[] = [];
  private idleWaiters: Array<() => void> = [];
  private inFlight = false;
  private rerun = false;
  private disposed = false;
  private forceRepair = false;
  private frameHandle: unknown | null = null;
  private microtaskPending = false;
  private scheduledUrgency: RenderStateUrgency = 'idle';
  private lastReason: string | null = null;
  private lastError: unknown | null = null;

  constructor(options: RenderStateCoordinatorOptions) {
    this.model = options.model;
    this.requestRender = options.requestRender;
    this.raf = options.raf ?? defaultRaf;
    this.cancelRaf = options.cancelRaf ?? defaultCancelRaf;
    this.microtask = options.microtask ?? ((callback) => queueMicrotask(callback));
    this.onError = options.onError;
  }

  update(
    patch: RenderStatePatch,
    options: RenderStateUpdateOptions = {},
  ): Promise<RenderStateCommit> {
    if (this.disposed) return Promise.reject(abortError('RenderStateCoordinator is disposed'));

    let changed = false;
    for (const next of patch.visibility ?? []) {
      const ids = toIdSet(next.hiddenIds);
      const previous = this.visibilityLayers.get(next.layer);
      if (ids.size === 0) {
        if (previous) {
          this.visibilityLayers.delete(next.layer);
          changed = true;
        }
      } else if (!previous || !sameSet(previous, ids)) {
        this.visibilityLayers.set(next.layer, ids);
        changed = true;
      }
    }

    for (const next of patch.opacity ?? []) {
      const ids = toIdSet(next.ids);
      const opacity = clampOpacity(next.opacity);
      const previous = this.opacityLayers.get(next.layer);
      if (ids.size === 0 || opacity >= 1) {
        if (previous) {
          this.opacityLayers.delete(next.layer);
          changed = true;
        }
      } else if (!previous || previous.opacity !== opacity || !sameSet(previous.ids, ids)) {
        this.opacityLayers.set(next.layer, { ids, opacity });
        changed = true;
      }
    }

    for (const next of patch.highlights ?? []) {
      const normalized = next.definition
        ? this.normalizeHighlightLayer(next.definition, next.layer)
        : null;
      const previous = this.highlightLayers.get(next.layer);
      if (!normalized || normalized.entries.length === 0) {
        if (previous) {
          this.highlightLayers.delete(next.layer);
          changed = true;
        }
      } else if (!previous || !this.sameHighlightLayer(previous, normalized)) {
        this.highlightLayers.set(next.layer, normalized);
        changed = true;
      }
    }

    if (!changed) {
      // A previous worker failure deliberately invalidates the applied caches.
      // Repeating the same semantic intent must trigger that pending repair,
      // otherwise the caller would wait forever on an unscheduled generation.
      if (this.forceRepair) {
        this.generation += 1;
        this.lastReason = options.reason ?? 'render-state-retry';
        const promise = this.waitForGeneration(this.generation, true);
        this.schedule(options.urgency ?? 'visual');
        return promise;
      }
      return this.waitForGeneration(this.generation, false);
    }

    this.generation += 1;
    this.lastReason = options.reason ?? 'render-state';
    const generation = this.generation;
    const promise = this.waitForGeneration(generation, true);
    this.schedule(options.urgency ?? 'frame');
    return promise;
  }

  setVisibilityLayer(
    layer: string,
    hiddenIds: Iterable<number> | null,
    options?: RenderStateUpdateOptions,
  ): Promise<RenderStateCommit> {
    return this.update({ visibility: [{ layer, hiddenIds }] }, options);
  }

  setOpacityLayer(
    layer: string,
    ids: Iterable<number> | null,
    opacity: number,
    options?: RenderStateUpdateOptions,
  ): Promise<RenderStateCommit> {
    return this.update({ opacity: [{ layer, ids, opacity }] }, options);
  }

  setHighlightLayer(
    definition: HighlightLayerDefinition | null,
    options?: RenderStateUpdateOptions,
  ): Promise<RenderStateCommit> {
    if (!definition) {
      return Promise.reject(new Error('A layer name is required when clearing a highlight layer'));
    }
    return this.update({
      highlights: [{ layer: definition.layer, definition }],
    }, options);
  }

  clearHighlightLayer(
    layer: string,
    options?: RenderStateUpdateOptions,
  ): Promise<RenderStateCommit> {
    return this.update({ highlights: [{ layer, definition: null }] }, options);
  }

  /**
   * Invalidate applied-state caches after an unavoidable external mutation or
   * context recovery.  Full resets are intentionally confined to this repair
   * boundary and never used for ordinary selection/filter/navigation changes.
   */
  repair(options: RenderStateUpdateOptions = {}): Promise<RenderStateCommit> {
    if (this.disposed) return Promise.reject(abortError('RenderStateCoordinator is disposed'));
    this.forceRepair = true;
    this.generation += 1;
    this.lastReason = options.reason ?? 'render-state-repair';
    const promise = this.waitForGeneration(this.generation, true);
    this.schedule(options.urgency ?? 'visual');
    return promise;
  }

  /**
   * Re-emit desired appearance after a tile/residency replacement without
   * resetting semantic layers. This is cheaper and safer than full repair.
   */
  invalidateAppearance(
    localIds?: Iterable<number>,
    options: RenderStateUpdateOptions = {},
  ): Promise<RenderStateCommit> {
    if (this.disposed) return Promise.reject(abortError('RenderStateCoordinator is disposed'));
    if (localIds) {
      for (const id of localIds) this.appliedAppearance.delete(id);
    } else {
      this.appliedAppearance.clear();
    }
    this.generation += 1;
    this.lastReason = options.reason ?? 'appearance:invalidate';
    const promise = this.waitForGeneration(this.generation, true);
    this.schedule(options.urgency ?? 'visual');
    return promise;
  }

  createVisibilityTarget(
    layer: string,
    hideOptions: RenderStateUpdateOptions = {},
    showOptions: RenderStateUpdateOptions = {
      urgency: 'visual',
      reason: `${layer}:show`,
    },
  ): VisibilityMutationTarget {
    const commit = (next: Set<number>, options: RenderStateUpdateOptions) => (
      this.setVisibilityLayer(layer, next, options).then(() => undefined)
    );
    return {
      setVisible: async (localIds, visible) => {
        if (!localIds || localIds.length === 0) return;
        const next = new Set(this.visibilityLayers.get(layer) ?? []);
        for (const id of localIds) {
          if (visible) next.delete(id);
          else next.add(id);
        }
        await commit(next, visible ? showOptions : hideOptions);
      },
      applyVisibilityDelta: async (toHide, toShow) => {
        const next = new Set(this.visibilityLayers.get(layer) ?? []);
        for (const id of toShow) next.delete(id);
        for (const id of toHide) next.add(id);
        await commit(next, toShow.length > 0 ? showOptions : hideOptions);
      },
      clearVisibility: async () => {
        await commit(new Set(), showOptions);
      },
    };
  }

  snapshot(): RenderStateSnapshot {
    const visibilityLayers: Record<string, number> = {};
    const opacityLayers: Record<string, { count: number; opacity: number }> = {};
    const highlightLayers: Record<string, { count: number; priority: number }> = {};
    for (const [name, ids] of this.visibilityLayers) visibilityLayers[name] = ids.size;
    for (const [name, layer] of this.opacityLayers) {
      opacityLayers[name] = { count: layer.ids.size, opacity: layer.opacity };
    }
    for (const [name, layer] of this.highlightLayers) {
      let count = 0;
      for (const entry of layer.entries) count += entry.ids.size;
      highlightLayers[name] = { count, priority: layer.priority };
    }
    return {
      generation: this.generation,
      appliedGeneration: this.appliedGeneration,
      renderedGeneration: this.renderedGeneration,
      inFlight: this.inFlight,
      scheduled: this.frameHandle !== null || this.microtaskPending,
      visibilityLayers,
      opacityLayers,
      highlightLayers,
      effectiveHiddenCount: this.appliedHidden.size,
      effectiveOpacityCount: [...this.appliedAppearance.values()]
        .filter((appearance) => (
          appearance.kind === 'opacity' || appearance.material.opacity < 1
        )).length,
      effectiveHighlightCount: [...this.appliedAppearance.values()]
        .filter((appearance) => appearance.kind === 'highlight').length,
      lastReason: this.lastReason,
      lastError: this.lastError,
    };
  }

  whenIdle(): Promise<void> {
    if (!this.inFlight) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  async shutdown(): Promise<void> {
    this.dispose();
    await this.whenIdle();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frameHandle !== null) {
      this.cancelRaf(this.frameHandle);
      this.frameHandle = null;
    }
    const error = abortError('RenderStateCoordinator disposed before the generation rendered');
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters = [];
    this.visibilityLayers.clear();
    this.opacityLayers.clear();
    this.highlightLayers.clear();
    if (!this.inFlight) this.resolveIdleWaiters();
  }

  private normalizeHighlightLayer(
    definition: HighlightLayerDefinition,
    layerName: string,
  ): StoredHighlightLayer {
    const previous = this.highlightLayers.get(layerName);
    const entries: StoredHighlightEntry[] = [];
    for (const entry of definition.entries) {
      const ids = toIdSet(entry.ids);
      if (ids.size === 0) continue;
      entries.push({
        styleKey: entry.styleKey,
        ids,
        material: entry.material,
      });
    }
    return {
      priority: definition.priority,
      order: previous?.order ?? this.highlightLayerOrder++,
      entries,
    };
  }

  private sameHighlightLayer(a: StoredHighlightLayer, b: StoredHighlightLayer): boolean {
    if (a.priority !== b.priority || a.entries.length !== b.entries.length) return false;
    for (let index = 0; index < a.entries.length; index += 1) {
      const left = a.entries[index];
      const right = b.entries[index];
      if (
        left.styleKey !== right.styleKey
        || this.materialFingerprint(left.material) !== this.materialFingerprint(right.material)
        || !sameSet(left.ids, right.ids)
      ) return false;
    }
    return true;
  }

  private waitForGeneration(generation: number, changed: boolean): Promise<RenderStateCommit> {
    if (this.renderedGeneration >= generation && !this.forceRepair) {
      return Promise.resolve({
        generation,
        appliedGeneration: this.appliedGeneration,
        renderedGeneration: this.renderedGeneration,
        changed,
      });
    }
    return new Promise<RenderStateCommit>((resolve, reject) => {
      this.waiters.push({ generation, resolve: (commit) => resolve({ ...commit, changed }), reject });
    });
  }

  private schedule(urgency: RenderStateUrgency): void {
    if (this.disposed) return;
    if (this.inFlight) {
      this.rerun = true;
      if (urgencyRank[urgency] > urgencyRank[this.scheduledUrgency]) {
        this.scheduledUrgency = urgency;
      }
      return;
    }

    if (urgencyRank[urgency] > urgencyRank[this.scheduledUrgency]) {
      this.scheduledUrgency = urgency;
    }
    if (urgency === 'visual') {
      if (this.frameHandle !== null) {
        this.cancelRaf(this.frameHandle);
        this.frameHandle = null;
      }
      if (this.microtaskPending) return;
      this.microtaskPending = true;
      this.microtask(() => {
        this.microtaskPending = false;
        void this.drain();
      });
      return;
    }
    if (this.frameHandle !== null || this.microtaskPending) return;
    this.frameHandle = this.raf(() => {
      this.frameHandle = null;
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.disposed || this.inFlight) return;
    this.inFlight = true;
    let automaticRepairAttempted = false;
    let renderDirty = false;
    try {
      do {
        this.rerun = false;
        this.scheduledUrgency = 'idle';
        const targetGeneration = this.generation;
        // The public reason is mutable desired-state metadata. Capture it with
        // the generation before any worker await so a newer culler/selection
        // update cannot relabel this render acknowledgement mid-flight.
        const targetReason = this.lastReason ?? 'render-state';
        const desired = this.computeDesiredState();
        const repairing = this.forceRepair;
        this.forceRepair = false;
        let changed = false;
        try {
          if (repairing) {
            await this.resetAppliedState();
            changed = true;
          }
          if (this.disposed) break;
          changed = (await this.reconcileVisibility(desired.hidden)) || changed;
          if (this.disposed) break;
          changed = (await this.reconcileAppearance(desired.opacity, desired.highlights)) || changed;
          if (this.disposed) break;
          this.appliedGeneration = Math.max(this.appliedGeneration, targetGeneration);
          renderDirty = renderDirty || changed;
          // If newer semantic state arrived while worker RPCs were pending,
          // converge it before presenting. Keep renderDirty so an equivalent
          // final diff still refreshes the unpainted worker mutations.
          if (this.generation > targetGeneration) {
            this.rerun = true;
            continue;
          }
          if (renderDirty && this.requestRender && !this.disposed) {
            await this.requestRender(targetGeneration, targetReason);
          }
          renderDirty = false;
          this.renderedGeneration = Math.max(this.renderedGeneration, targetGeneration);
          this.lastError = null;
          automaticRepairAttempted = false;
          this.resolveWaiters();
        } catch (error) {
          // A mutation may have partially reached the worker.  Forget all
          // applied caches so the next explicit update/repair starts from a
          // known baseline instead of diffing against a guess.
          this.forceRepair = true;
          this.lastError = error;
          try { this.onError?.(error); } catch { /* diagnostics are non-fatal */ }
          if (this.generation <= targetGeneration) {
            // A partial worker mutation must not remain indefinitely merely
            // because the original caller handled/rejected its Promise. Queue
            // one bounded ownership-scoped repair generation automatically;
            // another persistent failure waits for an explicit future update.
            if (!automaticRepairAttempted) {
              automaticRepairAttempted = true;
              this.generation = targetGeneration + 1;
              this.lastReason = `${targetReason}:auto-repair`;
              this.rerun = true;
            } else {
              this.rejectWaitersThrough(targetGeneration, error);
              break;
            }
          }
        }
      } while (!this.disposed && (this.rerun || this.appliedGeneration < this.generation));
    } finally {
      this.inFlight = false;
      this.resolveIdleWaiters();
      if (!this.disposed && this.appliedGeneration < this.generation && !this.forceRepair) {
        this.schedule(this.scheduledUrgency);
      }
    }
  }

  private computeDesiredState(): DesiredState {
    const hidden = new Set<number>();
    for (const layer of this.visibilityLayers.values()) {
      for (const id of layer) hidden.add(id);
    }

    const opacity = new Map<number, number>();
    for (const layer of this.opacityLayers.values()) {
      for (const id of layer.ids) {
        const current = opacity.get(id);
        if (current === undefined || layer.opacity < current) opacity.set(id, layer.opacity);
      }
    }

    const highlights = new Map<number, EffectiveHighlight>();
    const sortedLayers = [...this.highlightLayers.values()]
      .sort((a, b) => a.priority - b.priority || a.order - b.order);
    for (const layer of sortedLayers) {
      for (const entry of layer.entries) {
        for (const id of entry.ids) {
          highlights.set(id, { styleKey: entry.styleKey, material: entry.material });
        }
      }
    }
    return { hidden, opacity, highlights };
  }

  private async resetAppliedState(): Promise<void> {
    // Repair only IDs this coordinator has owned. A model-wide resetVisible
    // can expose source items intentionally hidden by beta edit-delta models.
    if (this.ownedVisibilityIds.size > 0) {
      await this.model.setVisible([...this.ownedVisibilityIds], true);
    }
    if (this.ownedAppearanceIds.size > 0) {
      await this.model.resetHighlight([...this.ownedAppearanceIds]);
    }
    this.appliedHidden = new Set();
    this.appliedAppearance = new Map();
  }

  private async reconcileVisibility(next: Set<number>): Promise<boolean> {
    if (this.disposed) return false;
    const toHide: number[] = [];
    const toShow: number[] = [];
    for (const id of next) if (!this.appliedHidden.has(id)) toHide.push(id);
    for (const id of this.appliedHidden) if (!next.has(id)) toShow.push(id);
    for (const id of toHide) this.ownedVisibilityIds.add(id);
    for (const id of toShow) this.ownedVisibilityIds.add(id);
    if (toShow.length > 0) await this.model.setVisible(toShow, true);
    if (this.disposed) return toShow.length > 0;
    // Reveal the incoming set before hiding the outgoing set. The worker RPCs
    // are individually acknowledged, so hide-first can produce a real blank
    // frame when switching between disjoint isolate/filter results.
    if (toHide.length > 0) await this.model.setVisible(toHide, false);
    this.appliedHidden = new Set(next);
    return toHide.length > 0 || toShow.length > 0;
  }

  private async reconcileAppearance(
    opacity: Map<number, number>,
    highlights: Map<number, EffectiveHighlight>,
  ): Promise<boolean> {
    if (this.disposed) return false;
    const next = this.composeAppearance(opacity, highlights);
    const toReset: number[] = [];
    const opacityGroups = new Map<number, number[]>();
    const highlightGroups = new Map<string, { material: MaterialDefinition; ids: number[] }>();
    for (const id of this.appliedAppearance.keys()) {
      if (!next.has(id)) toReset.push(id);
    }
    for (const [id, effective] of next) {
      const previous = this.appliedAppearance.get(id);
      if (previous?.fingerprint === effective.fingerprint) continue;
      // Fragments stores opacity and colour in one highlight slot. Moving
      // from a full highlight to opacity-only must clear the old colour first.
      if (previous?.kind === 'highlight' && effective.kind === 'opacity') {
        toReset.push(id);
      }
      if (effective.kind === 'opacity') {
        const group = opacityGroups.get(effective.opacity);
        if (group) group.push(id);
        else opacityGroups.set(effective.opacity, [id]);
      } else {
        const group = highlightGroups.get(effective.fingerprint);
        if (group) group.ids.push(id);
        else highlightGroups.set(effective.fingerprint, {
          material: effective.material,
          ids: [id],
        });
      }
    }
    for (const id of toReset) this.ownedAppearanceIds.add(id);
    for (const ids of opacityGroups.values()) for (const id of ids) this.ownedAppearanceIds.add(id);
    for (const group of highlightGroups.values()) {
      for (const id of group.ids) this.ownedAppearanceIds.add(id);
    }
    if (toReset.length > 0) await this.model.resetHighlight(toReset);
    for (const [value, ids] of opacityGroups) {
      if (this.disposed) break;
      await this.model.setOpacity(ids, value);
    }
    for (const group of highlightGroups.values()) {
      if (this.disposed) break;
      await this.model.highlight(group.ids, group.material);
    }
    this.appliedAppearance = new Map(next);
    return toReset.length > 0 || opacityGroups.size > 0 || highlightGroups.size > 0;
  }

  private composeAppearance(
    opacity: Map<number, number>,
    highlights: Map<number, EffectiveHighlight>,
  ): Map<number, EffectiveAppearance> {
    const result = new Map<number, EffectiveAppearance>();
    const ids = new Set<number>([...opacity.keys(), ...highlights.keys()]);
    for (const id of ids) {
      const highlight = highlights.get(id);
      const requestedOpacity = opacity.get(id);
      if (!highlight) {
        if (requestedOpacity !== undefined) {
          result.set(id, {
            kind: 'opacity',
            opacity: requestedOpacity,
            fingerprint: `opacity:${requestedOpacity}`,
          });
        }
        continue;
      }
      const material = this.composeHighlightMaterial(highlight.material, requestedOpacity);
      result.set(id, {
        kind: 'highlight',
        material,
        fingerprint: this.materialFingerprint(material),
      });
    }
    return result;
  }

  private composeHighlightMaterial(
    source: MaterialDefinition,
    requestedOpacity: number | undefined,
  ): MaterialDefinition {
    const opacity = Math.min(clampOpacity(source.opacity), requestedOpacity ?? 1);
    const material = {
      ...source,
      opacity,
      transparent: source.transparent || opacity < 1,
      preserveOriginalMaterial: false,
    } as MaterialDefinition & { _explicitProps?: string[] };
    // @thatopen/fragments merges highlight definitions. Mark every visual
    // field explicit so an earlier opacity-only slot cannot leak into this
    // complete material and a later opacity change cannot erase its colour.
    material._explicitProps = [
      'color',
      'renderedFaces',
      'opacity',
      'transparent',
      'depthTest',
      'depthWrite',
    ];
    return material;
  }

  private materialFingerprint(material: MaterialDefinition): string {
    const color = material.color;
    const colorKey = typeof (color as { getHexString?: () => string }).getHexString === 'function'
      ? (color as { getHexString: () => string }).getHexString()
      : `${color.r.toFixed(6)},${color.g.toFixed(6)},${color.b.toFixed(6)}`;
    const extended = material as MaterialDefinition & {
      depthWrite?: boolean;
      depthTest?: boolean;
    };
    return [
      colorKey,
      material.opacity,
      material.transparent ? 1 : 0,
      material.renderedFaces,
      extended.depthTest ?? 'default',
      extended.depthWrite ?? 'default',
      material.customId ?? '',
    ].join('|');
  }

  private resolveWaiters(): void {
    const remaining: Waiter[] = [];
    for (const waiter of this.waiters) {
      if (waiter.generation <= this.renderedGeneration) {
        waiter.resolve({
          generation: waiter.generation,
          appliedGeneration: this.appliedGeneration,
          renderedGeneration: this.renderedGeneration,
          changed: true,
        });
      } else {
        remaining.push(waiter);
      }
    }
    this.waiters = remaining;
  }

  private rejectWaitersThrough(generation: number, error: unknown): void {
    const remaining: Waiter[] = [];
    for (const waiter of this.waiters) {
      if (waiter.generation <= generation) waiter.reject(error);
      else remaining.push(waiter);
    }
    this.waiters = remaining;
  }

  private resolveIdleWaiters(): void {
    if (this.inFlight || this.idleWaiters.length === 0) return;
    const waiters = this.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}
