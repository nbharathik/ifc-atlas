import { describe, expect, it } from 'vitest';
import type { ActivityEntry } from '../../../store/useStore';
import {
  ACTIVITY_FILTER_STORAGE_KEY,
  ACTIVITY_KINDS,
  ACTIVITY_KIND_SET,
  countHiddenEntries,
  filterActivityEntries,
  parseMutedKindsPayload,
  readMutedKindsFromStorage,
  toggleMutedKind,
  writeMutedKindsToStorage,
  type ActivityKind,
} from '../activityFilterHelpers';

let seq = 0;
function entry(kind: ActivityKind, summary = `s-${kind}`): ActivityEntry {
  seq += 1;
  return { id: `e-${seq}`, ts: 1_700_000_000_000 + seq, kind, summary };
}

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
}

class ThrowingStorage {
  getItem(_k: string): string | null { throw new Error('boom-get'); }
  setItem(_k: string, _v: string): void { throw new Error('boom-set'); }
}

describe('ACTIVITY_KINDS vocabulary', () => {
  it('lists every ActivityEntry kind exactly once', () => {
    // The kind union is 12 values; we treat ACTIVITY_KINDS as the source of
    // truth for the UI chip order and storage round-tripping. Drift between
    // the union and this list would silently hide a chip; pin the count.
    expect(ACTIVITY_KINDS).toHaveLength(12);
    expect(new Set(ACTIVITY_KINDS).size).toBe(ACTIVITY_KINDS.length);
  });

  it('exposes a Set view that matches the array', () => {
    expect(ACTIVITY_KIND_SET.size).toBe(ACTIVITY_KINDS.length);
    for (const k of ACTIVITY_KINDS) expect(ACTIVITY_KIND_SET.has(k)).toBe(true);
  });

  it('the kinds array is frozen at the module boundary', () => {
    expect(Object.isFrozen(ACTIVITY_KINDS)).toBe(true);
  });
});

describe('filterActivityEntries', () => {
  it('returns a fresh array when no kinds are muted', () => {
    const xs = [entry('select'), entry('chat')];
    const out = filterActivityEntries(xs, new Set());
    expect(out).toEqual(xs);
    expect(out).not.toBe(xs); // copy, not aliased
  });

  it('drops entries whose kind is muted', () => {
    const xs = [entry('select'), entry('tool'), entry('chat'), entry('tool')];
    const out = filterActivityEntries(xs, new Set<ActivityKind>(['tool']));
    expect(out.map((e) => e.kind)).toEqual(['select', 'chat']);
  });

  it('drops everything when all kinds are muted', () => {
    const xs = [entry('select'), entry('chat'), entry('error')];
    const out = filterActivityEntries(xs, new Set<ActivityKind>(ACTIVITY_KINDS));
    expect(out).toEqual([]);
  });

  it('preserves original order', () => {
    const xs = [entry('chat'), entry('tool'), entry('chat'), entry('select'), entry('tool')];
    const out = filterActivityEntries(xs, new Set<ActivityKind>(['select']));
    expect(out.map((e) => e.kind)).toEqual(['chat', 'tool', 'chat', 'tool']);
  });

  it('does not mutate the input', () => {
    const xs = [entry('select'), entry('tool')];
    const before = xs.slice();
    filterActivityEntries(xs, new Set<ActivityKind>(['tool']));
    expect(xs).toEqual(before);
  });
});

describe('toggleMutedKind', () => {
  it('adds the kind when absent', () => {
    const next = toggleMutedKind(new Set(), 'tool');
    expect([...next]).toEqual(['tool']);
  });

  it('removes the kind when present', () => {
    const next = toggleMutedKind(new Set<ActivityKind>(['tool', 'chat']), 'tool');
    expect([...next]).toEqual(['chat']);
  });

  it('returns a new set each time (immutability)', () => {
    const before = new Set<ActivityKind>(['tool']);
    const next = toggleMutedKind(before, 'chat');
    expect(next).not.toBe(before);
    expect([...before]).toEqual(['tool']); // original untouched
  });

  it('round-trips a kind back to the original membership', () => {
    const start = new Set<ActivityKind>(['select']);
    const added = toggleMutedKind(start, 'tool');
    const removed = toggleMutedKind(added, 'tool');
    expect([...removed].sort()).toEqual(['select']);
  });
});

describe('countHiddenEntries', () => {
  it('is zero when no kinds are muted', () => {
    const xs = [entry('select'), entry('tool')];
    expect(countHiddenEntries(xs, new Set())).toBe(0);
  });

  it('counts entries with muted kinds', () => {
    const xs = [entry('select'), entry('tool'), entry('chat'), entry('tool')];
    const muted = new Set<ActivityKind>(['tool']);
    expect(countHiddenEntries(xs, muted)).toBe(2);
  });

  it('handles a multi-kind mute', () => {
    const xs = [entry('select'), entry('tool'), entry('chat'), entry('error')];
    const muted = new Set<ActivityKind>(['tool', 'error']);
    expect(countHiddenEntries(xs, muted)).toBe(2);
  });

  it('returns 0 for an empty list', () => {
    expect(countHiddenEntries([], new Set<ActivityKind>(['tool']))).toBe(0);
  });
});

describe('parseMutedKindsPayload', () => {
  it('returns an empty set for non-arrays', () => {
    expect(parseMutedKindsPayload(null).size).toBe(0);
    expect(parseMutedKindsPayload(undefined).size).toBe(0);
    expect(parseMutedKindsPayload({ kinds: ['tool'] }).size).toBe(0);
    expect(parseMutedKindsPayload('tool').size).toBe(0);
  });

  it('keeps only known kinds', () => {
    const out = parseMutedKindsPayload(['tool', 'chat', 'nope', 42, null]);
    expect([...out].sort()).toEqual(['chat', 'tool']);
  });

  it('deduplicates repeated kinds', () => {
    const out = parseMutedKindsPayload(['tool', 'tool', 'chat', 'tool']);
    expect([...out].sort()).toEqual(['chat', 'tool']);
  });
});

describe('readMutedKindsFromStorage / writeMutedKindsToStorage', () => {
  it('returns an empty set when no storage is available', () => {
    expect(readMutedKindsFromStorage(null).size).toBe(0);
  });

  it('returns an empty set when the key is absent', () => {
    const store = new MemoryStorage();
    expect(readMutedKindsFromStorage(store).size).toBe(0);
  });

  it('round-trips a written set', () => {
    const store = new MemoryStorage();
    const muted = new Set<ActivityKind>(['tool', 'chat']);
    writeMutedKindsToStorage(muted, store);
    const raw = store.getItem(ACTIVITY_FILTER_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!).sort()).toEqual(['chat', 'tool']);
    expect([...readMutedKindsFromStorage(store)].sort()).toEqual(['chat', 'tool']);
  });

  it('drops unknown kinds during read', () => {
    const store = new MemoryStorage();
    store.setItem(ACTIVITY_FILTER_STORAGE_KEY, JSON.stringify(['tool', 'unknown-kind']));
    expect([...readMutedKindsFromStorage(store)]).toEqual(['tool']);
  });

  it('falls back to empty set on JSON parse error', () => {
    const store = new MemoryStorage();
    store.setItem(ACTIVITY_FILTER_STORAGE_KEY, '{not json');
    expect(readMutedKindsFromStorage(store).size).toBe(0);
  });

  it('swallows storage exceptions during read', () => {
    expect(readMutedKindsFromStorage(new ThrowingStorage()).size).toBe(0);
  });

  it('swallows storage exceptions during write', () => {
    expect(() => writeMutedKindsToStorage(new Set<ActivityKind>(['tool']), new ThrowingStorage())).not.toThrow();
  });

  it('no-op write when storage is null', () => {
    expect(() => writeMutedKindsToStorage(new Set<ActivityKind>(['tool']), null)).not.toThrow();
  });
});
