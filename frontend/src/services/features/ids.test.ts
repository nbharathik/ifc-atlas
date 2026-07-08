/**
 * Unit coverage for the IDS panel's service module: pure helpers plus the
 * fetch-backed API functions with `globalThis.fetch` stubbed via
 * `vi.stubGlobal` (mirrors the serverConvertPrebuild test pattern - no real
 * HTTP, no real backend).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectAllFailingIds,
  deleteIdsEntry,
  failingElementLabel,
  fetchIdsLibrary,
  fetchLastIdsRun,
  formatIdsDate,
  idsEntryLabel,
  idsErrorMessage,
  idsLastCsvUrl,
  isIdsFileName,
  specCountLabel,
  specFailingIds,
  summarizeIdsReport,
  truncationNote,
  uploadIdsFile,
  validateIdsEntry,
  type IdsFailingElement,
  type IdsLibraryEntry,
  type IdsReport,
  type IdsSpecificationResult,
} from './ids';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

function makeFailing(overrides: Partial<IdsFailingElement> = {}): IdsFailingElement {
  return {
    id: 42,
    global_id: 'GLOBAL42',
    ifc_type: 'IfcWall',
    name: 'South Wall',
    facet_type: 'Property',
    reason: 'Missing Pset_WallCommon.FireRating',
    ...overrides,
  };
}

function makeSpec(overrides: Partial<IdsSpecificationResult> = {}): IdsSpecificationResult {
  return {
    name: 'Walls have fire rating',
    status: 'failed',
    applied_to: 10,
    passed: 7,
    failed: 3,
    description: 'All walls must declare a fire rating.',
    failing_elements: [makeFailing()],
    failing_truncated: false,
    ...overrides,
  };
}

function makeReport(overrides: Partial<IdsReport> = {}): IdsReport {
  return {
    total_specifications: 3,
    passed: 1,
    failed: 1,
    no_applicable: 1,
    specifications: [
      makeSpec({ name: 'Spec A', status: 'passed', failed: 0, failing_elements: [] }),
      makeSpec({ name: 'Spec B', status: 'failed' }),
      makeSpec({
        name: 'Spec C',
        status: 'no_applicable',
        applied_to: 0,
        passed: 0,
        failed: 0,
        failing_elements: [],
      }),
    ],
    ids_title: 'Office QA',
    ids_version: '1.0',
    ids_description: null,
    engine: 'ifctester',
    all_failing_ids: [42],
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── specFailingIds ──────────────────────────────────────────────────────────

describe('specFailingIds', () => {
  it('extracts express ids from failing elements', () => {
    const spec = makeSpec({
      failing_elements: [makeFailing({ id: 1 }), makeFailing({ id: 2 })],
    });
    expect(specFailingIds(spec)).toEqual([1, 2]);
  });

  it('dedupes repeated ids (one element can fail several facets)', () => {
    const spec = makeSpec({
      failing_elements: [
        makeFailing({ id: 5 }),
        makeFailing({ id: 5, facet_type: 'Attribute' }),
        makeFailing({ id: 6 }),
      ],
    });
    expect(specFailingIds(spec)).toEqual([5, 6]);
  });

  it('drops non-finite ids', () => {
    const spec = makeSpec({
      failing_elements: [makeFailing({ id: Number.NaN }), makeFailing({ id: 9 })],
    });
    expect(specFailingIds(spec)).toEqual([9]);
  });

  it('returns empty for a spec without failures', () => {
    expect(specFailingIds(makeSpec({ failing_elements: [] }))).toEqual([]);
  });
});

// ── collectAllFailingIds ────────────────────────────────────────────────────

describe('collectAllFailingIds', () => {
  it('prefers the server-computed all_failing_ids and dedupes it', () => {
    const report = makeReport({ all_failing_ids: [3, 1, 3, 2] });
    expect(collectAllFailingIds(report)).toEqual([3, 1, 2]);
  });

  it('falls back to the per-spec union when all_failing_ids is absent', () => {
    const report = makeReport({
      all_failing_ids: undefined,
      specifications: [
        makeSpec({ failing_elements: [makeFailing({ id: 1 }), makeFailing({ id: 2 })] }),
        makeSpec({ failing_elements: [makeFailing({ id: 2 }), makeFailing({ id: 3 })] }),
      ],
    });
    expect(collectAllFailingIds(report)).toEqual([1, 2, 3]);
  });

  it('falls back to the per-spec union when all_failing_ids is empty', () => {
    const report = makeReport({
      all_failing_ids: [],
      specifications: [makeSpec({ failing_elements: [makeFailing({ id: 7 })] })],
    });
    expect(collectAllFailingIds(report)).toEqual([7]);
  });

  it('returns empty when nothing failed anywhere', () => {
    const report = makeReport({
      all_failing_ids: [],
      specifications: [makeSpec({ status: 'passed', failing_elements: [] })],
    });
    expect(collectAllFailingIds(report)).toEqual([]);
  });
});

// ── summarizeIdsReport ──────────────────────────────────────────────────────

describe('summarizeIdsReport', () => {
  it('uses the top-level counters when present', () => {
    const report = makeReport({
      total_specifications: 12,
      passed: 8,
      failed: 3,
      no_applicable: 1,
    });
    expect(summarizeIdsReport(report)).toEqual({
      passed: 8,
      failed: 3,
      noApplicable: 1,
      total: 12,
    });
  });

  it('derives counts from spec statuses when counters are missing', () => {
    const report = {
      specifications: [
        makeSpec({ status: 'passed' }),
        makeSpec({ status: 'passed' }),
        makeSpec({ status: 'failed' }),
        makeSpec({ status: 'no_applicable' }),
      ],
    } as IdsReport;
    expect(summarizeIdsReport(report)).toEqual({
      passed: 2,
      failed: 1,
      noApplicable: 1,
      total: 4,
    });
  });
});

// ── formatIdsDate ───────────────────────────────────────────────────────────

describe('formatIdsDate', () => {
  it('formats a UTC ISO timestamp as a date', () => {
    expect(formatIdsDate('2026-06-12T10:00:00Z')).toBe('Jun 12, 2026');
  });

  it('appends the time when requested', () => {
    expect(formatIdsDate('2026-06-12T10:05:00Z', true)).toBe('Jun 12, 2026, 10:05 UTC');
  });

  it('pins midnight to 00 (h23 cycle)', () => {
    expect(formatIdsDate('2026-06-12T00:30:00Z', true)).toBe('Jun 12, 2026, 00:30 UTC');
  });

  it('returns unparseable input as-is', () => {
    expect(formatIdsDate('not-a-date')).toBe('not-a-date');
  });

  it('returns empty for null/undefined', () => {
    expect(formatIdsDate(null)).toBe('');
    expect(formatIdsDate(undefined)).toBe('');
  });
});

// ── small label helpers ─────────────────────────────────────────────────────

describe('specCountLabel', () => {
  it('uses the singular for 1', () => {
    expect(specCountLabel(1)).toBe('1 spec');
  });

  it('uses the plural otherwise', () => {
    expect(specCountLabel(0)).toBe('0 specs');
    expect(specCountLabel(3)).toBe('3 specs');
  });
});

describe('idsEntryLabel', () => {
  it('prefers the title', () => {
    expect(idsEntryLabel({ title: 'Office QA', filename: 'spec.ids' })).toBe('Office QA');
  });

  it('falls back to the filename for empty or blank titles', () => {
    expect(idsEntryLabel({ title: '', filename: 'spec.ids' })).toBe('spec.ids');
    expect(idsEntryLabel({ title: '   ', filename: 'spec.ids' })).toBe('spec.ids');
  });
});

describe('failingElementLabel', () => {
  it('prefers the element name', () => {
    expect(failingElementLabel({ id: 42, name: 'South Wall' })).toBe('South Wall');
  });

  it('falls back to #id for empty or null names', () => {
    expect(failingElementLabel({ id: 42, name: '' })).toBe('#42');
    expect(failingElementLabel({ id: 42, name: null })).toBe('#42');
  });
});

describe('truncationNote', () => {
  it('mentions the shown count and the CSV export', () => {
    const note = truncationNote(25);
    expect(note).toContain('first 25');
    expect(note).toContain('export CSV');
  });
});

describe('isIdsFileName', () => {
  it('accepts .ids and .xml in any case', () => {
    expect(isIdsFileName('spec.ids')).toBe(true);
    expect(isIdsFileName('SPEC.IDS')).toBe(true);
    expect(isIdsFileName('rules.xml')).toBe(true);
    expect(isIdsFileName('rules.XML ')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isIdsFileName('model.ifc')).toBe(false);
    expect(isIdsFileName('spec.ids.txt')).toBe(false);
    expect(isIdsFileName('ids')).toBe(false);
  });
});

describe('idsErrorMessage', () => {
  it('extracts the FastAPI detail string from an API error body', () => {
    const err = new Error('API error 422: {"detail":"Not a valid IDS file"}');
    expect(idsErrorMessage(err)).toBe('Not a valid IDS file');
  });

  it('keeps the full message when the body is not JSON', () => {
    const err = new Error('API error 502: Bad Gateway');
    expect(idsErrorMessage(err)).toBe('API error 502: Bad Gateway');
  });

  it('passes through non-API errors and non-Error values', () => {
    expect(idsErrorMessage(new Error('Failed to fetch'))).toBe('Failed to fetch');
    expect(idsErrorMessage('boom')).toBe('boom');
  });
});

// ── API functions (mocked fetch) ────────────────────────────────────────────

const ENTRY: IdsLibraryEntry = {
  id: 'a1b2c3d4e5f6',
  filename: 'spec.ids',
  title: 'Office QA',
  description: 'Wall fire ratings',
  specifications_count: 3,
  size_bytes: 1234,
  added_at: '2026-06-12T10:00:00Z',
};

describe('fetchIdsLibrary', () => {
  it('GETs the library and unwraps entries', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { entries: [ENTRY] }));
    vi.stubGlobal('fetch', fetchMock);

    const entries = await fetchIdsLibrary();
    expect(entries).toEqual([ENTRY]);
    expect(fetchMock).toHaveBeenCalledWith('/api/ids/library', undefined);
  });

  it('throws with status + body on failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(500, { detail: 'boom' })));
    await expect(fetchIdsLibrary()).rejects.toThrow(/API error 500/);
  });
});

describe('uploadIdsFile', () => {
  it('POSTs the file as a multipart "file" field and returns the entry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, ENTRY));
    vi.stubGlobal('fetch', fetchMock);

    const file = new File(['<ids/>'], 'spec.ids', { type: 'application/xml' });
    const entry = await uploadIdsFile(file);
    expect(entry).toEqual(ENTRY);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/ids/library');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    const sent = (init.body as FormData).get('file');
    expect(sent).toBeInstanceOf(File);
    expect((sent as File).name).toBe('spec.ids');
  });

  it('rejects with the 422 body when the file is not valid IDS', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json(422, { detail: 'Not a valid IDS file' })),
    );
    const file = new File(['nope'], 'broken.ids');
    await expect(uploadIdsFile(file)).rejects.toThrow(/422.*Not a valid IDS file/s);
  });
});

describe('validateIdsEntry', () => {
  const RUN = {
    ids_id: ENTRY.id,
    ran_at: '2026-06-12T11:00:00Z',
    all_failing_ids: [42],
    ...makeReport(),
  };

  it('POSTs to the validate route with the default limit and returns the run', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, RUN));
    vi.stubGlobal('fetch', fetchMock);

    const run = await validateIdsEntry(ENTRY.id);
    expect(run.ids_id).toBe(ENTRY.id);
    expect(run.all_failing_ids).toEqual([42]);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/ids/library/${ENTRY.id}/validate?limit_per_spec=25`,
      { method: 'POST' },
    );
  });

  it('honors a custom per-spec limit', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, RUN));
    vi.stubGlobal('fetch', fetchMock);

    await validateIdsEntry(ENTRY.id, 100);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/ids/library/${ENTRY.id}/validate?limit_per_spec=100`,
      { method: 'POST' },
    );
  });

  it('rejects with the 400 body when no model is loaded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json(400, { detail: 'No IFC model loaded' })),
    );
    await expect(validateIdsEntry(ENTRY.id)).rejects.toThrow(/400.*No IFC model loaded/s);
  });
});

describe('fetchLastIdsRun', () => {
  it('returns the normalized run when a cached report exists', async () => {
    const report = makeReport();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json(200, {
          available: true,
          ids_id: ENTRY.id,
          ran_at: '2026-06-12T11:00:00Z',
          report,
        }),
      ),
    );

    const last = await fetchLastIdsRun();
    expect(last).not.toBeNull();
    expect(last?.idsId).toBe(ENTRY.id);
    expect(last?.ranAt).toBe('2026-06-12T11:00:00Z');
    expect(last?.report.engine).toBe('ifctester');
  });

  it('returns null when nothing ran for the current model', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, { available: false })));
    expect(await fetchLastIdsRun()).toBeNull();
  });
});

describe('deleteIdsEntry', () => {
  it('DELETEs the entry route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { deleted: true }));
    vi.stubGlobal('fetch', fetchMock);

    await deleteIdsEntry(ENTRY.id);
    expect(fetchMock).toHaveBeenCalledWith(`/api/ids/library/${ENTRY.id}`, {
      method: 'DELETE',
    });
  });

  it('throws on 404 for an unknown id', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(404, { detail: 'Not found' })));
    await expect(deleteIdsEntry('missing')).rejects.toThrow(/API error 404/);
  });
});

describe('idsLastCsvUrl', () => {
  it('points at the cached-run CSV route (same-origin on web)', () => {
    expect(idsLastCsvUrl()).toBe('/api/ids/last.csv');
  });
});
