/**
 * Compose the localId→expressId selection bridge by zipping the backend
 * metadata index's GUID→express entries with the fragment model's native
 * guids-table lookup (`FragmentsModel.getLocalIdsByGuids`) for those same
 * GUIDs, in the same order.
 *
 * WHY THE GUIDS TABLE: fragments ≥3.x do NOT store GlobalId as a per-item
 * attribute - `getItemsData()` rows carry no 'GlobalId' key at all (GUIDs
 * live in a dedicated flatbuffers table). Reading the attribute silently
 * yields an empty bridge, so every viewer click fell back to the raw
 * fragment-space raycast id. On server-converted models that id collides
 * with unrelated low-numbered STEP rows, and the backend's owner-walk then
 * resolves those rows to whatever product owns them - which is how clicking
 * a wall showed IfcSpace properties. See resolveHitProductId.ts for the
 * dispatch side of this contract.
 */
export function composeIdBridge(
  guidExpressEntries: ReadonlyArray<readonly [string, number]>,
  localIdsForGuids: ReadonlyArray<number | null>,
): Map<number, number> {
  const bridge = new Map<number, number>();
  const n = Math.min(guidExpressEntries.length, localIdsForGuids.length);
  for (let i = 0; i < n; i++) {
    const localId = localIdsForGuids[i];
    if (typeof localId === 'number') bridge.set(localId, guidExpressEntries[i][1]);
  }
  return bridge;
}
