/**
 * Embodied-carbon API client + formatters for the Carbon panel.
 *
 * Backend contract:
 *   GET    /api/carbon/factors                   -> { factors }
 *   PUT    /api/carbon/factors  body { factors } -> { factors }
 *   GET    /api/carbon/estimate?group_by=<csv>&include_ids=true
 *   GET    /api/carbon/estimate.csv?group_by=<csv>
 * Always grouped by material first; group_by adds extra dimensions.
 */
import { apiUrl } from '../../lib/platform';

export type CarbonBasis = 'volume' | 'area' | 'length' | 'count';

export const CARBON_BASES: ReadonlyArray<{ value: CarbonBasis; label: string; unit: string }> = [
  { value: 'volume', label: 'Volume', unit: 'm3' },
  { value: 'area', label: 'Area', unit: 'm2' },
  { value: 'length', label: 'Length', unit: 'm' },
  { value: 'count', label: 'Count', unit: 'nr' },
];

export type CarbonExtraField = 'ifc_class' | 'storey' | 'type_object' | 'classification';

export const CARBON_EXTRA_FIELDS: ReadonlyArray<{ value: CarbonExtraField; label: string }> = [
  { value: 'ifc_class', label: 'IFC class' },
  { value: 'storey', label: 'Storey' },
  { value: 'type_object', label: 'Type' },
  { value: 'classification', label: 'Classification' },
];

export interface FactorEntry {
  basis: CarbonBasis;
  factor: number;
}

export type FactorLibrary = Record<string, FactorEntry>;

export interface CarbonRow {
  key: Record<string, string>;
  label: string;
  material: string;
  count: number;
  basis: CarbonBasis;
  unit: string;
  quantity: number;
  factor: number;
  carbon_kg: number;
  factored: boolean;
  element_ids?: number[];
}

export interface CarbonResult {
  group_by: string[];
  rows: CarbonRow[];
  total_kg: number;
  total_tonnes: number;
  factored_rows: number;
  total_rows: number;
  truncated: boolean;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(apiUrl(path));
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export function fetchFactors(): Promise<{ factors: FactorLibrary }> {
  return getJson<{ factors: FactorLibrary }>('/api/carbon/factors');
}

export async function saveFactors(factors: FactorLibrary): Promise<{ factors: FactorLibrary }> {
  const res = await fetch(apiUrl('/api/carbon/factors'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ factors }),
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<{ factors: FactorLibrary }>;
}

export function fetchCarbon(extra: readonly CarbonExtraField[]): Promise<CarbonResult> {
  const params = new URLSearchParams({ group_by: extra.join(','), include_ids: 'true' });
  return getJson<CarbonResult>(`/api/carbon/estimate?${params.toString()}`);
}

export function carbonCsvUrl(extra: readonly CarbonExtraField[]): string {
  const params = new URLSearchParams({ group_by: extra.join(',') });
  return apiUrl(`/api/carbon/estimate.csv?${params.toString()}`);
}

/** Format embodied carbon: kg under 1 t, tonnes above, with thousands separators. */
export function formatCarbon(kg: number): string {
  if (kg >= 1000) {
    return `${(kg / 1000).toLocaleString('en-US', { maximumFractionDigits: 2 })} t`;
  }
  return `${kg.toLocaleString('en-US', { maximumFractionDigits: 1 })} kg`;
}

export function formatQuantity(value: number, unit: string): string {
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 3 })} ${unit}`;
}
