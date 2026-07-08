/**
 * Budget Dashboard Panel.
 *
 * Shows per-agent monthly spend, a usage bar, and a Reset button.
 * Accessible via Settings → Budget or the keyboard shortcut Shift+B.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getBudgetSummary, resetAgentBudget } from '../../services/api';
import type { BudgetAgentRow, BudgetSummary } from '../../services/api';
import { useStore } from '../../store/useStore';

import { statusColor, usedPercent } from './budgetDashboardHelpers';

// ─── BudgetBar ────────────────────────────────────────────────────────────────

interface BudgetBarProps {
  row: BudgetAgentRow;
  onReset: (agentId: string) => void;
  resetting: string | null;
}

function BudgetBar({ row, onReset, resetting }: BudgetBarProps) {
  const busy = resetting === row.agent_id;
  const pct = usedPercent(row);
  const color = statusColor(row.status);

  return (
    <div className="bdg-row">
      <div className="bdg-row-header">
        <span className="bdg-agent-label" title={row.agent_id}>{row.label}</span>
        <span className={`bdg-status-badge bdg-status-${row.status}`}>
          {row.status === 'over_cap' ? '⚠ Over' : row.status === 'near_cap' ? '⚡ Near' : '✓ OK'}
        </span>
      </div>

      <div className="bdg-spend-line">
        <span className="bdg-spent">${row.spent_usd.toFixed(4)}</span>
        {row.budget_usd !== null && (
          <span className="bdg-cap"> / ${row.budget_usd.toFixed(2)} cap</span>
        )}
        <button
          className="bdg-reset-btn"
          disabled={busy || row.spent_usd === 0}
          onClick={() => onReset(row.agent_id)}
          title={`Reset ${row.label}'s spend counter`}
        >
          {busy ? '…' : '↺ Reset'}
        </button>
      </div>

      {row.budget_usd !== null && (
        <div className="bdg-bar-track" title={`${pct.toFixed(1)}% used`}>
          <div
            className="bdg-bar-fill"
            style={{ width: `${pct}%`, background: color }}
          />
        </div>
      )}
    </div>
  );
}

// ─── BudgetDashboardPanel ─────────────────────────────────────────────────────

export function BudgetDashboardPanel() {
  const { budgetPanelOpen, setBudgetPanelOpen, addToast } = useStore();

  const [summary, setSummary] = useState<BudgetSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getBudgetSummary();
      setSummary(data);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (budgetPanelOpen) load();
  }, [budgetPanelOpen, load]);

  useEffect(() => {
    if (!budgetPanelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setBudgetPanelOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [budgetPanelOpen, setBudgetPanelOpen]);

  useEffect(() => {
    if (budgetPanelOpen) panelRef.current?.focus();
  }, [budgetPanelOpen]);

  const handleReset = useCallback(async (agentId: string) => {
    setResetting(agentId);
    try {
      const res = await resetAgentBudget(agentId);
      addToast(`Reset ${agentId} - was $${res.previous_spent_usd.toFixed(4)}`, 'success');
      await load();
    } catch (err) {
      addToast(`Reset failed: ${String(err)}`, 'error');
    } finally {
      setResetting(null);
    }
  }, [addToast, load]);

  if (!budgetPanelOpen) return null;

  const totalSpent = summary?.agents.reduce((s, a) => s + a.spent_usd, 0) ?? 0;

  return (
    <div className="bdg-overlay" role="dialog" aria-label="Budget Dashboard" aria-modal="true">
      <div className="bdg-panel" ref={panelRef} tabIndex={-1}>
        {/* Header */}
        <div className="bdg-header">
          <h2 className="bdg-title">Budget Dashboard</h2>
          <button
            className="bdg-close"
            onClick={() => setBudgetPanelOpen(false)}
            aria-label="Close (Escape)"
          >
            ✕
          </button>
        </div>

        {/* Sub-header */}
        <div className="bdg-subheader">
          {summary && (
            <span className="bdg-month">
              {summary.month} - total spend: <strong>${totalSpent.toFixed(4)}</strong>
            </span>
          )}
          <button className="bdg-refresh" onClick={load} disabled={loading} title="Refresh">
            ↺
          </button>
        </div>

        {/* Body */}
        <div className="bdg-body">
          {loading && <p className="bdg-empty">Loading…</p>}
          {error && <p className="bdg-empty bdg-empty--warn">Error: {error}</p>}

          {!loading && !error && summary && summary.agents.length === 0 && (
            <p className="bdg-empty">
              No agents with spend or budget caps this month.
              <br />
              <span className="bdg-hint-text">Set a budget cap via the Agent Editor (pencil icon in chat).</span>
            </p>
          )}

          {!loading && !error && summary && summary.agents.length > 0 && (
            <ul className="bdg-list">
              {summary.agents.map(row => (
                <li key={row.agent_id}>
                  <BudgetBar row={row} onReset={handleReset} resetting={resetting} />
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="bdg-footer">
          <span className="bdg-hint">Esc to close</span>
        </div>
      </div>
    </div>
  );
}
