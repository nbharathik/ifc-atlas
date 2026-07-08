import { describe, it, expect } from 'vitest';
import {
  buildFnvFingerprint,
  buildFragmentCacheFingerprint,
} from '../fragmentCacheFingerprint';

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
