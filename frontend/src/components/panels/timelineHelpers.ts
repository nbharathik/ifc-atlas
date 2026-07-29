/**
 * Pure helpers for the TimelinePanel (plan C4).
 *
 * The timeline merges two backend feeds into one newest-first list:
 *   - GET /ifc/operations/history → actor-attributed op-log entries
 *   - GET /ifc/checkpoints        → git snapshots (restorable / diffable)
 *
 * Auto-snapshot checkpoints carry the commit message
 * `"{op.name} ({actor}): {description}"` (truncated to 200 chars server-side,
 * see operation_service._snapshot_after), which lets us correlate a checkpoint
 * back to the op that produced it and render ONE combined row instead of two
 * near-duplicates. Extracted so all of this is unit-testable without React.
 */
import type { IFCCheckpoint } from '../../types/ifc';

export type TimelineActor = 'user' | 'agent' | 'mcp' | 'system';
export type ActorFilter = 'all' | TimelineActor;

/** Shape of one /ifc/operations/history entry after defensive parsing. */
export interface OperationLogEntry {
  op_id: string;
  ts: number; // epoch seconds (backend time.time())
  actor: TimelineActor;
  name: string;
  ok: boolean;
  changed: boolean;
  patch_tier: string;
  changed_ids: number[];
  description: string;
  edit_id: string | null;
  error: string | null;
}

export interface TimelineItem {
  kind: 'operation' | 'checkpoint';
  /** Epoch ms - uniform sort key (op ts arrives in seconds, checkpoint ts as ISO). */
  ts: number;
  /** Human line for the row: op description, falling back to op name / commit message. */
  label: string;
  /** Op actor; for checkpoints, the correlated op's actor (undefined when unknown). */
  actor?: TimelineActor;
  // Checkpoint-only fields.
  sha?: string;
  isInitial?: boolean;
  message?: string;
  /** Present on operation rows and on checkpoints correlated to an op. */
  op?: OperationLogEntry;
}

const ACTOR_SET: ReadonlySet<string> = new Set(['user', 'agent', 'mcp', 'system']);

/** Filter-chip vocabulary, in display order. */
export const ACTOR_FILTERS: readonly { id: ActorFilter; label: string }[] = Object.freeze([
  { id: 'all', label: 'All' },
  { id: 'user', label: 'You' },
  { id: 'agent', label: 'AI' },
  { id: 'mcp', label: 'MCP' },
  { id: 'system', label: 'System' },
]);

export function actorLabel(actor: TimelineActor): string {
  const entry = ACTOR_FILTERS.find((f) => f.id === actor);
  return entry ? entry.label : actor;
}

/**
 * Coerce the untyped `/operations/history` payload into typed entries.
 * Entries without an op identity are dropped; unknown actors become 'system'
 * so a future actor vocabulary addition degrades gracefully instead of
 * breaking the filter.
 */
export function parseOperationEntries(raw: readonly Record<string, unknown>[]): OperationLogEntry[] {
  const out: OperationLogEntry[] = [];
  for (const r of raw) {
    if (typeof r !== 'object' || r === null) continue;
    const opId = typeof r.op_id === 'string' ? r.op_id : null;
    const name = typeof r.name === 'string' ? r.name : null;
    if (!opId || !name) continue;
    out.push({
      op_id: opId,
      ts: typeof r.ts === 'number' && Number.isFinite(r.ts) ? r.ts : 0,
      actor: typeof r.actor === 'string' && ACTOR_SET.has(r.actor) ? (r.actor as TimelineActor) : 'system',
      name,
      ok: r.ok !== false,
      changed: r.changed === true,
      patch_tier: typeof r.patch_tier === 'string' ? r.patch_tier : 'none',
      changed_ids: Array.isArray(r.changed_ids)
        ? r.changed_ids.filter((n): n is number => typeof n === 'number')
        : [],
      description: typeof r.description === 'string' ? r.description : '',
      edit_id: typeof r.edit_id === 'string' ? r.edit_id : null,
      error: typeof r.error === 'string' ? r.error : null,
    });
  }
  return out;
}

/** The exact commit stamp the backend writes for an auto-snapshot. */
export function checkpointStamp(
  op: Pick<OperationLogEntry, 'name' | 'actor' | 'description'>,
): string {
  return `${op.name} (${op.actor}): ${op.description}`.slice(0, 200);
}

function isoToMs(iso: string): number | null {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * Find the op-log entry that produced a checkpoint. Match strength:
 * exact stamp > `"{name} ({actor}):"` prefix > message contains the op
 * description. Ties (repeated identical edits) resolve to the op whose
 * timestamp is closest to the commit's.
 */
export function correlateCheckpointToOp(
  checkpoint: Pick<IFCCheckpoint, 'message' | 'timestamp'>,
  ops: readonly OperationLogEntry[],
): OperationLogEntry | null {
  const cpTs = isoToMs(checkpoint.timestamp);
  let best: OperationLogEntry | null = null;
  let bestScore = 0;
  let bestDist = Infinity;
  for (const op of ops) {
    let score = 0;
    if (checkpoint.message === checkpointStamp(op)) score = 3;
    else if (checkpoint.message.startsWith(`${op.name} (${op.actor}):`)) score = 2;
    else if (op.description !== '' && checkpoint.message.includes(op.description)) score = 1;
    if (score === 0) continue;
    const dist = cpTs === null ? 0 : Math.abs(cpTs - op.ts * 1000);
    if (score > bestScore || (score === bestScore && dist < bestDist)) {
      best = op;
      bestScore = score;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Merge ops + checkpoints into one newest-first timeline. A checkpoint that
 * correlates to an op absorbs it (one event, one row - the row is restorable
 * AND actor-badged); each op is claimed by at most one checkpoint. Ops that
 * never snapshotted (failed / read-only) and checkpoints with no matching op
 * (baseline, rollbacks recorded before the op log existed) stay as their own
 * rows.
 */
export function buildTimeline(
  ops: readonly OperationLogEntry[],
  checkpoints: readonly IFCCheckpoint[],
): TimelineItem[] {
  const items: TimelineItem[] = [];
  const claimed = new Set<string>();

  for (const cp of checkpoints) {
    const op = correlateCheckpointToOp(cp, ops.filter((o) => !claimed.has(o.op_id)));
    if (op) claimed.add(op.op_id);
    items.push({
      kind: 'checkpoint',
      ts: isoToMs(cp.timestamp) ?? 0,
      label: op?.description || cp.message,
      actor: op?.actor,
      sha: cp.sha,
      isInitial: cp.is_initial,
      message: cp.message,
      op: op ?? undefined,
    });
  }

  for (const op of ops) {
    if (claimed.has(op.op_id)) continue;
    items.push({
      kind: 'operation',
      ts: Math.round(op.ts * 1000),
      label: op.description || op.name,
      actor: op.actor,
      op,
    });
  }

  // Newest first; on a timestamp tie the checkpoint wins the top slot because
  // the snapshot is written after the op it records.
  return items.sort(
    (a, b) => b.ts - a.ts || (a.kind === 'checkpoint' ? 0 : 1) - (b.kind === 'checkpoint' ? 0 : 1),
  );
}

/** Actor filter: hides non-matching operation rows; checkpoints always stay. */
export function filterTimelineByActor(
  items: readonly TimelineItem[],
  filter: ActorFilter,
): TimelineItem[] {
  if (filter === 'all') return items.slice();
  return items.filter((it) => it.kind === 'checkpoint' || it.actor === filter);
}

/**
 * Order a compare selection for GET /ifc/history/diff: `from` must be the
 * older sha; a single selection compares against the CURRENT working model
 * (toSha null → omitted from the request).
 */
export function orderCompareSelection(
  selection: readonly string[],
  items: readonly TimelineItem[],
): { fromSha: string; toSha: string | null } | null {
  if (selection.length === 0) return null;
  if (selection.length === 1) return { fromSha: selection[0], toSha: null };
  const tsOf = (sha: string) => items.find((it) => it.sha === sha)?.ts ?? 0;
  const [a, b] = selection;
  return tsOf(a) <= tsOf(b) ? { fromSha: a, toSha: b } : { fromSha: b, toSha: a };
}

/** Compact relative time ("just now", "5m ago", …); empty string for bad input. */
export function formatRelativeTime(tsMs: number, nowMs: number = Date.now()): string {
  if (!Number.isFinite(tsMs) || tsMs <= 0) return '';
  const diffMs = nowMs - tsMs;
  if (diffMs < 45_000) return 'just now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(diffMs / 86_400_000);
  if (days < 7) return `${days}d ago`;
  return new Date(tsMs).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Pure helpers for the CheckpointPanel.
 * Extracted so they can be unit-tested without mounting React components.
 */

/** Format an ISO-8601 timestamp as "Mon DD, HH:MM". */
export function formatCheckpointTs(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/** Short SHA label used in the UI. Input may be any length; we show at most 12 chars. */
export function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

/** Build an accessible title for a restore button. */
export function restoreButtonTitle(sha: string, message: string): string {
  return `Restore model to checkpoint ${sha} - "${message}"`;
}
