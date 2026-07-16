import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchSpatialTileFragment } from '../api';

function response(headers: Record<string, string>, body = new Uint8Array([1, 2, 3])) {
  return new Response(body, { status: 200, headers });
}

const expectedHeaders = {
  'Content-Type': 'application/octet-stream',
  'X-Fragment-Source': 'tile-cache',
  'X-Fragment-Profile': 'balanced',
  'X-Fragment-Tile-Id': '2-1-3',
  'X-Fragment-Grid': '4',
  'X-Fragment-AABB-Source': 'real',
  'X-Fragment-Cache-Key': 'cache-key',
  'X-Fragment-Artifact-Schema': '2',
  'X-Fragments-Format-Version': '1.0',
};

afterEach(() => vi.unstubAllGlobals());

describe('fetchSpatialTileFragment', () => {
  it('validates artifact identity and returns standalone fragment bytes', async () => {
    const fetchMock = vi.fn(async () => response(expectedHeaders));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchSpatialTileFragment({
      fingerprint: 'abc',
      gridResolution: 4,
      tileId: '2-1-3',
      profile: 'balanced',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/ifc/fragments/tile?sha=abc&grid=4&tile_id=2-1-3&profile=balanced',
      undefined,
    );
    expect([...result.bytes]).toEqual([1, 2, 3]);
    expect(result).toMatchObject({
      source: 'tile-cache',
      profile: 'balanced',
      tileId: '2-1-3',
      gridResolution: 4,
      aabbSource: 'real',
      cacheKey: 'cache-key',
      artifactSchema: '2',
      fragmentsFormatVersion: '1.0',
    });
  });

  it('rejects a mismatched response before a stale tile can be mounted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      ...expectedHeaders,
      'X-Fragment-Tile-Id': 'wrong-tile',
    })));

    await expect(fetchSpatialTileFragment({
      fingerprint: 'abc',
      gridResolution: 4,
      tileId: '2-1-3',
      profile: 'balanced',
    })).rejects.toThrow(/identity/i);
  });

  it('rejects a response authored from a different source model', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      ...expectedHeaders,
      'X-Fragment-Source-Sha': 'other-model-sha',
    })));

    await expect(fetchSpatialTileFragment({
      fingerprint: 'abc',
      gridResolution: 4,
      tileId: '2-1-3',
      profile: 'balanced',
    })).rejects.toThrow(/identity/i);
  });

  it('accepts a matching source provenance header', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      ...expectedHeaders,
      'X-Fragment-Source-Sha': 'abc',
    })));

    const result = await fetchSpatialTileFragment({
      fingerprint: 'abc',
      gridResolution: 4,
      tileId: '2-1-3',
      profile: 'balanced',
    });

    expect(result.tileId).toBe('2-1-3');
  });

  it('keeps backend parity/cache failures explicit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('parity failed', { status: 503 })));

    await expect(fetchSpatialTileFragment({
      fingerprint: 'abc',
      gridResolution: 4,
      tileId: '2-1-3',
      profile: 'balanced',
    })).rejects.toThrow(/503.*parity failed/i);
  });
});

