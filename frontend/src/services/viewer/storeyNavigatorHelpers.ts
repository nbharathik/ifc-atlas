import type { SpatialNode } from '../../types/ifc';

/** Count all nodes in the subtree (inclusive). */
export function countSubtree(node: SpatialNode): number {
  return 1 + node.children.reduce((s, c) => s + countSubtree(c), 0);
}

/** Collect every express ID in the subtree (inclusive). */
export function collectStoreySubtreeIds(node: SpatialNode): number[] {
  const ids: number[] = [node.id];
  for (const child of node.children) ids.push(...collectStoreySubtreeIds(child));
  return ids;
}

/**
 * Derive a compact display label from a storey name.
 * Strips common English/IFC prefixes AND suffixes, then truncates to 14 chars.
 * Examples: "Ground Floor" → "Ground", "Level 2" → "2", "BF 01" → "BF 01"
 */
export function shortStoreyName(name: string): string {
  if (!name) return '-';
  const trimmed = name.trim();
  const stripped = trimmed
    // strip leading structural keywords
    .replace(/^(Building\s+)?Storey\s+/i, '')
    .replace(/^Level\s+/i, '')
    .replace(/^Floor\s+/i, '')
    .replace(/^Story\s+/i, '')
    // strip trailing structural keywords
    .replace(/\s+(Floor|Level|Story|Storey)$/i, '')
    .trim();
  const label = stripped || trimmed;
  return label.length > 14 ? label.slice(0, 13) + '…' : label;
}

/**
 * Given the current isolatedIds set, return the id of the storey whose
 * subtree exactly matches the isolated set. Returns null when nothing is
 * isolated and -1 when the isolation came from some other source.
 */
export function detectActiveStorey(
  isolatedIds: number[],
  storeys: SpatialNode[],
  storeySubtrees: Map<number, number[]>,
): number | null {
  if (isolatedIds.length === 0) return null;
  const isoSet = new Set(isolatedIds);
  for (const storey of storeys) {
    const subtree = storeySubtrees.get(storey.id);
    if (!subtree) continue;
    if (subtree.length === isolatedIds.length && subtree.every((id) => isoSet.has(id))) {
      return storey.id;
    }
  }
  return -1; // isolation from tree/chat/filter, not a full storey
}
