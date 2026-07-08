import { describe, it, expect } from 'vitest';
import {
  chooseColdLoadOrder,
  shouldAttemptServerConvert,
  shouldRepromoteCapabilities,
  isCapabilityProbeTimeoutReason,
  isHttpServerErrorReason,
  isRecoverableServerConvertFailure,
  defaultParsePathLabel,
  type ColdLoadInputs,
} from '../loadStrategy';

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
