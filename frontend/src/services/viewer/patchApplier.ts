/**
 * Patch applier - part of the IFC Atlas native engine.
 *
 * Consumes `ifc_patch` WebSocket events emitted by the backend after a
 * sandbox Apply.  The function is dependency-injected so that:
 *   a) It is fully testable without a running viewer or DOM.
 *   b) The caller (App.tsx) decides how to wire the viewer callbacks.
 *
 * Contract:
 *   - `attribute_changed` (Name) → patches the spatial tree in the Zustand store.
 *   - `attribute_changed` (other) → logs to the activity log.
 *   - `pset_changed` → logs to the activity log (full detail re-fetch is a later step).
 *   - `element_removed` → hides the fragment via `onElementsHidden`.
 *   - `element_added` with non-null `frag_delta_url` → delegates to optional geometry handler.
 *   - `geometry_changed` with `frag_delta_url` → delegates to optional geometry handler.
 *   - `storey_changed` → logs to the activity log.
 *
 * Geometry extension point:
 *   When `onFragDelta` is provided and a patch carries a `frag_delta_url`,
 *   the applier calls it with the URL + affected express IDs.  The caller
 *   is responsible for fetching/applying the geometry payload. This release
 *   keeps populated fragment-delta payloads as post-release work.
 */

import type { IfcPatch } from '../../types/ifcPatch';
import type { SpatialNode } from '../../types/ifc';

// ── ActivityEntry kind re-exported here to avoid circular store imports ──
export type PatchActivityKind = 'edit' | 'info' | 'error';

export interface PatchActivityEntry {
  kind: PatchActivityKind;
  summary: string;
  detail?: string;
}

/**
 * Dependency bag for `applyIfcPatchBatch`.
 * All callbacks are optional so tests only need to supply the ones being
 * exercised.
 */
export interface PatchApplierDeps {
  /** Current spatial tree (read-only). */
  spatialTree?: SpatialNode | null;
  /**
   * Called once (at most) per batch with a patched copy of the spatial tree
   * when one or more `attribute_changed` Name patches are present.
   * The new tree is structurally shared - only renamed nodes are replaced.
   */
  onTreeUpdated?: (tree: SpatialNode) => void;
  /**
   * Called for every human-readable activity entry that should appear in
   * the activity log.
   */
  onActivityLogged?: (entry: PatchActivityEntry) => void;
  /**
   * Called with express IDs that were removed from the model.
   * The caller adds them to `hiddenIds` in the Zustand store; the viewer
   * picks up the change via its store subscription and hides the fragment.
   */
  onElementsHidden?: (expressIds: number[]) => void;
  /**
   * Called when a patch carries geometry data via `frag_delta_url`. The
   * caller owns viewer-specific fragment editor dependencies. The current
   * backend endpoint returns an empty geometry payload until post-release
   * fragment-delta production is implemented.
   */
  onFragDelta?: (url: string, expressIds: number[]) => void;
}

// ─── Tree helpers ─────────────────────────────────────────────────────────────

/**
 * Structural-share walk: only returns a new node if it or any descendant
 * changed. Identical to `patchTreeNames` in App.tsx but decoupled here
 * so the service can be tested independently.
 */
export function applyNameUpdatesToTree(
  root: SpatialNode,
  nameMap: Map<number, string>,
): SpatialNode {
  const walk = (node: SpatialNode): [SpatialNode, boolean] => {
    let changed = false;
    const children: SpatialNode[] = [];
    for (const child of node.children) {
      const [patched, c] = walk(child);
      children.push(patched);
      if (c) changed = true;
    }

    const nextName = nameMap.get(node.id);
    const nameChanged = typeof nextName === 'string' && nextName !== node.name;
    if (nameChanged) changed = true;

    if (!changed) return [node, false];

    return [
      {
        ...node,
        name: nameChanged ? (nextName as string) : node.name,
        children,
      },
      true,
    ];
  };

  const [patched, changed] = walk(root);
  return changed ? patched : root;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Apply a list of `IfcPatch` objects received in a single `ifc_patch` WS
 * event to the viewer state via the provided dependency callbacks.
 *
 * The patches are processed in array order (matching the backend's insertion
 * order).  Patches with out-of-order `seq` are NOT reordered here - the
 * assumption is that the WS delivers patches reliably and in order.
 * Seq-gated buffering can be added if that changes.
 */
export function applyIfcPatchBatch(
  patches: IfcPatch[],
  deps: PatchApplierDeps,
): void {
  if (patches.length === 0) return;

  // Accumulate name updates for a single tree walk at the end.
  const nameUpdates = new Map<number, string>();
  // Accumulate hidden IDs for a single addHiddenIds call at the end.
  const hiddenIds: number[] = [];

  for (const patch of patches) {
    switch (patch.kind) {
      case 'attribute_changed': {
        if (patch.attribute === 'Name') {
          const newName = patch.new_value as string | null;
          if (typeof newName === 'string') {
            nameUpdates.set(patch.express_id, newName);
          }
          deps.onActivityLogged?.({
            kind: 'edit',
            summary: `Element #${patch.express_id} renamed`,
            detail: `"${patch.old_value ?? ''}" → "${patch.new_value ?? ''}"`,
          });
        } else if (patch.attribute === 'ifc_type') {
          deps.onActivityLogged?.({
            kind: 'info',
            summary: `Element #${patch.express_id} type changed`,
            detail: `${patch.old_value ?? '?'} → ${patch.new_value ?? '?'}`,
          });
        } else {
          deps.onActivityLogged?.({
            kind: 'info',
            summary: `Element #${patch.express_id} attribute updated`,
            detail: `${patch.attribute}: ${patch.old_value ?? '-'} → ${patch.new_value ?? '-'}`,
          });
        }
        break;
      }

      case 'pset_changed': {
        const propCount = Object.keys(patch.changes).length;
        deps.onActivityLogged?.({
          kind: 'edit',
          summary: `Element #${patch.express_id} properties updated`,
          detail: `${patch.pset_name}: ${propCount} property change${propCount !== 1 ? 's' : ''}`,
        });
        break;
      }

      case 'element_removed': {
        hiddenIds.push(patch.express_id);
        deps.onActivityLogged?.({
          kind: 'edit',
          summary: `${patch.ifc_type} #${patch.express_id} removed from model`,
        });
        break;
      }

      case 'element_added': {
        const url = patch.frag_delta_url;
        if (url && deps.onFragDelta) {
          // Load the mini-.frag geometry for the new element.
          deps.onFragDelta(url, [patch.express_id]);
        }
        deps.onActivityLogged?.({
          kind: 'edit',
          summary: `New ${patch.ifc_type} #${patch.express_id} added`,
          detail: url ? 'Geometry loading…' : 'Metadata-only (no geometry yet)',
        });
        break;
      }

      case 'geometry_changed': {
        const url = patch.frag_delta_url;
        if (url && deps.onFragDelta) {
          // Replace geometry fragments for affected elements.
          deps.onFragDelta(url, patch.express_ids);
        }
        deps.onActivityLogged?.({
          kind: 'info',
          summary: `Geometry updated for ${patch.express_ids.length} element${patch.express_ids.length !== 1 ? 's' : ''}`,
          detail: url ? 'Fragment delta loading…' : 'No geometry delta (metadata-only update)',
        });
        break;
      }

      case 'storey_changed': {
        deps.onActivityLogged?.({
          kind: 'info',
          summary: `Element #${patch.express_id} moved to different storey`,
          detail:
            patch.old_storey_express_id != null && patch.new_storey_express_id != null
              ? `storey #${patch.old_storey_express_id} → #${patch.new_storey_express_id}`
              : undefined,
        });
        break;
      }

      default: {
        // Exhaustiveness guard - future patch kinds degrade gracefully.
        const _exhaustive: never = patch;
        void _exhaustive;
        deps.onActivityLogged?.({
          kind: 'info',
          summary: 'Unknown patch kind received',
        });
      }
    }
  }

  // Apply accumulated name updates in a single tree walk.
  if (nameUpdates.size > 0 && deps.spatialTree && deps.onTreeUpdated) {
    const patched = applyNameUpdatesToTree(deps.spatialTree, nameUpdates);
    if (patched !== deps.spatialTree) {
      deps.onTreeUpdated(patched);
    }
  }

  // Apply accumulated hidden IDs in a single store call.
  if (hiddenIds.length > 0 && deps.onElementsHidden) {
    deps.onElementsHidden(hiddenIds);
  }
}
