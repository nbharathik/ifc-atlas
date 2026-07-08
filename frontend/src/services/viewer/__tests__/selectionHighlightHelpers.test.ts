import { describe, it, expect } from 'vitest';
import {
  SELECTION_HIGHLIGHT_HEX,
  SELECTION_HIGHLIGHT_OPACITY,
  SELECTION_HIGHLIGHT_MATERIAL_SPEC,
  getSelectionHighlightColor,
  computeAmberIds,
  decideSelectionWork,
  countSelectionChurn,
} from '../selectionHighlightHelpers';

describe('SELECTION_HIGHLIGHT_MATERIAL_SPEC', () => {
  it('pins the amber hue + 1.0 opacity + opaque contract', () => {
    expect(SELECTION_HIGHLIGHT_HEX).toBe(0xf59e0b);
    expect(SELECTION_HIGHLIGHT_OPACITY).toBe(1.0);
    expect(SELECTION_HIGHLIGHT_MATERIAL_SPEC.hex).toBe(0xf59e0b);
    expect(SELECTION_HIGHLIGHT_MATERIAL_SPEC.opacity).toBe(1.0);
    expect(SELECTION_HIGHLIGHT_MATERIAL_SPEC.transparent).toBe(false);
  });

  it('is frozen so a downstream consumer cannot mutate the singleton', () => {
    expect(Object.isFrozen(SELECTION_HIGHLIGHT_MATERIAL_SPEC)).toBe(true);
  });

  it('uses a different hue from the hover highlight (visual disambiguation)', () => {
    // Hover hex is `0xfbbf24` (see hoverHighlightHelpers.ts). Audit
    // contract: a preview tint and a selected tint must never collide.
    expect(SELECTION_HIGHLIGHT_HEX).not.toBe(0xfbbf24);
  });
});

describe('getSelectionHighlightColor', () => {
  it('returns referentially identical THREE.Color across many calls', () => {
    const a = getSelectionHighlightColor();
    const b = getSelectionHighlightColor();
    const c = getSelectionHighlightColor();
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('returns a THREE.Color matching SELECTION_HIGHLIGHT_HEX', () => {
    const colour = getSelectionHighlightColor();
    expect(colour.getHex()).toBe(SELECTION_HIGHLIGHT_HEX);
  });
});

describe('computeAmberIds', () => {
  it('returns selectedIds when non-empty (multi-select wins)', () => {
    expect(computeAmberIds(null, [1, 2, 3])).toEqual([1, 2, 3]);
    expect(computeAmberIds(99, [1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('falls back to [selectedElementId] when selectedIds is empty', () => {
    expect(computeAmberIds(42, [])).toEqual([42]);
  });

  it('returns [] when both are empty / null', () => {
    expect(computeAmberIds(null, [])).toEqual([]);
  });

  it('treats 0 as a real express ID (not coerced to empty)', () => {
    expect(computeAmberIds(0, [])).toEqual([0]);
    expect(computeAmberIds(null, [0])).toEqual([0]);
  });

  it('returns a copy of selectedIds (caller cannot mutate the store array)', () => {
    const input = [1, 2, 3];
    const out = computeAmberIds(null, input);
    out.push(99);
    expect(input).toEqual([1, 2, 3]);
  });
});

describe('decideSelectionWork', () => {
  it('skips when both sides are empty', () => {
    expect(decideSelectionWork([], []).skip).toBe(true);
  });

  it('skips when both sides have the same single id', () => {
    expect(decideSelectionWork([7], [7]).skip).toBe(true);
  });

  it('skips when both sides have the same id set regardless of order', () => {
    expect(decideSelectionWork([1, 2, 3], [3, 1, 2]).skip).toBe(true);
    expect(decideSelectionWork([1, 2, 3], [2, 3, 1]).skip).toBe(true);
  });

  it('does not skip when one id changed', () => {
    expect(decideSelectionWork([1, 2, 3], [1, 2, 4]).skip).toBe(false);
  });

  it('does not skip when size changes (subset / superset)', () => {
    expect(decideSelectionWork([1, 2], [1, 2, 3]).skip).toBe(false);
    expect(decideSelectionWork([1, 2, 3], [1, 2]).skip).toBe(false);
  });

  it('does not skip when transitioning to/from empty', () => {
    expect(decideSelectionWork([], [7]).skip).toBe(false);
    expect(decideSelectionWork([7], []).skip).toBe(false);
  });

  it('exposes both prev and next as Set views (dedup of repeated inputs)', () => {
    const decision = decideSelectionWork([1, 1, 2], [2, 1]);
    expect(decision.skip).toBe(true);
    expect(decision.prevIds.size).toBe(2);
    expect(decision.nextIds.size).toBe(2);
  });
});

describe('countSelectionChurn - rebuild churn guard', () => {
  it('stationary selection (100 identical ticks) produces 1 highlight + 99 skips', () => {
    const stream = Array(100).fill([42]);
    const counts = countSelectionChurn(stream);
    expect(counts.highlightCalls).toBe(1);
    expect(counts.skippedTicks).toBe(99);
    expect(counts.emptyTicks).toBe(0);
  });

  it('selection swap A → B → A → B produces 4 highlight calls', () => {
    const counts = countSelectionChurn([[1], [2], [1], [2]]);
    expect(counts.highlightCalls).toBe(4);
    expect(counts.skippedTicks).toBe(0);
  });

  it('select → deselect → select-same produces 2 highlights + 1 empty', () => {
    const counts = countSelectionChurn([[7], [], [7]]);
    expect(counts.highlightCalls).toBe(2);
    expect(counts.emptyTicks).toBe(1);
    expect(counts.skippedTicks).toBe(0);
  });

  it('reorder-only stream is fully deduped (audit contract: set equality)', () => {
    // Simulates the multi-store-subscription firing twice for the same
    // selection: once via `selectedElementId`, once via `selectedIds`,
    // but with the IDs in different order. The decision helper
    // dedups by set equality, so only the FIRST tick triggers work.
    const counts = countSelectionChurn([
      [1, 2, 3],
      [3, 2, 1],
      [2, 1, 3],
      [1, 3, 2],
    ]);
    expect(counts.highlightCalls).toBe(1);
    expect(counts.skippedTicks).toBe(3);
  });

  it('keeps the colour allocation at 1 across a 500-tick stream (singleton guarantee)', () => {
    const stream: number[][] = [];
    for (let i = 0; i < 500; i++) {
      stream.push(i % 5 === 0 ? [] : [i % 17]);
    }
    const counts = countSelectionChurn(stream, getSelectionHighlightColor);
    expect(counts.highlightCalls).toBeGreaterThan(0);
    expect(counts.materialAllocations).toBe(1);
  });
});
