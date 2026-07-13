import type { ToolCall } from '../../types/ifc';

export interface ToolActivityPresentation {
  label: string;
  tone: 'read' | 'viewer' | 'validate' | 'semantic' | 'geometry' | 'code';
  description: string;
}

const PRESENTATION: Record<NonNullable<ToolCall['activityKind']>, ToolActivityPresentation> = {
  read_only: { label: 'Read only', tone: 'read', description: 'Reads model data without modifying the IFC file.' },
  viewer_action: { label: 'Viewer action', tone: 'viewer', description: 'Changes selection or presentation only; the IFC file is not modified.' },
  validation: { label: 'Validation', tone: 'validate', description: 'Checks model data and reports issues without applying edits.' },
  semantic_edit: { label: 'Semantic edit', tone: 'semantic', description: 'Stages metadata or property changes for review.' },
  geometry_edit: { label: 'Geometry edit', tone: 'geometry', description: 'May change rendered geometry and reload the model after approval.' },
  model_edit: { label: 'Model change', tone: 'geometry', description: 'May modify semantic data or geometry depending on edit history.' },
  code_read: { label: 'Code · read', tone: 'code', description: 'Runs read-only Python in the IFC sandbox.' },
  code_edit: { label: 'Code · edit', tone: 'code', description: 'Runs Python against a sandbox copy and stages detected changes for review.' },
};

const SEMANTIC_TOOLS = new Set([
  'rename_element',
  'rename_elements_batch',
  'update_property_value',
  'update_element_attribute',
  'update_properties_batch',
]);
const GEOMETRY_TOOLS = new Set(['create_wall_from_ends', 'delete_element', 'propose_edit']);
const VALIDATION_TOOLS = new Set(['ids_validate', 'highlight_ids_failures', 'run_model_health_check', 'run_model_audit']);
const VIEWER_TOOLS = new Set(['highlight_elements', 'select_element', 'isolate_elements', 'show_all_elements', 'clip_section_box_to_element']);

export function toolActivityPresentation(tool: Pick<ToolCall, 'name' | 'activityKind'>): ToolActivityPresentation {
  let kind = tool.activityKind;
  // Restored v0.1.0 transcripts do not carry activityKind. Infer a safe label
  // from the tool name so old conversations remain understandable.
  if (!kind) {
    if (tool.name === 'execute_ifc_query_code') kind = 'code_read';
    else if (tool.name === 'execute_ifc_code') kind = 'code_edit';
    else if (tool.name === 'undo_last_edit') kind = 'model_edit';
    else if (SEMANTIC_TOOLS.has(tool.name)) kind = 'semantic_edit';
    else if (GEOMETRY_TOOLS.has(tool.name)) kind = 'geometry_edit';
    else if (VALIDATION_TOOLS.has(tool.name)) kind = 'validation';
    else if (VIEWER_TOOLS.has(tool.name)) kind = 'viewer_action';
    else kind = 'read_only';
  }
  return PRESENTATION[kind];
}
