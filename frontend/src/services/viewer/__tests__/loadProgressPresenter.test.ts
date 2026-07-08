import { describe, expect, it } from 'vitest';
import type { ViewerLoadProgress, ViewerPerfLogEntry } from '../loadPipelineHelpers';
import {
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
} from '../loadProgressPresenter';

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
    expect(humanizeProcessStage('conversion')).toBe('Packing the model');
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
