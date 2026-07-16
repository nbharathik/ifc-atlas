import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as FRAGS from '@thatopen/fragments';

import { _internal } from '../src/converter.js';
import type { ParseProfile } from '../src/profiles.js';

function comparableState(importer: FRAGS.IfcImporter) {
  return {
    classes: {
      elements: [...importer.classes.elements].sort((a, b) => a - b),
      abstract: [...importer.classes.abstract].sort((a, b) => a - b),
    },
    relations: [...importer.relations]
      .map(([type, relation]) => [type, { ...relation }] as const)
      .sort(([a], [b]) => a - b),
    attributesToExclude: [...importer.attributesToExclude].sort(),
    webIfcSettings: { ...importer.webIfcSettings },
    geometryProcessSettings: {
      ...importer.geometryProcessSettings,
      categoryFaceThresholds: importer.geometryProcessSettings.categoryFaceThresholds
        ? [...importer.geometryProcessSettings.categoryFaceThresholds].sort(([a], [b]) => a - b)
        : undefined,
    },
    replaceStoreyElevation: importer.replaceStoreyElevation,
    replaceSiteElevation: importer.replaceSiteElevation,
    includeUniqueAttributes: importer.includeUniqueAttributes,
    includeRelationNames: importer.includeRelationNames,
    distanceThreshold: importer.distanceThreshold,
  };
}

describe('converter importer state transaction', () => {
  it('restores settings, nested maps, scalar flags, and collections', () => {
    const importer = new FRAGS.IfcImporter();
    importer.webIfcSettings = {
      COORDINATE_TO_ORIGIN: false,
      CIRCLE_SEGMENTS: 31,
      MEMORY_LIMIT: 111,
      TAPE_SIZE: 222,
      LINEWRITER_BUFFER: 333,
      PLANE_REFIT_ITERATIONS: 7,
      BOOLEAN_UNION_THRESHOLD: 9,
      TOLERANCE_PLANE_INTERSECTION: 0.125,
      TOLERANCE_SCALAR_EQUALITY: 0.25,
    };
    importer.geometryProcessSettings = {
      threshold: 987,
      precision: 654,
      normalPrecision: 321,
      planePrecision: 123,
      faceThreshold: 0.42,
      forceTransparentSpaces: true,
      categoryFaceThresholds: new Map([[123, 0.25]]),
      processIfcRelSpaceBoundarySecondLevel: true,
    };
    importer.replaceStoreyElevation = true;
    importer.replaceSiteElevation = true;
    importer.includeUniqueAttributes = true;
    importer.includeRelationNames = true;
    importer.distanceThreshold = null;
    importer.attributesToExclude.add('CustomAttribute');

    const expected = comparableState(importer);
    const saved = _internal.snapshotImporterState(importer);

    _internal.applyImporterProfile(importer, 'ultra_fast');
    assert.equal(importer.webIfcSettings.CIRCLE_SEGMENTS, 6);
    assert.equal(importer.geometryProcessSettings.threshold, 1200);
    assert.equal(importer.replaceStoreyElevation, false);
    assert.equal(importer.distanceThreshold, 10_000);

    // Prove the snapshot does not alias nested mutable settings retained by
    // the profile's object spread.
    importer.geometryProcessSettings.categoryFaceThresholds?.set(123, 0.75);
    importer.attributesToExclude.add('AfterSnapshot');

    _internal.restoreImporterState(importer, saved);
    assert.deepEqual(comparableState(importer), expected);
  });

  it('does not leak ultra-fast-only settings into a later quality profile', () => {
    const importer = new FRAGS.IfcImporter();
    const baselineGeometry = comparableState(importer).geometryProcessSettings;
    const saved = _internal.snapshotImporterState(importer);

    _internal.applyImporterProfile(importer, 'ultra_fast');
    assert.equal(importer.webIfcSettings.MEMORY_LIMIT, 1024 * 1024 * 1024);
    assert.equal(importer.geometryProcessSettings.threshold, 1200);

    _internal.restoreImporterState(importer, saved);
    _internal.applyImporterProfile(importer, 'quality');

    assert.equal(importer.webIfcSettings.CIRCLE_SEGMENTS, 24);
    assert.equal(importer.webIfcSettings.MEMORY_LIMIT, undefined);
    assert.equal(importer.webIfcSettings.TAPE_SIZE, undefined);
    assert.equal(importer.webIfcSettings.BOOLEAN_UNION_THRESHOLD, undefined);
    assert.deepEqual(comparableState(importer).geometryProcessSettings, baselineGeometry);
  });

  // Release gate: simultaneous quality and ultra_fast conversions must be
  // deterministic and independent of request ordering. The full conversion is
  // configure -> process -> restore on one shared importer; process() only
  // reads importer state, so proving the configured state each profile sees is
  // byte-identical across orderings proves the deterministic core without
  // paying for full-model conversions.
  it('captures byte-identical per-profile state regardless of request ordering', async () => {
    const importer = new FRAGS.IfcImporter();
    const runSerial = _internal.createSerialExecutor();

    const configureAndCapture = (profile: ParseProfile) =>
      runSerial(async () => {
        const saved = _internal.snapshotImporterState(importer);
        try {
          _internal.applyImporterProfile(importer, profile);
          // Yield while holding the executor slot; a broken executor would let
          // the concurrently enqueued profile clobber the state captured next.
          await new Promise<void>((resolve) => setImmediate(resolve));
          return createHash('sha256')
            .update(JSON.stringify(comparableState(importer)))
            .digest('hex');
        } finally {
          _internal.restoreImporterState(importer, saved);
        }
      });

    const [qualityFirst, ultraSecond] = await Promise.all([
      configureAndCapture('quality'),
      configureAndCapture('ultra_fast'),
    ]);
    const [ultraFirst, qualitySecond] = await Promise.all([
      configureAndCapture('ultra_fast'),
      configureAndCapture('quality'),
    ]);

    assert.equal(qualityFirst, qualitySecond);
    assert.equal(ultraFirst, ultraSecond);
    assert.notEqual(qualityFirst, ultraFirst);
  });
});
