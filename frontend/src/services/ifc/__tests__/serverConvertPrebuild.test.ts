/**
 * Vitest coverage for the pre-build status helpers in
 * `services/ifc/serverConvert.ts` - `getFragmentPrebuildStatus` and
 * `waitForFragmentReady`.
 *
 * Strategy: stub `globalThis.fetch` with `vi.stubGlobal` (mirrors the
 * `streamingLoader.test.ts` pattern) so each test fully controls the
 * network response. No real HTTP, no real backend.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  convertIfcOnServer,
  getConvertProgress,
  getFragmentPrebuildStatus,
  getServerCapabilities,
  pollConvertProgress,
  waitForFragmentReady,
  type FragmentPrebuildStatus,
} from '../serverConvert';

const SHA = 'a'.repeat(64);

const json = (status: number, body: object): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const baseStatus = (overrides: Partial<FragmentPrebuildStatus>): FragmentPrebuildStatus => ({
  status: 'idle',
  fingerprint: SHA,
  profile: 'performance',
  started_at: null,
  elapsed_ms: null,
  size_bytes: null,
  error: null,
  serve_url: null,
  ...overrides,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getServerCapabilities', () => {
  it('marks a 200 text/html answer (static-host SPA rewrite) as hard-unrecoverable', async () => {
    // Static hosts (GitHub Pages with 404.html, Netlify redirects) answer
    // /api/* with 200 + index.html. That must NOT read as a transient error,
    // or the loader POSTs the whole IFC body to a backend that doesn't exist.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('<!doctype html><html></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await getServerCapabilities({ force: true });
    expect(result.server_convert).toBe(false);
    expect(result.recoverable).toBe(false);
    expect(result.reason).toMatch(/non-JSON/i);
  });

  it('marks a 200 with no content-type as hard-unrecoverable', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('whatever', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await getServerCapabilities({ force: true });
    expect(result.server_convert).toBe(false);
    expect(result.recoverable).toBe(false);
  });

  it('maps HTTP 5xx feature probe responses to recoverable false caps', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(500, { detail: 'sidecar warming' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getServerCapabilities({ force: true });
    expect(result).toMatchObject({
      server_convert: false,
      available: false,
      recoverable: true,
      reason: 'HTTP 500',
    });
  });

  it('preserves recoverable:false hard-unavailable caps from the backend', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(200, {
        server_convert: false,
        available: false,
        recoverable: false,
        reason: 'sidecar node_modules missing',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await getServerCapabilities({ force: true });
    expect(result).toMatchObject({
      server_convert: false,
      recoverable: false,
      reason: 'sidecar node_modules missing',
    });
  });
});

// ── getFragmentPrebuildStatus ────────────────────────────────────────────────

describe('getFragmentPrebuildStatus', () => {
  it('maps a complete response to the typed status envelope', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(200, baseStatus({
        status: 'complete',
        size_bytes: 2048,
        serve_url: `/api/ifc/fragments/serve?fingerprint=${SHA}&profile=performance`,
      })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await getFragmentPrebuildStatus(SHA, 'performance');
    expect(result.status).toBe('complete');
    expect(result.size_bytes).toBe(2048);
    expect(result.serve_url).toContain('/fragments/serve');
  });

  it('encodes wait_ms into the query string', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(200, baseStatus({ status: 'inflight', elapsed_ms: 120 })),
    );
    vi.stubGlobal('fetch', fetchMock);

    await getFragmentPrebuildStatus(SHA, 'performance', { waitMs: 1500 });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('wait_ms=1500');
    expect(url).toContain(`fingerprint=${SHA}`);
    expect(url).toContain('profile=performance');
  });

  it('defaults wait_ms to 0 when omitted', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(200, baseStatus({ status: 'idle' })),
    );
    vi.stubGlobal('fetch', fetchMock);

    await getFragmentPrebuildStatus(SHA, 'performance');
    expect(fetchMock.mock.calls[0][0]).toContain('wait_ms=0');
  });

  it('returns idle with reason on HTTP error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(500, { detail: 'boom' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getFragmentPrebuildStatus(SHA, 'performance');
    expect(result.status).toBe('idle');
    expect(result.error).toMatch(/HTTP 500/);
  });

  it('returns idle with reason on network throw', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('connection refused'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getFragmentPrebuildStatus(SHA, 'performance');
    expect(result.status).toBe('idle');
    expect(result.error).toBe('connection refused');
  });

  it('preserves the error field from a failed response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(200, baseStatus({ status: 'failed', error: 'sidecar exited 1' })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await getFragmentPrebuildStatus(SHA, 'performance');
    expect(result.status).toBe('failed');
    expect(result.error).toBe('sidecar exited 1');
  });

  it('falls back to the fingerprint/profile passed in when backend omits them', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'inflight' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await getFragmentPrebuildStatus(SHA, 'ultra_fast');
    expect(result.fingerprint).toBe(SHA);
    expect(result.profile).toBe('ultra_fast');
  });
});

// ── waitForFragmentReady ─────────────────────────────────────────────────────

describe('waitForFragmentReady', () => {
  // Sub-millisecond polling so tests run fast.
  const fastOpts = { timeoutMs: 200, pollIntervalMs: 100 };

  beforeEach(() => {
    vi.useRealTimers();
  });

  it('returns complete on the first poll when the backend says complete', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(200, baseStatus({ status: 'complete', size_bytes: 7 })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await waitForFragmentReady(SHA, 'performance', fastOpts);
    expect(result.status).toBe('complete');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns failed on the first poll when the backend reports failed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(200, baseStatus({ status: 'failed', error: 'sidecar crash' })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await waitForFragmentReady(SHA, 'performance', fastOpts);
    expect(result.status).toBe('failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns idle immediately when the backend has no record', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(200, baseStatus({ status: 'idle' })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await waitForFragmentReady(SHA, 'performance', fastOpts);
    expect(result.status).toBe('idle');
    // Should NOT poll a second time - idle means the registry forgot.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('transitions from inflight → complete across two polls', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, baseStatus({ status: 'inflight', elapsed_ms: 50 })))
      .mockResolvedValueOnce(json(200, baseStatus({ status: 'complete', size_bytes: 99 })));
    vi.stubGlobal('fetch', fetchMock);

    const result = await waitForFragmentReady(SHA, 'performance', {
      timeoutMs: 500,
      pollIntervalMs: 50,
    });
    expect(result.status).toBe('complete');
    expect(result.size_bytes).toBe(99);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns the last known status (still inflight) on timeout', async () => {
    // ``Response`` body is one-shot - use mockImplementation so every poll
    // gets a freshly built Response with a readable body.
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        json(200, baseStatus({ status: 'inflight', elapsed_ms: 50 })),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await waitForFragmentReady(SHA, 'performance', {
      timeoutMs: 250,
      pollIntervalMs: 100,
    });
    expect(result.status).toBe('inflight');
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('honours an already-aborted AbortSignal - returns first response without further polls', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => json(200, baseStatus({ status: 'inflight' })));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();

    const result = await waitForFragmentReady(SHA, 'performance', {
      timeoutMs: 500,
      pollIntervalMs: 50,
      signal: controller.signal,
    });
    expect(result.status).toBe('inflight');
    // One poll only - abort short-circuits the loop.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('clamps pollIntervalMs to at least 100 ms', async () => {
    // If the clamp didn't fire, a 0 ms poll interval would loop indefinitely
    // against an inflight response. Guard against regressions by making
    // ``waitMs`` query param land at >= 100.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, baseStatus({ status: 'inflight' })))
      .mockResolvedValueOnce(json(200, baseStatus({ status: 'complete', size_bytes: 1 })));
    vi.stubGlobal('fetch', fetchMock);

    const result = await waitForFragmentReady(SHA, 'performance', {
      timeoutMs: 500,
      pollIntervalMs: 0, // requested 0, should be clamped up
    });
    expect(result.status).toBe('complete');
    // First poll's URL should contain wait_ms >= 100.
    const firstUrl = fetchMock.mock.calls[0][0] as string;
    const match = /wait_ms=(\d+)/.exec(firstUrl);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(100);
  });

  it('uses the smaller of pollIntervalMs and timeoutMs for wait_ms', async () => {
    // pollIntervalMs (1 000) > timeoutMs (300) → wait_ms should be 300.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json(200, baseStatus({ status: 'complete', size_bytes: 1 })));
    vi.stubGlobal('fetch', fetchMock);

    await waitForFragmentReady(SHA, 'performance', {
      timeoutMs: 300,
      pollIntervalMs: 1_000,
    });
    const firstUrl = fetchMock.mock.calls[0][0] as string;
    const match = /wait_ms=(\d+)/.exec(firstUrl);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeLessThanOrEqual(300);
  });

  it('survives a transient network error and returns idle gracefully', async () => {
    // getFragmentPrebuildStatus collapses network errors to idle - the wait
    // loop must therefore exit cleanly rather than throwing.
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await waitForFragmentReady(SHA, 'performance', fastOpts);
    expect(result.status).toBe('idle');
    expect(result.error).toBe('ECONNRESET');
  });

  it('treats negative timeoutMs as zero', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => json(200, baseStatus({ status: 'inflight' })));
    vi.stubGlobal('fetch', fetchMock);

    const result = await waitForFragmentReady(SHA, 'performance', {
      timeoutMs: -5,
      pollIntervalMs: 100,
    });
    // First poll fires (since the function always tries once), but the loop
    // doesn't iterate again because the deadline is already in the past.
    expect(result.status).toBe('inflight');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ── convert progress polling ────────────────────────────────────────────────

describe('getConvertProgress', () => {
  it('maps an in-flight progress snapshot', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(200, {
        model_id: 'model-1',
        in_flight: true,
        stage: 'geometry',
        progress: 42,
        updated_at: 123,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await getConvertProgress('model-1');
    expect(result).toEqual({
      model_id: 'model-1',
      in_flight: true,
      stage: 'geometry',
      progress: 42,
      updated_at: 123,
    });
  });

  it('returns not-in-flight on HTTP or network failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(500, { detail: 'boom' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getConvertProgress('model-2')).resolves.toEqual({
      model_id: 'model-2',
      in_flight: false,
    });

    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await expect(getConvertProgress('model-2')).resolves.toEqual({
      model_id: 'model-2',
      in_flight: false,
    });
  });
});

describe('pollConvertProgress', () => {
  it('emits changing in-flight snapshots and stops when the backend reports done', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, {
        model_id: 'model-3',
        in_flight: true,
        stage: 'parse',
        progress: 10,
        updated_at: 1,
      }))
      .mockResolvedValueOnce(json(200, {
        model_id: 'model-3',
        in_flight: true,
        stage: 'geometry',
        progress: 55,
        updated_at: 2,
      }))
      .mockResolvedValueOnce(json(200, {
        model_id: 'model-3',
        in_flight: false,
      }));
    vi.stubGlobal('fetch', fetchMock);
    const seen: number[] = [];

    const result = await pollConvertProgress('model-3', {
      pollIntervalMs: 1,
      timeoutMs: 100,
      onProgress: (snapshot) => {
        if (typeof snapshot.progress === 'number') seen.push(snapshot.progress);
      },
    });

    expect(result.in_flight).toBe(false);
    expect(seen).toEqual([10, 55]);
  });

  it('convertIfcOnServer polls progress while the POST is pending', async () => {
    const fragmentBytes = new Uint8Array([1, 2, 3, 4, 5]);
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/convert/progress/')) {
        return json(200, {
          model_id: 'model-4',
          in_flight: true,
          stage: 'geometry',
          progress: 64,
          updated_at: 10,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(fragmentBytes, {
        status: 200,
        headers: {
          'X-Fragment-Source': 'sidecar',
          'X-Fragment-Profile': 'performance',
          'X-Fragment-Elapsed-Ms': '9',
          'X-Fragment-Source-Sha256': SHA,
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const onProgress = vi.fn();

    const result = await convertIfcOnServer(
      new Uint8Array([9, 8, 7]),
      'performance',
      'model-4',
      { progressPollIntervalMs: 1, onProgress },
    );

    expect(result.bytes).toEqual(fragmentBytes);
    expect(result.source).toBe('sidecar');
    expect(onProgress).toHaveBeenCalled();
    expect(onProgress.mock.calls[0][0]).toMatchObject({
      model_id: 'model-4',
      in_flight: true,
      stage: 'geometry',
      progress: 64,
    });
  });
});
