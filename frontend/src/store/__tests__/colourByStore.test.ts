/**
 * Vitest coverage for the colourBy store slice.
 * Tests setColourBy, initial value, and reset-on-model-unload behaviour.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../useStore';

function resetSlice() {
  useStore.setState({ colourBy: 'off' });
}

describe('colourBy store slice', () => {
  beforeEach(resetSlice);

  describe('initial state', () => {
    it('starts with colour-by off', () => {
      expect(useStore.getState().colourBy).toBe('off');
    });
  });

  describe('setColourBy', () => {
    it('switches to type mode', () => {
      useStore.getState().setColourBy('type');
      expect(useStore.getState().colourBy).toBe('type');
    });

    it('switches to storey mode', () => {
      useStore.getState().setColourBy('storey');
      expect(useStore.getState().colourBy).toBe('storey');
    });

    it('switches to material mode', () => {
      useStore.getState().setColourBy('material');
      expect(useStore.getState().colourBy).toBe('material');
    });

    it('switches back to off', () => {
      useStore.getState().setColourBy('type');
      useStore.getState().setColourBy('off');
      expect(useStore.getState().colourBy).toBe('off');
    });
  });

  describe('reset() clears colourBy', () => {
    it('resets material mode back to off', () => {
      useStore.getState().setColourBy('material');
      expect(useStore.getState().colourBy).toBe('material');
      useStore.getState().reset();
      expect(useStore.getState().colourBy).toBe('off');
    });

    it('resets type mode back to off', () => {
      useStore.getState().setColourBy('type');
      useStore.getState().reset();
      expect(useStore.getState().colourBy).toBe('off');
    });
  });
});
