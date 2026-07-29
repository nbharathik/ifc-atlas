# ADR 0004: Session and use-case ownership

- Status: Accepted
- Date: 2026-07-26
- Owners: viewer, IFC API, application services

## Context

`ViewerPanel` created, configured, mutated, and disposed the complete renderer
graph. `ifc_routes.py` mixed FastAPI transport with upload state transitions,
conversion cache policy, sidecar invocation, artifact publication, metadata
indexing, and AABB warm-up. Both modules were difficult to change safely
because resource lifetime and application workflow had no explicit owner.

A new framework, dependency-injection container, renderer replacement, or
parallel implementation would increase migration risk. The approved plan keeps
the current engines and extracts ownership behind small application-defined
boundaries.

## Decision

One `ViewerSession` owns one viewer engine lifetime. The session owns
cancellation, capability cleanup, asynchronous teardown barriers, final engine
disposal, and worker object URLs. Disposal is bounded and idempotent. React is
the composition layer and will progressively publish commands through typed
capabilities.

Backend transport composes request-scoped application services explicitly:

- `IfcConversionService` owns hashing, cache/prebuild coordination, the
  `IfcConverter` port, artifact validation, publication, and progress cleanup;
- `IfcIngestionService` owns active-model readiness transitions, IfcOpenShell
  load, checkpoint binding, derived-data warm-up, and model-sync publication.

Do not add a dependency-injection framework. Constructors and small route
composition functions are sufficient. Continue using `IfcService` as the
documented transitional single-model adapter until a scoped `ModelContext` is
implemented.

## Consequences

Benefits:

- engine resources have one deterministic final owner;
- eager and interactive conversions share one implementation;
- cache/converter behavior is unit-testable without FastAPI;
- HTTP handlers are smaller and future converter candidates use the existing
  application port;
- later capability and use-case moves have a stable destination.

Risks:

- `ViewerPanel` is still large until capabilities move behind the session;
- request-scoped services still reference process-global compatibility
  adapters;
- asynchronous teardown deadlines may release a broken worker operation before
  it naturally settles;
- temporary factory functions add wiring while old routes are migrated.

## Verification

- viewer session lifecycle tests cover cleanup order, cancellation, barriers,
  idempotence, and URL release;
- conversion and ingestion services have focused success/failure/cache tests;
- existing API, generated contract, renderer, build and performance gates pass;
- subsequent Phase 2 blocks update the modularization ledger and remove
  compatibility wiring only after parity.
