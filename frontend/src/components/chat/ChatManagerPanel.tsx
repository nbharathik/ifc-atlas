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

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useStore } from '../../store/useStore';
import { STRUCTURAL_EDIT_ENABLED } from '../../config/featureFlags';
import Icon, { type IconName } from '../ui/Icon';
import type { SystemPromptEntry, ToolCatalogEntry, McpServerConfig, ModelEntry } from '../../types/ifc';
import {
  listPrompts, createPrompt, updatePrompt, deletePrompt,
  listModels, createModel, updateModel, deleteModel, reorderModels,
  getChatManagerBootstrap,
  getCachedChatManagerBootstrap,
  getReferenceDocsStatus,
  type ProviderStatusEntry,
  type ModelPayload,
  type ReferenceDocsStatus,
} from '../../services/api';
import type { AgentPreset } from '../../types/ifc';
import AiKeysModal from './AiKeysModal';
import SkillsSection, { type PromptDraft } from './SkillsSection';
import DocumentsSection from './DocumentsSection';
import ToolsRegistrySection from './ToolsRegistrySection';
import ModelsSection from './ModelsSection';
import KnowledgeSection from './KnowledgeSection';
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
const DEFAULT_AGENT_IDS = ['default', 'edit-assistant'] as const;

interface AgentRosterSectionPropsExt extends AgentRosterSectionProps {
  tools: ToolCatalogEntry[];
}

function AgentRosterSection({ agents, tools }: AgentRosterSectionPropsExt) {
  const activeAgentId = useStore((s) => s.activeAgentId);
  const setActiveAgentId = useStore((s) => s.setActiveAgentId);

  // Only show the two defaults - the other 7 presets are not surfaced any more
  // (custom agent creation lands in a follow-up).
  const visible = useMemo(() => {
    const defaultIds = new Set<string>(DEFAULT_AGENT_IDS);
    const defaults = agents.filter((a) => defaultIds.has(a.id));
    defaults.sort(
      (x, y) =>
        DEFAULT_AGENT_IDS.indexOf(x.id as (typeof DEFAULT_AGENT_IDS)[number])
 - DEFAULT_AGENT_IDS.indexOf(y.id as (typeof DEFAULT_AGENT_IDS)[number]),
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
  const isDefault = (DEFAULT_AGENT_IDS as readonly string[]).includes(agent.id);
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
