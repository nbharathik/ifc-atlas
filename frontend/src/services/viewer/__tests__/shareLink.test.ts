import { describe, it, expect, vi } from 'vitest';
import {
  encodeShareState,
  decodeShareState,
  buildShareHash,
  buildShareUrl,
  parseShareHash,
  type ShareState,
} from '../shareLink';

// ─── encodeShareState + decodeShareState round-trips ─────────────────────────

describe('shareLink encode/decode', () => {
  it('round-trips a full share state', () => {
    const state: ShareState = {
      v: 1,
      cam: { p: [1.5, 2.5, 3.5], t: [0, 0, 0] },
      iso: [42, 7, 13],
      hi: [100, 200],
      tab: 'props',
    };
    const encoded = encodeShareState(state);
    const decoded = decodeShareState(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.v).toBe(1);
    expect(decoded!.cam!.p).toEqual([1.5, 2.5, 3.5]);
    expect(decoded!.cam!.t).toEqual([0, 0, 0]);
    // iso and hi are sorted by encode
    expect(decoded!.iso).toEqual([7, 13, 42]);
    expect(decoded!.hi).toEqual([100, 200]);
    expect(decoded!.tab).toBe('props');
  });

  it('round-trips a state with no camera', () => {
    const state: ShareState = { v: 1, iso: [5, 3], tab: 'chat' };
    const decoded = decodeShareState(encodeShareState(state));
    expect(decoded).not.toBeNull();
    expect(decoded!.cam).toBeUndefined();
    expect(decoded!.iso).toEqual([3, 5]);
    expect(decoded!.tab).toBe('chat');
  });

  it('round-trips a minimal state (only version)', () => {
    const state: ShareState = { v: 1 };
    const decoded = decodeShareState(encodeShareState(state));
    expect(decoded).not.toBeNull();
    expect(decoded!.v).toBe(1);
    expect(decoded!.cam).toBeUndefined();
    expect(decoded!.iso).toBeUndefined();
    expect(decoded!.hi).toBeUndefined();
  });

  it('sorts iso array during encode', () => {
    const state: ShareState = { v: 1, iso: [99, 1, 50, 2] };
    const decoded = decodeShareState(encodeShareState(state));
    expect(decoded!.iso).toEqual([1, 2, 50, 99]);
  });

  it('sorts hi array during encode', () => {
    const state: ShareState = { v: 1, hi: [300, 100, 200] };
    const decoded = decodeShareState(encodeShareState(state));
    expect(decoded!.hi).toEqual([100, 200, 300]);
  });

  it('omits empty iso array from output', () => {
    const state: ShareState = { v: 1, iso: [] };
    const decoded = decodeShareState(encodeShareState(state));
    expect(decoded!.iso).toBeUndefined();
  });

  it('omits empty hi array from output', () => {
    const state: ShareState = { v: 1, hi: [] };
    const decoded = decodeShareState(encodeShareState(state));
    expect(decoded!.hi).toBeUndefined();
  });

  it('rounds camera coordinates to 3 decimal places', () => {
    const state: ShareState = {
      v: 1,
      cam: { p: [1.23456789, 0.000001, -9.999999], t: [0, 0, 0] },
    };
    const decoded = decodeShareState(encodeShareState(state));
    expect(decoded!.cam!.p[0]).toBeCloseTo(1.235, 3);
    expect(decoded!.cam!.p[1]).toBeCloseTo(0, 3);
    expect(decoded!.cam!.p[2]).toBeCloseTo(-10, 3);
  });

  it('produces URL-safe base64url characters (no +, /, =)', () => {
    // Large arrays are more likely to produce padding
    const state: ShareState = {
      v: 1,
      iso: Array.from({ length: 50 }, (_, i) => i * 37),
      hi: Array.from({ length: 20 }, (_, i) => i * 100 + 7),
    };
    const encoded = encodeShareState(state);
    expect(encoded).not.toMatch(/[+/=]/);
  });
});

// ─── decodeShareState error cases ────────────────────────────────────────────

describe('decodeShareState', () => {
  it('returns null for empty string', () => {
    expect(decodeShareState('')).toBeNull();
  });

  it('returns null for invalid base64', () => {
    expect(decodeShareState('!!!not-base64!!!')).toBeNull();
  });

  it('returns null for valid base64 but wrong JSON', () => {
    const encoded = btoa('not json').replace(/=/g, '');
    expect(decodeShareState(encoded)).toBeNull();
  });

  it('returns null for wrong schema version', () => {
    const encoded = btoa(JSON.stringify({ v: 2, iso: [1] })).replace(/=/g, '');
    expect(decodeShareState(encoded)).toBeNull();
  });

  it('ignores cam with wrong shape', () => {
    const raw = JSON.stringify({ v: 1, cam: { p: [1, 2], t: [0, 0, 0] } });
    const encoded = btoa(raw).replace(/=/g, '');
    const decoded = decodeShareState(encoded);
    // 'p' only has 2 elements - invalid; cam is ignored
    expect(decoded!.cam).toBeUndefined();
  });

  it('ignores iso containing non-numbers', () => {
    const raw = JSON.stringify({ v: 1, iso: [1, 'bad', 3] });
    const encoded = btoa(raw).replace(/=/g, '');
    const decoded = decodeShareState(encoded);
    expect(decoded!.iso).toBeUndefined();
  });
});

// ─── buildShareHash + buildShareUrl ──────────────────────────────────────────

describe('buildShareHash', () => {
  it('starts with share: prefix', () => {
    const hash = buildShareHash({ v: 1 });
    expect(hash).toMatch(/^share:/);
  });

  it('produces a decodable payload', () => {
    const state: ShareState = { v: 1, hi: [42] };
    const hash = buildShareHash(state);
    const encoded = hash.replace('share:', '');
    const decoded = decodeShareState(encoded);
    expect(decoded!.hi).toEqual([42]);
  });
});

describe('buildShareUrl', () => {
  it('appends hash to base URL', () => {
    const url = buildShareUrl({ v: 1 }, 'https://example.com/viewer');
    expect(url).toMatch(/^https:\/\/example\.com\/viewer#share:/);
  });
});

// ─── parseShareHash ───────────────────────────────────────────────────────────

describe('parseShareHash', () => {
  it('returns null when hash is absent', () => {
    expect(parseShareHash('')).toBeNull();
    expect(parseShareHash('#')).toBeNull();
  });

  it('returns null when hash does not start with share:', () => {
    expect(parseShareHash('#other-thing')).toBeNull();
    expect(parseShareHash('#/settings')).toBeNull();
  });

  it('parses a valid share hash', () => {
    const state: ShareState = { v: 1, iso: [10, 20], tab: 'log' };
    const hash = `#${buildShareHash(state)}`;
    const parsed = parseShareHash(hash);
    expect(parsed).not.toBeNull();
    expect(parsed!.iso).toEqual([10, 20]);
    expect(parsed!.tab).toBe('log');
  });

  it('returns null for a malformed payload after share: prefix', () => {
    expect(parseShareHash('#share:!!!bad!!!')).toBeNull();
  });
});
