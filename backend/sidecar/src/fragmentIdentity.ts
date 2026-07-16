/**
 * Stable identity contract shared by fragment preprocessing operations.
 *
 * A render artifact may change geometry detail, but it must not renumber IFC
 * items or change their GUID bridge.  Keeping the comparison here makes LOD
 * and spatial-subset authoring fail closed before bytes reach the cache.
 */

import { createHash } from 'node:crypto';

export interface FragmentIdentitySnapshot {
  localIds: number[];
  guids: Array<string | null>;
  sha256: string;
}

/** Build a deterministic identity snapshot from already ID-sorted inputs. */
export function createFragmentIdentitySnapshot(
  localIds: number[],
  guids: Array<string | null>,
): FragmentIdentitySnapshot {
  if (localIds.length !== guids.length) {
    throw new Error(
      `fragment identity input mismatch: ${localIds.length} local IDs, ${guids.length} GUIDs`,
    );
  }

  const ids = [...localIds];
  const normalizedGuids = guids.map((guid) => (typeof guid === 'string' ? guid : null));
  const hash = createHash('sha256');
  for (let index = 0; index < ids.length; index++) {
    const localId = ids[index];
    if (!Number.isSafeInteger(localId) || localId < 0) {
      throw new Error(`invalid fragment local ID at index ${index}: ${localId}`);
    }
    if (index > 0 && ids[index - 1] >= localId) {
      throw new Error('fragment local IDs must be strictly increasing');
    }
    // Length-prefixed fields avoid separator ambiguity while remaining
    // streaming-friendly for very large models.  Prefixes count UTF-8 bytes
    // to match hash.update's encoding; IFC GUIDs are ASCII base64, so real
    // models keep their existing digests.
    const idText = String(localId);
    const guidText = normalizedGuids[index] ?? '';
    hash.update(`${idText.length}:${idText}${Buffer.byteLength(guidText, 'utf8')}:${guidText}`);
  }

  return { localIds: ids, guids: normalizedGuids, sha256: hash.digest('hex') };
}

/** Throw with a useful first-difference diagnostic when identities diverge. */
export function assertFragmentIdentityEqual(
  source: FragmentIdentitySnapshot,
  candidate: FragmentIdentitySnapshot,
  label = 'fragment artifact',
): void {
  if (source.localIds.length !== candidate.localIds.length) {
    throw new Error(
      `${label} identity mismatch: expected ${source.localIds.length} items, ` +
        `received ${candidate.localIds.length}`,
    );
  }

  for (let index = 0; index < source.localIds.length; index++) {
    const sourceId = source.localIds[index];
    const candidateId = candidate.localIds[index];
    const sourceGuid = source.guids[index];
    const candidateGuid = candidate.guids[index];
    if (sourceId !== candidateId || sourceGuid !== candidateGuid) {
      throw new Error(
        `${label} identity mismatch at index ${index}: ` +
          `${sourceId}/${sourceGuid ?? '<no-guid>'} -> ` +
          `${candidateId}/${candidateGuid ?? '<no-guid>'}`,
      );
    }
  }

  if (source.sha256 !== candidate.sha256) {
    throw new Error(`${label} identity digest mismatch`);
  }
}
