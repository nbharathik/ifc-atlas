# Phase 2 modularization

**Status:** Phases 2A and 2B implemented locally; Phase 2C recommended next

**Date:** 2026-07-26

## Scope

Phase 2 is split into cohesive, reviewable subsystem blocks. This avoids a
high-risk rewrite of the 7,358-line viewer and 3,230-line IFC route module while
also avoiding tiny cleanups that do not change ownership.

| Block | Boundary | Status |
|---|---|---|
| 2A | Viewer lifetime plus IFC conversion/ingestion use cases | Implemented locally |
| 2B | Renderer boot/model residency plus selection/visibility capabilities | Implemented locally |
| 2C | Backend edit/checkpoint/operation use cases and scoped model context | Recommended next |
| 2D | Typed tool handlers and centralized policy | Planned |

## Phase 2A result

### Frontend session ownership

`ViewerSession` now owns exactly one engine object and the resources whose
release must be ordered around it:

```text
React ViewerPanel
      |
      v
ViewerSession
  |-- cancellation signal
  |-- capability cleanup stack
  |-- in-flight async barriers
  |-- OBC Components engine
  `-- fragment worker object URLs
```

Disposal is idempotent. Session-scoped work is aborted first, capability
cleanup runs in reverse registration order, outstanding worker operations get
a bounded settling window, the engine is disposed once, and blob URLs are
revoked last. A stuck worker therefore cannot leak the complete viewer
indefinitely.

This block does not pretend that `ViewerPanel` is already a small composition
host. Most renderer configuration and capabilities remain in that component.
The new owner is the seam through which those capabilities can move without
changing the engine or React API.

### Backend use-case ownership

The HTTP route layer now composes two application services from the current
adapters:

```text
FastAPI transport
  |-- validate multipart/body/query
  |-- map application errors to HTTP
  `-- map artifact result to headers/body
          |
          +--> IfcIngestionService
          |      |-- readiness and active-model transition
          |      |-- checkpoint baseline
          |      |-- metadata/AABB warm-up
          |      `-- submit render prebuild
          |
          `--> IfcConversionService
                 |-- source hash and cache key
                 |-- cache/prebuild coordination
                 |-- IfcConverter port (web-ifc adapter today)
                 |-- output validation
                 `-- atomic artifact publication
```

The upload background task no longer carries a second conversion
implementation. Both eager prebuild and interactive `POST /convert` use the
same output validation, cache publication, and converter contract.

The route module changed from 3,230 to about 2,945 lines in this block. The
remaining size is primarily edit, operation, query, spatial subset, checkpoint,
and export behavior scheduled for Phase 2C or later domain blocks.

## Preserved invariants

- web-ifc remains the production converter through `WebIfcSidecarConverter`;
- Three.js/WebGL, That Open Components and Fragments remain the renderer;
- IfcOpenShell remains the semantic and edit engine;
- no custom parser, geometry kernel, Rust converter, or WebGPU production path
  was introduced;
- upload, conversion, cache, manifest, job, response headers and generated
  OpenAPI contracts remain compatible;
- local desktop and authenticated server profiles remain unchanged;
- failures in background prebuild, metadata index, or AABB warm-up remain
  non-fatal to an already-loaded semantic model.

## Transitional state

The backend still supports one active `IfcService` model per process. Phase 2A
does not hide that limitation:

- request-scoped orchestration services receive the adapter explicitly;
- background AABB warm-up captures the model instance loaded by that ingestion
  instead of reading the mutable global later;
- metadata and sync services remain process-global compatibility adapters.

Phase 2C should introduce a scoped `ModelContext` keyed by stable model/revision
identity, then migrate read/edit handlers one use case at a time. Shared-server
multi-user isolation is not complete until that work passes two-context
concurrency tests.

## Verification

Focused tests cover:

- viewer cleanup order, async barriers, abort signaling, idempotent disposal,
  and worker-URL release;
- fresh conversion, cache hit, no-cache operation, converter failure, invalid
  tiny artifact rejection, publication, and progress cleanup;
- ingestion state ordering, index invalidation/hydration, checkpoint binding,
  metadata/AABB background work, sync events, and failed-load rollback;
- existing upload-size, conversion route, manifest, status, and Phase 1
  contract behavior.

The block is accepted only after the full frontend/backend suites, production
build, generated-contract drift check, and renderer parity scenario pass. The
production bundle and BasicHouse conversion must stay within five percent of
the Phase 0/1 baseline.

### Local verification result

- backend fast suite: 1,702 passed, one unrelated optional-module skip;
- frontend suite: 2,750 passed, one existing skip;
- frontend typecheck/build, backend Ruff, production npm audit, generated
  OpenAPI/docs drift, and strict documentation build: passed;
- renderer parity: passed on the second run in 1.4 minutes; the first run hit a
  pick-dependent ghost-mode relocation failure with healthy render state;
- viewer-engine bundle: 6,725,668 bytes / 1,285.74 KiB gzip, exactly unchanged;
- warm fragment cache: 180.9 and 133.4 ms, comparable to the 152.1 and
  137.1 ms baseline runs;
- clean cold conversion: 4,682.6 and 4,666.0 ms, above the 4,136.0 ms single
  baseline sample. Most variance was reported inside unchanged web-ifc, and
  the current Python 3.13 runtime differs from the Python 3.12 reference.

The cold-conversion five-percent gate therefore remains open pending a repeat
on the recorded runtime/reference conditions. No production optimization was
added merely to hide a noisy or non-comparable sample.

## Phase 2B result

Phase 2B kept the current geometry and renderer while moving the first complete
runtime boundary:

- `ViewerSession.start()` is start-once and exposes session-scoped cleanup,
  cancellation, and object-URL ownership to the initializer;
- `viewerRuntime.ts` owns OBC world, renderer, camera, grid, context recovery,
  on-demand invalidation, color management, lighting, resize/DPR resources,
  and interaction DPR hysteresis;
- `fragmentRuntime.ts` owns FragmentsManager initialization, the blob-backed
  worker URL, update serialization/acknowledgement, and the resident model
  acknowledgement target;
- `ViewerStateCapabilities` exposes narrow selection and visibility commands.
  Canvas picking, saved viewpoints, and the external viewer bridge use these
  commands instead of each implementing store mutations;
- `RenderStateCoordinator` remains the single engine-side compositor for
  selection appearance, visibility, opacity, and culler layers.

The existing Three.js/WebGL, That Open Components, Fragments, web-ifc
conversion, loading strategies, geometry bytes, shortcuts, and public viewer
refs are unchanged. `ViewerPanel` moved from about 7,346 lines after Phase 2A
to about 6,888 lines.

Lifecycle snapshots now report startup state, cleanup count, barrier count, and
owned object-URL count. Tests repeat start/dispose for 20 sessions and require
every counter to return to zero, every cleanup to run, and every engine to be
disposed once.

### Phase 2B verification

- focused lifecycle and capability tests: 9 passed;
- frontend typecheck, full unit suite, and production build: passed;
- hardware-backed Chromium renderer parity: passed in 18.5 seconds;
- viewer-engine bundle: 6,725,668 bytes / 1,285.74 KiB gzip, unchanged;
- ViewerPanel chunk: about 315.24 kB / 97.96 KiB gzip, within the five-percent
  gate.

Two default SwiftShader attempts painted healthy geometry (88 draw calls,
616,287 triangles, no context loss or render-state error) but the separate
browser metadata worker did not populate the tree within the harness's
20-second post-paint deadline. The hardware-backed gate completed the same
metadata and renderer checks. Keep the software-renderer timeout visible; do
not widen it without a measured metadata/runtime decision.

## Phase 2C recommended settings

Use one cohesive backend block:

1. Introduce a request-scoped `ModelContext` keyed by model and revision.
2. Move edit, operation, checkpoint, undo/redo, and export orchestration from
   `ifc_routes.py` into explicit application services.
3. Keep FastAPI handlers limited to validation, authorization, and transport
   mapping.
4. Preserve the current single-model adapter as a compatibility path until
   two-context concurrency tests pass.
5. Do not change IfcOpenShell, the current API contracts, geometry conversion,
   or renderer behavior in this block.
