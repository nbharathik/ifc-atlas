/**
 * Durable section workspace definitions and a latest-state application queue.
 *
 * The existing clip-plane UI stores offsets relative to the current model
 * centre, while a saved view needs portable world-space definitions and a
 * durable section-box bound. This module provides that persisted contract,
 * pure preset builders, and a renderer-agnostic controller that serializes
 * async section mutations while discarding intermediate desired states.
 *
 * It deliberately has no Zustand, THREE, OBC, or ViewerPanel dependency.
 */

export type SectionAxis = 'x' | 'y' | 'z';

export type SectionBounds = readonly [
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
];

export type SectionPoint = readonly [x: number, y: number, z: number];

export type SectionWorkspaceSource = 'custom' | 'selection' | 'storey' | 'saved-view';

export interface SectionPlaneDefinition {
  readonly id: string;
  readonly label?: string;
  readonly enabled: boolean;
  readonly axis: SectionAxis;
  /** Absolute world-space coordinate along `axis`. */
  readonly position: number;
  /** False keeps the negative side; true keeps the positive side. */
  readonly inverted: boolean;
}

export interface SectionBoxDefinition {
  readonly enabled: boolean;
  readonly bounds: SectionBounds;
}

export interface SectionWorkspaceDefinition {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly source: SectionWorkspaceSource;
  readonly planes: readonly SectionPlaneDefinition[];
  readonly box: SectionBoxDefinition | null;
}

export interface RelativeClipPlaneState {
  readonly id: string;
  readonly enabled: boolean;
  readonly axis: SectionAxis;
  readonly offset: number;
  readonly inverted: boolean;
}

export class SectionWorkspaceValidationError extends Error {
  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'SectionWorkspaceValidationError';
  }
}

export interface SelectionSectionPresetInput {
  readonly id: string;
  readonly name?: string;
  readonly bounds: SectionBounds;
  /** Per-face padding as a fraction of each axis extent. Default 0.05. */
  readonly paddingFraction?: number;
  /** Minimum per-face world-space padding, including degenerate selections. */
  readonly minimumPadding?: number;
}

export interface StoreySectionBoxPresetInput {
  readonly id: string;
  readonly name: string;
  readonly modelBounds: SectionBounds;
  readonly lowerElevation: number;
  readonly upperElevation: number;
  readonly verticalAxis?: SectionAxis;
  readonly horizontalPaddingFraction?: number;
  readonly verticalPadding?: number;
}

export interface StoreyCutPlanePresetInput {
  readonly id: string;
  readonly name: string;
  readonly elevation: number;
  readonly verticalAxis?: SectionAxis;
  readonly keep?: 'below' | 'above';
}

export interface SectionWorkspaceApplyContext {
  readonly revision: number;
  /** True when a newer definition arrived or shutdown began. */
  readonly isSuperseded: () => boolean;
}

export interface SectionWorkspaceControllerOptions {
  readonly apply: (
    definition: SectionWorkspaceDefinition,
    context: SectionWorkspaceApplyContext,
  ) => Promise<void> | void;
  readonly microtask?: (callback: () => void) => void;
  readonly onError?: (error: unknown) => void;
}

export interface SectionWorkspaceCommit {
  readonly requestedRevision: number;
  readonly appliedRevision: number;
  readonly superseded: boolean;
  readonly changed: boolean;
  readonly definition: SectionWorkspaceDefinition;
}

export interface SectionWorkspaceControllerSnapshot {
  readonly revision: number;
  readonly appliedRevision: number;
  readonly scheduled: boolean;
  readonly inFlight: boolean;
  readonly closed: boolean;
  readonly desired: SectionWorkspaceDefinition | null;
  readonly applied: SectionWorkspaceDefinition | null;
  readonly lastError: unknown | null;
}

interface WorkspaceWaiter {
  readonly revision: number;
  readonly changed: boolean;
  readonly resolve: (commit: SectionWorkspaceCommit) => void;
  readonly reject: (error: unknown) => void;
}

const SOURCES = new Set<SectionWorkspaceSource>([
  'custom',
  'selection',
  'storey',
  'saved-view',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SectionWorkspaceValidationError(path, 'must be a finite number');
  }
  return value;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SectionWorkspaceValidationError(path, 'must be a non-empty string');
  }
  return value.trim();
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new SectionWorkspaceValidationError(path, 'must be boolean');
  }
  return value;
}

function axisValue(value: unknown, path: string): SectionAxis {
  if (value !== 'x' && value !== 'y' && value !== 'z') {
    throw new SectionWorkspaceValidationError(path, 'must be x, y, or z');
  }
  return value;
}

function normalizeBounds(value: unknown, path: string): SectionBounds {
  if (!Array.isArray(value) || value.length !== 6) {
    throw new SectionWorkspaceValidationError(path, 'must contain six min/max values');
  }
  const bounds = value.map((entry, index) => finite(entry, `${path}[${index}]`));
  if (bounds[0]! > bounds[3]! || bounds[1]! > bounds[4]! || bounds[2]! > bounds[5]!) {
    throw new SectionWorkspaceValidationError(path, 'minimum values must not exceed maximum values');
  }
  return Object.freeze(bounds) as unknown as SectionBounds;
}

function axisIndex(axis: SectionAxis): 0 | 1 | 2 {
  if (axis === 'x') return 0;
  if (axis === 'y') return 1;
  return 2;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/** Validate, clone, and deeply freeze a durable workspace. */
export function normalizeSectionWorkspace(value: unknown): SectionWorkspaceDefinition {
  if (!isRecord(value)) throw new SectionWorkspaceValidationError('workspace', 'must be an object');
  if (value.schemaVersion !== 1) {
    throw new SectionWorkspaceValidationError('workspace.schemaVersion', 'must be 1');
  }
  const id = nonEmptyString(value.id, 'workspace.id');
  const name = nonEmptyString(value.name, 'workspace.name');
  if (typeof value.source !== 'string' || !SOURCES.has(value.source as SectionWorkspaceSource)) {
    throw new SectionWorkspaceValidationError('workspace.source', 'is not supported');
  }
  if (!Array.isArray(value.planes)) {
    throw new SectionWorkspaceValidationError('workspace.planes', 'must be an array');
  }

  const planeIds = new Set<string>();
  const planes = value.planes.map((entry, index): SectionPlaneDefinition => {
    const path = `workspace.planes[${index}]`;
    if (!isRecord(entry)) throw new SectionWorkspaceValidationError(path, 'must be an object');
    const planeId = nonEmptyString(entry.id, `${path}.id`);
    if (planeIds.has(planeId)) throw new SectionWorkspaceValidationError(`${path}.id`, 'must be unique');
    planeIds.add(planeId);
    const label = entry.label === undefined
      ? undefined
      : nonEmptyString(entry.label, `${path}.label`);
    const plane: SectionPlaneDefinition = {
      id: planeId,
      ...(label ? { label } : {}),
      enabled: booleanValue(entry.enabled, `${path}.enabled`),
      axis: axisValue(entry.axis, `${path}.axis`),
      position: finite(entry.position, `${path}.position`),
      inverted: booleanValue(entry.inverted, `${path}.inverted`),
    };
    return Object.freeze(plane);
  });

  let box: SectionBoxDefinition | null = null;
  if (value.box !== null && value.box !== undefined) {
    if (!isRecord(value.box)) throw new SectionWorkspaceValidationError('workspace.box', 'must be an object or null');
    box = Object.freeze({
      enabled: booleanValue(value.box.enabled, 'workspace.box.enabled'),
      bounds: normalizeBounds(value.box.bounds, 'workspace.box.bounds'),
    });
  }

  return Object.freeze({
    schemaVersion: 1,
    id,
    name,
    source: value.source as SectionWorkspaceSource,
    planes: Object.freeze(planes),
    box,
  });
}

export function createSectionWorkspace(
  input: Omit<SectionWorkspaceDefinition, 'schemaVersion'>,
): SectionWorkspaceDefinition {
  return normalizeSectionWorkspace({ schemaVersion: 1, ...input });
}

export function serializeSectionWorkspace(definition: SectionWorkspaceDefinition): string {
  return JSON.stringify(normalizeSectionWorkspace(definition));
}

export function parseSectionWorkspace(serialized: string | unknown): SectionWorkspaceDefinition | null {
  try {
    const value = typeof serialized === 'string' ? JSON.parse(serialized) : serialized;
    return normalizeSectionWorkspace(value);
  } catch {
    return null;
  }
}

export function sameSectionWorkspace(
  left: SectionWorkspaceDefinition | null,
  right: SectionWorkspaceDefinition | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (
    left.schemaVersion !== right.schemaVersion
    || left.id !== right.id
    || left.name !== right.name
    || left.source !== right.source
    || left.planes.length !== right.planes.length
  ) return false;
  for (let index = 0; index < left.planes.length; index += 1) {
    const a = left.planes[index]!;
    const b = right.planes[index]!;
    if (
      a.id !== b.id
      || a.label !== b.label
      || a.enabled !== b.enabled
      || a.axis !== b.axis
      || a.position !== b.position
      || a.inverted !== b.inverted
    ) return false;
  }
  if (!left.box || !right.box) return left.box === right.box;
  return left.box.enabled === right.box.enabled
    && left.box.bounds.every((value, index) => value === right.box!.bounds[index]);
}

/** Pad every face without mutating the durable source tuple. */
export function padSectionBounds(
  bounds: SectionBounds,
  paddingFraction: number,
  minimumPadding = 0,
): SectionBounds {
  const source = normalizeBounds(bounds, 'bounds');
  if (!Number.isFinite(paddingFraction) || paddingFraction < 0) {
    throw new RangeError('paddingFraction must be finite and non-negative');
  }
  if (!Number.isFinite(minimumPadding) || minimumPadding < 0) {
    throw new RangeError('minimumPadding must be finite and non-negative');
  }
  const x = Math.max((source[3] - source[0]) * paddingFraction, minimumPadding);
  const y = Math.max((source[4] - source[1]) * paddingFraction, minimumPadding);
  const z = Math.max((source[5] - source[2]) * paddingFraction, minimumPadding);
  return Object.freeze([
    source[0] - x,
    source[1] - y,
    source[2] - z,
    source[3] + x,
    source[4] + y,
    source[5] + z,
  ]) as SectionBounds;
}

export function createSelectionSectionPreset(
  input: SelectionSectionPresetInput,
): SectionWorkspaceDefinition {
  const bounds = padSectionBounds(
    input.bounds,
    input.paddingFraction ?? 0.05,
    input.minimumPadding ?? 0.01,
  );
  return createSectionWorkspace({
    id: input.id,
    name: input.name ?? 'Section to selection',
    source: 'selection',
    planes: [],
    box: { enabled: true, bounds },
  });
}

export function createStoreySectionBoxPreset(
  input: StoreySectionBoxPresetInput,
): SectionWorkspaceDefinition {
  const axis = input.verticalAxis ?? 'y';
  const lower = finite(input.lowerElevation, 'lowerElevation');
  const upper = finite(input.upperElevation, 'upperElevation');
  if (upper <= lower) throw new RangeError('upperElevation must be greater than lowerElevation');
  const verticalPadding = input.verticalPadding ?? 0.05;
  if (!Number.isFinite(verticalPadding) || verticalPadding < 0) {
    throw new RangeError('verticalPadding must be finite and non-negative');
  }
  const padded = [...padSectionBounds(
    input.modelBounds,
    input.horizontalPaddingFraction ?? 0,
  )] as number[];
  const index = axisIndex(axis);
  padded[index] = lower - verticalPadding;
  padded[index + 3] = upper + verticalPadding;
  return createSectionWorkspace({
    id: input.id,
    name: input.name,
    source: 'storey',
    planes: [],
    box: { enabled: true, bounds: normalizeBounds(padded, 'storey.bounds') },
  });
}

export function createStoreyCutPlanePreset(
  input: StoreyCutPlanePresetInput,
): SectionWorkspaceDefinition {
  const axis = input.verticalAxis ?? 'y';
  return createSectionWorkspace({
    id: input.id,
    name: input.name,
    source: 'storey',
    planes: [{
      id: `${input.id}:cut`,
      label: input.name,
      enabled: true,
      axis,
      position: finite(input.elevation, 'elevation'),
      inverted: (input.keep ?? 'below') === 'above',
    }],
    box: null,
  });
}

/** Convert durable absolute positions to the current relative-offset UI shape. */
export function toRelativeClipPlaneStates(
  definition: SectionWorkspaceDefinition,
  modelCentre: SectionPoint,
): RelativeClipPlaneState[] {
  return definition.planes.map((plane) => {
    const index = axisIndex(plane.axis);
    return {
      id: plane.id,
      enabled: plane.enabled,
      axis: plane.axis,
      offset: plane.position - modelCentre[index],
      inverted: plane.inverted,
    };
  });
}

/** Lift current relative UI planes into a durable world-space workspace. */
export function fromRelativeClipPlaneStates(input: {
  readonly id: string;
  readonly name: string;
  readonly source?: SectionWorkspaceSource;
  readonly planes: readonly RelativeClipPlaneState[];
  readonly modelCentre: SectionPoint;
  readonly box?: SectionBoxDefinition | null;
}): SectionWorkspaceDefinition {
  return createSectionWorkspace({
    id: input.id,
    name: input.name,
    source: input.source ?? 'custom',
    planes: input.planes.map((plane) => ({
      id: plane.id,
      enabled: plane.enabled,
      axis: plane.axis,
      position: input.modelCentre[axisIndex(plane.axis)] + plane.offset,
      inverted: plane.inverted,
    })),
    box: input.box ?? null,
  });
}

/**
 * Single-flight, latest-state controller for renderer section mutations.
 * Synchronous bursts coalesce before application; changes arriving during an
 * async apply collapse into one follow-up carrying only the latest definition.
 */
export class LatestSectionWorkspaceController {
  private readonly applyDefinition: SectionWorkspaceControllerOptions['apply'];
  private readonly microtask: NonNullable<SectionWorkspaceControllerOptions['microtask']>;
  private readonly onError?: SectionWorkspaceControllerOptions['onError'];

  private desired: SectionWorkspaceDefinition | null = null;
  private applied: SectionWorkspaceDefinition | null = null;
  private revision = 0;
  private appliedRevision = 0;
  private scheduled = false;
  private inFlight = false;
  private closed = false;
  private lastError: unknown | null = null;
  private waiters: WorkspaceWaiter[] = [];
  private idleWaiters: Array<() => void> = [];
  private shutdownPromise: Promise<void> | null = null;

  constructor(options: SectionWorkspaceControllerOptions) {
    this.applyDefinition = options.apply;
    this.microtask = options.microtask ?? ((callback) => queueMicrotask(callback));
    this.onError = options.onError;
  }

  setDefinition(definition: SectionWorkspaceDefinition): Promise<SectionWorkspaceCommit> {
    if (this.closed) return Promise.reject(abortError('Section workspace controller is shut down'));
    const normalized = normalizeSectionWorkspace(definition);
    const changed = !sameSectionWorkspace(this.desired, normalized);

    if (!changed && this.lastError === null) {
      if (this.appliedRevision >= this.revision && this.applied) {
        return Promise.resolve({
          requestedRevision: this.revision,
          appliedRevision: this.appliedRevision,
          superseded: false,
          changed: false,
          definition: this.applied,
        });
      }
      return this.waitForRevision(this.revision, false);
    }

    this.desired = normalized;
    this.revision += 1;
    this.lastError = null;
    const promise = this.waitForRevision(this.revision, true);
    this.schedule();
    return promise;
  }

  snapshot(): SectionWorkspaceControllerSnapshot {
    return {
      revision: this.revision,
      appliedRevision: this.appliedRevision,
      scheduled: this.scheduled,
      inFlight: this.inFlight,
      closed: this.closed,
      desired: this.desired,
      applied: this.applied,
      lastError: this.lastError,
    };
  }

  whenIdle(): Promise<void> {
    if (!this.inFlight && !this.scheduled) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closed = true;
    this.scheduled = false;
    const error = abortError('Section workspace controller shut down before apply completed');
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters = [];
    this.shutdownPromise = this.whenIdle();
    return this.shutdownPromise;
  }

  private waitForRevision(revision: number, changed: boolean): Promise<SectionWorkspaceCommit> {
    return new Promise<SectionWorkspaceCommit>((resolve, reject) => {
      this.waiters.push({ revision, changed, resolve, reject });
    });
  }

  private schedule(): void {
    if (this.closed || this.scheduled || this.inFlight) return;
    this.scheduled = true;
    this.microtask(() => {
      if (!this.scheduled) return;
      this.scheduled = false;
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.closed || this.inFlight || !this.desired || this.appliedRevision >= this.revision) return;
    this.inFlight = true;
    try {
      while (!this.closed && this.desired && this.appliedRevision < this.revision) {
        const targetRevision = this.revision;
        const target = this.desired;
        const context: SectionWorkspaceApplyContext = {
          revision: targetRevision,
          isSuperseded: () => this.closed || this.revision !== targetRevision,
        };
        try {
          await this.applyDefinition(target, context);
        } catch (error) {
          if (this.revision > targetRevision) continue;
          this.lastError = error;
          try { this.onError?.(error); } catch { /* diagnostics are non-fatal */ }
          this.rejectWaitersThrough(targetRevision, error);
          break;
        }
        if (this.closed) break;

        this.applied = target;
        this.appliedRevision = targetRevision;
        // A -> B -> A while A is in flight needs no redundant second apply:
        // the renderer already matches the latest semantic definition.
        if (
          this.revision > targetRevision
          && this.desired
          && sameSectionWorkspace(target, this.desired)
        ) {
          this.appliedRevision = this.revision;
        }
        if (this.appliedRevision >= this.revision) {
          this.lastError = null;
          this.resolveWaiters();
        }
      }
    } finally {
      this.inFlight = false;
      this.resolveIdleWaiters();
      if (!this.closed && this.lastError === null && this.appliedRevision < this.revision) this.schedule();
    }
  }

  private resolveWaiters(): void {
    if (!this.applied) return;
    const remaining: WorkspaceWaiter[] = [];
    for (const waiter of this.waiters) {
      if (waiter.revision <= this.appliedRevision) {
        waiter.resolve({
          requestedRevision: waiter.revision,
          appliedRevision: this.appliedRevision,
          superseded: waiter.revision < this.appliedRevision,
          changed: waiter.changed,
          definition: this.applied,
        });
      } else {
        remaining.push(waiter);
      }
    }
    this.waiters = remaining;
  }

  private rejectWaitersThrough(revision: number, error: unknown): void {
    const remaining: WorkspaceWaiter[] = [];
    for (const waiter of this.waiters) {
      if (waiter.revision <= revision) waiter.reject(error);
      else remaining.push(waiter);
    }
    this.waiters = remaining;
  }

  private resolveIdleWaiters(): void {
    if (this.inFlight || this.scheduled) return;
    const waiters = this.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}
