import { describe, expect, it } from 'vitest';
import { applyGhostPostproductionState } from '../ghostPostproductionController';

describe('applyGhostPostproductionState', () => {
  it('disables postproduction and xray when ghost mode is off', () => {
    const pp = { enabled: true, edgesPass: { xray: true, mode: 'quality' } };

    const snapshot = applyGhostPostproductionState(pp, {
      ghostModeOn: false,
      navigating: false,
      fastEdgeMode: 'fast',
    });

    expect(snapshot).toEqual({ enabled: false, xray: false, mode: 'quality' });
    expect(pp.enabled).toBe(false);
    expect(pp.edgesPass.xray).toBe(false);
  });

  it('uses fast edge mode and disables postproduction while navigating', () => {
    const pp = { enabled: true, edgesPass: { xray: false, mode: 'quality' } };

    const snapshot = applyGhostPostproductionState(pp, {
      ghostModeOn: true,
      navigating: true,
      fastEdgeMode: 'fast',
    });

    expect(snapshot).toEqual({ enabled: false, xray: true, mode: 'fast' });
    expect(pp.enabled).toBe(false);
    expect(pp.edgesPass.xray).toBe(true);
    expect(pp.edgesPass.mode).toBe('fast');
  });

  it('keeps the composer disabled at rest (edges never render in the COLOR style chain)', () => {
    const pp = { enabled: false, edgesPass: { xray: true, mode: 'fast' } };

    const snapshot = applyGhostPostproductionState(pp, {
      ghostModeOn: true,
      navigating: false,
      fastEdgeMode: 'fast',
    });

    // Enabling the composer paid a second full scene pass for output
    // identical to the plain render (the edges pass is only in PEN-family
    // style chains, which the app never sets). Edge state is still staged
    // for a future PEN-style edges feature.
    expect(snapshot).toEqual({ enabled: false, xray: true, mode: 'fast' });
    expect(pp.enabled).toBe(false);
    expect(pp.edgesPass.xray).toBe(true);
  });

  it('turns the composer off when ghost mode was on and pp was somehow enabled', () => {
    const pp = { enabled: true, edgesPass: { xray: false, mode: 'quality' } };

    const snapshot = applyGhostPostproductionState(pp, {
      ghostModeOn: true,
      navigating: false,
      fastEdgeMode: 'fast',
    });

    expect(snapshot?.enabled).toBe(false);
    expect(pp.enabled).toBe(false);
  });
});
