/**
 * COBie data-handover API client for the COBie panel.
 *
 * Backend contract:
 *   GET /api/cobie/summary     -> { counts, completeness }
 *   GET /api/cobie/export.csv  -> multi-section COBie-lite CSV download
 */
import { apiUrl } from '../../lib/platform';

export interface CobieCounts {
  floors: number;
  spaces: number;
  types: number;
  components: number;
}

export interface CobieCompletenessItem {
  label: string;
  present: number;
  total: number;
  pct: number;
}

export interface CobieSummary {
  counts: CobieCounts;
  completeness: CobieCompletenessItem[];
}

export async function fetchCobieSummary(): Promise<CobieSummary> {
  const res = await fetch(apiUrl('/api/cobie/summary'));
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<CobieSummary>;
}

export function cobieCsvUrl(): string {
  return apiUrl('/api/cobie/export.csv');
}
