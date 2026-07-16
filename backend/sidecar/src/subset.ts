/**
 * ID-preserving spatial fragment subset authoring.
 *
 * `SingleThreadedFragmentsModel.getSubsetBuffer()` copies the requested items
 * plus their samples, transforms, representations, and materials directly from
 * an already-converted fragment.  This avoids rebuilding sub-IFCs (which can
 * renumber EXPRESS IDs) and makes storey/tile artifacts cheap to preprocess.
 */

import { createHash, type Hash } from 'node:crypto';

import * as FRAGS from '@thatopen/fragments';

import { ConversionCancelledError } from './converter.js';
import {
  assertFragmentIdentityEqual,
  createFragmentIdentitySnapshot,
  type FragmentIdentitySnapshot,
} from './fragmentIdentity.js';

export const SUBSET_ENVELOPE_SCHEMA_VERSION = 1;
const SUBSET_ENVELOPE_MAGIC = new TextEncoder().encode('IFCSUB01');
const MAX_SUBSET_ITEMS = 1_000_000;
const MAX_SUBSET_METADATA_BYTES = 64 * 1024 * 1024;

export interface SubsetIdentityRequest {
  sourceId: number;
  guid: string | null;
}

export interface SubsetRequestEnvelope {
  items: SubsetIdentityRequest[];
  fragmentBytes: Uint8Array;
}

export interface SubsetStats {
  requestedCount: number;
  resolvedCount: number;
  guidRemapCount: number;
  identityCount: number;
  identitySha256: string;
  identityVerified: true;
  contentSha256: string;
  contentVerified: true;
  inputBytes: number;
  outputBytes: number;
  elapsedMs: number;
}

interface VirtualModel {
  setupData: () => Promise<void>;
}

function vmOf(model: FRAGS.SingleThreadedFragmentsModel): VirtualModel {
  return (model as unknown as { _virtualModel: VirtualModel })._virtualModel;
}

/** Decode: 8-byte magic, uint32 metadata length, UTF-8 JSON, fragment bytes. */
export function decodeSubsetEnvelope(bytes: Uint8Array): SubsetRequestEnvelope {
  const prefixBytes = SUBSET_ENVELOPE_MAGIC.byteLength + 4;
  if (bytes.byteLength < prefixBytes + 1) {
    throw new Error('subset request envelope is truncated');
  }
  for (let index = 0; index < SUBSET_ENVELOPE_MAGIC.byteLength; index++) {
    if (bytes[index] !== SUBSET_ENVELOPE_MAGIC[index]) {
      throw new Error('subset request envelope has invalid magic');
    }
  }
  const metadataLength = new DataView(
    bytes.buffer,
    bytes.byteOffset + SUBSET_ENVELOPE_MAGIC.byteLength,
    4,
  ).getUint32(0, true);
  if (metadataLength <= 0 || metadataLength > MAX_SUBSET_METADATA_BYTES) {
    throw new Error(`invalid subset metadata length: ${metadataLength}`);
  }
  const fragmentOffset = prefixBytes + metadataLength;
  if (fragmentOffset >= bytes.byteLength) {
    throw new Error('subset request contains no fragment bytes');
  }

  let document: unknown;
  try {
    const metadata = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(prefixBytes, fragmentOffset),
    );
    document = JSON.parse(metadata);
  } catch {
    throw new Error('subset request metadata is not valid UTF-8 JSON');
  }
  if (!document || typeof document !== 'object') {
    throw new Error('subset request metadata must be an object');
  }
  const raw = document as { schemaVersion?: unknown; items?: unknown };
  if (raw.schemaVersion !== SUBSET_ENVELOPE_SCHEMA_VERSION) {
    throw new Error(`unsupported subset envelope schema: ${raw.schemaVersion}`);
  }
  if (!Array.isArray(raw.items) || raw.items.length === 0) {
    throw new Error('subset request must contain at least one item');
  }
  if (raw.items.length > MAX_SUBSET_ITEMS) {
    throw new Error(`subset request exceeds ${MAX_SUBSET_ITEMS} items`);
  }
  const items = raw.items.map((value, index): SubsetIdentityRequest => {
    if (!value || typeof value !== 'object') {
      throw new Error(`invalid subset item at index ${index}`);
    }
    const item = value as { sourceId?: unknown; guid?: unknown };
    if (!Number.isSafeInteger(item.sourceId) || Number(item.sourceId) < 0) {
      throw new Error(`invalid subset sourceId at index ${index}`);
    }
    if (item.guid !== null && typeof item.guid !== 'string') {
      throw new Error(`invalid subset GUID at index ${index}`);
    }
    return { sourceId: Number(item.sourceId), guid: item.guid as string | null };
  });
  return { items, fragmentBytes: bytes.subarray(fragmentOffset) };
}

async function snapshotIdentity(
  model: FRAGS.SingleThreadedFragmentsModel,
  localIds: number[],
): Promise<FragmentIdentitySnapshot> {
  return createFragmentIdentitySnapshot(localIds, model.getGuidsByLocalIds(localIds));
}

function updateNumber(hash: Hash, value: number | undefined): void {
  hash.update(value === undefined ? 'u;' : `${value};`);
}

function updateTypedArray(
  hash: Hash,
  value: ArrayBufferView | undefined,
): void {
  if (value === undefined) {
    hash.update('none;');
    return;
  }
  hash.update(`${value.constructor.name}:${value.byteLength}:`);
  hash.update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
}

/** Hash geometry bindings and material definitions for exact subset parity. */
async function contentDigest(
  model: FRAGS.SingleThreadedFragmentsModel,
  localIds: number[],
): Promise<string> {
  const hash = createHash('sha256');
  const sampleIds = new Set<number>();
  const batchSize = 500;
  for (let offset = 0; offset < localIds.length; offset += batchSize) {
    const batch = localIds.slice(offset, offset + batchSize);
    const perItem = model.getItemsGeometry(batch);
    for (let itemIndex = 0; itemIndex < batch.length; itemIndex++) {
      hash.update(`item:${batch[itemIndex]};`);
      const meshes = perItem[itemIndex] ?? [];
      hash.update(`meshes:${meshes.length};`);
      for (const mesh of meshes) {
        updateNumber(hash, mesh.localId);
        updateNumber(hash, mesh.sampleId);
        updateNumber(hash, mesh.representationId);
        if (mesh.sampleId !== undefined) sampleIds.add(mesh.sampleId);
        for (const component of mesh.transform.elements) updateNumber(hash, component);
        updateTypedArray(hash, mesh.positions);
        updateTypedArray(hash, mesh.indices);
        updateTypedArray(hash, mesh.normals);
      }
    }
  }

  const orderedSampleIds = [...sampleIds].sort((a, b) => a - b);
  const samples = await model.getSamples(orderedSampleIds);
  const materialIds = new Set<number>();
  for (const sampleId of orderedSampleIds) {
    const sample = samples.get(sampleId);
    if (!sample) throw new Error(`fragment sample ${sampleId} is missing`);
    hash.update(`sample:${sampleId};`);
    updateNumber(hash, sample.item);
    updateNumber(hash, sample.material);
    updateNumber(hash, sample.representation);
    updateNumber(hash, sample.localTransform);
    materialIds.add(sample.material);
  }

  const orderedMaterialIds = [...materialIds].sort((a, b) => a - b);
  const materials = await model.getMaterials(orderedMaterialIds);
  for (const materialId of orderedMaterialIds) {
    const material = materials.get(materialId);
    if (!material) throw new Error(`fragment material ${materialId} is missing`);
    hash.update(`material:${materialId};`);
    updateNumber(hash, material.r);
    updateNumber(hash, material.g);
    updateNumber(hash, material.b);
    updateNumber(hash, material.a);
    updateNumber(hash, material.renderedFaces);
    updateNumber(hash, material.stroke);
  }
  return hash.digest('hex');
}

function resolveRequestedLocalIds(
  model: FRAGS.SingleThreadedFragmentsModel,
  requests: SubsetIdentityRequest[],
  availableIds: Set<number>,
): { localIds: number[]; guidRemapCount: number } {
  const guidRequests = requests.filter((request) => request.guid !== null);
  const mapped = model.getLocalIdsByGuids(guidRequests.map((request) => request.guid!));
  const mappedByGuid = new Map<string, number>();
  for (let index = 0; index < guidRequests.length; index++) {
    const localId = mapped[index];
    if (localId !== null) mappedByGuid.set(guidRequests[index].guid!, localId);
  }

  const resolved = new Set<number>();
  const unresolved: SubsetIdentityRequest[] = [];
  let guidRemapCount = 0;
  for (const request of requests) {
    const guidLocalId = request.guid === null ? undefined : mappedByGuid.get(request.guid);
    if (guidLocalId !== undefined && availableIds.has(guidLocalId)) {
      resolved.add(guidLocalId);
      if (guidLocalId !== request.sourceId) guidRemapCount++;
    } else if (availableIds.has(request.sourceId)) {
      resolved.add(request.sourceId);
    } else {
      unresolved.push(request);
    }
  }
  if (unresolved.length > 0) {
    const first = unresolved[0];
    throw new Error(
      `unable to resolve ${unresolved.length} subset items; first=${first.sourceId}/` +
        `${first.guid ?? '<no-guid>'}`,
    );
  }
  return { localIds: [...resolved].sort((a, b) => a - b), guidRemapCount };
}

/** Author and fully verify a standalone, compressed spatial subset fragment. */
async function subsetFragmentsNow(
  fragBytes: Uint8Array,
  requests: SubsetIdentityRequest[],
): Promise<{ bytes: Uint8Array; stats: SubsetStats }> {
  const started = Date.now();
  const model = new FRAGS.SingleThreadedFragmentsModel('subset-source', fragBytes, false);
  await vmOf(model).setupData();
  try {
    const availableIds = new Set(await model.getLocalIds());
    const { localIds, guidRemapCount } = resolveRequestedLocalIds(
      model,
      requests,
      availableIds,
    );
    if (localIds.length === 0) throw new Error('subset resolved to zero fragment items');

    const sourceIdentity = await snapshotIdentity(model, localIds);
    const sourceContentSha256 = await contentDigest(model, localIds);
    const subsetBytes = model.getSubsetBuffer(localIds, false);
    if (subsetBytes.byteLength === 0) throw new Error('fragment subset is empty');

    const subset = new FRAGS.SingleThreadedFragmentsModel(
      'subset-verify',
      subsetBytes,
      false,
    );
    try {
      await vmOf(subset).setupData();
      const subsetLocalIds = [...(await subset.getLocalIds())].sort((a, b) => a - b);
      const subsetIdentity = await snapshotIdentity(subset, subsetLocalIds);
      assertFragmentIdentityEqual(sourceIdentity, subsetIdentity, 'spatial subset');
      const subsetContentSha256 = await contentDigest(subset, subsetLocalIds);
      if (sourceContentSha256 !== subsetContentSha256) {
        throw new Error('spatial subset geometry/material digest mismatch');
      }
    } finally {
      subset.dispose();
    }

    return {
      bytes: subsetBytes,
      stats: {
        requestedCount: requests.length,
        resolvedCount: localIds.length,
        guidRemapCount,
        identityCount: sourceIdentity.localIds.length,
        identitySha256: sourceIdentity.sha256,
        identityVerified: true,
        contentSha256: sourceContentSha256,
        contentVerified: true,
        inputBytes: fragBytes.byteLength,
        outputBytes: subsetBytes.byteLength,
        elapsedMs: Date.now() - started,
      },
    };
  } finally {
    model.dispose();
  }
}

// A cold tile build temporarily holds the full fragment plus its verified
// subset.  Serializing these jobs bounds peak memory when a frontend requests
// many uncached tiles at once; completed tiles are then served by Python's disk
// cache without returning here.
let subsetQueueTail: Promise<void> = Promise.resolve();

export function subsetFragments(
  fragBytes: Uint8Array,
  requests: SubsetIdentityRequest[],
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; stats: SubsetStats }> {
  const job = subsetQueueTail.then(async () => {
    if (signal) {
      // Same event-loop yield as the conversion executor: let a pending
      // socket-close notification abort the signal before work starts.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (signal.aborted) throw new ConversionCancelledError();
    }
    return subsetFragmentsNow(fragBytes, requests);
  });
  subsetQueueTail = job.then(
    () => undefined,
    () => undefined,
  );
  return job;
}
