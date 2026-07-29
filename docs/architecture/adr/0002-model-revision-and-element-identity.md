# ADR 0002: Model, revision, and element identity

- Status: Accepted
- Date: 2026-07-26
- Owners: ingestion, backend API, frontend state

## Context

IFC express IDs are only local to one IFC file. A fingerprint identifies
bytes, not a logical model or project. The current application often uses a
single fingerprint for all three meanings, which blocks safe editing,
federation, shared-server isolation, and durable caches.

## Decision

New boundaries use these versioned identities:

- `ProjectId`: `prj_` plus 32 lowercase hexadecimal characters;
- `ModelId`: `mdl_` plus 32 lowercase hexadecimal characters;
- `RevisionId`: `rev_` plus the 64-character SHA-256 of canonical IFC bytes;
- `ElementKey`: a compound object containing `ModelId`, `RevisionId`, positive
  IFC express ID, and optional IFC GlobalId.

During the migration:

- `ProjectId` is deterministically derived from `IfcProject.GlobalId`, with the
  original source hash as a fallback;
- `ModelId` is derived from the original import hash and stays stable through
  edits in the current session;
- `RevisionId` changes whenever the persisted working IFC bytes change;
- the existing `model_fingerprint` and `model_version` fields remain available
  for compatibility.

The canonical definitions live in `backend/app/models/contracts.py`. The
frontend consumes generated OpenAPI types.

## Consequences

Benefits:

- compound keys prevent collisions between models and revisions;
- immutable revision identity supports correct cache and job addressing;
- legacy callers can migrate without a flag-day API rewrite.

Risks:

- re-importing a derived file currently creates a new `ModelId`, because a
  durable model catalog is Phase 4 work;
- an IFC file with a reused project GlobalId can share a `ProjectId`; server
  tenancy must still be an authorization boundary;
- adding identity to old persisted frontend state requires compatibility
  handling until all stored sessions have been refreshed.

## Verification

- deterministic golden identity output is committed and tested;
- lineage tests show model identity stays stable while revision identity
  changes;
- validation rejects invalid IDs and non-positive express IDs;
- `/api/ifc/identity` and upload/meta responses expose `ModelIdentityV1`.
