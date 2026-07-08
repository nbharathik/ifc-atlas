import { describe, expect, it, vi } from 'vitest';

import { resolveHitProductId } from '../resolveHitProductId';

describe('resolveHitProductId', () => {
  // The bug this guards against: the viewer used to dispatch the raw raycast
  // `itemId` (fragment-space) to a backend route that expects IfcOpenShell
  // express ids. For server-converted models those id-spaces differ, so the
  // click resolved to a coincidental wrong entity or 404'd ("unavailable"),
  // while the model tree (which dispatches the GlobalId-anchored bridge value)
  // was correct. The fix: resolve through the SAME bridge the tree uses.

  it('prefers the localId→express bridge over the raw fragment itemId', () => {
    // localId 500 → IfcOpenShell express 7302 (e.g. the IfcDoor the user clicked).
    const bridge = new Map<number, number>([[500, 7302]]);
    // The owner fallback would return the (wrong) fragment-space itemId.
    const ownerFallback = vi.fn((itemId: number) => itemId);

    const { productId, viaBridge } = resolveHitProductId(bridge, ownerFallback, 783, 500);

    expect(productId).toBe(7302); // the door's real express id, NOT 783
    expect(viaBridge).toBe(true);
    expect(ownerFallback).not.toHaveBeenCalled(); // bridge short-circuits the fallback
  });

  it('falls back to the itemId-keyed owner resolution when the bridge has no entry', () => {
    const bridge = new Map<number, number>(); // not hydrated yet
    const ownerFallback = vi.fn((itemId: number) => itemId);

    const { productId, viaBridge } = resolveHitProductId(bridge, ownerFallback, 42, 999);

    expect(productId).toBe(42);
    expect(viaBridge).toBe(false);
    expect(ownerFallback).toHaveBeenCalledWith(42);
  });

  it('lets the owner fallback rewrite a sub-entity itemId to its product (client-converted path)', () => {
    const bridge = new Map<number, number>();
    // Client-converted models: itemId IS the express id and the owner map walks
    // a sub-representation express id up to its owning product.
    const ownerMap = new Map<number, number>([[696, 634]]);
    const ownerFallback = (itemId: number) => ownerMap.get(itemId) ?? itemId;

    const { productId, viaBridge } = resolveHitProductId(bridge, ownerFallback, 696, 12345);

    expect(productId).toBe(634);
    expect(viaBridge).toBe(false);
  });

  it('keys the bridge strictly on localId, never on itemId', () => {
    // A bridge entry exists for the itemId value but NOT the localId value.
    // The resolver must ignore it and fall back - using itemId as a bridge key
    // is exactly the cross-id-space confusion that caused the bug.
    const bridge = new Map<number, number>([[783, 99999]]);
    const ownerFallback = (itemId: number) => itemId;

    const { productId, viaBridge } = resolveHitProductId(bridge, ownerFallback, 783, 500);

    expect(productId).toBe(783); // fell back to itemId; did NOT read bridge[itemId]
    expect(viaBridge).toBe(false);
  });
});
