import type { ActivityEntry } from '../../store/useStore';

export type ActivityKind = ActivityEntry['kind'];

export const ACTIVITY_KINDS: readonly ActivityKind[] = Object.freeze([
  'select',
  'highlight',
  'isolate',
  'hide',
  'show-all',
  'tool',
  'chat',
  'screenshot',
  'view',
  'edit',
  'info',
  'error',
]);

export const ACTIVITY_KIND_SET: ReadonlySet<ActivityKind> = new Set(ACTIVITY_KINDS);

export const ACTIVITY_FILTER_STORAGE_KEY = 'pref.activity.mutedKinds.v1';

/**
 * Filter activity entries by hiding kinds present in `mutedKinds`.
 * Empty muted set passes everything through unchanged.
 */
export function filterActivityEntries(
  entries: readonly ActivityEntry[],
  mutedKinds: ReadonlySet<ActivityKind>,
): ActivityEntry[] {
  if (mutedKinds.size === 0) return entries.slice();
  return entries.filter((e) => !mutedKinds.has(e.kind));
}

/** Pure reducer: toggle a kind in / out of the muted set. Returns a new set. */
export function toggleMutedKind(
  current: ReadonlySet<ActivityKind>,
  kind: ActivityKind,
): ReadonlySet<ActivityKind> {
  const next = new Set(current);
  if (next.has(kind)) next.delete(kind);
  else next.add(kind);
  return next;
}

/** Hidden-entry count for the "(N hidden)" hint. */
export function countHiddenEntries(
  entries: readonly ActivityEntry[],
  mutedKinds: ReadonlySet<ActivityKind>,
): number {
  if (mutedKinds.size === 0) return 0;
  let n = 0;
  for (const e of entries) if (mutedKinds.has(e.kind)) n += 1;
  return n;
}

/**
 * Sanitise an unknown payload into a kind set. Drops anything that isn't a
 * known kind so future kind-vocabulary additions stay forward-compatible
 * (older persisted blobs ignore unknown strings rather than poisoning the
 * filter).
 */
export function parseMutedKindsPayload(raw: unknown): Set<ActivityKind> {
  const out = new Set<ActivityKind>();
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (typeof item === 'string' && ACTIVITY_KIND_SET.has(item as ActivityKind)) {
      out.add(item as ActivityKind);
    }
  }
  return out;
}

/** Read persisted muted kinds. Defaults to empty set (= no filter). */
export function readMutedKindsFromStorage(
  storage: Pick<Storage, 'getItem'> | null | undefined = typeof localStorage !== 'undefined' ? localStorage : null,
): Set<ActivityKind> {
  if (!storage) return new Set();
  try {
    const raw = storage.getItem(ACTIVITY_FILTER_STORAGE_KEY);
    if (raw == null) return new Set();
    return parseMutedKindsPayload(JSON.parse(raw));
  } catch {
    return new Set();
  }
}

export function writeMutedKindsToStorage(
  muted: ReadonlySet<ActivityKind>,
  storage: Pick<Storage, 'setItem'> | null | undefined = typeof localStorage !== 'undefined' ? localStorage : null,
): void {
  if (!storage) return;
  try {
    storage.setItem(ACTIVITY_FILTER_STORAGE_KEY, JSON.stringify(Array.from(muted)));
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}
