/**
 * Quantity Takeoff API client + pure table helpers for the QTO panel.
 *
 * Backend contract:
 *   GET /api/qto/summary?group_by=<csv>&include_ids=true
 *   GET /api/qto/export.csv?group_by=<csv>
 * where group_by is an ordered, comma-separated subset of
 * ifc_class | storey | material | type_object | classification.
 */
import { apiUrl } from '../../lib/platform';

/** Grouping dimensions accepted by the backend (order in the list is preserved). */
export type QtoGroupField =
  | 'ifc_class'
  | 'storey'
  | 'material'
  | 'type_object'
  | 'classification';

/** Chip metadata for the panel UI, in display order. */
export const QTO_GROUP_FIELDS: ReadonlyArray<{ value: QtoGroupField; label: string }> = [
  { value: 'ifc_class', label: 'IFC class' },
  { value: 'storey', label: 'Storey' },
  { value: 'material', label: 'Material' },
  { value: 'type_object', label: 'Type' },
  { value: 'classification', label: 'Classification' },
];

export interface QtoQuantities {
  volume_m3: number;
  area_m2: number;
  length_m: number;
}

/**
 * Per-quantity count of elements in the group that contributed a value.
 * 0 means the quantity is unknown for the whole group (the UI renders "-").
 */
export interface QtoCoverage {
  volume: number;
  area: number;
  length: number;
}

export interface QtoGroup {
  /** Group-field value per requested dimension, e.g. { ifc_class: "IfcWall", storey: "Ground Floor" }. */
  key: Record<string, string>;
  label: string;
  count: number;
  quantities: QtoQuantities;
  coverage: QtoCoverage;
  /** Present only when include_ids=true was requested; capped at 5000 ids per group. */
  element_ids?: number[];
}

export interface QtoSummary {
  group_by: string[];
  groups: QtoGroup[];
  overall: { count: number; quantities: QtoQuantities };
  /** True when the backend capped the response at 500 groups. */
  truncated: boolean;
  elapsed_ms: number;
}

export type QtoSortKey = 'count' | 'volume' | 'area' | 'length';
export type QtoSortDirection = 'asc' | 'desc';

/** Maps a sortable quantity key to its field name in QtoGroup.quantities. */
const QUANTITY_FIELD: Record<Exclude<QtoSortKey, 'count'>, keyof QtoQuantities> = {
  volume: 'volume_m3',
  area: 'area_m2',
  length: 'length_m',
};

/**
 * Fetch the grouped quantity summary. Always requests element ids so rows can
 * drive highlight/isolate in the viewer.
 */
export async function fetchQtoSummary(
  groupBy: readonly QtoGroupField[],
): Promise<QtoSummary> {
  const params = new URLSearchParams({
    group_by: groupBy.join(','),
    include_ids: 'true',
  });
  const res = await fetch(apiUrl(`/api/qto/summary?${params.toString()}`));
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API error ${res.status}: ${body}`);
  }
  return res.json() as Promise<QtoSummary>;
}

/** Build the CSV-export download URL for the current grouping. */
export function qtoExportCsvUrl(groupBy: readonly QtoGroupField[]): string {
  const params = new URLSearchParams({ group_by: groupBy.join(',') });
  return apiUrl(`/api/qto/export.csv?${params.toString()}`);
}

/** Format a quantity value: 1 decimal place with thousands separators (e.g. 1,234.6). */
export function formatQtoNumber(value: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

/** Format an integer count with thousands separators. */
export function formatQtoCount(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

/**
 * Format one quantity cell. Coverage 0 means no element in the group reported
 * the quantity, so the value is unknown rather than a true zero: render "-".
 */
export function formatQtoQuantity(value: number, coverage: number): string {
  return coverage === 0 ? '-' : formatQtoNumber(value);
}

/**
 * Comparator factory for sorting groups by a column. Equal primary values fall
 * back to a label compare (direction-independent) so the order is stable
 * across re-sorts regardless of the engine's sort stability.
 */
export function qtoSortComparator(
  key: QtoSortKey,
  direction: QtoSortDirection,
): (a: QtoGroup, b: QtoGroup) => number {
  const sign = direction === 'asc' ? 1 : -1;
  return (a, b) => {
    const av = key === 'count' ? a.count : a.quantities[QUANTITY_FIELD[key]];
    const bv = key === 'count' ? b.count : b.quantities[QUANTITY_FIELD[key]];
    if (av !== bv) return (av - bv) * sign;
    return a.label.localeCompare(b.label);
  };
}

/** Tabs and newlines inside a cell would corrupt the TSV grid; flatten them to spaces. */
function tsvCell(value: string): string {
  return value.replace(/[\t\r\n]+/g, ' ');
}

/**
 * Build a clipboard-ready TSV table from rows in their current (sorted) order.
 * Header mirrors the CSV export: one column per group field, then
 * count, volume_m3, area_m2, length_m. Quantities use plain 1-decimal numbers
 * (no thousands separators, spreadsheet-parseable); unknown quantities
 * (coverage 0) are written as "-" to match the on-screen table.
 */
export function buildQtoTsv(
  groups: readonly QtoGroup[],
  groupBy: readonly string[],
): string {
  const header = [...groupBy, 'count', 'volume_m3', 'area_m2', 'length_m'];
  const lines = [header.join('\t')];
  for (const group of groups) {
    const cells = groupBy.map((field) => tsvCell(group.key[field] ?? ''));
    cells.push(
      String(group.count),
      group.coverage.volume === 0 ? '-' : group.quantities.volume_m3.toFixed(1),
      group.coverage.area === 0 ? '-' : group.quantities.area_m2.toFixed(1),
      group.coverage.length === 0 ? '-' : group.quantities.length_m.toFixed(1),
    );
    lines.push(cells.join('\t'));
  }
  return lines.join('\n');
}
