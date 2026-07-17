import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getHistoryDiff,
  getOperationsHistory,
  listCheckpoints,
  rollbackToCheckpoint,
  type HistoryDiffEntry,
  type HistoryDiffResult,
} from '../../services/api';
import { formatCheckpointTs, restoreButtonTitle } from '../../services/viewer/checkpointHelpers';
import { useStore } from '../../store/useStore';
import {
  ACTOR_FILTERS,
  actorLabel,
  buildTimeline,
  filterTimelineByActor,
  formatRelativeTime,
  orderCompareSelection,
  parseOperationEntries,
  type ActorFilter,
  type OperationLogEntry,
  type TimelineItem,
} from './timelineHelpers';
import './timelinePanel.css';

// How long the inline restore confirm stays armed before it disarms itself.
const CONFIRM_DISARM_MS = 4000;
// Diff entry rows rendered before collapsing into an "…and N more" line.
const MAX_DIFF_ROWS = 100;

// ─── Actor filter chips ───────────────────────────────────────────────────────

function ActorChips({ filter, onChange }: { filter: ActorFilter; onChange: (f: ActorFilter) => void }) {
  return (
    <div className="tl-chips" role="group" aria-label="Filter operations by actor">
      {ACTOR_FILTERS.map((f) => (
        <button
          key={f.id}
          className={`tl-chip${filter === f.id ? ' tl-chip--active' : ''}`}
          aria-pressed={filter === f.id}
          onClick={() => onChange(f.id)}
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}

// ─── Semantic diff result ─────────────────────────────────────────────────────

interface DiffSectionProps {
  diff: HistoryDiffResult;
  onFlashIds: (ids: number[]) => void;
}

function DiffSection({ diff, onFlashIds }: DiffSectionProps) {
  const flashableIds = diff.entries
    .filter((e) => e.express_id !== null)
    .map((e) => e.express_id as number);

  const entryIcon = (e: HistoryDiffEntry) =>
    e.change === 'added' ? '+' : e.change === 'deleted' ? '−' : '~';

  return (
    <div className="tl-diff" aria-label="Semantic diff result">
      <div className="cp-diff-summary">
        {diff.added > 0 && <span className="cp-diff-added">+{diff.added}</span>}
        {diff.deleted > 0 && <span className="cp-diff-removed">−{diff.deleted}</span>}
        {diff.changed > 0 && <span className="cp-diff-changed">~{diff.changed}</span>}
        {diff.total === 0 && <span className="cp-diff-none">No differences</span>}
        {diff.truncated && <span className="cp-diff-trunc"> (truncated)</span>}
        {flashableIds.length > 0 && (
          <button
            className="cp-diff-flash"
            onClick={() => onFlashIds(flashableIds)}
            title="Flash all changed elements in the 3D viewer"
          >
            ⚡ Highlight all
          </button>
        )}
      </div>

      {diff.entries.length > 0 && (
        <ul className="cp-diff-list tl-diff-list">
          {diff.entries.slice(0, MAX_DIFF_ROWS).map((e) => (
            <li key={e.global_id}>
              <button
                className={`tl-diff-entry cp-diff-entry--${e.change}`}
                disabled={e.express_id === null}
                onClick={() => e.express_id !== null && onFlashIds([e.express_id])}
                title={
                  e.express_id !== null
                    ? 'Flash this element in the 3D viewer'
                    : 'No express id (element not in the current model)'
                }
              >
                <span className="cp-diff-entry-badge">{entryIcon(e)}</span>
                <span className="tl-diff-type">{e.ifc_type ?? '?'}</span>
                <span className="cp-diff-entry-name">{e.name ?? e.global_id}</span>
                {e.express_id !== null && <span className="tl-diff-eid">#{e.express_id}</span>}
              </button>
            </li>
          ))}
          {diff.entries.length > MAX_DIFF_ROWS && (
            <li className="cp-diff-more">…and {diff.entries.length - MAX_DIFF_ROWS} more</li>
          )}
        </ul>
      )}
    </div>
  );
}

// ─── Timeline rows ────────────────────────────────────────────────────────────

function ActorBadge({ actor }: { actor: OperationLogEntry['actor'] }) {
  return <span className={`tl-actor tl-actor--${actor}`}>{actorLabel(actor)}</span>;
}

interface CheckpointRowProps {
  item: TimelineItem; // kind === 'checkpoint'
  isCurrent: boolean;
  selected: boolean;
  onToggleCompare: (sha: string) => void;
  restoring: string | null;
  confirmSha: string | null;
  onRestoreClick: (sha: string) => void;
}

function CheckpointRow({
  item, isCurrent, selected, onToggleCompare, restoring, confirmSha, onRestoreClick,
}: CheckpointRowProps) {
  const sha = item.sha as string;
  const busy = restoring === sha;
  const armed = confirmSha === sha;
  return (
    <div
      className={`cp-row${item.isInitial ? ' cp-row--initial' : ''}${isCurrent ? ' cp-row--current' : ''}`}
    >
      <div className="cp-row-meta">
        <button
          className={`tl-compare-toggle${selected ? ' tl-compare-toggle--on' : ''}`}
          aria-pressed={selected}
          onClick={() => onToggleCompare(sha)}
          title={selected ? 'Deselect from compare' : 'Select for compare'}
        >
          {selected ? '●' : '○'}
        </button>
        <span className="cp-sha" title={sha}>{sha}</span>
        {isCurrent && <span className="cp-badge cp-badge--current">current</span>}
        {item.isInitial && !isCurrent && <span className="cp-badge cp-badge--initial">baseline</span>}
        {item.actor && <ActorBadge actor={item.actor} />}
        <span className="cp-time" title={formatCheckpointTs(new Date(item.ts).toISOString())}>
          {formatRelativeTime(item.ts)}
        </span>
      </div>
      <div className="cp-row-msg" title={item.message}>{item.label}</div>
      <div className="cp-row-actions">
        <button
          className={`cp-restore-btn${armed ? ' tl-restore-confirm' : ''}`}
          disabled={isCurrent || busy || (restoring !== null && !busy)}
          onClick={() => onRestoreClick(sha)}
          title={
            isCurrent
              ? 'This is the current model state'
              : restoreButtonTitle(sha, item.message ?? item.label)
          }
        >
          {busy ? 'Restoring…' : isCurrent ? 'Current' : armed ? 'Confirm?' : 'Restore'}
        </button>
      </div>
    </div>
  );
}

function OperationRow({ item }: { item: TimelineItem }) {
  const op = item.op as OperationLogEntry;
  return (
    <div className={`tl-op-row${op.ok ? '' : ' tl-op-row--failed'}`}>
      <ActorBadge actor={op.actor} />
      <span className="tl-op-desc" title={op.error ?? item.label}>{item.label}</span>
      {!op.ok && <span className="tl-op-failed-badge">failed</span>}
      <span className="cp-time" title={formatCheckpointTs(new Date(item.ts).toISOString())}>
        {formatRelativeTime(item.ts)}
      </span>
    </div>
  );
}

// ─── TimelinePanel ────────────────────────────────────────────────────────────

/**
 * History timeline (plan C4, supersedes the CheckpointPanel): one newest-first
 * feed of operations (actor-attributed) and git checkpoints (restorable), with
 * a two-point semantic compare via ifcdiff.
 */
export function TimelinePanel() {
  const {
    checkpointPanelOpen,
    setCheckpointPanelOpen,
    checkpoints,
    checkpointsAvailable,
    checkpointsLoading,
    setCheckpoints,
    setCheckpointsLoading,
    modelLoaded,
    addToast,
    logActivity,
    flashHighlightIds,
  } = useStore();

  const [ops, setOps] = useState<OperationLogEntry[]>([]);
  const [opsError, setOpsError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actorFilter, setActorFilter] = useState<ActorFilter>('all');
  const [compareSel, setCompareSel] = useState<string[]>([]);
  const [diff, setDiff] = useState<HistoryDiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [confirmSha, setConfirmSha] = useState<string | null>(null);
  const confirmTimerRef = useRef<number | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!modelLoaded) return;
    setCheckpointsLoading(true);
    setLoadError(null);
    setOpsError(null);
    // Independent fetches: an op-log failure must not hide the checkpoints
    // (and vice versa) - older backends may lack one of the endpoints.
    const [cpRes, opsRes] = await Promise.allSettled([
      listCheckpoints(50),
      getOperationsHistory(200),
    ]);
    if (cpRes.status === 'fulfilled') {
      setCheckpoints(cpRes.value.checkpoints, cpRes.value.available);
    } else {
      setLoadError(String(cpRes.reason));
    }
    if (opsRes.status === 'fulfilled') {
      setOps(parseOperationEntries(opsRes.value));
    } else {
      setOps([]);
      setOpsError(String(opsRes.reason));
    }
    setCheckpointsLoading(false);
  }, [modelLoaded, setCheckpoints, setCheckpointsLoading]);

  // Refresh whenever the panel is opened.
  useEffect(() => {
    if (checkpointPanelOpen) load();
  }, [checkpointPanelOpen, load]);

  // Close on Escape key.
  useEffect(() => {
    if (!checkpointPanelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCheckpointPanelOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [checkpointPanelOpen, setCheckpointPanelOpen]);

  // Focus the panel when opened for keyboard accessibility.
  useEffect(() => {
    if (checkpointPanelOpen) panelRef.current?.focus();
  }, [checkpointPanelOpen]);

  // Drop a pending confirm timer on unmount.
  useEffect(() => () => {
    if (confirmTimerRef.current !== null) window.clearTimeout(confirmTimerRef.current);
  }, []);

  const timeline = useMemo(() => buildTimeline(ops, checkpoints), [ops, checkpoints]);
  const visible = useMemo(
    () => filterTimelineByActor(timeline, actorFilter),
    [timeline, actorFilter],
  );
  const comparePair = useMemo(
    () => orderCompareSelection(compareSel, timeline),
    [compareSel, timeline],
  );

  const toggleCompare = useCallback((sha: string) => {
    setDiff(null);
    setDiffError(null);
    setCompareSel((sel) => {
      if (sel.includes(sha)) return sel.filter((s) => s !== sha);
      // Third pick replaces the older of the two current picks.
      return sel.length >= 2 ? [sel[1], sha] : [...sel, sha];
    });
  }, []);

  const clearCompare = useCallback(() => {
    setCompareSel([]);
    setDiff(null);
    setDiffError(null);
  }, []);

  const runCompare = useCallback(async () => {
    if (!comparePair) return;
    setDiffLoading(true);
    setDiffError(null);
    try {
      setDiff(await getHistoryDiff(comparePair.fromSha, comparePair.toSha));
    } catch (err) {
      setDiffError(String(err));
    } finally {
      setDiffLoading(false);
    }
  }, [comparePair]);

  const handleRestoreClick = useCallback(
    (sha: string) => {
      if (confirmSha !== sha) {
        // Arm the two-click confirm and disarm it after a beat so a stale
        // "Confirm?" doesn't sit under the pointer (PluginsPanel pattern).
        setConfirmSha(sha);
        if (confirmTimerRef.current !== null) window.clearTimeout(confirmTimerRef.current);
        confirmTimerRef.current = window.setTimeout(() => {
          setConfirmSha((s) => (s === sha ? null : s));
          confirmTimerRef.current = null;
        }, CONFIRM_DISARM_MS);
        return;
      }
      if (confirmTimerRef.current !== null) {
        window.clearTimeout(confirmTimerRef.current);
        confirmTimerRef.current = null;
      }
      setConfirmSha(null);
      void (async () => {
        setRestoring(sha);
        try {
          await rollbackToCheckpoint(sha);
          // The backend emits rebuild_started, which App.tsx answers with a
          // soft in-app model reload - no window.location.reload() here.
          addToast(`Restored to checkpoint ${sha}`, 'success');
          logActivity({ kind: 'edit', summary: `Restored checkpoint ${sha}` });
          clearCompare();
          // The rollback records itself as an op + "Rollback to {sha}"
          // snapshot, so re-fetch to show the truthful new head.
          await load();
        } catch (err) {
          addToast(`Restore failed: ${String(err)}`, 'error');
        } finally {
          setRestoring(null);
        }
      })();
    },
    [confirmSha, addToast, logActivity, clearCompare, load],
  );

  const handleFlashIds = useCallback(
    (ids: number[]) => {
      flashHighlightIds(ids);
    },
    [flashHighlightIds],
  );

  if (!checkpointPanelOpen) return null;

  const currentSha = checkpoints.length > 0 ? checkpoints[0].sha : null;
  const checkpointCount = timeline.filter((i) => i.kind === 'checkpoint').length;

  return (
    <div className="cp-overlay" role="dialog" aria-label="History timeline" aria-modal="true">
      <div className="cp-panel" ref={panelRef} tabIndex={-1}>
        {/* Header */}
        <div className="cp-header">
          <h2 className="cp-title">Timeline</h2>
          <button
            className="cp-close"
            onClick={() => setCheckpointPanelOpen(false)}
            aria-label="Close timeline panel (Escape)"
          >
            ✕
          </button>
        </div>

        {/* Sub-header */}
        <div className="cp-subheader">
          <span className="cp-subtitle">
            Operations and restorable snapshots, newest first
          </span>
          <button
            className="cp-refresh-btn"
            onClick={load}
            disabled={checkpointsLoading}
            aria-label="Refresh timeline"
            title="Refresh list"
          >
            ↺
          </button>
        </div>

        {/* Actor filter */}
        <ActorChips filter={actorFilter} onChange={setActorFilter} />

        {/* Compare bar + diff result */}
        {comparePair && (
          <div className="tl-compare-bar">
            <span className="tl-compare-label">
              <span className="cp-sha">{comparePair.fromSha}</span>
              {' → '}
              {comparePair.toSha ? (
                <span className="cp-sha">{comparePair.toSha}</span>
              ) : (
                <span className="tl-compare-current">Current</span>
              )}
            </span>
            <button
              className="tl-compare-run"
              onClick={runCompare}
              disabled={diffLoading}
              title="Semantic diff between the selected history points (ifcdiff)"
            >
              {diffLoading ? 'Comparing…' : 'Compare'}
            </button>
            <button className="tl-compare-clear" onClick={clearCompare}>
              Clear
            </button>
          </div>
        )}
        {diffError && <p className="cp-empty cp-empty--warn">{diffError}</p>}
        {diff && !diffLoading && <DiffSection diff={diff} onFlashIds={handleFlashIds} />}

        {/* Body */}
        <div className="cp-body">
          {!modelLoaded && <p className="cp-empty">No model loaded.</p>}

          {modelLoaded && !checkpointsAvailable && !checkpointsLoading && !loadError && (
            <p className="cp-empty cp-empty--warn">
              gitpython not installed - checkpoints disabled.{' '}
              <code>pip install gitpython</code>
            </p>
          )}

          {modelLoaded && checkpointsLoading && <p className="cp-empty">Loading…</p>}

          {modelLoaded && !checkpointsLoading && loadError && (
            <p className="cp-empty cp-empty--warn">
              Failed to load checkpoints - <code>{loadError}</code>
            </p>
          )}

          {modelLoaded && !checkpointsLoading && opsError && (
            <p className="cp-empty cp-empty--warn">
              Operation log unavailable - <code>{opsError}</code>
            </p>
          )}

          {modelLoaded && !checkpointsLoading && !loadError && !opsError && visible.length === 0 && (
            <p className="cp-empty">
              {timeline.length === 0
                ? 'No history yet. Apply an edit to create the first entry.'
                : 'Nothing matches this filter.'}
            </p>
          )}

          {modelLoaded && !checkpointsLoading && visible.length > 0 && (
            <ul className="cp-list" aria-label="Timeline">
              {visible.map((item) =>
                item.kind === 'checkpoint' ? (
                  <li key={item.sha}>
                    <CheckpointRow
                      item={item}
                      isCurrent={item.sha === currentSha}
                      selected={compareSel.includes(item.sha as string)}
                      onToggleCompare={toggleCompare}
                      restoring={restoring}
                      confirmSha={confirmSha}
                      onRestoreClick={handleRestoreClick}
                    />
                  </li>
                ) : (
                  <li key={item.op?.op_id}>
                    <OperationRow item={item} />
                  </li>
                ),
              )}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="cp-footer">
          <span className="cp-count">
            {ops.length} operation{ops.length !== 1 ? 's' : ''} ·{' '}
            {checkpointCount} checkpoint{checkpointCount !== 1 ? 's' : ''}
          </span>
          <span className="cp-hint">Esc to close</span>
        </div>
      </div>
    </div>
  );
}
