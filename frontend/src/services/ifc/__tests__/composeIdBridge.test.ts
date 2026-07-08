import { describe, expect, it } from 'vitest';

import { composeIdBridge } from '../composeIdBridge';

describe('composeIdBridge', () => {
  // The bug this guards against: the bridge used to be composed from a
  // 'GlobalId' ATTRIBUTE read off getItemsData rows - but fragments ≥3.x
  // store GUIDs in a dedicated table, not as an attribute, so the bridge
  // came up empty for every model. With an empty bridge each viewer click
  // dispatched the raw fragment-space raycast id; on server-converted models
  // the backend resolved that to a colliding low-numbered STEP row (its
  // owner-walk lands on an IfcSpace), so clicking a wall showed IfcSpace
  // properties. The fix composes index GUID→express entries with the
  // fragment guids-table lookup (getLocalIdsByGuids), zipped by position.

  it('zips guid→express entries with their positional localId lookups', () => {
    const entries: Array<readonly [string, number]> = [
      ['2giSrto6n508qdtAoUv3MU', 313954], // a wall
      ['0DIiXeGSX5cf$bfYY4Em9I', 182],    // a space
    ];
    const localIds = [4101, 77];

    const bridge = composeIdBridge(entries, localIds);

    expect(bridge.get(4101)).toBe(313954);
    expect(bridge.get(77)).toBe(182);
    expect(bridge.size).toBe(2);
  });

  it('drops entries whose GUID has no fragment item (null localId)', () => {
    // Index GUIDs that don't exist in the fragment (e.g. property sets,
    // or geometry the parse profile skipped) resolve to null - they must
    // not produce bridge entries.
    const entries: Array<readonly [string, number]> = [
      ['guidWithGeometry000001', 1066],
      ['guidPsetNoFragment0002', 555],
    ];
    const localIds = [12, null];

    const bridge = composeIdBridge(entries, localIds);

    expect(bridge.size).toBe(1);
    expect(bridge.get(12)).toBe(1066);
  });

  it('returns an empty map for empty inputs', () => {
    expect(composeIdBridge([], []).size).toBe(0);
  });

  it('tolerates a lookup result shorter than the entry list', () => {
    const entries: Array<readonly [string, number]> = [
      ['guidA00000000000000001', 100],
      ['guidB00000000000000002', 200],
    ];
    // Defensive: a truncated worker response must not throw or mis-zip.
    const bridge = composeIdBridge(entries, [7]);

    expect(bridge.size).toBe(1);
    expect(bridge.get(7)).toBe(100);
  });
});
