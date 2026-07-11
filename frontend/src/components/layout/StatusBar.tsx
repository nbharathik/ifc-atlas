import { useStore } from '../../store/useStore';
import Icon from '../ui/Icon';


/**
 * Bottom status bar. Minimal dense row of essential metrics only:
 * ready indicator, element count, storey count, and selection /
 * highlight / isolation counts.
 */
export default function StatusBar() {
  const stats = useStore((s) => s.stats);
  const modelLoaded = useStore((s) => s.modelLoaded);
  const loading = useStore((s) => s.loading);
  const selectedElementId = useStore((s) => s.selectedElementId);
  const highlightedIds = useStore((s) => s.highlightedIds);
  const isolatedIds = useStore((s) => s.isolatedIds);
  const nativeIndex = useStore((s) => s.nativeIndexReady);
  const editModeAvailable = useStore((s) => s.editModeAvailable);
  const editMode = useStore((s) => s.editMode);
  const modelDirty = useStore((s) => s.modelDirty);
  const isUndoing = useStore((s) => s.isUndoing);
  const canRedo = useStore((s) => s.canRedo);
  const undoLastEdit = useStore((s) => s.undoLastEdit);
  const redoLastEdit = useStore((s) => s.redoLastEdit);

  const dotClass = loading ? 'warn' : modelLoaded ? '' : 'off';
  const statusLabel = loading ? 'Loading...' : modelLoaded ? 'Ready' : 'No model';

  const fmtNum = (n: number) => n.toLocaleString('en-US');

  return (
    <div className="stats-bar">
      <span className="status-item">
        <span className={`status-dot-live ${dotClass}`} />
        {statusLabel}
      </span>
      <span className="stats-separator" />

      {/* Unsaved-changes badge (B7): File → Save clears it. */}
      {editModeAvailable && modelDirty && modelLoaded && (
        <>
          <span
            className="status-item"
            title="The model has unsaved edits - use File → Save (or Save as IFC…)"
            style={{ color: 'var(--warn, #ca3)' }}
          >
            ● Unsaved changes
          </span>
          <span className="stats-separator" />
        </>
      )}

      {/* Undo/redo (C2): visible while in Edit mode so the escape hatch is
          always one click away. Buttons drive the operation layer. */}
      {editModeAvailable && editMode && modelLoaded && (
        <>
          <span className="status-item" title="Edit mode is on">
            <Icon name="pencil" size={12} />
            Editing
          </span>
          <button
            type="button"
            className="status-item"
            onClick={() => { void undoLastEdit(); }}
            disabled={isUndoing}
            title="Undo last edit (Ctrl+Z)"
            style={{ cursor: 'pointer', background: 'none', border: 'none', font: 'inherit', color: 'inherit' }}
          >
            <Icon name="undo" size={12} />
            Undo
          </button>
          <button
            type="button"
            className="status-item"
            onClick={() => { void redoLastEdit(); }}
            disabled={isUndoing || !canRedo}
            title={canRedo ? 'Redo (Ctrl+Y)' : 'Nothing to redo'}
            style={{
              cursor: canRedo ? 'pointer' : 'default',
              background: 'none', border: 'none', font: 'inherit', color: 'inherit',
              opacity: canRedo ? 1 : 0.5,
            }}
          >
            <Icon name="redo" size={12} />
            Redo
          </button>
          <span className="stats-separator" />
        </>
      )}

      {/* Show native index status when geometry is still loading */}
      {nativeIndex && !modelLoaded && (
        <>
          <span className="status-item" title={`Metadata index ready: ${nativeIndex.psetCount} property sets indexed`} style={{ color: 'var(--color-accent)' }}>
            <Icon name="zap" size={12} />
            <b>{fmtNum(nativeIndex.elementCount)}</b>&nbsp;el·&nbsp;<b>{nativeIndex.storeyCount}</b>&nbsp;storeys·&nbsp;<b>{nativeIndex.psetCount}</b>&nbsp;psets (fast)
          </span>
          <span className="stats-separator" />
        </>
      )}

      {stats && (
        <>
          <span className="status-item" title="Total elements">
            <Icon name="cube" size={12} />
            <b>{fmtNum(stats.total_elements)}</b>&nbsp;elements
          </span>
          <span className="status-item" title="Storeys">
            <Icon name="layers" size={12} />
            {stats.storeys.length}&nbsp;storeys
          </span>
          {selectedElementId != null && (
            <span className="status-item">
              <b>1</b>&nbsp;selected
            </span>
          )}
          {highlightedIds.length > 0 && (
            <span className="status-item status-item-accent">
              {fmtNum(highlightedIds.length)} highlighted
            </span>
          )}
          {isolatedIds.length > 0 && (
            <span className="status-item status-item-accent">
              {fmtNum(isolatedIds.length)} isolated
            </span>
          )}
        </>
      )}

      <span className="status-spacer" />
    </div>
  );
}
