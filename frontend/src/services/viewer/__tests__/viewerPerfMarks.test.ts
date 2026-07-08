import { describe, expect, it } from 'vitest';
import {
  createViewerPerfCollector,
  summarizeViewerPerfSamples,
} from '../viewerPerfMarks';

describe('viewerPerfMarks', () => {
  it('summarizes deterministic dummy durations', () => {
    const samples = [1, 16, 40, 120].map((durationMs) => ({
      name: 'fragment.update',
      durationMs,
    }));

    expect(summarizeViewerPerfSamples('fragment.update', samples)).toEqual({
      name: 'fragment.update',
      count: 4,
      minMs: 1,
      medianMs: 16,
      p95Ms: 120,
      maxMs: 120,
    });
  });

  it('records scoped sync and async work with an injected fake clock', async () => {
    let now = 0;
    const collector = createViewerPerfCollector({
      now: () => now,
      cap: 10,
    });

    const value = collector.scoped('sync', () => {
      now += 12;
      return 42;
    });
    const asyncValue = await collector.scopedAsync('async', async () => {
      now += 30;
      return 'done';
    });

    expect(value).toBe(42);
    expect(asyncValue).toBe('done');
    expect(collector.summarize('sync')?.maxMs).toBe(12);
    expect(collector.summarize('async')?.maxMs).toBe(30);
  });

  it('caps old samples to keep the collector bounded', () => {
    const collector = createViewerPerfCollector({ cap: 3 });

    collector.add('x', 1);
    collector.add('x', 2);
    collector.add('x', 3);
    collector.add('x', 4);

    expect(collector.samples().map((sample) => sample.durationMs)).toEqual([2, 3, 4]);
  });
});
