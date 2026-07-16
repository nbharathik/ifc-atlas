import type * as FRAGS from '@thatopen/fragments';
import { describe, expect, it } from 'vitest';
import {
  configureImporter,
  getWebIfcSettingsForProfile,
  type ParseProfile,
} from '../parseProfiles';

function makeImporter(): FRAGS.IfcImporter {
  return {
    webIfcSettings: {
      COORDINATE_TO_ORIGIN: false,
      CIRCLE_SEGMENTS: 3,
      LINEWRITER_BUFFER: 4096,
    },
    replaceStoreyElevation: true,
    replaceSiteElevation: true,
    includeUniqueAttributes: true,
    includeRelationNames: true,
    distanceThreshold: null,
    relations: new Map(),
    attributesToExclude: new Set<string>(),
    classes: {
      elements: new Set<number>(),
      abstract: new Set<number>(),
    },
    geometryProcessSettings: {},
  } as unknown as FRAGS.IfcImporter;
}

describe('configureImporter web-ifc settings', () => {
  const profiles: ParseProfile[] = ['quality', 'balanced', 'performance', 'ultra_fast'];

  it.each(profiles)('applies the selected %s profile and preserves unrelated defaults', (profile) => {
    const importer = makeImporter();

    configureImporter(importer, profile);

    expect(importer.webIfcSettings).toEqual({
      COORDINATE_TO_ORIGIN: false,
      CIRCLE_SEGMENTS: 3,
      LINEWRITER_BUFFER: 4096,
      ...getWebIfcSettingsForProfile(profile),
    });
    expect(importer.webIfcSettings.LINEWRITER_BUFFER).toBe(4096);
  });
});
