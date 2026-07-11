import { afterEach, describe, expect, it, vi } from 'vitest';
import { newProject } from '../api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('newProject api', () => {
  it('POSTs to /ifc/new with the template and returns the bytes', async () => {
    const buf = new TextEncoder().encode('ISO-10303-21;').buffer;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(buf),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await newProject('two_storey');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/ifc/new');
    expect(String(url)).toContain('template=two_storey');
    expect(init.method).toBe('POST');
    expect(result).toBe(buf);
  });

  it('defaults to single_storey', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });
    vi.stubGlobal('fetch', fetchMock);

    await newProject();

    expect(String(fetchMock.mock.calls[0][0])).toContain('template=single_storey');
  });

  it('throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('boom'),
    }));

    await expect(newProject()).rejects.toThrow('500');
  });
});
