import { useCallback, useEffect, useState } from 'react';
import { runModelHealthCheck } from '../../services/api';
import { useStore } from '../../store/useStore';
import type { HealthRuleResult } from '../../store/useStore';
import {
  severityBadge,
  severityClass,
  totalsBySeverity,
  ruleLabel,
  overallSeverity,
  exportHealthReportMarkdown,
} from '../../services/viewer/healthHelpers';

// Re-export pure helpers so the existing test file can keep importing them here.
export { severityBadge, severityClass, totalsBySeverity, ruleLabel };

// ─── RuleRow ──────────────────────────────────────────────────────────────────

interface RuleRowProps {
  rule: HealthRuleResult;
  onHighlight: (ids: number[]) => void;
}

function RuleRow({ rule, onHighlight }: RuleRowProps) {
  const [expanded, setExpanded] = useState(false);

  const ids = rule.issues
    .map((i) => i.element_id)
    .filter((id): id is number => id != null);

  const canExpand = rule.count > 0 && rule.issues.length > 0;
  const canHighlight = rule.count > 0 && ids.length > 0;

  return (
    <div className={`health-rule health-rule--${rule.severity}`}>
      <div className="health-rule-header-row">
        <button
          className="health-rule-header"
          onClick={() => canExpand && setExpanded((e) => !e)}
          aria-expanded={canExpand ? expanded : undefined}
          disabled={!canExpand}
        >
          <span className={`health-sev-badge ${severityClass(rule.severity)}`}>
            {severityBadge(rule.severity)}
          </span>
          <span className="health-rule-label">{ruleLabel(rule.rule_id)}</span>
          <span className="health-rule-count">{rule.count}</span>
          {canExpand && (
            <span className="health-rule-chevron">{expanded ? '▾' : '▸'}</span>
          )}
        </button>

        {canHighlight && (
          <button
            className="health-highlight-btn"
            title={`Highlight ${ids.length} element${ids.length !== 1 ? 's' : ''}`}
            aria-label={`Highlight ${ids.length} element${ids.length !== 1 ? 's' : ''}`}
            onClick={() => onHighlight(ids)}
          >
            ◎
          </button>
        )}
      </div>

      <p className="health-rule-desc">{rule.description}</p>

      {expanded && rule.issues.length > 0 && (
        <ul className="health-issues-list" aria-label="Issues">
          {rule.issues.map((issue, idx) => (
            <li key={idx} className="health-issue-row">
              <span className="health-issue-name">
                {issue.element_name || <em>unnamed</em>}
              </span>
              <span className="health-issue-msg">{issue.message}</span>
              {issue.element_id != null && (
                <button
                  className="health-issue-pick"
                  title="Highlight this element"
                  aria-label="Highlight element"
                  onClick={() => onHighlight([issue.element_id as number])}
                >
                  ◎
                </button>
              )}
            </li>
          ))}
          {rule.count > rule.issues.length && (
            <li className="health-issue-overflow">
              +{rule.count - rule.issues.length} more…
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

// ─── Panel ────────────────────────────────────────────────────────────────────

export default function ModelHealthPanel({ embedded = false }: { embedded?: boolean } = {}) {
  const healthCheckResult = useStore((s) => s.healthCheckResult);
  const setHealthCheckResult = useStore((s) => s.setHealthCheckResult);
  const setHealthPanelOpen = useStore((s) => s.setHealthPanelOpen);
  const setHighlightedIds = useStore((s) => s.setHighlightedIds);
  const modelLoaded = useStore((s) => s.modelLoaded);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // ESC dismisses the panel, matching every other floating overlay (the panel
  // is only mounted while open, so no open-guard is needed here).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Don't swallow Esc meant for an overlay layered above the Tools tab.
      if (useStore.getState().commandPaletteOpen || useStore.getState().settingsOpen) return;
      e.stopPropagation();
      setHealthPanelOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [setHealthPanelOpen]);

  const handleRun = useCallback(async () => {
    if (!modelLoaded) return;
    setLoading(true);
    setError(null);
    try {
      const result = await runModelHealthCheck(50);
      setHealthCheckResult(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Health check failed');
    } finally {
      setLoading(false);
    }
  }, [modelLoaded, setHealthCheckResult]);

  const handleHighlight = useCallback(
    (ids: number[]) => {
      setHighlightedIds(ids);
    },
    [setHighlightedIds],
  );

  const handleExport = useCallback(async () => {
    if (!healthCheckResult) return;
    const md = exportHealthReportMarkdown(healthCheckResult.rules);
    try {
      await navigator.clipboard.writeText(md);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard not available (e.g. HTTP context), fall back to console
      console.info('[Health] Report:\n', md);
    }
  }, [healthCheckResult]);

  const result = healthCheckResult;
  const totals = result ? totalsBySeverity(result.rules) : null;
  const status = result ? overallSeverity(result.rules) : null;

  return (
    <div className="health-panel" role="region" aria-label="Model Health Check">
      <div className="health-panel-header">
        <span className="health-panel-title">
          {!embedded && 'Model Health'}
          {status && (
            <span className={`health-panel-status health-panel-status--${status}`}>
              {status === 'ok' ? '✓' : severityBadge(status as 'error' | 'warning' | 'info')}
            </span>
          )}
        </span>
        <div className="health-panel-actions">
          {result && (
            <button
              className="health-export-btn"
              onClick={handleExport}
              title="Copy report as Markdown"
              aria-label="Copy health report as Markdown"
            >
              {copied ? '✓' : '⎘'}
            </button>
          )}
          <button
            className="health-run-btn"
            onClick={handleRun}
            disabled={loading || !modelLoaded}
            title={modelLoaded ? 'Run quality check' : 'Load a model first'}
            aria-label="Run health check"
          >
            {loading ? '…' : '↻ Run'}
          </button>
          {!embedded && (
            <button
              className="health-close-btn"
              onClick={() => setHealthPanelOpen(false)}
              aria-label="Close health panel"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {error && <p className="health-error" role="alert">{error}</p>}

      {result && totals && (
        <>
          <div className="health-summary-row" aria-label="Summary">
            {totals.error > 0 && (
              <span className="health-summary-badge health-summary-badge--error">
                {severityBadge('error')} {totals.error} error{totals.error !== 1 ? 's' : ''}
              </span>
            )}
            {totals.warning > 0 && (
              <span className="health-summary-badge health-summary-badge--warning">
                {severityBadge('warning')} {totals.warning} warning{totals.warning !== 1 ? 's' : ''}
              </span>
            )}
            {totals.info > 0 && (
              <span className="health-summary-badge health-summary-badge--info">
                {severityBadge('info')} {totals.info}
              </span>
            )}
            {result.total_issues === 0 && (
              <span className="health-summary-badge health-summary-badge--ok">✓ No issues</span>
            )}
            {result.duration_ms !== undefined && (
              <span className="health-duration">{result.duration_ms} ms</span>
            )}
          </div>

          <div className="health-rules-list">
            {result.rules.map((rule) => (
              <RuleRow key={rule.rule_id} rule={rule} onHighlight={handleHighlight} />
            ))}
          </div>
        </>
      )}

      {!result && !loading && !error && (
        <p className="health-empty">
          {modelLoaded
            ? 'Click ↻ Run to scan the loaded model for quality issues.'
            : 'Load an IFC model first, then run the health check.'}
        </p>
      )}
    </div>
  );
}
