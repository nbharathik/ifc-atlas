export interface ViewerPerfSample {
  readonly name: string;
  readonly durationMs: number;
}

export interface ViewerPerfSummary {
  readonly name: string;
  readonly count: number;
  readonly minMs: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

export interface ViewerPerfCollector {
  add: (name: string, durationMs: number) => void;
  scoped: <T>(name: string, run: () => T) => T;
  scopedAsync: <T>(name: string, run: () => Promise<T>) => Promise<T>;
  samples: () => readonly ViewerPerfSample[];
  summarize: (name: string) => ViewerPerfSummary | null;
  clear: () => void;
}

export interface ViewerPerfCollectorOptions {
  readonly now?: () => number;
  readonly cap?: number;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

export function summarizeViewerPerfSamples(
  name: string,
  samples: readonly ViewerPerfSample[],
): ViewerPerfSummary | null {
  const durations = samples
    .filter((sample) => sample.name === name && Number.isFinite(sample.durationMs) && sample.durationMs >= 0)
    .map((sample) => sample.durationMs)
    .sort((a, b) => a - b);

  if (durations.length === 0) return null;

  return {
    name,
    count: durations.length,
    minMs: durations[0],
    medianMs: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    maxMs: durations[durations.length - 1],
  };
}

export function createViewerPerfCollector(
  options: ViewerPerfCollectorOptions = {},
): ViewerPerfCollector {
  const now = options.now ?? (() => performance.now());
  const cap = options.cap ?? 500;
  const collected: ViewerPerfSample[] = [];

  const add = (name: string, durationMs: number) => {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    collected.push({ name, durationMs });
    if (collected.length > cap) {
      collected.splice(0, collected.length - cap);
    }
  };

  const scoped = <T>(name: string, run: () => T): T => {
    const start = now();
    try {
      return run();
    } finally {
      add(name, now() - start);
    }
  };

  const scopedAsync = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const start = now();
    try {
      return await run();
    } finally {
      add(name, now() - start);
    }
  };

  return {
    add,
    scoped,
    scopedAsync,
    samples: () => collected.slice(),
    summarize: (name: string) => summarizeViewerPerfSamples(name, collected),
    clear: () => {
      collected.splice(0, collected.length);
    },
  };
}
