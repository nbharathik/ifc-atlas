/**
 * Tests for the model health store slice and ModelHealthPanel pure helpers.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../useStore';
import type { HealthCheckResult, HealthRuleResult } from '../useStore';
import {
  severityBadge,
  severityClass,
  totalsBySeverity,
  ruleLabel,
} from '../../components/panels/ModelHealthPanel';

// ─── Store slice ──────────────────────────────────────────────────────────────

function reset() {
  useStore.setState({
    healthPanelOpen: false,
    healthCheckResult: null,
    modelLoaded: false,
  });
}

describe('modelHealth store slice', () => {
  beforeEach(reset);

  it('defaults: panel closed, result null', () => {
    const s = useStore.getState();
    expect(s.healthPanelOpen).toBe(false);
    expect(s.healthCheckResult).toBeNull();
  });

  it('setHealthPanelOpen(true) opens the panel', () => {
    useStore.getState().setHealthPanelOpen(true);
    expect(useStore.getState().healthPanelOpen).toBe(true);
  });

  it('setHealthPanelOpen(false) closes the panel', () => {
    useStore.getState().setHealthPanelOpen(true);
    useStore.getState().setHealthPanelOpen(false);
    expect(useStore.getState().healthPanelOpen).toBe(false);
  });

  it('setHealthCheckResult stores the result', () => {
    const result: HealthCheckResult = {
      total_issues: 3,
      by_severity: { error: 1, warning: 2, info: 0 },
      rules: [],
    };
    useStore.getState().setHealthCheckResult(result);
    expect(useStore.getState().healthCheckResult?.total_issues).toBe(3);
  });

  it('setHealthCheckResult(null) clears the result', () => {
    const result: HealthCheckResult = {
      total_issues: 1,
      by_severity: { error: 1, warning: 0, info: 0 },
      rules: [],
    };
    useStore.getState().setHealthCheckResult(result);
    useStore.getState().setHealthCheckResult(null);
    expect(useStore.getState().healthCheckResult).toBeNull();
  });

  it('setModelLoaded(false) clears a prior health result', () => {
    const result: HealthCheckResult = {
      total_issues: 2,
      by_severity: { error: 2, warning: 0, info: 0 },
      rules: [],
    };
    useStore.setState({ modelLoaded: true, healthCheckResult: result });
    useStore.getState().setModelLoaded(false);
    expect(useStore.getState().healthCheckResult).toBeNull();
  });

  it('setModelLoaded(true) preserves an existing health result', () => {
    const result: HealthCheckResult = {
      total_issues: 1,
      by_severity: { error: 1, warning: 0, info: 0 },
      rules: [],
    };
    useStore.setState({ modelLoaded: false, healthCheckResult: result });
    useStore.getState().setModelLoaded(true);
    expect(useStore.getState().healthCheckResult).not.toBeNull();
  });
});

// ─── Pure helper functions ────────────────────────────────────────────────────

describe('severityBadge', () => {
  it('returns ✕ for error', () => {
    expect(severityBadge('error')).toBe('✕');
  });
  it('returns ⚠ for warning', () => {
    expect(severityBadge('warning')).toBe('⚠');
  });
  it('returns ℹ for info', () => {
    expect(severityBadge('info')).toBe('ℹ');
  });
});

describe('severityClass', () => {
  it('maps error to error class', () => {
    expect(severityClass('error')).toContain('error');
  });
  it('maps warning to warning class', () => {
    expect(severityClass('warning')).toContain('warning');
  });
  it('maps info to info class', () => {
    expect(severityClass('info')).toContain('info');
  });
});

describe('totalsBySeverity', () => {
  function makeRule(sev: 'error' | 'warning' | 'info', count: number): HealthRuleResult {
    return { rule_id: 'r', severity: sev, description: '', count, issues: [] };
  }

  it('returns zero totals for empty rules', () => {
    const totals = totalsBySeverity([]);
    expect(totals).toEqual({ error: 0, warning: 0, info: 0 });
  });

  it('sums counts by severity', () => {
    const rules = [
      makeRule('error', 2),
      makeRule('error', 3),
      makeRule('warning', 5),
      makeRule('info', 1),
    ];
    const totals = totalsBySeverity(rules);
    expect(totals.error).toBe(5);
    expect(totals.warning).toBe(5);
    expect(totals.info).toBe(1);
  });

  it('handles rules with zero count', () => {
    const rules = [makeRule('error', 0), makeRule('warning', 0)];
    const totals = totalsBySeverity(rules);
    expect(totals.error).toBe(0);
    expect(totals.warning).toBe(0);
  });
});

describe('ruleLabel', () => {
  it('converts underscores to spaces', () => {
    expect(ruleLabel('missing_global_id')).not.toContain('_');
  });
  it('title-cases the label', () => {
    const label = ruleLabel('missing_global_id');
    expect(label[0]).toBe(label[0].toUpperCase());
  });
  it('handles single-word rule IDs', () => {
    expect(ruleLabel('health')).toBe('Health');
  });
});
