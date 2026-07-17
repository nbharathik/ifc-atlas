import { describe, expect, it } from 'vitest';
import { nextHorizontalTabIndex } from '../tabKeyboardNavigation';

describe('nextHorizontalTabIndex', () => {
  it('moves and wraps with horizontal arrow keys', () => {
    expect(nextHorizontalTabIndex(1, 4, 'ArrowRight')).toBe(2);
    expect(nextHorizontalTabIndex(3, 4, 'ArrowRight')).toBe(0);
    expect(nextHorizontalTabIndex(0, 4, 'ArrowLeft')).toBe(3);
  });

  it('supports Home and End', () => {
    expect(nextHorizontalTabIndex(2, 4, 'Home')).toBe(0);
    expect(nextHorizontalTabIndex(1, 4, 'End')).toBe(3);
  });

  it('ignores unrelated keys and invalid lists', () => {
    expect(nextHorizontalTabIndex(1, 4, 'Enter')).toBeNull();
    expect(nextHorizontalTabIndex(-1, 4, 'ArrowRight')).toBeNull();
    expect(nextHorizontalTabIndex(0, 0, 'ArrowRight')).toBeNull();
  });
});
