// Pure data-transformation layer for IFC classification hierarchies.
// Extracted from metadata.worker.ts so the grouping logic can be unit-tested
// without a live web-ifc instance.

import type { ClassificationGroup, ClassificationItem } from '../types/ifc';

export interface RawClassification {
  eid: number;
  name: string;
  source: string | null;
  edition: string | null;
}

// A flat IfcClassificationReference with its immediate parent eid already
// resolved (could be another reference or the root IfcClassification).
export interface RawReference {
  eid: number;
  code: string | null;
  name: string;
  sourceEid: number | null;
}

// One IfcRelAssociatesClassification - many members, one relating classification.
export interface RawRelation {
  relatingClassificationEid: number;
  memberIds: number[];
}

/**
 * Assemble ClassificationGroup[] from pre-parsed IFC data.
 *
 * Algorithm:
 *  1. Index all IfcClassification rows as the top-level groups.
 *  2. For each IfcClassificationReference walk the parent chain (up to
 *     MAX_DEPTH hops) to find the owning IfcClassification.
 *  3. For each IfcRelAssociatesClassification add the member IDs to the
 *     matching item inside the right group, creating the item on first sight.
 */
export function buildClassificationGroups(
  classifications: RawClassification[],
  references: RawReference[],
  relations: RawRelation[],
): ClassificationGroup[] {
  const MAX_DEPTH = 8;

  // Step 1 - group index (keyed by IfcClassification expressID).
  const groupMap = new Map<number, ClassificationGroup>();
  for (const c of classifications) {
    groupMap.set(c.eid, {
      classificationExpressId: c.eid,
      name: c.name,
      source: c.source,
      edition: c.edition,
      items: [],
    });
  }

  // Step 2 - resolve each reference to its root IfcClassification.
  const referenceByEid = new Map<number, RawReference>();
  for (const r of references) {
    referenceByEid.set(r.eid, r);
  }

  interface ResolvedRef {
    classEid: number;
    code: string | null;
    name: string;
  }
  const resolvedRefs = new Map<number, ResolvedRef>();

  for (const ref of references) {
    let classEid: number | null = null;
    let current: number | null = ref.sourceEid;
    for (let depth = 0; depth < MAX_DEPTH && current !== null; depth++) {
      if (groupMap.has(current)) {
        classEid = current;
        break;
      }
      const parent = referenceByEid.get(current);
      current = parent?.sourceEid ?? null;
    }
    if (classEid !== null) {
      resolvedRefs.set(ref.eid, { classEid, code: ref.code, name: ref.name });
    }
  }

  // Step 3 - attach member IDs to items inside their groups.
  const itemMap = new Map<number, ClassificationItem>();

  for (const rel of relations) {
    const refEid = rel.relatingClassificationEid;
    if (rel.memberIds.length === 0) continue;

    let classEid: number | null = null;
    let code: string | null = null;
    let name = '';

    if (groupMap.has(refEid)) {
      // Direct association to an IfcClassification (no reference code).
      classEid = refEid;
      name = groupMap.get(refEid)!.name;
    } else if (resolvedRefs.has(refEid)) {
      const r = resolvedRefs.get(refEid)!;
      classEid = r.classEid;
      code = r.code;
      name = r.name;
    }

    if (classEid === null || !groupMap.has(classEid)) continue;

    if (!itemMap.has(refEid)) {
      const item: ClassificationItem = { refExpressId: refEid, code, name, memberIds: [] };
      itemMap.set(refEid, item);
      groupMap.get(classEid)!.items.push(item);
    }

    const item = itemMap.get(refEid)!;
    for (const id of rel.memberIds) {
      item.memberIds.push(id);
    }
  }

  return Array.from(groupMap.values());
}
