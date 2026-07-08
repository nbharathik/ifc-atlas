/**
 * Vitest for the LOD navigation swap controller.
 * State machine: show the decimated (lod) model during sustained motion, the
 * full model at rest, gated by enabled + both targets present.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LodSwapController } from '../lodSwap';

type Obj = { visible: boolean };

function make(): { c: LodSwapController; full: Obj; lod: Obj } {
  const full: Obj = { visible: true };
  const lod: Obj = { visible: true };
  const c = new LodSwapController();
  c.setTargets(full as never, lod as never);
  return { c, full, lod };
}

describe('LodSwapController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts with full visible, lod hidden (disabled)', () => {
    const { full, lod } = make();
    expect(full.visible).toBe(true);
    expect(lod.visible).toBe(false);
  });

  it('is not active until enabled AND both targets present', () => {
    const c = new LodSwapController();
    c.setEnabled(true);
    expect(c.active).toBe(false); // no targets
    const full: Obj = { visible: true };
    c.setTargets(full as never, null);
    expect(c.active).toBe(false); // no lod
  });

  it('shows the lod after sustained motion, full at rest', () => {
    const { c, full, lod } = make();
    c.setEnabled(true);
    c.onNavigate();
    // Before the sustain threshold nothing swaps (no flicker on clicks).
    vi.advanceTimersByTime(50);
    expect(full.visible).toBe(true);
    expect(lod.visible).toBe(false);
    // After the threshold the decimated model takes over.
    vi.advanceTimersByTime(60);
    expect(full.visible).toBe(false);
    expect(lod.visible).toBe(true);
    // Rest snaps back to full after its short delay.
    c.onRest();
    vi.advanceTimersByTime(100);
    expect(full.visible).toBe(true);
    expect(lod.visible).toBe(false);
  });

  it('a quick nav then rest before the threshold never swaps', () => {
    const { c, full, lod } = make();
    c.setEnabled(true);
    c.onNavigate();
    vi.advanceTimersByTime(30);
    c.onRest();
    vi.advanceTimersByTime(200);
    expect(full.visible).toBe(true);
    expect(lod.visible).toBe(false);
  });

  it('disabling mid-motion snaps back to full immediately', () => {
    const { c, full, lod } = make();
    c.setEnabled(true);
    c.onNavigate();
    vi.advanceTimersByTime(120);
    expect(lod.visible).toBe(true);
    c.setEnabled(false);
    expect(full.visible).toBe(true);
    expect(lod.visible).toBe(false);
  });

  it('does nothing while disabled', () => {
    const { c, full, lod } = make();
    c.onNavigate();
    vi.advanceTimersByTime(200);
    expect(full.visible).toBe(true);
    expect(lod.visible).toBe(false);
  });

  it('dispose leaves the full model visible', () => {
    const { c, full, lod } = make();
    c.setEnabled(true);
    c.onNavigate();
    vi.advanceTimersByTime(120);
    c.dispose();
    expect(full.visible).toBe(true);
    expect(lod.visible).toBe(false);
  });
});

describe('LodSwapController watchdog', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('restores the full model when nav signals stop without a rest event', () => {
    const { c, full, lod } = make();
    c.setEnabled(true);
    c.onNavigate();
    vi.advanceTimersByTime(120); // LOD showing
    expect(lod.visible).toBe(true);
    // No further onNavigate signals and NO onRest: the watchdog restores.
    vi.advanceTimersByTime(800);
    expect(full.visible).toBe(true);
    expect(lod.visible).toBe(false);
  });

  it('continuous nav signals keep the LOD showing past the hold timeout', () => {
    const { c, full, lod } = make();
    c.setEnabled(true);
    c.onNavigate();
    vi.advanceTimersByTime(120);
    expect(lod.visible).toBe(true);
    // Simulate frame-rate update signals for 2s: watchdog keeps refreshing.
    for (let i = 0; i < 40; i++) {
      c.onNavigate();
      vi.advanceTimersByTime(50);
    }
    expect(lod.visible).toBe(true);
    expect(full.visible).toBe(false);
  });
});
