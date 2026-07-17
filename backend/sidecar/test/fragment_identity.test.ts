import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  assertFragmentIdentityEqual,
  createFragmentIdentitySnapshot,
} from '../src/fragmentIdentity.js';

describe('fragment artifact identity contract', () => {
  it('is deterministic and accepts an exact ID/GUID bridge', () => {
    const source = createFragmentIdentitySnapshot([4, 12], ['guid-a', null]);
    const same = createFragmentIdentitySnapshot([4, 12], ['guid-a', null]);

    assert.equal(source.sha256.length, 64);
    assert.equal(source.sha256, same.sha256);
    assert.doesNotThrow(() => assertFragmentIdentityEqual(source, same, 'LOD'));
  });

  it('fails closed on renumbering or GUID drift', () => {
    const source = createFragmentIdentitySnapshot([4, 12], ['guid-a', 'guid-b']);
    const renumbered = createFragmentIdentitySnapshot([4, 13], ['guid-a', 'guid-b']);
    const changedGuid = createFragmentIdentitySnapshot([4, 12], ['guid-a', 'guid-c']);

    assert.throws(() => assertFragmentIdentityEqual(source, renumbered), /identity mismatch/);
    assert.throws(() => assertFragmentIdentityEqual(source, changedGuid), /identity mismatch/);
  });

  it('frames non-ASCII GUIDs by UTF-8 byte length, not UTF-16 code units', () => {
    // 'é' is 1 UTF-16 code unit but 2 UTF-8 bytes; the length prefix must
    // count bytes so the hashed stream stays unambiguously framed. A digest
    // built with the UTF-16 length ("1:é") would frame ambiguously and must
    // not match the snapshot digest.
    const snapshot = createFragmentIdentitySnapshot([1], ['é']);
    const utf8Framed = createHash('sha256').update('1:12:é').digest('hex');
    const utf16Framed = createHash('sha256').update('1:11:é').digest('hex');

    assert.equal(snapshot.sha256, utf8Framed);
    assert.notEqual(snapshot.sha256, utf16Framed);
  });

  it('rejects unsorted or duplicate local IDs', () => {
    assert.throws(
      () => createFragmentIdentitySnapshot([12, 4], [null, null]),
      /strictly increasing/,
    );
    assert.throws(
      () => createFragmentIdentitySnapshot([4, 4], [null, null]),
      /strictly increasing/,
    );
  });
});
