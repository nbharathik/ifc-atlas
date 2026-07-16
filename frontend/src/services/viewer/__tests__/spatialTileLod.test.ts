import { describe, expect, it } from 'vitest';

import {
  SpatialTileLodService,
  SpatialTileManifestError,
  computeTileScreenSpaceError,
  distanceToTileBounds,
  projectWorldErrorPx,
  selectSpatialTileLod,
  validateSpatialTileManifest,
  type SpatialTileDescriptor,
  type SpatialTileManifest,
  type SpatialTileResidency,
  type SpatialTileView,
} from '../spatialTileLod';

const view: SpatialTileView = {
  projection: 'perspective',
  cameraPosition: [5, 5, 0],
  viewportHeightPx: 1_000,
  verticalFovRadians: Math.PI / 2,
};

function makeContentTile(
  id: string,
  bounds: SpatialTileDescriptor['bounds'],
  elements: SpatialTileDescriptor['elements'],
): SpatialTileDescriptor {
  return {
    id,
    parentId: 'root',
    bounds,
    elements,
    // Deliberately unordered: the service normalizes producer order while
    // validation checks monotonic error by numeric level.
    lods: [
      { level: 2, kind: 'simplified', geometricError: 0.1, contentId: `${id}:lod2`, byteLength: 10 },
      { level: 0, kind: 'exact', geometricError: 0, contentId: `${id}:lod0`, byteLength: 100 },
      { level: 1, kind: 'simplified', geometricError: 0.02, contentId: `${id}:lod1`, byteLength: 40 },
    ],
  };
}

function makeManifest(): SpatialTileManifest {
  return {
    schemaVersion: 1,
    sourceFingerprint: 'sha256:model',
    settingsHash: 'settings:v2',
    tiles: [
      {
        id: 'root',
        bounds: [0, 0, 0, 30, 10, 20],
        elements: [],
        lods: [],
      },
      makeContentTile('tile-a', [0, 0, 10, 10, 10, 20], [
        { localId: 101, expressId: 1_001, globalId: 'guid-a', elementKey: 'model:101' },
        { localId: 102, expressId: 1_002, globalId: 'guid-b', elementKey: 'model:102' },
      ]),
      makeContentTile('tile-b', [20, 0, 10, 30, 10, 20], [
        { localId: 201, expressId: 2_001, globalId: 'guid-c', elementKey: 'model:201' },
      ]),
    ],
  };
}

function residency(
  ready: number[],
  active: number | null = null,
  loading: number[] = [],
): SpatialTileResidency {
  return {
    readyLevels: new Set(ready),
    loadingLevels: new Set(loading),
    activeLevel: active,
  };
}

function makeService(maxRequestsPerFrame = 4): SpatialTileLodService {
  return new SpatialTileLodService(makeManifest(), {
    idleMaxErrorPx: 2,
    navigationMaxErrorPx: 6,
    hysteresisRatio: 0,
    maxRequestsPerFrame,
  });
}

describe('spatial tile manifest and identity index', () => {
  it('normalizes immutable LOD order and resolves both stable identity spaces', () => {
    const service = makeService();
    const tile = service.getTile('tile-a')!;

    expect(tile.lods.map((lod) => lod.level)).toEqual([0, 1, 2]);
    expect(service.getTileForLocalId(101)?.id).toBe('tile-a');
    expect(service.getTileForElementKey('model:201')?.id).toBe('tile-b');
    expect(service.getElementIdentity(101)).toMatchObject({
      localId: 101,
      elementKey: 'model:101',
      expressId: 1_001,
    });
    expect(service.getChildren('root').map((child) => child.id)).toEqual(['tile-a', 'tile-b']);
    expect(service.getRootTiles().map((root) => root.id)).toEqual(['root']);
    expect(Object.isFrozen(service.manifest)).toBe(true);
    expect(Object.isFrozen(tile.elements)).toBe(true);
    expect(Object.isFrozen(tile.lods)).toBe(true);
  });

  it('queries content tiles by spatial bounds without returning hierarchy-only groups', () => {
    const service = makeService();
    expect(service.queryTilesIntersecting([5, 0, 12, 15, 10, 18]).map((tile) => tile.id)).toEqual(['tile-a']);
    expect(service.queryTilesIntersecting([9, 0, 12, 21, 10, 18]).map((tile) => tile.id)).toEqual([
      'tile-a',
      'tile-b',
    ]);
    expect(service.queryTilesIntersecting([2, 2, 2, 1, 1, 1])).toEqual([]);
  });

  it('rejects duplicate semantic ownership so an element cannot move between tiles or LODs', () => {
    const manifest = makeManifest();
    const duplicate = makeContentTile('tile-c', [0, 0, 0, 5, 5, 5], [
      { localId: 101, elementKey: 'model:101' },
    ]);
    const invalid = { ...manifest, tiles: [...manifest.tiles, duplicate] };
    const codes = validateSpatialTileManifest(invalid).map((issue) => issue.code);

    expect(codes).toContain('duplicate-local-id');
    expect(codes).toContain('duplicate-element-key');
    expect(() => new SpatialTileLodService(invalid)).toThrow(SpatialTileManifestError);
  });

  it('rejects missing exact content, non-monotonic error, broken parents, and hierarchy cycles', () => {
    const manifest = makeManifest();
    const brokenA: SpatialTileDescriptor = {
      ...manifest.tiles[1]!,
      parentId: 'tile-b',
      lods: [
        { level: 0, kind: 'simplified', geometricError: 1, contentId: 'broken:0' },
        { level: 1, kind: 'simplified', geometricError: 0.5, contentId: 'broken:1' },
      ],
    };
    const brokenB: SpatialTileDescriptor = {
      ...manifest.tiles[2]!,
      parentId: 'tile-a',
    };
    const invalid = { ...manifest, tiles: [manifest.tiles[0]!, brokenA, brokenB] };
    const codes = validateSpatialTileManifest(invalid).map((issue) => issue.code);

    expect(codes).toContain('missing-exact-lod');
    expect(codes).toContain('invalid-lod');
    expect(codes).toContain('hierarchy-cycle');
    expect(codes).toContain('child-outside-parent');
  });
});

describe('screen-space-error policy', () => {
  it('projects perspective error from distance to the tile bounds', () => {
    const tile = makeService().getTile('tile-a')!;

    expect(distanceToTileBounds(view.cameraPosition, tile.bounds)).toBe(10);
    expect(computeTileScreenSpaceError(tile, tile.lods[1]!, view)).toBeCloseTo(1, 8);
    expect(computeTileScreenSpaceError(tile, tile.lods[2]!, view)).toBeCloseTo(5, 8);
  });

  it('supports orthographic projection and safely forces exact when the camera is inside a tile', () => {
    const tile = makeService().getTile('tile-a')!;
    const orthographic: SpatialTileView = {
      projection: 'orthographic',
      cameraPosition: [5, 5, 0],
      viewportHeightPx: 1_000,
      verticalSpan: 100,
    };

    expect(projectWorldErrorPx(0.1, tile.bounds, orthographic)).toBeCloseTo(1);
    expect(projectWorldErrorPx(0.1, tile.bounds, { ...view, cameraPosition: [5, 5, 15] })).toBe(Infinity);
    expect(projectWorldErrorPx(0, tile.bounds, { ...view, cameraPosition: [5, 5, 15] })).toBe(0);
  });

  it('selects the coarsest level within the active pixel budget and can force exact', () => {
    const tile = makeService().getTile('tile-a')!;

    expect(selectSpatialTileLod(tile, view, 2).level).toBe(1);
    expect(selectSpatialTileLod(tile, view, 6).level).toBe(2);
    expect(selectSpatialTileLod(tile, view, 6, 2, 0.1, true).level).toBe(0);
  });

  it('uses hysteresis to prevent threshold jitter in both directions', () => {
    const tile = makeService().getTile('tile-a')!;
    const justInsideCoarseBand = { ...view, cameraPosition: [5, 5, -17.78] } as const;
    const safelyCoarse = { ...view, cameraPosition: [5, 5, -23.34] } as const;
    const coarseStillInsideUpperBand = { ...view, cameraPosition: [5, 5, -12.73] } as const;
    const mustRefine = { ...view, cameraPosition: [5, 5, -10] } as const;

    expect(selectSpatialTileLod(tile, justInsideCoarseBand, 2, 1, 0.2).level).toBe(1);
    expect(selectSpatialTileLod(tile, safelyCoarse, 2, 1, 0.2).level).toBe(2);
    expect(selectSpatialTileLod(tile, coarseStillInsideUpperBand, 2, 2, 0.2).level).toBe(2);
    expect(selectSpatialTileLod(tile, mustRefine, 2, 2, 0.2).level).toBe(1);
  });
});

describe('frame residency planning', () => {
  it('retains the current representation until a requested replacement is ready', () => {
    const service = makeService();
    const current = new Map([['tile-a', residency([1], 1)]]);
    const moving = service.planFrame({
      view,
      motion: 'navigating',
      visibleTileIds: ['tile-a'],
      residency: current,
    });

    expect(moving.decisions[0]).toMatchObject({
      desiredLevel: 2,
      previousActiveLevel: 1,
      renderLevel: 1,
      transition: 'retain-while-loading',
      requestState: 'queued',
    });
    expect(moving.requests).toEqual([
      expect.objectContaining({ tileId: 'tile-a', level: 2, reason: 'coarsen' }),
    ]);

    const replacementReady = service.planFrame({
      view,
      motion: 'navigating',
      visibleTileIds: ['tile-a'],
      residency: new Map([['tile-a', residency([1, 2], 1)]]),
    });
    expect(replacementReady.decisions[0]).toMatchObject({
      desiredLevel: 2,
      previousActiveLevel: 1,
      renderLevel: 2,
      transition: 'activate-ready',
    });
  });

  it('prioritises cheap first representations and applies deterministic backpressure', () => {
    const service = makeService(2);
    const plan = service.planFrame({
      view,
      motion: 'idle',
      visibleTileIds: ['tile-b', 'tile-a'],
      residency: new Map(),
    });

    expect(plan.requests.map((request) => [request.tileId, request.level, request.reason])).toEqual([
      ['tile-a', 2, 'initial'],
      ['tile-b', 2, 'initial'],
    ]);
    expect(plan.deferredRequests.map((request) => [request.tileId, request.level, request.reason])).toEqual([
      ['tile-a', 1, 'refine'],
      ['tile-b', 1, 'refine'],
    ]);
    expect(plan.decisions.every((decision) => decision.renderLevel === null)).toBe(true);
    expect(plan.decisions.every((decision) => decision.requestState === 'deferred')).toBe(true);
  });

  it('keeps an in-flight bootstrap on the only path to first pixels', () => {
    const service = makeService();
    const plan = service.planFrame({
      view,
      motion: 'idle',
      visibleTileIds: ['tile-a'],
      residency: new Map([['tile-a', residency([], null, [2])]]),
    });

    expect(plan.cancellations).not.toContainEqual(expect.objectContaining({ tileId: 'tile-a', level: 2 }));
    expect(plan.requests).toContainEqual(expect.objectContaining({ tileId: 'tile-a', level: 1 }));
  });

  it('activates a resident bootstrap when no representation is currently attached', () => {
    const service = makeService();
    const plan = service.planFrame({
      view,
      motion: 'idle',
      visibleTileIds: ['tile-a'],
      residency: new Map([['tile-a', residency([2], null)]]),
    });

    expect(plan.decisions[0]).toMatchObject({
      desiredLevel: 1,
      previousActiveLevel: null,
      renderLevel: 2,
      transition: 'activate-fallback',
    });
    expect(plan.requests).toContainEqual(expect.objectContaining({
      tileId: 'tile-a',
      level: 1,
      reason: 'refine',
    }));
  });

  it('cancels invisible camera-teleport work and superseded non-exact visible work', () => {
    const service = makeService();
    const teleported = service.planFrame({
      view,
      motion: 'idle',
      visibleTileIds: ['tile-b'],
      residency: new Map([
        ['tile-a', residency([], null, [1, 2])],
        ['tile-b', residency([1], 1)],
      ]),
    });

    expect(teleported.cancellations).toEqual([
      { tileId: 'tile-a', level: 1, reason: 'invisible' },
      { tileId: 'tile-a', level: 2, reason: 'invisible' },
    ]);

    const superseded = service.planFrame({
      view,
      motion: 'idle',
      visibleTileIds: ['tile-a'],
      residency: new Map([['tile-a', residency([1], 1, [0, 2])]]),
    });
    expect(superseded.cancellations).toEqual([
      { tileId: 'tile-a', level: 2, reason: 'superseded' },
    ]);
  });

  it('forces exact for leased elements, reports unknown IDs, and never substitutes simplified geometry', () => {
    const service = makeService();
    const waiting = service.planFrame({
      view,
      motion: 'navigating',
      visibleTileIds: [],
      residency: new Map([['tile-a', residency([2], 2)]]),
      exactElementLocalIds: [101, 999],
    });

    expect(waiting.unresolvedExactElementIds).toEqual([999]);
    expect(waiting.exactPickReady).toBe(false);
    expect(waiting.decisions[0]).toMatchObject({
      tileId: 'tile-a',
      desiredLevel: 0,
      renderLevel: 2,
      exactRequired: true,
      exactReady: false,
      transition: 'retain-while-loading',
    });
    expect(waiting.requests).toEqual([
      expect.objectContaining({ tileId: 'tile-a', level: 0, reason: 'exact-pick' }),
    ]);

    const exactReady = service.planFrame({
      view,
      motion: 'navigating',
      visibleTileIds: [],
      residency: new Map([['tile-a', residency([0, 2], 2)]]),
      exactElementLocalIds: [101],
    });
    expect(exactReady.exactPickReady).toBe(true);
    expect(exactReady.decisions[0]).toMatchObject({ renderLevel: 0, transition: 'activate-ready' });
  });

  it('reports unknown visible tile IDs without producing phantom load requests', () => {
    const service = makeService();
    const plan = service.planFrame({
      view,
      motion: 'idle',
      visibleTileIds: ['missing'],
      residency: new Map(),
    });

    expect(plan.unknownVisibleTileIds).toEqual(['missing']);
    expect(plan.decisions).toEqual([]);
    expect(plan.requests).toEqual([]);
  });
});

describe('exact geometry pick planning', () => {
  it('turns coarse tile candidates into level-0 targets without accepting simplified residency', () => {
    const service = makeService();
    const plan = service.planExactPickTiles(
      ['tile-b', 'missing', 'tile-a', 'tile-a'],
      new Map([
        ['tile-a', residency([2], 2)],
        ['tile-b', residency([0, 2], 2)],
      ]),
    );

    expect(plan.ready).toBe(false);
    expect(plan.unresolvedTileIds).toEqual(['missing']);
    expect(plan.targets).toEqual([
      expect.objectContaining({
        tileId: 'tile-a',
        exactLevel: 0,
        elementLocalIds: [101, 102],
        ready: false,
      }),
      expect.objectContaining({
        tileId: 'tile-b',
        exactLevel: 0,
        elementLocalIds: [201],
        ready: true,
      }),
    ]);
    expect(plan.requests).toEqual([
      expect.objectContaining({ tileId: 'tile-a', level: 0, reason: 'exact-pick' }),
    ]);
  });

  it('deduplicates tile loads while preserving every stable element identity', () => {
    const service = makeService();
    const plan = service.planExactPickGeometry(
      [102, 101, 101],
      new Map([['tile-a', residency([2], 2)]]),
    );

    expect(plan.ready).toBe(false);
    expect(plan.targets.map((target) => ({
      localId: target.localId,
      key: target.elementKey,
      exact: target.exactLevel,
      ready: target.ready,
    }))).toEqual([
      { localId: 101, key: 'model:101', exact: 0, ready: false },
      { localId: 102, key: 'model:102', exact: 0, ready: false },
    ]);
    expect(plan.requests).toEqual([
      expect.objectContaining({ tileId: 'tile-a', level: 0, contentId: 'tile-a:lod0' }),
    ]);
  });

  it('is ready only for resident exact payloads, regardless of the active visual LOD', () => {
    const service = makeService();
    const plan = service.planExactPickGeometry(
      [101],
      new Map([['tile-a', residency([0, 2], 2)]]),
    );

    expect(plan.ready).toBe(true);
    expect(plan.targets[0]).toMatchObject({ localId: 101, exactLevel: 0, ready: true });
    expect(plan.requests).toEqual([]);
  });

  it('prioritises exact requests, respects a load limit, and reports unresolved IDs', () => {
    const service = makeService();
    const plan = service.planExactPickGeometry([201, 999, 101], new Map(), 1);

    expect(plan.ready).toBe(false);
    expect(plan.unresolvedLocalIds).toEqual([999]);
    expect(plan.requests).toHaveLength(1);
    expect(plan.deferredRequests).toHaveLength(1);
    expect(plan.requests[0]).toMatchObject({ tileId: 'tile-a', reason: 'exact-pick' });
    expect(plan.deferredRequests[0]).toMatchObject({ tileId: 'tile-b', reason: 'exact-pick' });
  });
});
