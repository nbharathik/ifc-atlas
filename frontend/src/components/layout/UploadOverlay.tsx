import { useCallback, useRef, useState } from 'react';
import { useIfcUpload } from '../../hooks/useIfcUpload';
import { useNewProject, type NewProjectTemplate } from '../../hooks/useNewProject';
import { BROWSER_ONLY } from '../../config/featureFlags';
import { useStore } from '../../store/useStore';

export default function UploadOverlay() {
  const upload = useIfcUpload();
  const createProject = useNewProject();
  const editModeAvailable = useStore((s) => s.editModeAvailable);

  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    const result = await upload(file);
    if (result.ok === false) setError(result.error);
  }, [upload]);

  const startNew = useCallback(async (template: NewProjectTemplate) => {
    setError(null);
    setCreating(true);
    try {
      const result = await createProject(template);
      if (result.ok === false) setError(result.error);
    } finally {
      setCreating(false);
    }
  }, [createProject]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  const onDragLeave = useCallback(() => setDragging(false), []);

  return (
    <div className="upload-overlay">
      <div className="upload-ambient-grid" aria-hidden="true" />
      <div
        className={`upload-zone ${dragging ? 'dragging' : ''}`}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onClick={() => inputRef.current?.click()}
      >
        <div className="upload-eyebrow">Workspace Ready</div>
        <h2>Open IFC File</h2>
        <p>Drag and drop an .ifc file here, or click to browse</p>
        {error && <p style={{ color: 'var(--danger)', marginTop: 12 }}>{error}</p>}
      </div>
      {editModeAvailable && !BROWSER_ONLY && (
        <div className="upload-new-project" style={{ marginTop: 18, textAlign: 'center' }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 8 }}>
            or start a new empty project
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            <button
              type="button"
              onClick={() => startNew('single_storey')}
              disabled={creating}
              style={{
                fontSize: 13, padding: '6px 14px', borderRadius: 6,
                cursor: creating ? 'default' : 'pointer', opacity: creating ? 0.6 : 1,
                border: '1px solid var(--border, #333)',
                background: 'var(--surface, #1a1a1a)', color: 'var(--text, #ddd)',
              }}
            >
              {creating ? 'Creating…' : 'New Project'}
            </button>
            <button
              type="button"
              onClick={() => startNew('two_storey')}
              disabled={creating}
              style={{
                fontSize: 13, padding: '6px 14px', borderRadius: 6,
                cursor: creating ? 'default' : 'pointer', opacity: creating ? 0.6 : 1,
                border: '1px solid var(--border, #333)',
                background: 'transparent', color: 'var(--text-muted, #999)',
              }}
            >
              New 2-Storey
            </button>
          </div>
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept=".ifc"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
        }}
      />
    </div>
  );
}
