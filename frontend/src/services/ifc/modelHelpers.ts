

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

/**
 * Resolve a viewer raycast hit to the owning IfcProduct's IfcOpenShell express
 * id - the id the backend `/api/ifc/elements/{id}` route and the Properties
 * panel expect.
 *
 * The model tree dispatches `SpatialNode.expressId`, which comes from the
 * GlobalId-anchored localId→express bridge (`ModelService.expressIdByLocalId`).
 * The viewer must dispatch the SAME value so a click lands on exactly the
 * element a tree-row click does.
 *
 * The raycast `itemId` is a *fragment-space* id. For server-converted fragment
 * models it does NOT equal the IfcOpenShell express id, so dispatching it makes
 * the backend return a coincidental *wrong-but-valid* entity (e.g. an
 * IfcSpaceType when a wall was clicked) or 404 ("Properties are unavailable").
 * The raycast `localId`, by contrast, is the hit item's fragment localId - the
 * same localId space `getSpatialStructure()` (and therefore the tree + the
 * bridge) key on.
 *
 * Strategy: prefer the bridge keyed on `localId`. It is GlobalId-anchored, so
 * it can only ever yield the correct product express id or miss - never a wrong
 * id. On a miss (bridge not hydrated yet, or a localId that carries no
 * GlobalId) fall back to the itemId-keyed owner resolution, which is correct
 * for client-converted models where `itemId` already IS the IfcOpenShell
 * express id.
 */
export function resolveHitProductId(
  bridge: ReadonlyMap<number, number>,
  ownerFallback: (itemId: number) => number,
  itemId: number,
  localId: number,
): { productId: number; viaBridge: boolean } {
  const bridged = bridge.get(localId);
  if (typeof bridged === 'number') return { productId: bridged, viaBridge: true };
  return { productId: ownerFallback(itemId), viaBridge: false };
}

/**
 * Tiny dependency-free bridge between the Zustand store and ModelService.
 *
 * Importing ModelService from the store pulls the IFC/viewer engine into the
 * application entry chunk.  The old dynamic import avoided that cost, but it
 * also made property refresh wait several seconds on a cold bundle.  The
 * viewer registers its already-loaded singleton here; store invalidation then
 * stays synchronous without changing the bundle boundary.
 */

export type ElementDetailInvalidator = (expressIds: readonly number[]) => void;

let invalidator: ElementDetailInvalidator | null = null;

export function registerElementDetailInvalidator(next: ElementDetailInvalidator): () => void {
  invalidator = next;
  return () => {
    if (invalidator === next) invalidator = null;
  };
}

export function invalidateModelElementDetails(expressIds: readonly number[]): void {
  invalidator?.(expressIds);
}
