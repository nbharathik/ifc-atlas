/**
 * Tools registry - one flat list of every tool the backend
 * exposes, with "Used by Ask / Edit / Both / Neither" badges.
 *
 * Replaces the curate-tool-sets view in the Chat Manager.  The user asked
 * for a single sub-heading list of all tools showing which agent uses each;
 * the old per-tool-set fork-and-customise flow is hidden behind a "show tool
 * sets" toggle as a Phase 6b follow-up.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Icon from '../ui/Icon';
import type { AgentPreset, ToolCatalogEntry } from '../../types/ifc';
import { getToolSettings, setToolSettings } from '../../services/api';
import {
  buildToolUsageRows,
  filterToolUsageRows,
  formatDisabledSummary,
  sortToolUsageRows,
  tierColour,
  toggleToolDisabled,
  type ToolUsageRow,
} from './toolsRegistryHelpers';

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

export default function ToolsRegistrySection({ tools, agents }: ToolsRegistrySectionProps) {
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
