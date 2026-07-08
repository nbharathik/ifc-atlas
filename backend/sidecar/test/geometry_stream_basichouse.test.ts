/**
 * End-to-end contract test for the streaming geometry extractor against
 * the real `BasicHouse.ifc` fixture.
 *
 * What this verifies that the synthetic 3-wall fixture in
 * `geometry_stream.test.ts` cannot:
 *
 *  1. `extractGeometryStreaming` flushes ≥ 2 NDJSON batches on a real model
 *     (i.e. the streaming path actually streams, not just buffers).
 *  2. Streamed mesh output is **byte-identical** to the collecting
 *     `extractGeometry` path: same expressIds in the same order, same
 *     Float32 position arrays, same Uint32 index arrays. This is the
 *     contract that lets the future frontend consumer assume the
 *     streaming path is a drop-in performance optimisation over the
 *     monolithic `/geometry` JSON response.
 *
 * The test loads `data/fixtures/BasicHouse.ifc` (52 MB) and runs
 * the same entity-table + product-map setup as `handleGeometry` in
 * `src/index.ts`. If the fixture is missing (CI without checkout, etc.)
 * the test skips rather than failing.
 *
 * Run with `npx tsx --test test/geometry_stream_basichouse.test.ts`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { scanSections } from '../src/parser/index.js';
import {
  extractGeometry,
  extractGeometryStreaming,
  buildProductMaps,
  type ElementMesh,
} from '../src/parser/geometry.js';
import type { EntityRecord } from '../src/parser/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASIC_HOUSE = resolve(HERE, '../../../data/fixtures/BasicHouse.ifc');

/**
 * Same element filter as the production sidecar route. Kept inline (rather
 * than imported from `src/index.ts`) so this test is hermetic to the
 * geometry parser surface; if the route filter changes, this test should
 * still pass on the parser contract.
 */
function collectElementIds(entities: Map<number, EntityRecord>): number[] {
  const SKIP_PREFIXES = ['IFCREL', 'IFCPROPERTY', 'IFCQUANTITY', 'IFCPHYSICAL', 'IFCELEMENTQUANTITY'];
  const SKIP_SUFFIXES = ['TYPE', 'STYLE', 'PROPERTIES', 'PORT'];
  const SPATIAL_TYPES = new Set(['IFCPROJECT','IFCSITE','IFCBUILDING','IFCBUILDINGSTOREY','IFCSPACE']);
  const SKIP_EXPLICIT = new Set(['IFCOPENINGELEMENT','IFCOPENINGSTANDARDCASE','IFCVIRTUALELEMENT','IFCANNOTATION','IFCGRID']);
  const out: number[] = [];
  for (const [id, entity] of entities) {
    const t = entity.type;
    if (SPATIAL_TYPES.has(t) || SKIP_EXPLICIT.has(t)) continue;
    if (SKIP_PREFIXES.some((p) => t.startsWith(p))) continue;
    if (SKIP_SUFFIXES.some((s) => t.endsWith(s))) continue;
    out.push(id);
  }
  return out;
}

describe('BasicHouse.ifc - streaming vs collecting contract', () => {
  if (!existsSync(BASIC_HOUSE)) {
    it('skipped - BasicHouse.ifc fixture not present under data/fixtures', () => {
      // node:test has no top-level skip; emit a passing no-op so the
      // suite can be invoked unconditionally without CI red.
    });
    return;
  }

  it('emits ≥ 2 NDJSON batches AND meshes are byte-identical to extractGeometry', async () => {
    const bytes = new Uint8Array(readFileSync(BASIC_HOUSE));

    // 1. Build the entity table once (same single-lex pass the route does).
    const entities = new Map<number, EntityRecord>();
    scanSections(bytes, {
      onEntity: (e) => entities.set(e.expressId, e),
      onHeaderRaw: () => {},
    });
    const elementIds = collectElementIds(entities);
    assert.ok(elementIds.length > 0, 'BasicHouse should contain product elements');
    const { placementIds, repIds, elementTypes, elementNames } =
      buildProductMaps(entities, elementIds);

    // 2. Collecting path: ground truth.
    const collected = extractGeometry(
      entities, elementIds, elementTypes, elementNames, placementIds, repIds,
    );
    assert.ok(
      collected.meshes.length >= 2,
      `BasicHouse should yield ≥ 2 extractable meshes (got ${collected.meshes.length}) - ` +
      'if this fails, either the fixture changed or the parser regressed',
    );

    // 3. Streaming path with a batchSize small enough to guarantee ≥ 2
    //    batches given the mesh count. We pick `floor(meshCount/2)` so we
    //    always see at least one mid-iteration flush PLUS one final partial.
    const batchSize = Math.max(1, Math.floor(collected.meshes.length / 2));
    const streamed: ElementMesh[] = [];
    const batchIndices: number[] = [];
    const summary = await extractGeometryStreaming(
      entities, elementIds, elementTypes, elementNames, placementIds, repIds,
      {
        batchSize,
        onBatch: (meshes, batchIndex) => {
          for (const m of meshes) streamed.push(m);
          batchIndices.push(batchIndex);
        },
      },
    );

    // 4. ≥ 2 batches assertion (the core "actually streams" claim).
    assert.ok(
      summary.batchCount >= 2,
      `streaming should emit ≥ 2 batches with batchSize=${batchSize} ` +
      `on ${collected.meshes.length} meshes (got ${summary.batchCount})`,
    );
    assert.deepEqual(
      batchIndices,
      batchIndices.map((_, i) => i),
      'batch indices must be 0,1,2,… in order',
    );

    // 5. Byte-identicality: same count, same order, same arrays.
    assert.equal(streamed.length, collected.meshes.length, 'mesh count must match');
    assert.equal(summary.meshCount, collected.meshes.length, 'summary count must match');
    assert.equal(summary.attempted, collected.attempted);
    assert.equal(summary.skipped, collected.skipped);
    for (let i = 0; i < streamed.length; i++) {
      const a = streamed[i]!;
      const b = collected.meshes[i]!;
      assert.equal(a.expressId, b.expressId, `mesh ${i} expressId mismatch`);
      assert.equal(a.ifcType, b.ifcType, `mesh ${i} ifcType mismatch`);
      assert.equal(a.name, b.name, `mesh ${i} name mismatch`);
      assert.equal(
        a.positions.length, b.positions.length,
        `mesh ${i} (expressId=${a.expressId}) position length mismatch`,
      );
      assert.equal(
        a.indices.length, b.indices.length,
        `mesh ${i} (expressId=${a.expressId}) index length mismatch`,
      );
      // Exact-value compare on Float32 (no rounding tolerance); both
      // paths share `processElement`, so any drift is a code bug, not a
      // floating-point one.
      for (let k = 0; k < a.positions.length; k++) {
        if (a.positions[k] !== b.positions[k]) {
          assert.fail(
            `mesh ${i} (expressId=${a.expressId}) position[${k}] ` +
            `streamed=${a.positions[k]} vs collected=${b.positions[k]}`,
          );
        }
      }
      for (let k = 0; k < a.indices.length; k++) {
        if (a.indices[k] !== b.indices[k]) {
          assert.fail(
            `mesh ${i} (expressId=${a.expressId}) index[${k}] ` +
            `streamed=${a.indices[k]} vs collected=${b.indices[k]}`,
          );
        }
      }
    }
  });
});
