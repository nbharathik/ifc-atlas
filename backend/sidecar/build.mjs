/**
 * Bundle the sidecar into a single self-contained CJS file.
 *
 * Output:
 *   dist/index.cjs          - everything (server + parser + fragments +
 *                             three + web-ifc glue) in one file
 *   dist/web-ifc*.wasm      - the web-ifc binaries, staged next to the
 *                             bundle so `resolveWebIfcWasmDir()` in
 *                             converter.ts finds them without node_modules
 *
 * `backend/app/services/sidecar_manager.py` prefers `node dist/index.cjs`
 * over the `npx tsx src/index.ts` dev fallback when this output exists,
 * so installed apps only need a Node runtime on PATH.
 *
 * Run with `npm run build` from backend/sidecar/.
 */

import { build } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'dist');

// Clean stale output (older tsc builds emitted per-module .js files here).
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(here, 'src', 'index.ts')],
  outfile: join(outDir, 'index.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: false,
  logLevel: 'info',
  // The source is ESM and uses `import.meta.url` (converter.ts wasm-dir
  // resolution; fragments' lazy worker URL). In the CJS output that would
  // become `undefined`, so rebind it to this file's URL via define+banner.
  define: { 'import.meta.url': '__ifcSidecarImportMetaUrl' },
  banner: {
    js: "const __ifcSidecarImportMetaUrl = require('node:url').pathToFileURL(__filename).href;",
  },
});

// web-ifc reads its wasm from `wasm.path + filename` with fs at runtime
// (converter.ts passes the directory with `absolute = true`). Stage the
// binaries next to the bundle; -node is the one Node actually loads, the
// other two ride along for the multithreaded/browser code paths web-ifc
// may probe.
const require = createRequire(import.meta.url);
const webIfcDir = dirname(require.resolve('web-ifc'));
for (const name of ['web-ifc-node.wasm', 'web-ifc.wasm', 'web-ifc-mt.wasm']) {
  copyFileSync(join(webIfcDir, name), join(outDir, name));
}

console.log('[sidecar build] dist/index.cjs + web-ifc wasm staged');
