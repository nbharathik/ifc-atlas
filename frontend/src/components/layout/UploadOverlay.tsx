import { useCallback, useRef, useState } from 'react';
import { useIfcUpload } from '../../hooks/useIfcUpload';

export default function UploadOverlay() {
  const upload = useIfcUpload();

  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    const result = await upload(file);
    if (result.ok === false) setError(result.error);
  }, [upload]);

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
