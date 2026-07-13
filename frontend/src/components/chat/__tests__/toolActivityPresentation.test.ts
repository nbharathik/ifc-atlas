import { describe, expect, it } from 'vitest';
import { toolActivityPresentation } from '../toolActivityPresentation';

describe('tool activity presentation', () => {
  it('distinguishes semantic, geometry and edit-code operations', () => {
    expect(toolActivityPresentation({ name: 'rename_element' }).label).toBe('Semantic edit');
    expect(toolActivityPresentation({ name: 'create_wall_from_ends' }).label).toBe('Geometry edit');
    expect(toolActivityPresentation({ name: 'execute_ifc_code' }).label).toBe('Code · edit');
  });

  it('prefers the server-provided classification', () => {
    expect(toolActivityPresentation({ name: 'custom_tool', activityKind: 'validation' }).tone).toBe('validate');
  });
});
