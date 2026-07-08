/**
 * Prompt Snippet Panel.
 *
 * Floating overlay displaying reusable chat-message templates. Click any
 * snippet to instantly insert it into the chat textarea. Users can add,
 * edit, and delete custom snippets; built-in snippets are read-only.
 *
 * Opened from the chat composer; Escape closes. (Shift+P used to toggle
 * this panel but now opens Chat Manager → Skills.)
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  getSnippets,
  createSnippet,
  updateSnippet,
  deleteSnippet,
  type PromptSnippet,
} from '../../services/api';
import { useStore } from '../../store/useStore';

// ─── Pure helpers (exported for vitest) ──────────────────────────────────────

/** Returns true when the snippet body is non-empty after trimming. */
export function isSnippetBodyValid(body: string): boolean {
  return body.trim().length > 0;
}

/** Returns true when the title is non-empty after trimming. */
export function isSnippetTitleValid(title: string): boolean {
  return title.trim().length > 0;
}

/** Returns an error string or null for the new-snippet form. */
export function validateSnippetForm(title: string, body: string): string | null {
  if (!isSnippetTitleValid(title)) return 'Title is required.';
  if (!isSnippetBodyValid(body)) return 'Prompt text is required.';
  return null;
}

/** Filter snippets by a case-insensitive search term (matches title, body, tags). */
export function filterSnippets(snippets: PromptSnippet[], query: string): PromptSnippet[] {
  const q = query.trim().toLowerCase();
  if (!q) return snippets;
  return snippets.filter(
    (s) =>
      s.title.toLowerCase().includes(q) ||
      s.body.toLowerCase().includes(q) ||
      s.tags.some((t) => t.toLowerCase().includes(q)),
  );
}

/** Format a tag string: lowercase, no spaces, max 20 chars. */
export function normaliseTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 20);
}

/** Parse a comma-separated tag string into normalised tag array. */
export function parseTags(raw: string): string[] {
  return raw
    .split(',')
    .map(normaliseTag)
    .filter((t) => t.length > 0);
}

/**
 * Returns the sorted unique list of tags across all snippets.
 *
 * Tags are normalised to lowercase before deduplication so `Walls`,
 * `walls`, and `WALLS` collapse to a single chip. Order is ASCII-sort
 * ascending - keeps the chip row visually stable across reloads.
 */
export function extractAllTags(snippets: PromptSnippet[]): string[] {
  const seen = new Set<string>();
  for (const s of snippets) {
    for (const t of s.tags) {
      const norm = t.trim().toLowerCase();
      if (norm) seen.add(norm);
    }
  }
  return Array.from(seen).sort();
}

/**
 * Returns only the snippets whose tag list contains an exact case-insensitive
 * match for ``activeTag``. ``null`` / empty returns the input unchanged so
 * callers can use this as the no-op branch in combined-filter pipelines.
 */
export function filterByTag(
  snippets: PromptSnippet[],
  activeTag: string | null,
): PromptSnippet[] {
  if (!activeTag) return snippets;
  const target = activeTag.trim().toLowerCase();
  if (!target) return snippets;
  return snippets.filter((s) => s.tags.some((t) => t.trim().toLowerCase() === target));
}

/**
 * Apply both the search-query and the active-tag filters in the order the
 * panel renders them: tag filter first (cheap exact-match) then the text
 * filter (fuzzy substring across title / body / tags).
 */
export function applySnippetFilters(
  snippets: PromptSnippet[],
  query: string,
  activeTag: string | null,
): PromptSnippet[] {
  return filterSnippets(filterByTag(snippets, activeTag), query);
}

// ─── Panel ────────────────────────────────────────────────────────────────────

export function PromptSnippetPanel() {
  const { snippetPanelOpen, setSnippetPanelOpen, setSnippetInsertText } = useStore(useShallow((s) => ({
    snippetPanelOpen: s.snippetPanelOpen,
    setSnippetPanelOpen: s.setSnippetPanelOpen,
    setSnippetInsertText: s.setSnippetInsertText,
  })));

  const [snippets, setSnippets] = useState<PromptSnippet[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // New-snippet form state
  const [showForm, setShowForm] = useState(false);
  const [formTitle, setFormTitle] = useState('');
  const [formBody, setFormBody] = useState('');
  const [formTags, setFormTags] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [formSaving, setFormSaving] = useState(false);

  // Editing an existing custom snippet
  const [editingId, setEditingId] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);

  const loadSnippets = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getSnippets();
      setSnippets(data);
    } catch {
      setError('Failed to load snippets.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (snippetPanelOpen) {
      loadSnippets();
    }
  }, [snippetPanelOpen, loadSnippets]);

  // Close on Escape
  useEffect(() => {
    if (!snippetPanelOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSnippetPanelOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [snippetPanelOpen, setSnippetPanelOpen]);

  // Click-outside to close
  useEffect(() => {
    if (!snippetPanelOpen) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setSnippetPanelOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [snippetPanelOpen, setSnippetPanelOpen]);

  if (!snippetPanelOpen) return null;

  const allTags = extractAllTags(snippets);
  const visible = applySnippetFilters(snippets, query, activeTag);

  const handleTagClick = (tag: string) => {
    setActiveTag((current) => (current === tag ? null : tag));
  };

  const handleInsert = (snippet: PromptSnippet) => {
    setSnippetInsertText(snippet.body);
    setSnippetPanelOpen(false);
  };

  const resetForm = () => {
    setFormTitle('');
    setFormBody('');
    setFormTags('');
    setFormError(null);
    setEditingId(null);
    setShowForm(false);
  };

  const handleEditStart = (snippet: PromptSnippet) => {
    setEditingId(snippet.id);
    setFormTitle(snippet.title);
    setFormBody(snippet.body);
    setFormTags(snippet.tags.join(', '));
    setFormError(null);
    setShowForm(true);
  };

  const handleSave = async () => {
    const err = validateSnippetForm(formTitle, formBody);
    if (err) { setFormError(err); return; }
    setFormSaving(true);
    setFormError(null);
    try {
      const tags = parseTags(formTags);
      if (editingId) {
        const updated = await updateSnippet(editingId, formTitle.trim(), formBody.trim(), tags);
        setSnippets((prev) => prev.map((s) => (s.id === editingId ? updated : s)));
      } else {
        const created = await createSnippet(formTitle.trim(), formBody.trim(), tags);
        setSnippets((prev) => [...prev, created]);
      }
      resetForm();
    } catch {
      setFormError('Save failed. Please try again.');
    } finally {
      setFormSaving(false);
    }
  };

  const handleDelete = async (snippet: PromptSnippet) => {
    try {
      await deleteSnippet(snippet.id);
      setSnippets((prev) => prev.filter((s) => s.id !== snippet.id));
    } catch {
      setError('Delete failed.');
    }
  };

  return (
    <div className="snippet-panel-overlay" role="dialog" aria-label="Prompt Snippets">
      <div className="snippet-panel" ref={panelRef}>
        {/* ── Header ── */}
        <div className="snippet-panel__header">
          <span className="snippet-panel__title">Prompt Snippets</span>
          <div className="snippet-panel__header-actions">
            <button
              className="snippet-panel__btn-new"
              onClick={() => { resetForm(); setShowForm(true); }}
              title="Add custom snippet"
            >
              + New
            </button>
            <button
              className="snippet-panel__close"
              onClick={() => setSnippetPanelOpen(false)}
              title="Close (Esc)"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </div>

        {/* ── Search ── */}
        <div className="snippet-panel__search">
          <input
            type="text"
            className="snippet-panel__search-input"
            placeholder="Search snippets…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search snippets"
          />
        </div>

        {/* ── Tag filter chips ── */}
        {allTags.length > 0 && (
          <div
            className="snippet-panel__tag-filters"
            role="group"
            aria-label="Filter by tag"
          >
            {allTags.map((tag) => {
              const isActive = activeTag === tag;
              return (
                <button
                  key={tag}
                  className={`snippet-panel__tag-chip${isActive ? ' snippet-panel__tag-chip--active' : ''}`}
                  onClick={() => handleTagClick(tag)}
                  type="button"
                  aria-pressed={isActive}
                  title={isActive ? `Clear ${tag} filter` : `Show only "${tag}" snippets`}
                >
                  {tag}
                </button>
              );
            })}
          </div>
        )}

        {/* ── New / Edit form ── */}
        {showForm && (
          <div className="snippet-panel__form">
            <div className="snippet-panel__form-row">
              <label className="snippet-panel__form-label">Title</label>
              <input
                className="snippet-panel__form-input"
                type="text"
                value={formTitle}
                onChange={(e) => setFormTitle(e.target.value)}
                placeholder="e.g. Find All Walls"
                maxLength={80}
              />
            </div>
            <div className="snippet-panel__form-row">
              <label className="snippet-panel__form-label">Prompt</label>
              <textarea
                className="snippet-panel__form-textarea"
                value={formBody}
                onChange={(e) => setFormBody(e.target.value)}
                placeholder="e.g. How many walls are in this model? List them by storey."
                rows={3}
              />
            </div>
            <div className="snippet-panel__form-row">
              <label className="snippet-panel__form-label">Tags (comma-separated)</label>
              <input
                className="snippet-panel__form-input"
                type="text"
                value={formTags}
                onChange={(e) => setFormTags(e.target.value)}
                placeholder="e.g. walls, analysis"
              />
            </div>
            {formError && <p className="snippet-panel__form-error">{formError}</p>}
            <div className="snippet-panel__form-actions">
              <button
                className="snippet-panel__btn-save"
                onClick={handleSave}
                disabled={formSaving}
              >
                {formSaving ? 'Saving…' : editingId ? 'Update' : 'Add Snippet'}
              </button>
              <button className="snippet-panel__btn-cancel" onClick={resetForm}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* ── Snippet list ── */}
        <div className="snippet-panel__list" role="list">
          {loading && <p className="snippet-panel__empty">Loading…</p>}
          {error && <p className="snippet-panel__error">{error}</p>}
          {!loading && !error && visible.length === 0 && (
            <p className="snippet-panel__empty">
              {activeTag
                ? `No snippets tagged "${activeTag}"${query ? ' match your search.' : '.'}`
                : query
                  ? 'No snippets match your search.'
                  : 'No snippets yet.'}
            </p>
          )}
          {visible.map((snippet) => (
            <div
              key={snippet.id}
              className={`snippet-panel__item${snippet.is_builtin ? ' snippet-panel__item--builtin' : ''}`}
              role="listitem"
            >
              <div className="snippet-panel__item-content">
                <div className="snippet-panel__item-title">{snippet.title}</div>
                <div className="snippet-panel__item-body">{snippet.body}</div>
                {snippet.tags.length > 0 && (
                  <div className="snippet-panel__item-tags">
                    {snippet.tags.map((t) => (
                      <span key={t} className="snippet-panel__tag">{t}</span>
                    ))}
                  </div>
                )}
              </div>
              <div className="snippet-panel__item-actions">
                <button
                  className="snippet-panel__btn-insert"
                  onClick={() => handleInsert(snippet)}
                  title="Insert into chat"
                >
                  ↵ Use
                </button>
                {!snippet.is_builtin && (
                  <>
                    <button
                      className="snippet-panel__btn-edit"
                      onClick={() => handleEditStart(snippet)}
                      title="Edit snippet"
                    >
                      ✎
                    </button>
                    <button
                      className="snippet-panel__btn-delete"
                      onClick={() => handleDelete(snippet)}
                      title="Delete snippet"
                    >
                      ✕
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="snippet-panel__footer">
          <span className="snippet-panel__hint">
            Esc to close · Click <strong>↵ Use</strong> to insert
          </span>
        </div>
      </div>
    </div>
  );
}

export default PromptSnippetPanel;
