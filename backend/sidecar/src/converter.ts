/**
 * Fragment-conversion core: run `@thatopen/fragments` IfcImporter in Node
 * and return a `.frag` Uint8Array. Called by the HTTP server in `index.ts`.
 *
 * Part of the IFC Atlas native engine.
 */

import * as FRAGS from '@thatopen/fragments';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  configureImporter,
  getWebIfcSettingsForProfile,
  resolveParseProfile,
  type ParseProfile,
} from './profiles.js';

export interface ConvertResult {
  /** The produced fragment binary. */
  bytes: Uint8Array;
  /** Profile actually used (after auto-promotion). */
  effectiveProfile: ParseProfile;
  /** Wall-clock milliseconds. */
  elapsedMs: number;
  /** Progress events captured during conversion (last few). */
  stages: Array<{ stage: string; progress: number; at: number }>;
}

export interface ConvertOptions {
  profile: ParseProfile;
  /** Called on each progress update. */
  onProgress?: (stage: string, progress: number) => void;
}

/**
 * Resolve the web-ifc WASM directory. The importer needs the absolute path
 * because we pass `wasm.absolute = true`. Two layouts:
 *
 * 1. Bundled: `npm run build` (build.mjs) stages the .wasm files next to
 *    `dist/index.cjs`, so an installed app needs no node_modules. The
 *    bundle keeps `import.meta.url` meaningful via a build-time define.
 * 2. Dev (tsx on src/): fall back to `node_modules/web-ifc/*.wasm`.
 *    web-ifc ships an `exports` map that blocks `require.resolve('web-ifc/package.json')`,
 *    so resolve the main entry instead and take its dirname.
 */
function resolveWebIfcWasmDir(): string {
  const selfDir = dirname(fileURLToPath(import.meta.url));
  if (existsSync(pathResolve(selfDir, 'web-ifc-node.wasm'))) {
    return selfDir + '/';
  }
  const require = createRequire(import.meta.url);
  // This resolves to node_modules/web-ifc/web-ifc-api-node.js (the CJS entry).
  const webIfcEntry = require.resolve('web-ifc');
  return dirname(webIfcEntry) + '/';
}

let cachedImporter: FRAGS.IfcImporter | null = null;
let cachedWasmDir: string | null = null;

/**
 * Lazily create one shared IfcImporter and reuse it across conversions.
 * The importer caches the WASM module after first use, which saves ~500ms
 * on the second+ conversion.
 */
async function getImporter(): Promise<FRAGS.IfcImporter> {
  if (cachedImporter) return cachedImporter;
  const wasmDir = cachedWasmDir ?? (cachedWasmDir = resolveWebIfcWasmDir());
  const importer = new FRAGS.IfcImporter();
  importer.wasm.path = wasmDir;
  importer.wasm.absolute = true;
  cachedImporter = importer;
  return importer;
}

/** Convert IFC bytes → fragment binary using the chosen profile. */
export async function convert(
  bytes: Uint8Array,
  options: ConvertOptions,
): Promise<ConvertResult> {
  const started = Date.now();
  const stages: Array<{ stage: string; progress: number; at: number }> = [];

  const effectiveProfile = resolveParseProfile(options.profile, bytes.byteLength);

  // Reset the importer to a clean state for each conversion: the importer
  // mutates its own class sets when `configureImporter` deletes categories.
  // Rebuilding defeats the WASM cache we just set up, so instead we back up
  // and restore the mutable state.
  const importer = await getImporter();
  const savedClasses = {
    elements: new Set(importer.classes.elements),
    abstract: new Set(importer.classes.abstract),
  };
  const savedRelations = new Map(importer.relations);
  const savedAttrsExcluded = new Set(importer.attributesToExclude);

  try {
    importer.webIfcSettings = {
      ...importer.webIfcSettings,
      ...getWebIfcSettingsForProfile(effectiveProfile),
    };
    configureImporter(importer, effectiveProfile);

    const bytesOut = await importer.process({
      bytes,
      progressCallback: (progress, data) => {
        const stageName = String(data?.process ?? 'parsing');
        const norm = Number.isFinite(progress)
          ? (progress <= 1 ? progress * 100 : progress)
          : 0;
        if (options.onProgress) options.onProgress(stageName, norm);
        stages.push({ stage: stageName, progress: norm, at: Date.now() - started });
      },
    });

    return {
      bytes: bytesOut,
      effectiveProfile,
      elapsedMs: Date.now() - started,
      stages: stages.slice(-20), // keep last 20 for telemetry
    };
  } finally {
    // Restore importer state so the next call starts from the library
    // defaults, not this call's mutated version.
    importer.classes.elements.clear();
    for (const id of savedClasses.elements) importer.classes.elements.add(id);
    importer.classes.abstract.clear();
    for (const id of savedClasses.abstract) importer.classes.abstract.add(id);
    importer.relations = savedRelations;
    importer.attributesToExclude.clear();
    for (const attr of savedAttrsExcluded) importer.attributesToExclude.add(attr);
  }
}

/** Expose the resolved wasm directory for `/health` diagnostics. */
export function getWasmDir(): string {
  if (!cachedWasmDir) cachedWasmDir = resolveWebIfcWasmDir();
  return cachedWasmDir;
}

// Silence "unused variable" in case resolve helper is imported for tests.
export const _internal = { pathResolve, fileURLToPath };
