/**
 * Pure helpers for the IFC Model Health Check feature.
 * All functions are side-effect-free so they can be unit-tested without a DOM.
 */

import type { HealthRuleResult } from '../../store/useStore';

// ─── Display helpers ──────────────────────────────────────────────────────────

export function severityBadge(sev: 'error' | 'warning' | 'info'): string {
  if (sev === 'error') return '✕';
  if (sev === 'warning') return '⚠';
  return 'ℹ';
}

export function severityClass(sev: 'error' | 'warning' | 'info'): string {
  if (sev === 'error') return 'health-sev--error';
  if (sev === 'warning') return 'health-sev--warning';
  return 'health-sev--info';
}

export function ruleLabel(ruleId: string): string {
  return ruleId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

export function totalsBySeverity(rules: HealthRuleResult[]): {
  error: number;
  warning: number;
  info: number;
} {
  const out = { error: 0, warning: 0, info: 0 };
  for (const r of rules) {
    out[r.severity] = (out[r.severity] ?? 0) + r.count;
  }
  return out;
}

export function overallSeverity(
  rules: HealthRuleResult[],
): 'error' | 'warning' | 'info' | 'ok' {
  const totals = totalsBySeverity(rules);
  if (totals.error > 0) return 'error';
  if (totals.warning > 0) return 'warning';
  if (totals.info > 0) return 'info';
  return 'ok';
}

// ─── Export ───────────────────────────────────────────────────────────────────

/**
 * Renders health-check results as a Markdown summary string suitable for
 * clipboard export or a chat attachment.
 */
export function exportHealthReportMarkdown(rules: HealthRuleResult[]): string {
  const totals = totalsBySeverity(rules);
  const lines: string[] = ['# IFC Model Health Report', ''];

  const summaryParts: string[] = [];
  if (totals.error > 0) summaryParts.push(`${totals.error} error${totals.error !== 1 ? 's' : ''}`);
  if (totals.warning > 0) summaryParts.push(`${totals.warning} warning${totals.warning !== 1 ? 's' : ''}`);
  if (totals.info > 0) summaryParts.push(`${totals.info} info`);

  lines.push(
    summaryParts.length > 0
      ? `**Summary:** ${summaryParts.join(' · ')}`
      : '**Summary:** No issues found ✓',
  );
  lines.push('');

  for (const rule of rules) {
    if (rule.count === 0) continue;
    lines.push(
      `## ${severityBadge(rule.severity)} ${ruleLabel(rule.rule_id)} (${rule.count})`,
    );
    lines.push(`_${rule.description}_`);
    lines.push('');
    const shown = rule.issues.slice(0, 10);
    for (const issue of shown) {
      const nameTag = issue.element_name ? `**${issue.element_name}**` : '_unnamed_';
      const idTag = issue.element_id != null ? ` #${issue.element_id}` : '';
      lines.push(`- ${nameTag}${idTag}: ${issue.message}`);
    }
    if (rule.count > shown.length) {
      lines.push(`- _…and ${rule.count - shown.length} more_`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
