import { describe, expect, it } from 'vitest';

import type { AabbCacheStatusDto } from '../../api';
import {
  aabbSourceLabel,
  aabbStatusChanged,
  aabbStatusLabel,
  aabbStatusPollIntervalMs,
  isAabbCacheWarmEnough,
  isAabbSourceTrustworthy,
} from '../aabbStatusHelpers';

function status(partial: Partial<AabbCacheStatusDto>): AabbCacheStatusDto {
  return {
    sha: 'abc',
    state: 'idle',
    count: 0,
    total_expected: 0,
    total_ms: 0,
    error: null,
    ...partial,
  };
}

describe('aabbStatusPollIntervalMs', () => {
  it('polls fastest while computing', () => {
    expect(aabbStatusPollIntervalMs('computing')).toBeLessThan(
      aabbStatusPollIntervalMs('idle'),
    );
  });

  it('polls slowest when steady-ready', () => {
    expect(aabbStatusPollIntervalMs('ready')).toBeGreaterThanOrEqual(10_000);
  });

  it('backs off on failure', () => {
    expect(aabbStatusPollIntervalMs('failed')).toBeGreaterThanOrEqual(
      aabbStatusPollIntervalMs('idle'),
    );
  });
});

describe('aabbStatusLabel', () => {
  it('handles null status', () => {
    expect(aabbStatusLabel(null)).toMatch(/unknown/i);
  });

  it('shows count/total when computing with a total', () => {
    const s = status({ state: 'computing', count: 12, total_expected: 100 });
    expect(aabbStatusLabel(s)).toContain('12/100');
  });

  it('omits the slash when no total expected', () => {
    const s = status({ state: 'computing', count: 12, total_expected: 0 });
    const label = aabbStatusLabel(s);
    expect(label).toContain('12');
    expect(label).not.toContain('12/');
  });

  it('surfaces error text on failure', () => {
    const s = status({ state: 'failed', error: 'boom' });
    expect(aabbStatusLabel(s)).toContain('boom');
  });
});

describe('aabbSourceLabel', () => {
  it('labels each provenance distinctly', () => {
    const labels = new Set([
      aabbSourceLabel('real'),
      aabbSourceLabel('mixed'),
      aabbSourceLabel('placement'),
    ]);
    expect(labels.size).toBe(3);
  });
});

describe('isAabbCacheWarmEnough', () => {
  it('rejects null + non-ready states', () => {
    expect(isAabbCacheWarmEnough(null)).toBe(false);
    expect(isAabbCacheWarmEnough(status({ state: 'computing', count: 99 }))).toBe(false);
    expect(isAabbCacheWarmEnough(status({ state: 'idle', count: 99 }))).toBe(false);
    expect(isAabbCacheWarmEnough(status({ state: 'failed', count: 99 }))).toBe(false);
  });

  it('accepts ready with count >= minCount', () => {
    expect(isAabbCacheWarmEnough(status({ state: 'ready', count: 1 }))).toBe(true);
    expect(
      isAabbCacheWarmEnough(status({ state: 'ready', count: 5 }), 10),
    ).toBe(false);
    expect(
      isAabbCacheWarmEnough(status({ state: 'ready', count: 50 }), 10),
    ).toBe(true);
  });
});

describe('isAabbSourceTrustworthy', () => {
  it('only "placement" is untrustworthy for frustum culling', () => {
    expect(isAabbSourceTrustworthy('real')).toBe(true);
    expect(isAabbSourceTrustworthy('mixed')).toBe(true);
    expect(isAabbSourceTrustworthy('placement')).toBe(false);
  });
});

describe('aabbStatusChanged', () => {
  it('null/null is no change', () => {
    expect(aabbStatusChanged(null, null)).toBe(false);
  });

  it('any-vs-null is a change', () => {
    expect(aabbStatusChanged(null, status({ state: 'ready' }))).toBe(true);
    expect(aabbStatusChanged(status({ state: 'ready' }), null)).toBe(true);
  });

  it('identity / same shape is no change', () => {
    const a = status({ state: 'ready', count: 5 });
    expect(aabbStatusChanged(a, a)).toBe(false);
    expect(aabbStatusChanged(a, { ...a })).toBe(false);
  });

  it('detects state / count / error / sha changes', () => {
    const base = status({ state: 'computing', count: 5 });
    expect(aabbStatusChanged(base, { ...base, state: 'ready' })).toBe(true);
    expect(aabbStatusChanged(base, { ...base, count: 6 })).toBe(true);
    expect(aabbStatusChanged(base, { ...base, error: 'boom' })).toBe(true);
    expect(aabbStatusChanged(base, { ...base, sha: 'def' })).toBe(true);
  });

  it('ignores cosmetic-only timing changes', () => {
    const base = status({ state: 'ready', count: 5, total_ms: 100 });
    expect(aabbStatusChanged(base, { ...base, total_ms: 200 })).toBe(false);
  });
});
