import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { useStore } from '../../store/useStore';
import { BROWSER_ONLY } from '../../config/featureFlags';
import Icon from '../ui/Icon';
import { getViewerBridge } from '../../services/viewer/viewerBridge';
import type { CapturedViewState } from '../../services/viewer/viewerBridge';
import {
  BCF_PRIORITIES,
  BCF_STATUSES,
  addBcfComment,
  bcfExportUrl,
  bcfSnapshotUrl,
  captureToViewpoint,
  createBcfTopic,
  deleteBcfTopic,
  fetchBcfTopics,
  formatRelativeDate,
  importBcfZip,
  statusColor,
  updateBcfTopic,
  viewpointToApplyRequest,
  type BcfPriority,
  type BcfStatus,
  type BcfTopic,
  type BcfTopicPatch,
} from '../../services/features/bcf';
import './bcfPanel.css';

interface NewTopicForm {
  title: string;
  description: string;
  status: BcfStatus;
  priority: BcfPriority;
  assignedTo: string;
}

interface CreateTopicFormProps {
  capture: CapturedViewState | null;
  busy: boolean;
  onSubmit: (form: NewTopicForm) => void;
  onCancel: () => void;
}

function CreateTopicForm({ capture, busy, onSubmit, onCancel }: CreateTopicFormProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<BcfStatus>('Open');
  const [priority, setPriority] = useState<BcfPriority>('Normal');
  const [assignedTo, setAssignedTo] = useState('');

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    onSubmit({
      title: trimmed,
      description: description.trim(),
      status,
      priority,
      assignedTo: assignedTo.trim(),
    });
  };

  return (
    <form className="bcf-panel-form" onSubmit={handleSubmit} aria-label="New BCF topic">
      <div className="bcf-panel-form-snapshot">
        {capture?.snapshotDataUrl ? (
          <img
            className="bcf-panel-form-thumb"
            src={capture.snapshotDataUrl}
            alt="Captured view snapshot"
          />
        ) : (
          <span className="bcf-panel-form-nosnap">
            {capture
              ? 'View captured without a snapshot image'
              : 'Viewer not ready - the topic will be saved without a viewpoint'}
          </span>
        )}
      </div>
      <label className="bcf-panel-field">
        <span className="bcf-panel-label">Title</span>
        <input
          className="bcf-panel-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What needs attention?"
          autoFocus
          required
        />
      </label>
      <label className="bcf-panel-field">
        <span className="bcf-panel-label">Description</span>
        <textarea
          className="bcf-panel-textarea"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional details"
        />
      </label>
      <div className="bcf-panel-form-row">
        <label className="bcf-panel-field">
          <span className="bcf-panel-label">Status</span>
          <select
            className="bcf-panel-select"
            value={status}
            onChange={(e) => setStatus(e.target.value as BcfStatus)}
          >
            {BCF_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="bcf-panel-field">
          <span className="bcf-panel-label">Priority</span>
          <select
            className="bcf-panel-select"
            value={priority}
            onChange={(e) => setPriority(e.target.value as BcfPriority)}
          >
            {BCF_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="bcf-panel-field">
          <span className="bcf-panel-label">Assigned to</span>
          <input
            className="bcf-panel-input"
            value={assignedTo}
            onChange={(e) => setAssignedTo(e.target.value)}
            placeholder="Unassigned"
          />
        </label>
      </div>
      <div className="bcf-panel-form-actions">
        <button
          type="submit"
          className="bcf-panel-btn bcf-panel-btn--accent"
          disabled={busy || !title.trim()}
        >
          {busy ? 'Creating…' : 'Create topic'}
        </button>
        <button type="button" className="bcf-panel-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

interface TopicDetailProps {
  topic: BcfTopic;
  onPatch: (patch: BcfTopicPatch) => void;
  onComment: (text: string) => Promise<boolean>;
  onDelete: () => void;
  onNotice: (text: string) => void;
}

function TopicDetail({ topic, onPatch, onComment, onDelete, onNotice }: TopicDetailProps) {
  const [assignedDraft, setAssignedDraft] = useState(topic.assigned_to);
  const [commentDraft, setCommentDraft] = useState('');
  const [sendingComment, setSendingComment] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const commitAssigned = () => {
    const next = assignedDraft.trim();
    if (next !== topic.assigned_to) onPatch({ assigned_to: next });
  };

  const submitComment = async () => {
    const text = commentDraft.trim();
    if (!text || sendingComment) return;
    setSendingComment(true);
    const ok = await onComment(text);
    setSendingComment(false);
    if (ok) setCommentDraft('');
  };

  const handleFlyTo = () => {
    const bridge = getViewerBridge();
    if (!topic.viewpoint) {
      onNotice('This topic has no saved viewpoint');
      return;
    }
    if (!bridge) {
      onNotice('Viewer is not ready yet');
      return;
    }
    void bridge.applyViewState(viewpointToApplyRequest(topic.viewpoint));
  };

  return (
    <div className="bcf-panel-detail">
      {topic.description && <p className="bcf-panel-detail-desc">{topic.description}</p>}

      <div className="bcf-panel-detail-controls">
        <label className="bcf-panel-field">
          <span className="bcf-panel-label">Status</span>
          <select
            className="bcf-panel-select"
            value={topic.status}
            onChange={(e) => onPatch({ status: e.target.value as BcfStatus })}
          >
            {BCF_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="bcf-panel-field">
          <span className="bcf-panel-label">Priority</span>
          <select
            className="bcf-panel-select"
            value={topic.priority}
            onChange={(e) => onPatch({ priority: e.target.value as BcfPriority })}
          >
            {BCF_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="bcf-panel-field">
          <span className="bcf-panel-label">Assigned to</span>
          <input
            className="bcf-panel-input"
            value={assignedDraft}
            placeholder="Unassigned"
            onChange={(e) => setAssignedDraft(e.target.value)}
            onBlur={commitAssigned}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
        </label>
      </div>

      <div className="bcf-panel-detail-actions">
        <button
          className="bcf-panel-btn bcf-panel-btn--accent"
          onClick={handleFlyTo}
          title="Restore the camera and visibility saved with this topic"
        >
          Fly to viewpoint
        </button>
        {confirmingDelete ? (
          <span className="bcf-panel-confirm">
            <button className="bcf-panel-btn bcf-panel-btn--danger" onClick={onDelete}>
              Confirm delete
            </button>
            <button className="bcf-panel-btn" onClick={() => setConfirmingDelete(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button className="bcf-panel-btn" onClick={() => setConfirmingDelete(true)}>
            Delete topic
          </button>
        )}
      </div>

      <div className="bcf-panel-comments">
        {topic.comments.length > 0 && (
          <ul className="bcf-panel-comment-list" aria-label="Comments">
            {topic.comments.map((c) => (
              <li key={c.guid} className="bcf-panel-comment">
                <span className="bcf-panel-comment-meta">
                  <span className="bcf-panel-comment-author">{c.author || 'Anonymous'}</span>
                  <span className="bcf-panel-comment-date">{formatRelativeDate(c.date)}</span>
                </span>
                <p className="bcf-panel-comment-text">{c.comment}</p>
              </li>
            ))}
          </ul>
        )}
        <input
          className="bcf-panel-input bcf-panel-comment-input"
          value={commentDraft}
          placeholder="Add a comment - Enter to send"
          disabled={sendingComment}
          onChange={(e) => setCommentDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submitComment();
          }}
        />
      </div>
    </div>
  );
}

export default function BcfPanel({ onClose, embedded = false }: { onClose: () => void; embedded?: boolean }) {
  const modelLoaded = useStore((s) => s.modelLoaded);

  const [topics, setTopics] = useState<BcfTopic[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedGuid, setExpandedGuid] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createCapture, setCreateCapture] = useState<CapturedViewState | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  // Monotonic request counter: a slow list response must never overwrite the
  // result of a request issued after it.
  const requestSeq = useRef(0);
  const noticeTimer = useRef<number | null>(null);

  const canFetch = modelLoaded && !BROWSER_ONLY;

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 3500);
  }, []);

  useEffect(
    () => () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    },
    [],
  );

  const load = useCallback(async () => {
    if (!canFetch) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchBcfTopics();
      if (seq !== requestSeq.current) return;
      setTopics(result);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setError(e instanceof Error ? e.message : 'Failed to load BCF topics');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [canFetch]);

  // Fetch on open; drop stale state when the model is unloaded.
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!modelLoaded) {
      setTopics(null);
      setError(null);
      setExpandedGuid(null);
      setCreateOpen(false);
      setCreateCapture(null);
    }
  }, [modelLoaded]);

  // Newest activity first.
  const sortedTopics = useMemo(
    () =>
      topics
        ? [...topics].sort((a, b) => b.modified_at.localeCompare(a.modified_at))
        : [],
    [topics],
  );

  const replaceTopic = useCallback((updated: BcfTopic) => {
    setTopics((prev) =>
      prev ? prev.map((t) => (t.guid === updated.guid ? updated : t)) : prev,
    );
  }, []);

  const handleNewTopic = useCallback(async () => {
    let capture: CapturedViewState | null = null;
    const bridge = getViewerBridge();
    if (bridge) {
      try {
        capture = await bridge.captureViewState({ snapshotMaxPx: 800 });
      } catch {
        // A capture failure must not block creating a text-only topic.
        capture = null;
      }
    }
    setCreateCapture(capture);
    setCreateOpen(true);
  }, []);

  const handleCreate = useCallback(
    async (form: NewTopicForm) => {
      setCreating(true);
      try {
        const topic = await createBcfTopic({
          title: form.title,
          description: form.description || undefined,
          status: form.status,
          priority: form.priority,
          assigned_to: form.assignedTo || undefined,
          viewpoint: createCapture ? captureToViewpoint(createCapture) : undefined,
          snapshot_data_url: createCapture?.snapshotDataUrl ?? undefined,
        });
        setTopics((prev) => (prev ? [topic, ...prev] : [topic]));
        setCreateOpen(false);
        setCreateCapture(null);
      } catch (e) {
        showNotice(e instanceof Error ? e.message : 'Failed to create topic');
      } finally {
        setCreating(false);
      }
    },
    [createCapture, showNotice],
  );

  const handlePatch = useCallback(
    async (guid: string, patch: BcfTopicPatch) => {
      try {
        replaceTopic(await updateBcfTopic(guid, patch));
      } catch (e) {
        showNotice(e instanceof Error ? e.message : 'Failed to update topic');
      }
    },
    [replaceTopic, showNotice],
  );

  const handleComment = useCallback(
    async (guid: string, text: string): Promise<boolean> => {
      try {
        replaceTopic(await addBcfComment(guid, text));
        return true;
      } catch (e) {
        showNotice(e instanceof Error ? e.message : 'Failed to add comment');
        return false;
      }
    },
    [replaceTopic, showNotice],
  );

  const handleDelete = useCallback(
    async (guid: string) => {
      try {
        await deleteBcfTopic(guid);
        setTopics((prev) => (prev ? prev.filter((t) => t.guid !== guid) : prev));
        setExpandedGuid((cur) => (cur === guid ? null : cur));
      } catch (e) {
        showNotice(e instanceof Error ? e.message : 'Failed to delete topic');
      }
    },
    [showNotice],
  );

  const handleImportChange = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      // Reset so picking the same file again re-triggers the change event.
      e.target.value = '';
      if (!file) return;
      setImporting(true);
      try {
        const result = await importBcfZip(file);
        setTopics(result.topics);
        showNotice(
          `Imported ${result.imported} topic${result.imported !== 1 ? 's' : ''}, skipped ${result.skipped}`,
        );
      } catch (err) {
        showNotice(err instanceof Error ? err.message : 'Import failed');
      } finally {
        setImporting(false);
      }
    },
    [showNotice],
  );

  return (
    <div className="bcf-panel-overlay">
      <div className="bcf-panel" role="region" aria-label="BCF topics">
        <div className="bcf-panel-header">
          {!embedded && (
            <span className="bcf-panel-title fpanel-title">
              <span className="fpanel-title-icon">
                <Icon name="message-square" size={14} />
              </span>
              BCF topics
            </span>
          )}
          <div className="bcf-panel-actions">
            <button
              className="bcf-panel-btn bcf-panel-btn--accent"
              onClick={() => void handleNewTopic()}
              disabled={!canFetch || createOpen}
              title="Create a topic from the current view"
            >
              New topic
            </button>
            <button
              className="bcf-panel-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={!canFetch || importing}
              title="Import a .bcfzip file"
            >
              {importing ? 'Importing…' : 'Import'}
            </button>
            <a
              className={`bcf-panel-btn${canFetch ? '' : ' bcf-panel-btn--disabled'}`}
              href={bcfExportUrl()}
              download
              aria-disabled={!canFetch}
              title="Download all topics as .bcfzip (BCF 2.1)"
              onClick={(e) => {
                if (!canFetch) e.preventDefault();
              }}
            >
              Export
            </a>
            {!embedded && (
              <button
                className="bcf-panel-btn fpanel-icon-btn"
                onClick={onClose}
                aria-label="Close BCF panel"
              >
                <Icon name="x" size={14} />
              </button>
            )}
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".bcfzip"
          hidden
          onChange={(e) => void handleImportChange(e)}
        />

        {notice && (
          <div className="bcf-panel-notice" role="status">
            {notice}
          </div>
        )}

        {BROWSER_ONLY ? (
          <p className="bcf-panel-empty">This feature needs the desktop backend.</p>
        ) : !modelLoaded ? (
          <p className="bcf-panel-empty">Load an IFC model first.</p>
        ) : (
          <div className="bcf-panel-body">
            {createOpen && (
              <CreateTopicForm
                capture={createCapture}
                busy={creating}
                onSubmit={(form) => void handleCreate(form)}
                onCancel={() => {
                  setCreateOpen(false);
                  setCreateCapture(null);
                }}
              />
            )}

            {error && (
              <div className="bcf-panel-error" role="alert">
                <span className="bcf-panel-error-msg">{error}</span>
                <button className="bcf-panel-btn" onClick={() => void load()}>
                  Retry
                </button>
              </div>
            )}

            {loading && topics === null && !error && (
              <div className="bcf-panel-skeleton" aria-label="Loading topics">
                {Array.from({ length: 4 }, (_, i) => (
                  <div key={i} className="bcf-panel-skeleton-row" />
                ))}
              </div>
            )}

            {topics !== null && sortedTopics.length === 0 && !error && (
              <p className="bcf-panel-empty">
                No topics yet - create one from the current view
              </p>
            )}

            {sortedTopics.length > 0 && (
              <ul className="bcf-panel-list" aria-label="Topic list">
                {sortedTopics.map((topic) => {
                  const expanded = expandedGuid === topic.guid;
                  const commentCount = topic.comments.length;
                  return (
                    <li key={topic.guid} className="bcf-panel-topic">
                      <button
                        className={`bcf-panel-topic-row${expanded ? ' bcf-panel-topic-row--open' : ''}`}
                        onClick={() => setExpandedGuid(expanded ? null : topic.guid)}
                        aria-expanded={expanded}
                      >
                        <span
                          className="bcf-panel-topic-bar"
                          style={{ background: statusColor(topic.status) }}
                          aria-hidden="true"
                        />
                        {topic.has_snapshot ? (
                          <img
                            className="bcf-panel-thumb"
                            src={bcfSnapshotUrl(topic.guid)}
                            alt=""
                            loading="lazy"
                          />
                        ) : (
                          <span
                            className="bcf-panel-thumb bcf-panel-thumb--empty"
                            aria-hidden="true"
                          >
                            <Icon name="camera" size={16} />
                          </span>
                        )}
                        <span className="bcf-panel-topic-main">
                          <span className="bcf-panel-topic-title" title={topic.title}>
                            {topic.title}
                          </span>
                          <span className="bcf-panel-topic-meta">
                            <span
                              className={`bcf-panel-chip bcf-panel-chip--${topic.priority.toLowerCase()}`}
                            >
                              {topic.priority}
                            </span>
                            {topic.assigned_to && (
                              <span className="bcf-panel-meta-item" title="Assigned to">
                                {topic.assigned_to}
                              </span>
                            )}
                            <span className="bcf-panel-meta-item">
                              {commentCount} comment{commentCount !== 1 ? 's' : ''}
                            </span>
                            <span className="bcf-panel-meta-item">
                              {formatRelativeDate(topic.modified_at)}
                            </span>
                          </span>
                        </span>
                      </button>
                      {expanded && (
                        <TopicDetail
                          key={topic.guid}
                          topic={topic}
                          onPatch={(patch) => void handlePatch(topic.guid, patch)}
                          onComment={(text) => handleComment(topic.guid, text)}
                          onDelete={() => void handleDelete(topic.guid)}
                          onNotice={showNotice}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
