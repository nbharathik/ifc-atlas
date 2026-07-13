export type SettingsSectionId =
  | 'appearance'
  | 'viewer'
  | 'performance'
  | 'storage'
  | 'integrations'
  | 'ai';

export interface SettingsNavItem {
  id: SettingsSectionId;
  label: string;
  description: string;
}

export interface SettingsNavGroup {
  label: string;
  items: readonly SettingsNavItem[];
}

/** Product-language settings map shared by the modal and regression tests. */
export function buildSettingsNavigation(browserOnly: boolean): readonly SettingsNavGroup[] {
  return [
    {
      label: 'Workspace',
      items: [
        { id: 'appearance', label: 'General & appearance', description: 'Theme and visual identity' },
        { id: 'viewer', label: 'Viewer', description: 'Selection and scene behaviour' },
      ],
    },
    {
      label: 'IFC model',
      items: [
        { id: 'performance', label: 'Processing & performance', description: 'Loading, rendering and large models' },
        { id: 'storage', label: 'Privacy & data', description: 'Local files, caches and retention' },
      ],
    },
    {
      label: browserOnly ? 'Edition' : 'Assistant',
      items: browserOnly
        ? [
            { id: 'ai', label: 'Desktop features', description: 'AI, editing and export' },
          ]
        : [
            { id: 'ai', label: 'AI workspace', description: 'Providers, keys, models and approvals' },
            { id: 'integrations', label: 'Advanced', description: 'MCP servers and validation tools' },
          ],
    },
  ];
}
