/**
 * Tests for ElementFilterPanel pure helpers + store slice.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  OPERATORS,
  isNumericOperator,
  validateFilterForm,
  formatOperatorLabel,
} from '../../components/panels/ElementFilterPanel';
import { useStore } from '../useStore';

// ─── Pure helper tests ────────────────────────────────────────────────────────

describe('isNumericOperator', () => {
  it('returns true for gt, lt, gte, lte', () => {
    expect(isNumericOperator('gt')).toBe(true);
    expect(isNumericOperator('lt')).toBe(true);
    expect(isNumericOperator('gte')).toBe(true);
    expect(isNumericOperator('lte')).toBe(true);
  });

  it('returns false for string operators', () => {
    expect(isNumericOperator('eq')).toBe(false);
    expect(isNumericOperator('neq')).toBe(false);
    expect(isNumericOperator('contains')).toBe(false);
    expect(isNumericOperator('startswith')).toBe(false);
  });
});

describe('validateFilterForm', () => {
  it('returns null when all fields are valid (string op)', () => {
    expect(validateFilterForm('FireRating', 'eq', '2h')).toBeNull();
  });

  it('returns null for numeric op with numeric value', () => {
    expect(validateFilterForm('Area', 'gt', '20.5')).toBeNull();
  });

  it('errors when property name is empty', () => {
    const err = validateFilterForm('', 'eq', '2h');
    expect(err).toMatch(/property name/i);
  });

  it('errors when property name is whitespace only', () => {
    const err = validateFilterForm('   ', 'eq', '2h');
    expect(err).toMatch(/property name/i);
  });

  it('errors when value is empty', () => {
    const err = validateFilterForm('FireRating', 'eq', '');
    expect(err).toMatch(/value is required/i);
  });

  it('errors when numeric op gets non-numeric value', () => {
    const err = validateFilterForm('Area', 'gt', 'not-a-number');
    expect(err).toMatch(/numeric value/i);
  });

  it('is OK when numeric op gets 0', () => {
    expect(validateFilterForm('Area', 'gte', '0')).toBeNull();
  });

  it('is OK when numeric op gets negative number', () => {
    expect(validateFilterForm('Elevation', 'lt', '-3.5')).toBeNull();
  });
});

describe('OPERATORS list', () => {
  it('has 8 operators', () => {
    expect(OPERATORS).toHaveLength(8);
  });

  it('every operator has a non-empty value and label', () => {
    for (const op of OPERATORS) {
      expect(op.value).toBeTruthy();
      expect(op.label).toBeTruthy();
    }
  });

  it('contains eq, neq, contains, startswith, gt, lt, gte, lte', () => {
    const values = OPERATORS.map((o) => o.value);
    expect(values).toContain('eq');
    expect(values).toContain('neq');
    expect(values).toContain('contains');
    expect(values).toContain('startswith');
    expect(values).toContain('gt');
    expect(values).toContain('lt');
    expect(values).toContain('gte');
    expect(values).toContain('lte');
  });
});

describe('formatOperatorLabel', () => {
  it('returns the correct label for eq', () => {
    expect(formatOperatorLabel('eq')).toMatch(/equals/i);
  });

  it('returns the operator string itself for unknown op', () => {
    // @ts-expect-error testing unknown op
    expect(formatOperatorLabel('xyzzy')).toBe('xyzzy');
  });

  it('returns a string for every known operator', () => {
    for (const op of OPERATORS) {
      expect(typeof formatOperatorLabel(op.value)).toBe('string');
    }
  });
});

// ─── Store slice tests ────────────────────────────────────────────────────────

function reset() {
  useStore.setState({ filterPanelOpen: false, filterResultIds: [] });
}

describe('element filter store slice', () => {
  beforeEach(reset);

  it('defaults: filter panel closed, no result ids', () => {
    expect(useStore.getState().filterPanelOpen).toBe(false);
    expect(useStore.getState().filterResultIds).toEqual([]);
  });

  it('setFilterPanelOpen(true) opens the panel', () => {
    useStore.getState().setFilterPanelOpen(true);
    expect(useStore.getState().filterPanelOpen).toBe(true);
  });

  it('setFilterPanelOpen(false) closes the panel', () => {
    useStore.getState().setFilterPanelOpen(true);
    useStore.getState().setFilterPanelOpen(false);
    expect(useStore.getState().filterPanelOpen).toBe(false);
  });

  it('setFilterResultIds stores the ids', () => {
    useStore.getState().setFilterResultIds([10, 20, 30]);
    expect(useStore.getState().filterResultIds).toEqual([10, 20, 30]);
  });

  it('setFilterResultIds replaces previous result', () => {
    useStore.getState().setFilterResultIds([1, 2]);
    useStore.getState().setFilterResultIds([99]);
    expect(useStore.getState().filterResultIds).toEqual([99]);
  });

  it('filter panel is independent of budget panel', () => {
    useStore.getState().setFilterPanelOpen(true);
    useStore.getState().setBudgetPanelOpen(false);
    expect(useStore.getState().filterPanelOpen).toBe(true);
    expect(useStore.getState().budgetPanelOpen).toBe(false);
  });
});
