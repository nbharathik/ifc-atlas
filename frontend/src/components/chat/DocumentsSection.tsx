/**
 * Documents section - Document Index lives inside
 * the Chat Manager.
 *
 * Drop a PDF / Markdown / TXT to index it locally; agents can search the
 * index via the `search_document_index` tool.  Reached via Ctrl+Shift+I or
 * the `docs.index` command - both open the Chat Manager on this tab.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../store/useStore';
import Icon from '../ui/Icon';
import type { DocFile, DocSemanticStatus } from '../../types/ifc';
import {
  listDocFiles,
  uploadDocFile,
  deleteDocFile,
  getDocSemanticStatus,
} from '../../services/api';

function fmtSize(chars: number): string {
  if (chars < 1000) return `${chars} chars`;
  if (chars < 1_000_000) return `${(chars / 1000).toFixed(1)} K chars`;
  return `${(chars / 1_000_000).toFixed(1)} M chars`;
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso.slice(0, 10);
  }
}

export default function DocumentsSection() {
  const docIndexFiles = useStore((s) => s.docIndexFiles);
  const docIndexLoading = useStore((s) => s.docIndexLoading);
  const setDocIndexFiles = useStore((s) => s.setDocIndexFiles);
  const addDocIndexFile = useStore((s) => s.addDocIndexFile);
  const removeDocIndexFile = useStore((s) => s.removeDocIndexFile);
  const setDocIndexLoading = useStore((s) => s.setDocIndexLoading);

  const [dragOver, setDragOver] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [semantic, setSemantic] = useState<DocSemanticStatus | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDocIndexLoading(true);
    Promise.all([listDocFiles(), getDocSemanticStatus().catch(() => null)])
      .then(([res, sem]) => {
        setDocIndexFiles(res.docs);
        setSemantic(sem);
      })
      .catch(() => { /* silently ignore */ })
      .finally(() => setDocIndexLoading(false));
  }, [setDocIndexFiles, setDocIndexLoading]);

  const upload = useCallback(
    async (file: File) => {
      setUploadError(null);
      setDocIndexLoading(true);
      try {
        const res = await uploadDocFile(file);
        addDocIndexFile(res.doc);
      } catch (err: unknown) {
        setUploadError(err instanceof Error ? err.message : String(err));
      } finally {
        setDocIndexLoading(false);
      }
    },
    [addDocIndexFile, setDocIndexLoading],
  );

  const onFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) upload(file);
      // reset so picking the same file twice still fires `change`
      if (inputRef.current) inputRef.current.value = '';
    },
    [upload],
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) upload(file);
    },
    [upload],
  );

  const onDelete = useCallback(
    async (id: string) => {
      setDeletingId(id);
      try {
        await deleteDocFile(id);
        removeDocIndexFile(id);
      } catch (err: unknown) {
        setUploadError(err instanceof Error ? err.message : String(err));
      } finally {
        setDeletingId(null);
      }
    },
    [removeDocIndexFile],
  );

  const totalChars = docIndexFiles.reduce(
    (sum, d) => sum + (d.char_count ?? 0),
    0,
  );

  return (
    <div className="cm-docs">
      <div className="cm-docs-header">
        <div className="cm-docs-header-title">
          <h3 className="cm-docs-title">Document Index</h3>
          {semantic?.available ? (
            <span className="cm-docs-badge cm-docs-badge--semantic" title={`Semantic search: ${semantic.model || 'on'}`}>
              ⚡ Semantic
            </span>
          ) : (
            <span className="cm-docs-badge">BM25</span>
          )}
        </div>
        <p className="cm-docs-hint">
          Upload PDFs, Markdown or plain-text files to a local index. Agents can
          search them via the <code>search_document_index</code> tool.
          Max&nbsp;20&nbsp;MB per file.
        </p>
      </div>

      <div
        className={`cm-docs-drop${dragOver ? ' cm-docs-drop--hover' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
      >
        <Icon name="file-text" size={16} strokeWidth={1.5} />
        <span>
          Drop a <code>.pdf</code> / <code>.md</code> / <code>.txt</code> file here, or click to browse
        </span>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.md,.txt,.markdown"
          style={{ display: 'none' }}
          onChange={onFileInput}
        />
      </div>

      {uploadError && (
        <div className="cm-docs-error">
          <Icon name="x" size={11} /> {uploadError}
        </div>
      )}

      {docIndexLoading && docIndexFiles.length === 0 ? (
        <div className="cm-loading"><Icon name="refresh" size={14} /> Loading…</div>
      ) : docIndexFiles.length === 0 ? (
        <div className="cm-docs-empty">
          No documents indexed yet. Drop a file above to get started.
        </div>
      ) : (
        <>
          <div className="cm-docs-summary">
            {docIndexFiles.length} document{docIndexFiles.length === 1 ? '' : 's'} ·{' '}
            {fmtSize(totalChars)} total
          </div>
          <ul className="cm-docs-list">
            {docIndexFiles.map((d: DocFile) => (
              <li key={d.doc_id} className="cm-docs-row">
                <span className="cm-docs-icon">
                  <Icon name="file-text" size={12} strokeWidth={1.6} />
                </span>
                <div className="cm-docs-row-body">
                  <div className="cm-docs-row-title">
                    <span className="cm-docs-filename">{d.name}</span>
                    {d.semantic ? <span className="cm-docs-row-flag">⚡</span> : null}
                  </div>
                  <div className="cm-docs-row-meta">
                    {fmtSize(d.char_count ?? 0)} · {d.chunk_count} chunks · uploaded {fmtDate(d.uploaded_at)}
                  </div>
                </div>
                <button
                  type="button"
                  className="cm-docs-delete"
                  disabled={deletingId === d.doc_id}
                  onClick={() => onDelete(d.doc_id)}
                  title={`Delete ${d.name} from the index`}
                >
                  <Icon name="trash" size={11} />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
