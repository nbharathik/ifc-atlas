/**
 * Budget Dashboard math helpers.
 *
 * Extracted from BudgetDashboardPanel.tsx so the math is unit-testable
 * without spinning up React. The backend's ``check_budget`` already pins
 * the server-side ratio + status (test_budget_guardrails.py); this
 * module pins the corresponding *frontend* rendering math so the chip
 * + usage bar can't silently regress.
 *
 * Budget thresholds match backend ``budget_tracker.py``:
 *   - >= 100% → 'over_cap' (red)
 *   - >= 80%  → 'near_cap' (amber)
 *   - else    → 'ok'       (green)
 */

import type { BudgetAgentRow } from '../../services/api';

/**
 * Return the CSS var the dashboard renders for a given status. The
 * mapping must stay in lock-step with backend ``STATUS_*`` constants.
 */
export function statusColor(status: BudgetAgentRow['status']): string {
  switch (status) {
    case 'over_cap':
      return 'var(--budget-over, #f87171)';
    case 'near_cap':
      return 'var(--budget-near, #f59e0b)';
    case 'ok':
    default:
      return 'var(--budget-ok, #4ade80)';
  }
}

/**
 * Percentage of monthly budget used, clamped to [0, 100].
 *
 * - Returns 0 when ``budget_usd`` is null / 0 (no budget set) so the
 *   bar isn't full at startup.
 * - Caps at 100 so an over-budget agent doesn't push the bar past the
 *   container's right edge.
 * - Negative ``spent_usd`` (defensive, should never happen) clamps to 0.
 */
export function usedPercent(row: BudgetAgentRow): number {
  if (!row.budget_usd || row.budget_usd <= 0) return 0;
  if (row.spent_usd <= 0) return 0;
  return Math.min(100, (row.spent_usd / row.budget_usd) * 100);
}

/**
 * Verify backend status flag matches the frontend percent.
 *
 * Returns a description of any mismatch between backend ``row.status``
 * and what the frontend would infer from ``usedPercent(row)``. ``null``
 * if they agree.
 *
 * Used by the budget verification flow: drive 3 chat turns, then call
 * this for each row. Mismatches indicate the backend ratio threshold
 * has drifted from the frontend's, e.g. someone changed
 * ``_NEAR_CAP_RATIO`` without updating the dashboard.
 */
export function verifyBudgetRowConsistency(row: BudgetAgentRow): string | null {
  if (!row.budget_usd || row.budget_usd <= 0) {
    if (row.status !== 'ok') {
      return `Agent ${row.agent_id}: no budget set but status=${row.status} (expected 'ok')`;
    }
    return null;
  }
  const pct = usedPercent(row);
  // Reproduce the backend thresholds in JS so we can sanity-check.
  let expected: BudgetAgentRow['status'];
  if (pct >= 100) expected = 'over_cap';
  else if (pct >= 80) expected = 'near_cap';
  else expected = 'ok';
  if (row.status !== expected) {
    return (
      `Agent ${row.agent_id}: pct=${pct.toFixed(1)}% backend status=${row.status} ` +
      `but frontend expected ${expected}`
    );
  }
  return null;
}
