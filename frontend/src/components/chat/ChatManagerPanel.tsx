/**
 * Chat Manager - three-pane configuration UI.
 *
 *   ┌───────────────────────────────────────────────────────────┐
 *   │  Chat Manager                                          ×  │
 *   ├──────────┬──────────────────────────────────────────────┬─┤
 *   │ Tools    │  • Item A         │  Selected item editor    │ │
 *   │ Prompts  │  • Item B  ✓      │                          │ │
 *   │ Config   │  • Item C         │                          │ │
 *   │          │  + New            │                          │ │
 *   └──────────┴───────────────────┴──────────────────────────┘─┘
 *
 * Three top-level sections:
 * - Tools - manage tool sets (named bundles of tool names)
 * - Prompts - manage system prompt library
 * - Config - global chat defaults (model, temperature, etc.)
 *
 * The sections are independent of agents. The 3 chat-mode pills
 * (Ask / Plan / Edit) consume the *active* tool set and prompt - set
 * via the chat panel's "+" menu. The Manager is purely for curating
 * those resources.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useStore } from '../../store/useStore';
import { STRUCTURAL_EDIT_ENABLED } from '../../config/featureFlags';
import Icon, { type IconName } from '../ui/Icon';
import type {
  SystemPromptEntry, ToolCatalogEntry, McpServerConfig, ModelEntry, AgentPreset,
  AgentCategory, ModelProvider, ModelUseCase, ModelCostTier, ModelSpeedTier, ModelReasoning,
  DocFile, DocSemanticStatus,
} from '../../types/ifc';
import {
  listPrompts, createPrompt, updatePrompt, deletePrompt,
  listModels, createModel, updateModel, deleteModel, reorderModels,
  getChatManagerBootstrap,
  getCachedChatManagerBootstrap,
  getReferenceDocsStatus,
  fetchReferenceDocs,
  getToolSettings, setToolSettings,
  listDocFiles, uploadDocFile, deleteDocFile, getDocSemanticStatus,
  type ProviderStatusEntry,
  type ModelPayload,
  type ReferenceDocsStatus,
  type ReferenceDocsSemanticStatus,
  type PromptSnippet,
} from '../../services/api';
import AiKeysModal from './AiKeysModal';
import './knowledgeSection.css';

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

/**
 * Pure helpers for the Tools global registry.
 *
 * Maps every tool in the backend catalogue to the agents that allow it,
 * then ranks them so the most-used tools appear first.  Pure / synchronous /
 * vitest-friendly.
 */

/**
 * The "default agents" the chat surface drives - currently Ask + Edit.  Phase
 * 5b will let users author their own; until then these two are the only
 * surfaces a tool can land on.
 */
export const DEFAULT_AGENT_IDS = ['default', 'edit-assistant'] as const;
export type DefaultAgentId = (typeof DEFAULT_AGENT_IDS)[number];

export interface ToolUsageRow {
  tool: ToolCatalogEntry;
  /** Subset of `DEFAULT_AGENT_IDS` that include this tool in their allowlist. */
  agents: DefaultAgentId[];
  /** Human-friendly summary: "Ask · Edit", "Ask", "Edit", or "None". */
  usageLabel: string;
}

const DEFAULT_LABELS: Record<DefaultAgentId, string> = {
  'default': 'Ask',
  'edit-assistant': 'Edit',
};

/** Does the given agent's allowlist include the named tool? */
export function agentAllowsTool(agent: AgentPreset | undefined, toolName: string): boolean {
  if (!agent) return false;
  // null = "no allowlist filter" = every tool is allowed.
  if (agent.allowed_tools === null) return true;
  return agent.allowed_tools.includes(toolName);
}

/**
 * Build the usage matrix for the registry view.
 *
 * @param tools   - full tool catalogue (`listTools()`)
 * @param agents  - all agent presets (`listAgents()`).  We pick the
 *                  default-agent records out of this list.
 */
export function buildToolUsageRows(
  tools: ToolCatalogEntry[],
  agents: AgentPreset[],
): ToolUsageRow[] {
  const askAgent = agents.find((a) => a.id === 'default');
  const editAgent = agents.find((a) => a.id === 'edit-assistant');

  return tools.map((t) => {
    const used: DefaultAgentId[] = [];
    if (agentAllowsTool(askAgent, t.name)) used.push('default');
    if (agentAllowsTool(editAgent, t.name)) used.push('edit-assistant');
    const usageLabel =
      used.length === 0
        ? 'None'
        : used.map((id) => DEFAULT_LABELS[id]).join(' · ');
    return { tool: t, agents: used, usageLabel };
  });
}

/**
 * Filter the registry by tier + text query (matches name, description, tier).
 * `tierFilter === 'all'` returns everything that matches the query.
 */
export function filterToolUsageRows(
  rows: ToolUsageRow[],
  tierFilter: string,
  query: string,
): ToolUsageRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    if (tierFilter !== 'all' && r.tool.tier !== tierFilter) return false;
    if (!q) return true;
    if (r.tool.name.toLowerCase().includes(q)) return true;
    if (r.tool.description.toLowerCase().includes(q)) return true;
    if (r.tool.tier_label?.toLowerCase().includes(q)) return true;
    return false;
  });
}

/**
 * Sort: tools used by both agents first, then Edit-only, then Ask-only, then
 * unused.  Within a band, alpha by tool name.  Stable across reloads.
 */
export function sortToolUsageRows(rows: ToolUsageRow[]): ToolUsageRow[] {
  const score = (r: ToolUsageRow): number => {
    if (r.agents.length === 2) return 0;
    if (r.agents.includes('edit-assistant')) return 1;
    if (r.agents.includes('default')) return 2;
    return 3;
  };
  return [...rows].sort((a, b) => {
    const da = score(a) - score(b);
    if (da !== 0) return da;
    return a.tool.name.localeCompare(b.tool.name);
  });
}

/** Display colour for a tier badge - theme tokens defined in index.css. */
export function tierColour(tier: string): string {
  switch (tier) {
    case 'read_model': return 'var(--info)';
    case 'read_viewer': return 'var(--ok)';
    case 'validate': return 'var(--warn)';
    case 'write_edit': return 'var(--err)';
    default: return 'var(--f-2)';
  }
}

/**
 * Toggle a tool's globally-disabled state.
 *
 * Returns the new disabled set so callers can both render the UI and
 * persist via ``setToolSettings(Array.from(next).sort())``. Pure helper:
 * does not mutate the input set.
 */
export function toggleToolDisabled(
  disabled: ReadonlySet<string>,
  toolName: string,
): Set<string> {
  const next = new Set(disabled);
  if (next.has(toolName)) next.delete(toolName);
  else next.add(toolName);
  return next;
}

/**
 * Format the registry-header label that summarises how many
 * tools are globally disabled. Mirrors the JSX in ToolsRegistrySection
 * so a future tooltip / a11y refactor keeps the wording in one place.
 */
export interface DisabledSummary {
  readonly icon: 'check' | 'eye-off';
  readonly label: string;
  readonly tooltip: string;
}

export function formatDisabledSummary(
  disabledCount: number,
): DisabledSummary {
  if (disabledCount <= 0) {
    return {
      icon: 'check',
      label: ' all enabled',
      tooltip:
        'Every tool is enabled. Toggle the eye icon on a row to globally disable a tool.',
    };
  }
  return {
    icon: 'eye-off',
    label: ` ${disabledCount} disabled`,
    tooltip: `${disabledCount} tool(s) globally disabled. Toggle the eye icon to re-enable.`,
  };
}

/** Number of rows in each agent bucket - used for the per-agent count badge. */
export function countUsage(rows: ToolUsageRow[]): Record<DefaultAgentId | 'both' | 'none', number> {
  const c: Record<DefaultAgentId | 'both' | 'none', number> = {
    'default': 0,
    'edit-assistant': 0,
    'both': 0,
    'none': 0,
  };
  for (const r of rows) {
    if (r.agents.length === 0) c.none++;
    else if (r.agents.length === 2) c.both++;
    else c[r.agents[0]]++;
  }
  return c;
}

/**
 * Models section - the Model Registry tab of the Chat Manager.
 *
 * Lists every configured model (OpenAI / Anthropic / OpenRouter), lets the user
 * add, edit, enable/disable, reorder, and delete them, and pick which one drives
 * the chat ("Use in chat"). The chat model dropdown is populated from the
 * *enabled* entries here, and the backend resolves provider + model + sampling
 * (temperature, top_p, max output tokens, reasoning) from the selected entry id.
 *
 * Built-in seed models are fully editable here (see model_registry.py for why
 * this diverges from the built-in-protected prompt/tool registries).
 */

const PROVIDER_LABEL: Record<ModelProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
};
const PROVIDER_COLOR: Record<ModelProvider, string> = {
  openai: 'var(--brand-openai)',
  anthropic: 'var(--brand-anthropic)',
  openrouter: 'var(--brand-openrouter)',
};
const USE_CASES: Array<{ id: ModelUseCase; label: string }> = [
  { id: 'reasoning', label: 'Reasoning' },
  { id: 'coding', label: 'Coding' },
  { id: 'structured_extraction', label: 'Structured extraction' },
  { id: 'vision', label: 'Vision' },
  { id: 'fast_chat', label: 'Fast chat' },
  { id: 'cheap_fallback', label: 'Cheap fallback' },
];
const COST_TIERS: ModelCostTier[] = ['free', 'low', 'medium', 'high'];
/** Compact, monochrome cost notation for the list chips. */
const COST_CHIP: Record<ModelCostTier, string> = {
  free: 'free', low: '$', medium: '$$', high: '$$$',
};
const SPEED_TIERS: ModelSpeedTier[] = ['slow', 'medium', 'fast'];
const REASONING_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high'] as const;
type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

function modelToPayload(m: ModelEntry): ModelPayload {
  return {
    provider: m.provider,
    model_id: m.model_id,
    display_name: m.display_name,
    use_case: m.use_case,
    temperature: m.temperature,
    top_p: m.top_p,
    max_output_tokens: m.max_output_tokens,
    reasoning: m.reasoning,
    supports_tools: m.supports_tools,
    supports_vision: m.supports_vision,
    supports_structured_output: m.supports_structured_output,
    cost_tier: m.cost_tier,
    speed_tier: m.speed_tier,
    input_cost_per_1m: m.input_cost_per_1m,
    output_cost_per_1m: m.output_cost_per_1m,
    notes: m.notes,
    enabled: m.enabled,
  };
}

function blankDraft(): ModelPayload {
  return {
    provider: 'openai',
    model_id: '',
    display_name: '',
    use_case: 'fast_chat',
    temperature: 0.4,
    top_p: null,
    max_output_tokens: null,
    reasoning: null,
    supports_tools: true,
    supports_vision: false,
    supports_structured_output: true,
    cost_tier: 'medium',
    speed_tier: 'medium',
    input_cost_per_1m: null,
    output_cost_per_1m: null,
    notes: '',
    enabled: true,
  };
}

function reasoningToEffort(r: ModelReasoning | undefined): ReasoningEffort {
  if (!r) return 'off';
  if (r.effort && (REASONING_EFFORTS as readonly string[]).includes(r.effort)) {
    return r.effort as ReasoningEffort;
  }
  // budget-only reasoning shows as "medium" effort in the picker.
  if (r.budget_tokens && r.budget_tokens > 0) return 'medium';
  return 'off';
}

function buildReasoning(effort: ReasoningEffort, budget: number | null): ModelReasoning {
  if (effort === 'off') return null;
  const out: { effort: ReasoningEffort; budget_tokens?: number } = { effort };
  if (budget && budget > 0) out.budget_tokens = budget;
  return out as ModelReasoning;
}

interface ModelsSectionProps {
  models: ModelEntry[];
  activeModelId: string | null;
  onUse: (model: ModelEntry) => void;
  onCreate: (payload: ModelPayload) => Promise<ModelEntry>;
  onUpdate: (id: string, payload: ModelPayload) => Promise<ModelEntry>;
  onDelete: (id: string) => Promise<void>;
  onReorder: (orderedIds: string[]) => Promise<void>;
}

function ModelsSection({
  models, activeModelId, onUse, onCreate, onUpdate, onDelete, onReorder,
}: ModelsSectionProps) {
  const ordered = useMemo(
    () => [...models].sort((a, b) => a.sort_order - b.sort_order),
    [models],
  );

  const [selectedId, setSelectedId] = useState<string | null>(() => ordered[0]?.id ?? null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<ModelPayload | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [providerFilter, setProviderFilter] = useState<ModelProvider | 'all'>('all');
  const [query, setQuery] = useState('');

  const selected = useMemo(
    () => ordered.find((m) => m.id === selectedId) ?? null,
    [ordered, selectedId],
  );

  // Keep a valid selection as the list changes.
  useEffect(() => {
    if (!creating && !ordered.some((m) => m.id === selectedId)) {
      setSelectedId(ordered[0]?.id ?? null);
    }
  }, [ordered, selectedId, creating]);

  // Sync the draft from the selected entry unless mid-create.
  useEffect(() => {
    if (creating) return;
    setDraft(selected ? modelToPayload(selected) : null);
    setError('');
  }, [selected, creating]);

  const startCreate = useCallback(() => {
    setCreating(true);
    setDraft(blankDraft());
    setSelectedId(null);
    setError('');
  }, []);

  const cancel = useCallback(() => {
    setCreating(false);
    setError('');
    setSelectedId(ordered[0]?.id ?? null);
  }, [ordered]);

  const patch = useCallback((p: Partial<ModelPayload>) => {
    setDraft((d) => (d ? { ...d, ...p } : d));
  }, []);

  const save = useCallback(async () => {
    if (!draft) return;
    if (!draft.model_id.trim()) { setError('Model ID is required.'); return; }
    // Display name is optional - fall back to the model id.
    const payload = {
      ...draft,
      display_name: draft.display_name.trim() || draft.model_id.trim(),
    };
    setSaving(true);
    setError('');
    try {
      if (creating) {
        const created = await onCreate(payload);
        setCreating(false);
        setSelectedId(created.id);
        // Make sure the just-added model is visible (an active filter / search
        // would otherwise hide its row).
        setProviderFilter('all');
        setQuery('');
      } else if (selectedId) {
        await onUpdate(selectedId, payload);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [draft, creating, selectedId, onCreate, onUpdate]);

  const remove = useCallback(async () => {
    if (!selected) return;
    if (!confirm(`Delete model "${selected.display_name}"?`)) return;
    try {
      await onDelete(selected.id);
      setSelectedId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [selected, onDelete]);

  const toggleEnabled = useCallback(async (m: ModelEntry, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await onUpdate(m.id, { ...modelToPayload(m), enabled: !m.enabled });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [onUpdate]);

  const counts = useMemo(() => {
    const c: Record<ModelProvider | 'all', number> = {
      all: 0, openai: 0, anthropic: 0, openrouter: 0,
    };
    for (const m of ordered) { c[m.provider]++; c.all++; }
    return c;
  }, [ordered]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ordered.filter((m) => {
      if (providerFilter !== 'all' && m.provider !== providerFilter) return false;
      if (!q) return true;
      return (
        m.display_name.toLowerCase().includes(q) ||
        m.model_id.toLowerCase().includes(q)
      );
    });
  }, [ordered, providerFilter, query]);

  // Reorder operates on the visible rows, then merges the new sequence back into
  // the global order so hidden (filtered-out) entries keep their slots. With no
  // filter or search active this is just an adjacent swap in the full list.
  const move = useCallback(async (id: string, dir: -1 | 1, e: React.MouseEvent) => {
    e.stopPropagation();
    const visibleIds = filtered.map((m) => m.id);
    const vi = visibleIds.indexOf(id);
    const vj = vi + dir;
    if (vi < 0 || vj < 0 || vj >= visibleIds.length) return;
    const reordered = [...visibleIds];
    [reordered[vi], reordered[vj]] = [reordered[vj], reordered[vi]];
    const visibleSet = new Set(visibleIds);
    let k = 0;
    const fullIds = ordered.map((m) => (visibleSet.has(m.id) ? reordered[k++] : m.id));
    try {
      await onReorder(fullIds);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [filtered, ordered, onReorder]);

  const enabledCount = ordered.filter((m) => m.enabled).length;

  return (
    <>
      {/* List */}
      <div className="cm-list cm-models-list">
        <div className="cm-list-header">
          <span className="cm-list-label">Models <span className="cm-count-pill">{enabledCount}/{ordered.length} on</span></span>
          <button className="cm-list-new" title="Add model" onClick={startCreate}>
            <Icon name="plus" size={12} />
          </button>
        </div>

        {/* Provider filter - jump straight to one vendor's models. */}
        <div className="cm-models-filter-row">
          {(['all', 'openai', 'anthropic', 'openrouter'] as const).map((p) => {
            const isActive = providerFilter === p;
            return (
              <button
                key={p}
                className={`cm-models-pill${isActive ? ' cm-models-pill--active' : ''}`}
                onClick={() => setProviderFilter(p)}
                title={p === 'all' ? 'All providers' : PROVIDER_LABEL[p]}
              >
                {p !== 'all' && (
                  <span className="cm-models-pill-dot" style={{ background: PROVIDER_COLOR[p] }} />
                )}
                {p === 'all' ? 'All' : PROVIDER_LABEL[p]}
                <span className="cm-models-pill-count">{counts[p]}</span>
              </button>
            );
          })}
        </div>

        <input
          className="cm-models-search"
          type="search"
          placeholder="Search name or model ID…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="cm-list-items">
          {creating && (
            <div className="cm-list-item cm-list-item--selected cm-list-item--draft cm-model-row cm-model-row--draft">
              <span className="cm-model-row-main">
                <Icon name="plus" size={12} /> <span className="cm-model-name">New model</span>
              </span>
            </div>
          )}
          {filtered.length === 0 && !creating ? (
            <div className="cm-skills-empty">
              <Icon name="search" size={14} /> No models match.
            </div>
          ) : (
            filtered.map((m, idx) => {
              const isSel = selectedId === m.id && !creating;
              const isActive = activeModelId === m.id;
              return (
                <div
                  key={m.id}
                  className={`cm-list-item cm-model-row${isSel ? ' cm-list-item--selected' : ''}${m.enabled ? '' : ' cm-model-row--off'}`}
                  onClick={() => { setSelectedId(m.id); setCreating(false); }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { setSelectedId(m.id); setCreating(false); } }}
                >
                  <span className="cm-model-row-main">
                    <span
                      className="cm-model-provider-dot"
                      style={{ background: PROVIDER_COLOR[m.provider] }}
                      title={PROVIDER_LABEL[m.provider]}
                    />
                    <span className="cm-model-name">{m.display_name}</span>
                    {isActive && <span className="cm-active-dot" title="Active in chat" />}
                  </span>
                  <span className="cm-model-row-sub">
                    <code className="cm-model-id">{m.model_id}</code>
                    <span className="cm-model-chip" title={`Cost tier: ${m.cost_tier}`}>{COST_CHIP[m.cost_tier]}</span>
                    {m.reasoning && <span className="cm-model-chip cm-model-chip--reason">reasoning</span>}
                  </span>
                  <span className="cm-model-row-side">
                    <button
                      className="cm-model-mini-btn"
                      title="Move up"
                      disabled={idx === 0}
                      onClick={(e) => move(m.id, -1, e)}
                    ><Icon name="chevron-up" size={11} /></button>
                    <button
                      className="cm-model-mini-btn"
                      title="Move down"
                      disabled={idx === filtered.length - 1}
                      onClick={(e) => move(m.id, 1, e)}
                    ><Icon name="chevron-down" size={11} /></button>
                    <button
                      className={`cm-model-toggle${m.enabled ? ' cm-model-toggle--on' : ''}`}
                      title={m.enabled ? 'Enabled - click to disable' : 'Disabled - click to enable'}
                      onClick={(e) => toggleEnabled(m, e)}
                    ><span className="cm-model-toggle-knob" /></button>
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Detail editor */}
      <div className="cm-detail cm-models-detail">
        {draft ? (
          <ModelEditor
            draft={draft}
            patch={patch}
            creating={creating}
            selected={selected}
            isActive={!!selected && activeModelId === selected.id}
            saving={saving}
            error={error}
            onSave={save}
            onCancel={cancel}
            onDelete={remove}
            onUse={() => selected && onUse(selected)}
          />
        ) : (
          <div className="cm-empty"><Icon name="cpu" size={20} /> Select a model, or add a new one</div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function ModelEditor({
  draft, patch, creating, selected, isActive, saving, error,
  onSave, onCancel, onDelete, onUse,
}: {
  draft: ModelPayload;
  patch: (p: Partial<ModelPayload>) => void;
  creating: boolean;
  selected: ModelEntry | null;
  isActive: boolean;
  saving: boolean;
  error: string;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onUse: () => void;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const effort = reasoningToEffort(draft.reasoning);
  const budget = draft.reasoning?.budget_tokens ?? null;
  const reasoningOn = effort !== 'off';

  const setEffort = (next: ReasoningEffort) => patch({ reasoning: buildReasoning(next, budget) });
  const setBudget = (next: number | null) => patch({ reasoning: buildReasoning(effort, next) });

  const numOrNull = (v: string): number | null => {
    const n = parseFloat(v);
    return v.trim() === '' || Number.isNaN(n) ? null : n;
  };
  const intOrNull = (v: string): number | null => {
    const n = parseInt(v, 10);
    return v.trim() === '' || Number.isNaN(n) ? null : n;
  };

  return (
    <>
      <div className="cm-detail-header">
        <span className="cm-model-provider-tag" title={`Provider: ${PROVIDER_LABEL[draft.provider]}`}>
          <span className="cm-model-provider-dot" style={{ background: PROVIDER_COLOR[draft.provider] }} />
          {PROVIDER_LABEL[draft.provider]}
        </span>
        <input
          className="cm-detail-title-input"
          value={draft.display_name}
          onChange={(e) => patch({ display_name: e.target.value })}
          placeholder="Display name (e.g. GPT-5.5)"
        />
        <div className="cm-detail-header-actions">
          {!creating && selected && (
            <button
              className={`cm-pill-btn${isActive ? ' cm-pill-btn--active' : ''}`}
              onClick={onUse}
              title={isActive ? 'This model drives the chat' : 'Use this model in chat'}
            >
              <Icon name="zap" size={11} />
              {isActive ? 'Active' : 'Use in chat'}
            </button>
          )}
          {!creating && selected && !selected.is_custom && (
            <span className="cm-built-in-pill" title="Seeded default - editable">default</span>
          )}
          {!creating && selected && (
            <button className="cm-danger-btn" onClick={onDelete} title="Delete model">
              <Icon name="trash" size={11} />
            </button>
          )}
        </div>
      </div>

      <div className="cm-model-form">
        {/* Essentials - everything a model needs to run. */}
        <div className="cm-model-grid">
          <label className="cm-config-field">
            <span className="cm-config-label">Provider</span>
            <select
              className="cm-config-select"
              value={draft.provider}
              onChange={(e) => patch({ provider: e.target.value as ModelProvider })}
            >
              {(Object.keys(PROVIDER_LABEL) as ModelProvider[]).map((p) => (
                <option key={p} value={p}>{PROVIDER_LABEL[p]}</option>
              ))}
            </select>
          </label>
          <label className="cm-config-field">
            <span className="cm-config-label">Model ID</span>
            <input
              className="cm-config-input"
              value={draft.model_id}
              onChange={(e) => patch({ model_id: e.target.value })}
              placeholder="e.g. gpt-5.5, claude-opus-4-7, deepseek/deepseek-v3.2"
            />
          </label>
          <label className="cm-config-field">
            <span className="cm-config-label">Reasoning / thinking</span>
            <select
              className="cm-config-select"
              value={effort}
              onChange={(e) => setEffort(e.target.value as ReasoningEffort)}
            >
              <option value="off">Off</option>
              <option value="minimal">Minimal</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
        </div>
        <p className="cm-model-autonote">
          Sampling and token limits are tuned automatically per provider and model
          - open Advanced only to override them.
        </p>

        {/* Advanced - optional overrides, collapsed by default. */}
        <div className="cm-detail-section">
          <button
            type="button"
            className="cm-adv-toggle"
            onClick={() => setShowAdvanced((v) => !v)}
            aria-expanded={showAdvanced}
          >
            <Icon name={showAdvanced ? 'chevron-up' : 'chevron-down'} size={11} />
            Advanced settings
          </button>
          {showAdvanced && (
            <>
              <div className="cm-model-grid">
                <label className="cm-config-field">
                  <span className="cm-config-label">
                    Temperature
                    {reasoningOn && <span className="cm-model-hint"> · ignored while reasoning on</span>}
                  </span>
                  <input
                    className="cm-config-input"
                    type="number" min={0} max={2} step={0.05}
                    value={draft.temperature}
                    onChange={(e) => patch({ temperature: numOrNull(e.target.value) ?? 0 })}
                  />
                </label>
                <label className="cm-config-field">
                  <span className="cm-config-label">Top-p <span className="cm-model-hint">· optional</span></span>
                  <input
                    className="cm-config-input"
                    type="number" min={0} max={1} step={0.05}
                    value={draft.top_p ?? ''}
                    placeholder="default"
                    onChange={(e) => patch({ top_p: numOrNull(e.target.value) })}
                  />
                </label>
                <label className="cm-config-field">
                  <span className="cm-config-label">Max output tokens <span className="cm-model-hint">· optional</span></span>
                  <input
                    className="cm-config-input"
                    type="number" min={1} step={256}
                    value={draft.max_output_tokens ?? ''}
                    placeholder="default"
                    onChange={(e) => patch({ max_output_tokens: intOrNull(e.target.value) })}
                  />
                </label>
                <label className="cm-config-field">
                  <span className="cm-config-label">Thinking budget <span className="cm-model-hint">· tokens, optional</span></span>
                  <input
                    className="cm-config-input"
                    type="number" min={0} step={1024}
                    value={budget ?? ''}
                    placeholder="auto"
                    disabled={!reasoningOn}
                    onChange={(e) => setBudget(intOrNull(e.target.value))}
                  />
                </label>
                <label className="cm-config-field">
                  <span className="cm-config-label">Default use case</span>
                  <select
                    className="cm-config-select"
                    value={draft.use_case}
                    onChange={(e) => patch({ use_case: e.target.value as ModelUseCase })}
                  >
                    {USE_CASES.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
                  </select>
                </label>
                <label className="cm-config-field">
                  <span className="cm-config-label">Cost tier</span>
                  <select
                    className="cm-config-select"
                    value={draft.cost_tier}
                    onChange={(e) => patch({ cost_tier: e.target.value as ModelCostTier })}
                  >
                    {COST_TIERS.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
                <label className="cm-config-field">
                  <span className="cm-config-label">Speed tier</span>
                  <select
                    className="cm-config-select"
                    value={draft.speed_tier}
                    onChange={(e) => patch({ speed_tier: e.target.value as ModelSpeedTier })}
                  >
                    {SPEED_TIERS.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </label>
                <label className="cm-config-field">
                  <span className="cm-config-label">$ / 1M input <span className="cm-model-hint">· estimate</span></span>
                  <input
                    className="cm-config-input"
                    type="number" min={0} step={0.05}
                    value={draft.input_cost_per_1m ?? ''}
                    placeholder="unknown"
                    onChange={(e) => patch({ input_cost_per_1m: numOrNull(e.target.value) })}
                  />
                </label>
                <label className="cm-config-field">
                  <span className="cm-config-label">$ / 1M output <span className="cm-model-hint">· estimate</span></span>
                  <input
                    className="cm-config-input"
                    type="number" min={0} step={0.05}
                    value={draft.output_cost_per_1m ?? ''}
                    placeholder="unknown"
                    onChange={(e) => patch({ output_cost_per_1m: numOrNull(e.target.value) })}
                  />
                </label>
              </div>

              <div className="cm-model-caps">
                <label className="cm-model-cap">
                  <input type="checkbox" checked={draft.supports_tools}
                    onChange={(e) => patch({ supports_tools: e.target.checked })} />
                  Tool calling
                </label>
                <label className="cm-model-cap">
                  <input type="checkbox" checked={draft.supports_vision}
                    onChange={(e) => patch({ supports_vision: e.target.checked })} />
                  Vision
                </label>
                <label className="cm-model-cap">
                  <input type="checkbox" checked={draft.supports_structured_output}
                    onChange={(e) => patch({ supports_structured_output: e.target.checked })} />
                  Structured output
                </label>
              </div>

              <textarea
                className="cm-prompt-textarea cm-model-notes"
                value={draft.notes ?? ''}
                onChange={(e) => patch({ notes: e.target.value })}
                placeholder="When to reach for this model, caveats, pricing notes…"
              />
            </>
          )}
        </div>
      </div>

      <div className="cm-detail-actions">
        <button className="cm-save-btn" onClick={onSave} disabled={saving}>
          <Icon name="check" size={12} /> {creating ? 'Add model' : 'Save'}
        </button>
        <button className="cm-cancel-btn" onClick={onCancel}>Cancel</button>
        {error && <span className="cm-save-error">{error}</span>}
      </div>
    </>
  );
}

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

function SkillsSection({
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

/**
 * Tools registry - one flat list of every tool the backend
 * exposes, with "Used by Ask / Edit / Both / Neither" badges.
 *
 * Replaces the curate-tool-sets view in the Chat Manager.  The user asked
 * for a single sub-heading list of all tools showing which agent uses each;
 * the old per-tool-set fork-and-customise flow is hidden behind a "show tool
 * sets" toggle as a Phase 6b follow-up.
 */

interface ToolsRegistrySectionProps {
  tools: ToolCatalogEntry[];
  agents: AgentPreset[];
}

/**
 * Tier filter pills.  Labels here mirror the backend's `tier_label` field
 * exactly, so if a new tier is added in code (or a label is renamed) the
 * label here updates automatically once the catalogue API returns it.
 * The synthetic 'all' entry is the only label we author here.
 */
function buildTierPills(tools: ToolCatalogEntry[]): Array<{ id: string; label: string }> {
  const seen = new Map<string, string>();
  for (const t of tools) {
    if (!seen.has(t.tier)) seen.set(t.tier, t.tier_label || t.tier);
  }
  return [{ id: 'all', label: 'All' }, ...Array.from(seen, ([id, label]) => ({ id, label }))];
}

function compactTierLabel(label: string): string {
  return label
    .replace(/^Read\s*[-/]\s*/i, '')
    .replace(/^Write\s*[-/]\s*/i, '')
    .replace(/^Write\s+/i, '')
    .trim();
}

function ToolsRegistrySection({ tools, agents }: ToolsRegistrySectionProps) {
  const [tierFilter, setTierFilter] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [selectedName, setSelectedName] = useState<string | null>(null);

  // Globally-disabled tool names. Source of truth lives on the
  // backend; we mirror it here so toggles feel instant. PUT-on-toggle
  // (optimistic UI + roll back on failure).
  const [disabled, setDisabled] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    getToolSettings()
      .then((resp) => {
        if (cancelled) return;
        setDisabled(new Set(resp.disabled_tools ?? []));
      })
      .catch(() => {
        // Silent fallback - empty set is the safe default (nothing disabled).
      });
    return () => { cancelled = true; };
  }, []);

  const toggleDisabled = useCallback(async (toolName: string) => {
    const prev = disabled;
    const next = toggleToolDisabled(prev, toolName);
    setDisabled(next); // optimistic
    try {
      await setToolSettings(Array.from(next).sort());
    } catch {
      // Roll back on failure so the UI matches reality.
      setDisabled(prev);
    }
  }, [disabled]);

  const rows = useMemo(
    () => sortToolUsageRows(buildToolUsageRows(tools, agents)),
    [tools, agents],
  );

  const filtered = useMemo(
    () => filterToolUsageRows(rows, tierFilter, query),
    [rows, tierFilter, query],
  );

  const selected = useMemo<ToolUsageRow | null>(
    () => filtered.find((r) => r.tool.name === selectedName) ?? filtered[0] ?? null,
    [filtered, selectedName],
  );

  return (
    <>
      <div className="cm-list cm-tools-reg-list">
        <div className="cm-list-header">
          <span className="cm-list-label">All tools</span>
          {(() => {
            const summary = formatDisabledSummary(disabled.size);
            return (
              <span
                className="cm-list-readonly-pill"
                title={summary.tooltip}
                style={disabled.size > 0 ? { color: 'var(--warn)' } : undefined}
              >
                <Icon name={summary.icon} size={9} />
                {summary.label}
              </span>
            );
          })()}
        </div>

        <div className="cm-skills-filter-row">
          {buildTierPills(tools).map((t) => {
            const isActive = tierFilter === t.id;
            const tCount =
              t.id === 'all'
                ? rows.length
                : rows.filter((r) => r.tool.tier === t.id).length;
            return (
              <button
                key={t.id}
                className={`cm-skills-pill${isActive ? ' cm-skills-pill--active' : ''}`}
                onClick={() => setTierFilter(t.id)}
                title={t.label}
              >
                {t.id === 'all' ? t.label : compactTierLabel(t.label)}
                <span className="cm-skills-pill-count">{tCount}</span>
              </button>
            );
          })}
        </div>

        <input
          className="cm-skills-search"
          type="search"
          placeholder="Search tools…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="cm-list-items">
          {filtered.length === 0 ? (
            <div className="cm-skills-empty">
              <Icon name="search" size={14} /> No tools match.
            </div>
          ) : (
            filtered.map((r) => {
              const isSel = selected?.tool.name === r.tool.name;
              const isDisabled = disabled.has(r.tool.name);
              return (
                <div
                  key={r.tool.name}
                  className={`cm-tool-reg-row${isSel ? ' cm-tool-reg-row--selected' : ''}`}
                  style={isDisabled ? { opacity: 0.55 } : undefined}
                  title={`${r.tool.name} - ${r.tool.tier_label}${isDisabled ? ' (disabled)' : ''}`}
                  onClick={() => setSelectedName(r.tool.name)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSelectedName(r.tool.name); }}
                >
                  <span
                    className="cm-tool-reg-tier"
                    style={{ background: tierColour(r.tool.tier) }}
                    title={r.tool.tier_label}
                  />
                  <code className="cm-tool-reg-name">{r.tool.name}</code>
                  <button
                    type="button"
                    className="btn-icon cm-tool-reg-toggle"
                    title={isDisabled ? 'Enable tool globally' : 'Disable tool globally'}
                    onClick={(e) => {
                      e.stopPropagation();
                      void toggleDisabled(r.tool.name);
                    }}
                  >
                    <Icon name={isDisabled ? 'eye-off' : 'eye'} size={14} />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="cm-detail cm-skills-detail">
        {selected ? (
          <ToolDetail row={selected} />
        ) : (
          <div className="cm-empty"><Icon name="wrench" size={20} /> Select a tool on the left</div>
        )}
      </div>
    </>
  );
}

function ToolDetail({ row }: { row: ToolUsageRow }) {
  const { tool } = row;
  const paramEntries = Object.entries(
    (tool.parameters as { properties?: Record<string, unknown> })?.properties ?? {},
  );
  const requiredSet = new Set(
    (tool.parameters as { required?: string[] })?.required ?? [],
  );

  return (
    <>
      <div className="cm-detail-header">
        <div className="cm-skills-detail-title-block">
          {/* Tier chip uses the backend tier_label verbatim (no caps / no
              re-formatting) so a renamed tier shows up here automatically. */}
          <span
            className="cm-skills-detail-kind"
            style={{ color: tierColour(tool.tier), borderColor: tierColour(tool.tier) }}
          >
            {tool.tier_label}
          </span>
          <div className="cm-skills-detail-title">
            <code>{tool.name}</code>
          </div>
        </div>
      </div>

      <p className="cm-skills-detail-desc">{tool.description}</p>

      <div className="cm-skills-detail-body">
        <div className="cm-skills-meta-row">
          <span className="cm-skills-meta-label">where</span>
          <span className="cm-skills-meta-val"><code>{tool.where}</code></span>
        </div>
        <div className="cm-skills-meta-row">
          <span className="cm-skills-meta-label">tier</span>
          <span className="cm-skills-meta-val"><code>{tool.tier}</code></span>
        </div>
        <div className="cm-skills-meta-row">
          <span className="cm-skills-meta-label">tier_label</span>
          <span className="cm-skills-meta-val">{tool.tier_label}</span>
        </div>
        <div className="cm-skills-meta-row">
          <span className="cm-skills-meta-label">used by</span>
          <span className="cm-skills-meta-val">
            {row.agents.length === 0 ? '(none)' : row.usageLabel}
          </span>
        </div>
        {paramEntries.length > 0 && (
          <div className="cm-skills-content-block">
            <span className="cm-skills-section-title">parameters</span>
            <table className="cm-tool-reg-params">
              <thead>
                <tr><th>name</th><th>type</th><th>required</th><th>description</th></tr>
              </thead>
              <tbody>
                {paramEntries.map(([name, spec]) => {
                  const s = spec as { type?: string; description?: string };
                  return (
                    <tr key={name}>
                      <td><code>{name}</code></td>
                      <td>{s.type ?? ''}</td>
                      <td>{requiredSet.has(name) ? '✓' : ''}</td>
                      <td>{s.description ?? ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="cm-skills-foot-note">
          All values shown here come straight from the backend tool catalogue.
        </p>
      </div>
    </>
  );
}

/**
 * Knowledge section - Chat Manager tab for the AI's reference desk (plan E4).
 *
 * Two knowledge sources back the agent's "Read - Knowledge" tools:
 *
 *   1. IfcOpenShell API reference - a local index built from the *installed*
 *      package's docstrings (one document per API domain). Queried by the
 *      `get_docs` tool with source 'ifcopenshell'. A fresh install ships with
 *      an EMPTY index: until the user clicks "Fetch IfcOpenShell API docs"
 *      here (or runs scripts/fetch_reference_docs.py), get_docs returns
 *      `not_indexed`. This tab surfaces that state and the fix.
 *
 *   2. bSDD (buildingSMART Data Dictionary) - a live web API consulted by
 *      the `get_docs` tool with source 'bsdd' (search via query, class or
 *      property detail via uri) with an automatic 6-hour server-side cache.
 *      Nothing to fetch or manage; the card below is a static explainer.
 */

// ---------------------------------------------------------------------------
// Pure formatting helpers (unit-tested in __tests__/knowledgeSection.test.ts)
// ---------------------------------------------------------------------------

export interface FetchOutcome {
  ok: boolean;
  message: string;
}

/** Turn the raw POST /chat/reference-docs/fetch payload into a one-line
 *  outcome message. Success shape: { ok, indexed, errors, domains,
 *  ifcopenshell_version, source }; failure: { ok: false, error, indexed: 0 }. */
export function summarizeFetchResult(raw: Record<string, unknown>): FetchOutcome {
  if (raw.ok !== true) {
    const err = typeof raw.error === 'string' && raw.error ? raw.error : 'Fetch failed';
    return { ok: false, message: err };
  }
  const indexed = typeof raw.indexed === 'number' ? raw.indexed : 0;
  const errors = typeof raw.errors === 'number' ? raw.errors : 0;
  const version =
    typeof raw.ifcopenshell_version === 'string' && raw.ifcopenshell_version
      ? raw.ifcopenshell_version
      : null;
  let msg = `Indexed ${indexed} API domain${indexed === 1 ? '' : 's'}`;
  if (version) msg += ` from IfcOpenShell v${version}`;
  if (errors > 0) msg += ` (${errors} domain${errors === 1 ? '' : 's'} failed)`;
  return { ok: true, message: msg };
}

/** "ifcopenshell.api.wall" -> "wall" (chip label for an indexed domain doc). */
export function domainLabel(docName: string | null | undefined): string {
  if (!docName) return '?';
  const parts = docName.split('.');
  return parts[parts.length - 1] || docName;
}

/** Human label for the search mode the index will use. */
export function searchModeLabel(semantic: ReferenceDocsSemanticStatus): string {
  if (semantic.built) return 'Hybrid (semantic + keyword)';
  if (semantic.available) return 'Keyword (BM25) - semantic index not built yet';
  return 'Keyword (BM25) only';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface KnowledgeSectionProps {
  /** Last known status, owned by ChatManagerPanel so the nav tile count and
   *  this tab stay in sync. Null = not loaded yet. */
  status: ReferenceDocsStatus | null;
  onStatusChange: (s: ReferenceDocsStatus) => void;
}

export function KnowledgeSection({ status, onStatusChange }: KnowledgeSectionProps) {
  const [fetching, setFetching] = useState(false);
  const [fetchResult, setFetchResult] = useState<FetchOutcome | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  // Revalidate on open - the endpoint is a cheap local read, and this also
  // recovers when the panel-level fetch failed (backend restart etc.).
  useEffect(() => {
    getReferenceDocsStatus()
      .then((s) => { setStatusError(null); onStatusChange(s); })
      .catch((err: unknown) => {
        setStatusError(err instanceof Error ? err.message : String(err));
      });
    // onStatusChange is a useState setter in the parent - stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onFetch = useCallback(async () => {
    setFetching(true);
    setFetchResult(null);
    try {
      const raw = await fetchReferenceDocs('ifcopenshell');
      setFetchResult(summarizeFetchResult(raw));
    } catch (err: unknown) {
      setFetchResult({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // Refresh the status card (and the nav tile) whatever happened.
      try {
        onStatusChange(await getReferenceDocsStatus());
        setStatusError(null);
      } catch { /* keep the previous status */ }
      setFetching(false);
    }
  }, [onStatusChange]);

  const indexed = status?.indexed === true;
  const domains = (status?.documents ?? [])
    .map(domainLabel)
    .filter((d) => d !== '?')
    .sort();

  return (
    <div className="cm-knowledge">
      <div className="cm-knowledge-header">
        <h3 className="cm-knowledge-title">Knowledge</h3>
        <p className="cm-knowledge-hint">
          Reference material the AI consults through its knowledge tools before
          answering or writing code - separate from your uploaded documents in
          the <strong>Documents</strong> tab.
        </p>
      </div>

      {/* --- IfcOpenShell API reference index --------------------------- */}
      <div className="cm-knowledge-card">
        <div className="cm-knowledge-card-head">
          <span className={`cm-knowledge-dot${indexed ? ' cm-knowledge-dot--on' : ''}`} />
          <div className="cm-knowledge-card-title-block">
            <span className="cm-knowledge-card-title">IfcOpenShell API reference</span>
            <span className="cm-knowledge-card-status">
              {status === null ? 'checking…' : indexed ? 'indexed' : 'not indexed'}
            </span>
          </div>
          <button
            type="button"
            className="cm-pill-btn cm-pill-btn--primary"
            disabled={fetching}
            onClick={onFetch}
            title="Index the installed IfcOpenShell package's API docstrings (takes a few seconds)"
          >
            <Icon name="refresh" size={12} className={fetching ? 'cm-knowledge-spin' : undefined} />
            {fetching
              ? 'Fetching…'
              : indexed
                ? 'Re-fetch IfcOpenShell API docs'
                : 'Fetch IfcOpenShell API docs'}
          </button>
        </div>

        <p className="cm-knowledge-card-desc">
          Local index of the installed IfcOpenShell Python API docstrings,
          grouped per domain (<code>wall</code>, <code>pset</code>,{' '}
          <code>geometry</code>, …). The <code>get_docs</code> tool consults it
          before the AI writes IfcOpenShell code, so the calls match the
          installed version.
        </p>

        {statusError && status === null ? (
          <div className="cm-knowledge-msg cm-knowledge-msg--err">
            <Icon name="alert-circle" size={12} /> Could not load index status: {statusError}
          </div>
        ) : status !== null && !indexed ? (
          <div className="cm-knowledge-warn">
            <Icon name="alert-circle" size={14} strokeWidth={1.8} />
            <div>
              <div className="cm-knowledge-warn-title">Not indexed yet</div>
              <div className="cm-knowledge-warn-text">
                The <code>get_docs</code> tool will return{' '}
                <code>not_indexed</code> until you fetch. Click{' '}
                <strong>Fetch IfcOpenShell API docs</strong> above to build the
                index (a few seconds, no network needed - it reads the installed
                package).
              </div>
            </div>
          </div>
        ) : status !== null ? (
          <>
            <div className="cm-skills-chips cm-knowledge-chips">
              <span className="cm-skills-chip">
                <span className="cm-skills-chip-label">API domains</span>
                <span className="cm-skills-chip-val">{status.doc_count}</span>
              </span>
              <span className="cm-skills-chip">
                <span className="cm-skills-chip-label">Chunks</span>
                <span className="cm-skills-chip-val">{status.semantic.chunk_count}</span>
              </span>
              <span className="cm-skills-chip">
                <span className="cm-skills-chip-label">Search</span>
                <span className="cm-skills-chip-val">{searchModeLabel(status.semantic)}</span>
              </span>
            </div>
            {domains.length > 0 && (
              <details className="cm-knowledge-domains">
                <summary>Show {domains.length} indexed domain{domains.length === 1 ? '' : 's'}</summary>
                <div className="cm-knowledge-domain-list">
                  {domains.map((d) => (
                    <code key={d} className="cm-knowledge-domain">{d}</code>
                  ))}
                </div>
              </details>
            )}
          </>
        ) : (
          <div className="cm-loading"><Icon name="refresh" size={14} /> Loading status…</div>
        )}

        {fetchResult && (
          <div
            className={`cm-knowledge-msg ${fetchResult.ok ? 'cm-knowledge-msg--ok' : 'cm-knowledge-msg--err'}`}
            role="status"
          >
            <Icon name={fetchResult.ok ? 'check' : 'alert-circle'} size={12} />
            {fetchResult.message}
          </div>
        )}
      </div>

      {/* --- bSDD live API ----------------------------------------------- */}
      <div className="cm-knowledge-card">
        <div className="cm-knowledge-card-head">
          <span className="cm-knowledge-dot cm-knowledge-dot--on" />
          <div className="cm-knowledge-card-title-block">
            <span className="cm-knowledge-card-title">bSDD - buildingSMART Data Dictionary</span>
            <span className="cm-knowledge-card-status">live API</span>
          </div>
        </div>
        <p className="cm-knowledge-card-desc">
          Classification and property lookups (<code>get_docs</code> with
          source <code>bsdd</code>) query the live buildingSMART bSDD web API
          directly, with automatic 6-hour caching of results on the backend.
          Nothing to fetch or manage here - it just needs an internet
          connection.
        </p>
      </div>

      <div className="cm-knowledge-footer">
        Both sources feed the agent's <code>Read - Knowledge</code> tools. You can
        also rebuild the IfcOpenShell index from a terminal with{' '}
        <code>python scripts/fetch_reference_docs.py</code>.
      </div>
    </div>
  );
}

/**
 * Documents section - Document Index lives inside
 * the Chat Manager.
 *
 * Drop a PDF / Markdown / TXT to index it locally; agents can search the
 * index via the `get_docs` tool with source 'user'.  Reached via Ctrl+Shift+I
 * or the `docs.index` command - both open the Chat Manager on this tab.
 */

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

function DocumentsSection() {
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
          search them via the <code>get_docs</code> tool with source{' '}
          <code>user</code>. Max&nbsp;20&nbsp;MB per file.
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

/** Sections rendered as sidebar tiles. */
type Section = 'agents' | 'models' | 'skills' | 'tools' | 'docs' | 'knowledge' | 'mcp' | 'settings';

const SECTIONS: Array<{ id: Section; icon: IconName; label: string; hint: string }> = [
  { id: 'agents',   icon: 'sparkle',     label: 'Agents',      hint: 'The agents driving the chat' },
  { id: 'models',   icon: 'cpu',         label: 'Models',      hint: 'OpenAI / Anthropic / OpenRouter models - add, edit, enable, reorder' },
  { id: 'skills',   icon: 'file-text',   label: 'Skills',      hint: 'Detailed system prompts for specialised tasks' },
  { id: 'tools',    icon: 'wrench',      label: 'Tools',       hint: 'Every tool the backend exposes' },
  { id: 'docs',     icon: 'file-text',   label: 'Documents',   hint: 'Files agents can search via the document index tool' },
  { id: 'knowledge', icon: 'brain',      label: 'Knowledge',   hint: "Reference docs the AI consults via get_docs - IfcOpenShell API index + live bSDD" },
  { id: 'mcp',      icon: 'plug',        label: 'MCP Servers', hint: 'External MCP servers that contribute tools' },
  { id: 'settings', icon: 'sliders',     label: 'Settings',    hint: 'Provider keys, base URLs, default model and temperature' },
];

const TIER_COLORS: Record<string, string> = {
  read_model: 'var(--info)',
  read_viewer: 'var(--ok)',
  validate: 'var(--warn)',
  write_edit: 'var(--err)',
};

interface Props { onClose: () => void; }

export default function ChatManagerPanel({ onClose }: Props) {
  const activePromptId = useStore(s => s.activePromptId);
  const setActivePromptId = useStore(s => s.setActivePromptId);
  const chatModelRegistryId = useStore(s => s.chatModelRegistryId);
  const setChatModelRegistryId = useStore(s => s.setChatModelRegistryId);
  const setChatProvider = useStore(s => s.setChatProvider);
  const setChatModel = useStore(s => s.setChatModel);

  const initialSection = useStore.getState().chatManagerInitialSection;
  const setChatManagerInitialSection = useStore((s) => s.setChatManagerInitialSection);
  const [section, setSection] = useState<Section>(
    (initialSection && ['agents', 'models', 'skills', 'tools', 'docs', 'knowledge', 'mcp', 'settings'].includes(initialSection))
      ? (initialSection as Section)
      : 'agents'
  );
  // Consume the signal once.
  useEffect(() => {
    if (initialSection) setChatManagerInitialSection(null);
    // intentionally one-shot - initialSection snapshot at mount is what we want
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Seed every piece of state from the cached bootstrap if we have one - the
  // modal then renders synchronously on reopen instead of flashing a loader
  // while the network round-trip completes. The background revalidation below
  // overwrites stale values when they come in.
  const cachedBoot = useMemo(() => getCachedChatManagerBootstrap(), []);
  const [prompts, setPrompts] = useState<SystemPromptEntry[]>(cachedBoot?.prompts ?? []);
  const [tools, setTools] = useState<ToolCatalogEntry[]>(cachedBoot?.tools ?? []);
  const [agents, setAgents] = useState<AgentPreset[]>(cachedBoot?.agents ?? []);
  const [models, setModels] = useState<ModelEntry[]>(cachedBoot?.models ?? []);
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>(cachedBoot?.mcp?.servers ?? []);
  const [mcpSource, setMcpSource] = useState<string>(cachedBoot?.mcp?.source ?? '');
  const [mcpLoading, setMcpLoading] = useState(cachedBoot === null);
  const [providers, setProviders] = useState<Record<string, ProviderStatusEntry>>(
    cachedBoot?.providers ?? {},
  );
  const [loading, setLoading] = useState(cachedBoot === null);
  const mcpServerCount = mcpServers.length;

  // Curated allowlist for the Skills tab. The backend still exposes every
  // built-in prompt / snippet, but we only surface the genuinely useful
  // skill-like starting points here. The default Ask prompt belongs to
  // the core Ask harness, not the Skills list.
  const ESSENTIAL_PROMPT_IDS = useMemo(
    () => new Set(['quantity-takeoff-specialist']),
    [],
  );
  // Hard exclude - `default-ask` is the harness default, never a "skill".
  // Filtered out even if a user override marked it custom.
  const HIDDEN_PROMPT_IDS = useMemo(() => new Set(['default-ask']), []);

  const visiblePrompts = useMemo(
    () => prompts.filter(
      (p) => !HIDDEN_PROMPT_IDS.has(p.id) && (ESSENTIAL_PROMPT_IDS.has(p.id) || p.is_custom),
    ),
    [prompts, ESSENTIAL_PROMPT_IDS, HIDDEN_PROMPT_IDS],
  );

  // Skills tile count reflects what's actually shown in the tab.
  const skillsCount = visiblePrompts.length;

  // Edit gate: hide the edit-assistant agent and the write_edit-tier tools
  // when the BACKEND reports editing disabled (runtime /edit-state probe into
  // editModeAvailable). Because it is the backend's own flag, the two sides
  // move in lock-step by construction - a backend that hides the tools here
  // also refuses to offer them to the LLM.
  const editModeAvailable = useStore((s) => s.editModeAvailable);
  const visibleAgents = useMemo(
    () => (editModeAvailable ? agents : agents.filter((a) => a.id !== 'edit-assistant')),
    [agents, editModeAvailable],
  );
  const visibleTools = useMemo(
    () => (editModeAvailable ? tools : tools.filter((t) => t.tier !== 'write_edit')),
    [tools, editModeAvailable],
  );

  // Agents tile reads "2" (Ask + Edit) with editing on; "1" (Ask only) when
  // the Edit surface is gated off.
  const agentCount = editModeAvailable ? 2 : 1;
  const docCount = useStore((s) => s.docIndexFiles.length);

  // Knowledge tile - reference-docs index status (plan E4). Owned here so the
  // nav tile count and the Knowledge tab render from the same object; the
  // section refreshes it after a fetch via setRefDocsStatus.
  const [refDocsStatus, setRefDocsStatus] = useState<ReferenceDocsStatus | null>(null);
  useEffect(() => {
    getReferenceDocsStatus().then(setRefDocsStatus).catch(() => { /* tile shows em-dash */ });
  }, []);

  // ESC closes the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Load (or revalidate) the bootstrap payload. When the cache had a hit we
  // already rendered with valid data; this refresh just overwrites stale
  // values silently. When there was no cache we also flip the loading flags
  // off here.
  useEffect(() => {
    getChatManagerBootstrap().then((boot) => {
      setPrompts(boot.prompts ?? []);
      setTools(boot.tools ?? []);
      setAgents(boot.agents ?? []);
      setModels(boot.models ?? []);
      setMcpServers(boot.mcp?.servers ?? []);
      setMcpSource(boot.mcp?.source ?? '');
      setProviders(boot.providers ?? {});
    }).finally(() => {
      setMcpLoading(false);
      setLoading(false);
    });
  }, []);

  // Decoupled prompt CRUD for the Skills section's inline editor. These wrap
  // the API + refresh the shared `prompts` state without entangling the legacy
  // editor's draft/selection state. All writes land in the user data dir
  // (~/.ifc-atlas/data/system_prompts.json) - the project repo is never touched.
  const refreshPrompts = useCallback(async () => {
    const updated = await listPrompts();
    setPrompts(updated.prompts);
    return updated.prompts;
  }, []);

  const handleCreatePromptSkill = useCallback(async (payload: PromptDraft) => {
    const r = await createPrompt(payload);
    await refreshPrompts();
    return r.prompt;
  }, [refreshPrompts]);

  const handleUpdatePromptSkill = useCallback(async (id: string, payload: PromptDraft) => {
    const r = await updatePrompt(id, payload);
    await refreshPrompts();
    return r.prompt;
  }, [refreshPrompts]);

  const handleDeletePromptSkill = useCallback(async (id: string) => {
    await deletePrompt(id);
    await refreshPrompts();
  }, [refreshPrompts]);

  // Model Registry CRUD - wrap the API + refresh the shared `models` state.
  // All writes land in ~/.ifc-atlas/data/models.json.
  const refreshModels = useCallback(async () => {
    const updated = await listModels();
    setModels(updated.models);
    return updated.models;
  }, []);

  const handleCreateModel = useCallback(async (payload: ModelPayload) => {
    const r = await createModel(payload);
    await refreshModels();
    return r.model;
  }, [refreshModels]);

  const handleUpdateModel = useCallback(async (id: string, payload: ModelPayload) => {
    const r = await updateModel(id, payload);
    await refreshModels();
    return r.model;
  }, [refreshModels]);

  const handleDeleteModel = useCallback(async (id: string) => {
    await deleteModel(id);
    await refreshModels();
    // If the deleted model was the active one, clear the selection so the chat
    // dropdown falls back to a still-present model.
    if (chatModelRegistryId === id) setChatModelRegistryId(null);
  }, [refreshModels, chatModelRegistryId, setChatModelRegistryId]);

  const handleReorderModels = useCallback(async (order: string[]) => {
    const r = await reorderModels(order);
    setModels(r.models);
  }, []);

  // "Use in chat" - make this model drive the chat (provider + model_id + the
  // registry id the backend resolves sampling from).
  const handleUseModel = useCallback((m: ModelEntry) => {
    setChatModelRegistryId(m.id);
    setChatProvider(m.provider);
    setChatModel(m.model_id);
  }, [setChatModelRegistryId, setChatProvider, setChatModel]);

  return (
    <div className="cm-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cm-panel">
        {/* Header */}
        <div className="cm-header">
          <div className="cm-title-block">
            <span className="cm-title-icon"><Icon name="cpu" size={16} strokeWidth={1.8} /></span>
            <div>
              <div className="cm-title">Chat Manager</div>
              <div className="cm-subtitle">Agents · skills · tools · MCP · settings for {editModeAvailable ? 'Ask & Edit' : 'Ask'}</div>
            </div>
          </div>
          <button className="cm-close" onClick={onClose} title="Close (Esc)">
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="cm-body">
          {/* Section nav */}
          <div className="cm-nav">
            {SECTIONS.map(s => {
              const isActive = section === s.id;
              return (
              <button
                key={s.id}
                className={`cm-nav-item${isActive ? ' cm-nav-item--active' : ''}`}
                onClick={() => setSection(s.id)}
                title={s.hint}
              >
                <Icon name={s.icon} size={14} strokeWidth={1.8} />
                <div className="cm-nav-item-label">
                  <span className="cm-nav-item-title">{s.label}</span>
                  <span className="cm-nav-item-count">
                    {s.id === 'agents'   ? `${agentCount} agents`
                      : s.id === 'models'   ? `${models.length} models`
                      : s.id === 'skills'   ? `${skillsCount} items`
                      : s.id === 'tools'    ? `${visibleTools.length} tools`
                      : s.id === 'docs'     ? `${docCount} files`
                      : s.id === 'knowledge' ? (refDocsStatus === null ? ' - '
                          : refDocsStatus.indexed ? `${refDocsStatus.doc_count} domains`
                          : 'not indexed')
                      : s.id === 'mcp'      ? `${mcpServerCount} servers`
                      : 'global'}
                  </span>
                </div>
              </button>
              );
            })}
          </div>

          {/* Section content */}
          {loading ? (
            <div className="cm-loading"><Icon name="refresh" size={14} /> Loading…</div>
          ) : section === 'tools' ? (
            <ToolsRegistrySection tools={visibleTools} agents={visibleAgents} />
          ) : section === 'skills' ? (
            <SkillsSection
              prompts={visiblePrompts}
              snippets={[]}
              activePromptId={activePromptId}
              onActivatePrompt={setActivePromptId}
              onCreatePrompt={handleCreatePromptSkill}
              onUpdatePrompt={handleUpdatePromptSkill}
              onDeletePrompt={handleDeletePromptSkill}
              onCloseManager={onClose}
            />
          ) : section === 'agents' ? (
            <AgentRosterSection
              agents={visibleAgents}
              tools={visibleTools}
            />
          ) : section === 'models' ? (
            <ModelsSection
              models={models}
              activeModelId={chatModelRegistryId}
              onUse={handleUseModel}
              onCreate={handleCreateModel}
              onUpdate={handleUpdateModel}
              onDelete={handleDeleteModel}
              onReorder={handleReorderModels}
            />
          ) : section === 'docs' ? (
            <DocumentsSection />
          ) : section === 'knowledge' ? (
            <KnowledgeSection
              status={refDocsStatus}
              onStatusChange={setRefDocsStatus}
            />
          ) : section === 'mcp' ? (
            <McpSection
              servers={mcpServers}
              source={mcpSource}
              loading={mcpLoading}
            />
          ) : (
            <ConfigSection providers={providers} onProvidersChanged={setProviders} />
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Agent Roster section - list every agent preset
// ============================================================================

interface AgentRosterSectionProps {
  agents: AgentPreset[];
}

const AGENT_CATEGORY_COLOURS: Record<string, string> = {
  ask: 'var(--info)',
  plan: 'var(--purple)',
  edit: 'var(--err)',
};
const AGENT_CATEGORY_LABEL: Record<string, string> = {
  ask: 'Ask',
  plan: 'Plan',
  edit: 'Edit',
};

// The two default agents the chat surface exposes via the Ask + Edit pills.
const PANEL_DEFAULT_AGENT_IDS = ['default', 'edit-assistant'] as const;

interface AgentRosterSectionPropsExt extends AgentRosterSectionProps {
  tools: ToolCatalogEntry[];
}

function AgentRosterSection({ agents, tools }: AgentRosterSectionPropsExt) {
  const activeAgentId = useStore((s) => s.activeAgentId);
  const setActiveAgentId = useStore((s) => s.setActiveAgentId);

  // Only show the two defaults - the other 7 presets are not surfaced any more
  // (custom agent creation lands in a follow-up).
  const visible = useMemo(() => {
    const defaultIds = new Set<string>(PANEL_DEFAULT_AGENT_IDS);
    const defaults = agents.filter((a) => defaultIds.has(a.id));
    defaults.sort(
      (x, y) =>
        PANEL_DEFAULT_AGENT_IDS.indexOf(x.id as (typeof PANEL_DEFAULT_AGENT_IDS)[number])
 - PANEL_DEFAULT_AGENT_IDS.indexOf(y.id as (typeof PANEL_DEFAULT_AGENT_IDS)[number]),
    );
    return defaults;
  }, [agents]);

  const [selectedId, setSelectedId] = useState<string | null>(
    () => visible[0]?.id ?? null,
  );
  const selected = useMemo(
    () => visible.find((a) => a.id === selectedId) ?? visible[0] ?? null,
    [visible, selectedId],
  );

  return (
    <>
      <div className="cm-list cm-skills-list cm-agents-list">
        <div className="cm-list-header">
          <span className="cm-list-label">Agents</span>
          <span className="cm-list-readonly-pill" title="Built-in agents - custom agents coming soon">
            <Icon name="lock" size={9} /> built-in
          </span>
        </div>

        <div className="cm-list-items">
          {visible.map((a) => {
            const isSel = selected?.id === a.id;
            const isActive = activeAgentId === a.id;
            return (
              <div
                key={a.id}
                className={`cm-skill-row${isSel ? ' cm-skill-row--selected' : ''}`}
                onClick={() => setSelectedId(a.id)}
                role="button"
                tabIndex={0}
                aria-selected={isSel}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSelectedId(a.id); }}
                title={a.description || a.label}
              >
                <span className="cm-skill-icon" title="Agent">
                  <Icon name="sparkle" size={13} strokeWidth={1.8} />
                </span>
                <span className="cm-skill-name">{a.label}</span>
                {isActive && <span className="cm-active-dot" title="Active agent" />}
              </div>
            );
          })}
        </div>
      </div>

      <div className="cm-detail cm-skills-detail">
        {selected ? (
          <AgentRosterDetail
            agent={selected}
            isActive={activeAgentId === selected.id}
            tools={tools}
            onUse={() => setActiveAgentId(selected.id)}
          />
        ) : (
          <div className="cm-empty"><Icon name="sparkle" size={20} /> Select an agent on the left</div>
        )}
      </div>
    </>
  );
}

function AgentRosterDetail({
  agent,
  isActive,
  tools,
  onUse,
}: {
  agent: AgentPreset;
  isActive: boolean;
  tools: ToolCatalogEntry[];
  onUse: () => void;
}) {
  const isDefault = (PANEL_DEFAULT_AGENT_IDS as readonly string[]).includes(agent.id);
  const tag = agent.id === 'edit-assistant' ? 'EDIT' : 'ASK';

  // For each tool: is it allowed by this agent?  `allowed_tools === null`
  // means "no allowlist filter" (every tool is enabled).
  const toolRows = useMemo(() => {
    const allowSet = agent.allowed_tools === null
      ? null
      : new Set(agent.allowed_tools);
    const enabled = (name: string) => allowSet === null || allowSet.has(name);
    const rows = tools.map((t) => ({ tool: t, enabled: enabled(t.name) }));
    // Enabled first, then alpha by name within each band.
    rows.sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return a.tool.name.localeCompare(b.tool.name);
    });
    return rows;
  }, [tools, agent.allowed_tools]);

  const enabledCount = toolRows.filter((r) => r.enabled).length;

  const toolsLabel = agent.allowed_tools === null
    ? `All ${tools.length} tools`
    : `${enabledCount} of ${tools.length} enabled`;

  return (
    <>
      <div className="cm-skills-hero">
        <div className="cm-skills-hero-top">
          {isDefault && (
            <span className={`cm-skills-kind-tag cm-skills-kind-tag--agent-${tag.toLowerCase()}`}>
              <Icon name="sparkle" size={11} strokeWidth={1.8} />
              {tag}
            </span>
          )}
          <span className="cm-skills-builtin-tag">
            <Icon name="lock" size={10} strokeWidth={1.8} /> Built-in
          </span>
        </div>

        <h2 className="cm-skills-hero-title">{agent.label}</h2>
        {agent.description && (
          <p className="cm-skills-hero-desc">{agent.description}</p>
        )}

        <div className="cm-skills-hero-actions">
          <button
            className={`cm-pill-btn cm-pill-btn--primary${isActive ? ' cm-pill-btn--active' : ''}`}
            onClick={onUse}
            disabled={isActive}
          >
            <Icon name="zap" size={12} /> {isActive ? 'Active' : 'Use'}
          </button>
        </div>
      </div>

      <div className="cm-skills-detail-body">
        {agent.id === 'edit-assistant' && (
          <div className="cm-editscope-note">
            <span className="cm-skills-section-title">Edit scopes - what it can change</span>
            <div className="cm-editscope-row">
              <span className="cm-editscope-badge cm-editscope-badge--semantic">Semantic</span>
              <span>
                Names, property &amp; pset values, classifications. Updates the 3D
                viewer <strong>in place - no reload</strong>. Safe to run in bulk.
                The default scope.
              </span>
            </div>
            <div className="cm-editscope-row">
              <span className="cm-editscope-badge cm-editscope-badge--structural">
                Structural · {STRUCTURAL_EDIT_ENABLED ? 'beta' : 'off'}
              </span>
              <span>
                Create walls / slabs, delete elements, run IFC code. Changes
                geometry, so it <strong>reloads the 3D viewer</strong>.{' '}
                {STRUCTURAL_EDIT_ENABLED
                  ? 'Enable it with the scope toggle in the top edit bar.'
                  : 'Turned off in this release - geometry authoring is not available yet.'}
              </span>
            </div>
            <p className="cm-editscope-hint">
              {STRUCTURAL_EDIT_ENABLED
                ? 'In semantic scope the structural tools are removed from the agent entirely, so property editing never triggers a reload.'
                : 'The structural tools are removed from the agent entirely, so editing is limited to metadata and never triggers a reload.'}
              {' '}See
              <code> dev/docs/EDIT_SCOPES.md</code>.
            </p>
          </div>
        )}
        <div className="cm-skills-chips">
          <span className="cm-skills-chip">
            <span className="cm-skills-chip-label">Tools</span>
            <span className="cm-skills-chip-val">{toolsLabel}</span>
          </span>
        </div>

        {agent.system_prompt && (
          <div className="cm-skills-content-block">
            <span className="cm-skills-section-title">System prompt</span>
            <pre className="cm-skills-content-pre">{agent.system_prompt}</pre>
          </div>
        )}

        <div className="cm-skills-content-block">
          <span className="cm-skills-section-title">Tool access</span>
          <ul className="cm-agent-tools">
            {toolRows.map(({ tool, enabled }) => (
              <li
                key={tool.name}
                className={`cm-agent-tool-row cm-agent-tool-row--${enabled ? 'on' : 'off'}`}
              >
                <span
                  className={`cm-agent-tool-dot${enabled ? ' cm-agent-tool-dot--on' : ''}`}
                  title={enabled ? 'Enabled' : 'Disabled'}
                />
                <code className="cm-agent-tool-name">{tool.name}</code>
                <span className="cm-agent-tool-tier">{tool.tier_label}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}

// ============================================================================
// MCP Servers section - external servers contributing tools to the chat
// ============================================================================

interface McpSectionProps {
  servers: McpServerConfig[];
  source: string;
  loading: boolean;
}

function McpSection({ servers, source, loading }: McpSectionProps) {
  if (loading) {
    return (
      <div className="cm-loading">
        <Icon name="refresh" size={14} /> Loading MCP servers…
      </div>
    );
  }

  return (
    <div className="cm-mcp">
      <div className="cm-mcp-header">
        <h3 className="cm-mcp-title">MCP Servers</h3>
        <p className="cm-mcp-hint">
          Refer to <code>docs/agent/MCP_CLIENTS.md</code> for more info.
        </p>
      </div>

      {servers.length === 0 ? (
        <div className="cm-mcp-empty">
          <Icon name="plug" size={20} strokeWidth={1.5} />
          <div className="cm-mcp-empty-title">No MCP servers configured</div>
          <div className="cm-mcp-empty-hint">
            Refer to <code>docs/agent/MCP_CLIENTS.md</code> for more info.
          </div>
        </div>
      ) : (
        <ul className="cm-mcp-list">
          {servers.map((s) => {
            const enabled = s.enabled !== false;
            const cmdLine =
              (s.command && String(s.command)) ||
              (s.url && String(s.url)) ||
              '';
            return (
              <li
                key={s.name}
                className={`cm-mcp-row${enabled ? '' : ' cm-mcp-row--disabled'}`}
              >
                <span className={`cm-mcp-dot${enabled ? ' cm-mcp-dot--on' : ''}`} />
                <div className="cm-mcp-row-body">
                  <div className="cm-mcp-row-title">
                    <span className="cm-mcp-name">{s.name}</span>
                    <span className="cm-mcp-status">
                      {enabled ? 'enabled' : 'disabled'}
                    </span>
                  </div>
                  <div className="cm-mcp-row-meta" title={cmdLine}>
                    {cmdLine.length > 96 ? cmdLine.slice(0, 95) + '…' : cmdLine}
                  </div>
                  {s.description ? (
                    <div className="cm-mcp-row-desc">{String(s.description)}</div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="cm-mcp-footer">Refer to <code>docs/agent/MCP_CLIENTS.md</code> for more info.</div>
    </div>
  );
}

// ============================================================================
// Settings section - provider status + global chat defaults
// ============================================================================

function ConfigSection({
  providers,
  onProvidersChanged,
}: {
  providers: Record<string, ProviderStatusEntry>;
  onProvidersChanged?: (next: Record<string, ProviderStatusEntry>) => void;
}) {
  const chatProvider = useStore(s => s.chatProvider);
  const setChatProvider = useStore(s => s.setChatProvider);
  const chatModel = useStore(s => s.chatModel);
  const setChatModel = useStore(s => s.setChatModel);
  const chatTemperature = useStore(s => s.chatTemperature);
  const setChatTemperature = useStore(s => s.setChatTemperature);
  const [keysOpen, setKeysOpen] = useState(false);

  return (
    <div className="cm-config">
      <h3 className="cm-config-title">Provider configuration</h3>
      <p className="cm-config-hint">
        Keys are stored locally in <code>~/.ifc-atlas/secrets.json</code> and
        take effect immediately - no restart needed. A key in your{' '}
        <code>.env</code> file or shell wins over the stored one, so developers
        can keep using their existing setup.
      </p>
      <div style={{ marginBottom: 12 }}>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => setKeysOpen(true)}
        >
          <Icon name="lock" size={12} />
          Manage AI keys
        </button>
      </div>

      {Object.keys(providers).length === 0 ? (
        <div className="cm-loading"><Icon name="refresh" size={14} /> Loading providers…</div>
      ) : (
        <ul className="cm-providers-list">
          {Object.entries(providers).map(([id, p]) => {
            const liveOk = p.configured;
            const liveDown = !p.configured;
            const sourceLabel = p.configured
              ? (p.source === 'env'
                  ? `from ${p.env_var}${p.masked ? ` · ${p.masked}` : ''}`
                  : `saved key${p.masked ? ` · ${p.masked}` : ''}`)
              : null;
            const statusLabel = p.configured ? 'configured' : 'not set';
            return (
              <li key={id} className={`cm-provider-row${liveDown ? ' cm-provider-row--down' : ''}`}>
                <span className={`cm-provider-dot${liveOk ? ' cm-provider-dot--on' : ''}`} />
                <div className="cm-provider-body">
                  <div className="cm-provider-title">
                    <span className="cm-provider-name">{p.name}</span>
                    <span className="cm-provider-status">{statusLabel}</span>
                  </div>
                  <div className="cm-provider-meta">
                    {sourceLabel ? <code>{sourceLabel}</code> : <code>{p.env_var}</code>}
                    {p.base_url ? <> · <code>{p.base_url}</code></> : null}
                  </div>
                  <div className="cm-provider-default">
                    Default model: <code>{p.default_model}</code>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <h3 className="cm-config-title" style={{ marginTop: 28 }}>Chat defaults</h3>
      <p className="cm-config-hint">
        These settings apply to every Ask &amp; Edit message. The chat panel's model
        dropdown shadows these for the current session only.
      </p>

      <label className="cm-config-field">
        <span className="cm-config-label">Default provider</span>
        <select
          className="cm-config-select"
          value={chatProvider}
          onChange={e => setChatProvider(e.target.value)}
        >
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
          <option value="openrouter">OpenRouter</option>
        </select>
      </label>

      <label className="cm-config-field">
        <span className="cm-config-label">Default model</span>
        <input
          className="cm-config-input"
          value={chatModel}
          onChange={e => setChatModel(e.target.value)}
          placeholder="e.g. gpt-4o, claude-sonnet-4-20250514"
        />
      </label>

      <div className="cm-config-field">
        <span className="cm-config-label">
          Default temperature
          <span className="cm-config-value">{chatTemperature.toFixed(2)}</span>
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={chatTemperature}
          onChange={e => setChatTemperature(parseFloat(e.target.value))}
          className="cm-config-slider"
        />
        <div className="cm-config-slider-labels">
          <span>Precise</span><span>Creative</span>
        </div>
      </div>

      <div className="cm-config-note">
        <Icon name="info" size={12} />
        <span>Tool sets and system prompts are managed in their own sections of this panel.</span>
      </div>

      {keysOpen && (
        <AiKeysModal
          mode="manage"
          onClose={() => setKeysOpen(false)}
          onChanged={(res) => {
            if (!onProvidersChanged) return;
            // Merge the freshly-returned per-provider status into the panel's
            // cached map so the rows re-render without a full bootstrap refetch.
            const merged: Record<string, ProviderStatusEntry> = { ...providers };
            for (const [id, entry] of Object.entries(res.providers)) {
              const prev = merged[id];
              if (!prev) continue;
              merged[id] = {
                ...prev,
                configured: entry.configured,
                source: entry.source,
                masked: entry.masked,
              };
            }
            onProvidersChanged(merged);
          }}
        />
      )}
    </div>
  );
}
