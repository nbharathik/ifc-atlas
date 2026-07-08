import { describe, it, expect } from 'vitest';
import {
  severityBadge,
  severityClass,
  ruleLabel,
  totalsBySeverity,
  overallSeverity,
  exportHealthReportMarkdown,
} from '../healthHelpers';
import type { HealthRuleResult } from '../../../store/useStore';

function makeRule(
  ruleId: string,
  sev: 'error' | 'warning' | 'info',
  count: number,
  issues: { element_id?: number | null; element_name: string; message: string }[] = [],
): HealthRuleResult {
  return {
    rule_id: ruleId,
    severity: sev,
    description: `Description for ${ruleId}`,
    count,
    issues: issues.map((i) => ({
      rule_id: ruleId,
      severity: sev,
      element_id: i.element_id ?? null,
      element_name: i.element_name,
      message: i.message,
    })),
  };
}

// ─── severityBadge ────────────────────────────────────────────────────────────

describe('severityBadge', () => {
  it('returns ✕ for error', () => expect(severityBadge('error')).toBe('✕'));
  it('returns ⚠ for warning', () => expect(severityBadge('warning')).toBe('⚠'));
  it('returns ℹ for info', () => expect(severityBadge('info')).toBe('ℹ'));
});

// ─── severityClass ────────────────────────────────────────────────────────────

describe('severityClass', () => {
  it('contains "error" for error', () => expect(severityClass('error')).toContain('error'));
  it('contains "warning" for warning', () => expect(severityClass('warning')).toContain('warning'));
  it('contains "info" for info', () => expect(severityClass('info')).toContain('info'));
  it('all classes start with health-sev--', () => {
    for (const s of ['error', 'warning', 'info'] as const) {
      expect(severityClass(s)).toMatch(/^health-sev--/);
    }
  });
});

// ─── ruleLabel ────────────────────────────────────────────────────────────────

describe('ruleLabel', () => {
  it('converts underscores to spaces', () => {
    expect(ruleLabel('missing_global_id')).not.toContain('_');
  });
  it('title-cases each word', () => {
    const label = ruleLabel('missing_global_id');
    expect(label).toBe('Missing Global Id');
  });
  it('handles single-word ids', () => {
    expect(ruleLabel('health')).toBe('Health');
  });
  it('handles already-space-separated strings', () => {
    expect(ruleLabel('no issues')).toBe('No Issues');
  });
});

// ─── totalsBySeverity ─────────────────────────────────────────────────────────

describe('totalsBySeverity', () => {
  it('returns zero totals for empty rules', () => {
    expect(totalsBySeverity([])).toEqual({ error: 0, warning: 0, info: 0 });
  });

  it('sums counts by severity', () => {
    const rules = [
      makeRule('a', 'error', 2),
      makeRule('b', 'error', 3),
      makeRule('c', 'warning', 5),
      makeRule('d', 'info', 1),
    ];
    expect(totalsBySeverity(rules)).toEqual({ error: 5, warning: 5, info: 1 });
  });

  it('handles rules with zero count', () => {
    const rules = [makeRule('a', 'error', 0), makeRule('b', 'warning', 0)];
    expect(totalsBySeverity(rules)).toEqual({ error: 0, warning: 0, info: 0 });
  });
});

// ─── overallSeverity ─────────────────────────────────────────────────────────

describe('overallSeverity', () => {
  it('returns ok for empty rules', () => {
    expect(overallSeverity([])).toBe('ok');
  });

  it('returns ok when all counts are zero', () => {
    expect(overallSeverity([makeRule('a', 'error', 0), makeRule('b', 'warning', 0)])).toBe('ok');
  });

  it('returns error when any error count > 0', () => {
    expect(overallSeverity([makeRule('a', 'error', 1), makeRule('b', 'warning', 3)])).toBe('error');
  });

  it('returns warning when no errors but warnings present', () => {
    expect(overallSeverity([makeRule('a', 'error', 0), makeRule('b', 'warning', 2)])).toBe('warning');
  });

  it('returns info when only info issues', () => {
    expect(overallSeverity([makeRule('a', 'info', 5)])).toBe('info');
  });
});

// ─── exportHealthReportMarkdown ───────────────────────────────────────────────

describe('exportHealthReportMarkdown', () => {
  it('produces a heading', () => {
    const md = exportHealthReportMarkdown([]);
    expect(md).toContain('# IFC Model Health Report');
  });

  it('shows "No issues found" when all counts are zero', () => {
    const md = exportHealthReportMarkdown([makeRule('a', 'error', 0)]);
    expect(md).toContain('No issues found');
  });

  it('omits rules with count = 0', () => {
    const rules = [
      makeRule('bad_rule', 'error', 0),
      makeRule('good_warn', 'warning', 2, [{ element_name: 'Wall', message: 'missing name' }]),
    ];
    const md = exportHealthReportMarkdown(rules);
    expect(md).not.toContain('Bad Rule');
    expect(md).toContain('Good Warn');
  });

  it('lists issue element names', () => {
    const rules = [
      makeRule('missing_name', 'warning', 1, [{ element_name: 'Slab-01', message: 'blank name' }]),
    ];
    const md = exportHealthReportMarkdown(rules);
    expect(md).toContain('Slab-01');
    expect(md).toContain('blank name');
  });

  it('shows overflow indicator when count > issues shown', () => {
    const issues = Array.from({ length: 12 }, (_, i) => ({
      element_name: `El-${i}`,
      message: 'bad',
    }));
    const rules = [makeRule('dup', 'info', 15, issues)];
    const md = exportHealthReportMarkdown(rules);
    // first 10 shown, remaining 5 as overflow
    expect(md).toContain('…and 5 more');
  });

  it('includes element id when present', () => {
    const rules = [
      makeRule('a', 'error', 1, [{ element_id: 42, element_name: 'Door', message: 'dup id' }]),
    ];
    const md = exportHealthReportMarkdown(rules);
    expect(md).toContain('#42');
  });

  it('handles element with no id gracefully', () => {
    const rules = [
      makeRule('a', 'error', 1, [{ element_id: null, element_name: 'Wall', message: 'missing' }]),
    ];
    const md = exportHealthReportMarkdown(rules);
    expect(md).not.toContain('#null');
    expect(md).toContain('Wall');
  });

  it('summary line contains issue counts', () => {
    const rules = [
      makeRule('a', 'error', 2),
      makeRule('b', 'warning', 3),
    ];
    const md = exportHealthReportMarkdown(rules);
    expect(md).toContain('2 errors');
    expect(md).toContain('3 warnings');
  });
});
