import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as FRAGS from '@thatopen/fragments';

import { convert } from '../src/converter.js';
import { subsetFragments } from '../src/subset.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASIC_HOUSE = resolve(HERE, '../../../data/fixtures/BasicHouse.ifc');

interface VirtualModel {
  setupData: () => Promise<void>;
}

function vmOf(model: FRAGS.SingleThreadedFragmentsModel): VirtualModel {
  return (model as unknown as { _virtualModel: VirtualModel })._virtualModel;
}

describe('BasicHouse ID-preserving fragment subset', () => {
  if (!existsSync(BASIC_HOUSE)) {
    it('skipped - BasicHouse.ifc fixture is unavailable', () => {});
    return;
  }

  it('reloads standalone with exact IDs, GUIDs, geometry, and materials', async () => {
    const ifcBytes = new Uint8Array(await readFile(BASIC_HOUSE));
    const converted = await convert(ifcBytes, { profile: 'performance' });
    const source = new FRAGS.SingleThreadedFragmentsModel(
      'subset-test-source',
      converted.bytes,
      false,
    );
    await vmOf(source).setupData();
    try {
      const localIds = [...source.getItemsWithGeometry()].sort((a, b) => a - b).slice(0, 8);
      const guids = source.getGuidsByLocalIds(localIds);
      const requests = localIds.map((sourceId, index) => ({
        // Prove GUID mapping wins when an IFC-side ID hint is not the fragment local ID.
        sourceId: index === 0 ? sourceId + 999_999 : sourceId,
        guid: guids[index],
      }));
      const result = await subsetFragments(converted.bytes, requests);

      assert.equal(result.stats.identityVerified, true);
      assert.equal(result.stats.contentVerified, true);
      assert.equal(result.stats.resolvedCount, localIds.length);
      assert.equal(result.stats.guidRemapCount, 1);
      assert.ok(result.bytes.byteLength < converted.bytes.byteLength);

      const subset = new FRAGS.SingleThreadedFragmentsModel(
        'subset-test-output',
        result.bytes,
        false,
      );
      try {
        await vmOf(subset).setupData();
        assert.deepEqual([...(await subset.getLocalIds())].sort((a, b) => a - b), localIds);
        assert.deepEqual(subset.getGuidsByLocalIds(localIds), guids);
        assert.deepEqual([...subset.getItemsWithGeometry()].sort((a, b) => a - b), localIds);
      } finally {
        subset.dispose();
      }
    } finally {
      source.dispose();
    }
  });
});
