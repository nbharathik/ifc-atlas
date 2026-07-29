import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  authenticatedWsUrl,
  clearServerApiToken,
  getStoredServerApiToken,
  installApiAuthentication,
  setServerApiToken,
} from './platform';

describe('API authentication boundary', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the server token per-tab and authenticates only Atlas API traffic', async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });

    const nativeFetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('{}', { status: 200 }),
    );
    vi.stubGlobal('window', {
      location: {
        href: 'https://atlas.example.test/viewer',
        origin: 'https://atlas.example.test',
        protocol: 'https:',
        host: 'atlas.example.test',
      },
      fetch: nativeFetch,
    });

    setServerApiToken('  server-secret  ');
    expect(getStoredServerApiToken()).toBe('server-secret');

    installApiAuthentication();
    await window.fetch('/api/private', {
      headers: { 'X-Test': 'preserved' },
    });
    await window.fetch('/worker.mjs');

    const apiInit = nativeFetch.mock.calls[0]?.[1] as RequestInit;
    const apiHeaders = new Headers(apiInit.headers);
    expect(apiHeaders.get('Authorization')).toBe('Bearer server-secret');
    expect(apiHeaders.get('X-Test')).toBe('preserved');

    const assetInit = nativeFetch.mock.calls[1]?.[1];
    expect(assetInit).toBeUndefined();

    const websocketUrl = await authenticatedWsUrl('/api/chat/ws');
    expect(websocketUrl).toBe(
      'wss://atlas.example.test/api/chat/ws?access_token=server-secret',
    );

    clearServerApiToken();
    expect(getStoredServerApiToken()).toBeNull();
  });
});
