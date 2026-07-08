import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  extractStoreyNodes,
  buildRevealSequence,
  revealStoreyByStorey,
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

describe('buildRevealSequence', () => {
  it('returns [] for empty storey list', () => {
    expect(buildRevealSequence([])).toEqual([]);
  });

  it('returns one step for a single storey', () => {
    const tree = makeTree();
    const [gf] = extractStoreyNodes(tree);
    const seq = buildRevealSequence([gf]);
    expect(seq).toHaveLength(1);
    // Ground floor has 3 leaf elements: 10, 11, 12
    expect(seq[0].sort((a, b) => a - b)).toEqual([10, 11, 12]);
  });

  it('accumulates ids across steps', () => {
    const tree = makeTree();
    const storeys = extractStoreyNodes(tree);
    const seq = buildRevealSequence(storeys);
    expect(seq).toHaveLength(2);
    // Step 0: ground floor only
    expect(seq[0].sort((a, b) => a - b)).toEqual([10, 11, 12]);
    // Step 1: ground + first floor
    expect(seq[1].sort((a, b) => a - b)).toEqual([10, 11, 12, 20, 21]);
  });

  it('containers are excluded from leaf collection', () => {
    // A storey containing a nested storey should not include the nested storey itself
    const innerStorey = makeNode(99, 'IfcBuildingStorey', [makeNode(100, 'IfcWall', [])]);
    const outerStorey = makeNode(50, 'IfcBuildingStorey', [innerStorey]);
    const seq = buildRevealSequence([outerStorey]);
    // 99 (IfcBuildingStorey) should be excluded; 100 (IfcWall) included
    expect(seq[0]).not.toContain(99);
    expect(seq[0]).toContain(100);
  });
});

// ── revealStoreyByStorey ──────────────────────────────────────────────────────

describe('revealStoreyByStorey', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls clearVisibility immediately for single-storey models (no animation)', () => {
    const root = makeNode(0, 'IfcProject', [
      makeNode(1, 'IfcBuilding', [
        makeNode(2, 'IfcBuildingStorey', [makeNode(10, 'IfcWall', [])]),
      ]),
    ]);
    const setIsolatedIds = vi.fn();
    const clearVisibility = vi.fn();

    revealStoreyByStorey(root, { setIsolatedIds, clearVisibility });

    // Single storey → minStoreys=2 guard → immediate clearVisibility
    expect(clearVisibility).toHaveBeenCalledOnce();
    expect(setIsolatedIds).not.toHaveBeenCalled();
  });

  it('reveals ground floor first then clears after delay for multi-storey', () => {
    const tree = makeTree();
    const setIsolatedIds = vi.fn();
    const clearVisibility = vi.fn();

    revealStoreyByStorey(tree, { setIsolatedIds, clearVisibility }, { delayMs: 100 });

    // Step 0 fires synchronously (first storey shown immediately)
    expect(setIsolatedIds).toHaveBeenCalledOnce();
    expect(setIsolatedIds.mock.calls[0][0].sort((a: number, b: number) => a - b)).toEqual([10, 11, 12]);

    vi.advanceTimersByTime(100);
    // Step 1: both floors visible
    expect(setIsolatedIds).toHaveBeenCalledTimes(2);
    expect(setIsolatedIds.mock.calls[1][0].sort((a: number, b: number) => a - b)).toEqual([10, 11, 12, 20, 21]);

    vi.advanceTimersByTime(100);
    // All storeys done → clearVisibility
    expect(clearVisibility).toHaveBeenCalledOnce();
  });

  it('calls clearVisibility immediately for null root', () => {
    const setIsolatedIds = vi.fn();
    const clearVisibility = vi.fn();
    revealStoreyByStorey(null, { setIsolatedIds, clearVisibility });
    expect(clearVisibility).toHaveBeenCalledOnce();
    expect(setIsolatedIds).not.toHaveBeenCalled();
  });

  it('cancel() stops animation and clears visibility', () => {
    const tree = makeTree();
    const setIsolatedIds = vi.fn();
    const clearVisibility = vi.fn();

    const ctrl = revealStoreyByStorey(tree, { setIsolatedIds, clearVisibility }, { delayMs: 500 });

    // First step fires, then we cancel before the timeout fires
    expect(setIsolatedIds).toHaveBeenCalledOnce();
    ctrl.cancel();
    expect(clearVisibility).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(1000);
    // No further setIsolatedIds after cancel
    expect(setIsolatedIds).toHaveBeenCalledOnce();
  });

  it('onProgress is called at each step', () => {
    const tree = makeTree();
    const onProgress = vi.fn();

    revealStoreyByStorey(
      tree,
      { setIsolatedIds: vi.fn(), clearVisibility: vi.fn(), onProgress },
      { delayMs: 50 },
    );

    vi.advanceTimersByTime(200);

    // step=1,total=2 and step=2,total=2 calls
    expect(onProgress).toHaveBeenCalledWith(1, 2);
    expect(onProgress).toHaveBeenCalledWith(2, 2);
  });

  it('respects custom minStoreys threshold', () => {
    // Model with exactly 2 storeys; minStoreys=3 → immediate clear, no animation
    const tree = makeTree();
    const clearVisibility = vi.fn();
    revealStoreyByStorey(tree, { setIsolatedIds: vi.fn(), clearVisibility }, { minStoreys: 3 });
    expect(clearVisibility).toHaveBeenCalledOnce();
  });
});

// ── fetchStoreyFragment + createStoreyStreamingLoader ────────────────────────

import {
  fetchStoreyFragment,
  createStoreyStreamingLoader,
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

describe('createStoreyStreamingLoader', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls onStoreyReady when storey[0] fetch succeeds', async () => {
    const resp = new Response('FRAG_BYTES', {
      status: 200,
      headers: {
        'X-Fragment-Source': 'cache',
        'X-Fragment-Storey-Name': 'GF',
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp));

    const onStoreyReady = vi.fn();
    createStoreyStreamingLoader('sha-test', { onStoreyReady });

    // Wait for the async fetch to complete.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(onStoreyReady).toHaveBeenCalledOnce();
    const [result, idx] = onStoreyReady.mock.calls[0] as [StoreyFragmentResult, number];
    expect(idx).toBe(0);
    expect(result.source).toBe('cache');
  });

  it('calls onError (not onStoreyReady) when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

    const onStoreyReady = vi.fn();
    const onError = vi.fn();
    createStoreyStreamingLoader('sha-err', { onStoreyReady, onError });

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(onStoreyReady).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('cancel() prevents onStoreyReady from firing after abort', async () => {
    // Slow fetch that resolves after 200ms
    vi.stubGlobal('fetch', vi.fn().mockImplementation(
      () => new Promise<Response>((resolve) =>
        setTimeout(() => resolve(new Response('BYTES', { status: 200 })), 200),
      ),
    ));

    const onStoreyReady = vi.fn();
    const session = createStoreyStreamingLoader('sha-cancel', { onStoreyReady });

    // Cancel before the fetch completes.
    session.cancel();
    expect(session.cancelled).toBe(true);

    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    expect(onStoreyReady).not.toHaveBeenCalled();
  });

  // Error-fallback tests

  it('cancel() is idempotent - second call does not trigger onDispose twice', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response('BYTES', { status: 200 })), 500)),
    ));
    const onDispose = vi.fn();
    const session = createStoreyStreamingLoader('sha-idem', { onStoreyReady: vi.fn(), onDispose });

    session.cancel();
    session.cancel(); // second call must be a no-op

    expect(onDispose).toHaveBeenCalledTimes(1);
  });

  it('cancel() does not forward AbortError to onError (abort is not an error)', async () => {
    // fetch rejects with AbortError when the signal is aborted.
    vi.stubGlobal('fetch', vi.fn().mockImplementation(
      (_url: string, opts: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          const sig = opts?.signal;
          if (sig) {
            sig.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
          }
        }),
    ));
    const onError = vi.fn();
    const session = createStoreyStreamingLoader('sha-abort-err', { onStoreyReady: vi.fn(), onError });

    // Give async handler a tick to wire the abort listener before cancelling.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    session.cancel();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    // AbortError fires because we cancelled - but it must NOT reach onError.
    expect(onError).not.toHaveBeenCalled();
  });

  it('onDispose is called exactly once when cancel() fires before fetch resolves', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response('B', { status: 200 })), 300)),
    ));
    const onDispose = vi.fn();
    createStoreyStreamingLoader('sha-dispose', { onStoreyReady: vi.fn(), onDispose });

    // Let the fetch start, then cancel mid-flight.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    // We don't have a reference here - re-create to verify directly.
    const onDispose2 = vi.fn();
    const session = createStoreyStreamingLoader('sha-dispose2', { onStoreyReady: vi.fn(), onDispose: onDispose2 });
    session.cancel();

    expect(onDispose2).toHaveBeenCalledTimes(1);
  });

  it('network error during active session calls onError with the error', async () => {
    const networkErr = new TypeError('Failed to fetch');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(networkErr));

    const onError = vi.fn();
    const onStoreyReady = vi.fn();
    createStoreyStreamingLoader('sha-net-err', { onStoreyReady, onError });

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(onStoreyReady).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect((onError.mock.calls[0][0] as Error).message).toContain('Failed to fetch');
  });
});
