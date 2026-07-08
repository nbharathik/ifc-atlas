/**
 * Unit tests for the streaming geometry extractor
 * (`extractGeometryStreaming` in `src/parser/geometry.ts`).
 *
 * Run with `npx tsx --test test/geometry_stream.test.ts` from
 * `backend/sidecar/`.
 *
 * Scope: unit-level batching semantics + empty / no-match paths. An
 * end-to-end contract test that streams BasicHouse.ifc and verifies
 * byte-identical mesh output vs the collecting path is a separate follow-up.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import { scanSections } from '../src/parser/index.js';
import {
  extractGeometry,
  extractGeometryStreaming,
  buildProductMaps,
  type ElementMesh,
} from '../src/parser/geometry.js';
import type { EntityRecord } from '../src/parser/types.js';

function ifc(body: string): Uint8Array {
  return Buffer.from(body, 'utf-8');
}

// Minimal extruded-area-solid wall fixture. Three walls share the same
// profile/extrude direction but distinct GlobalIds + placements so
// `processElement` produces three distinct meshes.
function buildThreeWallIfc(): Uint8Array {
  return ifc(`ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Stream test'),'2;1');
FILE_NAME('Test.ifc','2026-05-14T00:00:00',('me'),('Org'),'preprocessor','origsys','auth');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.0,0.0,0.0));
#2=IFCAXIS2PLACEMENT3D(#1,$,$);
#3=IFCLOCALPLACEMENT($,#2);
#4=IFCCARTESIANPOINT((5.0,0.0,0.0));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCLOCALPLACEMENT($,#5);
#7=IFCCARTESIANPOINT((10.0,0.0,0.0));
#8=IFCAXIS2PLACEMENT3D(#7,$,$);
#9=IFCLOCALPLACEMENT($,#8);
#10=IFCRECTANGLEPROFILEDEF(.AREA.,'r',#2,1.0,1.0);
#11=IFCDIRECTION((0.,0.,1.));
#12=IFCEXTRUDEDAREASOLID(#10,#2,#11,2.5);
#13=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#12));
#14=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#15=IFCWALL('w1aaaaaaaaaaaaaaaaaaaa',$,'Wall 1',$,$,#3,#14,$);
#16=IFCWALL('w2aaaaaaaaaaaaaaaaaaaa',$,'Wall 2',$,$,#6,#14,$);
#17=IFCWALL('w3aaaaaaaaaaaaaaaaaaaa',$,'Wall 3',$,$,#9,#14,$);
ENDSEC;
END-ISO-10303-21;
`);
}

function buildEntityTable(bytes: Uint8Array): {
  entities: Map<number, EntityRecord>;
  elementIds: number[];
} {
  const entities = new Map<number, EntityRecord>();
  scanSections(bytes, {
    onEntity: (e) => entities.set(e.expressId, e),
    onHeaderRaw: () => {},
  });
  // Same filter as the production sidecar route: keep IFCWALL.
  const elementIds: number[] = [];
  for (const [id, entity] of entities) {
    if (entity.type === 'IFCWALL') elementIds.push(id);
  }
  return { entities, elementIds };
}

describe('extractGeometryStreaming', () => {
  it('emits no batches when there are no element ids', async () => {
    const calls: { count: number; index: number }[] = [];
    const summary = await extractGeometryStreaming(
      new Map(), [], new Map(), new Map(), new Map(), new Map(),
      {
        batchSize: 10,
        onBatch: (meshes, batchIndex) => {
          calls.push({ count: meshes.length, index: batchIndex });
        },
      },
    );
    assert.equal(calls.length, 0);
    assert.equal(summary.attempted, 0);
    assert.equal(summary.skipped, 0);
    assert.equal(summary.meshCount, 0);
    assert.equal(summary.batchCount, 0);
  });

  it('reports skipped count when elements have no matching entities', async () => {
    const calls: ElementMesh[][] = [];
    const summary = await extractGeometryStreaming(
      new Map(), [1, 2, 3], new Map(), new Map(), new Map(), new Map(),
      {
        batchSize: 2,
        onBatch: (meshes) => { calls.push(meshes); },
      },
    );
    assert.equal(calls.length, 0);
    assert.equal(summary.attempted, 3);
    assert.equal(summary.skipped, 3);
    assert.equal(summary.meshCount, 0);
    assert.equal(summary.batchCount, 0);
  });

  it('flushes mid-iteration when batchSize is reached + final partial flush', async () => {
    const { entities, elementIds } = buildEntityTable(buildThreeWallIfc());
    assert.equal(elementIds.length, 3, 'fixture should yield three walls');
    const { placementIds, repIds, elementTypes, elementNames } =
      buildProductMaps(entities, elementIds);

    const batches: { index: number; meshes: ElementMesh[] }[] = [];
    const summary = await extractGeometryStreaming(
      entities, elementIds, elementTypes, elementNames, placementIds, repIds,
      {
        batchSize: 2,
        onBatch: (meshes, batchIndex) => {
          // Defensive copy; production caller does the same via serialise.
          batches.push({ index: batchIndex, meshes: [...meshes] });
        },
      },
    );

    assert.equal(summary.attempted, 3);
    assert.equal(summary.meshCount, 3);
    assert.equal(summary.batchCount, 2, 'three walls / batchSize 2 = 2 batches');
    assert.equal(batches.length, 2);
    assert.equal(batches[0]!.index, 0);
    assert.equal(batches[0]!.meshes.length, 2);
    assert.equal(batches[1]!.index, 1);
    assert.equal(batches[1]!.meshes.length, 1);
  });

  it('produces byte-identical meshes to the collecting variant', async () => {
    const { entities, elementIds } = buildEntityTable(buildThreeWallIfc());
    const { placementIds, repIds, elementTypes, elementNames } =
      buildProductMaps(entities, elementIds);

    const collected = extractGeometry(
      entities, elementIds, elementTypes, elementNames, placementIds, repIds,
    );

    const streamed: ElementMesh[] = [];
    const summary = await extractGeometryStreaming(
      entities, elementIds, elementTypes, elementNames, placementIds, repIds,
      {
        batchSize: 100,
        onBatch: (meshes) => { streamed.push(...meshes); },
      },
    );

    assert.equal(streamed.length, collected.meshes.length);
    assert.equal(summary.meshCount, collected.meshes.length);
    assert.equal(summary.attempted, collected.attempted);
    assert.equal(summary.skipped, collected.skipped);
    for (let i = 0; i < streamed.length; i++) {
      const a = streamed[i]!;
      const b = collected.meshes[i]!;
      assert.equal(a.expressId, b.expressId);
      assert.equal(a.ifcType, b.ifcType);
      assert.equal(a.positions.length, b.positions.length);
      assert.equal(a.indices.length, b.indices.length);
      for (let k = 0; k < a.positions.length; k++) {
        assert.equal(a.positions[k], b.positions[k]);
      }
      for (let k = 0; k < a.indices.length; k++) {
        assert.equal(a.indices[k], b.indices[k]);
      }
    }
  });

  it('clamps batchSize >= 1 (defensive)', async () => {
    const { entities, elementIds } = buildEntityTable(buildThreeWallIfc());
    const { placementIds, repIds, elementTypes, elementNames } =
      buildProductMaps(entities, elementIds);

    const batches: number[] = [];
    const summary = await extractGeometryStreaming(
      entities, elementIds, elementTypes, elementNames, placementIds, repIds,
      {
        batchSize: 0, // illegal, should be clamped to 1
        onBatch: (meshes) => { batches.push(meshes.length); },
      },
    );
    assert.equal(summary.batchCount, 3, 'batchSize=1 → one batch per mesh');
    assert.deepEqual(batches, [1, 1, 1]);
  });

  it('clamps batchSize <= 1000 (matches route contract)', async () => {
    // batchSize > 1000 must be silently capped at 1000 so direct callers
    // can't produce a payload shape the HTTP route would reject. With
    // only 3 walls + cap 1000, the single batch should still hold all 3.
    const { entities, elementIds } = buildEntityTable(buildThreeWallIfc());
    const { placementIds, repIds, elementTypes, elementNames } =
      buildProductMaps(entities, elementIds);

    const batchSizes: number[] = [];
    const summary = await extractGeometryStreaming(
      entities, elementIds, elementTypes, elementNames, placementIds, repIds,
      {
        batchSize: 99999,
        onBatch: (meshes) => { batchSizes.push(meshes.length); },
      },
    );
    assert.equal(summary.batchCount, 1, 'cap=1000 + 3 meshes → 1 batch');
    assert.deepEqual(batchSizes, [3]);
  });
});
