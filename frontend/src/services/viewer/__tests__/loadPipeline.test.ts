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
  type ViewerLoadProgress,
  type ViewerPerfLogEntry,
  LOAD_STAGES,
  PACE_MILESTONES,
  advancePace,
  createPaceState,
  deriveLoadStage,
  estimateExpectedTotal,
  formatEta,
  humanizeProcessStage,
  innerWorkPercent,
  pathKindForSourceHint,
  presentLoadProgress,
  chooseColdLoadOrder,
  shouldAttemptServerConvert,
  shouldRepromoteCapabilities,
  isCapabilityProbeTimeoutReason,
  isHttpServerErrorReason,
  isRecoverableServerConvertFailure,
  defaultParsePathLabel,
  type ColdLoadInputs,
  LIVE_PARSE_MAX_TIMEOUT_MS,
  LIVE_PARSE_MIN_TIMEOUT_MS,
  computeLiveParseTimeoutMs,
  raceWithTimeout,
  buildFnvFingerprint,
  buildFragmentCacheFingerprint,
} from '../loadPipeline';


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


function raw(progress: number, sourceHint: string, overrides: Partial<ViewerLoadProgress> = {}): ViewerLoadProgress {
  return {
    title: 'raw title',
    detail: 'raw detail',
    progress,
    sourceHint,
    ...overrides,
  };
}

describe('LOAD_STAGES', () => {
  it('defines four ordered stages', () => {
    expect(LOAD_STAGES).toHaveLength(4);
    expect(LOAD_STAGES.map((s) => s.index)).toEqual([0, 1, 2, 3]);
    expect(LOAD_STAGES.map((s) => s.id)).toEqual(['open', 'prepare', 'build', 'finish']);
  });

  it('never uses long dashes in labels', () => {
    for (const stage of LOAD_STAGES) {
      expect(stage.label).not.toMatch(/[\u2013\u2014]/);
    }
  });
});

describe('deriveLoadStage', () => {
  it('classifies the startup checkpoints as open', () => {
    expect(deriveLoadStage(4, 'Startup').id).toBe('open');
    expect(deriveLoadStage(10, 'Startup').id).toBe('open');
    expect(deriveLoadStage(14, 'Manifest check').id).toBe('open');
    expect(deriveLoadStage(16, 'Startup').id).toBe('open');
    expect(deriveLoadStage(22, 'Cache check').id).toBe('open');
  });

  it('classifies conversion checkpoints as prepare', () => {
    expect(deriveLoadStage(26, 'Server convert').id).toBe('prepare');
    expect(deriveLoadStage(30, 'Server convert').id).toBe('prepare');
    expect(deriveLoadStage(55, 'Server convert').id).toBe('prepare');
    expect(deriveLoadStage(69, 'Server convert').id).toBe('prepare');
  });

  it('keeps the pre-build wait in prepare even at raw 22', () => {
    expect(deriveLoadStage(22, 'Server pre-build').id).toBe('prepare');
  });

  it('treats the pre-build raw-70 fragment load as build, not conversion', () => {
    expect(deriveLoadStage(70, 'Server pre-build').id).toBe('build');
  });

  it('keeps browser parse paths in prepare until their 94% handoff', () => {
    expect(deriveLoadStage(28, 'Worker parse').id).toBe('prepare');
    expect(deriveLoadStage(60, 'Worker parse').id).toBe('prepare');
    expect(deriveLoadStage(92, 'Worker parse').id).toBe('prepare');
    expect(deriveLoadStage(94, 'Worker parse').id).toBe('build');
    expect(deriveLoadStage(92, 'Live parse').id).toBe('prepare');
  });

  it('classifies fragment loading and attach as build', () => {
    expect(deriveLoadStage(70, 'Server convert').id).toBe('build');
    expect(deriveLoadStage(70, 'Cache hit').id).toBe('build');
    expect(deriveLoadStage(75, 'Server manifest').id).toBe('build');
    expect(deriveLoadStage(50, 'Server manifest').id).toBe('build');
    expect(deriveLoadStage(74, 'local-fragment-cache').id).toBe('build');
    expect(deriveLoadStage(94, 'Server convert').id).toBe('build');
    expect(deriveLoadStage(96, 'Cache hit').id).toBe('build');
  });

  it('classifies the finalize checkpoints as finish', () => {
    expect(deriveLoadStage(98, 'Server convert').id).toBe('finish');
    expect(deriveLoadStage(100, 'Cache hit').id).toBe('finish');
    expect(deriveLoadStage(98, 'Worker parse').id).toBe('finish');
  });
});

describe('innerWorkPercent', () => {
  it('recovers the sidecar percent from the 30-70 band', () => {
    expect(innerWorkPercent(30, 'Server convert')).toBe(0);
    expect(innerWorkPercent(50, 'Server convert')).toBe(50);
    expect(innerWorkPercent(69, 'Server convert')).toBe(98);
  });

  it('recovers the parse percent from the 28-92 band', () => {
    expect(innerWorkPercent(28, 'Worker parse')).toBe(0);
    expect(innerWorkPercent(60, 'Worker parse')).toBe(50);
  });

  it('returns null outside the active bands', () => {
    expect(innerWorkPercent(20, 'Server convert')).toBeNull();
    expect(innerWorkPercent(80, 'Server convert')).toBeNull();
    expect(innerWorkPercent(50, 'Cache hit')).toBeNull();
  });
});

describe('humanizeProcessStage', () => {
  it('maps the converter process tokens to plain language', () => {
    expect(humanizeProcessStage('geometries')).toBe('Building shapes');
    expect(humanizeProcessStage('attributes')).toBe('Reading element data');
    expect(humanizeProcessStage('relations')).toBe('Linking elements');
    expect(humanizeProcessStage('conversion')).toBe('Processing model data');
    expect(humanizeProcessStage('Processing model data')).toBe('Processing model data');
    expect(humanizeProcessStage('parsing')).toBe('Reading the file');
  });

  it('returns null for unknown or empty tokens', () => {
    expect(humanizeProcessStage('Backend sidecar (geometries)')).toBeNull();
    expect(humanizeProcessStage('')).toBeNull();
    expect(humanizeProcessStage(null)).toBeNull();
  });
});

describe('presentLoadProgress', () => {
  it('shows the file name while opening', () => {
    const p = presentLoadProgress(raw(16, 'Startup'), { fileName: 'House.ifc', fileSizeMB: 49 });
    expect(p.stage.id).toBe('open');
    expect(p.title).toBe('Opening file');
    expect(p.detail).toContain('House.ifc');
    expect(p.detail).toContain('49 MB');
  });

  it('explains server conversion with a live inner percent', () => {
    const p = presentLoadProgress(raw(50, 'Server convert'));
    expect(p.stage.id).toBe('prepare');
    expect(p.title).toBe('Building 3D model');
    expect(p.detail).toContain('50% done');
  });

  it('uses the humanized sub-stage when the pipeline passes a process token', () => {
    const p = presentLoadProgress(raw(50, 'Server convert', { detail: 'geometries' }));
    expect(p.detail).toBe('Building shapes, 50% done');
  });

  it('humanizes the worker title token instead of showing it raw', () => {
    const p = presentLoadProgress(raw(60, 'Worker parse', { title: 'geometries' }));
    expect(p.title).toBe('Building 3D model');
    expect(p.detail).toContain('Building shapes');
  });

  it('mentions the saved copy on cache hits', () => {
    const p = presentLoadProgress(raw(70, 'Cache hit'));
    expect(p.stage.id).toBe('build');
    expect(p.detail).toContain('saved copy');
    expect(p.chip).toBe('From cache');
  });

  it('labels cold loads with the first-load chip and caption', () => {
    const p = presentLoadProgress(raw(50, 'Server convert'));
    expect(p.chip).toBe('First load');
    expect(p.caption).toContain('later opens are faster');
  });

  it('suppresses the cache caption when caches are disabled', () => {
    const p = presentLoadProgress(raw(50, 'Server convert'), { cachesEnabled: false });
    expect(p.caption).toBeNull();
  });

  it('keeps the chip empty while the path is unknown', () => {
    const p = presentLoadProgress(raw(4, 'Startup'));
    expect(p.chip).toBeNull();
  });

  it('titles the final checkpoint Ready', () => {
    expect(presentLoadProgress(raw(100, 'Cache hit')).title).toBe('Ready');
    expect(presentLoadProgress(raw(98, 'Cache hit')).title).toBe('Almost ready');
  });

  it('keeps the raw detail available as techDetail', () => {
    const p = presentLoadProgress(raw(70, 'Cache hit', { detail: 'Cache hit. Skipping IFC parse...' }));
    expect(p.techDetail).toBe('Cache hit. Skipping IFC parse...');
  });

  it('never emits long dashes or library jargon in user copy', () => {
    const hints = [
      'Startup', 'Manifest check', 'Server manifest', 'Cache check', 'Cache hit',
      'Server first', 'Server pre-build', 'Server convert', 'Server cache',
      'Worker parse', 'Live parse', 'local-fragment-cache', 'Storey stream',
    ];
    for (const hint of hints) {
      for (const pct of [4, 16, 22, 30, 50, 70, 94, 98, 100]) {
        const p = presentLoadProgress(raw(pct, hint));
        const copy = `${p.title} ${p.detail} ${p.chip ?? ''} ${p.caption ?? ''}`;
        expect(copy).not.toMatch(/[\u2013\u2014]/);
        expect(copy).not.toMatch(/sidecar|fragment|manifest|wasm|raycast|geometries/i);
      }
    }
  });
});

describe('pathKindForSourceHint', () => {
  it('classifies the pipeline hints', () => {
    expect(pathKindForSourceHint('Server convert')).toBe('server-convert');
    expect(pathKindForSourceHint('Server pre-build')).toBe('server-convert');
    expect(pathKindForSourceHint('Worker parse')).toBe('browser-parse');
    expect(pathKindForSourceHint('Live parse')).toBe('browser-parse');
    expect(pathKindForSourceHint('Cache hit')).toBe('cached');
    expect(pathKindForSourceHint('Server manifest')).toBe('cached');
    expect(pathKindForSourceHint('Server cache')).toBe('cached');
    expect(pathKindForSourceHint('local-fragment-cache')).toBe('cached');
  });

  it('does not treat cache probes as the cached path', () => {
    expect(pathKindForSourceHint('Cache check')).toBe('unknown');
    expect(pathKindForSourceHint('Manifest check')).toBe('unknown');
    expect(pathKindForSourceHint('Local cache check')).toBe('unknown');
    expect(pathKindForSourceHint('Startup')).toBe('unknown');
    expect(pathKindForSourceHint('Server first')).toBe('unknown');
  });
});

describe('estimateExpectedTotal', () => {
  const entry = (source: ViewerPerfLogEntry['source'], ttfrMs: number): ViewerPerfLogEntry => ({
    ts: 0,
    source,
    ttfrMs,
    ttfgMs: ttfrMs,
    loadMs: null,
  });

  it('falls back to priors without history', () => {
    expect(estimateExpectedTotal('cached', [])).toEqual({ ms: 12_000, fromHistory: false });
    expect(estimateExpectedTotal('server-convert', null)).toEqual({ ms: 30_000, fromHistory: false });
    expect(estimateExpectedTotal('unknown', [entry('server-convert', 9000)]))
      .toEqual({ ms: 25_000, fromHistory: false });
  });

  it('uses the median of recent same-kind samples', () => {
    const history = [
      entry('server-convert', 8_000),
      entry('server-convert', 20_000),
      entry('server-convert', 12_000),
      entry('server-cache', 3_000),
    ];
    expect(estimateExpectedTotal('server-convert', history)).toEqual({ ms: 12_000, fromHistory: true });
  });

  it('only trusts history with two or more samples', () => {
    const one = [entry('server-cache', 3_000)];
    expect(estimateExpectedTotal('cached', one)).toEqual({ ms: 3_000, fromHistory: false });
    const two = [entry('server-cache', 3_000), entry('fragments-cache', 5_000)];
    expect(estimateExpectedTotal('cached', two)).toEqual({ ms: 5_000, fromHistory: true });
  });

  it('clamps degenerate samples', () => {
    expect(estimateExpectedTotal('cached', [entry('server-cache', 1)]).ms).toBe(1_500);
    expect(estimateExpectedTotal('cached', [entry('server-cache', 10_000_000)]).ms).toBe(600_000);
  });
});

describe('advancePace', () => {
  it('starts at the initial raw value', () => {
    const s = createPaceState(4, 30_000);
    expect(s.display).toBe(4);
    expect(s.anchor).toBe(4);
  });

  it('never moves backwards even if raw regresses', () => {
    let s = createPaceState(70, 30_000);
    s = advancePace(s, 70, 1000);
    const high = s.display;
    s = advancePace(s, 22, 1000);
    expect(s.display).toBeGreaterThanOrEqual(high);
    expect(s.anchor).toBe(70);
  });

  it('always keeps moving between checkpoints', () => {
    let s = createPaceState(70, 30_000);
    const seen: number[] = [];
    for (let i = 0; i < 20; i++) {
      s = advancePace(s, 70, 500);
      seen.push(s.display);
    }
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThan(seen[i - 1]);
    }
  });

  it('respects the band ceiling within the expected duration', () => {
    let s = createPaceState(70, 10_000);
    for (let i = 0; i < 12; i++) s = advancePace(s, 70, 1000);
    expect(s.display).toBeLessThan(94);
  });

  it('creeps past a saturated ceiling on pathological stalls, capped at 99.4', () => {
    let s = createPaceState(70, 10_000);
    for (let i = 0; i < 600; i++) s = advancePace(s, 70, 1000);
    expect(s.display).toBeGreaterThan(93.5);
    expect(s.display).toBeLessThanOrEqual(99.4);
  });

  it('caps the conversion band ride-along a few points over raw', () => {
    let s = createPaceState(30, 10_000);
    for (let i = 0; i < 12; i++) s = advancePace(s, 30, 1000);
    expect(s.display).toBeLessThanOrEqual(36);
  });

  it('sweeps up quickly when a checkpoint lands ahead of the display', () => {
    let s = createPaceState(30, 30_000);
    s = advancePace(s, 94, 450);
    expect(s.display).toBeGreaterThanOrEqual(93.9);
  });

  it('snaps to 100 on completion', () => {
    let s = createPaceState(98, 30_000);
    s = advancePace(s, 100, 16);
    expect(s.display).toBe(100);
  });

  it('suppresses drift when raw regresses below the anchor (fallback parse)', () => {
    // Stale-local-cache fallback shape: anchor 80, then worker re-parse
    // restarts and reports raw ~30. The bar must not keep climbing toward
    // the abandoned 93.5 ceiling; a token crawl only.
    let s = createPaceState(80, 45_000);
    s = advancePace(s, 80, 1000);
    const atFallback = s.display;
    for (let i = 0; i < 120; i++) s = advancePace(s, 30, 1000); // 2 min
    expect(s.display).toBeLessThanOrEqual(atFallback + 1.5);
    expect(s.display).toBeGreaterThanOrEqual(atFallback);
  });

  it('keeps creeping after a checkpoint regression saturates the band', () => {
    let s = createPaceState(80, 45_000);
    let prev = s.display;
    for (let i = 0; i < 240; i++) { // 4 minutes at 1 s ticks
      s = advancePace(s, 30, 1000);
      expect(s.display).toBeGreaterThan(prev);
      prev = s.display;
    }
    expect(s.display).toBeLessThanOrEqual(99.4);
  });

  it('paces long phases slower than short ones', () => {
    let slow = createPaceState(70, 60_000);
    let fast = createPaceState(70, 6_000);
    slow = advancePace(slow, 70, 2_000);
    fast = advancePace(fast, 70, 2_000);
    expect(fast.display).toBeGreaterThan(slow.display);
  });

  it('survives randomized event sequences without regressing', () => {
    // Property-style sweep: raw checkpoints from real paths, shuffled by a
    // deterministic LCG, must always yield a non-decreasing display.
    const checkpoints = [4, 10, 14, 16, 22, 26, 30, 38, 47, 55, 63, 70, 72, 94, 96, 98, 100];
    let seed = 1234567;
    const next = () => {
      seed = (seed * 48271) % 2147483647;
      return seed;
    };
    for (let run = 0; run < 25; run++) {
      let s = createPaceState(4, 5_000 + (next() % 60_000));
      let prev = s.display;
      for (let step = 0; step < 200; step++) {
        const rawPct = checkpoints[next() % checkpoints.length];
        s = advancePace(s, rawPct, next() % 700);
        expect(s.display).toBeGreaterThanOrEqual(prev);
        expect(s.display).toBeLessThanOrEqual(100);
        prev = s.display;
      }
    }
  });

  it('milestone bands cover the raw checkpoint constants', () => {
    for (const from of [0, 10, 14, 22, 28, 70, 94, 96, 98]) {
      expect(PACE_MILESTONES.some((m) => m.from === from)).toBe(true);
    }
  });
});

describe('formatEta', () => {
  it('stays quiet for the first seconds', () => {
    expect(formatEta(1_000, 30_000, true).text).toBeNull();
  });

  it('rounds the estimate to 5s steps when history-backed', () => {
    expect(formatEta(10_000, 30_000, true)).toEqual({ text: 'about 20s left', overrun: false });
    expect(formatEta(10_000, 33_000, true)).toEqual({ text: 'about 25s left', overrun: false });
  });

  it('uses minutes for long estimates', () => {
    expect(formatEta(5_000, 185_000, true).text).toBe('about 3 min left');
  });

  it('shows only elapsed time without history', () => {
    expect(formatEta(10_000, 30_000, false)).toEqual({ text: '10s elapsed', overrun: false });
  });

  it('switches to elapsed time once the estimate is blown', () => {
    const eta = formatEta(40_000, 30_000, true);
    expect(eta.overrun).toBe(true);
    expect(eta.text).toBe('40s elapsed');
  });

  it('formats minutes for long overruns', () => {
    expect(formatEta(95_000, 30_000, true).text).toBe('1m 35s elapsed');
  });
});


const baseInputs: ColdLoadInputs = {
  hasCacheKey: false,
  hasFileBytes: true,
  capsKnown: false,
  caps: null,
  hasShaFingerprint: false,
  prebuildWaitAllowed: false,
};

describe('shouldAttemptServerConvert (default-on flip)', () => {
  it('returns true when caps are unknown and bytes are present (DEFAULT)', () => {
    expect(shouldAttemptServerConvert(null, true)).toBe(true);
    expect(shouldAttemptServerConvert(undefined, true)).toBe(true);
  });

  it('returns true when caps say server_convert: true', () => {
    expect(shouldAttemptServerConvert({ server_convert: true }, true)).toBe(true);
  });

  it('returns true when caps say server_convert: false BUT reason is a probe timeout (transient)', () => {
    expect(
      shouldAttemptServerConvert(
        { server_convert: false, reason: 'capability probe timed out after 5000 ms' },
        true,
      ),
    ).toBe(true);
    expect(
      shouldAttemptServerConvert(
        { server_convert: false, reason: '/api/ifc/features aborted after 5000 ms' },
        true,
      ),
    ).toBe(true);
  });

  it('returns true when caps say server_convert: false but the failure is recoverable', () => {
    expect(
      shouldAttemptServerConvert({ server_convert: false, reason: 'HTTP 502' }, true),
    ).toBe(true);
    expect(
      shouldAttemptServerConvert({ server_convert: false, recoverable: true, reason: 'starting' }, true),
    ).toBe(true);
  });

  it('returns false when caps say server_convert: false for a hard setup failure', () => {
    expect(
      shouldAttemptServerConvert(
        { server_convert: false, recoverable: false, reason: 'sidecar node_modules missing' },
        true,
      ),
    ).toBe(false);
    expect(
      shouldAttemptServerConvert({ server_convert: false, recoverable: false }, true),
    ).toBe(false);
  });

  it('returns false when no file bytes are available (cannot upload an empty body)', () => {
    expect(shouldAttemptServerConvert({ server_convert: true }, false)).toBe(false);
    expect(shouldAttemptServerConvert(null, false)).toBe(false);
  });
});

describe('shouldRepromoteCapabilities', () => {
  it('returns true when caps are unknown', () => {
    expect(shouldRepromoteCapabilities(null)).toBe(true);
    expect(shouldRepromoteCapabilities(undefined)).toBe(true);
  });

  it('returns false when caps already say server_convert: true', () => {
    expect(shouldRepromoteCapabilities({ server_convert: true })).toBe(false);
  });

  it('returns true when last probe timed out (transient)', () => {
    expect(
      shouldRepromoteCapabilities({
        server_convert: false,
        reason: 'capability probe timed out after 5000 ms',
      }),
    ).toBe(true);
  });

  it('returns true when last probe was a recoverable HTTP 5xx', () => {
    expect(
      shouldRepromoteCapabilities({ server_convert: false, reason: 'HTTP 502' }),
    ).toBe(true);
  });

  it('returns false on a hard-unavailable cap', () => {
    expect(
      shouldRepromoteCapabilities({
        server_convert: false,
        recoverable: false,
        reason: 'npx not found on PATH',
      }),
    ).toBe(false);
  });
});

describe('isCapabilityProbeTimeoutReason', () => {
  it('matches the two reason strings produced by serverConvert.ts', () => {
    expect(isCapabilityProbeTimeoutReason('capability probe timed out after 8000 ms')).toBe(true);
    expect(isCapabilityProbeTimeoutReason('/api/ifc/features aborted after 20000 ms')).toBe(true);
  });

  // A2 dedup contract - the verbatim reason strings emitted by
  // probeServerCapabilities / getServerCapabilities in serverConvert.ts must
  // round-trip back to "transient". If either of these strings is renamed at
  // the producer side without updating this helper, ViewerPanel's
  // capability-cache write and the cold-load order both regress silently
  // (we would persist a stale "no server-convert" cap on a transient failure
  // and stop attempting it).
  it('matches the EXACT reason strings emitted by serverConvert.ts (regression guard)', () => {
    expect(isCapabilityProbeTimeoutReason('capability probe aborted after 5000 ms')).toBe(true);
    expect(isCapabilityProbeTimeoutReason('capability probe timed out after 6000 ms')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isCapabilityProbeTimeoutReason('TIMED OUT after 1s')).toBe(true);
  });

  it('rejects unrelated reasons', () => {
    expect(isCapabilityProbeTimeoutReason('HTTP 500')).toBe(false);
    expect(isCapabilityProbeTimeoutReason('sidecar process exited')).toBe(false);
    expect(isCapabilityProbeTimeoutReason('capability probe unavailable')).toBe(false);
    expect(isCapabilityProbeTimeoutReason(undefined)).toBe(false);
    expect(isCapabilityProbeTimeoutReason('')).toBe(false);
  });
});

describe('recoverable server-convert failures', () => {
  it('treats HTTP 5xx, explicit recoverable states, and timeouts as recoverable', () => {
    expect(isHttpServerErrorReason('HTTP 500')).toBe(true);
    expect(isHttpServerErrorReason('http 503: warming up')).toBe(true);
    expect(isRecoverableServerConvertFailure({ server_convert: false, reason: 'HTTP 500' })).toBe(true);
    expect(isRecoverableServerConvertFailure({ server_convert: false, recoverable: true })).toBe(true);
    expect(
      isRecoverableServerConvertFailure({
        server_convert: false,
        reason: 'capability probe aborted after 5000 ms',
      }),
    ).toBe(true);
  });

  it('treats explicit hard false caps as non-recoverable', () => {
    expect(
      isRecoverableServerConvertFailure({
        server_convert: false,
        recoverable: false,
        reason: 'sidecar node_modules missing',
      }),
    ).toBe(false);
    expect(isHttpServerErrorReason('HTTP 404')).toBe(false);
    expect(isHttpServerErrorReason('sidecar process exited')).toBe(false);
  });
});

describe('chooseColdLoadOrder', () => {
  it('puts server-convert before worker-parse and live-parse when caps allow it (DEFAULT FLIP)', () => {
    const order = chooseColdLoadOrder({
      ...baseInputs,
      hasFileBytes: true,
      caps: { server_convert: true },
    });
    expect(order).toEqual(['server-convert', 'worker-parse', 'live-parse']);
  });

  it('attempts server-convert even when caps are unknown (default flip)', () => {
    const order = chooseColdLoadOrder({
      ...baseInputs,
      hasFileBytes: true,
      caps: null,
    });
    expect(order.indexOf('server-convert')).toBeLessThan(order.indexOf('worker-parse'));
  });

  it('skips server-convert when caps are hard-unavailable', () => {
    const order = chooseColdLoadOrder({
      ...baseInputs,
      hasFileBytes: true,
      caps: { server_convert: false, recoverable: false, reason: 'npx not found on PATH' },
    });
    expect(order).toEqual(['worker-parse', 'live-parse']);
    expect(order.includes('server-convert')).toBe(false);
  });

  it('uses local IndexedDB cache only after server-convert when a cache key is present', () => {
    const order = chooseColdLoadOrder({
      ...baseInputs,
      hasCacheKey: true,
      hasFileBytes: true,
      caps: { server_convert: true },
    });
    expect(order).toEqual(['server-convert', 'idb-cache', 'worker-parse', 'live-parse']);
  });

  it('includes fragment-manifest only when a sha-256 fingerprint is known', () => {
    const without = chooseColdLoadOrder({
      ...baseInputs,
      hasFileBytes: true,
      caps: { server_convert: true },
      hasShaFingerprint: false,
    });
    expect(without.includes('fragment-manifest')).toBe(false);
    const withFp = chooseColdLoadOrder({
      ...baseInputs,
      hasFileBytes: true,
      caps: { server_convert: true },
      hasShaFingerprint: true,
    });
    expect(withFp.includes('fragment-manifest')).toBe(true);
    expect(withFp.indexOf('fragment-manifest')).toBeLessThan(withFp.indexOf('server-convert'));
  });

  it('includes prebuild-wait only when fingerprint + wait-allowed + caps are not a true-negative', () => {
    const truePositive = chooseColdLoadOrder({
      ...baseInputs,
      hasFileBytes: true,
      hasShaFingerprint: true,
      prebuildWaitAllowed: true,
      caps: { server_convert: true },
    });
    expect(truePositive.includes('prebuild-wait')).toBe(true);
    expect(truePositive.indexOf('prebuild-wait')).toBeLessThan(truePositive.indexOf('server-convert'));

    const trueNegative = chooseColdLoadOrder({
      ...baseInputs,
      hasFileBytes: true,
      hasShaFingerprint: true,
      prebuildWaitAllowed: true,
      caps: { server_convert: false, recoverable: false, reason: 'sidecar node_modules missing' },
    });
    expect(trueNegative.includes('prebuild-wait')).toBe(false);

    const noTimeoutBudget = chooseColdLoadOrder({
      ...baseInputs,
      hasFileBytes: true,
      hasShaFingerprint: true,
      prebuildWaitAllowed: false,
      caps: { server_convert: true },
    });
    expect(noTimeoutBudget.includes('prebuild-wait')).toBe(false);
  });

  it('returns an empty list when there are no bytes and no fingerprint and no cache key', () => {
    const order = chooseColdLoadOrder({
      ...baseInputs,
      hasFileBytes: false,
      caps: { server_convert: true },
    });
    expect(order).toEqual([]);
  });

  it('orders cold-load paths backend-first before local/browser fallbacks', () => {
    const order = chooseColdLoadOrder({
      ...baseInputs,
      hasCacheKey: true,
      hasFileBytes: true,
      caps: { server_convert: false, recoverable: true, reason: 'HTTP 500' },
      hasShaFingerprint: true,
      prebuildWaitAllowed: true,
    });
    expect(order).toEqual([
      'fragment-manifest',
      'prebuild-wait',
      'server-convert',
      'idb-cache',
      'worker-parse',
      'live-parse',
    ]);
  });

  it('browser-only: skips every server step regardless of caps', () => {
    const order = chooseColdLoadOrder({
      ...baseInputs,
      browserOnly: true,
      hasCacheKey: true,
      hasFileBytes: true,
      caps: { server_convert: true }, // even a "ready" cap must be ignored
      hasShaFingerprint: true,
      prebuildWaitAllowed: true,
    });
    expect(order).toEqual(['idb-cache', 'worker-parse', 'live-parse']);
  });

  it('browser-only: no cache key → straight to worker-parse', () => {
    const order = chooseColdLoadOrder({
      ...baseInputs,
      browserOnly: true,
      hasFileBytes: true,
    });
    expect(order).toEqual(['worker-parse', 'live-parse']);
  });

  it('browser-only: no bytes and no cache → empty (nothing can load)', () => {
    const order = chooseColdLoadOrder({
      ...baseInputs,
      browserOnly: true,
      hasFileBytes: false,
      hasShaFingerprint: true, // a fingerprint alone is useless without a server
    });
    expect(order).toEqual([]);
  });

  it('always ends with live-parse when bytes are present (universal safety net)', () => {
    for (const caps of [
      null,
      { server_convert: true } as const,
      { server_convert: false, recoverable: false, reason: 'npx not found' } as const,
      { server_convert: false, reason: 'probe timed out' } as const,
    ]) {
      const order = chooseColdLoadOrder({
        ...baseInputs,
        hasFileBytes: true,
        caps,
      });
      expect(order[order.length - 1]).toBe('live-parse');
    }
  });
});

describe('defaultParsePathLabel', () => {
  it('returns server-convert as the default first-attempt parse path when caps allow', () => {
    expect(defaultParsePathLabel({ server_convert: true }, true)).toBe('server-convert');
    expect(defaultParsePathLabel(null, true)).toBe('server-convert');
  });

  it('falls back to worker-parse when caps are a true-negative', () => {
    expect(
      defaultParsePathLabel(
        { server_convert: false, recoverable: false, reason: 'HTTP 404' },
        true,
      ),
    ).toBe('worker-parse');
  });

  it('returns none when no bytes are available', () => {
    expect(defaultParsePathLabel({ server_convert: true }, false)).toBe('none');
  });
});


describe('computeLiveParseTimeoutMs', () => {
  it('returns the floor for zero / negative / NaN', () => {
    expect(computeLiveParseTimeoutMs(0)).toBe(LIVE_PARSE_MIN_TIMEOUT_MS);
    expect(computeLiveParseTimeoutMs(-1)).toBe(LIVE_PARSE_MIN_TIMEOUT_MS);
    expect(computeLiveParseTimeoutMs(Number.NaN)).toBe(LIVE_PARSE_MIN_TIMEOUT_MS);
  });

  it('returns the floor for tiny files where scaled < floor', () => {
    // 5 MB × 3000 ms/MB = 15 000 ms, below the 60 s floor.
    expect(computeLiveParseTimeoutMs(5 * 1024 * 1024)).toBe(LIVE_PARSE_MIN_TIMEOUT_MS);
  });

  it('scales linearly with file size', () => {
    // 50 MB × 3000 ms/MB = 150 000 ms.
    expect(computeLiveParseTimeoutMs(50 * 1024 * 1024)).toBe(150_000);
    // 100 MB → 300 s.
    expect(computeLiveParseTimeoutMs(100 * 1024 * 1024)).toBe(300_000);
  });

  it('clamps oversized files to the ceiling', () => {
    // 500 MB × 3000 ms/MB = 1 500 000 ms; clamped to 10 min ceiling.
    expect(computeLiveParseTimeoutMs(500 * 1024 * 1024)).toBe(LIVE_PARSE_MAX_TIMEOUT_MS);
  });

  it('treats fractional MB correctly', () => {
    // 2.5 MB × 3000 = 7500 ms → floor wins.
    expect(computeLiveParseTimeoutMs(2.5 * 1024 * 1024)).toBe(LIVE_PARSE_MIN_TIMEOUT_MS);
    // 25 MB × 3000 = 75 000 ms > 60 000 ms floor.
    expect(computeLiveParseTimeoutMs(25 * 1024 * 1024)).toBe(75_000);
  });
});

describe('raceWithTimeout', () => {
  it('resolves with the inner promise when it wins', async () => {
    const value = await raceWithTimeout(Promise.resolve('ok'), 1000, 'test');
    expect(value).toBe('ok');
  });

  it('rejects with a labelled error when the timer fires first', async () => {
    const slow = new Promise((resolve) => setTimeout(() => resolve('never'), 5000));
    await expect(raceWithTimeout(slow, 20, 'Live IFC parse')).rejects.toThrow(
      /Live IFC parse timed out after/,
    );
  });

  it('propagates inner-promise rejections without wrapping', async () => {
    const failing = Promise.reject(new Error('boom'));
    await expect(raceWithTimeout(failing, 1000, 'test')).rejects.toThrow('boom');
  });

  it('disables the timeout when timeoutMs <= 0', async () => {
    const value = await raceWithTimeout(Promise.resolve(42), 0, 'never');
    expect(value).toBe(42);
    const value2 = await raceWithTimeout(Promise.resolve(43), -10, 'never');
    expect(value2).toBe(43);
  });

  it('clears the timer when the inner promise wins to avoid leaks', async () => {
    // If the timer wasn't cleared, the rejection would still fire and
    // crash the test runner with an unhandled rejection.
    const fast = await raceWithTimeout(Promise.resolve('done'), 50, 'cleanup');
    expect(fast).toBe('done');
    // Wait past the original 50 ms timeout - no error should surface.
    await new Promise((r) => setTimeout(r, 80));
  });
});


describe('buildFnvFingerprint', () => {
  it('returns a stable token for zero-length input', () => {
    expect(buildFnvFingerprint(new Uint8Array())).toBe('0-0');
  });

  it('is deterministic for identical input', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 255, 0, 128]);
    expect(buildFnvFingerprint(bytes)).toBe(buildFnvFingerprint(bytes));
  });

  it('encodes byte length as the leading hex segment', () => {
    const bytes = new Uint8Array(257);
    const fp = buildFnvFingerprint(bytes);
    expect(fp.startsWith('101-')).toBe(true);
  });

  it('differs when a single byte changes', () => {
    const a = new Uint8Array([0, 0, 0, 0]);
    const b = new Uint8Array([0, 0, 0, 1]);
    expect(buildFnvFingerprint(a)).not.toBe(buildFnvFingerprint(b));
  });
});

describe('buildFragmentCacheFingerprint', () => {
  it('round-trips deterministically for the same bytes', async () => {
    const payload = new Uint8Array(4096);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) & 0xff;
    const a = await buildFragmentCacheFingerprint(payload);
    const b = await buildFragmentCacheFingerprint(payload);
    expect(a).toBe(b);
  });

  it('encodes byte length as the leading hex segment (length-prefix stability)', async () => {
    const payload = new Uint8Array(4096);
    const fp = await buildFragmentCacheFingerprint(payload);
    expect(fp.startsWith('1000-')).toBe(true);
  });

  it('returns zero-length sentinel for empty input', async () => {
    expect(await buildFragmentCacheFingerprint(new Uint8Array())).toBe('0-0');
  });

  it('produces distinct fingerprints for equal-length but different payloads', async () => {
    const a = new Uint8Array(64);
    const b = new Uint8Array(64);
    b[b.length - 1] = 1;
    expect(await buildFragmentCacheFingerprint(a)).not.toBe(
      await buildFragmentCacheFingerprint(b),
    );
  });
});
