import { describe, it, expect } from 'vitest';
import type { AgentPreset, ToolCatalogEntry } from '../../../types/ifc';
import {
  agentAllowsTool,
  buildToolUsageRows,
  countUsage,
  filterToolUsageRows,
  formatDisabledSummary,
  sortToolUsageRows,
  tierColour,
  toggleToolDisabled,
  DEFAULT_AGENT_IDS,
} from '../ChatManagerPanel';

const TOOL_A: ToolCatalogEntry = {
  name: 'describe_model',
  description: 'Return project metadata and model overviews',
  parameters: {},
  where: 'server',
  tier: 'read_model',
  tier_label: 'Read model',
};
const TOOL_B: ToolCatalogEntry = {
  name: 'edit_semantic',
  description: 'Stage name and property edits for review',
  parameters: {},
  where: 'server',
  tier: 'write_edit',
  tier_label: 'Write / Edit',
};
const TOOL_C: ToolCatalogEntry = {
  name: 'viewer_control',
  description: 'Highlight, isolate and select elements in the viewer',
  parameters: {},
  where: 'client',
  tier: 'read_viewer',
  tier_label: 'Read viewer',
};

const ASK_AGENT: AgentPreset = {
  id: 'default',
  label: 'Default · Ask',
  description: 'Ask',
  provider: 'openai',
  model: 'gpt-4o',
  temperature: 0.3,
  icon: 'star',
  // null = no allowlist filter → every tool allowed
  allowed_tools: null,
  quick_prompts: [],
  category: 'ask',
};
const EDIT_AGENT: AgentPreset = {
  id: 'edit-assistant',
  label: 'Edit Assistant',
  description: 'Edit',
  provider: 'anthropic',
  model: 'claude-sonnet-4',
  temperature: 0.1,
  icon: 'edit',
  // explicit allowlist
  allowed_tools: ['describe_model', 'edit_semantic'],
  quick_prompts: [],
  category: 'edit',
};

describe('DEFAULT_AGENT_IDS', () => {
  it('contains exactly default + edit-assistant', () => {
    expect([...DEFAULT_AGENT_IDS]).toEqual(['default', 'edit-assistant']);
  });
});

describe('agentAllowsTool', () => {
  it('returns false for missing agents', () => {
    expect(agentAllowsTool(undefined, 'foo')).toBe(false);
  });

  it('returns true when allowed_tools is null (no allowlist)', () => {
    expect(agentAllowsTool(ASK_AGENT, 'anything')).toBe(true);
    expect(agentAllowsTool(ASK_AGENT, 'edit_semantic')).toBe(true);
  });

  it('returns true when the tool is in the explicit allowlist', () => {
    expect(agentAllowsTool(EDIT_AGENT, 'edit_semantic')).toBe(true);
    expect(agentAllowsTool(EDIT_AGENT, 'describe_model')).toBe(true);
  });

  it('returns false when the tool is missing from an explicit allowlist', () => {
    expect(agentAllowsTool(EDIT_AGENT, 'execute_ifc_code')).toBe(false);
    expect(agentAllowsTool(EDIT_AGENT, 'viewer_control')).toBe(false);
  });
});

describe('buildToolUsageRows', () => {
  const rows = buildToolUsageRows([TOOL_A, TOOL_B, TOOL_C], [ASK_AGENT, EDIT_AGENT]);

  it('returns one row per tool', () => {
    expect(rows).toHaveLength(3);
  });

  it('marks tools allowed by both Ask + Edit with both ids', () => {
    const editRow = rows.find((r) => r.tool.name === 'edit_semantic')!;
    expect(editRow.agents).toEqual(['default', 'edit-assistant']);
    expect(editRow.usageLabel).toBe('Ask · Edit');
  });

  it('marks Ask-only tools correctly (Edit allowlist omits them)', () => {
    const viewerRow = rows.find((r) => r.tool.name === 'viewer_control')!;
    expect(viewerRow.agents).toEqual(['default']);
    expect(viewerRow.usageLabel).toBe('Ask');
  });

  it('renders "None" usage when neither agent allows a tool', () => {
    const extraTool: ToolCatalogEntry = {
      ...TOOL_A,
      name: 'unused_tool',
    };
    // Ask has null allowlist so it would still match - supply a strict ask agent instead.
    const strictAsk: AgentPreset = { ...ASK_AGENT, allowed_tools: ['nothing'] };
    const out = buildToolUsageRows([extraTool], [strictAsk, EDIT_AGENT]);
    expect(out[0].agents).toEqual([]);
    expect(out[0].usageLabel).toBe('None');
  });

  it('handles missing default agents gracefully (returns "None")', () => {
    const out = buildToolUsageRows([TOOL_A], []);
    expect(out[0].agents).toEqual([]);
    expect(out[0].usageLabel).toBe('None');
  });
});

describe('sortToolUsageRows', () => {
  const both: ToolCatalogEntry = { ...TOOL_A, name: 'b_both' };
  const editOnly: ToolCatalogEntry = { ...TOOL_B, name: 'a_edit' };
  const askOnly: ToolCatalogEntry = { ...TOOL_C, name: 'a_ask' };
  const none: ToolCatalogEntry = { ...TOOL_A, name: 'z_none' };

  const strictAsk: AgentPreset = {
    ...ASK_AGENT,
    allowed_tools: ['b_both', 'a_ask'],
  };
  const strictEdit: AgentPreset = {
    ...EDIT_AGENT,
    allowed_tools: ['b_both', 'a_edit'],
  };

  it('orders both-bucket first, then edit-only, ask-only, none', () => {
    const built = buildToolUsageRows([none, askOnly, editOnly, both], [strictAsk, strictEdit]);
    const sorted = sortToolUsageRows(built);
    expect(sorted.map((r) => r.tool.name)).toEqual(['b_both', 'a_edit', 'a_ask', 'z_none']);
  });

  it('is stable within a bucket (alpha by tool name)', () => {
    const x: ToolCatalogEntry = { ...TOOL_C, name: 'x_ask' };
    const a: ToolCatalogEntry = { ...TOOL_C, name: 'a_ask' };
    const strictAskBoth: AgentPreset = { ...ASK_AGENT, allowed_tools: ['x_ask', 'a_ask'] };
    const rows = buildToolUsageRows([x, a], [strictAskBoth, EDIT_AGENT]);
    const sorted = sortToolUsageRows(rows);
    expect(sorted.map((r) => r.tool.name)).toEqual(['a_ask', 'x_ask']);
  });
});

describe('filterToolUsageRows', () => {
  const rows = sortToolUsageRows(buildToolUsageRows([TOOL_A, TOOL_B, TOOL_C], [ASK_AGENT, EDIT_AGENT]));

  it('returns everything when tier=all and query is empty', () => {
    expect(filterToolUsageRows(rows, 'all', '')).toHaveLength(3);
  });

  it('filters by tier exactly', () => {
    expect(filterToolUsageRows(rows, 'write_edit', '')).toHaveLength(1);
    expect(filterToolUsageRows(rows, 'read_viewer', '')).toHaveLength(1);
  });

  it('matches the query against name (case-insensitive)', () => {
    expect(filterToolUsageRows(rows, 'all', 'EDIT_SEMANTIC')).toHaveLength(1);
  });

  it('matches the query against description', () => {
    expect(filterToolUsageRows(rows, 'all', 'metadata')).toHaveLength(1);
  });

  it('returns empty for an unmatched query', () => {
    expect(filterToolUsageRows(rows, 'all', 'no-such-thing')).toEqual([]);
  });

  it('combines tier + query with AND', () => {
    expect(filterToolUsageRows(rows, 'write_edit', 'highlight')).toEqual([]);
    expect(filterToolUsageRows(rows, 'read_viewer', 'highlight')).toHaveLength(1);
  });
});

describe('countUsage', () => {
  it('buckets rows by usage cardinality', () => {
    const rows = buildToolUsageRows([TOOL_A, TOOL_B, TOOL_C], [ASK_AGENT, EDIT_AGENT]);
    const c = countUsage(rows);
    // ASK_AGENT has null allowlist (allows everything) so:
    //   - TOOL_A: allowed by both (Ask allows all, Edit explicit) → 'both'
    //   - TOOL_B: allowed by both                                  → 'both'
    //   - TOOL_C: allowed only by Ask (Edit doesn't list it)       → 'default'
    expect(c.both).toBe(2);
    expect(c['default']).toBe(1);
    expect(c['edit-assistant']).toBe(0);
    expect(c.none).toBe(0);
  });

  it('returns zeros for an empty list', () => {
    expect(countUsage([])).toEqual({ 'default': 0, 'edit-assistant': 0, both: 0, none: 0 });
  });
});

describe('tierColour', () => {
  it('returns four distinct colour tokens for the four tiers', () => {
    const colours = new Set([
      tierColour('read_model'),
      tierColour('read_viewer'),
      tierColour('validate'),
      tierColour('write_edit'),
    ]);
    expect(colours.size).toBe(4);
  });

  it('falls back to a grey for unknown tiers', () => {
    expect(tierColour('unknown')).toMatch(/^var\(--/);
  });
});

// ---------------------------------------------------------------------------
// toggleToolDisabled + formatDisabledSummary
// ---------------------------------------------------------------------------

describe('toggleToolDisabled', () => {
  it('adds a tool to the disabled set', () => {
    const next = toggleToolDisabled(new Set(), 'edit_semantic');
    expect(next.has('edit_semantic')).toBe(true);
    expect(next.size).toBe(1);
  });

  it('removes an already-disabled tool', () => {
    const next = toggleToolDisabled(new Set(['edit_semantic']), 'edit_semantic');
    expect(next.has('edit_semantic')).toBe(false);
    expect(next.size).toBe(0);
  });

  it('does not mutate the input set', () => {
    const input = new Set(['a']);
    toggleToolDisabled(input, 'b');
    expect(Array.from(input)).toEqual(['a']);
  });

  it('preserves unrelated entries on add', () => {
    const next = toggleToolDisabled(new Set(['a', 'b']), 'c');
    expect(next).toEqual(new Set(['a', 'b', 'c']));
  });

  it('preserves unrelated entries on remove', () => {
    const next = toggleToolDisabled(new Set(['a', 'b', 'c']), 'b');
    expect(next).toEqual(new Set(['a', 'c']));
  });
});

describe('formatDisabledSummary', () => {
  it('returns "all enabled" + check icon when count is 0', () => {
    const s = formatDisabledSummary(0);
    expect(s.icon).toBe('check');
    expect(s.label).toContain('all enabled');
    expect(s.tooltip).toContain('Every tool is enabled');
  });

  it('returns "N disabled" + eye-off icon when count > 0', () => {
    const s = formatDisabledSummary(3);
    expect(s.icon).toBe('eye-off');
    expect(s.label).toContain('3 disabled');
    expect(s.tooltip).toContain('3 tool(s) globally disabled');
  });

  it('singular handling for 1 disabled tool keeps the "(s)" plural form', () => {
    // The tooltip uses "tool(s)" so it works for 1 and N without grammar churn.
    const s = formatDisabledSummary(1);
    expect(s.label).toContain('1 disabled');
    expect(s.tooltip).toContain('1 tool(s)');
  });

  it('treats negative counts defensively as "all enabled"', () => {
    const s = formatDisabledSummary(-1);
    expect(s.icon).toBe('check');
  });
});
