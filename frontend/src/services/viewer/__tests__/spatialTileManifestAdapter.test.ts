import { describe, expect, it } from 'vitest';

import type { SpatialTileManifestDto } from '../../api';
import { SpatialTileLodService } from '../spatialTileLod';
import {
  adaptSpatialTileManifest,
  rebaseSpatialTileManifestBounds,
} from '../spatialTileManifestAdapter';

const dto: SpatialTileManifestDto = {
  source_sha256: 'AABBCC',
  grid_resolution: 4,
  world_aabb_min: [0, 0, 0],
  world_aabb_max: [10, 10, 10],
  total_elements: 3,
  total_tiles: 2,
  aabb_source: 'real',
  tiles: [
    {
      tile_id: '0-1-0',
      storey_idx: 0,
      cell_x: 1,
      cell_y: 0,
      aabb_min: [5, 0, 0],
      aabb_max: [10, 10, 10],
      element_ids: [12],
      element_count: 1,
    },
    {
      tile_id: '0-0-0',
      storey_idx: 0,
      cell_x: 0,
      cell_y: 0,
      aabb_min: [0, 0, 0],
      aabb_max: [5, 10, 10],
      element_ids: [10, 11],
      element_count: 2,
    },
  ],
};

describe('adaptSpatialTileManifest', () => {
  it('bridges Express IDs to stable exact local-ID tiles accepted by the LOD service', () => {
    const result = adaptSpatialTileManifest(dto, {
      mountedFingerprint: 'sha256:aabbcc',
      expressToLocal: new Map([[10, 100], [11, 101], [12, 102]]),
    });

    expect(result.mappedElements).toBe(3);
    expect(result.manifest.tiles.map((tile) => tile.id)).toEqual(['root', '0-0-0', '0-1-0']);
    expect(result.manifest.tiles[1]?.elements).toEqual([
      { localId: 100, expressId: 10, elementKey: 'aabbcc:100' },
      { localId: 101, expressId: 11, elementKey: 'aabbcc:101' },
    ]);
    expect(result.manifest.tiles[1]?.lods[0]).toMatchObject({
      level: 0,
      kind: 'exact',
      geometricError: 0,
    });

    const service = new SpatialTileLodService(result.manifest);
    expect(service.getTileForLocalId(102)?.id).toBe('0-1-0');
  });

  it('rejects stale and placement-only manifests before they can hide geometry', () => {
    expect(() => adaptSpatialTileManifest(dto, {
      mountedFingerprint: 'different',
      expressToLocal: new Map([[10, 100]]),
    })).toThrow(/mounted model/i);

    expect(() => adaptSpatialTileManifest({ ...dto, aabb_source: 'placement' }, {
      mountedFingerprint: 'aabbcc',
      expressToLocal: new Map([[10, 100]]),
    })).toThrow(/real geometry AABBs/i);
  });

  it('reports unresolved IDs and removes empty tiles without weakening the contract', () => {
    const result = adaptSpatialTileManifest(dto, {
      mountedFingerprint: 'aabbcc',
      expressToLocal: new Map([[10, 100], [11, 101]]),
    });

    expect(result.unresolvedExpressIds).toEqual([12]);
    expect(result.emptyTileIds).toEqual(['0-1-0']);
    expect(result.mappedElements).toBe(2);
    expect(() => new SpatialTileLodService(result.manifest)).not.toThrow();
  });

  it('rejects duplicate local ownership across tiles', () => {
    expect(() => adaptSpatialTileManifest(dto, {
      mountedFingerprint: 'aabbcc',
      expressToLocal: new Map([[10, 100], [11, 101], [12, 100]]),
    })).toThrow(/assigned to both/i);
  });

  it('rebases IFC-world tiles into mounted renderer coordinates and drops unproven tiles', async () => {
    const result = await rebaseSpatialTileManifestBounds(
      dto,
      new Map([[10, 100], [11, 101], [12, 102]]),
      async (localIds) => {
        if (localIds.includes(102)) return null;
        return [100, 200, 300, 110, 220, 330];
      },
      { batchSize: 1 },
    );

    expect(result.manifest.tiles).toHaveLength(1);
    expect(result.manifest.tiles[0]).toMatchObject({
      tile_id: '0-0-0',
      aabb_min: [100, 200, 300],
      aabb_max: [110, 220, 330],
    });
    expect(result.manifest.world_aabb_min).toEqual([100, 200, 300]);
    expect(result.manifest.world_aabb_max).toEqual([110, 220, 330]);
    expect(result.failedTileIds).toEqual(['0-1-0']);
    expect(result.failedExpressIds).toEqual([12]);
  });
});
