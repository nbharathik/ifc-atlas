/**
 * Budget Dashboard math contract.
 *
 * Pins ``usedPercent`` clamping rules + ``statusColor`` palette + the
 * backend↔frontend consistency check. The backend's spend math is
 * pinned separately by ``test_budget_guardrails.py``.
 */
import { describe, it, expect } from 'vitest';
import {
  statusColor,
  usedPercent,
  verifyBudgetRowConsistency,
} from '../BudgetDashboardPanel';
import type { BudgetAgentRow } from '../../../services/api';

function row(
  partial: Partial<BudgetAgentRow> = {},
): BudgetAgentRow {
  return {
    agent_id: 'default',
    label: 'Default',
    spent_usd: 0,
    budget_usd: null,
    status: 'ok',
    ...partial,
  } as BudgetAgentRow;
}

// ---------------------------------------------------------------------------
// statusColor
// ---------------------------------------------------------------------------

describe('statusColor', () => {
  it('returns the over-cap colour for over_cap', () => {
    expect(statusColor('over_cap')).toMatch(/budget-over/);
  });

  it('returns the near-cap colour for near_cap', () => {
    expect(statusColor('near_cap')).toMatch(/budget-near/);
  });

  it('returns the ok colour for ok', () => {
    expect(statusColor('ok')).toMatch(/budget-ok/);
  });
});

// ---------------------------------------------------------------------------
// usedPercent
// ---------------------------------------------------------------------------

describe('usedPercent', () => {
  it('returns 0 when budget is null', () => {
    expect(usedPercent(row({ budget_usd: null, spent_usd: 10 }))).toBe(0);
  });

  it('returns 0 when budget is zero', () => {
    expect(usedPercent(row({ budget_usd: 0, spent_usd: 10 }))).toBe(0);
  });

  it('returns 0 when spend is zero', () => {
    expect(usedPercent(row({ budget_usd: 100, spent_usd: 0 }))).toBe(0);
  });

  it('returns 50 when spend is half of budget', () => {
    expect(usedPercent(row({ budget_usd: 100, spent_usd: 50 }))).toBe(50);
  });

  it('returns 80 at the near-cap threshold', () => {
    expect(usedPercent(row({ budget_usd: 100, spent_usd: 80 }))).toBe(80);
  });

  it('caps at 100 when spend exceeds budget', () => {
    expect(usedPercent(row({ budget_usd: 100, spent_usd: 150 }))).toBe(100);
  });

  it('clamps negative spend to 0 (defensive)', () => {
    expect(usedPercent(row({ budget_usd: 100, spent_usd: -5 }))).toBe(0);
  });

  it('handles tiny budget + tiny spend gracefully', () => {
    expect(usedPercent(row({ budget_usd: 0.01, spent_usd: 0.005 }))).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// verifyBudgetRowConsistency - backend↔frontend cross-check
// ---------------------------------------------------------------------------

describe('verifyBudgetRowConsistency', () => {
  it('returns null when row has no budget and status=ok', () => {
    expect(
      verifyBudgetRowConsistency(row({ budget_usd: null, status: 'ok' })),
    ).toBeNull();
  });

  it('detects no-budget-but-non-ok-status drift', () => {
    const msg = verifyBudgetRowConsistency(
      row({ budget_usd: null, status: 'near_cap' }),
    );
    expect(msg).toContain("expected 'ok'");
  });

  it('returns null for under-80% spend with status=ok', () => {
    expect(
      verifyBudgetRowConsistency(
        row({ budget_usd: 100, spent_usd: 50, status: 'ok' }),
      ),
    ).toBeNull();
  });

  it('returns null for 80-100% spend with status=near_cap', () => {
    expect(
      verifyBudgetRowConsistency(
        row({ budget_usd: 100, spent_usd: 85, status: 'near_cap' }),
      ),
    ).toBeNull();
  });

  it('returns null for >=100% spend with status=over_cap', () => {
    expect(
      verifyBudgetRowConsistency(
        row({ budget_usd: 100, spent_usd: 150, status: 'over_cap' }),
      ),
    ).toBeNull();
  });

  it('detects backend-says-ok-but-frontend-would-say-near-cap drift', () => {
    // Spend = 85 / budget 100 → 85% → frontend says near_cap, but backend
    // reports ok. This would indicate the backend _NEAR_CAP_RATIO changed.
    const msg = verifyBudgetRowConsistency(
      row({ budget_usd: 100, spent_usd: 85, status: 'ok' }),
    );
    expect(msg).toContain('expected near_cap');
  });

  it('detects backend-says-near-cap-but-frontend-would-say-over-cap drift', () => {
    // Spend = 100 / budget 100 → 100% → frontend says over_cap.
    const msg = verifyBudgetRowConsistency(
      row({ budget_usd: 100, spent_usd: 100, status: 'near_cap' }),
    );
    expect(msg).toContain('expected over_cap');
  });
});
