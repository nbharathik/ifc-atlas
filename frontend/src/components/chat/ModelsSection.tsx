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

import { useState, useEffect, useMemo, useCallback } from 'react';
import Icon from '../ui/Icon';
import type {
  ModelEntry, ModelProvider, ModelUseCase, ModelCostTier, ModelSpeedTier, ModelReasoning,
} from '../../types/ifc';
import type { ModelPayload } from '../../services/api';

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

interface Props {
  models: ModelEntry[];
  activeModelId: string | null;
  onUse: (model: ModelEntry) => void;
  onCreate: (payload: ModelPayload) => Promise<ModelEntry>;
  onUpdate: (id: string, payload: ModelPayload) => Promise<ModelEntry>;
  onDelete: (id: string) => Promise<void>;
  onReorder: (orderedIds: string[]) => Promise<void>;
}

export default function ModelsSection({
  models, activeModelId, onUse, onCreate, onUpdate, onDelete, onReorder,
}: Props) {
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
