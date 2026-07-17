import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachGeometryTitle,
  buildViewerPerfLogEntry,
  buildFragmentCacheKey,
  FRAGMENT_ARTIFACT_COMPATIBILITY,
  clearFragmentThreadPlaceholder,
  computeViewerReadyMetrics,
  formatUnknownLoadError,
  formatImportProgressDetail,
  formatStageTimings,
  formatViewerReadySummary,
  isCacheHitModelLoadSource,
  isBackendShaFingerprint,
  isSuspiciousServerFragmentBytes,
  loadFragmentsWithTimeout,
  makeViewerModelId,
  modelLoadSourceForServerFragmentSource,
  modelLoadSourceHint,
  modelLoadSourceLabel,
  nextCacheHitRate,
  normalizeImportProgress,
  prependViewerPerfLogEntry,
  serverCapabilityWaitMs,
  shouldUseServerFragmentManifest,
  shouldWaitForServerPrebuild,
  type FragmentManagerWithCore,
} from '../loadPipelineHelpers';

function makeFragmentsManager(
  loadImpl: FragmentManagerWithCore['core']['load'],
  autoCoordinate = true,
  graphicsQuality = 0.85,
): FragmentManagerWithCore {
  return {
    core: {
      settings: { autoCoordinate, graphicsQuality },
      load: loadImpl,
      _data: { _modelThread: new Map() },
    },
  };
}

describe('isBackendShaFingerprint', () => {
  it('accepts 64-character hex strings only', () => {
    expect(isBackendShaFingerprint('a'.repeat(64))).toBe(true);
    expect(isBackendShaFingerprint('A'.repeat(64))).toBe(true);
    expect(isBackendShaFingerprint('g'.repeat(64))).toBe(false);
    expect(isBackendShaFingerprint('a'.repeat(63))).toBe(false);
    expect(isBackendShaFingerprint(null)).toBe(false);
  });
});

describe('normalizeImportProgress', () => {
  it('normalizes fractions and clamps percentages', () => {
    expect(normalizeImportProgress(0.42)).toBe(42);
    expect(normalizeImportProgress(42)).toBe(42);
    expect(normalizeImportProgress(150)).toBe(100);
    expect(normalizeImportProgress(-1)).toBe(0);
    expect(normalizeImportProgress(Number.NaN)).toBe(0);
  });
});

describe('formatImportProgressDetail', () => {
  it('formats state, class, and entity count', () => {
    expect(formatImportProgressDetail({
      process: 'geometries',
      state: 'inProgress',
      class: 'IfcWall',
      entitiesProcessed: 1200,
    })).toBe(`in progress • IfcWall • ${(1200).toLocaleString()} entities`);
  });

  it('formats start and finish labels', () => {
    expect(formatImportProgressDetail({
      process: 'attributes',
      state: 'start',
    })).toBe('starting');
    expect(formatImportProgressDetail({
      process: 'relations',
      state: 'finish',
    })).toBe('done');
  });
});

describe('buildFragmentCacheKey', () => {
  it('uses the importer-settings compatibility revision', () => {
    expect(FRAGMENT_ARTIFACT_COMPATIBILITY).toContain('parse-r2');
  });

  it('includes stable prefix, profile, and sha fingerprint', async () => {
    const key = await buildFragmentCacheKey(new Uint8Array([1, 2, 3]), 'balanced');
    expect(key).toMatch(new RegExp(
      `^/__ifc_frag_cache__/${FRAGMENT_ARTIFACT_COMPATIBILITY}-balanced-auto-coordinate-3-[a-f0-9-]+\\.frag$`,
    ));
  });

  it('separates profile and coordinate-policy artifacts', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const balanced = await buildFragmentCacheKey(bytes, 'balanced');
    const performance = await buildFragmentCacheKey(bytes, 'performance');
    expect(balanced).not.toBe(performance);
    expect(performance).toContain('-performance-local-origin-');
  });
});

describe('makeViewerModelId', () => {
  it('uses the requested prefix and entropy suffix', () => {
    const id = makeViewerModelId('test');
    expect(id).toMatch(/^test-\d+-[a-z0-9]{5}$/);
  });
});

describe('serverCapabilityWaitMs', () => {
  it('waits longer for large files', () => {
    expect(serverCapabilityWaitMs(10 * 1024 * 1024)).toBe(6_000);
    expect(serverCapabilityWaitMs(40 * 1024 * 1024)).toBe(22_000);
  });
});

describe('server fragment load decisions', () => {
  const sha = 'a'.repeat(64);

  it('uses the manifest fast path only when remounting with a backend SHA and sidecar support', () => {
    expect(shouldUseServerFragmentManifest({
      hasFileBytes: false,
      fingerprint: sha,
      serverConvertAvailable: true,
    })).toBe(true);
    expect(shouldUseServerFragmentManifest({
      hasFileBytes: true,
      fingerprint: sha,
      serverConvertAvailable: true,
    })).toBe(false);
    expect(shouldUseServerFragmentManifest({
      hasFileBytes: false,
      fingerprint: 'local-preview',
      serverConvertAvailable: true,
    })).toBe(false);
    expect(shouldUseServerFragmentManifest({
      hasFileBytes: false,
      fingerprint: sha,
      serverConvertAvailable: false,
    })).toBe(false);
  });

  it('waits for server prebuild only when capabilities, SHA, and timeout allow it', () => {
    expect(shouldWaitForServerPrebuild({
      caps: { server_convert: true },
      fingerprint: sha,
      timeoutMs: 12_000,
    })).toBe(true);
    expect(shouldWaitForServerPrebuild({
      caps: { server_convert: false },
      fingerprint: sha,
      timeoutMs: 12_000,
    })).toBe(false);
    expect(shouldWaitForServerPrebuild({
      caps: { server_convert: false, recoverable: true, reason: 'HTTP 500' },
      fingerprint: sha,
      timeoutMs: 12_000,
    })).toBe(true);
    expect(shouldWaitForServerPrebuild({
      caps: { server_convert: true },
      fingerprint: sha,
      timeoutMs: 0,
    })).toBe(false);
    expect(shouldWaitForServerPrebuild({
      caps: { server_convert: true },
      fingerprint: 'not-sha',
      timeoutMs: 12_000,
    })).toBe(false);
  });

  it('rejects suspiciously small server fragment payloads', () => {
    expect(isSuspiciousServerFragmentBytes(new Uint8Array(4095))).toBe(true);
    expect(isSuspiciousServerFragmentBytes(new Uint8Array(4096))).toBe(false);
    expect(isSuspiciousServerFragmentBytes(null)).toBe(false);
  });
});

describe('model load source labels', () => {
  it('maps server fragment source to viewer load source', () => {
    expect(modelLoadSourceForServerFragmentSource('cache')).toBe('server-cache');
    expect(modelLoadSourceForServerFragmentSource('sidecar')).toBe('server-convert');
  });

  it('formats progress hints and attach titles', () => {
    expect(modelLoadSourceHint('fragments-cache')).toBe('Cache hit');
    expect(modelLoadSourceHint('server-cache')).toBe('Cache hit');
    expect(modelLoadSourceHint('server-convert')).toBe('Server convert');
    expect(modelLoadSourceHint('worker-parse')).toBe('Worker parse');
    expect(modelLoadSourceHint('ifc-parse')).toBe('Live parse');
    expect(attachGeometryTitle('server-convert')).toBe('Attaching pre-built geometry');
    expect(attachGeometryTitle('ifc-parse')).toBe('Attaching parsed geometry');
    expect(isCacheHitModelLoadSource('server-cache')).toBe(true);
    expect(isCacheHitModelLoadSource('server-convert')).toBe(false);
  });

  it('formats activity log labels', () => {
    expect(modelLoadSourceLabel('fragments-cache')).toBe('local-fragment-cache');
    expect(modelLoadSourceLabel('server-cache')).toBe('server-cache');
    expect(modelLoadSourceLabel('server-convert')).toBe('server-convert');
    expect(modelLoadSourceLabel('worker-parse')).toBe('worker-parse');
    expect(modelLoadSourceLabel('ifc-parse')).toBe('live-parse');
    expect(modelLoadSourceLabel('geometry-patch')).toBe('Geometry delta patch');
  });
});

describe('viewer ready metrics and perf log helpers', () => {
  it('smooths cache hit rate from source samples', () => {
    expect(nextCacheHitRate(null, 'server-cache')).toBe(100);
    expect(nextCacheHitRate(undefined, 'ifc-parse')).toBe(0);
    expect(nextCacheHitRate(50, 'fragments-cache')).toBe(60);
    expect(nextCacheHitRate(50, 'server-convert')).toBe(40);
  });

  it('computes ready metrics from monotonic and wall-clock timestamps', () => {
    expect(computeViewerReadyMetrics({
      source: 'fragments-cache',
      initStartMs: 100,
      nowMs: 460,
      loadStartTs: 1_000,
      wallClockNowMs: 1_900,
      previousCacheHitRate: 25,
    })).toEqual({
      ttfrMs: 360,
      loadMs: 900,
      cacheHitRate: 40,
    });
  });

  it('builds rounded performance log entries and keeps newest entries first', () => {
    const entry = buildViewerPerfLogEntry({
      timestampMs: 10,
      source: 'worker-parse',
      ttfrMs: 123.6,
      ttfgMs: 45.2,
      loadMs: 999.5,
    });

    expect(entry).toEqual({
      ts: 10,
      source: 'worker-parse',
      ttfrMs: 124,
      ttfgMs: 45,
      loadMs: 1000,
    });
    expect(prependViewerPerfLogEntry(['old-a', 'old-b'], entry, 2)).toEqual([entry, 'old-a']);
  });

  it('formats stage timings in dashboard order and skips absent timings', () => {
    expect(formatStageTimings({
      parseMs: 91.6,
      cacheReadMs: 10.2,
      sidecarMs: 25.7,
    })).toBe('cache read: 10 ms | sidecar: 26 ms | parse: 92 ms');
    expect(formatStageTimings({})).toBe('');
  });

  it('formats the ready activity summary from the load source', () => {
    expect(formatViewerReadySummary('server-convert', 1234.4, 456.6))
      .toBe('server-convert ready in 1234 ms (TTFR), first geometry 457 ms (TTFG)');
  });
});

describe('formatUnknownLoadError', () => {
  it('keeps Error messages concise', () => {
    expect(formatUnknownLoadError(new Error('worker failed'))).toBe('worker failed');
  });

  it('serializes non-Error worker events with diagnostic fields', () => {
    expect(formatUnknownLoadError({
      message: 'bad inflate',
      type: 'error',
      filename: 'worker.js',
      lineno: 42,
    })).toBe('{"message":"bad inflate","type":"error","filename":"worker.js","lineno":42}');
  });
});

describe('clearFragmentThreadPlaceholder', () => {
  it('removes stale model placeholders without throwing', () => {
    const manager = makeFragmentsManager(async () => ({}) as never);
    manager.core._data?._modelThread?.set('model-1', {});
    clearFragmentThreadPlaceholder(manager, 'model-1');
    expect(manager.core._data?._modelThread?.has('model-1')).toBe(false);
  });
});

describe('loadFragmentsWithTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads Uint8Array bytes and restores autoCoordinate override', async () => {
    const model = {} as Awaited<ReturnType<FragmentManagerWithCore['core']['load']>>;
    let loadedBytes: Uint8Array | null = null;
    let loadedOptions: { modelId: string } | null = null;
    const load: FragmentManagerWithCore['core']['load'] = async (bytes, options) => {
      loadedBytes = bytes;
      loadedOptions = options;
      return model;
    };
    const manager = makeFragmentsManager(load, true);

    const result = await loadFragmentsWithTimeout(
      manager,
      new Uint8Array([1, 2]),
      'model-1',
      { timeoutMs: 0, autoCoordinate: false },
    );

    expect(result).toBe(model);
    expect(loadedBytes).toBeInstanceOf(Uint8Array);
    expect(loadedOptions).toEqual({ modelId: 'model-1' });
    expect(manager.core.settings.autoCoordinate).toBe(true);
  });

  it('seeds and restores the load-time graphicsQuality bracket', async () => {
    let qualityDuringLoad: number | null = null;
    const manager = makeFragmentsManager(async () => {
      qualityDuringLoad = manager.core.settings.graphicsQuality;
      return {} as Awaited<ReturnType<FragmentManagerWithCore['core']['load']>>;
    }, true, 0.3);

    await loadFragmentsWithTimeout(manager, new Uint8Array([1]), 'model-q', {
      timeoutMs: 0,
      graphicsQuality: 0.85,
    });

    expect(qualityDuringLoad).toBe(0.85);
    expect(manager.core.settings.graphicsQuality).toBe(0.3);
  });

  it('leaves graphicsQuality untouched when no seed is passed', async () => {
    const manager = makeFragmentsManager(
      async () => ({} as Awaited<ReturnType<FragmentManagerWithCore['core']['load']>>),
      true,
      0.42,
    );

    await loadFragmentsWithTimeout(manager, new Uint8Array([1]), 'model-q2', { timeoutMs: 0 });

    expect(manager.core.settings.graphicsQuality).toBe(0.42);
  });

  it('converts ArrayBuffer bytes before loading', async () => {
    let loadedBytes: Uint8Array | null = null;
    const load: FragmentManagerWithCore['core']['load'] = async (bytes) => {
      loadedBytes = bytes;
      return {} as Awaited<ReturnType<FragmentManagerWithCore['core']['load']>>;
    };
    const manager = makeFragmentsManager(load);
    const buffer = new Uint8Array([3, 4]).buffer;

    await loadFragmentsWithTimeout(manager, buffer, 'model-2', { timeoutMs: 0 });

    expect(loadedBytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(loadedBytes ?? [])).toEqual([3, 4]);
  });

  it('clears placeholders and restores settings when timeout wins', async () => {
    vi.useFakeTimers();
    const load = vi.fn(() => new Promise<never>(() => {}));
    const manager = makeFragmentsManager(load, true);
    manager.core._data?._modelThread?.set('model-timeout', {});

    const promise = loadFragmentsWithTimeout(
      manager,
      new Uint8Array([1]),
      'model-timeout',
      { timeoutMs: 50, autoCoordinate: false },
    );

    const assertion = expect(promise).rejects.toThrow('Fragment load timed out after 50 ms');
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(manager.core._data?._modelThread?.has('model-timeout')).toBe(false);
    expect(manager.core.settings.autoCoordinate).toBe(true);
  });

  it('disposes a model that resolves after its timed-out load was replaced', async () => {
    vi.useFakeTimers();
    let resolveLoad!: (model: Awaited<ReturnType<FragmentManagerWithCore['core']['load']>>) => void;
    const lateModel = {
      dispose: vi.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<FragmentManagerWithCore['core']['load']>>;
    const manager = makeFragmentsManager(() => new Promise((resolve) => {
      resolveLoad = resolve;
    }));
    manager.core._data?._modelThread?.set('late-model', {});

    const load = loadFragmentsWithTimeout(
      manager,
      new Uint8Array([1]),
      'late-model',
      { timeoutMs: 25 },
    );
    const assertion = expect(load).rejects.toThrow('Fragment load timed out after 25 ms');
    await vi.advanceTimersByTimeAsync(25);
    await assertion;

    resolveLoad(lateModel);
    await vi.waitFor(() => expect(lateModel.dispose).toHaveBeenCalledOnce());
    expect(manager.core._data?._modelThread?.has('late-model')).toBe(false);
  });
});
