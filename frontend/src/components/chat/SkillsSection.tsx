/**
 * Skills section - unified list of prompts +
 * snippets, with per-row "Use / Insert" actions and an **inline editor**
 * for prompt skills (create / edit / delete) so authoring never leaves
 * the new design.
 *
 *  ┌────────────────────────────┬─────────────────────────────────────┐
 *  │  ALL  PROMPT  +            │   Selected skill - preview, or       │
 *  │  [search…]                 │   inline editor when New / Edit      │
 *  │  ──────────────────────    │                                     │
 *  │  ◑ BIM Analyst     USE     │                                     │
 *  │  ◑ Quantity Take.. USE     │                                     │
 *  └────────────────────────────┴─────────────────────────────────────┘
 *
 * Built-in prompts can't be mutated server-side, so "Edit" on a built-in
 * **forks** it into an editable custom copy (mirrors the tool-set fork-on-
 * toggle pattern). Custom copies and net-new skills persist to the user
 * data dir (`~/.ifc-atlas/data/system_prompts.json`) via the parent's CRUD
 * handlers - the project repo is never touched.
 *
 * Heavy lifting (merging, filtering, badge / action math) lives in
 * `skillsSectionHelpers.ts` so vitest can cover the branches without a
 * React renderer.
 */

import { useMemo, useState, useCallback } from 'react';
import Icon, { type IconName } from '../ui/Icon';
import { useStore } from '../../store/useStore';
import type { SystemPromptEntry } from '../../types/ifc';
import type { PromptSnippet } from '../../services/api';
import {
  actionLabel,
  blankPromptDraft,
  filterSkills,
  mergeSkills,
  seedEditFromPrompt,
  type PromptCategory,
  type PromptDraft,
  type SkillType,
  type UnifiedSkill,
} from './skillsSectionHelpers';

// Re-exported so ChatManagerPanel can type its CRUD handlers against the same
// draft shape the editor produces (and tests can import from one place).
export type { PromptCategory, PromptDraft } from './skillsSectionHelpers';

interface SkillsSectionProps {
  prompts: SystemPromptEntry[];
  snippets: PromptSnippet[];
  /** Currently-active prompt id (drives the "In use" highlight). */
  activePromptId: string | null;
  /** Toggle a prompt's "Use in chat" state. */
  onActivatePrompt: (id: string | null) => void;
  /** Persist a brand-new custom prompt; resolves to the created entry. */
  onCreatePrompt: (payload: PromptDraft) => Promise<SystemPromptEntry>;
  /** Persist edits to an existing custom prompt; resolves to the updated entry. */
  onUpdatePrompt: (id: string, payload: PromptDraft) => Promise<SystemPromptEntry>;
  /** Delete a custom prompt. */
  onDeletePrompt: (id: string) => Promise<void>;
  /** Close the Chat Manager - used by Run / Insert so the user lands back in chat. */
  onCloseManager: () => void;
}

const TYPE_ICON: Record<SkillType, IconName> = {
  prompt: 'file-text',
  snippet: 'clipboard-list',
};

const TYPE_LABEL: Record<SkillType, string> = {
  prompt: 'Prompt',
  snippet: 'Snippet',
};

const PROMPT_CATEGORIES: PromptCategory[] = ['ask', 'plan', 'edit', 'general'];

const CATEGORY_COLORS: Record<PromptCategory, string> = {
  ask: 'var(--info)',
  plan: 'var(--purple)',
  edit: 'var(--err)',
  general: 'var(--f-2)',
};

/** Inline-editor state. `create` covers both net-new and fork-from-built-in. */
type EditState =
  | { mode: 'create'; forkedFrom?: string }
  | { mode: 'edit'; promptId: string }
  | null;

export default function SkillsSection({
  prompts,
  snippets,
  activePromptId,
  onActivatePrompt,
  onCreatePrompt,
  onUpdatePrompt,
  onDeletePrompt,
  onCloseManager,
}: SkillsSectionProps) {
  const [typeFilter, setTypeFilter] = useState<SkillType | 'all'>('all');
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  // Inline editor.
  const [edit, setEdit] = useState<EditState>(null);
  const [draft, setDraft] = useState<PromptDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const setSnippetInsertText = useStore((s) => s.setSnippetInsertText);

  const skills = useMemo(
    () => mergeSkills(prompts, snippets),
    [prompts, snippets],
  );

  const filtered = useMemo(
    () => filterSkills(skills, typeFilter, query),
    [skills, typeFilter, query],
  );

  const selected = useMemo(
    () => filtered.find((s) => s.key === selectedKey) ?? filtered[0] ?? null,
    [filtered, selectedKey],
  );

  const counts = useMemo(() => {
    const c: Record<SkillType | 'all', number> = { all: 0, prompt: 0, snippet: 0 };
    for (const s of skills) {
      c[s.type]++;
      c.all++;
    }
    return c;
  }, [skills]);

  // ── Action dispatchers ─────────────────────────────────────────────────────

  const insertSnippet = useCallback(
    (skill: UnifiedSkill) => {
      if (skill.native.type !== 'snippet') return;
      setSnippetInsertText(skill.native.entry.body);
      onCloseManager();
    },
    [setSnippetInsertText, onCloseManager],
  );

  const usePrompt = useCallback(
    (skill: UnifiedSkill) => {
      if (skill.native.type !== 'prompt') return;
      const isActive = activePromptId === skill.native.entry.id;
      onActivatePrompt(isActive ? null : skill.native.entry.id);
    },
    [activePromptId, onActivatePrompt],
  );

  const dispatchPrimary = useCallback(
    (skill: UnifiedSkill) => {
      if (skill.type === 'prompt') return usePrompt(skill);
      return insertSnippet(skill);
    },
    [usePrompt, insertSnippet],
  );

  // ── Inline editor handlers ──────────────────────────────────────────────────

  const startCreate = useCallback(() => {
    setDraft(blankPromptDraft());
    setSaveError('');
    setEdit({ mode: 'create' });
  }, []);

  const startEdit = useCallback((skill: UnifiedSkill) => {
    if (skill.native.type !== 'prompt') return;
    // Built-ins can't be mutated server-side → seedEditFromPrompt forks them
    // into a new custom copy; custom prompts edit in place.
    const seed = seedEditFromPrompt(skill.native.entry);
    setDraft(seed.draft);
    setSaveError('');
    setEdit(
      seed.mode === 'edit'
        ? { mode: 'edit', promptId: seed.promptId }
        : { mode: 'create', forkedFrom: seed.forkedFrom },
    );
  }, []);

  const cancelEdit = useCallback(() => {
    setEdit(null);
    setDraft(null);
    setSaveError('');
  }, []);

  const saveDraft = useCallback(async () => {
    if (!edit || !draft) return;
    const label = draft.label.trim();
    if (!label) {
      setSaveError('Name is required.');
      return;
    }
    setSaving(true);
    setSaveError('');
    try {
      const payload: PromptDraft = { ...draft, label };
      const entry =
        edit.mode === 'create'
          ? await onCreatePrompt(payload)
          : await onUpdatePrompt(edit.promptId, payload);
      setSelectedKey(`prompt:${entry.id}`);
      // A non-prompt type filter would hide the just-saved skill; drop back to
      // "All" so the result is actually visible + selected.
      setTypeFilter((f) => (f === 'snippet' ? 'all' : f));
      setEdit(null);
      setDraft(null);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [edit, draft, onCreatePrompt, onUpdatePrompt]);

  const deleteSkill = useCallback(
    async (skill: UnifiedSkill) => {
      if (skill.native.type !== 'prompt') return;
      const p = skill.native.entry;
      if (p.is_custom !== true) return; // built-ins are not deletable
      if (!window.confirm(`Delete skill "${p.label}"? This cannot be undone.`)) return;
      try {
        await onDeletePrompt(p.id);
        if (activePromptId === p.id) onActivatePrompt(null);
        setSelectedKey(null);
        if (edit?.mode === 'edit' && edit.promptId === p.id) cancelEdit();
      } catch (e) {
        setSaveError(e instanceof Error ? e.message : String(e));
      }
    },
    [onDeletePrompt, activePromptId, onActivatePrompt, edit, cancelEdit],
  );

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      <div className="cm-list cm-skills-list">
        <div className="cm-list-header">
          <span className="cm-list-label">Skills</span>
          <button className="cm-list-new" title="New skill" onClick={startCreate}>
            <Icon name="plus" size={12} />
          </button>
        </div>

        <div className="cm-skills-filter-row">
          {(['all', 'prompt'] as const).map((t) => {
            const isActive = typeFilter === t;
            return (
              <button
                key={t}
                className={`cm-skills-pill${isActive ? ' cm-skills-pill--active' : ''}`}
                onClick={() => setTypeFilter(t)}
                title={t === 'all' ? 'All skills' : `Filter to ${TYPE_LABEL[t]}s`}
              >
                {t === 'all' ? 'All' : TYPE_LABEL[t]}
                <span className="cm-skills-pill-count">{counts[t]}</span>
              </button>
            );
          })}
        </div>

        <input
          className="cm-skills-search"
          type="search"
          placeholder="Search skills…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="cm-list-items">
          {filtered.length === 0 ? (
            <div className="cm-skills-empty">
              <Icon name="search" size={14} /> No matches.
            </div>
          ) : (
            filtered.map((s) => {
              const isSel = !edit && selected?.key === s.key;
              const isActivePrompt = s.type === 'prompt' && s.native.type === 'prompt' && s.native.entry.id === activePromptId;
              return (
                <div
                  key={s.key}
                  className={`cm-skill-row${isSel ? ' cm-skill-row--selected' : ''}`}
                  // Selecting a row leaves the editor (discarding an open draft),
                  // mirroring the legacy editor's selection behaviour.
                  onClick={() => { setSelectedKey(s.key); if (edit) cancelEdit(); }}
                  role="button"
                  tabIndex={0}
                  aria-selected={isSel}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { setSelectedKey(s.key); if (edit) cancelEdit(); } }}
                  title={s.description || s.name}
                >
                  <span className="cm-skill-icon" title={TYPE_LABEL[s.type]}>
                    <Icon name={TYPE_ICON[s.type]} size={13} strokeWidth={1.8} />
                  </span>
                  <span className="cm-skill-name">{s.name}</span>
                  {isActivePrompt && <span className="cm-active-dot" title="Active in chat" />}
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="cm-detail cm-skills-detail">
        {edit && draft ? (
          <SkillEditor
            mode={edit.mode}
            forkedFrom={edit.mode === 'create' ? edit.forkedFrom : undefined}
            draft={draft}
            setDraft={setDraft}
            saving={saving}
            error={saveError}
            onSave={saveDraft}
            onCancel={cancelEdit}
          />
        ) : selected ? (
          <SkillDetail
            skill={selected}
            activePromptId={activePromptId}
            onPrimary={() => dispatchPrimary(selected)}
            onEdit={() => startEdit(selected)}
            onDelete={() => deleteSkill(selected)}
          />
        ) : (
          <div className="cm-empty"><Icon name="sparkle" size={20} /> Select a skill on the left, or <strong>+ New</strong> to create one</div>
        )}
      </div>
    </>
  );
}

// ─── Detail pane (per-type read-only preview) ───────────────────────────────

interface SkillDetailProps {
  skill: UnifiedSkill;
  activePromptId: string | null;
  onPrimary: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function SkillDetail({ skill, activePromptId, onPrimary, onEdit, onDelete }: SkillDetailProps) {
  const headerLabel = TYPE_LABEL[skill.type];
  const primaryLabel = actionLabel(skill, activePromptId);
  const isActivePrompt = skill.type === 'prompt' && primaryLabel === 'In use';

  return (
    <>
      <div className="cm-skills-hero">
        <div className="cm-skills-hero-top">
          <span className={`cm-skills-kind-tag cm-skills-kind-tag--${skill.type}`}>
            <Icon name={TYPE_ICON[skill.type]} size={11} strokeWidth={1.8} />
            {headerLabel}
          </span>
          {skill.isBuiltin && (
            <span className="cm-skills-builtin-tag">
              <Icon name="lock" size={10} strokeWidth={1.8} /> Built-in
            </span>
          )}
        </div>

        <h2 className="cm-skills-hero-title">{skill.name}</h2>
        {skill.description && (
          <p className="cm-skills-hero-desc">{skill.description}</p>
        )}

        <div className="cm-skills-hero-actions">
          <button
            className={`cm-pill-btn cm-pill-btn--primary${isActivePrompt ? ' cm-pill-btn--active' : ''}`}
            onClick={onPrimary}
          >
            {skill.type === 'snippet' ? <Icon name="plus" size={12} /> : <Icon name="zap" size={12} />}
            {primaryLabel}
          </button>
          {skill.type === 'prompt' && (
            <button
              className="cm-pill-btn"
              onClick={onEdit}
              title={skill.isBuiltin ? 'Edit a copy of this built-in skill' : 'Edit this skill'}
            >
              <Icon name="pencil" size={12} /> Edit
            </button>
          )}
          {skill.type === 'prompt' && !skill.isBuiltin && (
            <button
              className="cm-pill-btn cm-pill-btn--danger"
              onClick={onDelete}
              title="Delete this skill"
            >
              <Icon name="trash" size={12} /> Delete
            </button>
          )}
        </div>
      </div>

      {skill.native.type === 'prompt' && <PromptPreview prompt={skill.native.entry} />}
      {skill.native.type === 'snippet' && <SnippetPreview snippet={skill.native.entry} />}
    </>
  );
}

// ─── Inline editor (prompt skills) ──────────────────────────────────────────

interface SkillEditorProps {
  mode: 'create' | 'edit';
  /** Built-in label when this create was forked from a built-in skill. */
  forkedFrom?: string;
  draft: PromptDraft;
  setDraft: (d: PromptDraft) => void;
  saving: boolean;
  error: string;
  onSave: () => void;
  onCancel: () => void;
}

function SkillEditor({ mode, forkedFrom, draft, setDraft, saving, error, onSave, onCancel }: SkillEditorProps) {
  const chars = draft.content.length;
  const tokens = Math.round(chars / 4);

  return (
    <>
      <div className="cm-skills-hero">
        <div className="cm-skills-hero-top">
          <span className="cm-skills-kind-tag cm-skills-kind-tag--prompt">
            <Icon name="file-text" size={11} strokeWidth={1.8} />
            Prompt
          </span>
          <span className="cm-count-pill">{mode === 'create' ? 'New skill' : 'Editing'}</span>
        </div>

        <input
          className="cm-detail-title-input"
          value={draft.label}
          autoFocus
          onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          placeholder="Skill name"
        />
        <input
          className="cm-detail-desc-input"
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          placeholder="One-line description (optional)"
        />

        {forkedFrom && (
          <div className="cm-config-note">
            <Icon name="info" size={12} />
            <span>“{forkedFrom}” is built-in - saving creates your own editable copy.</span>
          </div>
        )}
      </div>

      <div className="cm-skills-detail-body">
        <div className="cm-skills-content-block">
          <span className="cm-skills-section-title">Category</span>
          <div className="cm-cat-pills">
            {PROMPT_CATEGORIES.map((c) => (
              <button
                key={c}
                className={`cm-cat-pill${draft.category === c ? ' cm-cat-pill--active' : ''}`}
                style={draft.category === c ? { color: CATEGORY_COLORS[c], borderColor: CATEGORY_COLORS[c], background: `color-mix(in srgb, ${CATEGORY_COLORS[c]} 10%, transparent)` } : undefined}
                onClick={() => setDraft({ ...draft, category: c })}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        <div className="cm-skills-content-block">
          <span className="cm-skills-section-title">
            Prompt content
            <span className="cm-count-pill">{chars.toLocaleString()} chars · ~{tokens.toLocaleString()} tokens</span>
          </span>
          <textarea
            className="cm-prompt-textarea"
            value={draft.content}
            onChange={(e) => setDraft({ ...draft, content: e.target.value })}
            placeholder="You are a BIM specialist who…"
          />
        </div>

        <div className="cm-detail-actions">
          <button className="cm-save-btn" onClick={onSave} disabled={saving}>
            <Icon name="check" size={12} /> {saving ? 'Saving…' : mode === 'create' ? 'Create skill' : 'Save changes'}
          </button>
          <button className="cm-cancel-btn" onClick={onCancel} disabled={saving}>Cancel</button>
          {error && <span className="cm-save-error">{error}</span>}
        </div>
      </div>
    </>
  );
}

function MetaChips({ items }: { items: Array<{ label: string; value: string }> }) {
  if (items.length === 0) return null;
  return (
    <div className="cm-skills-chips">
      {items.map((it) => (
        <span key={it.label} className="cm-skills-chip">
          <span className="cm-skills-chip-label">{it.label}</span>
          <span className="cm-skills-chip-val">{it.value}</span>
        </span>
      ))}
    </div>
  );
}

function PromptPreview({ prompt }: { prompt: SystemPromptEntry }) {
  const chars = prompt.content.length;
  const tokens = Math.round(chars / 4);
  return (
    <div className="cm-skills-detail-body">
      <MetaChips
        items={[
          { label: 'Category', value: prompt.category },
          { label: 'Size', value: `${chars.toLocaleString()} chars · ~${tokens.toLocaleString()} tokens` },
        ]}
      />
      <div className="cm-skills-content-block">
        <span className="cm-skills-section-title">Prompt content</span>
        <pre className="cm-skills-content-pre">{prompt.content || '(empty)'}</pre>
      </div>
    </div>
  );
}

function SnippetPreview({ snippet }: { snippet: PromptSnippet }) {
  return (
    <div className="cm-skills-detail-body">
      {snippet.tags.length > 0 && (
        <MetaChips items={[{ label: 'Tags', value: snippet.tags.join(' · ') }]} />
      )}
      <div className="cm-skills-content-block">
        <span className="cm-skills-section-title">Body</span>
        <pre className="cm-skills-content-pre">{snippet.body || '(empty)'}</pre>
      </div>
    </div>
  );
}
