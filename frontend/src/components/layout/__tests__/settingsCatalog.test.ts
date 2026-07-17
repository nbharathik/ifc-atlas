import { describe, expect, it } from 'vitest';
import { buildSettingsNavigation } from '../settingsCatalog';

describe('settings navigation', () => {
  it('uses plain-language release sections without duplicate destinations', () => {
    const items = buildSettingsNavigation(false).flatMap((group) => group.items);
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    expect(items.map((item) => item.label)).toEqual(expect.arrayContaining([
      'General & appearance',
      'Viewer',
      'Processing & performance',
      'Privacy & data',
      'AI workspace',
      'Advanced',
    ]));
  });

  it('does not expose backend-only integration settings in the web viewer', () => {
    const ids = buildSettingsNavigation(true).flatMap((group) => group.items.map((item) => item.id));
    expect(ids).not.toContain('integrations');
    expect(ids).toContain('ai');
  });
});
