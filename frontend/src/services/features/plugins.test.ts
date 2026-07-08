import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PluginApiError,
  buildRunParams,
  coerceParamValue,
  createPlugin,
  createPluginCopy,
  defaultParamRawValues,
  deletePlugin,
  fetchPlugin,
  fetchPlugins,
  installPluginZip,
  nextCopyPluginId,
  pluginErrorMessage,
  runPlugin,
  slugifyPluginId,
  updatePlugin,
  type PluginListItem,
  type PluginManifest,
  type PluginParam,
} from './plugins';

function makeParam(overrides: Partial<PluginParam> = {}): PluginParam {
  return {
    name: 'tolerance_mm',
    label: 'Tolerance (mm)',
    type: 'number',
    default: 5,
    required: false,
    ...overrides,
  };
}

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'wall-report',
    name: 'Wall report',
    description: 'Lists every wall.',
    version: '1.0.0',
    params: [makeParam()],
    requires_write: false,
    ...overrides,
  };
}

function makeListItem(overrides: Partial<PluginListItem> = {}): PluginListItem {
  return { ...makeManifest(), builtin: false, ...overrides };
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

describe('nextCopyPluginId', () => {
  it('appends -copy on the first collision', () => {
    expect(nextCopyPluginId('wall-report')).toBe('wall-report-copy');
  });

  it('numbers the second copy', () => {
    expect(nextCopyPluginId('wall-report-copy')).toBe('wall-report-copy-2');
  });

  it('increments an existing copy number', () => {
    expect(nextCopyPluginId('wall-report-copy-2')).toBe('wall-report-copy-3');
    expect(nextCopyPluginId('wall-report-copy-9')).toBe('wall-report-copy-10');
  });

  it('treats a bare "copy" id like any other id', () => {
    expect(nextCopyPluginId('copy')).toBe('copy-copy');
  });
});

describe('slugifyPluginId', () => {
  it('lowercases and replaces symbol runs with single dashes', () => {
    expect(slugifyPluginId('Wall Report (v2)!')).toBe('wall-report-v2');
  });

  it('trims leading and trailing dashes', () => {
    expect(slugifyPluginId('  Spaced out  ')).toBe('spaced-out');
  });

  it('never returns an empty id', () => {
    expect(slugifyPluginId('')).toBe('plugin');
    expect(slugifyPluginId('!!!')).toBe('plugin');
  });
});

describe('coerceParamValue', () => {
  it('parses numbers, including decimals and negatives', () => {
    const param = makeParam({ type: 'number' });
    expect(coerceParamValue(param, '42')).toEqual({ ok: true, value: 42 });
    expect(coerceParamValue(param, ' 4.5 ')).toEqual({ ok: true, value: 4.5 });
    expect(coerceParamValue(param, '-3')).toEqual({ ok: true, value: -3 });
  });

  it('rejects non-numeric text for number params', () => {
    const result = coerceParamValue(makeParam({ type: 'number' }), 'abc');
    expect(result).toEqual({ ok: false, error: "param 'tolerance_mm': expected number" });
  });

  it('rejects an empty required value', () => {
    const result = coerceParamValue(makeParam({ required: true }), '');
    expect(result).toEqual({ ok: false, error: "param 'tolerance_mm': required" });
  });

  it('omits an empty optional value so script defaults apply', () => {
    expect(coerceParamValue(makeParam({ required: false }), '')).toEqual({
      ok: true,
      value: undefined,
    });
    expect(
      coerceParamValue(makeParam({ type: 'string', required: false }), '   '),
    ).toEqual({ ok: true, value: undefined });
  });

  it('passes booleans through from checkbox state or text', () => {
    const param = makeParam({ name: 'dry_run', type: 'boolean' });
    expect(coerceParamValue(param, true)).toEqual({ ok: true, value: true });
    expect(coerceParamValue(param, false)).toEqual({ ok: true, value: false });
    expect(coerceParamValue(param, 'true')).toEqual({ ok: true, value: true });
  });

  it('keeps string values verbatim (no trimming of intentional spaces)', () => {
    const param = makeParam({ name: 'prefix', type: 'string' });
    expect(coerceParamValue(param, ' W ')).toEqual({ ok: true, value: ' W ' });
  });
});

describe('buildRunParams', () => {
  const params: PluginParam[] = [
    makeParam({ name: 'tolerance_mm', type: 'number', required: true }),
    makeParam({ name: 'prefix', type: 'string', required: false }),
    makeParam({ name: 'dry_run', type: 'boolean', required: false }),
  ];

  it('coerces every value and omits empty optionals', () => {
    const built = buildRunParams(params, {
      tolerance_mm: '2.5',
      prefix: '',
      dry_run: true,
    });
    expect(built).toEqual({ ok: true, values: { tolerance_mm: 2.5, dry_run: true } });
  });

  it('collects every validation error at once', () => {
    const built = buildRunParams(params, {
      tolerance_mm: 'abc',
      prefix: '',
      dry_run: false,
    });
    expect(built.ok).toBe(false);
    if (built.ok === false) {
      expect(built.errors).toEqual(["param 'tolerance_mm': expected number"]);
    }
  });

  it('treats a missing raw value as empty (required -> error)', () => {
    const built = buildRunParams(params, { dry_run: false });
    expect(built.ok).toBe(false);
    if (built.ok === false) {
      expect(built.errors).toEqual(["param 'tolerance_mm': required"]);
    }
  });
});

describe('defaultParamRawValues', () => {
  it('prefills from manifest defaults, stringifying numbers', () => {
    const values = defaultParamRawValues([
      makeParam({ name: 'tol', type: 'number', default: 5 }),
      makeParam({ name: 'prefix', type: 'string', default: 'W' }),
      makeParam({ name: 'dry', type: 'boolean', default: true }),
    ]);
    expect(values).toEqual({ tol: '5', prefix: 'W', dry: true });
  });

  it('falls back to empty text / unchecked when no default exists', () => {
    const values = defaultParamRawValues([
      makeParam({ name: 'tol', type: 'number', default: undefined }),
      makeParam({ name: 'dry', type: 'boolean', default: undefined }),
    ]);
    expect(values).toEqual({ tol: '', dry: false });
  });
});

describe('fetchPlugins', () => {
  it('unwraps the plugins array from the list envelope', async () => {
    const items = [makeListItem(), makeListItem({ id: 'door-audit', builtin: true })];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ plugins: items }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchPlugins();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0]).endsWith('/api/plugins')).toBe(true);
    expect(result).toEqual(items);
  });

  it('throws with status and body text on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ detail: 'boom' }, 500)),
    );
    await expect(fetchPlugins()).rejects.toThrow('API error 500: {"detail":"boom"}');
  });
});

describe('fetchPlugin', () => {
  it('URL-encodes the plugin id', async () => {
    const detail = { manifest: makeManifest(), script: 'print(1)', builtin: false };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(detail));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchPlugin('odd id/with#chars');

    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/api/plugins/odd%20id%2Fwith%23chars',
    );
    expect(result).toEqual(detail);
  });
});

describe('createPlugin', () => {
  it('POSTs the manifest and script as JSON', async () => {
    const manifest = makeManifest();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ...manifest, builtin: false }, 201));
    vi.stubGlobal('fetch', fetchMock);

    await createPlugin(manifest, 'print(1)');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.endsWith('/api/plugins')).toBe(true);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ manifest, script: 'print(1)' });
  });

  it('throws a PluginApiError carrying the HTTP status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ detail: 'exists' }, 409)),
    );
    const err = await createPlugin(makeManifest(), 'x = 1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginApiError);
    expect((err as PluginApiError).status).toBe(409);
    expect((err as PluginApiError).message).toBe('API error 409: {"detail":"exists"}');
  });
});

describe('createPluginCopy', () => {
  it('starts at <builtin-id>-copy and increments the suffix on 409', async () => {
    const manifest = makeManifest();
    const { id: _dropped, ...manifestNoId } = manifest;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ detail: 'exists' }, 409))
      .mockResolvedValueOnce(jsonResponse({ detail: 'exists' }, 409))
      .mockResolvedValueOnce(
        jsonResponse({ ...manifest, id: 'wall-report-copy-3', builtin: false }, 201),
      );
    vi.stubGlobal('fetch', fetchMock);

    const created = await createPluginCopy(manifestNoId, 'print(1)', 'wall-report');

    expect(created.id).toBe('wall-report-copy-3');
    const triedIds = fetchMock.mock.calls.map(
      (call) => JSON.parse((call[1] as RequestInit).body as string).manifest.id as string,
    );
    expect(triedIds).toEqual(['wall-report-copy', 'wall-report-copy-2', 'wall-report-copy-3']);
  });

  it('rethrows non-409 failures immediately', async () => {
    const manifest = makeManifest();
    const { id: _dropped, ...manifestNoId } = manifest;
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ detail: ['script: empty'] }, 422));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createPluginCopy(manifestNoId, '', 'wall-report')).rejects.toThrow(
      /API error 422/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('updatePlugin', () => {
  it('PUTs a partial body to the plugin route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(makeManifest()));
    vi.stubGlobal('fetch', fetchMock);

    await updatePlugin('wall-report', { script: 'print(2)' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.endsWith('/api/plugins/wall-report')).toBe(true);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ script: 'print(2)' });
  });

  it('surfaces the builtin read-only 403', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ detail: 'Built-in plugins are read-only' }, 403),
      ),
    );
    await expect(updatePlugin('builtin-id', { script: 'x' })).rejects.toThrow(
      'API error 403: {"detail":"Built-in plugins are read-only"}',
    );
  });
});

describe('deletePlugin', () => {
  it('issues a DELETE and returns the deletion flag', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ deleted: true }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await deletePlugin('wall-report');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.endsWith('/api/plugins/wall-report')).toBe(true);
    expect(init.method).toBe('DELETE');
    expect(result).toEqual({ deleted: true });
  });
});

describe('installPluginZip', () => {
  it('uploads the zip as multipart form data under "file"', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(makeManifest()));
    vi.stubGlobal('fetch', fetchMock);
    const file = new File(['zipbytes'], 'plugin.zip', { type: 'application/zip' });

    await installPluginZip(file);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.endsWith('/api/plugins/install-zip')).toBe(true);
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('file')).toBe(file);
  });
});

describe('runPlugin', () => {
  it('POSTs the params envelope and passes the sandbox result through', async () => {
    const runResult = {
      action: 'execute_result' as const,
      stdout: 'Found 12 walls\n',
      result_repr: "'12 walls inspected'",
      elapsed_ms: 12.0,
      plugin_id: 'wall-report',
      plugin_name: 'Wall report',
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(runResult));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runPlugin('wall-report', { tolerance_mm: 2.5, dry_run: true });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.endsWith('/api/plugins/wall-report/run')).toBe(true);
    expect(JSON.parse(init.body as string)).toEqual({
      params: { tolerance_mm: 2.5, dry_run: true },
    });
    expect(result).toEqual(runResult);
  });

  it('throws with the 422 param-validation detail intact', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({ detail: ["param 'x': expected number"] }, 422),
      ),
    );
    await expect(runPlugin('wall-report', {})).rejects.toThrow(/expected number/);
  });

  it('throws on the 400 no-model-loaded response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ detail: 'No IFC model loaded' }, 400)),
    );
    await expect(runPlugin('wall-report', {})).rejects.toThrow(/API error 400/);
  });
});

describe('pluginErrorMessage', () => {
  it('joins a 422 detail list into one line', () => {
    const err = new PluginApiError(
      422,
      JSON.stringify({ detail: ["param 'a': expected number", "param 'b' is required"] }),
    );
    expect(pluginErrorMessage(err)).toBe("param 'a': expected number; param 'b' is required");
  });

  it('unwraps a string detail', () => {
    const err = new PluginApiError(400, JSON.stringify({ detail: 'No IFC model loaded' }));
    expect(pluginErrorMessage(err)).toBe('No IFC model loaded');
  });

  it('falls back to the raw message for non-JSON bodies', () => {
    const err = new PluginApiError(500, 'Internal Server Error');
    expect(pluginErrorMessage(err)).toBe('API error 500: Internal Server Error');
  });

  it('handles plain errors and non-errors', () => {
    expect(pluginErrorMessage(new Error('boom'))).toBe('boom');
    expect(pluginErrorMessage('oops')).toBe('oops');
  });
});
