# Atlas render artifact manifest v1

The manifest is the stable boundary between IFC conversion, cache storage, and
frontend rendering. Its JSON Schema is generated from
`ArtifactManifestV1` in `backend/app/models/contracts.py`.

## Lookup

`GET /api/ifc/artifact-manifest?fingerprint=<sha256>&profile=balanced`
returns `ArtifactManifestLookupV1`.

- `cached=false` and `manifest=null` means no validated artifact is available.
- `cached=true` means the internal cache record, preprocessing checksum, file
  length, and artifact checksum all passed before the public manifest was
  built.

The legacy `/api/ifc/fragment-manifest` endpoint remains temporarily for
compatibility. New callers must use the versioned endpoint.

## Integrity rules

1. `source_sha256` and `source_revision_id` identify immutable IFC bytes.
2. `cache_key` covers source, profile, settings, converter build, dependency
   versions, and cache schema.
3. `artifact.sha256` covers the exact served fragment bytes.
4. `preprocessing_sha256` covers canonical preprocessing JSON.
5. `manifest_sha256` covers every manifest field except itself.
6. JSON is canonicalized with sorted keys, compact separators, ASCII escaping,
   and non-finite values forbidden.

## Compatibility

Consumers must reject:

- an unknown `schema_name` or unsupported `schema_version`;
- a Fragments format version incompatible with the active renderer;
- a checksum mismatch;
- an artifact source revision different from the requested model revision.

Adding optional fields is backward compatible. Renaming fields, changing hash
material, changing enum meaning, or removing fields requires manifest v2.

## Current limitations

- only the That Open Fragments media type is active;
- conversion jobs expose a stable state contract but the current sidecar is
  not reliably cancellable, so `cancellable=false`;
- the manifest URL is API-relative and assumes the normal authenticated fetch
  boundary;
- spatial tiles and metadata shards will extend the artifact family in
  Phases 4 and 5.
