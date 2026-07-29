# ADR 0003: Atlas render artifact manifest

- Status: Accepted
- Date: 2026-07-26
- Owners: converter, cache, renderer

## Context

The renderer currently consumes That Open Fragments produced by web-ifc.
Cache correctness already depends on source bytes, conversion settings,
converter build, dependency versions, and artifact schema. Exposing only a
fingerprint and byte count couples the frontend to an implementation detail
and provides no portable contract for future converter benchmarks.

## Decision

Own a versioned, engine-neutral `ifc-atlas.render-artifact-manifest` contract.
Manifest v1 records:

- immutable source revision and SHA-256;
- artifact kind, graphics profile, cache key, byte length, media type, and
  content checksum;
- converter engine/version, build checksum, settings checksum, and dependency
  versions;
- preprocessing metadata and checksum;
- checksum of the complete unsigned manifest payload;
- a bounded API-relative artifact URL.

The existing internal fragment cache manifest remains schema v2. It is an
atomic cache-publication record and is adapted to the public manifest v1 only
after checksum validation. This avoids duplicating artifact bytes or changing
the active renderer.

web-ifc remains the production converter. Three.js/WebGL and Fragments remain
the production renderer. Backend conversion calls pass through the
application-owned `IfcConverter` protocol and `WebIfcSidecarConverter`
adapter. New code depends on that protocol, the Atlas manifest, and generated
types, allowing later IfcOpenShell-native or Rust/IFC Lite candidates to emit
the same contract.

## Consequences

Benefits:

- corrupt or mismatched artifacts fail as cache misses;
- converter replacements can be benchmarked without another frontend
  contract rewrite;
- the frontend can skip IFC re-upload while verifying exact provenance.

Risks:

- manifests add a small metadata and checksum cost;
- public manifest v1 and internal cache schema v2 must be migrated
  independently;
- `application/vnd.thatopen.fragments` remains format-specific until another
  artifact kind is promoted.

## Verification

- construction, round-trip, preprocessing-tamper, manifest-tamper, and route
  adapter tests pass;
- generated TypeScript builds and is checked for drift in CI;
- the viewer manifest fast path uses `/api/ifc/artifact-manifest`;
- existing web-ifc/Fragments conversion and render characterization tests
  remain unchanged.
