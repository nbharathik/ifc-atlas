/**
 * Sidecar-side mirror of `frontend/src/services/viewer/parseProfiles.ts`.
 *
 * THIS FILE MUST STAY IN SYNC WITH THE FRONTEND.
 *
 * The content-hash fragment cache assumes the sidecar and the browser
 * produce identical bytes for the same (ifc, profile) pair. Any knob
 * that differs between the two sides causes cache misses at best and
 * subtle visual inconsistencies at worst.
 *
 * These two files could later be generated from a shared JSON schema
 * so they can never drift apart.
 *
 * The category drop sets below are additionally mirrored in
 * backend/app/services/spatial_fragment_service.py, which filters spatial
 * subset requests down to the categories a profile actually converts.
 * Changing a drop set here requires updating that table too.
 */

import * as FRAGS from '@thatopen/fragments';
import type * as OBC from '@thatopen/components';

export type ParseProfile = 'quality' | 'balanced' | 'performance' | 'ultra_fast';

export const AUTO_PERF_PROFILE_THRESHOLD_BYTES = 40 * 1024 * 1024;
export const AUTO_ULTRA_PROFILE_THRESHOLD_BYTES = 60 * 1024 * 1024;

export function resolveParseProfile(
  preferred: ParseProfile,
  fileSizeBytes: number,
): ParseProfile {
  void fileSizeBytes;
  return preferred;
}

// Items further from the origin than this (meters, post
// COORDINATE_TO_ORIGIN rebase) are dropped at conversion. Legitimate
// building extents stay well under this; survivors at such distances are
// broken exports (absolute coordinates, stray annotation junk) that wreck
// depth precision, the camera fit, and the model bounding sphere.
// NOTE: already-cached conversions keep serving until the fragment cache
// is flushed - the cache key carries the profile name, not its content.
export const OUTLIER_DISTANCE_THRESHOLD_M = 10_000;

export function configureImporter(importer: FRAGS.IfcImporter, profile: ParseProfile): void {
  importer.replaceStoreyElevation = false;
  importer.replaceSiteElevation = false;
  importer.includeUniqueAttributes = false;
  importer.includeRelationNames = false;
  importer.distanceThreshold = OUTLIER_DISTANCE_THRESHOLD_M;

  const slimRelations = new Map<number, { forRelating: string; forRelated: string }>();
  for (const [relationType, relation] of importer.relations.entries()) {
    if (
      relation.forRelating === 'IsDecomposedBy'
      || relation.forRelating === 'ContainsElements'
    ) {
      slimRelations.set(relationType, relation);
    }
  }
  if (slimRelations.size > 0) {
    importer.relations = slimRelations;
  }

  const lightweightExclusions = ['IsDefinedBy', 'HasAssociations', 'LongName'];
  for (const attributeName of lightweightExclusions) {
    importer.attributesToExclude.add(attributeName);
  }

  const nonVisualCategories = new Set([
    'IFCSPACE',
    'IFCOPENINGELEMENT',
    'IFCOPENINGSTANDARDCASE',
    'IFCANNOTATION',
    'IFCGRID',
  ]);
  if (profile !== 'quality') {
    for (const [typeId, categoryName] of Object.entries(FRAGS.ifcCategoryMap)) {
      if (nonVisualCategories.has(categoryName.toUpperCase())) {
        importer.classes.elements.delete(Number(typeId));
      }
    }
  }

  if (profile === 'performance' || profile === 'ultra_fast') {
    for (const propertyClass of FRAGS.ifcClasses.properties) {
      importer.classes.abstract.delete(propertyClass);
    }
    for (const unitClass of FRAGS.ifcClasses.units) {
      importer.classes.abstract.delete(unitClass);
    }

    const ultraOnlyDropCategories = new Set([
      'IFCFASTENER',
      'IFCMECHANICALFASTENER',
      'IFCREINFORCINGBAR',
      'IFCREINFORCINGMESH',
      'IFCTENDON',
      'IFCTENDONANCHOR',
      'IFCVIRTUALELEMENT',
      'IFCSURFACEFEATURE',
      'IFCBUILDINGELEMENTPART',
      'IFCFURNISHINGELEMENT',
      'IFCFURNITURE',
      'IFCSYSTEMFURNITUREELEMENT',
      'IFCDISTRIBUTIONELEMENT',
      'IFCDISTRIBUTIONCONTROLELEMENT',
      'IFCDISTRIBUTIONFLOWELEMENT',
      'IFCFLOWTERMINAL',
      'IFCFLOWCONTROLLER',
      'IFCFLOWFITTING',
      'IFCFLOWSEGMENT',
    ]);
    for (const [typeId, categoryName] of Object.entries(FRAGS.ifcCategoryMap)) {
      const upper = categoryName.toUpperCase();
      const shouldDropUltra = profile === 'ultra_fast' && (
        ultraOnlyDropCategories.has(upper)
        || upper.includes('FITTING')
        || upper.includes('TERMINAL')
        || upper.includes('ACCESSORY')
        || upper.includes('REINFORCING')
        || upper.includes('FASTENER')
      );
      if (shouldDropUltra) {
        importer.classes.elements.delete(Number(typeId));
      }
    }

    if (profile === 'ultra_fast') {
      importer.geometryProcessSettings = {
        ...importer.geometryProcessSettings,
        threshold: 1200,
        precision: 120000,
        normalPrecision: 900000,
        planePrecision: 180,
        faceThreshold: 0.84,
        forceTransparentSpaces: false,
      };
    } else {
      importer.geometryProcessSettings = {
        ...importer.geometryProcessSettings,
        threshold: 2200,
        precision: 250000,
        normalPrecision: 1500000,
        planePrecision: 300,
        faceThreshold: 0.72,
        forceTransparentSpaces: false,
      };
    }
  }
}

export function getWebIfcSettingsForProfile(
  profile: ParseProfile,
): Partial<OBC.IfcFragmentSettings['webIfc']> {
  if (profile === 'ultra_fast') {
    return {
      COORDINATE_TO_ORIGIN: true,
      CIRCLE_SEGMENTS: 6,
      MEMORY_LIMIT: 1024 * 1024 * 1024,
      TAPE_SIZE: 256 * 1024 * 1024,
      PLANE_REFIT_ITERATIONS: 2,
      BOOLEAN_UNION_THRESHOLD: 32,
      TOLERANCE_PLANE_INTERSECTION: 1e-4,
      TOLERANCE_SCALAR_EQUALITY: 1e-4,
    };
  }
  if (profile === 'performance') {
    return {
      COORDINATE_TO_ORIGIN: true,
      CIRCLE_SEGMENTS: 14,
      MEMORY_LIMIT: 384 * 1024 * 1024,
      TAPE_SIZE: 96 * 1024 * 1024,
      PLANE_REFIT_ITERATIONS: 5,
    };
  }
  if (profile === 'quality') {
    return {
      COORDINATE_TO_ORIGIN: true,
      CIRCLE_SEGMENTS: 24,
    };
  }
  return {
    COORDINATE_TO_ORIGIN: true,
    CIRCLE_SEGMENTS: 18,
  };
}
