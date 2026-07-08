import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapturedViewState } from '../viewer/viewerBridge';
import {
  addBcfComment,
  bcfExportUrl,
  bcfSnapshotUrl,
  captureToViewpoint,
  createBcfTopic,
  deleteBcfTopic,
  fetchBcfTopics,
  formatRelativeDate,
  importBcfZip,
  statusColor,
  updateBcfTopic,
  viewpointToApplyRequest,
  type BcfImportResult,
  type BcfTopic,
  type BcfViewpoint,
} from './bcf';

function makeViewpoint(overrides: Partial<BcfViewpoint> = {}): BcfViewpoint {
  return {
    camera: { pos: [1, 2, 3], target: [4, 5, 6] },
    isolated_ids: [10, 11],
    hidden_ids: [20],
    selected_id: 30,
    highlighted_ids: [40, 41],
    ...overrides,
  };
}

function makeCapture(overrides: Partial<CapturedViewState> = {}): CapturedViewState {
  return {
    camera: { pos: [1, 2, 3], target: [4, 5, 6] },
    isolatedIds: [10, 11],
    hiddenIds: [20],
    selectedId: 30,
    highlightedIds: [40, 41],
    snapshotDataUrl: 'data:image/jpeg;base64,abc',
    ...overrides,
  };
}

function makeTopic(overrides: Partial<BcfTopic> = {}): BcfTopic {
  return {
    guid: 'topic-guid-1',
    title: 'Wall clashes with duct',
    description: 'Move the duct up by 10 cm.',
    topic_type: 'Issue',
    status: 'Open',
    priority: 'Normal',
    assigned_to: '',
    author: 'alice',
    created_at: '2026-06-01T10:00:00Z',
    modified_at: '2026-06-02T10:00:00Z',
    labels: [],
    comments: [],
    viewpoint: makeViewpoint(),
    has_snapshot: true,
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('statusColor', () => {
  it('maps each status to its Atlas token', () => {
    expect(statusColor('Open')).toBe('var(--acc)');
    expect(statusColor('In Progress')).toBe('var(--amber)');
    expect(statusColor('Resolved')).toBe('var(--green-live)');
    expect(statusColor('Closed')).toBe('var(--f-3)');
  });
});

describe('captureToViewpoint', () => {
  it('maps camelCase capture fields to the snake_case wire shape', () => {
    expect(captureToViewpoint(makeCapture())).toEqual({
      camera: { pos: [1, 2, 3], target: [4, 5, 6] },
      isolated_ids: [10, 11],
      hidden_ids: [20],
      selected_id: 30,
      highlighted_ids: [40, 41],
    });
  });

  it('preserves a null selection and empty id lists', () => {
    const viewpoint = captureToViewpoint(
      makeCapture({ selectedId: null, isolatedIds: [], hiddenIds: [], highlightedIds: [] }),
    );
    expect(viewpoint.selected_id).toBeNull();
    expect(viewpoint.isolated_ids).toEqual([]);
    expect(viewpoint.hidden_ids).toEqual([]);
    expect(viewpoint.highlighted_ids).toEqual([]);
  });

  it('does not leak the snapshot into the viewpoint', () => {
    const viewpoint = captureToViewpoint(makeCapture());
    expect(Object.keys(viewpoint).sort()).toEqual([
      'camera',
      'hidden_ids',
      'highlighted_ids',
      'isolated_ids',
      'selected_id',
    ]);
  });
});

describe('viewpointToApplyRequest', () => {
  it('maps snake_case wire fields to the camelCase bridge request', () => {
    expect(viewpointToApplyRequest(makeViewpoint())).toEqual({
      camera: { pos: [1, 2, 3], target: [4, 5, 6] },
      isolatedIds: [10, 11],
      hiddenIds: [20],
      selectedId: 30,
      highlightedIds: [40, 41],
    });
  });

  it('round-trips through captureToViewpoint', () => {
    const capture = makeCapture();
    const request = viewpointToApplyRequest(captureToViewpoint(capture));
    expect(request).toEqual({
      camera: capture.camera,
      isolatedIds: capture.isolatedIds,
      hiddenIds: capture.hiddenIds,
      selectedId: capture.selectedId,
      highlightedIds: capture.highlightedIds,
    });
  });
});

describe('formatRelativeDate', () => {
  const now = new Date('2026-06-12T12:00:00Z');

  it('reads "just now" under 45 seconds', () => {
    expect(formatRelativeDate('2026-06-12T11:59:30Z', now)).toBe('just now');
  });

  it('treats future timestamps (clock skew) as "just now"', () => {
    expect(formatRelativeDate('2026-06-12T12:05:00Z', now)).toBe('just now');
  });

  it('formats minutes, never showing 0m', () => {
    expect(formatRelativeDate('2026-06-12T11:59:10Z', now)).toBe('1m ago');
    expect(formatRelativeDate('2026-06-12T11:35:00Z', now)).toBe('25m ago');
  });

  it('formats hours under a day', () => {
    expect(formatRelativeDate('2026-06-12T09:00:00Z', now)).toBe('3h ago');
    expect(formatRelativeDate('2026-06-11T13:00:00Z', now)).toBe('23h ago');
  });

  it('formats days under a week', () => {
    expect(formatRelativeDate('2026-06-11T11:00:00Z', now)).toBe('1d ago');
    expect(formatRelativeDate('2026-06-06T11:00:00Z', now)).toBe('6d ago');
  });

  it('falls back to an absolute date after a week', () => {
    expect(formatRelativeDate('2026-05-01T12:00:00Z', now)).toBe('May 1, 2026');
  });

  it('returns an empty string for unparseable input', () => {
    expect(formatRelativeDate('not-a-date', now)).toBe('');
    expect(formatRelativeDate('', now)).toBe('');
  });
});

describe('fetchBcfTopics', () => {
  it('GETs the topics route and unwraps the list', async () => {
    const topic = makeTopic();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ topics: [topic] }));
    vi.stubGlobal('fetch', fetchMock);

    const topics = await fetchBcfTopics();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl.endsWith('/api/bcf/topics')).toBe(true);
    expect(topics).toEqual([topic]);
  });

  it('throws with status and body text when no model is loaded', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ detail: 'No IFC model loaded' }, 400));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchBcfTopics()).rejects.toThrow(
      'API error 400: {"detail":"No IFC model loaded"}',
    );
  });
});

describe('createBcfTopic', () => {
  it('POSTs JSON with the viewpoint and snapshot data url', async () => {
    const created = makeTopic({ guid: 'new-guid' });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(created));
    vi.stubGlobal('fetch', fetchMock);

    const result = await createBcfTopic({
      title: 'New issue',
      description: 'Details',
      status: 'Open',
      priority: 'High',
      assigned_to: 'bob',
      viewpoint: makeViewpoint(),
      snapshot_data_url: 'data:image/jpeg;base64,abc',
    });

    expect(result).toEqual(created);
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl.endsWith('/api/bcf/topics')).toBe(true);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body as string);
    expect(body.title).toBe('New issue');
    expect(body.priority).toBe('High');
    expect(body.viewpoint).toEqual(makeViewpoint());
    expect(body.snapshot_data_url).toBe('data:image/jpeg;base64,abc');
  });

  it('omits optional fields that were not provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(makeTopic()));
    vi.stubGlobal('fetch', fetchMock);

    await createBcfTopic({ title: 'Bare topic' });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ title: 'Bare topic' });
  });
});

describe('updateBcfTopic', () => {
  it('PATCHes the topic route with only the changed fields', async () => {
    const updated = makeTopic({ status: 'Resolved' });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(updated));
    vi.stubGlobal('fetch', fetchMock);

    const result = await updateBcfTopic('topic-guid-1', { status: 'Resolved' });

    expect(result).toEqual(updated);
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl.endsWith('/api/bcf/topics/topic-guid-1')).toBe(true);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ status: 'Resolved' });
  });

  it('surfaces a 404 for an unknown guid', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ detail: 'Topic not found' }, 404));
    vi.stubGlobal('fetch', fetchMock);

    await expect(updateBcfTopic('missing', { title: 'x' })).rejects.toThrow(/API error 404/);
  });
});

describe('deleteBcfTopic', () => {
  it('DELETEs the topic route and resolves', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ deleted: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(deleteBcfTopic('topic-guid-1')).resolves.toBeUndefined();

    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl.endsWith('/api/bcf/topics/topic-guid-1')).toBe(true);
    expect(init.method).toBe('DELETE');
  });
});

describe('addBcfComment', () => {
  it('POSTs the comment and returns the topic with it appended', async () => {
    const withComment = makeTopic({
      comments: [
        { guid: 'c1', author: 'alice', date: '2026-06-12T10:00:00Z', comment: 'Fixed.' },
      ],
    });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(withComment));
    vi.stubGlobal('fetch', fetchMock);

    const result = await addBcfComment('topic-guid-1', 'Fixed.');

    expect(result.comments).toHaveLength(1);
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl.endsWith('/api/bcf/topics/topic-guid-1/comments')).toBe(true);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ comment: 'Fixed.' });
  });

  it('includes the author only when given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(makeTopic()));
    vi.stubGlobal('fetch', fetchMock);

    await addBcfComment('topic-guid-1', 'Note', 'bob');

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ comment: 'Note', author: 'bob' });
  });
});

describe('importBcfZip', () => {
  it('POSTs the file as multipart form data and returns the merge result', async () => {
    const result: BcfImportResult = {
      imported: 2,
      skipped: 1,
      topics: [makeTopic(), makeTopic({ guid: 'topic-guid-2' })],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(result));
    vi.stubGlobal('fetch', fetchMock);

    const file = new File(['zipbytes'], 'issues.bcfzip', { type: 'application/zip' });
    const imported = await importBcfZip(file);

    expect(imported).toEqual(result);
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl.endsWith('/api/bcf/import')).toBe(true);
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('file')).toBe(file);
  });
});

describe('url builders', () => {
  it('bcfExportUrl targets the export route', () => {
    expect(bcfExportUrl().endsWith('/api/bcf/export')).toBe(true);
  });

  it('bcfSnapshotUrl targets the per-topic snapshot route', () => {
    expect(bcfSnapshotUrl('topic-guid-1').endsWith('/api/bcf/topics/topic-guid-1/snapshot')).toBe(
      true,
    );
  });

  it('bcfSnapshotUrl escapes guids that contain reserved characters', () => {
    expect(bcfSnapshotUrl('a/b')).toContain('/api/bcf/topics/a%2Fb/snapshot');
  });
});
