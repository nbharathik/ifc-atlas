import { describe, it, expect } from 'vitest';
import {
  HOVER_HIGHLIGHT_HEX,
  HOVER_HIGHLIGHT_OPACITY,
  HOVER_HIGHLIGHT_MATERIAL_SPEC,
  getHoverHighlightColor,
  decideHoverWork,
  countHoverChurn,
} from '../hoverHighlightHelpers';

describe('HOVER_HIGHLIGHT_MATERIAL_SPEC', () => {
  it('pins the amber hue + 0.45 opacity + transparent contract', () => {
    expect(HOVER_HIGHLIGHT_HEX).toBe(0xfbbf24);
    expect(HOVER_HIGHLIGHT_OPACITY).toBe(0.45);
    expect(HOVER_HIGHLIGHT_MATERIAL_SPEC.hex).toBe(0xfbbf24);
    expect(HOVER_HIGHLIGHT_MATERIAL_SPEC.opacity).toBe(0.45);
    expect(HOVER_HIGHLIGHT_MATERIAL_SPEC.transparent).toBe(true);
  });

  it('is frozen so a downstream consumer cannot mutate the singleton', () => {
    expect(Object.isFrozen(HOVER_HIGHLIGHT_MATERIAL_SPEC)).toBe(true);
  });
});

describe('getHoverHighlightColor', () => {
  it('returns referentially identical THREE.Color across many calls', () => {
    const a = getHoverHighlightColor();
    const b = getHoverHighlightColor();
    const c = getHoverHighlightColor();
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('returns a THREE.Color matching HOVER_HIGHLIGHT_HEX', () => {
    const colour = getHoverHighlightColor();
    expect(colour.getHex()).toBe(HOVER_HIGHLIGHT_HEX);
  });
});

describe('decideHoverWork', () => {
  it('skips when new === prev for any pair', () => {
    expect(decideHoverWork(null, null)).toEqual({ skip: true, toReset: null, toHighlight: null });
    expect(decideHoverWork(42, 42)).toEqual({ skip: true, toReset: null, toHighlight: null });
    expect(decideHoverWork(0, 0)).toEqual({ skip: true, toReset: null, toHighlight: null });
  });

  it('void → element schedules only a highlight (no reset)', () => {
    expect(decideHoverWork(null, 7)).toEqual({
      skip: false,
      toReset: null,
      toHighlight: 7,
    });
  });

  it('element → void schedules only a reset (no highlight)', () => {
    expect(decideHoverWork(7, null)).toEqual({
      skip: false,
      toReset: 7,
      toHighlight: null,
    });
  });

  it('element → different element schedules both reset and highlight', () => {
    expect(decideHoverWork(7, 11)).toEqual({
      skip: false,
      toReset: 7,
      toHighlight: 11,
    });
  });

  it('treats 0 as a real element id (not falsy)', () => {
    expect(decideHoverWork(null, 0)).toEqual({
      skip: false,
      toReset: null,
      toHighlight: 0,
    });
    expect(decideHoverWork(0, null)).toEqual({
      skip: false,
      toReset: 0,
      toHighlight: null,
    });
    expect(decideHoverWork(0, 0)).toEqual({ skip: true, toReset: null, toHighlight: null });
  });
});

describe('countHoverChurn - material allocation guard', () => {
  it('stationary hover over the same element produces 1 highlight + N-1 skipped ticks', () => {
    // 100 pointermove ticks all over the same element. The audit
    // contract: only the first tick triggers a highlight call; the
    // remaining 99 are deduped by `decideHoverWork`.
    const stream = Array(100).fill(42);
    const counts = countHoverChurn(stream);
    expect(counts.highlightCalls).toBe(1);
    expect(counts.resetCalls).toBe(0);
    expect(counts.skippedTicks).toBe(99);
  });

  it('stationary hover over void produces zero highlight + zero reset', () => {
    const stream = Array(50).fill(null);
    const counts = countHoverChurn(stream);
    expect(counts.highlightCalls).toBe(0);
    expect(counts.resetCalls).toBe(0);
    expect(counts.skippedTicks).toBe(50);
  });

  it('sweep across 5 elements, 10 ticks each, produces exactly 5 highlights + 4 resets', () => {
    const stream: (number | null)[] = [];
    for (const id of [1, 2, 3, 4, 5]) {
      for (let i = 0; i < 10; i++) stream.push(id);
    }
    const counts = countHoverChurn(stream);
    expect(counts.highlightCalls).toBe(5);
    // First element: no prior highlight to clear. Subsequent 4 transitions
    // each clear the prior element's highlight.
    expect(counts.resetCalls).toBe(4);
    expect(counts.skippedTicks).toBe(45);
  });

  it('element → void → element (same) produces 2 highlights + 1 reset', () => {
    const counts = countHoverChurn([7, 7, null, null, 7, 7]);
    expect(counts.highlightCalls).toBe(2);
    expect(counts.resetCalls).toBe(1);
    expect(counts.skippedTicks).toBe(3);
  });

  it('keeps the colour allocation at 1 across a 1000-tick stream (singleton guarantee)', () => {
    // The audit's headline guarantee: the THREE.Color is allocated
    // exactly once for the page lifetime, not per pointer event. A
    // regression that re-allocates per tick would push this count
    // toward the highlight-call count.
    const stream: (number | null)[] = [];
    for (let i = 0; i < 1000; i++) {
      stream.push(i % 7 === 0 ? null : (i % 13));
    }
    const counts = countHoverChurn(stream, getHoverHighlightColor);
    expect(counts.highlightCalls).toBeGreaterThan(0);
    expect(counts.materialAllocations).toBe(1);
  });
});
