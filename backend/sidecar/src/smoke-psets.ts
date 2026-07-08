/** Quick smoke: verify property-set extraction. Run: npx tsx src/smoke-psets.ts */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseIfc } from './parser/index.js';

const FIXTURE = resolve(process.cwd(), '../..', 'data/fixtures/BasicHouse.ifc');
const bytes = new Uint8Array(readFileSync(FIXTURE));
console.log(`Parsing ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB...`);
const start = Date.now();
const idx = parseIfc(bytes, { producerVersion: 'v1.5-smoke' });
console.log(`Done in ${Date.now() - start} ms`);

const elemIds = Object.keys(idx.element_psets);
console.log(`\nElements with property sets: ${elemIds.length}`);
console.log(`Distinct pset names: ${Object.keys(idx.all_pset_names).length}`);
console.log('Sample pset names:', Object.keys(idx.all_pset_names).slice(0, 5).join(', '));

const sampleId = Number(elemIds[0]);
if (sampleId) {
  const psets = idx.element_psets[sampleId]!;
  console.log(`\nElement #${sampleId} has ${psets.length} property sets:`);
  for (const ps of psets.slice(0, 3)) {
    console.log(`  ${ps.name} (${ps.properties.length} props):`);
    for (const p of ps.properties.slice(0, 3)) {
      console.log(`    ${p.name} = ${p.value} [${p.value_type}]`);
    }
  }
}
