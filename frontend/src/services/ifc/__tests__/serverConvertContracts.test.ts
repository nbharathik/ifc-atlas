import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkFragmentManifest } from '../serverConvert';

const SHA = 'a'.repeat(64);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Atlas artifact manifest adapter', () => {
  it('uses the generated v1 contract and preserves the legacy caller shape', async () => {
    const manifest = {
      schema_name: 'ifc-atlas.render-artifact-manifest' as const,
      schema_version: 1 as const,
      artifact_id: `art_${'c'.repeat(64)}`,
      source_revision_id: `rev_${SHA}`,
      source_sha256: SHA,
      artifact_kind: 'full' as const,
      profile: 'balanced' as const,
      cache_key: 'c'.repeat(64),
      fragments_format_version: '3.4.3',
      converter: {
        contract_version: '1.0' as const,
        engine: 'web-ifc',
        engine_version: '0.0.77',
        runtime: 'node' as const,
        build_sha256: 'd'.repeat(64),
        settings_sha256: 'e'.repeat(64),
        dependencies: { 'web-ifc': '0.0.77' },
      },
      artifact: {
        media_type: 'application/vnd.thatopen.fragments',
        byte_length: 4096,
        sha256: 'f'.repeat(64),
        serve_url: `/api/ifc/fragments/serve?fingerprint=${SHA}&profile=balanced`,
      },
      preprocessing: {},
      preprocessing_sha256: '1'.repeat(64),
      manifest_sha256: '2'.repeat(64),
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          contract_version: '1.0',
          cached: true,
          fingerprint: SHA,
          profile: 'balanced',
          manifest,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkFragmentManifest(SHA, 'balanced');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/api/ifc/artifact-manifest?',
    );
    expect(result.cached).toBe(true);
    expect(result.size_bytes).toBe(4096);
    expect(result.serve_url).toBe(manifest.artifact.serve_url);
    expect(result.artifact_manifest?.schema_version).toBe(1);
  });

  it('returns a safe cache miss for malformed or unavailable responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));

    await expect(checkFragmentManifest(SHA, 'balanced')).resolves.toEqual({
      cached: false,
      fingerprint: SHA,
      profile: 'balanced',
      size_bytes: null,
      serve_url: null,
      artifact_manifest: null,
    });
  });
});
