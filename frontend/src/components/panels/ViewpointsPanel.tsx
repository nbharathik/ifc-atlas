import { useState, useCallback } from 'react';
import { useStore } from '../../store/useStore';

interface ViewpointsPanelProps {
  onSaveViewpoint?: (name: string) => void;
  onRestoreViewpoint?: (id: string) => void;
  embedded?: boolean;
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(ts).toLocaleDateString();
}

export default function ViewpointsPanel({
  onSaveViewpoint,
  onRestoreViewpoint,
  embedded = false,
}: ViewpointsPanelProps) {
  const viewpoints = useStore((s) => s.viewpoints);
  const modelLoaded = useStore((s) => s.modelLoaded);
  const deleteViewpoint = useStore((s) => s.deleteViewpoint);
  const renameViewpoint = useStore((s) => s.renameViewpoint);
  const toggleViewpoints = useStore((s) => s.toggleViewpoints);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  const handleSave = useCallback(() => {
    if (!onSaveViewpoint) return;
    // Auto-name: avoids window.prompt (which is blocked in some embedded
    // contexts and adds friction). User can rename via the pencil icon.
    const defaultName = `Viewpoint ${viewpoints.length + 1}`;
    onSaveViewpoint(defaultName);
  }, [onSaveViewpoint, viewpoints.length]);

  const commitRename = useCallback(() => {
    if (editingId && editValue.trim()) {
      renameViewpoint(editingId, editValue.trim());
    }
    setEditingId(null);
    setEditValue('');
  }, [editingId, editValue, renameViewpoint]);

  const containerStyle: React.CSSProperties = embedded
    ? { flex: 1, minHeight: 0 }
    : { flex: '0 0 auto', maxHeight: '45%' };

  return (
    <div className="panel viewpoints-panel" style={containerStyle}>
      {!embedded && (
        <div className="panel-header">
          <span>Viewpoints {viewpoints.length > 0 && <span style={{ color: 'var(--text-muted)' }}>({viewpoints.length})</span>}</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              className="btn-icon"
              title="Save current view (V)"
              onClick={handleSave}
              disabled={!modelLoaded || !onSaveViewpoint}
              style={{ fontSize: 14, opacity: modelLoaded && onSaveViewpoint ? 1 : 0.4 }}
            >
              +
            </button>
            <button
              className="btn-icon"
              title="Close viewpoints panel"
              onClick={toggleViewpoints}
              style={{ fontSize: 14 }}
            >
              &times;
            </button>
          </div>
        </div>
      )}
      {embedded && (
        <div className="embedded-toolbar">
          <button
            className="btn-mini btn-mini-primary"
            onClick={handleSave}
            disabled={!modelLoaded || !onSaveViewpoint}
            title="Save current camera + visibility state (V)"
          >
            + Save current view
          </button>
        </div>
      )}
      <div className="panel-body viewpoints-body">
        {viewpoints.length === 0 ? (
          <p className="viewpoints-empty">
            No saved viewpoints. Use <kbd>V</kbd> or click + to save the current camera view and visibility state.
          </p>
        ) : (
          <div className="viewpoints-list">
            {viewpoints.map((vp) => {
              const meta: string[] = [];
              if (vp.isolatedIds.length > 0) meta.push(`iso ${vp.isolatedIds.length}`);
              if (vp.hiddenIds.length > 0) meta.push(`hidden ${vp.hiddenIds.length}`);
              if (vp.highlightedIds.length > 0) meta.push(`HL ${vp.highlightedIds.length}`);
              if (vp.selectedId != null) meta.push(`sel #${vp.selectedId}`);

              return (
                <div
                  key={vp.id}
                  className="viewpoint-card"
                  onClick={() => onRestoreViewpoint?.(vp.id)}
                  title="Click to restore this view"
                >
                  <div className="viewpoint-thumb">
                    {vp.thumbnail ? (
                      <img src={vp.thumbnail} alt="" />
                    ) : (
                      <div className="viewpoint-thumb-fallback">3D</div>
                    )}
                  </div>
                  <div className="viewpoint-info">
                    {editingId === vp.id ? (
                      <input
                        autoFocus
                        className="viewpoint-name-edit"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                          if (e.key === 'Escape') { e.preventDefault(); setEditingId(null); }
                        }}
                        onBlur={commitRename}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <div className="viewpoint-name" title={vp.name}>{vp.name}</div>
                    )}
                    <div className="viewpoint-meta">
                      <span>{formatRelative(vp.createdAt)}</span>
                      {meta.length > 0 && <span>&middot;</span>}
                      {meta.map((m, i) => (
                        <span key={i} className="viewpoint-chip">{m}</span>
                      ))}
                    </div>
                  </div>
                  <div className="viewpoint-actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="btn-icon"
                      title="Rename"
                      onClick={() => { setEditingId(vp.id); setEditValue(vp.name); }}
                      style={{ fontSize: 12 }}
                    >
                      &#x270E;
                    </button>
                    <button
                      className="btn-icon"
                      title="Delete"
                      onClick={() => {
                        if (window.confirm(`Delete viewpoint "${vp.name}"?`)) {
                          deleteViewpoint(vp.id);
                        }
                      }}
                      style={{ fontSize: 12 }}
                    >
                      &times;
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
