import { useCallback } from 'react';
import { useIfcUpload } from './useIfcUpload';
import { newProject } from '../services/api';

export type NewProjectTemplate = 'empty' | 'single_storey' | 'two_storey';

/**
 * Create a fresh IFC project from a template (plan A3) and load it through the
 * normal upload pipeline, so from here on it behaves exactly like any opened
 * model. Reused by the empty-state overlay and the File menu.
 *
 * Returns the same `{ ok }` shape as `useIfcUpload` so callers can surface an
 * error inline without a throw.
 */
export function useNewProject() {
  const upload = useIfcUpload();
  return useCallback(
    async (
      template: NewProjectTemplate = 'single_storey',
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        const bytes = await newProject(template);
        const file = new File([bytes], 'New Project.ifc', { type: 'application/x-ifc' });
        return await upload(file);
      } catch (err) {
        return { ok: false, error: `Could not create project: ${String(err)}` };
      }
    },
    [upload],
  );
}
