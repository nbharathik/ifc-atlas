/**
 * IDS validation API client + pure helpers for the IDS panel.
 *
 * Backend contract:
 *   GET    /api/ids/library                  -> { entries: IdsLibraryEntry[] }
 *   POST   /api/ids/library                  -> IdsLibraryEntry (multipart field "file";
 *                                               422 "Not a valid IDS file" when it does not parse)
 *   DELETE /api/ids/library/{id}             -> { deleted: true } (404 unknown id)
 *   POST   /api/ids/library/{id}/validate?limit_per_spec=N
 *                                            -> IdsValidationRun (400 when no model loaded)
 *   GET    /api/ids/last                     -> { available, ids_id, ran_at, report }
 *                                               (available=false when nothing ran for the
 *                                               current model fingerprint)
 *   GET    /api/ids/last.csv                 -> CSV attachment (404 when no cached run)
 */
import { apiUrl } from '../../lib/platform';

export type IdsSpecStatus = 'passed' | 'failed' | 'no_applicable';

export interface IdsLibraryEntry {
  id: string;
  filename: string;
  title: string;
  description: string;
  specifications_count: number;
  size_bytes: number;
  added_at: string;
}

export interface IdsFailingElement {
  /** Express ID - usable directly with viewer selection/highlight. */
  id: number;
  /** Null for entities without a GlobalId attribute. */
  global_id: string | null;
  ifc_type: string;
  name: string | null;
  facet_type: string;
  reason: string;
}

export interface IdsSpecificationResult {
  name: string;
  status: IdsSpecStatus;
  applied_to: number;
  passed: number;
  failed: number;
  description: string;
  failing_elements: IdsFailingElement[];
  failing_truncated: boolean;
}

export interface IdsReport {
  total_specifications: number;
  passed: number;
  failed: number;
  no_applicable: number;
  specifications: IdsSpecificationResult[];
  ids_title: string | null;
  ids_version: string | null;
  ids_description: string | null;
  engine: string;
  /** Present on /validate responses; tolerated as absent on /last restores. */
  all_failing_ids?: number[];
}

/** Flat response of POST /api/ids/library/{id}/validate. */
export interface IdsValidationRun extends IdsReport {
  ids_id: string;
  ran_at: string;
  all_failing_ids: number[];
}

/** Normalized shape the panel keeps in state, for both fresh and restored runs. */
export interface IdsLastRun {
  idsId: string | null;
  ranAt: string | null;
  report: IdsReport;
}

export const DEFAULT_LIMIT_PER_SPEC = 25;

async function idsFetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), init);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API error ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchIdsLibrary(): Promise<IdsLibraryEntry[]> {
  const data = await idsFetchJson<{ entries: IdsLibraryEntry[] }>('/api/ids/library');
  return data.entries;
}

/** Upload a .ids/.xml spec. Re-uploading a duplicate returns the existing entry. */
export async function uploadIdsFile(file: File): Promise<IdsLibraryEntry> {
  const form = new FormData();
  form.append('file', file);
  return idsFetchJson<IdsLibraryEntry>('/api/ids/library', { method: 'POST', body: form });
}

export async function deleteIdsEntry(id: string): Promise<void> {
  await idsFetchJson<{ deleted: boolean }>(`/api/ids/library/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function validateIdsEntry(
  id: string,
  limitPerSpec: number = DEFAULT_LIMIT_PER_SPEC,
): Promise<IdsValidationRun> {
  return idsFetchJson<IdsValidationRun>(
    `/api/ids/library/${encodeURIComponent(id)}/validate?limit_per_spec=${limitPerSpec}`,
    { method: 'POST' },
  );
}

interface IdsLastResponse {
  available: boolean;
  ids_id?: string | null;
  ran_at?: string | null;
  report?: IdsReport | null;
}

/** Cached report for the current model fingerprint, or null when none exists. */
export async function fetchLastIdsRun(): Promise<IdsLastRun | null> {
  const data = await idsFetchJson<IdsLastResponse>('/api/ids/last');
  if (!data.available || !data.report) return null;
  return { idsId: data.ids_id ?? null, ranAt: data.ran_at ?? null, report: data.report };
}

/** Download URL for the cached run's CSV export (404 server-side when no run). */
export function idsLastCsvUrl(): string {
  return apiUrl('/api/ids/last.csv');
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Failing-element express ids for one spec: deduped, non-numeric entries dropped. */
export function specFailingIds(
  spec: Pick<IdsSpecificationResult, 'failing_elements'>,
): number[] {
  const seen = new Set<number>();
  for (const el of spec.failing_elements ?? []) {
    if (typeof el.id === 'number' && Number.isFinite(el.id)) seen.add(el.id);
  }
  return [...seen];
}

/**
 * Every failing express id of a run. Prefers the server-computed
 * `all_failing_ids` (NOT subject to the per-spec limit) when it has entries;
 * otherwise falls back to the union of the per-spec lists, which is the best
 * available when restoring an older cached report without that key.
 */
export function collectAllFailingIds(report: IdsReport): number[] {
  const fromServer = report.all_failing_ids;
  if (Array.isArray(fromServer) && fromServer.length > 0) {
    const seen = new Set<number>();
    for (const id of fromServer) {
      if (typeof id === 'number' && Number.isFinite(id)) seen.add(id);
    }
    return [...seen];
  }
  const seen = new Set<number>();
  for (const spec of report.specifications ?? []) {
    for (const id of specFailingIds(spec)) seen.add(id);
  }
  return [...seen];
}

export interface IdsSummaryCounts {
  passed: number;
  failed: number;
  noApplicable: number;
  total: number;
}

/**
 * Summary-strip math. Prefers the report's top-level counters and falls back
 * to counting specification statuses, so a restored report that lacks the
 * counters still renders correct chips.
 */
export function summarizeIdsReport(report: IdsReport): IdsSummaryCounts {
  const specs = report.specifications ?? [];
  const byStatus = (status: IdsSpecStatus) =>
    specs.filter((s) => s.status === status).length;
  return {
    passed: typeof report.passed === 'number' ? report.passed : byStatus('passed'),
    failed: typeof report.failed === 'number' ? report.failed : byStatus('failed'),
    noApplicable:
      typeof report.no_applicable === 'number'
        ? report.no_applicable
        : byStatus('no_applicable'),
    total:
      typeof report.total_specifications === 'number'
        ? report.total_specifications
        : specs.length,
  };
}

/**
 * Format a server UTC timestamp for display: "Jun 12, 2026" or, with time,
 * "Jun 12, 2026, 10:00 UTC". Rendered in UTC so the label matches the
 * server-side record regardless of the viewer's zone (and stays deterministic
 * in tests). Unparseable input is returned as-is; null/undefined become "".
 */
export function formatIdsDate(iso: string | null | undefined, withTime = false): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const opts: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  };
  if (withTime) {
    opts.hour = '2-digit';
    opts.minute = '2-digit';
    // h23 (not hour12:false) pins midnight to "00", which engines disagree on.
    opts.hourCycle = 'h23';
  }
  const text = new Intl.DateTimeFormat('en-US', opts).format(date);
  return withTime ? `${text} UTC` : text;
}

/** "1 spec" / "3 specs" for the library row meta. */
export function specCountLabel(count: number): string {
  return `${count} spec${count === 1 ? '' : 's'}`;
}

/** Display label for a library entry: title, else filename. */
export function idsEntryLabel(entry: Pick<IdsLibraryEntry, 'title' | 'filename'>): string {
  return entry.title && entry.title.trim() ? entry.title : entry.filename;
}

/** Display label for a failing-element row: name, else "#<express id>". */
export function failingElementLabel(el: Pick<IdsFailingElement, 'id' | 'name'>): string {
  return el.name && el.name.trim() ? el.name : `#${el.id}`;
}

/** Note shown under a spec whose failing-element list was capped server-side. */
export function truncationNote(shownCount: number): string {
  return `Showing first ${shownCount} per spec, export CSV for the full list.`;
}

/** Client-side pick filter: the backend only accepts .ids and .xml documents. */
export function isIdsFileName(name: string): boolean {
  return /\.(ids|xml)$/i.test(name.trim());
}

/**
 * Human-friendly text for an error thrown by this module. API errors carry
 * the raw response body; when that body is a FastAPI {"detail": "..."}
 * envelope, surface just the detail string (e.g. "Not a valid IDS file").
 */
export function idsErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const match = message.match(/^API error \d+: (.*)$/s);
  if (!match) return message;
  try {
    const detail = (JSON.parse(match[1]) as { detail?: unknown }).detail;
    if (typeof detail === 'string' && detail) return detail;
  } catch {
    // Body was not JSON - keep the full "API error <status>: <body>" text.
  }
  return message;
}
