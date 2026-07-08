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
