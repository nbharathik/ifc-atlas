/**
 * Vitest coverage for the section-box store slice.
 * Tests sectionBoxEnabled, setSectionBoxEnabled, toggleSectionBox,
 * clipToElementFn, setClipToElementFn, clipToElement, and model-unload clear.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../useStore';

function reset() {
  useStore.setState({ sectionBoxEnabled: false, clipToElementFn: null, modelLoaded: false });
}

describe('section box store slice', () => {
  beforeEach(reset);

  describe('initial state', () => {
    it('starts with section box disabled', () => {
      expect(useStore.getState().sectionBoxEnabled).toBe(false);
    });
  });

  describe('setSectionBoxEnabled', () => {
    it('enables the section box', () => {
      useStore.getState().setSectionBoxEnabled(true);
      expect(useStore.getState().sectionBoxEnabled).toBe(true);
    });

    it('disables the section box', () => {
      useStore.setState({ sectionBoxEnabled: true });
      useStore.getState().setSectionBoxEnabled(false);
      expect(useStore.getState().sectionBoxEnabled).toBe(false);
    });

    it('is idempotent - setting true twice stays true', () => {
      useStore.getState().setSectionBoxEnabled(true);
      useStore.getState().setSectionBoxEnabled(true);
      expect(useStore.getState().sectionBoxEnabled).toBe(true);
    });

    it('is idempotent - setting false twice stays false', () => {
      useStore.getState().setSectionBoxEnabled(false);
      useStore.getState().setSectionBoxEnabled(false);
      expect(useStore.getState().sectionBoxEnabled).toBe(false);
    });
  });

  describe('toggleSectionBox', () => {
    it('toggles from false to true', () => {
      useStore.getState().toggleSectionBox();
      expect(useStore.getState().sectionBoxEnabled).toBe(true);
    });

    it('toggles from true to false', () => {
      useStore.setState({ sectionBoxEnabled: true });
      useStore.getState().toggleSectionBox();
      expect(useStore.getState().sectionBoxEnabled).toBe(false);
    });

    it('double-toggle returns to original state', () => {
      const initial = useStore.getState().sectionBoxEnabled;
      useStore.getState().toggleSectionBox();
      useStore.getState().toggleSectionBox();
      expect(useStore.getState().sectionBoxEnabled).toBe(initial);
    });

    it('triple-toggle inverts original state', () => {
      const initial = useStore.getState().sectionBoxEnabled;
      useStore.getState().toggleSectionBox();
      useStore.getState().toggleSectionBox();
      useStore.getState().toggleSectionBox();
      expect(useStore.getState().sectionBoxEnabled).toBe(!initial);
    });
  });

  describe('clipToElementFn / setClipToElementFn / clipToElement', () => {
    it('starts with clipToElementFn null', () => {
      expect(useStore.getState().clipToElementFn).toBeNull();
    });

    it('setClipToElementFn registers a function', () => {
      const fn = vi.fn();
      useStore.getState().setClipToElementFn(fn);
      expect(useStore.getState().clipToElementFn).toBe(fn);
    });

    it('setClipToElementFn clears the function when called with null', () => {
      const fn = vi.fn();
      useStore.getState().setClipToElementFn(fn);
      useStore.getState().setClipToElementFn(null);
      expect(useStore.getState().clipToElementFn).toBeNull();
    });

    it('clipToElement calls the registered function with the expressId', () => {
      const fn = vi.fn();
      useStore.getState().setClipToElementFn(fn);
      useStore.getState().clipToElement(42);
      expect(fn).toHaveBeenCalledOnce();
      expect(fn).toHaveBeenCalledWith(42);
    });

    it('clipToElement is a no-op when no function is registered', () => {
      expect(() => useStore.getState().clipToElement(42)).not.toThrow();
    });

    it('replacing the function calls the new one', () => {
      const fn1 = vi.fn();
      const fn2 = vi.fn();
      useStore.getState().setClipToElementFn(fn1);
      useStore.getState().setClipToElementFn(fn2);
      useStore.getState().clipToElement(7);
      expect(fn1).not.toHaveBeenCalled();
      expect(fn2).toHaveBeenCalledWith(7);
    });
  });

  describe('model-unload clears section box state', () => {
    it('setModelLoaded(false) resets sectionBoxEnabled to false', () => {
      useStore.setState({ sectionBoxEnabled: true, modelLoaded: true });
      useStore.getState().setModelLoaded(false);
      expect(useStore.getState().sectionBoxEnabled).toBe(false);
    });

    it('setModelLoaded(true) preserves existing sectionBoxEnabled value', () => {
      useStore.setState({ sectionBoxEnabled: true, modelLoaded: false });
      useStore.getState().setModelLoaded(true);
      expect(useStore.getState().sectionBoxEnabled).toBe(true);
    });

    it('setModelLoaded(false) when already false keeps false', () => {
      useStore.setState({ sectionBoxEnabled: false, modelLoaded: true });
      useStore.getState().setModelLoaded(false);
      expect(useStore.getState().sectionBoxEnabled).toBe(false);
    });
  });
});
