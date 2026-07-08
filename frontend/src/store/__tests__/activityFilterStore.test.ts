import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../useStore';
import {
  ACTIVITY_FILTER_STORAGE_KEY,
  type ActivityKind,
} from '../../components/panels/activityFilterHelpers';

/** In-memory localStorage stub (vitest default env is `node`, no globals). */
function installLocalStorageStub(): { store: Map<string, string> } {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  });
  return { store };
}

let backing: { store: Map<string, string> };

beforeEach(() => {
  backing = installLocalStorageStub();
  useStore.setState({ activityMutedKinds: new Set<ActivityKind>() });
});

describe('activityMutedKinds store slice', () => {
  it('initialises empty', () => {
    expect(useStore.getState().activityMutedKinds.size).toBe(0);
  });

  it('toggleActivityKindMute adds a kind on first call', () => {
    useStore.getState().toggleActivityKindMute('tool');
    expect([...useStore.getState().activityMutedKinds]).toEqual(['tool']);
  });

  it('toggleActivityKindMute removes a kind on second call', () => {
    useStore.getState().toggleActivityKindMute('tool');
    useStore.getState().toggleActivityKindMute('tool');
    expect(useStore.getState().activityMutedKinds.size).toBe(0);
  });

  it('toggleActivityKindMute persists the muted set to localStorage', () => {
    useStore.getState().toggleActivityKindMute('chat');
    const raw = backing.store.get(ACTIVITY_FILTER_STORAGE_KEY);
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toEqual(['chat']);
  });

  it('clearActivityKindMutes empties the set and writes [] to storage', () => {
    useStore.getState().toggleActivityKindMute('tool');
    useStore.getState().toggleActivityKindMute('chat');
    useStore.getState().clearActivityKindMutes();
    expect(useStore.getState().activityMutedKinds.size).toBe(0);
    const raw = backing.store.get(ACTIVITY_FILTER_STORAGE_KEY);
    expect(JSON.parse(raw!)).toEqual([]);
  });

  it('replaces the set reference on each mutation (immutable updates)', () => {
    const a = useStore.getState().activityMutedKinds;
    useStore.getState().toggleActivityKindMute('tool');
    const b = useStore.getState().activityMutedKinds;
    expect(b).not.toBe(a);
    useStore.getState().clearActivityKindMutes();
    const c = useStore.getState().activityMutedKinds;
    expect(c).not.toBe(b);
  });
});
