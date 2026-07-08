import { useCallback, useEffect, useRef, useState } from 'react';
import { getCheckpointDiff, listCheckpoints, rollbackToCheckpoint } from '../../services/api';
import { formatCheckpointTs, restoreButtonTitle } from '../../services/viewer/checkpointHelpers';
import { useStore } from '../../store/useStore';
import type { CheckpointDiffResult, IFCCheckpoint } from '../../types/ifc';

// ─── DiffCard ─────────────────────────────────────────────────────────────────

interface DiffCardProps {
  sha: string;
  onFlashIds: (ids: number[]) => void;
}

function DiffCard({ sha, onFlashIds }: DiffCardProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [diff, setDiff] = useState<CheckpointDiffResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (diff) { setOpen(o => !o); return; }
    setLoading(true);
    setError(null);
    try {
      const result = await getCheckpointDiff(sha);
      setDiff(result);
      setOpen(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [sha, diff]);

  const handleFlash = useCallback(() => {
    if (!diff) return;
    const ids = diff.entries
      .filter(e => e.express_id !== null)
      .map(e => e.express_id as number);
    if (ids.length > 0) onFlashIds(ids);
  }, [diff, onFlashIds]);

  return (
    <div className="cp-diff-card">
      <button
        className={`cp-diff-toggle${open ? ' cp-diff-toggle--open' : ''}`}
        onClick={load}
        disabled={loading}
        title="Show diff against current model"
      >
        {loading ? '…' : open ? '▾ Diff' : '▸ Diff'}
      </button>

      {error && <span className="cp-diff-error">{error}</span>}

      {diff && open && (
        <div className="cp-diff-body">
          <div className="cp-diff-summary">
            {diff.added > 0 && <span className="cp-diff-added">+{diff.added}</span>}
            {diff.removed > 0 && <span className="cp-diff-removed">−{diff.removed}</span>}
            {diff.changed > 0 && <span className="cp-diff-changed">~{diff.changed}</span>}
            {diff.total === 0 && <span className="cp-diff-none">No differences</span>}
            {diff.truncated && <span className="cp-diff-trunc"> (showing first 100)</span>}
            {diff.total > 0 && (
              <button className="cp-diff-flash" onClick={handleFlash} title="Flash changed elements in 3D viewer">
                ⚡ Highlight
              </button>
            )}
          </div>

          {diff.entries.length > 0 && (
            <ul className="cp-diff-list">
              {diff.entries.slice(0, 10).map(entry => (
                <li key={entry.global_id} className={`cp-diff-entry cp-diff-entry--${entry.change}`}>
                  <span className="cp-diff-entry-badge">
                    {entry.change === 'added' ? '+' : entry.change === 'removed' ? '−' : '~'}
                  </span>
                  <span className="cp-diff-entry-name">{entry.name ?? entry.ifc_type}</span>
                  {entry.attribute_changes.map(ac => (
                    <span key={ac.attribute} className="cp-diff-attr-change">
                      {ac.attribute}: {ac.before ?? '∅'} → {ac.after ?? '∅'}
                    </span>
                  ))}
                </li>
              ))}
              {diff.entries.length > 10 && (
                <li className="cp-diff-more">…and {diff.entries.length - 10} more</li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ─── CheckpointRow ────────────────────────────────────────────────────────────

interface CheckpointRowProps {
  checkpoint: IFCCheckpoint;
  isCurrent: boolean;
  onRestore: (sha: string) => void;
  restoring: string | null;
  onFlashIds: (ids: number[]) => void;
}

function CheckpointRow({ checkpoint, isCurrent, onRestore, restoring, onFlashIds }: CheckpointRowProps) {
  const busy = restoring === checkpoint.sha;
  return (
    <div className={`cp-row${checkpoint.is_initial ? ' cp-row--initial' : ''}${isCurrent ? ' cp-row--current' : ''}`}>
      <div className="cp-row-meta">
        <span className="cp-sha" title={checkpoint.sha}>{checkpoint.sha}</span>
        {isCurrent && (
          <span className="cp-badge cp-badge--current">current</span>
        )}
        {checkpoint.is_initial && !isCurrent && (
          <span className="cp-badge cp-badge--initial">baseline</span>
        )}
        <span className="cp-time">{formatCheckpointTs(checkpoint.timestamp)}</span>
      </div>
      <div className="cp-row-msg">{checkpoint.message}</div>
      <div className="cp-row-actions">
        {!isCurrent && (
          <DiffCard sha={checkpoint.sha} onFlashIds={onFlashIds} />
        )}
        <button
          className="cp-restore-btn"
          disabled={isCurrent || busy || restoring !== null}
          onClick={() => onRestore(checkpoint.sha)}
          title={isCurrent ? 'This is the current model state' : restoreButtonTitle(checkpoint.sha, checkpoint.message)}
        >
          {busy ? 'Restoring…' : isCurrent ? 'Current' : 'Restore'}
        </button>
      </div>
    </div>
  );
}

// ─── CheckpointPanel ─────────────────────────────────────────────────────────

export function CheckpointPanel() {
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
    flashHighlightIds,
  } = useStore();

  const [restoring, setRestoring] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!modelLoaded) return;
    setCheckpointsLoading(true);
    setLoadError(null);
    try {
      const status = await listCheckpoints(50);
      setCheckpoints(status.checkpoints, status.available);
    } catch (err) {
      setLoadError(String(err));
    } finally {
      setCheckpointsLoading(false);
    }
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

  const handleRestore = useCallback(
    async (sha: string) => {
      setRestoring(sha);
      try {
        await rollbackToCheckpoint(sha);
        addToast(`Restored to checkpoint ${sha}`, 'success');
        setCheckpointPanelOpen(false);
        window.location.reload();
      } catch (err) {
        addToast(`Restore failed: ${String(err)}`, 'error');
      } finally {
        setRestoring(null);
      }
    },
    [addToast, setCheckpointPanelOpen],
  );

  const handleFlashIds = useCallback((ids: number[]) => {
    flashHighlightIds(ids);
  }, [flashHighlightIds]);

  if (!checkpointPanelOpen) return null;

  const currentSha = checkpoints.length > 0 ? checkpoints[0].sha : null;

  return (
    <div
      className="cp-overlay"
      role="dialog"
      aria-label="IFC Edit Checkpoints"
      aria-modal="true"
    >
      <div className="cp-panel" ref={panelRef} tabIndex={-1}>
        {/* Header */}
        <div className="cp-header">
          <h2 className="cp-title">Edit Checkpoints</h2>
          <button
            className="cp-close"
            onClick={() => setCheckpointPanelOpen(false)}
            aria-label="Close checkpoint panel (Escape)"
          >
            ✕
          </button>
        </div>

        {/* Sub-header */}
        <div className="cp-subheader">
          <span className="cp-subtitle">
            Git-backed snapshots - restore any previous model state
          </span>
          <button
            className="cp-refresh-btn"
            onClick={load}
            disabled={checkpointsLoading}
            aria-label="Refresh checkpoints"
            title="Refresh list"
          >
            ↺
          </button>
        </div>

        {/* Body */}
        <div className="cp-body">
          {!modelLoaded && (
            <p className="cp-empty">No model loaded.</p>
          )}

          {modelLoaded && !checkpointsAvailable && !checkpointsLoading && (
            <p className="cp-empty cp-empty--warn">
              gitpython not installed - checkpoints disabled.{' '}
              <code>pip install gitpython</code>
            </p>
          )}

          {modelLoaded && checkpointsAvailable && checkpointsLoading && (
            <p className="cp-empty">Loading…</p>
          )}

          {modelLoaded && checkpointsAvailable && !checkpointsLoading && loadError && (
            <p className="cp-empty cp-empty--warn">
              Failed to load checkpoints - <code>{loadError}</code>
            </p>
          )}

          {modelLoaded && checkpointsAvailable && !checkpointsLoading && !loadError && checkpoints.length === 0 && (
            <p className="cp-empty">
              No checkpoints yet. Apply an edit to create the first snapshot.
            </p>
          )}

          {modelLoaded && checkpointsAvailable && checkpoints.length > 0 && (
            <ul className="cp-list" aria-label="Checkpoints">
              {checkpoints.map((cp) => (
                <li key={cp.sha}>
                  <CheckpointRow
                    checkpoint={cp}
                    isCurrent={cp.sha === currentSha}
                    onRestore={handleRestore}
                    restoring={restoring}
                    onFlashIds={handleFlashIds}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="cp-footer">
          <span className="cp-count">
            {checkpoints.length} checkpoint{checkpoints.length !== 1 ? 's' : ''}
          </span>
          <span className="cp-hint">Esc to close</span>
        </div>
      </div>
    </div>
  );
}
