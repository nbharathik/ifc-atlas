import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  extractStoreyNodes,
} from '../streamingLoader';
import type { SpatialNode } from '../../../types/ifc';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeNode(
  id: number,
  ifc_type: string,
  children: SpatialNode[] = [],
  name = `node${id}`,
): SpatialNode {
  return { id, ifc_type, name, children, global_id: '' };
}

function makeTree(): SpatialNode {
  // Project → Site → Building → [Ground Floor, First Floor]
  const gfWall1 = makeNode(10, 'IfcWall', [], 'GFWall1');
  const gfWall2 = makeNode(11, 'IfcWall', [], 'GFWall2');
  const gfDoor  = makeNode(12, 'IfcDoor', [], 'GFDoor');
  const groundFloor = makeNode(2, 'IfcBuildingStorey', [gfWall1, gfWall2, gfDoor], 'Ground Floor');

  const ffWall  = makeNode(20, 'IfcWall', [], 'FFWall');
  const ffWindow = makeNode(21, 'IfcWindow', [], 'FFWindow');
  const firstFloor = makeNode(3, 'IfcBuildingStorey', [ffWall, ffWindow], 'First Floor');

  const building = makeNode(1, 'IfcBuilding', [groundFloor, firstFloor]);
  const site = makeNode(0, 'IfcSite', [building]);
  return makeNode(-1, 'IfcProject', [site]);
}

// ── extractStoreyNodes ────────────────────────────────────────────────────────

describe('extractStoreyNodes', () => {
  it('returns [] for null root', () => {
    expect(extractStoreyNodes(null)).toEqual([]);
  });

  it('returns [] when no storeys in tree', () => {
    const root = makeNode(1, 'IfcProject', [makeNode(2, 'IfcSite', [])]);
    expect(extractStoreyNodes(root)).toEqual([]);
  });

  it('extracts storey nodes in depth-first order', () => {
    const tree = makeTree();
    const storeys = extractStoreyNodes(tree);
    expect(storeys).toHaveLength(2);
    expect(storeys[0].name).toBe('Ground Floor');
    expect(storeys[1].name).toBe('First Floor');
  });

  it('extracts single storey', () => {
    const gf = makeNode(2, 'IfcBuildingStorey', [], 'GF');
    const root = makeNode(0, 'IfcProject', [makeNode(1, 'IfcBuilding', [gf])]);
    const storeys = extractStoreyNodes(root);
    expect(storeys).toHaveLength(1);
    expect(storeys[0]).toBe(gf);
  });

  it('handles ifc_type case-insensitively', () => {
    const gf = makeNode(2, 'IFCBUILDINGSTOREY', [], 'GF');
    const root = makeNode(0, 'ifcproject', [gf]);
    expect(extractStoreyNodes(root)).toHaveLength(1);
  });

  it('does not include IfcProject itself even if type is storey', () => {
    // Edge: a single root node that IS a storey
    const root = makeNode(1, 'IfcBuildingStorey', []);
    const storeys = extractStoreyNodes(root);
    expect(storeys).toHaveLength(1);
    expect(storeys[0]).toBe(root);
  });
});

// ── buildRevealSequence ───────────────────────────────────────────────────────

// ── revealStoreyByStorey ──────────────────────────────────────────────────────

// ── fetchStoreyFragment + createStoreyStreamingLoader ────────────────────────

import {
  fetchStoreyFragment,
  type StoreyFragmentResult,
} from '../streamingLoader';

describe('fetchStoreyFragment', () => {
  const mockFetch = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    const resp = new Response(
      typeof body === 'string' ? body : JSON.stringify(body),
      {
        status,
        headers: {
          'Content-Type': status === 200 ? 'application/octet-stream' : 'application/json',
          ...headers,
        },
      },
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp));
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns bytes + source + storeyName on 200', async () => {
    mockFetch(200, 'FRAG_BYTES', {
      'X-Fragment-Source': 'sidecar',
      'X-Fragment-Storey-Name': 'Ground Floor',
    });
    const result = await fetchStoreyFragment('sha123', 0);
    expect(result.source).toBe('sidecar');
    expect(result.storeyName).toBe('Ground Floor');
    expect(result.bytes.byteLength).toBeGreaterThan(0);
  });

  it('throws on 204 (empty storey)', async () => {
    // Response constructor rejects 204 in test env; use a plain mock object.
    const resp204 = { status: 204, ok: false, headers: new Headers() };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp204));
    await expect(fetchStoreyFragment('sha123', 0)).rejects.toThrow('204');
  });

  it('throws on 404 with detail message', async () => {
    mockFetch(404, { detail: 'SHA mismatch' });
    await expect(fetchStoreyFragment('sha123', 0)).rejects.toThrow('SHA mismatch');
  });

  it('includes HTTP status in error message on non-OK response', async () => {
    mockFetch(503, { detail: 'sidecar error' });
    await expect(fetchStoreyFragment('sha123', 0)).rejects.toThrow('503');
  });

  it('builds the correct URL with sha + idx', async () => {
    mockFetch(200, 'BYTES', { 'X-Fragment-Source': 'cache', 'X-Fragment-Storey-Name': 'GF' });
    await fetchStoreyFragment('deadbeef', 2);
    const fetchMock = vi.mocked(fetch);
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain('sha=deadbeef');
    expect(calledUrl).toContain('idx=2');
  });

  it('uses "unknown" source when X-Fragment-Source header is absent', async () => {
    const resp = new Response('BYTES', { status: 200 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp));
    const result = await fetchStoreyFragment('sha', 0);
    expect(result.source).toBe('unknown');
  });
});

