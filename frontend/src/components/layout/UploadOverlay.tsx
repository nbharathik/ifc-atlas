import { useCallback, useRef, useState } from 'react';
import { useIfcUpload } from '../../hooks/useIfcUpload';
import { useNewProject, type NewProjectTemplate } from '../../hooks/useIfcUpload';
import { BROWSER_ONLY } from '../../config/featureFlags';
import { useStore } from '../../store/useStore';
import Icon from '../ui/Icon';

export default function UploadOverlay() {
  const upload = useIfcUpload();
  const createProject = useNewProject();
  const editModeAvailable = useStore((s) => s.editModeAvailable);
  const loading = useStore((s) => s.loading);

  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const inputRef = useRef<HTMLInputElement>(null);
  const lastFileRef = useRef<File | null>(null);

  const handleFile = useCallback(async (file: File) => {
    lastFileRef.current = file;
    setError(null);
    setCopyStatus('idle');
    const result = await upload(file);
    if (result.ok === false) setError(result.error);
  }, [upload]);

  const openPicker = useCallback(() => {
    if (!loading && !creating) inputRef.current?.click();
  }, [creating, loading]);

  const copyDiagnostics = useCallback(async () => {
    if (!error) return;
    const file = lastFileRef.current;
    const diagnostics = [
      'IFC Atlas model-open failure',
      `Time: ${new Date().toISOString()}`,
      file ? `File: ${file.name} (${file.size.toLocaleString()} bytes)` : '',
      `Error: ${error}`,
      `Browser: ${navigator.userAgent}`,
    ].filter(Boolean).join('\n');
    try {
      await navigator.clipboard.writeText(diagnostics);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
  }, [error]);

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
    if (file && !loading && !creating) void handleFile(file);
  }, [creating, handleFile, loading]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  const onDragLeave = useCallback(() => setDragging(false), []);

  return (
    <div className="upload-overlay">
      <div className="upload-ambient-grid" aria-hidden="true" />
      <div className="upload-panel">
        <div
          className={`upload-zone ${dragging ? 'dragging' : ''}`}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onClick={openPicker}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            openPicker();
          }}
          role="button"
          tabIndex={0}
          aria-labelledby="upload-zone-title"
          aria-describedby="upload-zone-description"
          aria-disabled={loading || creating}
          aria-busy={loading}
        >
          <div className="upload-zone-icon" aria-hidden="true">
            <Icon name="upload" size={22} strokeWidth={1.6} />
          </div>
          <div className="upload-eyebrow">Workspace Ready</div>
          <h2 id="upload-zone-title">Open IFC File</h2>
          <p id="upload-zone-description">Drag and drop an .ifc file here, or press Enter to browse</p>
        </div>

        {loading && (
          <div className="upload-progress" role="status" aria-live="polite">
            Opening and preprocessing the IFC model...
          </div>
        )}

        {error && (
          <div className="upload-error" role="alert">
            <span>{error}</span>
            <div className="upload-error-actions">
              <button
                type="button"
                onClick={() => { if (lastFileRef.current) void handleFile(lastFileRef.current); }}
                disabled={!lastFileRef.current || loading}
              >
                Retry
              </button>
              <button type="button" onClick={openPicker} disabled={loading}>Choose another IFC</button>
              <button type="button" onClick={() => { void copyDiagnostics(); }}>
                {copyStatus === 'copied' ? 'Diagnostics copied' : 'Copy diagnostics'}
              </button>
            </div>
            {copyStatus === 'failed' && (
              <span className="upload-copy-error">Clipboard access failed. Select the error text to copy it manually.</span>
            )}
          </div>
        )}

        {editModeAvailable && !BROWSER_ONLY && (
          <>
            <div className="upload-divider"><span>or</span></div>
            <button
              type="button"
              className="upload-new-btn"
              onClick={() => startNew('single_storey')}
              disabled={creating || loading}
            >
              <Icon name="plus" size={14} strokeWidth={2} />
              {creating ? 'Creating…' : 'New Project'}
            </button>
          </>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".ifc"
        style={{ display: 'none' }}
        aria-label="Choose IFC file"
        disabled={loading || creating}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
        }}
      />
    </div>
  );
}
