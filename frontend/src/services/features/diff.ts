/**
 * Working-vs-original diff API client for the Diff panel.
 *
 * Backend contract:
 *   GET /api/diff/working-vs-original      -> { added, removed, changed, counts, truncated, has_working_copy }
 *   GET /api/diff/working-vs-original.csv  -> change report CSV
 */
import { apiUrl } from '../../lib/platform';

export interface DiffRow {
  express_id: number;
  ifc_type: string;
  name?: string | null;
}

export interface DiffPropertyChange {
  property_set?: string;
  property_name?: string;
  before?: unknown;
  after?: unknown;
}

export interface DiffChangedRow {
  express_id: number;
  ifc_type: string;
  change: string;
  name_before?: string | null;
  name_after?: string | null;
  property_changes: DiffPropertyChange[];
}

export interface DiffResult {
  added: DiffRow[];
  removed: DiffRow[];
  changed: DiffChangedRow[];
  counts: { added: number; removed: number; changed: number };
  truncated: boolean;
  has_working_copy: boolean;
}

export async function fetchDiff(): Promise<DiffResult> {
  const res = await fetch(apiUrl('/api/diff/working-vs-original'));
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<DiffResult>;
}

export function diffCsvUrl(): string {
  return apiUrl('/api/diff/working-vs-original.csv');
}

/** Strip the "Ifc" prefix (IfcWall -> Wall). */
export function shortType(ifcType: string): string {
  return ifcType.startsWith('Ifc') ? ifcType.slice(3) : ifcType;
}

/** A short human label for a change kind. */
export function changeLabel(change: string): string {
  switch (change) {
    case 'renamed':
      return 'renamed';
    case 'retyped':
      return 'retyped';
    case 'property_changed':
      return 'properties';
    default:
      return change;
  }
}
