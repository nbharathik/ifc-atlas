/**
 * Vitest coverage for the colourLayers store slice: set/clear/clearAll,
 * last-set-wins ordering, no-op reference stability, and the two clear
 * paths (model unload + reset).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../useStore';
import type { ColourLayer } from '../useStore';

function layer(color: string, ids: number[], name?: string): ColourLayer {
  return { entries: [{ color, ids }], name };
}

function resetSlice() {
  useStore.setState({ colourLayers: {}, modelLoaded: false });
}

describe('colourLayers store slice', () => {
  beforeEach(resetSlice);

  it('starts empty', () => {
    expect(useStore.getState().colourLayers).toEqual({});
  });

  describe('setColourLayer', () => {
    it('adds a layer under its id', () => {
      const l = layer('#ff0000', [1, 2]);
      useStore.getState().setColourLayer('diff', l);
      expect(useStore.getState().colourLayers.diff).toBe(l);
    });

    it('replaces an existing layer and moves it to the END of the paint order', () => {
      const { setColourLayer } = useStore.getState();
      setColourLayer('a', layer('#ff0000', [1]));
      setColourLayer('b', layer('#00ff00', [2]));
      expect(Object.keys(useStore.getState().colourLayers)).toEqual(['a', 'b']);
      // Re-setting 'a' must move it after 'b' - last SET wins on overlaps.
      const a2 = layer('#0000ff', [1]);
      setColourLayer('a', a2);
      expect(Object.keys(useStore.getState().colourLayers)).toEqual(['b', 'a']);
      expect(useStore.getState().colourLayers.a).toBe(a2);
    });

    it('replaces the record reference (repaint trigger for subscribers)', () => {
      const before = useStore.getState().colourLayers;
      useStore.getState().setColourLayer('x', layer('#ffffff', [9]));
      expect(useStore.getState().colourLayers).not.toBe(before);
    });
  });

  describe('clearColourLayer', () => {
    it('removes one layer and keeps the others', () => {
      const { setColourLayer, clearColourLayer } = useStore.getState();
      setColourLayer('a', layer('#ff0000', [1]));
      setColourLayer('b', layer('#00ff00', [2]));
      clearColourLayer('a');
      expect(Object.keys(useStore.getState().colourLayers)).toEqual(['b']);
    });

    it('is a reference-stable no-op for an unknown id (no spurious repaint)', () => {
      useStore.getState().setColourLayer('a', layer('#ff0000', [1]));
      const before = useStore.getState().colourLayers;
      useStore.getState().clearColourLayer('nope');
      expect(useStore.getState().colourLayers).toBe(before);
    });
  });

  describe('clearAllColourLayers', () => {
    it('removes every layer', () => {
      const { setColourLayer, clearAllColourLayers } = useStore.getState();
      setColourLayer('a', layer('#ff0000', [1]));
      setColourLayer('b', layer('#00ff00', [2]));
      clearAllColourLayers();
      expect(useStore.getState().colourLayers).toEqual({});
    });

    it('is a reference-stable no-op when already empty', () => {
      const before = useStore.getState().colourLayers;
      useStore.getState().clearAllColourLayers();
      expect(useStore.getState().colourLayers).toBe(before);
    });
  });

  describe('lifecycle clears', () => {
    it('model unload (setModelLoaded(false)) drops all layers', () => {
      useStore.setState({ modelLoaded: true });
      useStore.getState().setColourLayer('heat', layer('#ff0000', [1, 2]));
      useStore.getState().setModelLoaded(false);
      expect(useStore.getState().colourLayers).toEqual({});
    });

    it('setModelLoaded(true) preserves layers', () => {
      useStore.getState().setColourLayer('heat', layer('#ff0000', [1]));
      useStore.getState().setModelLoaded(true);
      expect(Object.keys(useStore.getState().colourLayers)).toEqual(['heat']);
    });

    it('reset() drops all layers', () => {
      useStore.getState().setColourLayer('heat', layer('#ff0000', [1]));
      useStore.getState().reset();
      expect(useStore.getState().colourLayers).toEqual({});
    });
  });
});
