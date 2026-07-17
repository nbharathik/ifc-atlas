/**
 * Offline `.frag` LOD decimation for the IFC Atlas native engine.
 *
 * The input is an ALREADY-CONVERTED
 * `@thatopen/fragments` `.frag` (there is no IFC / web-ifc step here); the output
 * is a smaller `.frag` with fewer triangles that preserves element identity
 * (localIds + GUIDs + spatial structure) so the existing render + id-bridge +
 * picking paths keep working unchanged.
 *
 * Pipeline, per SHELL representation:
 *   read shell geometry (aggregating the multiple 16-bit index-split chunks the
 *   fragments API delivers per representation) -> weld coincident vertices
 *   (`MeshoptSimplifier.generatePositionRemap`) -> `MeshoptSimplifier.simplifySloppy`
 *   (plain `simplify` does NOTHING on the heavily non-manifold BIM shells;
 *   simplifySloppy ignores topology and reliably reduces) -> rebuild a
 *   `THREE.BufferGeometry` -> `FRAGS.GeomsFbUtils.representationFromGeometry` ->
 *   push an `UPDATE_REPRESENTATION` edit request.
 * Then bake every request via `_virtualModel.save()` and re-compress to a `.frag`.
 *
 * Non-SHELL representations (e.g. CIRCLE_EXTRUSION) are skipped: they are not
 * re-encodable as shells and `representationFromGeometry` throws on them.
 *
 * The decimated model is shown during navigation and the full model at rest.
 */

import * as FRAGS from '@thatopen/fragments';
import { MeshoptSimplifier } from 'meshoptimizer';
import * as THREE from 'three';

import {
  assertFragmentIdentityEqual,
  createFragmentIdentitySnapshot,
  type FragmentIdentitySnapshot,
} from './fragmentIdentity.js';

// Defaults proven on a large model (5.68M -> 1.77M tris, ~31%, identity preserved).
export const DEFAULT_TARGET_RATIO = 0.35; // aim ~35% of original index count per shell
export const DEFAULT_SLOPPY_ERROR = 0.05; // relative error ceiling for sloppy simplification
// Only decimate DENSE shells. BIM triangle mass is concentrated in a few dense
// representations (furniture, fixtures, curved fittings - the largest
// shell alone holds 371k tris) while the visible architecture (walls, slabs,
// windows) is simple prismatic geometry with a handful of triangles per shell.
// Decimating those low-tri shells is what tore facades apart visually (sloppy
// merges across features -> triangular gashes) while contributing almost
// nothing to the reduction. Keeping everything under this threshold EXACT
// makes the LOD near-indistinguishable during navigation and costs only a few
// percent of the triangle budget.
const MIN_TRIS_TO_DECIMATE = 2000;

// Per-category preservation: simplifySloppy
// ignores topology, so it collapses the thin cross-section of elongated shells
// (window mullions, railings, pipes, thin bracing) - the one place the LOD
// looks bad up close. A shell is "elongated" when its middle bounding-box
// extent is tiny relative to its longest (a bar/tube: one long axis, two thin
// ones). We keep those FULL. They hold few triangles, so preserving them barely
// changes the total triangle count - the FPS win (from the bulky walls/slabs)
// is untouched. Flat slabs/walls have a large mid extent and are NOT preserved.
const PRESERVE_ELONGATED_RATIO = 0.12;

/** True when a shell is bar/tube-like (mid extent << longest extent). */
function isElongatedShell(positions: Float32Array | Float64Array, ratio: number): boolean {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
  }
  const extents = [maxX - minX, maxY - minY, maxZ - minZ].sort((a, b) => b - a);
  const longest = extents[0];
  const middle = extents[1];
  if (!Number.isFinite(longest) || longest <= 0) return false;
  return middle / longest < ratio;
}

export interface DecimateStats {
  reprsTotal: number;
  shellReprs: number;
  decimated: number;
  skippedSmall: number;
  skippedThin: number;
  notReduced: number;
  skippedErr: number;
  trisBefore: number;
  trisAfter: number;
  inputBytes: number;
  outputBytes: number;
  elapsedMs: number;
  targetRatio: number;
  targetError: number;
  achievedMaxError: number;
  achievedWeightedMeanError: number;
  identityCount: number;
  identitySha256: string;
  identityVerified: true;
}

export interface DecimateOptions {
  /** Target fraction of the original per-shell index count. Clamped to (0, 1). Default 0.35. */
  ratio?: number;
  /** Relative error ceiling for `simplifySloppy`. Clamped to >= 0. Default 0.05. */
  error?: number;
  /** Optional progress hook; `progress` is roughly 0-100. */
  onProgress?: (stage: string, progress: number) => void;
  /** Optional stats sink, invoked once when the decimation finishes. */
  onStats?: (stats: DecimateStats) => void;
}

// Minimal structural view of the private virtual model the fragments loader
// exposes. The public API does not surface these, but they
// are stable on 3.4.x and are the only way to author a `.frag` headless.
interface VirtualModel {
  setupData: () => Promise<void>;
  requests: unknown[];
  save: () => Uint8Array;
  getRepresentations: (ids?: Iterable<number>) => Map<number, FRAGS.RawRepresentation>;
}

function vmOf(model: FRAGS.SingleThreadedFragmentsModel): VirtualModel {
  return (model as unknown as { _virtualModel: VirtualModel })._virtualModel;
}

async function snapshotIdentity(
  model: FRAGS.SingleThreadedFragmentsModel,
): Promise<FragmentIdentitySnapshot> {
  const localIds = [...(await model.getLocalIds())].sort((a, b) => a - b);
  return createFragmentIdentitySnapshot(localIds, model.getGuidsByLocalIds(localIds));
}

/** Concatenate shell geometry chunks (16-bit index splits) into one geometry. */
function concatChunks(
  chunks: Array<{
    positions: Float32Array | Float64Array;
    indices: Uint8Array | Uint16Array | Uint32Array;
  }>,
): { positions: Float32Array; indices: Uint32Array } {
  let totalPos = 0;
  let totalIdx = 0;
  for (const c of chunks) {
    totalPos += c.positions.length;
    totalIdx += c.indices.length;
  }
  const positions = new Float32Array(totalPos);
  const indices = new Uint32Array(totalIdx);
  let posOff = 0;
  let idxOff = 0;
  let vertOff = 0;
  for (const c of chunks) {
    positions.set(c.positions, posOff);
    for (let i = 0; i < c.indices.length; i++) indices[idxOff + i] = c.indices[i] + vertOff;
    posOff += c.positions.length;
    idxOff += c.indices.length;
    vertOff += c.positions.length / 3;
  }
  return { positions, indices };
}

function clampRatio(ratio: number | undefined): number {
  if (ratio === undefined || !Number.isFinite(ratio)) return DEFAULT_TARGET_RATIO;
  // Must reduce (< 1) and stay positive. Keep a hair below 1 so a repr always
  // shrinks when it is decimated at all.
  return Math.min(0.99, Math.max(0.01, ratio));
}

function clampError(error: number | undefined): number {
  if (error === undefined || !Number.isFinite(error)) return DEFAULT_SLOPPY_ERROR;
  return Math.max(0, error);
}

/**
 * Decimate an already-converted `.frag` and return a new, smaller `.frag`.
 *
 * @param fragBytes  raw bytes of a compressed `.frag` (as produced by `convert`).
 * @param opts       ratio / error overrides + optional progress + stats hooks.
 * @returns          bytes of the decimated `.frag`, loadable by the frontend.
 * @throws           if no SHELL representation could be reduced (caller should
 *                   degrade to serving the full model).
 */
export async function decimateFragments(
  fragBytes: Uint8Array,
  opts: DecimateOptions = {},
): Promise<Uint8Array> {
  const started = Date.now();
  const targetRatio = clampRatio(opts.ratio);
  const sloppyError = clampError(opts.error);
  const onProgress = opts.onProgress ?? (() => {});

  await MeshoptSimplifier.ready;
  onProgress('load', 2);

  // Load the compressed `.frag` headless (third arg false = input is compressed).
  const model = new FRAGS.SingleThreadedFragmentsModel('lod-src', fragBytes, false);
  const vm = vmOf(model);
  // The constructor kicks off setupData() but does not await it; await tile
  // generation so getItemsGeometry can read shell triangles.
  await vm.setupData();
  const sourceIdentity = await snapshotIdentity(model);
  onProgress('load', 8);

  try {
    // Which representations are SHELLs (only those can be re-encoded as shells).
    const allReprs = vm.getRepresentations();
    const shellReprIds = new Set<number>();
    for (const [id, repr] of allReprs) {
      if (repr.representationClass === FRAGS.RepresentationClass.SHELL) shellReprIds.add(id);
    }

    // Collect local triangle geometry per representation. Shell geometry is
    // shared (the per-sample transform is separate), so decimating a shell once
    // updates every referencing instance. A single shell is delivered by
    // getItemsGeometry as MULTIPLE chunks (16-bit index splits); aggregate ALL
    // chunks of a representation - taken from the first item that references it -
    // into one full-resolution geometry before decimating.
    const reprGeom = new Map<number, { positions: Float32Array; indices: Uint32Array }>();
    const itemsWithGeom = model.getItemsWithGeometry();
    const BATCH = 500;
    for (let i = 0; i < itemsWithGeom.length; i += BATCH) {
      const batch = itemsWithGeom.slice(i, i + BATCH);
      const perItem = model.getItemsGeometry(batch);
      for (const meshes of perItem) {
        const chunksByRepr = new Map<
          number,
          Array<{
            positions: Float32Array | Float64Array;
            indices: Uint8Array | Uint16Array | Uint32Array;
          }>
        >();
        for (const mesh of meshes) {
          const rid = mesh.representationId;
          if (rid === undefined || !shellReprIds.has(rid)) continue;
          if (reprGeom.has(rid)) continue; // already captured from an earlier item
          if (!mesh.indices || !mesh.positions) continue;
          let arr = chunksByRepr.get(rid);
          if (!arr) {
            arr = [];
            chunksByRepr.set(rid, arr);
          }
          arr.push({ positions: mesh.positions, indices: mesh.indices });
        }
        for (const [rid, chunks] of chunksByRepr) {
          reprGeom.set(rid, concatChunks(chunks));
        }
      }
      // Reading geometry dominates the wall-clock time; map it onto 8 -> 55%.
      if (itemsWithGeom.length > 0) {
        onProgress(
          'read',
          8 + Math.round((Math.min(i + BATCH, itemsWithGeom.length) / itemsWithGeom.length) * 47),
        );
      }
    }

    // Decimate each representation and build UPDATE_REPRESENTATION requests.
    const rawSettings: FRAGS.GeometryProcessSettings = {
      threshold: 0, // force the simple raw-shell path (1 triangle -> 1 profile)
      precision: 1e6,
      normalPrecision: 1e7,
      planePrecision: 1e3,
      faceThreshold: 0.6,
      forceTransparentSpaces: true,
    };

    const requests: FRAGS.EditRequest[] = [];
    let decimated = 0;
    let skippedSmall = 0;
    let skippedThin = 0;
    let notReduced = 0;
    let skippedErr = 0;
    let triBefore = 0;
    let triAfter = 0;
    let decimatedTriBefore = 0; // decimated shells only; weights the mean error
    let maxAchievedError = 0;
    let weightedErrorTotal = 0;

    let processed = 0;
    for (const [rid, geom] of reprGeom) {
      processed++;
      const triCount = geom.indices.length / 3;
      // Whole-model stats: every shell counts toward "before"; shells left
      // untouched keep their full triangle count in "after".
      triBefore += triCount;
      if (triCount < MIN_TRIS_TO_DECIMATE) {
        skippedSmall++;
        triAfter += triCount;
        continue;
      }
      // Per-category: keep elongated/thin shells full (see PRESERVE_ELONGATED_RATIO).
      if (isElongatedShell(geom.positions, PRESERVE_ELONGATED_RATIO)) {
        skippedThin++;
        triAfter += triCount;
        continue;
      }
      try {
        // Weld coincident vertices (fragments delivers unwelded per-triangle
        // vertices) so simplification operates on shared topology.
        const remap = MeshoptSimplifier.generatePositionRemap(geom.positions, 3);
        const weldedIndices = new Uint32Array(geom.indices.length);
        for (let i = 0; i < geom.indices.length; i++) weldedIndices[i] = remap[geom.indices[i]];

        const targetIndexCount = Math.max(
          3,
          Math.floor((geom.indices.length * targetRatio) / 3) * 3,
        );
        const [newIndex, achievedError] = MeshoptSimplifier.simplifySloppy(
          weldedIndices,
          geom.positions,
          3,
          null,
          targetIndexCount,
          sloppyError,
        );
        if (newIndex.length >= geom.indices.length || newIndex.length < 3) {
          notReduced++;
          triAfter += triCount;
          continue;
        }
        const bg = new THREE.BufferGeometry();
        bg.setAttribute('position', new THREE.BufferAttribute(geom.positions, 3));
        bg.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(geom.positions.length), 3));
        bg.setIndex(new THREE.BufferAttribute(new Uint32Array(newIndex), 1));

        const existing = allReprs.get(rid);
        const newRepr = FRAGS.GeomsFbUtils.representationFromGeometry(bg, existing, rawSettings);
        newRepr.id = rid;

        requests.push({
          type: FRAGS.EditRequestType.UPDATE_REPRESENTATION,
          localId: rid,
          data: newRepr,
        } as FRAGS.UpdateRepresentationRequest);

        triAfter += newIndex.length / 3;
        decimatedTriBefore += triCount;
        maxAchievedError = Math.max(maxAchievedError, achievedError);
        weightedErrorTotal += achievedError * triCount;
        decimated++;
      } catch {
        // Non-shell / unsupported repr geometry (e.g. CIRCLE_EXTRUSION) throws
        // in representationFromGeometry - skip it, keep the original shell.
        skippedErr++;
        triAfter += triCount;
      }
      if (reprGeom.size > 0) {
        onProgress('decimate', 55 + Math.round((processed / reprGeom.size) * 35));
      }
    }

    if (requests.length === 0) {
      throw new Error(
        `no representation edits produced (shells=${shellReprIds.size}, ` +
          `skippedSmall=${skippedSmall}, notReduced=${notReduced}, skippedErr=${skippedErr})`,
      );
    }

    // Bake edits into a full model buffer via save() (delta:false).
    onProgress('bake', 92);
    for (const r of requests) vm.requests.push(r);
    const fullRaw = vm.save(); // uncompressed full model with edits applied

    // Re-wrap raw (third arg true = uncompressed) and compress to a `.frag`.
    const lodModel = new FRAGS.SingleThreadedFragmentsModel('lod-write', fullRaw, true);
    let out: Uint8Array;
    try {
      // setupData validates that the authored buffer can generate its geometry
      // indices.  Then prove that every local ID/GUID pair survived before the
      // result is compressed or offered to the backend cache.
      await vmOf(lodModel).setupData();
      const outputIdentity = await snapshotIdentity(lodModel);
      assertFragmentIdentityEqual(sourceIdentity, outputIdentity, 'LOD artifact');

      const compressed = lodModel.getBuffer(false); // pako.deflate
      out =
        compressed instanceof Uint8Array
          ? compressed
          : new Uint8Array(compressed as ArrayBuffer);
    } finally {
      lodModel.dispose();
    }
    onProgress('done', 100);

    if (opts.onStats) {
      opts.onStats({
        reprsTotal: allReprs.size,
        shellReprs: shellReprIds.size,
        decimated,
        skippedSmall,
        skippedThin,
        notReduced,
        skippedErr,
        trisBefore: Math.round(triBefore),
        trisAfter: Math.round(triAfter),
        inputBytes: fragBytes.byteLength,
        outputBytes: out.byteLength,
        elapsedMs: Date.now() - started,
        targetRatio,
        targetError: sloppyError,
        achievedMaxError: maxAchievedError,
        achievedWeightedMeanError:
          decimatedTriBefore > 0 ? weightedErrorTotal / decimatedTriBefore : 0,
        identityCount: sourceIdentity.localIds.length,
        identitySha256: sourceIdentity.sha256,
        identityVerified: true,
      });
    }

    return out;
  } finally {
    model.dispose();
  }
}
