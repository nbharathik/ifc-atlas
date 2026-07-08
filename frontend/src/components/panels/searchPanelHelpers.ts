import type { ElementSummary } from '../../types/ifc';

/** Display label for a search result row. */
export function formatElementLabel(el: ElementSummary): string {
  return el.name ? el.name : `#${el.id}`;
}

/** Type badge text - strips the `Ifc` prefix. */
export function formatTypeLabel(ifcType: string): string {
  return ifcType.replace(/^Ifc/, '');
}

/** Aria label for the zoom-to button. */
export function zoomAriaLabel(el: ElementSummary): string {
  return `Zoom to ${el.name || el.ifc_type}`;
}

/** Aria label for the isolate button. */
export function isolateAriaLabel(el: ElementSummary): string {
  return `Isolate ${el.name || el.ifc_type}`;
}

export interface SearchResultGroup {
  ifcType: string;
  elements: ElementSummary[];
}

/**
 * Groups results by IFC class for the grouped result list. Largest group
 * first (ties broken by class name); element order inside a group is
 * preserved, so relevance-sorted input stays relevance-sorted.
 */
export function groupResultsByClass(elements: ElementSummary[]): SearchResultGroup[] {
  const byType = new Map<string, ElementSummary[]>();
  for (const el of elements) {
    const bucket = byType.get(el.ifc_type);
    if (bucket) bucket.push(el);
    else byType.set(el.ifc_type, [el]);
  }
  const groups = Array.from(byType, ([ifcType, els]) => ({ ifcType, elements: els }));
  groups.sort(
    (a, b) => b.elements.length - a.elements.length || a.ifcType.localeCompare(b.ifcType),
  );
  return groups;
}

/** Group header text, e.g. "IfcWall (12)". */
export function groupHeaderLabel(group: SearchResultGroup): string {
  return `${group.ifcType} (${group.elements.length})`;
}

/** Progress line while the property index builds, e.g. "Indexing properties... 2400/8000". */
export function enrichmentProgressLabel(processed: number, total: number): string {
  return `Indexing properties... ${processed}/${total}`;
}
