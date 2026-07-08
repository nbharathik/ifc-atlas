/**
 * Quick smoke test: parse BasicHouse.ifc with the V1 native parser and
 * print summary stats. Run with `npx tsx src/smoke-parse.ts`.
 *
 * NOT a benchmark, just a "does it work?" check. The real benchmark is
 * `bench-parse.ts` (added when the HTTP route is wired).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseIfc } from './parser/index.js';

const REPO_ROOT = resolve(process.cwd(), '../..');
const FIXTURE = process.argv[2] ?? resolve(REPO_ROOT, 'data/fixtures/BasicHouse.ifc');

console.log(`Reading ${FIXTURE}...`);
const readStart = Date.now();
const bytes = readFileSync(FIXTURE);
const readMs = Date.now() - readStart;
console.log(`  read ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB in ${readMs} ms`);

console.log('Parsing...');
const parseStart = Date.now();
const index = parseIfc(bytes, { producerVersion: 'smoke' });
const parseMs = Date.now() - parseStart;

console.log(`Done in ${parseMs} ms total (lex ${index.stats.lex_ms} ms, build ${index.stats.index_ms} ms).`);
console.log('');
console.log('Summary:');
console.log(`  schema:           ${index.schema}`);
console.log(`  source_sha256:    ${index.source_sha256.slice(0, 16)}...`);
console.log(`  source_bytes:     ${index.source_bytes}`);
console.log(`  total entities:   ${index.stats.entityCount}`);
console.log(`  warnings:         ${index.stats.warningCount}`);
console.log('');
console.log(`  project:          ${index.project?.name ?? '(none)'}`);
console.log(`  storeys:          ${index.stats.storey_count}`);
console.log(`  elements:         ${index.stats.element_count}`);
console.log(`  materials:        ${index.materials.length}`);
console.log('');

console.log('Top 10 element types:');
const sorted = Object.entries(index.by_type).sort((a, b) => b[1] - a[1]).slice(0, 10);
for (const [type, count] of sorted) {
  console.log(`  ${type.padEnd(40)} ${count}`);
}

if (index.stats.warningCount > 0) {
  console.log('');
  console.log('First warnings:');
  for (const w of index.stats.warnings.slice(0, 5)) console.log(`  ${w}`);
}

console.log('');
console.log('Spatial roots:');
for (const id of index.spatial_roots) {
  const node = index.spatial[id];
  console.log(`  #${id} ${node.type} "${node.name}"`);
}

console.log('');
console.log('Storeys (first 5):');
for (const id of index.storey_ids.slice(0, 5)) {
  const node = index.spatial[id];
  const elementCount = (index.ids_by_storey[id] ?? []).length;
  console.log(`  #${id} "${node.name}" → ${elementCount} elements`);
}
