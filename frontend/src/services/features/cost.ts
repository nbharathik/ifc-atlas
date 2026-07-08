/**
 * 5D cost / bill-of-quantities API client + formatters for the Cost panel.
 *
 * Backend contract:
 *   GET    /api/cost/rates                       -> { currency, rates }
 *   PUT    /api/cost/rates  body { rates }       -> { currency, rates }
 *   GET    /api/cost/boq?group_by=<csv>&include_ids=true
 *   GET    /api/cost/boq.csv?group_by=<csv>
 * The BoQ is always grouped by ifc_class first; group_by adds extra dimensions
 * (storey | material | type_object | classification).
 */
import { apiUrl } from '../../lib/platform';

/** Measurement basis a rate is applied against. */
export type CostBasis = 'volume' | 'area' | 'length' | 'count';

export const COST_BASES: ReadonlyArray<{ value: CostBasis; label: string; unit: string }> = [
  { value: 'area', label: 'Area', unit: 'm2' },
  { value: 'volume', label: 'Volume', unit: 'm3' },
  { value: 'length', label: 'Length', unit: 'm' },
  { value: 'count', label: 'Count', unit: 'nr' },
];

/** Extra grouping dimensions (after the implicit ifc_class). */
export type CostExtraField = 'storey' | 'material' | 'type_object' | 'classification';

export const COST_EXTRA_FIELDS: ReadonlyArray<{ value: CostExtraField; label: string }> = [
  { value: 'storey', label: 'Storey' },
  { value: 'material', label: 'Material' },
  { value: 'type_object', label: 'Type' },
  { value: 'classification', label: 'Classification' },
];

export interface RateEntry {
  basis: CostBasis;
  rate: number;
}

export type RateLibrary = Record<string, RateEntry>;

export interface RatesResponse {
  currency: string;
  rates: RateLibrary;
}

export interface CostBoqRow {
  key: Record<string, string>;
  label: string;
  ifc_class: string;
  count: number;
  basis: CostBasis;
  unit: string;
  quantity: number;
  rate: number;
  amount: number;
  priced: boolean;
  element_ids?: number[];
}

export interface CostBoq {
  currency: string;
  group_by: string[];
  rows: CostBoqRow[];
  total: number;
  priced_rows: number;
  total_rows: number;
  truncated: boolean;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(apiUrl(path));
  if (!res.ok) {
    throw new Error(`API error ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

/** Fetch the editable rate library. */
export function fetchRates(): Promise<RatesResponse> {
  return getJson<RatesResponse>('/api/cost/rates');
}

/** Replace the rate library; returns the persisted (sanitized) result. */
export async function saveRates(rates: RateLibrary): Promise<RatesResponse> {
  const res = await fetch(apiUrl('/api/cost/rates'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rates }),
  });
  if (!res.ok) {
    throw new Error(`API error ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<RatesResponse>;
}

/** Fetch the priced bill of quantities. `extra` are dimensions after ifc_class. */
export function fetchBoq(extra: readonly CostExtraField[]): Promise<CostBoq> {
  const params = new URLSearchParams({ group_by: extra.join(','), include_ids: 'true' });
  return getJson<CostBoq>(`/api/cost/boq?${params.toString()}`);
}

/** Download URL for the BoQ CSV. */
export function boqCsvUrl(extra: readonly CostExtraField[]): string {
  const params = new URLSearchParams({ group_by: extra.join(',') });
  return apiUrl(`/api/cost/boq.csv?${params.toString()}`);
}

/** Format a money amount with thousands separators and 2 decimals. */
export function formatMoney(value: number, currency: string): string {
  const num = value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${currency} ${num}`;
}

/** Format a quantity (3 dp, trimmed) with its unit. */
export function formatQuantity(value: number, unit: string): string {
  const num = value.toLocaleString('en-US', { maximumFractionDigits: 3 });
  return `${num} ${unit}`;
}

/** Strip the "Ifc" prefix for display (IfcWall -> Wall). */
export function shortClass(ifcClass: string): string {
  return ifcClass.startsWith('Ifc') ? ifcClass.slice(3) : ifcClass;
}
