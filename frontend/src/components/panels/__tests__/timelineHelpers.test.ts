/**
 * Timeline merge/correlation contract (plan C4).
 *
 * Pins the op-log parsing rules, the checkpoint↔op correlation (the backend
 * stamps auto-snapshot commits as `"{name} ({actor}): {description}"`), the
 * newest-first merge order, and the actor filter's "checkpoints always shown"
 * rule.
 */
import { describe, it, expect } from 'vitest';
import {
  actorLabel,
  buildTimeline,
  checkpointStamp,
  correlateCheckpointToOp,
  filterTimelineByActor,
  formatRelativeTime,
  orderCompareSelection,
  parseOperationEntries,
  type OperationLogEntry,
} from '../timelineHelpers';
import type { IFCCheckpoint } from '../../../types/ifc';

function op(partial: Partial<OperationLogEntry> = {}): OperationLogEntry {
  return {
    op_id: 'op-1',
    ts: 1_770_000_000, // epoch seconds
    actor: 'user',
    name: 'set_property',
    ok: true,
    changed: true,
    patch_tier: 'metadata',
    changed_ids: [42],
    description: 'Set Name on wall',
    edit_id: 'edit-1',
    error: null,
    ...partial,
  };
}

function cp(partial: Partial<IFCCheckpoint> = {}): IFCCheckpoint {
  return {
    sha: 'abc1234',
    message: 'set_property (user): Set Name on wall',
    timestamp: '2026-02-02T02:40:00Z', // = 1_770_000_000 s epoch
    edit_count: 1,
    is_initial: false,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// parseOperationEntries
// ---------------------------------------------------------------------------

describe('parseOperationEntries', () => {
  it('parses a well-formed backend entry', () => {
    const [parsed] = parseOperationEntries([
      {
        op_id: 'a1',
        ts: 123.5,
        actor: 'agent',
        name: 'create_wall',
        ok: true,
        changed: true,
        patch_tier: 'structural',
        changed_ids: [1, 2],
        description: 'Created a wall',
        edit_id: 'e1',
        error: null,
      },
    ]);
    expect(parsed).toEqual({
      op_id: 'a1',
      ts: 123.5,
      actor: 'agent',
      name: 'create_wall',
      ok: true,
      changed: true,
      patch_tier: 'structural',
      changed_ids: [1, 2],
      description: 'Created a wall',
      edit_id: 'e1',
      error: null,
    });
  });

  it('drops entries missing op_id or name', () => {
    expect(
      parseOperationEntries([{ name: 'x' }, { op_id: 'y' }, {}]),
    ).toEqual([]);
  });

  it('maps unknown actors to system (forward compat)', () => {
    const [parsed] = parseOperationEntries([{ op_id: 'a', name: 'n', actor: 'robot' }]);
    expect(parsed.actor).toBe('system');
  });

  it('filters non-numeric changed_ids and defaults missing fields', () => {
    const [parsed] = parseOperationEntries([
      { op_id: 'a', name: 'n', changed_ids: [1, 'two', null, 3] },
    ]);
    expect(parsed.changed_ids).toEqual([1, 3]);
    expect(parsed.ok).toBe(true);
    expect(parsed.changed).toBe(false);
    expect(parsed.description).toBe('');
    expect(parsed.edit_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkpointStamp / correlateCheckpointToOp
// ---------------------------------------------------------------------------

describe('checkpointStamp', () => {
  it('matches the backend commit-message format', () => {
    expect(checkpointStamp(op())).toBe('set_property (user): Set Name on wall');
  });

  it('truncates to 200 chars like the backend', () => {
    const long = op({ description: 'x'.repeat(300) });
    expect(checkpointStamp(long)).toHaveLength(200);
  });
});

describe('correlateCheckpointToOp', () => {
  it('matches on the exact stamp', () => {
    expect(correlateCheckpointToOp(cp(), [op()])).toEqual(op());
  });

  it('matches on the "{name} ({actor}):" prefix when the description was truncated', () => {
    const longOp = op({ description: 'y'.repeat(300) });
    const truncated = cp({ message: checkpointStamp(longOp) });
    expect(correlateCheckpointToOp(truncated, [longOp])).toEqual(longOp);
  });

  it('matches when the message merely contains the op description', () => {
    const o = op({ name: 'apply_pending_edit', description: 'Moved door D-101' });
    const c = cp({ message: 'Edit #4: Moved door D-101' });
    expect(correlateCheckpointToOp(c, [o])).toEqual(o);
  });

  it('does not match on an empty description alone', () => {
    const o = op({ name: 'other_op', description: '' });
    const c = cp({ message: 'Initial model snapshot' });
    expect(correlateCheckpointToOp(c, [o])).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(correlateCheckpointToOp(cp({ message: 'Initial model snapshot' }), [op()])).toBeNull();
  });

  it('resolves repeated identical edits to the timestamp-closest op', () => {
    const older = op({ op_id: 'old', ts: 1_769_999_000 });
    const closer = op({ op_id: 'new', ts: 1_770_000_000 });
    const found = correlateCheckpointToOp(cp(), [older, closer]);
    expect(found?.op_id).toBe('new');
  });

  it('prefers an exact stamp over a weaker description-contains match', () => {
    const weak = op({ op_id: 'weak', name: 'other', description: 'Set Name on wall' });
    const exact = op({ op_id: 'exact' });
    // Weak candidate listed first must not win.
    expect(correlateCheckpointToOp(cp(), [weak, exact])?.op_id).toBe('exact');
  });
});

// ---------------------------------------------------------------------------
// buildTimeline
// ---------------------------------------------------------------------------

describe('buildTimeline', () => {
  it('merges a correlated checkpoint+op into a single checkpoint row', () => {
    const items = buildTimeline([op()], [cp()]);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('checkpoint');
    expect(items[0].sha).toBe('abc1234');
    expect(items[0].actor).toBe('user');
    expect(items[0].op?.op_id).toBe('op-1');
    expect(items[0].label).toBe('Set Name on wall');
  });

  it('keeps uncorrelated ops and checkpoints as separate rows', () => {
    const failed = op({ op_id: 'f1', ok: false, description: 'Bad edit' });
    const baseline = cp({ sha: 'base', message: 'Initial model snapshot', is_initial: true });
    const items = buildTimeline([failed], [baseline]);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.kind).sort()).toEqual(['checkpoint', 'operation']);
  });

  it('sorts newest-first, converting op seconds to ms', () => {
    const newer = op({ op_id: 'n', ts: 2000, description: 'zzz-no-match' });
    const older = cp({ sha: 'c1', message: 'no-match', timestamp: '1970-01-01T00:16:40Z' }); // 1000 s
    const items = buildTimeline([newer], [older]);
    expect(items[0].kind).toBe('operation');
    expect(items[0].ts).toBe(2_000_000);
    expect(items[1].ts).toBe(1_000_000);
  });

  it('puts the checkpoint above the op on a timestamp tie', () => {
    const o = op({ op_id: 'tie', ts: 1_770_000_000, description: 'no-corr' });
    const c = cp({ message: 'unrelated snapshot' }); // same instant, no correlation
    const items = buildTimeline([o], [c]);
    expect(items[0].kind).toBe('checkpoint');
    expect(items[1].kind).toBe('operation');
  });

  it('claims each op for at most one checkpoint', () => {
    const single = op();
    const twin1 = cp({ sha: 'aaa' });
    const twin2 = cp({ sha: 'bbb' });
    const items = buildTimeline([single], [twin1, twin2]);
    const withOp = items.filter((i) => i.op !== undefined);
    expect(withOp).toHaveLength(1);
  });

  it('falls back to the op name when the description is empty', () => {
    const bare = op({ description: '', op_id: 'b' });
    const items = buildTimeline([bare], []);
    expect(items[0].label).toBe('set_property');
  });
});

// ---------------------------------------------------------------------------
// filterTimelineByActor
// ---------------------------------------------------------------------------

describe('filterTimelineByActor', () => {
  const timeline = buildTimeline(
    [
      op({ op_id: 'u', actor: 'user', description: 'user op' }),
      op({ op_id: 'a', actor: 'agent', description: 'agent op' }),
      op({ op_id: 'm', actor: 'mcp', description: 'mcp op' }),
    ],
    [cp({ sha: 'keep', message: 'unrelated snapshot' })],
  );

  it("passes everything through for 'all'", () => {
    expect(filterTimelineByActor(timeline, 'all')).toHaveLength(4);
  });

  it('keeps only matching operation rows', () => {
    const filtered = filterTimelineByActor(timeline, 'agent');
    const opRows = filtered.filter((i) => i.kind === 'operation');
    expect(opRows).toHaveLength(1);
    expect(opRows[0].actor).toBe('agent');
  });

  it('always keeps checkpoints, whatever the filter', () => {
    for (const f of ['user', 'agent', 'mcp', 'system'] as const) {
      const filtered = filterTimelineByActor(timeline, f);
      expect(filtered.some((i) => i.sha === 'keep')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// orderCompareSelection
// ---------------------------------------------------------------------------

describe('orderCompareSelection', () => {
  const items = buildTimeline(
    [],
    [
      cp({ sha: 'newer', message: 'n', timestamp: '2026-02-02T10:00:00Z' }),
      cp({ sha: 'older', message: 'o', timestamp: '2026-02-01T10:00:00Z' }),
    ],
  );

  it('returns null for an empty selection', () => {
    expect(orderCompareSelection([], items)).toBeNull();
  });

  it('compares a single selection against the current model (toSha null)', () => {
    expect(orderCompareSelection(['older'], items)).toEqual({ fromSha: 'older', toSha: null });
  });

  it('orders two selections oldest → newest regardless of click order', () => {
    expect(orderCompareSelection(['newer', 'older'], items)).toEqual({
      fromSha: 'older',
      toSha: 'newer',
    });
    expect(orderCompareSelection(['older', 'newer'], items)).toEqual({
      fromSha: 'older',
      toSha: 'newer',
    });
  });
});

// ---------------------------------------------------------------------------
// formatRelativeTime / actorLabel
// ---------------------------------------------------------------------------

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-02-02T12:00:00Z');

  it('says "just now" under 45s', () => {
    expect(formatRelativeTime(now - 10_000, now)).toBe('just now');
  });

  it('formats minutes', () => {
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m ago');
  });

  it('formats hours', () => {
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3h ago');
  });

  it('formats days under a week', () => {
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe('2d ago');
  });

  it('falls back to a locale date beyond a week', () => {
    const label = formatRelativeTime(now - 30 * 86_400_000, now);
    expect(label).toMatch(/2026/);
  });

  it('returns empty string for invalid input', () => {
    expect(formatRelativeTime(NaN, now)).toBe('');
    expect(formatRelativeTime(0, now)).toBe('');
  });
});

describe('actorLabel', () => {
  it('maps actors to the chip vocabulary', () => {
    expect(actorLabel('user')).toBe('You');
    expect(actorLabel('agent')).toBe('AI');
    expect(actorLabel('mcp')).toBe('MCP');
    expect(actorLabel('system')).toBe('System');
  });
});
