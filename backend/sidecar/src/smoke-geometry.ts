/**
 * Smoke test the geometry extractor on BasicHouse.ifc.
 * Run: npx tsx src/smoke-geometry.ts
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { scanSections } from './parser/lexer.js';
import { buildProductMaps, extractGeometry } from './parser/geometry.js';
import type { EntityRecord } from './parser/types.js';

const FIXTURE = process.argv[2] ?? resolve(process.cwd(), '../..', 'data/fixtures/BasicHouse.ifc');
const bytes = new Uint8Array(readFileSync(FIXTURE));

console.log(`Scanning ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB...`);
const lexStart = Date.now();
const entities = new Map<number, EntityRecord>();
scanSections(bytes, {
  onEntity: (e) => entities.set(e.expressId, e),
  onHeaderRaw: () => {},
});
console.log(`  lexed ${entities.size} entities in ${Date.now() - lexStart} ms`);

const SKIP_PREFIXES = ['IFCREL','IFCPROPERTY','IFCQUANTITY','IFCPHYSICAL','IFCELEMENTQUANTITY'];
const SKIP_SUFFIXES = ['TYPE','STYLE','PROPERTIES','PORT'];
const SPATIAL = new Set(['IFCPROJECT','IFCSITE','IFCBUILDING','IFCBUILDINGSTOREY','IFCSPACE']);
const SKIP_EX  = new Set(['IFCOPENINGELEMENT','IFCOPENINGSTANDARDCASE','IFCVIRTUALELEMENT','IFCANNOTATION','IFCGRID']);
const elementIds: number[] = [];
for (const [id, e] of entities) {
  const t = e.type;
  if (SPATIAL.has(t) || SKIP_EX.has(t)) continue;
  if (SKIP_PREFIXES.some((p) => t.startsWith(p))) continue;
  if (SKIP_SUFFIXES.some((s) => t.endsWith(s))) continue;
  elementIds.push(id);
}
console.log(`  ${elementIds.length} candidate product elements`);

const { placementIds, repIds, elementTypes, elementNames } = buildProductMaps(entities, elementIds);

console.log('Extracting geometry...');
const geoStart = Date.now();
const result = extractGeometry(entities, elementIds, elementTypes, elementNames, placementIds, repIds);
console.log(`  done in ${Date.now() - geoStart} ms`);
console.log(`  attempted: ${result.attempted}, extracted: ${result.meshes.length}, skipped: ${result.skipped}`);

let totalVerts = 0, totalTris = 0;
for (const m of result.meshes) {
  totalVerts += m.positions.length / 3;
  totalTris  += m.indices.length / 3;
}
console.log(`  total vertices: ${totalVerts}, total triangles: ${totalTris}`);
console.log(`  geometry elapsedMs: ${result.elapsedMs} ms`);

console.log('\nSample meshes (first 5):');
for (const m of result.meshes.slice(0, 5)) {
  const vertCount = m.positions.length / 3;
  const triCount  = m.indices.length / 3;
  console.log(`  #${m.expressId} ${m.ifcType.padEnd(30)} "${m.name ?? ''}"  verts=${vertCount} tris=${triCount}`);
  console.log(`    bbox: [${Array.from(m.bbox).map((v) => v.toFixed(2)).join(', ')}]`);
}
