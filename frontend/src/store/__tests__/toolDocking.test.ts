/**
 * Vitest coverage for the Tools-tab docking store API (openTool / closeTool /
 * toggleTool / activeToolOf). Regression guard: toggleTool used to hardcode
 * the first four feature panels (qto/ids/bcf/plugins), so command-palette
 * toggles for cost/carbon/cobie/diff landed on the launcher instead of the
 * panel. Both entry points must route every FeaturePanel identically.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { activeToolOf, useStore } from '../useStore';
import type { ToolId } from '../useStore';

const FEATURE_PANELS = ['qto', 'ids', 'bcf', 'plugins', 'cost', 'carbon', 'cobie', 'diff'] as const;
const MODEL_TOOLS = ['stats', 'filter', 'health'] as const;

function reset() {
  useStore.setState({
    activeFeaturePanel: null,
    statsPanelOpen: false,
    filterPanelOpen: false,
    healthPanelOpen: false,
  });
}

describe('tools tab docking', () => {
  beforeEach(reset);

  describe('toggleTool', () => {
    it.each(FEATURE_PANELS)('opens the %s feature panel', (id) => {
      useStore.getState().toggleTool(id as ToolId);
      expect(useStore.getState().activeFeaturePanel).toBe(id);
      expect(activeToolOf(useStore.getState())).toBe(id);
    });

    it.each(FEATURE_PANELS)('closes %s when it is already active', (id) => {
      useStore.getState().toggleTool(id as ToolId);
      useStore.getState().toggleTool(id as ToolId);
      expect(useStore.getState().activeFeaturePanel).toBeNull();
      expect(activeToolOf(useStore.getState())).toBeNull();
    });

    it.each(MODEL_TOOLS)('opens the %s model tool without a feature panel', (id) => {
      useStore.getState().toggleTool(id as ToolId);
      expect(useStore.getState().activeFeaturePanel).toBeNull();
      expect(activeToolOf(useStore.getState())).toBe(id);
    });

    it('switches between feature panels (mutually exclusive)', () => {
      useStore.getState().toggleTool('qto');
      useStore.getState().toggleTool('diff');
      expect(useStore.getState().activeFeaturePanel).toBe('diff');
    });

    it('switching from a model tool to a feature panel closes the model tool', () => {
      useStore.getState().toggleTool('stats');
      useStore.getState().toggleTool('carbon');
      const s = useStore.getState();
      expect(s.statsPanelOpen).toBe(false);
      expect(s.activeFeaturePanel).toBe('carbon');
    });

    it('focuses the Tools tab when opening', () => {
      useStore.getState().toggleTool('cobie');
      expect(useStore.getState().rightActiveTab).toBe('tools');
      expect(useStore.getState().rightSidebarOpen).toBe(true);
    });
  });

  describe('openTool / closeTool parity', () => {
    it.each(FEATURE_PANELS)('openTool docks %s', (id) => {
      useStore.getState().openTool(id as ToolId);
      expect(activeToolOf(useStore.getState())).toBe(id);
    });

    it('closeTool clears everything', () => {
      useStore.getState().openTool('cost');
      useStore.getState().closeTool();
      expect(activeToolOf(useStore.getState())).toBeNull();
    });
  });
});
