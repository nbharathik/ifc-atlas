/**
 * Spatial-tile residency and screen-space-error (SSE) LOD foundation.
 *
 * This module deliberately owns no THREE objects, workers, caches, or UI state.
 * It validates the immutable artifact contract and produces deterministic plans
 * that an integration adapter can execute through the existing fragment update
 * and render-state lifecycles.
 *
 * Important invariants:
 * - Semantic identities live on the tile, never on an individual LOD. Every
 *   representation therefore uses the same local IDs and application keys.
 * - Level 0 is exact geometry and is the only representation eligible for an
 *   exact selection/measurement raycast.
 * - A requested replacement does not become the render level until it is
 *   resident. The current representation remains active in the meantime.
 * - Loading is explicitly prioritised and bounded; stale invisible work is
 *   reported for cancellation rather than mutating scene geometry here.
 */

export type SpatialTileBounds = readonly [
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
];

export type SpatialPoint3 = readonly [x: number, y: number, z: number];

export interface SpatialTileElementIdentity {
  /** Stable FragmentsModel-local ID used by visibility/appearance/picking. */
  readonly localId: number;
  /** Stable model-scoped application key, e.g. `${modelKey}:${localId}`. */
  readonly elementKey: string;
  readonly expressId?: number;
  readonly globalId?: string | null;
}

export interface SpatialTileLodLevel {
  /** Zero is exact; larger values are progressively coarser. */
  readonly level: number;
  readonly kind: 'exact' | 'simplified';
  /** Maximum object-space deviation from exact geometry, in model units. */
  readonly geometricError: number;
  /** Immutable artifact/content identifier used by a loader or cache. */
  readonly contentId: string;
  readonly byteLength?: number;
  readonly triangleCount?: number;
  readonly checksum?: string;
}

export interface SpatialTileDescriptor {
  readonly id: string;
  readonly parentId?: string | null;
  readonly bounds: SpatialTileBounds;
  /** Shared semantic table for every LOD in this tile. */
  readonly elements: readonly SpatialTileElementIdentity[];
  /** May be empty for hierarchy-only grouping tiles. */
  readonly lods: readonly SpatialTileLodLevel[];
}

export interface SpatialTileManifest {
  readonly schemaVersion: 1;
  readonly sourceFingerprint: string;
  readonly settingsHash: string;
  readonly tiles: readonly SpatialTileDescriptor[];
}

export type SpatialTileManifestIssueCode =
  | 'schema-version'
  | 'manifest-field'
  | 'duplicate-tile'
  | 'invalid-bounds'
  | 'missing-parent'
  | 'hierarchy-cycle'
  | 'child-outside-parent'
  | 'content-without-elements'
  | 'elements-without-content'
  | 'duplicate-local-id'
  | 'duplicate-element-key'
  | 'invalid-element'
  | 'duplicate-lod-level'
  | 'duplicate-content-id'
  | 'missing-exact-lod'
  | 'invalid-lod';

export interface SpatialTileManifestIssue {
  readonly code: SpatialTileManifestIssueCode;
  readonly message: string;
  readonly tileId?: string;
}

export class SpatialTileManifestError extends Error {
  readonly issues: readonly SpatialTileManifestIssue[];

  constructor(issues: readonly SpatialTileManifestIssue[]) {
    super(`Invalid spatial tile manifest (${issues.length} issue${issues.length === 1 ? '' : 's'})`);
    this.name = 'SpatialTileManifestError';
    this.issues = issues;
  }
}

export type SpatialTileView =
  | {
      readonly projection: 'perspective';
      readonly cameraPosition: SpatialPoint3;
      readonly viewportHeightPx: number;
      readonly verticalFovRadians: number;
    }
  | {
      readonly projection: 'orthographic';
      readonly cameraPosition: SpatialPoint3;
      readonly viewportHeightPx: number;
      readonly verticalSpan: number;
    };

export type SpatialTileMotionState = 'idle' | 'navigating';

export interface SpatialTileResidency {
  /** Fully decoded/attachable representations. */
  readonly readyLevels: ReadonlySet<number>;
  /** In-flight requests, used for request deduplication and cancellation. */
  readonly loadingLevels?: ReadonlySet<number>;
  /** Representation currently attached and visible for the tile. */
  readonly activeLevel?: number | null;
}

export interface SpatialTileLodPolicyOptions {
  /** Maximum projected simplification error after the camera settles. */
  readonly idleMaxErrorPx?: number;
  /** Looser error budget while moving, allowing a coarser representation. */
  readonly navigationMaxErrorPx?: number;
  /** Symmetric dead-band around the SSE threshold, in [0, 0.95). */
  readonly hysteresisRatio?: number;
  /** Maximum new tile payloads admitted by one frame plan. */
  readonly maxRequestsPerFrame?: number;
}

export interface SpatialTileFrameInput {
  readonly view: SpatialTileView;
  readonly motion: SpatialTileMotionState;
  /** Tiles surviving coarse hierarchy/frustum visibility. */
  readonly visibleTileIds: Iterable<string>;
  readonly residency: ReadonlyMap<string, SpatialTileResidency>;
  /** Keep these elements exact while a selection/measurement lease is active. */
  readonly exactElementLocalIds?: Iterable<number>;
  readonly maxRequests?: number;
}

export type SpatialTileLoadReason = 'exact-pick' | 'initial' | 'refine' | 'coarsen';

export interface SpatialTileLoadRequest {
  readonly tileId: string;
  readonly level: number;
  readonly contentId: string;
  readonly reason: SpatialTileLoadReason;
  /** Higher values should be consumed first. */
  readonly priority: number;
  readonly generation: number;
}

export interface SpatialTileLoadCancellation {
  readonly tileId: string;
  readonly level: number;
  readonly reason: 'invisible' | 'superseded';
}

export type SpatialTileTransition =
  | 'stable'
  | 'activate-ready'
  | 'activate-fallback'
  | 'retain-while-loading'
  | 'missing';

export interface SpatialTileLodDecision {
  readonly tileId: string;
  readonly desiredLevel: number;
  readonly desiredErrorPx: number;
  readonly previousActiveLevel: number | null;
  /** Level that should remain rendered after this plan is applied. */
  readonly renderLevel: number | null;
  readonly transition: SpatialTileTransition;
  readonly exactRequired: boolean;
  readonly exactReady: boolean;
  readonly requestState: 'none' | 'loading' | 'queued' | 'deferred';
}

export interface SpatialTileFramePlan {
  readonly generation: number;
  readonly decisions: readonly SpatialTileLodDecision[];
  readonly requests: readonly SpatialTileLoadRequest[];
  /** Valid requests held behind the current backpressure budget. */
  readonly deferredRequests: readonly SpatialTileLoadRequest[];
  readonly cancellations: readonly SpatialTileLoadCancellation[];
  readonly unresolvedExactElementIds: readonly number[];
  readonly unknownVisibleTileIds: readonly string[];
  /** Never use simplified geometry for an exact raycast when this is false. */
  readonly exactPickReady: boolean;
}

export interface ExactPickTarget {
  readonly localId: number;
  readonly elementKey: string;
  readonly expressId?: number;
  readonly globalId?: string | null;
  readonly tileId: string;
  readonly exactLevel: 0;
  readonly exactContentId: string;
  readonly ready: boolean;
}

export interface ExactPickGeometryPlan {
  readonly generation: number;
  readonly targets: readonly ExactPickTarget[];
  readonly requests: readonly SpatialTileLoadRequest[];
  readonly deferredRequests: readonly SpatialTileLoadRequest[];
  readonly unresolvedLocalIds: readonly number[];
  /** True only when every target has resident level-0 geometry. */
  readonly ready: boolean;
}

export interface ExactPickTileTarget {
  readonly tileId: string;
  readonly exactLevel: 0;
  readonly exactContentId: string;
  /** Stable IDs that the exact raycast is allowed to return for this tile. */
  readonly elementLocalIds: readonly number[];
  readonly ready: boolean;
}

export interface ExactPickTilePlan {
  readonly generation: number;
  readonly targets: readonly ExactPickTileTarget[];
  readonly requests: readonly SpatialTileLoadRequest[];
  readonly deferredRequests: readonly SpatialTileLoadRequest[];
  readonly unresolvedTileIds: readonly string[];
  /** Simplified residency never contributes to this result. */
  readonly ready: boolean;
}

interface IndexedElement {
  readonly tile: SpatialTileDescriptor;
  readonly identity: SpatialTileElementIdentity;
}

interface RequestCandidate extends SpatialTileLoadRequest {
  readonly screenCoveragePx: number;
}

const DEFAULT_POLICY: Required<SpatialTileLodPolicyOptions> = {
  idleMaxErrorPx: 1.5,
  navigationMaxErrorPx: 6,
  hysteresisRatio: 0.15,
  maxRequestsPerFrame: 4,
};

const REQUEST_REASON_RANK: Record<SpatialTileLoadReason, number> = {
  'exact-pick': 4,
  initial: 3,
  refine: 2,
  coarsen: 1,
};

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function validBounds(bounds: SpatialTileBounds): boolean {
  return bounds.length === 6
    && bounds.every(Number.isFinite)
    && bounds[0] <= bounds[3]
    && bounds[1] <= bounds[4]
    && bounds[2] <= bounds[5];
}

function boundsContain(parent: SpatialTileBounds, child: SpatialTileBounds): boolean {
  return parent[0] <= child[0]
    && parent[1] <= child[1]
    && parent[2] <= child[2]
    && parent[3] >= child[3]
    && parent[4] >= child[4]
    && parent[5] >= child[5];
}

export function boundsIntersect(a: SpatialTileBounds, b: SpatialTileBounds): boolean {
  return a[0] <= b[3] && a[3] >= b[0]
    && a[1] <= b[4] && a[4] >= b[1]
    && a[2] <= b[5] && a[5] >= b[2];
}

export function distanceToTileBounds(point: SpatialPoint3, bounds: SpatialTileBounds): number {
  const dx = Math.max(bounds[0] - point[0], 0, point[0] - bounds[3]);
  const dy = Math.max(bounds[1] - point[1], 0, point[1] - bounds[4]);
  const dz = Math.max(bounds[2] - point[2], 0, point[2] - bounds[5]);
  return Math.hypot(dx, dy, dz);
}

function boundsDiagonal(bounds: SpatialTileBounds): number {
  return Math.hypot(
    bounds[3] - bounds[0],
    bounds[4] - bounds[1],
    bounds[5] - bounds[2],
  );
}

/** Project a world-space deviation into vertical screen pixels. */
export function projectWorldErrorPx(
  worldError: number,
  bounds: SpatialTileBounds,
  view: SpatialTileView,
): number {
  if (worldError <= 0) return 0;
  if (!Number.isFinite(worldError) || !Number.isFinite(view.viewportHeightPx) || view.viewportHeightPx <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  if (view.projection === 'orthographic') {
    if (!Number.isFinite(view.verticalSpan) || view.verticalSpan <= 0) return Number.POSITIVE_INFINITY;
    return worldError * view.viewportHeightPx / view.verticalSpan;
  }
  if (
    !Number.isFinite(view.verticalFovRadians)
    || view.verticalFovRadians <= 0
    || view.verticalFovRadians >= Math.PI
  ) return Number.POSITIVE_INFINITY;
  const distance = distanceToTileBounds(view.cameraPosition, bounds);
  // At/inside a tile, no finite simplification error is safe; force exact.
  if (distance <= Number.EPSILON) return Number.POSITIVE_INFINITY;
  const worldHeightAtDistance = 2 * distance * Math.tan(view.verticalFovRadians / 2);
  return worldError * view.viewportHeightPx / worldHeightAtDistance;
}

export function computeTileScreenSpaceError(
  tile: SpatialTileDescriptor,
  lod: SpatialTileLodLevel,
  view: SpatialTileView,
): number {
  return projectWorldErrorPx(lod.geometricError, tile.bounds, view);
}

export function validateSpatialTileManifest(
  manifest: SpatialTileManifest,
): SpatialTileManifestIssue[] {
  const issues: SpatialTileManifestIssue[] = [];
  const add = (
    code: SpatialTileManifestIssueCode,
    message: string,
    tileId?: string,
  ) => issues.push({ code, message, ...(tileId ? { tileId } : {}) });

  if (manifest.schemaVersion !== 1) add('schema-version', 'schemaVersion must be 1');
  if (!manifest.sourceFingerprint?.trim()) add('manifest-field', 'sourceFingerprint is required');
  if (!manifest.settingsHash?.trim()) add('manifest-field', 'settingsHash is required');

  const tilesById = new Map<string, SpatialTileDescriptor>();
  const localIds = new Map<number, string>();
  const elementKeys = new Map<string, string>();
  const contentIds = new Map<string, string>();

  for (const tile of manifest.tiles) {
    if (!tile.id?.trim()) {
      add('duplicate-tile', 'tile id must be non-empty');
      continue;
    }
    if (tilesById.has(tile.id)) add('duplicate-tile', `duplicate tile id ${tile.id}`, tile.id);
    else tilesById.set(tile.id, tile);
    if (!validBounds(tile.bounds)) add('invalid-bounds', 'bounds must be finite ordered min/max values', tile.id);
    if (tile.parentId === tile.id) add('hierarchy-cycle', 'tile cannot parent itself', tile.id);
    if (tile.lods.length > 0 && tile.elements.length === 0) {
      add('content-without-elements', 'renderable tile must declare stable semantic elements', tile.id);
    }
    if (tile.elements.length > 0 && tile.lods.length === 0) {
      add('elements-without-content', 'semantic elements require an exact tile payload', tile.id);
    }

    for (const element of tile.elements) {
      if (!Number.isInteger(element.localId) || element.localId < 0 || !element.elementKey?.trim()) {
        add('invalid-element', 'element requires a non-negative integer localId and non-empty elementKey', tile.id);
        continue;
      }
      if (element.expressId !== undefined && (!Number.isInteger(element.expressId) || element.expressId < 0)) {
        add('invalid-element', `element ${element.localId} has an invalid expressId`, tile.id);
      }
      const localOwner = localIds.get(element.localId);
      if (localOwner) add('duplicate-local-id', `localId ${element.localId} is also owned by ${localOwner}`, tile.id);
      else localIds.set(element.localId, tile.id);
      const keyOwner = elementKeys.get(element.elementKey);
      if (keyOwner) add('duplicate-element-key', `elementKey ${element.elementKey} is also owned by ${keyOwner}`, tile.id);
      else elementKeys.set(element.elementKey, tile.id);
    }

    const levels = new Set<number>();
    const ordered = [...tile.lods].sort((a, b) => a.level - b.level);
    for (const lod of ordered) {
      if (!Number.isInteger(lod.level) || lod.level < 0 || levels.has(lod.level)) {
        add('duplicate-lod-level', `LOD level ${lod.level} is invalid or duplicated`, tile.id);
      }
      levels.add(lod.level);
      if (!lod.contentId?.trim()) add('invalid-lod', `LOD ${lod.level} requires contentId`, tile.id);
      else {
        const owner = contentIds.get(lod.contentId);
        if (owner) add('duplicate-content-id', `contentId ${lod.contentId} is also used by ${owner}`, tile.id);
        else contentIds.set(lod.contentId, tile.id);
      }
      if (!isFiniteNonNegative(lod.geometricError)) {
        add('invalid-lod', `LOD ${lod.level} geometricError must be finite and non-negative`, tile.id);
      }
      if (lod.byteLength !== undefined && !isFiniteNonNegative(lod.byteLength)) {
        add('invalid-lod', `LOD ${lod.level} byteLength must be finite and non-negative`, tile.id);
      }
      if (lod.triangleCount !== undefined && !isFiniteNonNegative(lod.triangleCount)) {
        add('invalid-lod', `LOD ${lod.level} triangleCount must be finite and non-negative`, tile.id);
      }
    }

    if (ordered.length > 0) {
      const exact = ordered.find((lod) => lod.level === 0);
      if (!exact || exact.kind !== 'exact' || exact.geometricError !== 0) {
        add('missing-exact-lod', 'level 0 must be exact with zero geometric error', tile.id);
      }
      let previousError = -1;
      for (const lod of ordered) {
        if (lod.level > 0 && lod.kind !== 'simplified') {
          add('invalid-lod', `LOD ${lod.level} must be simplified`, tile.id);
        }
        if (lod.level > 0 && lod.geometricError <= previousError) {
          add('invalid-lod', 'geometric error must strictly increase with coarser levels', tile.id);
        }
        previousError = lod.geometricError;
      }
    }
  }

  for (const tile of tilesById.values()) {
    if (tile.parentId && !tilesById.has(tile.parentId)) {
      add('missing-parent', `parent ${tile.parentId} does not exist`, tile.id);
      continue;
    }
    if (tile.parentId) {
      const parent = tilesById.get(tile.parentId);
      if (parent && validBounds(parent.bounds) && validBounds(tile.bounds) && !boundsContain(parent.bounds, tile.bounds)) {
        add('child-outside-parent', `tile bounds are not contained by parent ${parent.id}`, tile.id);
      }
    }
    const seen = new Set<string>();
    let cursor: SpatialTileDescriptor | undefined = tile;
    while (cursor?.parentId) {
      if (seen.has(cursor.id)) {
        add('hierarchy-cycle', 'tile hierarchy contains a cycle', tile.id);
        break;
      }
      seen.add(cursor.id);
      cursor = tilesById.get(cursor.parentId);
    }
  }

  return issues;
}

function freezeManifest(manifest: SpatialTileManifest): SpatialTileManifest {
  const tiles = manifest.tiles.map((tile) => {
    const bounds = Object.freeze([...tile.bounds]) as unknown as SpatialTileBounds;
    const elements = Object.freeze(tile.elements.map((element) => Object.freeze({ ...element })));
    const lods = Object.freeze(
      [...tile.lods]
        .sort((a, b) => a.level - b.level)
        .map((lod) => Object.freeze({ ...lod })),
    );
    return Object.freeze({ ...tile, bounds, elements, lods });
  });
  return Object.freeze({ ...manifest, tiles: Object.freeze(tiles) });
}

function normalizePolicy(options: SpatialTileLodPolicyOptions): Required<SpatialTileLodPolicyOptions> {
  const policy = { ...DEFAULT_POLICY, ...options };
  if (!Number.isFinite(policy.idleMaxErrorPx) || policy.idleMaxErrorPx <= 0) {
    throw new RangeError('idleMaxErrorPx must be finite and greater than zero');
  }
  if (!Number.isFinite(policy.navigationMaxErrorPx) || policy.navigationMaxErrorPx < policy.idleMaxErrorPx) {
    throw new RangeError('navigationMaxErrorPx must be finite and >= idleMaxErrorPx');
  }
  if (!Number.isFinite(policy.hysteresisRatio) || policy.hysteresisRatio < 0 || policy.hysteresisRatio >= 0.95) {
    throw new RangeError('hysteresisRatio must be in [0, 0.95)');
  }
  if (!Number.isInteger(policy.maxRequestsPerFrame) || policy.maxRequestsPerFrame < 0) {
    throw new RangeError('maxRequestsPerFrame must be a non-negative integer');
  }
  return policy;
}

function coarsestWithinError(
  tile: SpatialTileDescriptor,
  view: SpatialTileView,
  thresholdPx: number,
): SpatialTileLodLevel {
  let selected = tile.lods[0]!;
  for (const lod of tile.lods) {
    if (computeTileScreenSpaceError(tile, lod, view) <= thresholdPx) selected = lod;
    else break;
  }
  return selected;
}

/**
 * Choose an LOD with a symmetric hysteresis band. Refinement occurs only when
 * the current target exceeds the upper band; coarsening occurs only when a
 * candidate falls below the lower band.
 */
export function selectSpatialTileLod(
  tile: SpatialTileDescriptor,
  view: SpatialTileView,
  maxErrorPx: number,
  previousLevel?: number | null,
  hysteresisRatio = 0,
  exactRequired = false,
): SpatialTileLodLevel {
  if (tile.lods.length === 0) throw new Error(`Tile ${tile.id} has no renderable LOD`);
  const exact = tile.lods[0]!;
  if (exactRequired) return exact;
  const previous = previousLevel === undefined || previousLevel === null
    ? undefined
    : tile.lods.find((lod) => lod.level === previousLevel);
  if (!previous) return coarsestWithinError(tile, view, maxErrorPx);

  const previousError = computeTileScreenSpaceError(tile, previous, view);
  if (previousError > maxErrorPx * (1 + hysteresisRatio)) {
    return coarsestWithinError(tile, view, maxErrorPx);
  }
  const coarser = coarsestWithinError(tile, view, maxErrorPx * (1 - hysteresisRatio));
  return coarser.level > previous.level ? coarser : previous;
}

function requestComparator(a: RequestCandidate, b: RequestCandidate): number {
  const reason = REQUEST_REASON_RANK[b.reason] - REQUEST_REASON_RANK[a.reason];
  if (reason !== 0) return reason;
  const coverage = b.screenCoveragePx - a.screenCoveragePx;
  if (Number.isFinite(coverage) && coverage !== 0) return coverage;
  // Infinite coverage means the camera is at or inside the tile - it must
  // outrank every finite tile instead of falling through to the id tiebreak.
  const aInfinite = a.screenCoveragePx === Number.POSITIVE_INFINITY;
  const bInfinite = b.screenCoveragePx === Number.POSITIVE_INFINITY;
  if (aInfinite !== bInfinite) return aInfinite ? -1 : 1;
  const tile = a.tileId.localeCompare(b.tileId);
  return tile !== 0 ? tile : a.level - b.level;
}

function requestPriority(reason: SpatialTileLoadReason, coveragePx: number): number {
  const coverage = Number.isFinite(coveragePx) ? Math.min(999_999, Math.max(0, coveragePx)) : 999_999;
  return REQUEST_REASON_RANK[reason] * 1_000_000 + coverage;
}

function chooseReadyFallback(
  tile: SpatialTileDescriptor,
  desiredLevel: number,
  residency: SpatialTileResidency | undefined,
): number | null {
  if (!residency) return null;
  const validReady = tile.lods.filter((lod) => residency.readyLevels.has(lod.level));
  if (validReady.length === 0) return null;
  const active = residency.activeLevel;
  if (active !== undefined && active !== null && validReady.some((lod) => lod.level === active)) return active;
  validReady.sort((a, b) => {
    const distance = Math.abs(a.level - desiredLevel) - Math.abs(b.level - desiredLevel);
    return distance !== 0 ? distance : a.level - b.level;
  });
  return validReady[0]!.level;
}

function currentActiveLevel(
  tile: SpatialTileDescriptor,
  residency: SpatialTileResidency | undefined,
): number | null {
  const active = residency?.activeLevel;
  if (active === undefined || active === null || !residency.readyLevels.has(active)) return null;
  return tile.lods.some((lod) => lod.level === active) ? active : null;
}

function maxRequests(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (value === Number.POSITIVE_INFINITY) return Number.MAX_SAFE_INTEGER;
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

export class SpatialTileLodService {
  readonly manifest: SpatialTileManifest;
  readonly policy: Required<SpatialTileLodPolicyOptions>;

  private readonly tilesById = new Map<string, SpatialTileDescriptor>();
  private readonly childrenById = new Map<string, readonly SpatialTileDescriptor[]>();
  private readonly elementByLocalId = new Map<number, IndexedElement>();
  private readonly elementByKey = new Map<string, IndexedElement>();
  private readonly renderTiles: readonly SpatialTileDescriptor[];
  private readonly previousDesiredLevels = new Map<string, number>();
  private generation = 0;

  constructor(manifest: SpatialTileManifest, options: SpatialTileLodPolicyOptions = {}) {
    const issues = validateSpatialTileManifest(manifest);
    if (issues.length > 0) throw new SpatialTileManifestError(issues);
    this.manifest = freezeManifest(manifest);
    this.policy = Object.freeze(normalizePolicy(options));

    const mutableChildren = new Map<string, SpatialTileDescriptor[]>();
    for (const tile of this.manifest.tiles) {
      this.tilesById.set(tile.id, tile);
      if (tile.parentId) {
        const children = mutableChildren.get(tile.parentId) ?? [];
        children.push(tile);
        mutableChildren.set(tile.parentId, children);
      }
      for (const identity of tile.elements) {
        const indexed = { tile, identity };
        this.elementByLocalId.set(identity.localId, indexed);
        this.elementByKey.set(identity.elementKey, indexed);
      }
    }
    for (const [id, children] of mutableChildren) {
      this.childrenById.set(id, Object.freeze(children.sort((a, b) => a.id.localeCompare(b.id))));
    }
    this.renderTiles = Object.freeze(this.manifest.tiles.filter((tile) => tile.lods.length > 0));
  }

  resetHistory(): void {
    this.previousDesiredLevels.clear();
  }

  getTile(tileId: string): SpatialTileDescriptor | null {
    return this.tilesById.get(tileId) ?? null;
  }

  getChildren(tileId: string): readonly SpatialTileDescriptor[] {
    return this.childrenById.get(tileId) ?? [];
  }

  getRootTiles(): readonly SpatialTileDescriptor[] {
    return this.manifest.tiles.filter((tile) => !tile.parentId);
  }

  getTileForLocalId(localId: number): SpatialTileDescriptor | null {
    return this.elementByLocalId.get(localId)?.tile ?? null;
  }

  getTileForElementKey(elementKey: string): SpatialTileDescriptor | null {
    return this.elementByKey.get(elementKey)?.tile ?? null;
  }

  getElementIdentity(localId: number): SpatialTileElementIdentity | null {
    return this.elementByLocalId.get(localId)?.identity ?? null;
  }

  queryTilesIntersecting(bounds: SpatialTileBounds): readonly SpatialTileDescriptor[] {
    if (!validBounds(bounds)) return [];
    return this.renderTiles.filter((tile) => boundsIntersect(tile.bounds, bounds));
  }

  planFrame(input: SpatialTileFrameInput): SpatialTileFramePlan {
    const generation = ++this.generation;
    const requestedVisibleIds = new Set(input.visibleTileIds);
    const unknownVisibleTileIds = [...requestedVisibleIds]
      .filter((id) => !this.tilesById.has(id))
      .sort();
    const visibleIds = new Set(
      [...requestedVisibleIds].filter((id) => this.tilesById.get(id)?.lods.length),
    );
    const exactTileIds = new Set<string>();
    const unresolvedExactElementIds: number[] = [];
    for (const localId of new Set(input.exactElementLocalIds ?? [])) {
      const indexed = this.elementByLocalId.get(localId);
      if (indexed) {
        exactTileIds.add(indexed.tile.id);
        visibleIds.add(indexed.tile.id);
      } else {
        unresolvedExactElementIds.push(localId);
      }
    }
    unresolvedExactElementIds.sort((a, b) => a - b);

    const threshold = input.motion === 'navigating'
      ? this.policy.navigationMaxErrorPx
      : this.policy.idleMaxErrorPx;
    const candidateByKey = new Map<string, RequestCandidate>();
    const cancellations: SpatialTileLoadCancellation[] = [];
    const mutableDecisions: Array<SpatialTileLodDecision & { requestKey: string | null }> = [];

    const addCandidate = (
      tile: SpatialTileDescriptor,
      lod: SpatialTileLodLevel,
      reason: SpatialTileLoadReason,
    ) => {
      const key = `${tile.id}@${lod.level}`;
      if (candidateByKey.has(key)) return;
      const coverage = projectWorldErrorPx(boundsDiagonal(tile.bounds), tile.bounds, input.view);
      candidateByKey.set(key, {
        tileId: tile.id,
        level: lod.level,
        contentId: lod.contentId,
        reason,
        priority: requestPriority(reason, coverage),
        generation,
        screenCoveragePx: coverage,
      });
    };

    for (const tile of this.renderTiles) {
      const residency = input.residency.get(tile.id);
      const loading = residency?.loadingLevels ?? new Set<number>();
      if (!visibleIds.has(tile.id)) {
        this.previousDesiredLevels.delete(tile.id);
        for (const level of loading) cancellations.push({ tileId: tile.id, level, reason: 'invisible' });
        continue;
      }

      const exactRequired = exactTileIds.has(tile.id);
      const desired = selectSpatialTileLod(
        tile,
        input.view,
        threshold,
        this.previousDesiredLevels.get(tile.id),
        this.policy.hysteresisRatio,
        exactRequired,
      );
      this.previousDesiredLevels.set(tile.id, desired.level);
      const desiredReady = residency?.readyLevels.has(desired.level) ?? false;
      const previousActiveLevel = currentActiveLevel(tile, residency);
      const readyFallback = chooseReadyFallback(tile, desired.level, residency);
      const renderLevel = desiredReady ? desired.level : readyFallback;
      const transition: SpatialTileTransition = desiredReady
        ? (previousActiveLevel === desired.level ? 'stable' : 'activate-ready')
        : renderLevel === null
          ? 'missing'
          : previousActiveLevel === renderLevel
            ? 'retain-while-loading'
            : 'activate-fallback';
      let requestKey: string | null = null;

      // Get a cheap representation on screen first. Exact leases skip this:
      // a coarse payload must never be mistaken for pickable exact geometry.
      if (renderLevel === null && !exactRequired) {
        const bootstrap = tile.lods[tile.lods.length - 1]!;
        if (!residency?.readyLevels.has(bootstrap.level) && !loading.has(bootstrap.level)) {
          addCandidate(tile, bootstrap, 'initial');
        }
      }
      if (!desiredReady && !loading.has(desired.level)) {
        const reason: SpatialTileLoadReason = exactRequired
          ? 'exact-pick'
          : readyFallback === null
            ? (desired.level === tile.lods[tile.lods.length - 1]!.level ? 'initial' : 'refine')
            : desired.level < readyFallback
              ? 'refine'
              : 'coarsen';
        addCandidate(tile, desired, reason);
        requestKey = `${tile.id}@${desired.level}`;
      }

      for (const level of loading) {
        // Level zero may be needed by an overlapping exact-pick lease; allow it
        // to finish while the tile remains visible even if visual SSE changes.
        // Likewise, do not cancel the bootstrap payload while it is the only
        // path to a first visible representation.
        const bootstrapLevel = tile.lods[tile.lods.length - 1]!.level;
        const requiredForFirstFrame = renderLevel === null && level === bootstrapLevel;
        if (level !== desired.level && level !== 0 && !requiredForFirstFrame) {
          cancellations.push({ tileId: tile.id, level, reason: 'superseded' });
        }
      }

      mutableDecisions.push({
        tileId: tile.id,
        desiredLevel: desired.level,
        desiredErrorPx: computeTileScreenSpaceError(tile, desired, input.view),
        previousActiveLevel,
        renderLevel,
        transition,
        exactRequired,
        exactReady: residency?.readyLevels.has(0) ?? false,
        requestState: desiredReady ? 'none' : loading.has(desired.level) ? 'loading' : 'deferred',
        requestKey,
      });
    }

    const candidates = [...candidateByKey.values()].sort(requestComparator);
    const limit = maxRequests(input.maxRequests, this.policy.maxRequestsPerFrame);
    const queuedCandidates = candidates.slice(0, limit);
    const deferredCandidates = candidates.slice(limit);
    const queuedKeys = new Set(queuedCandidates.map((request) => `${request.tileId}@${request.level}`));
    const decisions = mutableDecisions.map(({ requestKey, ...decision }) => ({
      ...decision,
      requestState: requestKey && queuedKeys.has(requestKey)
        ? 'queued' as const
        : decision.requestState,
    }));

    const exactPickReady = unresolvedExactElementIds.length === 0
      && [...exactTileIds].every((tileId) => input.residency.get(tileId)?.readyLevels.has(0));

    const stripCandidate = ({ screenCoveragePx: _coverage, ...request }: RequestCandidate) => request;
    return {
      generation,
      decisions,
      requests: queuedCandidates.map(stripCandidate),
      deferredRequests: deferredCandidates.map(stripCandidate),
      cancellations,
      unresolvedExactElementIds,
      unknownVisibleTileIds,
      exactPickReady,
    };
  }

  /**
   * Turn tile IDs from a coarse GPU/spatial pick into exact-geometry targets.
   * This is the bridge for a hybrid picker that knows the candidate tile but
   * intentionally does not trust simplified triangles to identify an element.
   */
  planExactPickTiles(
    tileIds: Iterable<string>,
    residency: ReadonlyMap<string, SpatialTileResidency>,
    requestLimit = Number.POSITIVE_INFINITY,
  ): ExactPickTilePlan {
    const generation = ++this.generation;
    const unresolvedTileIds: string[] = [];
    const targets: ExactPickTileTarget[] = [];
    const candidates: RequestCandidate[] = [];

    for (const tileId of new Set(tileIds)) {
      const tile = this.tilesById.get(tileId);
      if (!tile || tile.lods.length === 0) {
        unresolvedTileIds.push(tileId);
        continue;
      }
      const exact = tile.lods[0]!;
      const tileResidency = residency.get(tile.id);
      const ready = tileResidency?.readyLevels.has(0) ?? false;
      targets.push({
        tileId: tile.id,
        exactLevel: 0,
        exactContentId: exact.contentId,
        elementLocalIds: tile.elements.map((element) => element.localId),
        ready,
      });
      if (!ready && !tileResidency?.loadingLevels?.has(0)) {
        candidates.push({
          tileId: tile.id,
          level: 0,
          contentId: exact.contentId,
          reason: 'exact-pick',
          priority: requestPriority('exact-pick', Number.POSITIVE_INFINITY),
          generation,
          screenCoveragePx: Number.POSITIVE_INFINITY,
        });
      }
    }

    targets.sort((a, b) => a.tileId.localeCompare(b.tileId));
    unresolvedTileIds.sort();
    candidates.sort(requestComparator);
    const limit = maxRequests(requestLimit, candidates.length);
    const stripCandidate = ({ screenCoveragePx: _coverage, ...request }: RequestCandidate) => request;
    return {
      generation,
      targets,
      requests: candidates.slice(0, limit).map(stripCandidate),
      deferredRequests: candidates.slice(limit).map(stripCandidate),
      unresolvedTileIds,
      ready: unresolvedTileIds.length === 0 && targets.every((target) => target.ready),
    };
  }

  /**
   * Resolve exact geometry for a pick/measurement. Consumers must wait for
   * `ready === true` and raycast the returned level-0 targets; an active
   * simplified render level is intentionally never accepted as a hit source.
   */
  planExactPickGeometry(
    localIds: Iterable<number>,
    residency: ReadonlyMap<string, SpatialTileResidency>,
    requestLimit = Number.POSITIVE_INFINITY,
  ): ExactPickGeometryPlan {
    const generation = ++this.generation;
    const unresolvedLocalIds: number[] = [];
    const targets: ExactPickTarget[] = [];
    const candidates = new Map<string, RequestCandidate>();

    for (const localId of new Set(localIds)) {
      const indexed = this.elementByLocalId.get(localId);
      if (!indexed) {
        unresolvedLocalIds.push(localId);
        continue;
      }
      const exact = indexed.tile.lods[0]!;
      const tileResidency = residency.get(indexed.tile.id);
      const ready = tileResidency?.readyLevels.has(0) ?? false;
      targets.push({
        ...indexed.identity,
        tileId: indexed.tile.id,
        exactLevel: 0,
        exactContentId: exact.contentId,
        ready,
      });
      if (!ready && !tileResidency?.loadingLevels?.has(0) && !candidates.has(indexed.tile.id)) {
        candidates.set(indexed.tile.id, {
          tileId: indexed.tile.id,
          level: 0,
          contentId: exact.contentId,
          reason: 'exact-pick',
          priority: requestPriority('exact-pick', Number.POSITIVE_INFINITY),
          generation,
          screenCoveragePx: Number.POSITIVE_INFINITY,
        });
      }
    }

    targets.sort((a, b) => a.localId - b.localId);
    unresolvedLocalIds.sort((a, b) => a - b);
    const ordered = [...candidates.values()].sort(requestComparator);
    const limit = maxRequests(requestLimit, ordered.length);
    const stripCandidate = ({ screenCoveragePx: _coverage, ...request }: RequestCandidate) => request;
    return {
      generation,
      targets,
      requests: ordered.slice(0, limit).map(stripCandidate),
      deferredRequests: ordered.slice(limit).map(stripCandidate),
      unresolvedLocalIds,
      ready: unresolvedLocalIds.length === 0 && targets.every((target) => target.ready),
    };
  }
}
