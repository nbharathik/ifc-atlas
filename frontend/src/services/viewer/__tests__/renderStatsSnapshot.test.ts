import { beforeEach, describe, expect, it } from 'vitest';
import {
  getMainPassStats,
  isMainPassFresh,
  recordMainPass,
  resetMainPassStats,
} from '../renderStatsSnapshot';

describe('renderStatsSnapshot', () => {
  beforeEach(() => {
    resetMainPassStats();
  });

  it('starts empty: no frame recorded, never fresh', () => {
    const snap = getMainPassStats();
    expect(snap.frame).toBe(0);
    expect(snap.drawCalls).toBe(0);
    expect(snap.triangles).toBe(0);
    expect(isMainPassFresh(1000, 60000)).toBe(false);
  });

  it('records main-pass counts with the overlay subtracted', () => {
    // 131 total calls with a 9-call / 72-tri gizmo overlay = 122 main calls
    // (the BasicHouse shape of the original bug).
    recordMainPass(131, 582135, 9, 72, 500);
    const snap = getMainPassStats();
    expect(snap.frame).toBe(1);
    expect(snap.drawCalls).toBe(122);
    expect(snap.triangles).toBe(582063);
    expect(snap.recordedAt).toBe(500);
  });

  it('overwrites in place on subsequent frames and counts them', () => {
    const snap = getMainPassStats();
    recordMainPass(131, 582135, 9, 72, 500);
    recordMainPass(140, 600000, 9, 72, 516);
    // Same object rewritten each frame - the consumer contract that makes
    // the recorder zero-allocation.
    expect(getMainPassStats()).toBe(snap);
    expect(snap.frame).toBe(2);
    expect(snap.drawCalls).toBe(131);
    expect(snap.triangles).toBe(599928);
    expect(snap.recordedAt).toBe(516);
  });

  it('clamps negative results to zero instead of trusting bad accounting', () => {
    // Overlay larger than the total means a reset raced the capture.
    recordMainPass(5, 40, 9, 72, 100);
    const snap = getMainPassStats();
    expect(snap.drawCalls).toBe(0);
    expect(snap.triangles).toBe(0);
  });

  it('freshness is an inclusive age window from the last record', () => {
    recordMainPass(131, 582135, 9, 72, 1000);
    expect(isMainPassFresh(1000, 2000)).toBe(true);
    expect(isMainPassFresh(3000, 2000)).toBe(true); // exactly at the limit
    expect(isMainPassFresh(3001, 2000)).toBe(false);
  });

  it('reset clears the data and the freshness', () => {
    recordMainPass(131, 582135, 9, 72, 1000);
    resetMainPassStats();
    const snap = getMainPassStats();
    expect(snap.frame).toBe(0);
    expect(snap.drawCalls).toBe(0);
    expect(snap.triangles).toBe(0);
    expect(isMainPassFresh(1001, 60000)).toBe(false);
  });
});
