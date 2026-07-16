import * as THREE from 'three';

import type { VisibilityMutationTarget } from './renderStateCoordinator';
import {
  SpatialTileLodService,
  type SpatialTileFramePlan,
  type SpatialTileMotionState,
  type SpatialTileResidency,
  type SpatialTileView,
} from './spatialTileLod';

interface TileRecord {
  readonly id: string;
  readonly localIds: readonly number[];
  readonly box: THREE.Box3;
  hidden: boolean;
}

export interface SpatialTileVisibilityOptions {
  /** Conservative margin expressed as a fraction of the model diagonal. */
  readonly padFraction?: number;
}

export interface SpatialTileVisibilityResult {
  readonly visibleTileIds: readonly string[];
  readonly hiddenTileCount: number;
  readonly hiddenElementCount: number;
  readonly revealedElementCount: number;
  readonly newlyHiddenElementCount: number;
  readonly lodPlan: SpatialTileFramePlan;
}

/**
 * Stable scene-residency controller for preprocessed spatial tiles.
 *
 * It never removes, disposes, or rebuilds geometry. At idle it publishes one
 * named visibility mask through RenderStateCoordinator; while navigating it
 * performs only conservative show operations. The same tile/L0 identities are
 * fed through SpatialTileLodService now, so future payload-backed LODs can be
 * mounted-before-swap without changing selection or visibility semantics.
 */
export class SpatialTileVisibilityController {
  private readonly records: TileRecord[];
  private readonly exactResidency = new Map<string, SpatialTileResidency>();
  private readonly frustum = new THREE.Frustum();
  private readonly projection = new THREE.Matrix4();
  private operationEpoch = 0;
  private disposed = false;
  private lastPlan: SpatialTileFramePlan | null = null;

  constructor(
    readonly lod: SpatialTileLodService,
    options: SpatialTileVisibilityOptions = {},
  ) {
    const records: TileRecord[] = [];
    const union = new THREE.Box3();
    for (const tile of lod.manifest.tiles) {
      if (tile.lods.length === 0 || tile.elements.length === 0) continue;
      const box = new THREE.Box3(
        new THREE.Vector3(tile.bounds[0], tile.bounds[1], tile.bounds[2]),
        new THREE.Vector3(tile.bounds[3], tile.bounds[4], tile.bounds[5]),
      );
      union.union(box);
      records.push({
        id: tile.id,
        localIds: tile.elements.map((element) => element.localId),
        box,
        hidden: false,
      });
      // The adapter currently exposes exact-only tiles. Keeping residency in
      // the real planner makes exact picking explicit and forward-compatible.
      this.exactResidency.set(tile.id, {
        readyLevels: new Set([0]),
        loadingLevels: new Set(),
        activeLevel: 0,
      });
    }
    const padFraction = Math.max(0, options.padFraction ?? 0.03);
    if (!union.isEmpty() && padFraction > 0) {
      const size = new THREE.Vector3();
      union.getSize(size);
      const padding = size.length() * padFraction;
      if (padding > 0) for (const record of records) record.box.expandByScalar(padding);
    }
    this.records = records;
  }

  get isBuilt(): boolean { return !this.disposed && this.records.length > 0; }
  get tileCount(): number { return this.records.length; }
  get elementCount(): number {
    return this.records.reduce((total, record) => total + record.localIds.length, 0);
  }
  get hiddenTileCount(): number { return this.records.filter((record) => record.hidden).length; }
  get hiddenElementCount(): number {
    return this.records.reduce(
      (total, record) => total + (record.hidden ? record.localIds.length : 0),
      0,
    );
  }
  getLastPlan(): SpatialTileFramePlan | null { return this.lastPlan; }

  getCulledLocalIds(): number[] {
    const ids: number[] = [];
    for (const record of this.records) if (record.hidden) ids.push(...record.localIds);
    return ids;
  }

  private updateFrustum(camera: THREE.Camera): void {
    camera.updateMatrixWorld();
    this.projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projection);
  }

  private visibleRecords(camera: THREE.Camera, pinnedLocalIds: ReadonlySet<number>): TileRecord[] {
    this.updateFrustum(camera);
    const pinnedTiles = new Set<string>();
    for (const localId of pinnedLocalIds) {
      const tile = this.lod.getTileForLocalId(localId);
      if (tile) pinnedTiles.add(tile.id);
    }
    return this.records.filter((record) => (
      pinnedTiles.has(record.id) || this.frustum.intersectsBox(record.box)
    ));
  }

  private viewFromCamera(camera: THREE.Camera, viewportHeightPx: number): SpatialTileView {
    // World-space position: camera.position is parent-local and diverges from
    // the frustum (built from matrixWorldInverse) when the camera is nested
    // under a transformed parent.
    const position = camera.getWorldPosition(new THREE.Vector3());
    if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
      const orthographic = camera as THREE.OrthographicCamera;
      return {
        projection: 'orthographic',
        cameraPosition: [position.x, position.y, position.z],
        viewportHeightPx: Math.max(1, viewportHeightPx),
        verticalSpan: Math.abs(orthographic.top - orthographic.bottom) / Math.max(orthographic.zoom, 1e-6),
      };
    }
    const perspective = camera as THREE.PerspectiveCamera;
    return {
      projection: 'perspective',
      cameraPosition: [position.x, position.y, position.z],
      viewportHeightPx: Math.max(1, viewportHeightPx),
      verticalFovRadians: THREE.MathUtils.degToRad(perspective.fov),
    };
  }

  private plan(
    camera: THREE.Camera,
    motion: SpatialTileMotionState,
    visible: readonly TileRecord[],
    pinnedLocalIds: ReadonlySet<number>,
    viewportHeightPx: number,
  ): SpatialTileFramePlan {
    const plan = this.lod.planFrame({
      view: this.viewFromCamera(camera, viewportHeightPx),
      motion,
      visibleTileIds: visible.map((record) => record.id),
      residency: this.exactResidency,
      exactElementLocalIds: pinnedLocalIds,
    });
    this.lastPlan = plan;
    return plan;
  }

  async tick(
    camera: THREE.Camera,
    visibility: VisibilityMutationTarget,
    options: {
      readonly pinnedLocalIds?: ReadonlySet<number>;
      readonly viewportHeightPx?: number;
    } = {},
  ): Promise<SpatialTileVisibilityResult> {
    const pinned = options.pinnedLocalIds ?? new Set<number>();
    if (!this.isBuilt) return this.emptyResult(camera, 'idle', pinned, options.viewportHeightPx);
    const epoch = ++this.operationEpoch;
    const visible = this.visibleRecords(camera, pinned);
    const visibleIds = new Set(visible.map((record) => record.id));
    const toShow = this.records.filter((record) => record.hidden && visibleIds.has(record.id));
    const toHide = this.records.filter((record) => !record.hidden && !visibleIds.has(record.id));
    const showIds = toShow.flatMap((record) => record.localIds);
    const hideIds = toHide.flatMap((record) => record.localIds);
    const lodPlan = this.plan(camera, 'idle', visible, pinned, options.viewportHeightPx ?? 1);

    if (hideIds.length > 0 || showIds.length > 0) {
      // The named mask is changed synchronously but its Promise acknowledges
      // only after rendering. Publish desired tile ownership first so an
      // overlapping navigation pass sees pending hides without sending every
      // visible tile's IDs through the coordinator on steady frames.
      for (const record of toShow) record.hidden = false;
      for (const record of toHide) record.hidden = true;
      try {
        if (visibility.applyVisibilityDelta) {
          await visibility.applyVisibilityDelta(hideIds, showIds);
        } else {
          if (showIds.length > 0) await visibility.setVisible(showIds, true);
          if (hideIds.length > 0) await visibility.setVisible(hideIds, false);
        }
      } catch (error) {
        if (epoch === this.operationEpoch && !this.disposed) {
          for (const record of toShow) record.hidden = true;
          for (const record of toHide) record.hidden = false;
        }
        throw error;
      }
    }
    return this.result(visible, showIds.length, hideIds.length, lodPlan);
  }

  /** Navigation path: reveal newly intersecting/pinned tiles, never hide. */
  async showPass(
    camera: THREE.Camera,
    visibility: VisibilityMutationTarget,
    options: {
      readonly pinnedLocalIds?: ReadonlySet<number>;
      readonly viewportHeightPx?: number;
    } = {},
  ): Promise<SpatialTileVisibilityResult> {
    const pinned = options.pinnedLocalIds ?? new Set<number>();
    if (!this.isBuilt) return this.emptyResult(camera, 'navigating', pinned, options.viewportHeightPx);
    const epoch = ++this.operationEpoch;
    const visible = this.visibleRecords(camera, pinned);
    const visibleIds = new Set(visible.map((record) => record.id));
    const toShow = this.records.filter((record) => record.hidden && visibleIds.has(record.id));
    const showIds = toShow.flatMap((record) => record.localIds);
    const lodPlan = this.plan(camera, 'navigating', visible, pinned, options.viewportHeightPx ?? 1);
    if (showIds.length > 0) {
      for (const record of toShow) record.hidden = false;
      try {
        await visibility.setVisible(showIds, true);
      } catch (error) {
        if (epoch === this.operationEpoch && !this.disposed) {
          for (const record of toShow) record.hidden = true;
        }
        throw error;
      }
    }
    return this.result(visible, showIds.length, 0, lodPlan);
  }

  /** Reveal selected/measured content immediately without changing other tiles. */
  async revealLocalIds(
    localIds: ReadonlySet<number>,
    visibility: VisibilityMutationTarget,
  ): Promise<number> {
    if (!this.isBuilt || localIds.size === 0) return 0;
    const epoch = ++this.operationEpoch;
    const tileIds = new Set<string>();
    for (const localId of localIds) {
      const tile = this.lod.getTileForLocalId(localId);
      if (tile) tileIds.add(tile.id);
    }
    const records = this.records.filter((record) => record.hidden && tileIds.has(record.id));
    const ids = records.flatMap((record) => record.localIds);
    if (ids.length === 0) return 0;
    for (const record of records) record.hidden = false;
    try {
      await visibility.setVisible(ids, true);
    } catch (error) {
      if (epoch === this.operationEpoch && !this.disposed) {
        for (const record of records) record.hidden = true;
      }
      throw error;
    }
    return ids.length;
  }

  async clearCull(visibility: VisibilityMutationTarget): Promise<void> {
    const epoch = ++this.operationEpoch;
    const hiddenRecords = this.records.filter((record) => record.hidden);
    const hidden = hiddenRecords.flatMap((record) => record.localIds);
    for (const record of hiddenRecords) record.hidden = false;
    try {
      if (visibility.clearVisibility) {
        await visibility.clearVisibility();
      } else if (hidden.length > 0) {
        await visibility.setVisible(hidden, true);
      }
      if (epoch === this.operationEpoch) {
        for (const record of this.records) record.hidden = false;
      }
    } catch (error) {
      if (epoch === this.operationEpoch && !this.disposed) {
        for (const record of hiddenRecords) record.hidden = true;
      }
      throw error;
    }
  }

  releaseOwnership(): void {
    this.operationEpoch += 1;
    for (const record of this.records) record.hidden = false;
  }

  async dispose(visibility?: VisibilityMutationTarget): Promise<void> {
    if (this.disposed) return;
    if (visibility) await this.clearCull(visibility);
    this.disposed = true;
    this.operationEpoch += 1;
  }

  private result(
    visible: readonly TileRecord[],
    revealedElementCount: number,
    newlyHiddenElementCount: number,
    lodPlan: SpatialTileFramePlan,
  ): SpatialTileVisibilityResult {
    return {
      visibleTileIds: visible.map((record) => record.id),
      hiddenTileCount: this.hiddenTileCount,
      hiddenElementCount: this.hiddenElementCount,
      revealedElementCount,
      newlyHiddenElementCount,
      lodPlan,
    };
  }

  private emptyResult(
    camera: THREE.Camera,
    motion: SpatialTileMotionState,
    pinned: ReadonlySet<number>,
    viewportHeightPx = 1,
  ): SpatialTileVisibilityResult {
    const plan = this.plan(camera, motion, [], pinned, viewportHeightPx);
    return this.result([], 0, 0, plan);
  }
}
