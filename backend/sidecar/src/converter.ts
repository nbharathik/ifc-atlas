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
 * Build a FIFO executor for async work. Rejections are observed on the
 * returned promise but are swallowed on the internal tail so one failed job
 * never blocks the jobs queued behind it.
 */
function createSerialExecutor(): <T>(work: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();

  return <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

// IfcImporter is mutable: profiles temporarily rewrite its class sets and
// settings around process(). Keep the WASM-warmed importer, but never let two
// requests configure or use it concurrently.
const runConversionSerial = createSerialExecutor();

interface ImporterStateSnapshot {
  classes: {
    elements: Set<number>;
    abstract: Set<number>;
  };
  relations: FRAGS.IfcImporter['relations'];
  attributesToExclude: Set<string>;
  webIfcSettings: FRAGS.IfcImporter['webIfcSettings'];
  geometryProcessSettings: FRAGS.GeometryProcessSettings;
  replaceStoreyElevation: boolean;
  replaceSiteElevation: boolean;
  includeUniqueAttributes: boolean;
  includeRelationNames: boolean;
  distanceThreshold: number | null;
}

function cloneRelations(
  relations: FRAGS.IfcImporter['relations'],
): FRAGS.IfcImporter['relations'] {
  return new Map(
    [...relations].map(([type, relation]) => [type, { ...relation }]),
  );
}

function cloneGeometryProcessSettings(
  settings: FRAGS.GeometryProcessSettings,
): FRAGS.GeometryProcessSettings {
  const cloned = { ...settings };
  if (settings.categoryFaceThresholds) {
    cloned.categoryFaceThresholds = new Map(settings.categoryFaceThresholds);
  } else {
    delete cloned.categoryFaceThresholds;
  }
  return cloned;
}

/** Capture every public importer field changed by profile configuration. */
function snapshotImporterState(importer: FRAGS.IfcImporter): ImporterStateSnapshot {
  return {
    classes: {
      elements: new Set(importer.classes.elements),
      abstract: new Set(importer.classes.abstract),
    },
    relations: cloneRelations(importer.relations),
    attributesToExclude: new Set(importer.attributesToExclude),
    webIfcSettings: { ...importer.webIfcSettings },
    geometryProcessSettings: cloneGeometryProcessSettings(importer.geometryProcessSettings),
    replaceStoreyElevation: importer.replaceStoreyElevation,
    replaceSiteElevation: importer.replaceSiteElevation,
    includeUniqueAttributes: importer.includeUniqueAttributes,
    includeRelationNames: importer.includeRelationNames,
    distanceThreshold: importer.distanceThreshold,
  };
}

/** Restore a snapshot without retaining mutable Map/Set references from it. */
function restoreImporterState(
  importer: FRAGS.IfcImporter,
  saved: ImporterStateSnapshot,
): void {
  importer.classes.elements.clear();
  for (const id of saved.classes.elements) importer.classes.elements.add(id);
  importer.classes.abstract.clear();
  for (const id of saved.classes.abstract) importer.classes.abstract.add(id);
  importer.relations = cloneRelations(saved.relations);
  importer.attributesToExclude.clear();
  for (const attr of saved.attributesToExclude) importer.attributesToExclude.add(attr);
  importer.webIfcSettings = { ...saved.webIfcSettings };
  importer.geometryProcessSettings = cloneGeometryProcessSettings(saved.geometryProcessSettings);
  importer.replaceStoreyElevation = saved.replaceStoreyElevation;
  importer.replaceSiteElevation = saved.replaceSiteElevation;
  importer.includeUniqueAttributes = saved.includeUniqueAttributes;
  importer.includeRelationNames = saved.includeRelationNames;
  importer.distanceThreshold = saved.distanceThreshold;
}

function applyImporterProfile(importer: FRAGS.IfcImporter, profile: ParseProfile): void {
  importer.webIfcSettings = {
    ...importer.webIfcSettings,
    ...getWebIfcSettingsForProfile(profile),
  };
  configureImporter(importer, profile);
}

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

  return runConversionSerial(async () => {
    // Reset the importer to a clean state for each conversion: the importer
    // mutates its own class sets when `configureImporter` deletes categories.
    // Rebuilding defeats the WASM cache we just set up, so instead we back up
    // and restore the mutable state. The serial executor above makes this
    // save/configure/process/restore transaction exclusive.
    const importer = await getImporter();
    const saved = snapshotImporterState(importer);

    try {
      applyImporterProfile(importer, effectiveProfile);

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
      restoreImporterState(importer, saved);
    }
  });
}

/** Expose the resolved wasm directory for `/health` diagnostics. */
export function getWasmDir(): string {
  if (!cachedWasmDir) cachedWasmDir = resolveWebIfcWasmDir();
  return cachedWasmDir;
}

// Silence "unused variable" in case resolve helper is imported for tests.
export const _internal = {
  pathResolve,
  fileURLToPath,
  createSerialExecutor,
  snapshotImporterState,
  restoreImporterState,
  applyImporterProfile,
};
