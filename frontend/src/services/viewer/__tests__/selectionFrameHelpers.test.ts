import { describe, it, expect } from 'vitest';
import { chooseFrameTargets } from '../selectionFrameHelpers';

describe('chooseFrameTargets', () => {
  it('returns [selectedId] when a single element is selected', () => {
    expect(chooseFrameTargets(42, [])).toEqual([42]);
  });

  it('prefers selectedId over highlightedIds when both are set', () => {
    expect(chooseFrameTargets(7, [1, 2, 3])).toEqual([7]);
  });

  it('returns the highlight list when no element is selected', () => {
    expect(chooseFrameTargets(null, [10, 20, 30])).toEqual([10, 20, 30]);
  });

  it('returns null when neither selection nor highlight is set', () => {
    expect(chooseFrameTargets(null, [])).toBeNull();
  });

  it('returns a fresh array (does not alias the highlight list)', () => {
    const highlights = [4, 5, 6];
    const result = chooseFrameTargets(null, highlights);
    expect(result).not.toBe(highlights);
    expect(result).toEqual([4, 5, 6]);
  });

  it('deduplicates highlight ids while preserving first-seen order', () => {
    expect(chooseFrameTargets(null, [1, 2, 1, 3, 2])).toEqual([1, 2, 3]);
  });

  it('drops non-finite ids from the highlight list', () => {
    expect(chooseFrameTargets(null, [1, Number.NaN, 2, Number.POSITIVE_INFINITY, 3])).toEqual([1, 2, 3]);
  });

  it('returns null if every highlight id is non-finite', () => {
    expect(chooseFrameTargets(null, [Number.NaN, Number.POSITIVE_INFINITY])).toBeNull();
  });

  it('rejects a non-finite selectedId and falls through to highlights', () => {
    expect(chooseFrameTargets(Number.NaN, [9])).toEqual([9]);
  });

  it('treats selectedId === 0 as a real selection (valid express IDs include 0 in some implementations)', () => {
    // Number.isFinite(0) === true; 0 is a valid distinct selection from null.
    expect(chooseFrameTargets(0, [1, 2])).toEqual([0]);
  });

  it('preserves negative ids verbatim (callers handle id validity downstream)', () => {
    // The helper does not enforce positive-only express IDs; downstream
    // `getMergedBox` will discard unknown ids. Tested so renames don't silently
    // change the contract.
    expect(chooseFrameTargets(null, [-1, 2])).toEqual([-1, 2]);
  });

  it('works with a readonly array (TypeScript-level contract)', () => {
    const frozen: ReadonlyArray<number> = Object.freeze([5, 6, 7]);
    expect(chooseFrameTargets(null, frozen)).toEqual([5, 6, 7]);
  });
});
