/**
 * Presentation layer for the viewer load overlay.
 *
 * The load pipeline in ViewerPanel reports raw technical checkpoints
 * (title, detail, progress, sourceHint). This module translates them into
 * what a person actually sees:
 *
 *   - a four-stage journey with plain-language names,
 *   - a display percent that is monotonic, never frozen, and paced by how
 *     long each phase is expected to take (so the bar tracks wall-clock
 *     time instead of jumping between far-apart checkpoints),
 *   - an honest time line: elapsed always, a remaining estimate only when
 *     this machine's own load history backs it up.
 *
 * Everything here is pure data-in data-out so it can be unit tested without
 * React or the viewer.
 */

import type { ViewerLoadProgress, ViewerPerfLogEntry } from './loadPipelineHelpers';

// ── Stage model ────────────────────────────────────────────────────────────

export type LoadStageId = 'open' | 'prepare' | 'build' | 'finish';

export interface LoadStageInfo {
  id: LoadStageId;
  /** 0-based position in the journey; drives the stepper UI. */
  index: number;
  /** Short user-facing name. Sentence case, no jargon. */
  label: string;
}

export const LOAD_STAGES: readonly LoadStageInfo[] = [
  { id: 'open', index: 0, label: 'Opening file' },
  { id: 'prepare', index: 1, label: 'Building 3D model' },
  { id: 'build', index: 2, label: 'Preparing view' },
  { id: 'finish', index: 3, label: 'Almost ready' },
] as const;

const STAGE_BY_ID: Record<LoadStageId, LoadStageInfo> = {
  open: LOAD_STAGES[0],
  prepare: LOAD_STAGES[1],
  build: LOAD_STAGES[2],
  finish: LOAD_STAGES[3],
};

/**
 * Map a raw pipeline checkpoint to its user-facing stage.
 *
 * The raw percent values are stable constants of the load pipeline
 * (4/10/16/22/26 startup, 28-70 conversion, 70-94 fragment load, 94-100
 * finalize), so percent plus the sourceHint is enough to classify without
 * touching the ~30 call sites in ViewerPanel.
 */
export function deriveLoadStage(progress: number, sourceHint: string): LoadStageInfo {
  if (progress >= 97) return STAGE_BY_ID.finish;
  const hint = sourceHint.toLowerCase();
  // Browser parse paths stay in "prepare" until their 94% handoff: the
  // 28-92 band is all parse work, not view preparation.
  if (hint.includes('parse')) {
    return progress >= 93 ? STAGE_BY_ID.build : progressAtLeast(progress, 24, 'prepare');
  }
  // Waiting on a server pre-build is conversion work, even at raw 22 -
  // but its raw-70 checkpoint is the fetched-fragment load, which is
  // view preparation like every other 70+ checkpoint.
  if (hint.includes('pre-build')) {
    return progress >= 70 ? STAGE_BY_ID.build : STAGE_BY_ID.prepare;
  }
  // Fetching or loading already-built fragments is view preparation.
  if (progress >= 50 && (
    hint.includes('manifest') || hint.includes('cache') || hint.includes('storey')
  )) {
    return STAGE_BY_ID.build;
  }
  if (progress >= 70) return STAGE_BY_ID.build;
  if (progress >= 26) return STAGE_BY_ID.prepare;
  return STAGE_BY_ID.open;
}

function progressAtLeast(progress: number, threshold: number, id: LoadStageId): LoadStageInfo {
  return progress >= threshold ? STAGE_BY_ID[id] : STAGE_BY_ID.open;
}

// ── Friendly copy ──────────────────────────────────────────────────────────

/**
 * Plain-language names for the converter's internal phase tokens. Both the
 * worker-parse path (raw.title) and the sidecar progress snapshots
 * (raw.detail, after the ViewerPanel callback passes the token through)
 * surface these raw strings; without this map users literally see
 * "geometries" as a headline.
 */
const PROCESS_STAGE_COPY: Record<string, string> = {
  geometries: 'Building shapes',
  attributes: 'Reading element data',
  relations: 'Linking elements',
  // `conversion` spans importer initialization, OpenModel, geometry work, and
  // final compression; it is not a signal that only packing remains.
  conversion: 'Processing model data',
  parsing: 'Reading the file',
  // The live-parse path titles checkpoints with IMPORT_STAGE_LABELS values
  // rather than raw process tokens; translate those too.
  'streaming geometry batches': 'Building shapes',
  'indexing element attributes': 'Reading element data',
  'linking model relations': 'Linking elements',
  'processing model data': 'Processing model data',
};

export function humanizeProcessStage(token: string | null | undefined): string | null {
  if (!token) return null;
  return PROCESS_STAGE_COPY[token.trim().toLowerCase()] ?? null;
}

export interface LoadPresentation {
  stage: LoadStageInfo;
  /** Big line: what is happening, in plain words. */
  title: string;
  /** Supporting line: one concrete, human sentence. */
  detail: string;
  /** Eyebrow chip naming the load kind, or null while unknown. */
  chip: string | null;
  /** One-line reassurance shown on cold loads, or null. */
  caption: string | null;
  /** Raw pipeline detail, for the small technical sub-line. */
  techDetail: string;
}

/**
 * Recover the inner work percent from the raw band mappings so the copy can
 * say "62% done" without threading extra state through the pipeline.
 * Bands: server convert maps pct into 30-70, worker/live parse into 28-92.
 */
export function innerWorkPercent(progress: number, sourceHint: string): number | null {
  const hint = sourceHint.toLowerCase();
  if (hint.includes('convert') && progress >= 30 && progress < 70) {
    return Math.round(Math.min(100, Math.max(0, (progress - 30) / 0.4)));
  }
  if (hint.includes('parse') && progress >= 28 && progress < 93) {
    return Math.round(Math.min(100, Math.max(0, (progress - 28) / 0.64)));
  }
  return null;
}

const COLD_LOAD_CAPTION = 'First open builds a cache, later opens are faster';

/** Compose the user-facing strings for a raw pipeline report. */
export function presentLoadProgress(
  raw: ViewerLoadProgress,
  context: {
    fileName?: string | null;
    fileSizeMB?: number | null;
    cachesEnabled?: boolean;
  } = {},
): LoadPresentation {
  const stage = deriveLoadStage(raw.progress, raw.sourceHint);
  const hint = raw.sourceHint.toLowerCase();
  const kind = pathKindForSourceHint(raw.sourceHint);
  const fileLabel = context.fileName
    ? context.fileSizeMB && context.fileSizeMB >= 1
      ? `${context.fileName} (${context.fileSizeMB.toFixed(0)} MB)`
      : context.fileName
    : null;

  let title: string = stage.label;
  let detail = '';

  switch (stage.id) {
    case 'open': {
      detail = fileLabel ? `Reading ${fileLabel}` : 'Reading the model file';
      break;
    }
    case 'prepare': {
      const pct = innerWorkPercent(raw.progress, raw.sourceHint);
      const subStage =
        humanizeProcessStage(raw.detail) ?? humanizeProcessStage(raw.title);
      const work = subStage ?? 'Turning the file into 3D shapes';
      if (hint.includes('pre-build')) {
        detail = 'The server is converting this file, first open can take a minute';
      } else if (pct != null && pct > 0) {
        detail = `${work}, ${pct}% done`;
      } else {
        detail = work;
      }
      break;
    }
    case 'build': {
      detail = kind === 'cached'
        ? 'Found a saved copy, loading it now'
        : 'Loading the model into the viewer';
      break;
    }
    case 'finish': {
      if (raw.progress >= 100) title = 'Ready';
      detail = 'Setting up the camera and controls';
      break;
    }
  }

  const chip =
    kind === 'cached' ? 'From cache'
      : kind === 'server-convert' ? 'First load'
        : kind === 'browser-parse' ? 'In-browser'
          : null;

  const caption =
    context.cachesEnabled !== false
      && (kind === 'server-convert' || kind === 'browser-parse')
      && stage.id === 'prepare'
      ? COLD_LOAD_CAPTION
      : null;

  return { stage, title, detail, chip, caption, techDetail: raw.detail };
}

// ── Expected-duration model (priors + this machine's history) ─────────────

export type LoadPathKind = 'cached' | 'server-convert' | 'browser-parse' | 'unknown';

/** Classify the active load path from the pipeline's sourceHint. */
export function pathKindForSourceHint(sourceHint: string): LoadPathKind {
  const hint = sourceHint.toLowerCase();
  if (hint.includes('parse')) return 'browser-parse';
  if (hint.includes('convert') || hint.includes('pre-build')) return 'server-convert';
  // Only confirmed hits/serves count as the cached path; probe hints like
  // "Cache check" or "Manifest check" must stay unknown or the chip lies
  // on cold loads ('Server manifest' is the confirmed-hit hint).
  if (
    hint.includes('cache hit')
    || hint.includes('server manifest')
    || hint.includes('server cache')
    || hint.includes('fragment-cache')
    || hint.includes('fragments-cache')
  ) {
    return 'cached';
  }
  return 'unknown';
}

const PATH_SOURCES: Record<Exclude<LoadPathKind, 'unknown'>, string[]> = {
  cached: ['server-cache', 'fragments-cache'],
  'server-convert': ['server-convert'],
  'browser-parse': ['worker-parse', 'ifc-parse'],
};

/** Fallback expectations (ms) when this machine has no history yet. */
const PRIOR_TOTAL_MS: Record<LoadPathKind, number> = {
  cached: 12_000,
  'server-convert': 30_000,
  'browser-parse': 45_000,
  unknown: 25_000,
};

export interface ExpectedTotal {
  ms: number;
  /** True when the estimate comes from real samples on this machine. */
  fromHistory: boolean;
}

/**
 * Expected total load duration for a path, using the median of this
 * machine's recent loads of the same kind (from the localStorage perf log)
 * and falling back to fixed priors. History wins because the dominant cost
 * (CPU geometry conversion) is machine-specific. `fromHistory` is only true
 * with 2+ samples, which also gates whether the UI shows a remaining-time
 * estimate at all.
 */
export function estimateExpectedTotal(
  kind: LoadPathKind,
  history: ViewerPerfLogEntry[] | null | undefined,
): ExpectedTotal {
  if (kind === 'unknown' || !history?.length) {
    return { ms: PRIOR_TOTAL_MS[kind], fromHistory: false };
  }
  const sources = PATH_SOURCES[kind];
  const samples = history
    .filter((e) => e && sources.includes(e.source) && Number.isFinite(e.ttfrMs) && e.ttfrMs > 0)
    .slice(0, 5)
    .map((e) => e.ttfrMs)
    .sort((a, b) => a - b);
  if (!samples.length) return { ms: PRIOR_TOTAL_MS[kind], fromHistory: false };
  const median = samples[Math.floor(samples.length / 2)];
  // Clamp to a sane window so one corrupted sample cannot wedge the pacing.
  return {
    ms: Math.min(600_000, Math.max(1_500, median)),
    fromHistory: samples.length >= 2,
  };
}

// ── Pace model ─────────────────────────────────────────────────────────────
//
// Between checkpoints the displayed percent approaches a ceiling just below
// the next known checkpoint, with a time constant proportional to how much
// of the total load that gap is expected to take. The result:
//   - always moving (no frozen bar),
//   - never overtakes reality by more than one checkpoint,
//   - long phases advance slowly and honestly instead of stalling,
//   - when a real checkpoint lands early the bar sweeps up fast, which
//     reads as the load "speeding up" near completion.

export interface PaceMilestone {
  /** Raw checkpoint band start (inclusive). */
  from: number;
  /** Display ceiling while inside this band. */
  ceiling: number;
  /** Expected share of total load time spent inside this band. */
  share: number;
}

/**
 * Band table for the production pipeline. `from` values mirror the raw
 * checkpoint constants in ViewerPanel's init(). The conversion band (28-70)
 * receives continuous raw updates, so its ceiling rides a few points above
 * the latest raw value instead of a fixed number.
 */
export const PACE_MILESTONES: readonly PaceMilestone[] = [
  { from: 0, ceiling: 12, share: 0.04 },
  { from: 10, ceiling: 18, share: 0.04 },
  { from: 14, ceiling: 24, share: 0.04 },
  { from: 22, ceiling: 32, share: 0.06 },
  { from: 28, ceiling: 69.5, share: 0.42 },
  { from: 70, ceiling: 93.5, share: 0.22 },
  { from: 94, ceiling: 95.5, share: 0.06 },
  { from: 96, ceiling: 97.5, share: 0.06 },
  { from: 98, ceiling: 99.4, share: 0.06 },
] as const;

function milestoneFor(anchor: number): PaceMilestone {
  let current = PACE_MILESTONES[0];
  for (const m of PACE_MILESTONES) {
    if (anchor >= m.from) current = m;
    else break;
  }
  return current;
}

export interface PaceState {
  /** Latest raw checkpoint from the pipeline. */
  anchor: number;
  /** Displayed percent (monotonic). */
  display: number;
  /** Expected total load duration driving the time constants. */
  expectedTotalMs: number;
}

export function createPaceState(initialRaw: number, expectedTotalMs: number): PaceState {
  const raw = clampPct(initialRaw);
  return { anchor: raw, display: raw, expectedTotalMs };
}

function clampPct(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

/** How fast the display closes the gap to a freshly-raised checkpoint. */
const CATCH_UP_MS = 450;

/**
 * Token motion (0.5% per minute) used when the pipeline has regressed
 * below the anchor (a server path was abandoned and a browser parse
 * restarted): the bar must not climb toward a ceiling the pipeline
 * abandoned, but must also never look frozen.
 */
const FALLBACK_CRAWL_PCT_PER_MS = 0.5 / 60_000;

/**
 * Advance the pace model by `dtMs`. Pure: returns the next state.
 *
 * `rawPct` below the current anchor is ignored (fallback branches can
 * re-report lower checkpoints; the user must never see the bar move back).
 * `rawPct >= 100` snaps to 100 so completion lands cleanly.
 */
export function advancePace(state: PaceState, rawPct: number, dtMs: number): PaceState {
  const raw = clampPct(rawPct);
  const anchor = Math.max(state.anchor, raw);
  if (anchor >= 100) {
    return { ...state, anchor: 100, display: 100 };
  }
  const dt = Math.max(0, dtMs);
  let display = state.display;

  if (display < anchor) {
    // A real checkpoint moved ahead of the display: sweep up quickly.
    const gap = anchor - display;
    display += gap * Math.min(1, dt / CATCH_UP_MS);
  } else {
    // Drift toward the band ceiling with a duration-aware time constant.
    const band = milestoneFor(anchor);
    const inConversionBand = anchor >= 28 && anchor < 70;
    const ceiling = inConversionBand
      ? Math.min(band.ceiling, anchor + 6)
      : band.ceiling;
    const headroom = ceiling - display;
    if (headroom > 0.05) {
      if (raw < anchor) {
        // Fallback regime: the pipeline re-reported below the anchor.
        // Crawl instead of drifting so the bar stays honest until the
        // restarted path catches back up.
        display += Math.min(headroom, dt * FALLBACK_CRAWL_PCT_PER_MS);
      } else {
        // Reach ~63% of the remaining headroom over the band's expected
        // duration, with a floor so very fast machines still see motion.
        const tau = Math.max(700, state.expectedTotalMs * band.share);
        display += headroom * (1 - Math.exp(-dt / tau));
      }
    } else if (display < 99.4) {
      // Band ceiling saturated (a stalled phase, or fallback regressions
      // wedged the anchor in a band whose ceiling the display already
      // reached): glacial creep toward the global cap so the bar is never
      // frozen. Floored at 60 s so short expected loads do not race to 99.
      const creepTau = Math.max(60_000, state.expectedTotalMs * 3);
      display += (99.4 - display) * (1 - Math.exp(-dt / creepTau));
    }
  }

  display = Math.min(99.4, Math.max(display, state.display));
  return { ...state, anchor, display };
}

// ── Time line ──────────────────────────────────────────────────────────────

export interface EtaText {
  /** e.g. "about 20s left" or "32s elapsed" or null when too early to say. */
  text: string | null;
  /** True once the load has overrun the estimate (switches to elapsed). */
  overrun: boolean;
}

function formatElapsed(elapsedMs: number): string {
  const elapsedSec = Math.floor(elapsedMs / 1000);
  return elapsedSec < 60
    ? `${elapsedSec}s elapsed`
    : `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s elapsed`;
}

/**
 * Honest time line. Quiet for the first moments. With history backing, a
 * remaining estimate rounded to 5s so it never counts down digit by digit;
 * once the estimate is blown (or without history), plain elapsed time,
 * because predictability beats optimism.
 */
export function formatEta(
  elapsedMs: number,
  expectedTotalMs: number,
  fromHistory: boolean,
): EtaText {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 3_000) return { text: null, overrun: false };
  const remainingMs = expectedTotalMs - elapsedMs;
  if (!fromHistory || remainingMs <= 2_000) {
    return { text: formatElapsed(elapsedMs), overrun: remainingMs <= 2_000 };
  }
  const remainingSec = Math.max(5, Math.round(remainingMs / 5000) * 5);
  if (remainingSec >= 90) {
    return { text: `about ${Math.round(remainingSec / 60)} min left`, overrun: false };
  }
  return { text: `about ${remainingSec}s left`, overrun: false };
}
