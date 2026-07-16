/**
 * Shared IFC-parse-profile settings. Extracted from `ViewerPanel.tsx` so
 * both the frontend live-parse path AND the backend Node sidecar can
 * produce identical fragment bytes for the same (file, profile) pair.
 *
 * Why identical bytes matter: the content-hash cache key doubles as the
 * de-dup key. If FE and BE emit different bytes for the same input, we
 * cache-miss every switch and the browser re-fetches pre-built fragments
 * it already has locally.
 *
 * Part of the IFC Atlas native engine (`docs/architecture/AI_NATIVE_ENGINE.md`).
 *
 * Backend sidecar mirrors this file at `backend/sidecar/src/profiles.ts`.
 * Keep them in lock-step; a future codegen step could replace the manual mirror.
 */

import * as FRAGS from '@thatopen/fragments';
import type * as OBC from '@thatopen/components';

export type ParseProfile = 'quality' | 'balanced' | 'performance' | 'ultra_fast';

/**
 * Legacy file-size thresholds retained for telemetry and old cache metadata.
 * Mirrored in `backend/sidecar/src/profiles.ts`. Production selection is now
 * explicit: balanced stays balanced unless the user or caller chooses a
 * faster visual profile.
 */
export const AUTO_PERF_PROFILE_THRESHOLD_BYTES = 40 * 1024 * 1024;
export const AUTO_ULTRA_PROFILE_THRESHOLD_BYTES = 60 * 1024 * 1024;

/**
 * Resolve the active parse profile. The selected profile is explicit; do not
 * silently switch a balanced production load into a faster geometry profile.
 */
export function resolveParseProfile(
  preferred: ParseProfile,
  fileSizeBytes: number,
): ParseProfile {
  void fileSizeBytes;
  return preferred;
}

/**
 * Strip relations / attributes the fragment importer doesn't need for
 * geometry + spatial tree. The client `ModelService` fetches psets /
 * materials / quantities via a separate web-ifc pass over the raw bytes.
 *
 * The performance and ultra_fast profiles also drop non-visual and (on
 * ultra_fast) MEP + furnishing categories - they stay in the metadata
 * but their fragment geometry is skipped.
 */
// Items further from the origin than this (meters, post
// COORDINATE_TO_ORIGIN rebase) are dropped at conversion. Legitimate
// building extents stay well under this; survivors at such distances are
// broken exports (absolute coordinates, stray annotation junk) that wreck
// depth precision, the camera fit, and the model bounding sphere.
// NOTE: already-cached conversions keep serving until the fragment cache
// is flushed - the cache key carries the profile name, not its content.
export const OUTLIER_DISTANCE_THRESHOLD_M = 10_000;

export function configureImporter(importer: FRAGS.IfcImporter, profile: ParseProfile): void {
  // IfcImporter owns a separate web-ifc settings object. Configuring only the
  // surrounding IfcLoader does not reach the dedicated conversion worker, so
  // apply the selected profile here as the shared final source of truth. Keep
  // importer/library defaults that the profile does not intentionally replace.
  importer.webIfcSettings = {
    ...importer.webIfcSettings,
    ...getWebIfcSettingsForProfile(profile),
  };
  importer.replaceStoreyElevation = false;
  importer.replaceSiteElevation = false;
  importer.includeUniqueAttributes = false;
  importer.includeRelationNames = false;
  importer.distanceThreshold = OUTLIER_DISTANCE_THRESHOLD_M;

  // Keep only decomposition + containment relations for the spatial
  // hierarchy. Psets, materials and long storey names are fetched on
  // demand via web-ifc.
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
    // Drop heavy abstract-property classes from the fragments import path.
    // Rich metadata remains available from the dedicated worker pass.
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
      // MEP + furnishing categories that often make up 50-80% of a
      // hospital/office IFC's element count. Metadata stays; only fragment
      // geometry is skipped. Switch to `performance` or `quality` to restore.
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

/**
 * Construction-time WebGLRenderer flags that are profile-driven so a later
 * browser A/B can flip them per graphics profile without touching the renderer
 * init. Both flags are fixed at renderer creation and CANNOT be toggled after
 * (three.js constraint), so they belong to the parse/graphics profile rather
 * than the runtime interaction-quality ladder.
 *
 *  • `logarithmicDepthBuffer` carries a per-fragment log-depth shader cost; it
 *    exists to kill z-fighting across extreme near/far ranges (large
 *    site-scale models). The dedicated polygon-offset/depth-bias mitigation
 *    (zFightingMitigation.ts) may already cover typical single-building models.
 *  • `antialias` enables MSAA - good orbit edge stability, medium GPU cost.
 */
export interface RendererProfileFlags {
  readonly logarithmicDepthBuffer: boolean;
  readonly antialias: boolean;
}

/**
 * Resolve the construction-time renderer flags for a graphics profile.
 *
 * NOTE: the defaults below are intentionally identical for EVERY profile
 * (logdepth on, antialias on) so wiring this through is behaviour-identical and
 * reversible. The knob is exposed for a later browser A/B (e.g. dropping
 * `logarithmicDepthBuffer` on the `performance` profile once it is confirmed
 * that the polygon-offset z-fighting mitigation covers single-building models).
 * Do not change the values here without a measured A/B logged to
 * the performance log.
 */
export function getRendererFlagsForProfile(profile: ParseProfile): RendererProfileFlags {
  void profile;
  return {
    logarithmicDepthBuffer: true,
    antialias: true,
  };
}

/**
 * web-ifc loader settings tuned per profile. See header for the per-knob
 * rationale. These feed `IfcFragmentSettings.webIfc` (frontend) and the
 * same object on the Node importer (sidecar).
 */
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
    // Bumped CIRCLE_SEGMENTS 8 → 14: curves were rendering as octagons
    // (visible as "blocky" pipes / columns / round mullions). Triangle
    // count goes up ~75 % on round elements, but those are usually a
    // small share of total triangles so the FPS hit is in the noise.
    return {
      COORDINATE_TO_ORIGIN: true,
      CIRCLE_SEGMENTS: 14,
      MEMORY_LIMIT: 384 * 1024 * 1024,
      TAPE_SIZE: 96 * 1024 * 1024,
      PLANE_REFIT_ITERATIONS: 5,
    };
  }
  if (profile === 'quality') {
    // Bumped 18 → 24 - visibly smoother on architectural curves at the
    // cost of slightly bigger fragments. Quality profile is opt-in, so
    // users picking it are fine with the trade.
    return {
      COORDINATE_TO_ORIGIN: true,
      CIRCLE_SEGMENTS: 24,
    };
  }
  // 'balanced' default: 12 → 18 for a meaningful quality bump on the
  // out-of-the-box render. Most desktop machines don't notice the extra
  // triangles; the visual improvement on round elements is dramatic.
  return {
    COORDINATE_TO_ORIGIN: true,
    CIRCLE_SEGMENTS: 18,
  };
}
