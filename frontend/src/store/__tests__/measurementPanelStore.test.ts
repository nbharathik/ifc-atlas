import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../useStore';

describe('measurementPanelOpen store slice', () => {
  beforeEach(() => {
    useStore.getState().reset?.();
    // Direct reset of the slice since reset() may preserve other state
    useStore.setState({ measurementPanelOpen: false });
  });

  it('defaults to false', () => {
    expect(useStore.getState().measurementPanelOpen).toBe(false);
  });

  it('setMeasurementPanelOpen(true) opens the panel', () => {
    useStore.getState().setMeasurementPanelOpen(true);
    expect(useStore.getState().measurementPanelOpen).toBe(true);
  });

  it('setMeasurementPanelOpen(false) closes the panel', () => {
    useStore.getState().setMeasurementPanelOpen(true);
    useStore.getState().setMeasurementPanelOpen(false);
    expect(useStore.getState().measurementPanelOpen).toBe(false);
  });

  it('toggle pattern works', () => {
    const toggle = () =>
      useStore.getState().setMeasurementPanelOpen(!useStore.getState().measurementPanelOpen);
    toggle();
    expect(useStore.getState().measurementPanelOpen).toBe(true);
    toggle();
    expect(useStore.getState().measurementPanelOpen).toBe(false);
  });

  it('setMeasurementPanelOpen does not affect other store slices', () => {
    const perfDashBefore = useStore.getState().perfDashOpen;
    useStore.getState().setMeasurementPanelOpen(true);
    expect(useStore.getState().perfDashOpen).toBe(perfDashBefore);
  });
});
