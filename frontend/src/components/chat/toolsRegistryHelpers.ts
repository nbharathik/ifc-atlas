/**
 * Pure helpers for the Tools global registry.
 *
 * Maps every tool in the backend catalogue to the agents that allow it,
 * then ranks them so the most-used tools appear first.  Pure / synchronous /
 * vitest-friendly.
 */
import type { AgentPreset, ToolCatalogEntry } from '../../types/ifc';

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
