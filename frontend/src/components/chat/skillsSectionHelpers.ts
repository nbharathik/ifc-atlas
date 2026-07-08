/**
 * Pure helpers for the unified Skills section.
 *
 * "Skill" is a unified frontend concept that subsumes:
 *   - prompt   - entries from the System Prompt library (`SystemPromptEntry`)
 *   - snippet  - reusable chat-message templates (`PromptSnippet`)
 *
 * The Chat Manager's Skills tab renders a single list of both with type
 * badges + per-row actions.  These helpers turn the native shapes into
 * one `UnifiedSkill[]` for rendering and filtering.
 */
import type { SystemPromptEntry, AgentCategory } from '../../types/ifc';
import type { PromptSnippet } from '../../services/api';

export type SkillType = 'prompt' | 'snippet';

export interface UnifiedSkill {
  /** Stable key - `${type}:${native id}` so React keys never collide. */
  key: string;
  type: SkillType;
  /** Display name (prompt label / snippet title). */
  name: string;
  /** One-line summary if available (prompt description / "" for snippets). */
  description: string;
  /**
   * Category text shown in the badge. For prompts: `AgentCategory | 'general'`;
   * for snippets: `'snippet'` (snippets have no first-class category).
   */
  category: string;
  /** Tags (always lowercase, deduped). Used by the search filter. */
  tags: string[];
  /** Built-in records can't be edited via the in-app editor. */
  isBuiltin: boolean;
  /**
   * Carries the native record so the row's action button can dispatch the
   * right side effect.  Discriminated by `type`.
   */
  native:
    | { type: 'prompt'; entry: SystemPromptEntry }
    | { type: 'snippet'; entry: PromptSnippet };
}

/** Truncate to N chars with an ellipsis. Returns `''` for nullish input. */
export function shortText(s: string | null | undefined, max = 100): string {
  if (!s) return '';
  const t = s.trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export function promptToSkill(p: SystemPromptEntry): UnifiedSkill {
  const cat: AgentCategory | 'general' = p.category ?? 'general';
  return {
    key: `prompt:${p.id}`,
    type: 'prompt',
    name: p.label || p.id,
    description: shortText(p.description, 140),
    category: String(cat),
    tags: [],
    // SystemPromptEntry uses `is_custom` as the inverse of "builtin".
    isBuiltin: p.is_custom !== true,
    native: { type: 'prompt', entry: p },
  };
}

export function snippetToSkill(s: PromptSnippet): UnifiedSkill {
  return {
    key: `snippet:${s.id}`,
    type: 'snippet',
    name: s.title || s.id,
    description: shortText(s.body, 140),
    category: 'snippet',
    tags: (s.tags ?? []).map((t) => t.toLowerCase()),
    isBuiltin: s.is_builtin === true,
    native: { type: 'snippet', entry: s },
  };
}

/**
 * Merge the native libraries into a single ordered list.
 *
 * Sort: prompts first (alphabetical by name), then snippets (alphabetical by
 * name).  This keeps the most consequential items at the top of the list and
 * is stable across reloads.
 */
export function mergeSkills(
  prompts: SystemPromptEntry[],
  snippets: PromptSnippet[],
): UnifiedSkill[] {
  const promptSkills = prompts.map(promptToSkill);
  const snippetSkills = snippets.map(snippetToSkill);

  const alpha = (a: UnifiedSkill, b: UnifiedSkill) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

  promptSkills.sort(alpha);
  snippetSkills.sort(alpha);

  return [...promptSkills, ...snippetSkills];
}

/**
 * Filter a unified skill list by type filter + free-text query.
 *
 * `typeFilter === 'all'` returns every entry that matches the query.
 * The query is matched (case-insensitive) against name, description,
 * category and tags.
 */
export function filterSkills(
  skills: UnifiedSkill[],
  typeFilter: SkillType | 'all',
  query: string,
): UnifiedSkill[] {
  const q = query.trim().toLowerCase();
  return skills.filter((s) => {
    if (typeFilter !== 'all' && s.type !== typeFilter) return false;
    if (!q) return true;
    if (s.name.toLowerCase().includes(q)) return true;
    if (s.description.toLowerCase().includes(q)) return true;
    if (s.category.toLowerCase().includes(q)) return true;
    if (s.tags.some((t) => t.includes(q))) return true;
    return false;
  });
}

/** Pure count helper for the filter pills' badge numbers. */
export function countSkillsByType(skills: UnifiedSkill[]): Record<SkillType, number> {
  const counts: Record<SkillType, number> = { prompt: 0, snippet: 0 };
  for (const s of skills) counts[s.type]++;
  return counts;
}

/**
 * For a given skill, decide which per-row action label to render.
 *
 * `prompt`   → "Use" (or "In use" when already activated)
 * `snippet`  → "Insert"
 *
 * Active state for prompts comes from the store's `activePromptId`.
 */
export function actionLabel(
  skill: UnifiedSkill,
  activePromptId: string | null | undefined,
): string {
  if (skill.type === 'prompt') {
    const active = skill.native.entry.id === activePromptId;
    return active ? 'In use' : 'Use';
  }
  return 'Insert';
}

/** Per-type accent colour used by the badge. */
export function badgeColorFor(type: SkillType): string {
  if (type === 'prompt') return 'var(--color-blue-400, #3b82f6)';
  return 'var(--color-green-400, #10b981)';
}

// ─── Inline prompt editor (create / edit / fork-on-edit) ─────────────────────

export type PromptCategory = 'ask' | 'plan' | 'edit' | 'general';

/** Draft the inline editor produces; structurally a backend `PromptPayload`. */
export interface PromptDraft {
  label: string;
  description: string;
  content: string;
  category: PromptCategory;
}

/** Coerce a stored prompt category to an editable one (defaults to `ask`). */
export function normalizePromptCategory(c: string | undefined): PromptCategory {
  return c === 'plan' || c === 'edit' || c === 'general' ? c : 'ask';
}

/** A fresh, empty draft for the "+ New" path. */
export function blankPromptDraft(): PromptDraft {
  return { label: '', description: '', content: '', category: 'ask' };
}

/**
 * Seed for the inline editor when the user clicks "Edit" on a prompt skill.
 *
 * Built-in prompts can't be mutated server-side (`prompt_library.update`
 * rejects built-in ids), so editing one **forks** into a new custom copy:
 * `create` mode, a `"… (copy)"` label, and `forkedFrom` set for the notice.
 * Custom prompts edit in place (`edit` mode, carrying `promptId`).
 */
export type PromptEditSeed =
  | { mode: 'create'; forkedFrom?: string; draft: PromptDraft }
  | { mode: 'edit'; promptId: string; draft: PromptDraft };

export function seedEditFromPrompt(p: SystemPromptEntry): PromptEditSeed {
  const builtin = p.is_custom !== true;
  const draft: PromptDraft = {
    label: builtin ? `${p.label} (copy)` : p.label,
    description: p.description ?? '',
    content: p.content ?? '',
    category: normalizePromptCategory(p.category),
  };
  return builtin
    ? { mode: 'create', forkedFrom: p.label, draft }
    : { mode: 'edit', promptId: p.id, draft };
}
