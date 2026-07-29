import { describe, expect, it } from 'vitest';
import { toolActivityPresentation } from '../ChatPanel';

describe('tool activity presentation', () => {
  it('distinguishes semantic, geometry and edit-code operations', () => {
    expect(toolActivityPresentation({ name: 'edit_semantic' }).label).toBe('Semantic edit');
    expect(toolActivityPresentation({ name: 'edit_structural' }).label).toBe('Geometry edit');
    expect(toolActivityPresentation({ name: 'execute_ifc_code' }).label).toBe('Code · edit');
  });

  it('still infers labels for legacy pre-consolidation tool names (restored transcripts)', () => {
    expect(toolActivityPresentation({ name: 'rename_element' }).label).toBe('Semantic edit');
  });

  it('prefers the server-provided classification', () => {
    expect(toolActivityPresentation({ name: 'custom_tool', activityKind: 'validation' }).tone).toBe('validate');
  });
});
