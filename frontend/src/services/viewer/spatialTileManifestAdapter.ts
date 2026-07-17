import type { SpatialTileManifestDto } from '../api';
import type {
  SpatialTileBounds,
  SpatialTileDescriptor,
  SpatialTileManifest,
} from './spatialTileLod';

export interface SpatialTileManifestAdaptOptions {
  /** Fingerprint of the model that is actually mounted in the viewer. */
  readonly mountedFingerprint: string;
  /** Express-ID to Fragments-local-ID bridge for that mounted model. */
  readonly expressToLocal: ReadonlyMap<number, number>;
}

export interface SpatialTileManifestAdaptResult {
  readonly manifest: SpatialTileManifest;
  readonly mappedElements: number;
  readonly unresolvedExpressIds: readonly number[];
  readonly emptyTileIds: readonly string[];
}

export interface SpatialTileBoundsRebaseResult {
  readonly manifest: SpatialTileManifestDto;
  readonly failedTileIds: readonly string[];
  readonly failedExpressIds: readonly number[];
}

function finiteBounds(min: readonly number[], max: readonly number[]): SpatialTileBounds | null {
  if (min.length !== 3 || max.length !== 3) return null;
  const values = [min[0], min[1], min[2], max[0], max[1], max[2]];
  if (!values.every(Number.isFinite)) return null;
  if (values[0] > values[3] || values[1] > values[4] || values[2] > values[5]) return null;
  return [values[0], values[1], values[2], values[3], values[4], values[5]];
}

function normalizeFingerprint(value: string): string {
  return value.trim().toLowerCase().replace(/^sha256:/, '');
}

/**
 * Rebase backend IFC-world bounds into the mounted fragment model's renderer
 * coordinate space without walking raw vertices. Backend tile membership is
 * retained, while FragmentsModel.getMergedBox supplies one conservative box
 * per tile after auto-coordinate/axis transforms have been applied.
 *
 * A tile without a proven renderer-space box is omitted, so its elements stay
 * conservatively visible instead of being culled against the wrong space.
 */
export async function rebaseSpatialTileManifestBounds(
  dto: SpatialTileManifestDto,
  expressToLocal: ReadonlyMap<number, number>,
  getMergedBounds: (localIds: readonly number[]) => Promise<SpatialTileBounds | null>,
  options: {
    readonly batchSize?: number;
    readonly isCancelled?: () => boolean;
    readonly yieldAfterBatch?: () => Promise<void> | void;
  } = {},
): Promise<SpatialTileBoundsRebaseResult> {
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 8));
  const rebasedTiles: SpatialTileManifestDto['tiles'] = [];
  const failedTileIds: string[] = [];
  const failedExpressIds = new Set<number>();
  let worldBounds: SpatialTileBounds | null = null;

  for (let start = 0; start < dto.tiles.length; start += batchSize) {
    if (options.isCancelled?.()) break;
    const batch = dto.tiles.slice(start, start + batchSize);
    const resolved = await Promise.all(batch.map(async (tile) => {
      const localIds: number[] = [];
      for (const expressId of new Set(tile.element_ids)) {
        const localId = expressToLocal.get(expressId);
        if (localId === undefined) failedExpressIds.add(expressId);
        else localIds.push(localId);
      }
      if (localIds.length === 0) return null;
      try {
        const bounds = await getMergedBounds(localIds);
        if (!bounds || !finiteBounds(bounds.slice(0, 3), bounds.slice(3, 6))) return null;
        return { tile, bounds };
      } catch {
        return null;
      }
    }));
    if (options.isCancelled?.()) break;
    for (let index = 0; index < resolved.length; index += 1) {
      const item = resolved[index];
      if (!item) {
        const failed = batch[index];
        if (failed) {
          failedTileIds.push(failed.tile_id);
          for (const expressId of failed.element_ids) failedExpressIds.add(expressId);
        }
        continue;
      }
      const { tile, bounds } = item;
      rebasedTiles.push({
        ...tile,
        aabb_min: [bounds[0], bounds[1], bounds[2]],
        aabb_max: [bounds[3], bounds[4], bounds[5]],
      });
      if (!worldBounds) {
        worldBounds = [bounds[0], bounds[1], bounds[2], bounds[3], bounds[4], bounds[5]];
      }
      else {
        worldBounds = [
          Math.min(worldBounds[0], bounds[0]),
          Math.min(worldBounds[1], bounds[1]),
          Math.min(worldBounds[2], bounds[2]),
          Math.max(worldBounds[3], bounds[3]),
          Math.max(worldBounds[4], bounds[4]),
          Math.max(worldBounds[5], bounds[5]),
        ];
      }
    }
    if (start + batchSize < dto.tiles.length) await options.yieldAfterBatch?.();
  }
  if (!worldBounds || rebasedTiles.length === 0) {
    throw new Error('No spatial tile bounds could be proven in renderer coordinates');
  }
  return {
    manifest: {
      ...dto,
      world_aabb_min: [worldBounds[0], worldBounds[1], worldBounds[2]],
      world_aabb_max: [worldBounds[3], worldBounds[4], worldBounds[5]],
      total_elements: rebasedTiles.reduce((total, tile) => total + tile.element_count, 0),
      total_tiles: rebasedTiles.length,
      tiles: rebasedTiles,
    },
    failedTileIds: failedTileIds.sort(),
    failedExpressIds: [...failedExpressIds].sort((a, b) => a - b),
  };
}

/**
 * Convert the backend Express-ID manifest into the immutable local-ID
 * artifact contract used by the viewer's residency/LOD planner.
 *
 * The current backend tiles expose exact geometry only. Representing that as
 * LOD0 is intentional: the same contract can gain simplified levels later
 * without changing semantic identity, picking, saved views, or visibility.
 */
export function adaptSpatialTileManifest(
  dto: SpatialTileManifestDto,
  options: SpatialTileManifestAdaptOptions,
): SpatialTileManifestAdaptResult {
  const sourceFingerprint = normalizeFingerprint(dto.source_sha256);
  const mountedFingerprint = normalizeFingerprint(options.mountedFingerprint);
  if (!sourceFingerprint || sourceFingerprint !== mountedFingerprint) {
    throw new Error('Spatial tile manifest does not belong to the mounted model');
  }
  if (dto.aabb_source !== 'real') {
    throw new Error(`Spatial tile manifest requires real geometry AABBs (received ${dto.aabb_source})`);
  }

  const rootBounds = finiteBounds(dto.world_aabb_min, dto.world_aabb_max);
  if (!rootBounds) throw new Error('Spatial tile manifest has invalid world bounds');

  const unresolved = new Set<number>();
  const emptyTileIds: string[] = [];
  const localOwners = new Map<number, string>();
  const contentTiles: SpatialTileDescriptor[] = [];

  for (const tile of [...dto.tiles].sort((a, b) => a.tile_id.localeCompare(b.tile_id))) {
    const bounds = finiteBounds(tile.aabb_min, tile.aabb_max);
    if (!bounds) throw new Error(`Spatial tile ${tile.tile_id} has invalid bounds`);
    const elements = [];
    for (const expressId of new Set(tile.element_ids)) {
      const localId = options.expressToLocal.get(expressId);
      if (localId === undefined) {
        unresolved.add(expressId);
        continue;
      }
      const owner = localOwners.get(localId);
      if (owner && owner !== tile.tile_id) {
        throw new Error(`Local element ${localId} is assigned to both ${owner} and ${tile.tile_id}`);
      }
      localOwners.set(localId, tile.tile_id);
      elements.push({
        localId,
        expressId,
        elementKey: `${sourceFingerprint}:${localId}`,
      });
    }
    elements.sort((a, b) => a.localId - b.localId);
    if (elements.length === 0) {
      emptyTileIds.push(tile.tile_id);
      continue;
    }
    contentTiles.push({
      id: tile.tile_id,
      parentId: 'root',
      bounds,
      elements,
      lods: [{
        level: 0,
        kind: 'exact',
        geometricError: 0,
        contentId: `ifc-tile://${sourceFingerprint}/${dto.grid_resolution}/${encodeURIComponent(tile.tile_id)}/lod0`,
      }],
    });
  }

  if (contentTiles.length === 0) {
    throw new Error('Spatial tile manifest contains no elements that exist in the mounted model');
  }

  const manifest: SpatialTileManifest = {
    schemaVersion: 1,
    sourceFingerprint,
    settingsHash: `grid:${dto.grid_resolution};aabb:real;adapter:1`,
    tiles: [
      {
        id: 'root',
        parentId: null,
        bounds: rootBounds,
        elements: [],
        lods: [],
      },
      ...contentTiles,
    ],
  };

  return {
    manifest,
    mappedElements: localOwners.size,
    unresolvedExpressIds: [...unresolved].sort((a, b) => a - b),
    emptyTileIds,
  };
}
