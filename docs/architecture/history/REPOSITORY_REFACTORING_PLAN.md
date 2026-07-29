# IFC Atlas Repository-Wide Refactoring Plan

**Status:** Approved direction; Phases 0 and 1 complete locally, Phases 2A and 2B implemented locally

**Review date:** 2026-07-26

**Repository baseline:** `main` at `d1268dedfa228c0be527345a028f86600001f540`
**Recommended strategy:** Cohesive medium-to-large subsystem blocks using a measured strangler migration

## Approved decisions and working settings

The repository owner approved the following direction on 2026-07-26. Treat these as the default settings for future coding agents and new sessions unless new benchmark, security, or compatibility evidence requires an ADR and an explicit change of direction.

| Decision | Approved setting |
|---|---|
| Refactoring scope | Complete repository-wide refactor while preserving existing features |
| Change size | Work in cohesive medium-to-large subsystem blocks. Avoid both tiny fragmented cleanups and a single high-risk rewrite. Each block must remain reviewable, testable, and releasable. |
| Migration style | Incremental replacement behind explicit boundaries, with old/new compatibility only for a time-bounded rollback window |
| Deployment targets | Support both trusted local desktop and authenticated shared-server modes as explicit security profiles |
| Current IFC parser/converter | Keep web-ifc as the active render converter for now; place it behind the converter contract and improve its current pipeline |
| Custom IFC parser | Do not build a production custom parser now. Keep it as a future development track and create only benchmark/conformance starting points during the current refactor. |
| IFC semantic/edit engine | Keep IfcOpenShell |
| Geometry | Reuse existing geometry, triangulation, simplification, BVH and CSG/BRep implementations rather than creating new geometry algorithms |
| Renderer | Keep Three.js/WebGL and Fragments for production behind an Atlas renderer adapter |
| WebGPU | Development experiment only until the compatibility and performance promotion gates pass |
| Languages | TypeScript/React for UI, Python/FastAPI for semantic/AI/application services, Rust only for benchmark-proven performance-critical converter/indexing work |
| Model and cache architecture | Adopt immutable content-addressed model revisions and an Atlas-owned artifact manifest |
| API contract source | Backend Pydantic/OpenAPI is authoritative. Commit deterministic OpenAPI JSON and generated TypeScript; never hand-edit generated files. |
| Contract versioning | Additive changes may stay within v1. Removed or renamed fields, changed hash material, or changed enum meaning require a new contract version and compatibility window. |
| Frontend build/test baseline | Keep Vite on the compatible 6.x line and Vitest on the patched 3.x line during the contract block; defer Vite 8/Vitest 4 to the dependency/build block. |
| Extensions | Capability-based, versioned and isolated; trusted-local only until a real OS/process sandbox is available |
| Remaining recommendations | Use the recommended option in this plan unless an implementation finding is recorded in the decision log |

The phrase “keep web-ifc” does not mean coupling new application code to it. New conversion behavior must depend on an Atlas `IfcConverter` contract so web-ifc can later be compared with an IfcOpenShell-native or Rust/IFC Lite candidate without another application rewrite.

### Refactoring execution protocol

Every implementation block should:

1. Read this section, the relevant phase acceptance criteria, repository `AGENTS.md`, and recent ADRs.
2. Inspect the worktree and preserve unrelated user changes.
3. State the subsystem boundary and acceptance checks before editing.
4. Add characterization tests before moving behavior that is not already protected.
5. Complete one cohesive block, including cleanup, tests, documentation and metrics. Do not leave two permanent implementations without an owner and removal gate.
6. Run the narrow tests first, then the broad checks proportional to the changed risk.
7. Update the implementation ledger below with evidence, remaining gaps and the next recommended block.
8. Do not begin a production custom IFC parser, geometry kernel, Rust converter, or WebGPU migration without the benchmark/ADR gates in this plan.

### Implementation ledger

| Phase/block | Status | Evidence and remaining work |
|---|---|---|
| Plan and repository baseline | Complete | Repository audit and this plan created at the baseline commit above |
| Phase 0: baseline and deployment safety | Implemented locally; review gate | Explicit local/server security profiles, per-launch Tauri token, web token gate, server-side code-execution default-off, finite sidecar deadline, non-root/read-only containers, hashed Python locks, dependency upgrades, expanded CI, and baseline measurements are implemented. Remote CI and Docker validation remain. |
| Phase 1: characterization and contracts | Implemented locally; complete | Stable identity/element keys, artifact manifest v1, generated OpenAPI TypeScript, error/job contracts, ADRs, compatibility adapters, deterministic golden output, and renderer characterization are implemented and locally verified. |
| Phase 2A: lifecycle and IFC orchestration boundaries | Implemented locally; review gate | `ViewerSession` owns final engine lifetime and IFC routes delegate conversion/ingestion workflows to application services. Full local tests, build, contract/docs drift, and renderer parity pass; bundle size is unchanged. A reference-runtime cold-conversion recheck remains because Python 3.13 clean runs exceeded the Python 3.12 single-sample baseline. |
| Phase 2B: viewer capability extraction | Implemented locally; review gate | `ViewerSession.start()` now owns renderer/Fragments boot, worker/DPR/context resources and model acknowledgement; typed selection/visibility commands replace independent bridge/viewpoint/canvas store writes. ViewerPanel is about 458 lines smaller, the engine bundle is unchanged, and hardware renderer parity passes. |
| Phase 2C: viewer efficiency and correctness | In progress | Re-sequenced ahead of the backend blocks on 2026-07-29. Transfer weight, viewer defects, deletion, CSS co-location, `ViewerPanel` dissolution, store/transport hygiene. See [`PHASE_2C_VIEWER_PLAN.md`](PHASE_2C_VIEWER_PLAN.md). |
| Phase 2E: backend edit/use-case extraction | Planned, was 2C | Move edit/checkpoint/operation orchestration from `ifc_routes.py`, then isolate the transitional single-model state behind a scoped model context. |
| Phase 2F: typed tool dispatch | Planned, was 2D | Replace raw dispatch branches with typed handlers and one authorization/policy boundary. |
| Later phases | Not started | Follow Sections 19, 25 and 26 |

### Re-sequencing note (2026-07-29)

Phases 2A and 2B each recorded the `viewer-engine` artifact as exactly
unchanged. That was the right gate for a boundary move, but two consecutive
blocks produced no user-visible improvement, and this plan contained no
bundle-reduction workstream at all. A measurement pass on 2026-07-29 found the
production deployment serving every asset uncompressed, a Fragments geometry
worker version-skewed against the pinned library, and four viewer defects a user
can observe. Viewer work is therefore promoted ahead of the backend blocks and
its gates require reduction rather than forbidding regression.

One claim in this plan was checked and does not hold. The frontend store's
"re-render storm" framing is wrong: pointer-move writes nothing to the store,
`perfMetrics` writes are gated on HUD visibility, and there are zero unstable
derived selectors, so the recommended slice split buys maintainability rather
than performance. The dead-component list in Section 15 is correct as written:
all three have zero import sites of any kind.

### Phase 0 implementation checkpoint (2026-07-26)

The first refactor block deliberately combined deployment safety,
reproducibility and measurement because they form one release gate:

- local development now defaults to `127.0.0.1`; a tokenless local process
  cannot bind publicly;
- shared-server mode fails startup unless a strong shared bearer token is
  configured, and the middleware protects HTTP and WebSocket API traffic;
- the Tauri host creates a random 256-bit token per launch without persisting
  or logging it;
- browser/server builds show an access gate and retain the shared token only
  for the current tab;
- arbitrary Python/plugin execution is disabled by default in server mode, and
  allowed child-process environment variables no longer include provider,
  cloud or application secrets;
- sidecar conversion has a finite configurable deadline;
- Docker definitions run non-root with read-only roots, dropped capabilities,
  no-new-privileges, process/memory limits and health checks;
- Python runtime and development graphs are universal, hash-locked and
  installed from the locks in Docker/CI;
- the invalid frontend self-referencing `file:..` package was removed, backend
  framework/LLM packages were upgraded as a compatibility cohort, and the
  Python runtime audit reports no known vulnerabilities;
- CI now covers backend Ruff/audit/tests, frontend audit/typecheck/tests/build,
  sidecar typecheck/tests/build, Rust format/tests and strict documentation.

Local verification passed with 1,684 backend fast tests, 2,744 frontend tests,
34 sidecar tests and 6 Rust tests. The production frontend audit and Python
runtime audit are clean. Detailed bundle, converter and process-memory results
are in [`PHASE_0_BASELINE.md`](PHASE_0_BASELINE.md).

Known Phase 0 gaps are intentionally visible rather than hidden:

1. Docker is not installed on the review machine, so Compose interpolation,
   image builds, health checks and read-only runtime behavior require remote CI
   or a Docker-capable reviewer.
2. `npm ls --all` succeeds for the sidecar after `npm ci`, but npm's retiring
   quick-audit endpoint returns HTTP 400 "Invalid package tree" for that lock.
   Keep the sidecar build gate and add a working advisory scanner before
   declaring the complete npm graph auditable.
3. The server credential is deployment-wide. Per-user identity, roles, project
   authorization and tenant isolation remain a later shared-server block.
4. Memory numbers are sampled process counters. Time-series CPU/RSS/Wasm/GPU
   capture and medium/large corpus runs remain part of the benchmark block.
5. No production custom IFC parser, geometry kernel or WebGPU path was started.
   The existing web-ifc/Fragments output is the reference result for the future
   converter bake-off.

### Phase 1 implementation checkpoint (2026-07-26)

The second block established replaceable boundaries without replacing the
working IFC or rendering engines:

- `ProjectId`, `ModelId`, immutable `RevisionId`, and compound `ElementKeyV1`
  are defined in an engine-neutral backend contract module;
- upload/meta responses now carry `ModelIdentityV1`; dedicated identity and
  element-key endpoints allow new consumers to avoid bare express IDs;
- public artifact manifest v1 adapts the existing checksummed internal cache
  manifest only after validating the artifact and preprocessing metadata;
- all current route-level conversion calls pass through the Atlas
  `IfcConverter` protocol and `WebIfcSidecarConverter` adapter;
- the viewer cache fast path now consumes the versioned Atlas manifest while
  web-ifc, Fragments, Three.js/WebGL, and the existing geometry bytes remain
  active;
- conversion prebuild state is adapted to versioned job states and stable
  error codes, including cancelled, resource-limit, and unsupported-IFC cases;
- HTTP errors retain the legacy `detail` field and add a versioned structured
  envelope, avoiding a flag-day frontend migration;
- OpenAPI JSON and TypeScript are generated deterministically and checked for
  drift in CI;
- ADRs record security profiles, identity, and render-artifact decisions;
- Vite was patched to 6.4.3 and Vitest to 3.2.7, removing the test runner's
  critical/high advisories without taking the Vite 8 migration in this block.

Local verification passed with 1,700 backend fast tests, 2,746 frontend tests
and 34 sidecar tests. Backend Ruff, frontend typecheck/build, sidecar
typecheck/build, generated-file checks, production frontend audit, and strict
documentation build pass. The main viewer-engine artifact remains exactly at
the Phase 0 baseline of 6,725,668 bytes.

Known Phase 1 gaps and explicit review gates:

1. The main renderer Playwright parity scenario passes with the measured local
   SwiftShader load budget of 420 seconds (4.8 minutes in the passing run).
   WebGL context-loss recovery remains an existing explicit `fixme` because
   That Open Fragments does not re-upload GPU geometry after context restore;
   it is not treated as a Phase 1 regression or a passing feature.
2. Docker execution remains skipped as approved because Docker is unavailable.
3. Full frontend production dependencies have no known vulnerabilities. The
   development-only `openapi-typescript` 7.13.0 dependency pins Redocly 1.x,
   whose YAML/glob transitive packages have four high denial-of-service
   advisories. Generation consumes only the repository's trusted committed
   JSON, and production bundles do not contain these packages. Recheck or
   replace this generator when upstream supports patched dependencies.
4. Conversion jobs expose `cancellable=false`; reliable sidecar interruption
   and persisted job coordination remain Phase 4 work.
5. The transitional `ModelId` is stable through edits in one imported
   lineage, but durable identity across re-imports requires the Phase 4 model
   catalog.

### Phase 2A implementation checkpoint (2026-07-26)

This block establishes ownership boundaries before moving individual viewer
capabilities and backend edit use cases:

- `ViewerSession` is the sole owner of one viewer engine instance. It exposes a
  session cancellation signal, reverse-order capability cleanup, bounded async
  shutdown barriers, idempotent disposal, and post-engine worker-URL release.
- `ViewerPanel` constructs the existing OBC engine through that session. Native
  preview requests use the session signal, and fragment workers stay alive
  until renderer/culler/async-reader barriers settle.
- `IfcConversionService` owns content hashing, validated cache lookup,
  prebuild coordination, converter invocation, minimum-artifact validation,
  atomic publication, job-state updates, and progress cleanup.
- `IfcIngestionService` owns readiness transition ordering, IfcOpenShell load,
  checkpoint rebinding, background render prebuild, metadata index construction,
  model-sync events, and AABB warm-up.
- Upload and conversion endpoints now contain transport validation and HTTP
  response/error mapping. The duplicated upload prebuild implementation was
  removed and now reuses `IfcConversionService`.
- The application still uses web-ifc, Fragments, Three.js/WebGL, IfcOpenShell,
  the existing cache format, and the Phase 1 API contracts.
- The current single loaded model remains behind `IfcService` as a transitional
  adapter. Background AABB work captures the loaded model instance so a later
  upload cannot redirect it through mutable global state.

This is intentionally Phase 2A, not a claim that all modularization is done.
`ViewerPanel` still configures most engine capabilities, edit/orchestration
routes remain large, and raw chat/tool dispatch has not moved yet. See
[`PHASE_2_MODULARIZATION.md`](PHASE_2_MODULARIZATION.md) and
[ADR 0004](../adr/0004-session-and-use-case-ownership.md).

Local verification passed with 1,702 backend fast tests (one unrelated
optional-module skip), 2,750 frontend tests (one existing skip), frontend
typecheck/build, Ruff, production npm audit, deterministic OpenAPI/docs checks,
strict MkDocs, and the full BasicHouse renderer parity scenario. The
`viewer-engine` artifact remains exactly 6,725,668 bytes / 1,285.74 KiB gzip.
The renderer scenario passed in 1.4 minutes on its second run; the first run
selected an element that could not be relocated by the exact picker after
orbiting in ghost mode, with otherwise healthy renderer diagnostics.

Conversion checks used two new empty application homes. Cold end-to-end runs
were 4,682.6 ms (web-ifc 3,738 ms) and 4,666.0 ms (web-ifc 3,680 ms), versus
the Phase 0 single sample of 4,136.0 ms (web-ifc 3,437 ms). Warm-cache runs
were 180.9 and 133.4 ms versus 152.1 and 137.1 ms. The current interpreter is
Python 3.13 while the recorded reference was Python 3.12, and the unchanged
converter accounts for most cold variance. Bundle and warm-cache gates pass;
repeat cold conversion on the reference runtime before closing the Phase 2
five-percent performance gate.

### Phase 2B implementation checkpoint (2026-07-26)

This block moved renderer and fragment startup without replacing the current
engines or geometry:

- `ViewerSession.start()` provides one shared startup promise and tracks
  startup state, cleanups, barriers, and worker object URLs;
- `viewerRuntime.ts` owns the OBC world, postproduction renderer, camera, grid,
  render invalidation, context recovery, lighting, resize observer, and
  interaction DPR controller;
- `fragmentRuntime.ts` owns FragmentsManager initialization, blob worker URL,
  paced single-flight updates, FINISH acknowledgement, and active-model
  acknowledgement residency;
- canvas selection, saved viewpoints, and the external viewer bridge use
  narrow `SelectionCapability` and `VisibilityCapability` commands;
- `RenderStateCoordinator` remains the only code that composites these commands
  into engine visibility/appearance mutations;
- `ViewerPanel` is about 6,888 lines, down from about 7,346 after Phase 2A.

Lifecycle tests run 20 complete start/dispose cycles and require zero remaining
cleanups, barriers, and object URLs. The focused lifecycle/capability suite,
frontend typecheck, full unit suite, and production build pass. The
viewer-engine bundle remains 6,725,668 bytes / 1,285.74 KiB gzip, and the
ViewerPanel chunk is about 315.24 kB / 97.96 KiB gzip.

The hardware-backed BasicHouse renderer scenario passed in 18.5 seconds. Two
SwiftShader attempts painted the same healthy geometry but missed the separate
metadata worker's 20-second post-paint readiness deadline. This remains a
visible software-renderer/metadata timing issue rather than a widened test
budget. See [`PHASE_2_MODULARIZATION.md`](PHASE_2_MODULARIZATION.md) and
[ADR 0005](../adr/0005-viewer-runtime-and-command-capabilities.md).

## Review scope and method

This plan is based on a repository-wide inventory of 821 tracked files, full-text and dependency searches, manual tracing of the main runtime paths, and targeted static and dynamic checks. The review covered the React application, Python API, Node conversion sidecar, Tauri shell, tests, deployment files, documentation, and build configuration. Generated output and vendored build artifacts were measured but were not treated as authored source.

The following checks describe the initial audit at the baseline commit. The
newer Phase 0 results are recorded in the implementation checkpoint above:

- Frontend TypeScript check: passed.
- Frontend Vitest suite: 2,743 passed and 1 skipped across 165 test files.
- Frontend production build: passed, with oversized-chunk warnings.
- Sidecar type check, unit tests, and build: passed; 34 tests passed.
- Fast backend suite: 1,676 passed and 120 deselected. The process emitted an IfcOpenShell destructor warning.
- Rust `cargo check`: passed. `cargo test` did not complete within two 60-second attempts while compiling/linking, so it is not recorded as passing or failing.
- Strict MkDocs build: passed. The combined generated-document check failed because `docs/api/REST.md` was already out of date at the baseline commit.
- Python complexity scan: 1,256 code blocks, average cyclomatic complexity 4.41, with several severe hotspots.
- Duplicate-code scan: 33 clone groups, 0.56% duplicated lines. Concentration and coupling are larger problems than literal duplication.
- Production frontend dependency audit: no known vulnerabilities. Full frontend and sidecar audits could not produce a trustworthy result because the package tree/lock state is invalid.
- Python dependency audit: 27 advisories affecting 9 installed packages at the review date.
- Bandit medium/high scan: five medium findings and no high findings; architectural security issues described below are more serious than this count suggests.

This is a point-in-time review. Package versions and advisories must be rechecked when each upgrade phase begins.

---

## 1. Executive summary

IFC Atlas already has valuable domain behavior, a broad test suite, a working desktop shell, and a capable viewer. A complete rewrite would put those assets at risk and would not address the most urgent problems quickly enough. The recommended course is to preserve the running product while extracting stable boundaries around model identity, upload/storage, conversion, rendering, state, and extensions.

The most important findings are:

1. **The public API and plugin execution model are the first release blockers.** Most API routes have no authentication or authorization, share process-wide mutable services, and include operations that can upload, replace, edit, invoke paid LLMs, manage plugins, and change secrets. Plugin/code execution inherits the server environment and is not a secure isolation boundary.
2. **IFC data is copied and converted too many times.** A normal browser load can materialize the entire file in the browser, hash it, retain it, upload it, reread it in Python, send it as another full body to the sidecar, and copy it into WebAssembly. The `/convert` route itself uses a fully materialized request body. This raises peak memory, time-to-first-model, and failure risk on large files.
3. **The architecture is concentrated in a few files and global services.** `ViewerPanel.tsx`, `ifc_routes.py`, `ifc_service.py`, `tools.py`, `api.ts`, `useStore.ts`, and `index.css` combine many responsibilities. Tests reduce regression risk, but these boundaries make safe changes slow.
4. **The render and conversion dependencies are useful, but they leak throughout the application.** That Open Components, Fragments, Three.js, and web-ifc should be placed behind application-owned interfaces before any engine experiment. Replacing them first would be a rewrite.
5. **The deployed conversion story is inconsistent.** The application contains browser, Node sidecar, Python/IfcOpenShell, cache, and prebuild paths. The production backend container does not include the Node sidecar runtime, so server conversion is not uniformly available.
6. **The frontend is not small.** The production `dist` directory is about 22.2 MiB. Major minified outputs include the viewer engine at about 6.4 MiB, conversion worker at 4.1 MiB, metadata worker at 3.4 MiB, and fragments worker at 3.1 MiB. Several workers embed overlapping IFC/runtime code.
7. **A custom IFC parser or geometry kernel is not justified now.** web-ifc and IfcOpenShell contain years of schema, placement, representation, boolean, BRep, curve, surface, and edge-case work. Owning a purpose-built artifact format, tiling policy, cache, model registry, and residency scheduler offers much better return.
8. **Rust is a strong candidate for a future shared converter hot path, not for the whole application.** TypeScript should remain the UI language, Python should remain the semantic/AI/service language, and a Rust native/Wasm core should be adopted only if a controlled bake-off proves a material benefit.
9. **WebGL/Three.js should remain the default renderer in the near term.** WebGPU is promising but is still an experimental compatibility and shader-migration commitment. It should enter through an adapter and a measured feature flag.

The target is a modular monorepo with a typed contract layer, content-addressed model revisions, one authoritative ingestion path, versioned render artifacts, a Three.js renderer adapter, isolated feature/domain services, and optional native/Wasm acceleration. The likely duration for the recommended refactor is 6–10 months for a team of three to four engineers. A fully owned parser and render kernel would be a separate multi-year program and is not recommended.

## 2. Current architecture overview

### 2.1 Runtime topology

```text
Browser / Tauri webview
  React + Zustand + Three.js
  That Open Components / Fragments
  web-ifc workers
           |
           | REST + WebSocket/MCP
           v
Python FastAPI process
  global IFC/model service
  IfcOpenShell semantic/edit services
  chat, tools, MCP, plugins, checkpoints
           |
           | optional HTTP conversion
           v
Node TypeScript sidecar
  web-ifc + Fragments + custom metadata/geometry work

Tauri Rust host
  launches packaged backend, handles desktop integration and updates
```

The product currently has four overlapping notions of authority:

- The browser is authoritative during initial rendering and retains source bytes until persistence succeeds.
- The Python service is authoritative for semantic queries, edits, metadata, checkpoints, and many tools.
- The Node sidecar can be authoritative for fragment conversion and custom geometry processing when it is deployed.
- Browser workers provide a fallback conversion and metadata path.

This redundancy improves resilience in development but obscures which result is canonical, duplicates code and memory, and complicates cache invalidation.

### 2.2 Main model-load flow

The default flow is client-authoritative:

1. The user drops or selects an IFC file.
2. The frontend calls `file.arrayBuffer()`, stores the bytes, and computes a SHA-256 key.
3. The viewer attempts to use fragment/prebuilt caches.
4. On a cache miss, it sends the full IFC bytes to `/convert`, or falls back to a browser web-ifc worker.
5. In parallel or shortly afterward, the frontend uploads the source file to `/upload`.
6. Python streams the upload to a filename-derived path, then background tasks reread the complete file for IfcOpenShell loading, metadata, and fragment prebuilding.
7. Edits update semantic state and either patch viewer metadata or cause a model remount/reload.

The important performance issue is not only parsing speed. It is the combined peak of browser buffers, request bodies, Python bytes, Node buffers, Wasm memory, geometry arrays, fragment output, metadata, and renderer GPU allocations.

### 2.3 Rendering flow

The viewer builds a Three.js-based scene through That Open components and Fragments. Selection, highlighting, clipping, measurement, visibility, coloring, tiles, metadata, and navigation cross `ViewerPanel`, singleton services, and the global Zustand store. The renderer supports useful optimization mechanisms—instancing/fragment grouping, BVH-based queries, worker conversion, cache artifacts, frustum culling, and experimental LOD/tiles—but ownership and lifecycle are spread across the application.

### 2.4 Backend flow

FastAPI routes call long-lived module-level services. The central IFC service loads models through IfcOpenShell and also coordinates edit, metadata, geometry, validation, spatial, checkpoint, and conversion behavior. Chat/tool execution can reach many of the same services. The design is effective for a single local desktop user but is not a safe multi-user server architecture.

### 2.5 Desktop flow

The Tauri layer is intentionally thin. It starts and monitors the packaged backend, supports file association and desktop events, and participates in application updates. This is a good boundary. It should remain thin rather than absorbing application or IFC logic.

## 3. Repository structure analysis

### 3.1 Inventory

| Area | Tracked files | Approximate role |
|---|---:|---|
| `frontend/` | 425 | React UI, viewer, browser workers, Node sidecar, tests |
| `backend/` | 249 | FastAPI, IFC/AI/plugin services, tests |
| `src-tauri/` | 66 | Desktop host, permissions, packaging |
| `docs/` | 54 | Architecture, operations, user/developer documentation |
| `scripts/` | 10 | Build and verification utilities |
| root and CI | 17 | Compose, Caddy, package orchestration, workflows |

The authored code is approximately 65,000 lines of TypeScript, 53,000 lines of Python, 30,000 lines of TSX, 14,000 lines of CSS, and 447 lines of Rust.

### 3.2 Concentration hotspots

| File or area | Evidence | Main concern | Proposed boundary |
|---|---:|---|---|
| `frontend/src/components/ViewerPanel.tsx` | about 7,000 lines; 41 effects | Scene lifecycle, tools, UI, events, engine state, and model state in one component | `viewer-core`, tool controllers, renderer adapter, focused React shells |
| `frontend/src/index.css` | about 11,700 lines / 326 KB | Global cascade, duplicated patterns, hard responsive work | tokens + reset + feature-scoped styles |
| `backend/app/api/ifc_routes.py` | about 3,000 lines; 63 routes | Transport, validation, file I/O, conversion, edit orchestration mixed | thin routers + application use cases |
| `backend/app/services/ifc_service.py` | about 2,500 lines | Central service knows most domains | per-project context and feature services |
| `backend/app/services/tools.py` | about 2,500 lines | tool registry, validation, dispatch, permissions, execution mixed | command catalog + policy + handlers + executor |
| `_execute_tool_raw` | complexity 161 | untestable dispatch/control path | typed handler registry and middleware pipeline |
| `frontend/src/store/useStore.ts` | about 2,000 lines; 500+ state/type members | unrelated updates and broad subscriptions | domain slices with selectors |
| `frontend/src/services/api.ts` | about 1,500 lines; roughly 99 exports | manual transport surface and weak grouping | generated client + feature gateways |
| `ChatPanel.tsx`, `SettingsModal.tsx` | 1,250–2,000 lines | domain, presentation, transport, and persistence mixed | feature modules and lazy panels |

Literal clone density is low, but repeated concepts exist in sidecar/browser profile parsing, frustum cullers, cost/carbon handling, LLM providers, sandbox/edit operations, and style definitions. Consolidate only after tests identify the intended common behavior; forced generic abstractions would be worse than small duplication.

### 3.3 Dead and stale candidates

Static import/export analysis found three UI components with definitions but no import sites:

- `ClipPlaneControls.tsx`
- `ColourByControl.tsx`
- `SelectionHistoryNav.tsx`

It also found 24 unused exported values and 123 exported types. Worker and service-worker entry points create expected false positives, so deletion must be preceded by runtime and test confirmation. Documentation still names some unreferenced components and describes flows that no longer match the default implementation.

### 3.4 Separation and naming

The repository generally uses meaningful domain terms, but the following patterns weaken boundaries:

- “Service,” “manager,” and “controller” names often represent singleton objects with broad responsibilities.
- IFC express IDs are sometimes treated as globally sufficient identities, even though they are only model-scoped.
- “Fragment,” “tile,” “model,” and “cache” refer to multiple artifact shapes without a common manifest.
- Transport DTOs, UI state, engine objects, and domain state are frequently represented by the same informal TypeScript objects.
- Python routes expose orchestration decisions that should be application use cases.

Adopt explicit identifiers such as `ProjectId`, `ModelId`, `RevisionId`, `ElementKey`, `ArtifactId`, and `ConverterBuildId`. Prefer feature-specific names over another generic `Manager`.

### 3.5 Documentation state

The documentation is substantial and worth keeping. Several statements have drifted:

- The architecture overview describes a server-convert/upload-first path, while the active hook is client-authoritative.
- Tauri “known gaps” mention a missing CSP, but a CSP is now configured.
- Frontend documentation lists UI components that appear unused.

Documentation should be checked in CI for links and generated contract snippets, but human architectural explanations should remain manually curated.

## 4. Dependency audit

### 4.1 Frontend runtime dependencies

| Dependency | Why and where it is used | Advantages | Disadvantages | Decision and lighter alternative |
|---|---|---|---|---|
| React / React DOM 18 | Application shell and all UI components | Mature ecosystem, existing tests, suitable concurrent UI model | Component concentration currently hides lifecycle complexity; a major upgrade changes behavior | **Keep.** Split components first, then trial React 19 as a separate compatibility cohort. Replacing the framework has no demonstrated return. |
| Zustand 5 | Shared viewer, project, UI, chat, and settings state | Small API and runtime, works outside React | One monolithic store encourages unrelated state and broad subscriptions | **Keep, restructure.** Use domain slices, selectors, immutable identifiers, and engine state outside serializable UI state. A hand-built event store would save little and add risk. |
| Three.js | Scene graph, materials, cameras, geometry, WebGL rendering | Broad browser/GPU support and mature ecosystem | Large surface; frequent releases; internal objects leak into features | **Keep behind `RendererAdapter`.** A custom renderer is not justified. Babylon.js would be lateral migration, not a lighter replacement. |
| `camera-controls` | Smooth orbit/pan/navigation behavior | Well-tested interaction behavior | Another lifecycle-sensitive Three dependency | **Keep.** Implementing camera dynamics in-house has little product value. |
| `@thatopen/components` | Viewer world, clipping, IFC-oriented tools and coordination | Useful BIM primitives and integration | Leaks broad framework concepts into `ViewerPanel`; version compatibility matters | **Keep temporarily behind a façade.** Replace individual component features only when the façade and parity tests show a bundle or maintenance win. |
| `@thatopen/components-front` | Frontend-oriented clipping/edge and patch integration | Saves specialized rendering work | Used in few concentrated places and can pull a broad graph | **Evaluate after façade extraction.** It is a candidate for selective replacement, not immediate removal. |
| `@thatopen/fragments` | Fragment model loading, storage, rendering, selection and IFC conversion artifacts | Compact FlatBuffers artifacts, geometry/metadata relationships, worker and tile concepts | Engine-specific artifact versioning and worker payloads; large bundles | **Keep short-term, exact-pin, wrap.** Define an Atlas artifact manifest around it. Replace only if a benchmarked converter/renderer path wins. |
| `web-ifc` | Browser and sidecar IFC parsing/tessellation | Fast Wasm/C++ implementation, broad coverage, open source | Large worker/Wasm payloads; Wasm memory copies; geometry edge cases; version coupling | **Keep as fallback/reference.** Move behind `IfcConverter`; do not build a parser from scratch. Benchmark a Rust/IFC Lite candidate. |
| `three-mesh-bvh` | Fast raycasting/spatial geometry queries | Mature, highly optimized | More geometry memory and build time | **Keep, measure build policy.** Building a general BVH implementation in-house is poor value. |
| `react-markdown` / `remark-gfm` | Rendering assistant output in `ChatPanel` | Safe structured Markdown and GFM support | Used by one feature and contributes to initial graph if eagerly imported | **Keep and lazy-load with chat.** A home-grown Markdown renderer is a security and maintenance regression. |
| local `ifc-atlas-desktop: file:..` | Appears as a package dependency | None demonstrated | Invalid/bogus tree entry breaks reliable audits | **Remove after confirming no packaging consumer.** Use root workspaces/scripts for orchestration. |

### 4.2 Frontend build and test dependencies

| Dependency | Use | Decision |
|---|---|---|
| Vite 6 and React plugin | Dev server and production bundling | Keep; upgrade one major at a time after bundle baselines. Use explicit worker/vendor chunk policy only where it reduces duplicate bytes. |
| TypeScript 5.6 | Type safety | Keep; enable stricter options incrementally and generate API DTOs. Do not combine TypeScript 7 migration with architecture changes. |
| Vitest / fake IndexedDB | Fast unit and cache tests | Keep; add coverage thresholds by risk area rather than chasing a global percentage. |
| Playwright / PNGJS | Browser and screenshot regression harness | Keep; promote the BasicHouse renderer harness to a required, artifact-producing CI job. |
| ESLint configuration without installed runtime packages | Intended linting | Repair or replace deliberately. Minimum churn is to install/pin the configured ESLint stack. Biome is a possible single-tool alternative, but only adopt it after checking rule parity and autofix churn. |

As of the review date, current upstream releases are several majors ahead in some tools (for example React 19, Vite 8, and Vitest 4). “Update everything” must not mean installing every latest release in one change. Use compatibility cohorts: React/UI, Three/That Open/web-ifc, Vite/TypeScript/test tools, then application code.

### 4.3 Node sidecar dependencies

| Dependency | Why and where | Pros / cons | Decision |
|---|---|---|---|
| web-ifc, Fragments, Three | Source parsing, geometry, fragment output | Reuses browser ecosystem but duplicates large runtime payloads and version constraints | Keep during transition; exact-pin with frontend where artifact compatibility requires it. Retire the sidecar only after a candidate converter passes parity and deployment tests. |
| `earcut` | Polygon triangulation in custom geometry paths | Small and specialized; robust | Keep while those paths exist. Do not reproduce triangulation casually. |
| `meshoptimizer` | Geometry simplification/optimization | High-value native-quality algorithms | Adds a processing dependency and artifact-version variable | Keep and record version/settings in artifact manifests. |
| esbuild / tsx | Sidecar build and execution | Fast, simple tooling | Separate toolchain from Vite | Keep unless the sidecar is retired. |

### 4.4 Python runtime dependencies

| Dependency or group | Why and where it is used | Advantages | Disadvantages | Decision and alternative |
|---|---|---|---|---|
| FastAPI, Starlette, Uvicorn, Pydantic | HTTP/WebSocket API, validation, OpenAPI | Productive typed service stack | Current versions include advisories; direct Starlette pin can conflict with FastAPI compatibility | **Keep and upgrade as one tested cohort.** Do not replace the web framework during the domain split. |
| `python-multipart` | IFC/form uploads | Standard FastAPI integration | Installed version has multiple advisories | **Upgrade immediately** to a fixed compatible version and stream/cap uploads. |
| IfcOpenShell | Authoritative IFC parsing, semantics, edits, validation and geometry-related operations | Broad IFC coverage, Python API, native geometry engine, multicore iterator/caching capabilities | Native memory/lifecycle complexity; package/platform constraints | **Keep as semantic authority.** Prefer its tested implementation to an in-house parser/kernel. Evaluate native conversion profiles separately. |
| httpx / websockets | Sidecar and remote service communication | Modern async clients | One sidecar client has no timeout; retry/backpressure behavior is inconsistent | **Keep**, introduce shared deadline/retry/circuit policy and bounded streaming. |
| OpenAI / Anthropic SDKs | Direct LLM providers | Official, current provider support | Provider logic is duplicated with LangChain integrations | **Keep direct provider adapters** unless graph features prove necessary. Lazy-load optional providers. |
| LangChain, LangGraph, provider integrations | Agent orchestration and provider abstractions | Ready-made graph/tool ecosystem | Large fast-moving dependency family, duplicate provider paths, several current advisories | **Converge and likely remove.** First characterize workflows; implement a small application-owned orchestration state machine using direct SDKs and MCP. Retain only a demonstrated graph feature that would be expensive to replace. |
| MCP Python SDK | Model Context Protocol server/client behavior | Standard interoperability | Current installed version has advisories | **Keep and upgrade.** Place capability/auth policy outside the SDK. |
| GitPython | Checkpoint/history implementation | Mature Git operations | Requires Git/process/filesystem semantics for application history | **Keep short-term.** Evaluate a content-addressed immutable revision store if only snapshot/list/diff/rollback are required. |
| `ifcdiff`, `ifctester` | IFC-specific diff and IDS/validation workflows | Valuable domain behavior that is costly to recreate | Native/domain version compatibility | **Keep and pin/test.** |
| `pypdf` | PDF document ingestion | Mature parser | Untrusted PDFs can consume resources | **Keep with file/page/time limits** and process isolation for public deployments. |
| `fastembed`, `hnswlib` | Optional semantic retrieval | Local retrieval and efficient ANN | Heavy native footprint and packaging complexity | **Move to an optional `semantic-search` extra/service.** Keep the smaller lexical/BM25 path in base installations. |
| `python-dotenv` | Local environment loading | Small developer convenience | Installed version has an advisory; production does not need it | Upgrade and restrict to development, or replace with explicit settings loading. |

### 4.5 Desktop, documentation, and infrastructure dependencies

| Area | Decision |
|---|---|
| Tauri 2 and currently enabled plugins | Keep. Every configured plugin has a visible desktop responsibility. Continue minimizing permissions and remove `withGlobalTauri`/broad arguments if not required. |
| Rust crates in the desktop shell | Keep updated through normal Cargo audit/update cycles. Do not add converter work to the shell crate; create a separate library/process. |
| MkDocs Material | Keep. Documentation value exceeds its isolated build dependency. Pin the documentation environment. |
| Caddy | Keep as the edge proxy, then add authentication integration, security headers, body limits, rate limits, and request IDs. |
| Docker/Compose | Keep, but build self-contained images, run non-root, use health checks/read-only filesystems where possible, and make the converter runtime explicit. |

### 4.6 Dependency policy

Adopt these rules:

- Each direct dependency needs an owner, use sites, license, update cadence, and removal condition.
- Runtime dependencies are exact-pinned or lockfile-pinned; artifact-producing engine versions are recorded inside the artifact manifest.
- Optional features use extras or separate services instead of inflating every installation.
- No dependency is replaced merely because it is large. First measure parsed, executed, transferred, and retained cost.
- Do not implement parsers, cryptography, Markdown sanitization, geometry kernels, compression, or provider protocols in-house without a written threat/model and benchmark justification.

### 4.7 Baseline version and upgrade sequence

Important manifest versions at the reviewed commit include React/React DOM `^18.3.1`, Three.js `^0.182`, That Open Components `^3.4.0`, Components Front `^3.4.2`, Fragments `3.4.3`, web-ifc `^0.0.77`, Zustand `^5`, Vite `^6.4`, TypeScript `~5.6`, Vitest `^2.1` and Playwright `^1.61`. The sidecar has its own That Open/Three/web-ifc graph plus `earcut`, `meshoptimizer`, esbuild and tsx. This duplication requires an explicit artifact compatibility matrix.

The main Python baseline includes FastAPI 0.115.6, Uvicorn 0.34, Pydantic 2.10.4, IfcOpenShell 0.8.3 or later, websockets 14.1, httpx 0.28.1, OpenAI 2.41, Anthropic 0.109.1, LangChain/LangGraph 1.0-era packages, and a ranged MCP dependency. Several requirements are ranges rather than a resolved lock, so the manifest alone does not reproduce the installed audit environment.

Apply upgrades in this order:

1. security patch cohorts that preserve API compatibility;
2. Python/FastAPI/Starlette/Pydantic/MCP as a tested service cohort;
3. repair npm workspace and lock state;
4. Three/That Open/Fragments/web-ifc as one renderer/converter compatibility cohort;
5. Vite/Vitest/TypeScript build cohort;
6. React major after component/lifecycle extraction;
7. optional provider/search packages after base/extra separation.

Each cohort receives a clean install, full relevant suite, artifact compatibility check, bundle/memory comparison and rollback note. Never let a caret update silently change an artifact-producing dependency in release builds.

## 5. Security review

### 5.1 Priority findings

| Severity | Finding | Impact | Required response |
|---|---|---|---|
| Critical for network deployment | Main API routes do not enforce authentication/authorization | Any reachable caller may upload/replace/edit models, invoke LLM cost, alter plugins/settings, or clear history/data | Add an authentication gateway, server-side authorization policy, project tenancy, and deny-by-default route classification before calling the service internet-ready |
| Critical | Process-global model/services are shared across callers | Cross-user data leakage, conflicting edits, accidental replacement | Introduce `ProjectContext`/`ModelSession` scoped by authenticated project and revision |
| Critical | Plugin/code runner inherits `os.environ` and relies on in-process/child Python restrictions | Secret exfiltration and sandbox escape; an audit-hook denylist is not a security boundary | Treat plugins as trusted-local only now, or move execution to a scrubbed, unprivileged OS/container sandbox with no network, explicit mounts, quotas, and hard timeouts |
| High | Full-body conversion and repeated full-file reads | Memory exhaustion and service denial on large/concurrent uploads | Stream to capped temporary storage, validate, content-address, then pass a file/stream handle to one conversion job |
| High | Upload path is derived from sanitized original filename | Different users/files can overwrite the same shared path; partial failure ambiguity | Use server-generated IDs/content hashes, atomic move, immutable revisions, and retain original name only as metadata |
| High | Vulnerable Python dependency cohort | Known request parsing, framework, MCP, and agent/library vulnerabilities | Upgrade and lock the cohort; add audit gates and regression tests |
| High | XML/archive/document processing lacks a uniform resource policy | Entity/ZIP bombs or CPU/memory exhaustion in BCF/IDS/PDF paths | Use hardened XML parsing, member/total/ratio limits, bounded streams, and isolated document workers |
| High | Secrets are stored in application JSON with POSIX-only permission assumptions | Weak protection on Windows/desktop and excessive exposure if API is reachable | Use OS keychain/Tauri Stronghold or a server secret manager; never return partial secret material |
| Medium | Sidecar `httpx.AsyncClient(timeout=None)` | Hung workers consume requests indefinitely | Apply connect/read/write/pool deadlines, cancellation, and circuit breaking |
| Medium | Containers run with broad/default privileges | Increases blast radius of parser/plugin compromise | Non-root UID, read-only root, dropped capabilities, PID/memory/CPU limits, explicit writable volumes |

### 5.2 Dependency findings

The Python audit reported 27 advisories across 9 installed packages. Affected direct or transitive groups include `python-multipart`, `python-dotenv`, Starlette, MCP, LangGraph, LangChain and its OpenAI/Anthropic integrations, and `langsmith`. Fixed versions available at review time include multipart 0.0.31 or later, dotenv 1.2.2 or later, LangGraph 1.0.10 or later, MCP 1.28.1 or later, and newer compatible LangChain/provider releases. Starlette must be upgraded with FastAPI rather than forced independently.

The production-only frontend audit was clean. Full npm audit was blocked by the invalid local package/lock tree, so the correct conclusion is “not yet auditable,” not “clean.” Repair the workspace, recreate lockfiles in a controlled change, and run production and development audits for root, frontend, and sidecar.

Bandit flagged network binding, three standard-library XML parse sites, and an unbounded HTTP client. `0.0.0.0` is acceptable inside a container only with a secured edge; it is not itself the main issue.

### 5.3 Security boundary decision

There should be two explicit product modes:

- **Local trusted desktop:** loopback-only API, per-launch random bearer token, trusted/signed local extensions, OS keychain, strict origin checking.
- **Shared server:** authenticated users, tenant/project authorization, immutable model revisions, rate/size quotas, isolated background workers, no arbitrary plugin code in the API process, centralized secret management, and complete audit events.

Trying to make one permissive process silently serve both modes is unsafe.

## 6. Performance review

### 6.1 Measured frontend output

The current production build produced about 22.2 MiB across 63 files. The largest minified assets were approximately:

| Asset | Size | Observation |
|---|---:|---|
| viewer engine chunk | 6.4 MiB | Three/That Open/IFC-heavy shared engine |
| IFC conversion worker | 4.1 MiB | Contains parsing/conversion runtime |
| metadata worker | 3.4 MiB | Overlapping schema/parser responsibilities |
| fragments worker | 3.1 MiB | Separate engine worker |
| public worker module | 1.27 MiB | Additional worker payload |
| web-ifc Wasm variants | 1.24–1.25 MiB each | Necessary only for paths that execute them |
| `ViewerPanel` chunk | about 0.30 MiB | Large application-owned component |
| global CSS | about 0.22 MiB | Large global cascade |

The viewer engine compresses well, but compressed transfer is only one cost. Parsing, compilation, worker startup, Wasm memory, geometry retention, and GPU uploads must be measured separately. The build also reports that `api.ts` is both statically and dynamically imported, preventing intended chunk isolation.

### 6.2 Main bottlenecks

| Bottleneck | Evidence and cause | Direction |
|---|---|---|
| Whole-file memory amplification | Browser `arrayBuffer`, retained store bytes, full request bodies, Python `read_bytes`, Node/Wasm copies | One ingest, immutable source, job by model revision, streaming/spooled APIs |
| Duplicate conversion paths | browser web-ifc, sidecar web-ifc, backend prebuild, custom metadata workers | One canonical server/desktop pipeline plus a clearly scoped offline fallback |
| Time-to-first-model waits for too much work | Source hash, parsing, metadata, geometry and cache checks are coupled | Progressive manifest/spatial tree first; visible geometry next; properties on demand |
| Global model/service state | Serializes or conflicts across projects and inhibits worker scheduling | Scoped model sessions and bounded job queues |
| Main component effect density | 41 effects and many event registrations in `ViewerPanel` | Explicit viewer lifecycle object with deterministic `mount/load/unload/dispose` |
| Store breadth | Broad shared store and large type surface | Selector-based feature stores; keep high-frequency camera/pointer/engine data outside React |
| Worker duplication | Multiple large independently bundled workers | Shared artifact responsibilities, lazy worker creation, or server/native conversion; verify bundler dedupe |
| Unbounded or repeated computation | metadata/property/spatial/filter work can be recomputed across layers | Revision-keyed memoization, persisted indexes, query instrumentation |
| Large global CSS and modal/panel code | All features are easy to include in the initial graph | Route/feature lazy loading, scoped CSS, remove dead components after parity |
| Deployment mismatch | Production backend lacks sidecar runtime | Ship a self-contained converter service or explicitly use browser-only mode; never silently diverge |

### 6.3 Performance budgets

Budgets must be set against a fixed fixture corpus and reference hardware. Initial proposed gates:

- No more than 1.5× source size in API-process peak RSS during upload; conversion memory belongs to a separately budgeted worker.
- No endpoint should call an unbounded full-body read for IFC input.
- Cached visible-model time improves at least 30% at p50 and does not regress p95.
- Uncached time to first useful 3D view improves at least 25% on medium/large fixtures.
- Viewer frame time stays below 16.7 ms p95 during the standard desktop orbit trace and below 33 ms on the mobile-class profile.
- Initial non-viewer application JavaScript and CSS remain under an agreed compressed budget; chat/settings/admin features are lazy.
- GPU and browser retained memory return within 10% of the pre-load baseline after repeated load/unload cycles, excluding deliberate caches.
- Conversion artifacts are deterministic for identical source, converter build, schema, and settings.

Absolute values should be filled from Phase 0 measurements rather than invented in advance.

## 7. Frontend review

### 7.1 What is working

- TypeScript is broadly used, the unit suite is large and fast, and worker/cache behavior already has tests.
- Heavy viewer code is partly chunked and workerized.
- The product has rich IFC interactions: selection, properties, measurements, clipping, coloring, visibility, editing feedback, and chat/tool integration.
- Three.js, BVH, fragments, caches, and experimental LOD/tiles provide a credible optimization base.

### 7.2 Problems and changes

**Split the viewer by lifecycle and capability.** `ViewerPanel` should become a small React host that creates one `ViewerSession`. The session owns renderer setup/disposal and exposes typed capabilities such as selection, clipping, measurements, visibility, navigation, and model residency. React panels call application commands rather than manipulating engine objects.

**Split state by update frequency and ownership.**

- Durable application state: project, model revisions, settings, tool preferences.
- Server/query state: metadata, jobs, history, validation results; use a small query cache or a deliberately simple request cache rather than copying responses into one global store.
- UI state: open panel, selected tab, modal state.
- Viewer runtime state: scene objects, cameras, GPU resources, frame-local selections; keep outside Zustand and expose snapshots/events.

**Generate transport types.** FastAPI OpenAPI should generate the TypeScript client and DTOs. Hand-written feature gateways can add domain behavior, cancellation, and error mapping, but should not repeat endpoints.

**Create a visibility/appearance compositor.** Isolation, category visibility, spatial visibility, search results, selection, hover, issue status, color-by, clipping, and LOD should contribute to one resolved appearance state. Today, features can overwrite each other because engine mutations are scattered.

**Make responsiveness intentional.** Replace the giant global stylesheet incrementally with tokens, layout primitives, and feature-scoped CSS. Define compact/wide breakpoints, touch target sizes, panel docking rules, reduced-motion behavior, and a canvas resize contract. Preserve the current look first; visual redesign is a separate decision.

**Dispose deterministically.** Every capability returns an idempotent disposer. Use one event registry for DOM, worker, store, and engine subscriptions. Run repeated mount/load/unload tests with heap and GPU-resource counters. Most current listeners do have cleanup, so this is hardening, not an assertion that every listener leaks.

**Lazy-load by feature.** Viewer engines load only when a model view is opened; chat Markdown/provider UI loads with chat; settings/admin/plugin panels load on demand. Fix the mixed static/dynamic `api.ts` import before adding manual chunk rules.

### 7.3 Type safety

Introduce branded model identifiers and discriminated unions for job states, artifact versions, tool results, and viewer events. Do not expose `THREE.Object3D`, That Open objects, or raw express IDs across feature boundaries. Tighten TypeScript in stages:

1. no unchecked transport DTOs;
2. no implicit model identity;
3. checked indexed access in new packages;
4. strict engine adapter types;
5. remove legacy escape hatches after migration.

## 8. Backend review

### 8.1 What is working

- FastAPI/Pydantic provide a productive typed API surface.
- IfcOpenShell offers strong semantic/edit/validation coverage.
- The backend has extensive tests and many clearly named domain services.
- Chat, tools, MCP, checkpoints, BCF, IDS, COBie, quantities, costs, and carbon features provide real application value.

### 8.2 Problems and changes

**Replace process-global authority with scoped contexts.** A `ProjectContext` should resolve the authenticated project, model revision, permissions, storage paths, services, and job handles. Read-only IfcOpenShell models may be cached by immutable revision; edits create a new revision or an explicit transactional working copy.

**Make routes thin.** Routers validate transport, call one use case, and map domain errors. Upload, conversion, edit, validation, checkpoint, and tool orchestration move into application modules. A route should not choose storage names, read entire files, and coordinate several engines.

**Break up the central IFC service by capability.**

- model catalog and revision repository;
- IFC semantic reader;
- edit transaction service;
- property and spatial query service;
- conversion job coordinator;
- validation/export service;
- checkpoint/history service.

These are simple interfaces around existing code, not speculative layers.

**Replace raw tool dispatch with typed commands.** Each tool declares input schema, required capability, read/write classification, timeout, handler, and audit format. Middleware handles authentication, authorization, idempotency, cancellation, transaction scope, and result normalization. This directly addresses `_execute_tool_raw` complexity.

**Move CPU/native work off the async event loop.** IfcOpenShell parsing, geometry, PDF/XML work, and heavy indexing should run in a bounded worker pool or dedicated worker service. Requests create jobs, stream progress, and support cancellation. Thread safety and process isolation must be tested for each native library.

**Consolidate LLM orchestration.** Preserve the provider-neutral application interface, but remove duplicate provider and graph stacks. A small explicit state machine is easier to test, audit, and meter. Keep MCP as an interoperability boundary, not as a substitute for authorization.

**Use structured errors and telemetry.** Define stable error codes, causal chains, request/job/model revision IDs, and safe user messages. Replace catch-all logging with boundary-specific decisions: retryable, invalid input, unsupported IFC, converter defect, cancelled, resource limit, or internal error.

### 8.3 Python version and packaging

The environment used for review is Python 3.13 while project metadata expects a version below 3.13. Standardize production and CI on Python 3.12 initially because native IFC/geometry dependencies are better characterized there. Use `uv` or another resolver to commit a hash-locked environment for each platform/feature set. Keep a separate constraints/update file if human-readable direct requirements are desired.

Python should not be removed from the complete application. It is well suited to the API, AI, automation, validation, document workflows, and orchestration. It should not hold large byte buffers unnecessarily or perform frame-critical geometry work.

## 9. IFC-processing pipeline review

### 9.1 Current pipeline

The current product combines:

- browser source hashing and source-byte retention;
- browser web-ifc conversion fallback;
- Node sidecar conversion using web-ifc, Fragments, and custom metadata/geometry processing;
- Python IfcOpenShell loading for semantics, queries, edits, and validation;
- fragment/prebuild cache lookup;
- metadata workers and experimental spatial/LOD artifact paths.

This provides coverage but lacks one versioned contract connecting source revision, converter build, conversion settings, geometry chunks, property shards, spatial indexes, and cache validity.

### 9.2 web-ifc implementation review

[web-ifc](https://github.com/ThatOpen/engine_web-ifc) is an MPL-2.0 C++ engine compiled with Emscripten for browser and Node Wasm, with a standalone C++ path. Its implementation is substantially more than a text parser:

- A token stream indexes STEP content and maps express IDs/types to tape positions.
- Generated schema bindings support multiple IFC schemas.
- Model management and caches resolve units, placements, styles, materials, voids, nesting, aggregation, and related structures.
- Geometry processing recursively handles representation items including extrusions, sweeps, mapped items, BReps, booleans, curves, surfaces, NURBS, and placement transforms.
- Geometry and relationship caches reduce repeated work.
- Public APIs expose line access and mesh streaming callbacks.

“Streaming meshes” occurs after source input has been indexed; it is not equivalent to parsing directly from a network stream with constant memory. The repository version also produces multi-megabyte worker code plus Wasm and requires coordinated compatibility with Fragments.

**Conclusion:** Do not fork web-ifc as the first optimization and do not rewrite its parser/geometry engine. Keep it behind a converter interface. If profiling finds a narrow hot path, upstream a fix or compile a carefully maintained feature profile before owning a fork.

### 9.3 IfcOpenShell role

[IfcOpenShell](https://github.com/IfcOpenShell/IfcOpenShell) should remain the semantic and edit authority. It supports full schema/entity behavior, validation-related workflows, and a mature native geometry stack. Its geometry iterator can use multicore processing, cache/reuse work, and operate with hybrid geometry kernels. Benchmark those capabilities before assuming a new parser is required.

Use immutable source files and model revisions so IfcOpenShell instances can be safely cached or reconstructed. Avoid sharing one mutable model across unrelated requests.

### 9.4 Proposed ingestion and artifact flow

```text
bounded upload / desktop file handle
             |
             v
validate size + IFC header -> hash while streaming -> immutable source blob
             |
             v
ModelRevision(source hash, schema, units, coordinates)
             |
             +--> semantic/index job (IfcOpenShell)
             |
             +--> render conversion job (current Fragments, candidate Rust later)
                           |
                           v
              Atlas Render Package manifest
                - converter/version/settings
                - coordinate and unit metadata
                - spatial hierarchy and bounds
                - geometry/material chunks
                - property/relation shards
                - LOD errors and tile dependencies
                - checksums and byte ranges
                           |
                           v
             CDN/local blob store -> client residency scheduler
```

The source is stored once. Conversion jobs receive an immutable file path/blob handle and emit immutable artifacts. Browser upload and desktop open can share the same logical contract even if the desktop implementation uses local IPC.

### 9.5 Atlas Render Package

Define an application-owned manifest before defining a new binary format. Version 1 can wrap current Fragments artifacts:

- source SHA-256 and immutable revision ID;
- IFC schema, units, georeferencing and local-origin transform;
- converter name/build, dependency versions, feature profile, tolerances and decimation settings;
- compound model/element identity mapping;
- bounding hierarchy and tile/LOD table;
- geometry, materials, relations and property shard URIs/byte ranges;
- per-chunk checksums, uncompressed size and compression;
- feature flags and compatibility requirements.

FlatBuffers is a reasonable geometry/index representation because Fragments already uses it, but the manifest should permit another codec. The contract is more important than inventing a container.

## 10. Rendering pipeline review

### 10.1 Current strengths

Fragment-based rendering is appropriate for BIM. It can group compatible geometry, instance repeated shapes, decouple source IFC semantics from draw-time data, and load a compact binary artifact. Three.js provides the scene/camera/material foundation, while BVH and culling services accelerate interaction.

### 10.2 Current weaknesses

- Viewer features directly know engine objects and can compete when changing visibility/materials.
- Model identity and express ID handling are not designed first for federation.
- LOD/tile/cache mechanisms exist, but they are not yet one authoritative residency system.
- Conversion artifacts are not governed by an application-owned compatibility manifest.
- Whole-model or large-chunk lifecycle dominates some paths.
- Shader/render assumptions make a direct WebGPU switch risky.

### 10.3 Target renderer design

Keep Three.js/WebGL as the production implementation behind:

```ts
interface RendererAdapter {
  mount(target: HTMLElement): Promise<void>;
  attachModel(manifest: RenderManifest): Promise<ModelHandle>;
  setView(view: ViewState): void;
  setAppearance(delta: AppearanceDelta): void;
  pick(point: ScreenPoint): Promise<PickResult | null>;
  captureMetrics(): RendererMetrics;
  dispose(): Promise<void>;
}
```

This is illustrative, not a required final API. The important constraints are:

- feature code uses stable commands/events, not Three/Fragments types;
- the adapter reports actual memory, draw-call, triangle, tile, and frame metrics;
- all resources have explicit ownership and disposal;
- selection/visibility/color resolution happens before engine mutation;
- a model handle includes project/model/revision identity;
- renderer implementations may be selected by capability and feature flag.

### 10.4 Spatial, culling, LOD, and streaming

Develop the policy and orchestration in-house because it is workload-specific; reuse algorithms and engine primitives:

- Offline converter computes stable bounds, a spatial hierarchy, per-tile cost, dependencies, and LOD geometric error.
- Runtime performs frustum and projected-error selection, then applies an occlusion heuristic only if measurements justify it.
- A residency scheduler prioritizes visible tiles, then near-future camera motion, selection ancestors, and requested properties.
- CPU decoded cache, GPU resident cache, and persistent artifact cache each have separate budgets and LRU/priority policy.
- Selection and measurements pin required tiles or use simplified proxy geometry.
- Federated models share a common high-precision coordinate strategy while render coordinates stay near the camera/local origin.

Do not make runtime mesh simplification the primary LOD approach. Precompute deterministic LOD artifacts and keep exact geometry available for inspection and measurement.

### 10.5 WebGPU decision

[Three.js WebGPU renderer documentation](https://threejs.org/manual/en/webgpurenderer) describes a WebGPU renderer with a WebGL 2 fallback, but its material/shader model differs from the mature WebGL renderer. Existing custom shaders, `ShaderMaterial`, `onBeforeCompile`, post-processing, picking, and edge/clipping behavior require explicit parity work. [MDN marks WebGPU as limited availability](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API), and it requires a secure context.

Run WebGPU as an experimental adapter after the render contract is stable. Promote it only if:

- the supported-device matrix meets product needs;
- all critical visual/interaction parity tests pass;
- p95 frame time or memory improves materially on representative large models;
- fallback behavior does not double maintenance indefinitely.

Do not write a WebGPU renderer directly against the low-level API before proving that Three.js WebGPU/TSL cannot meet the requirement.

## 11. Comparison of web-ifc, IFC Lite, Dalux-style rendering, and possible custom solutions

### 11.1 Comparative summary

| System | Parse/convert | Store/stream | Render | Strengths | Risks / fit |
|---|---|---|---|---|---|
| web-ifc + Fragments | C++/Wasm STEP index and IFC geometry; Fragments importer produces FlatBuffers | Worker callbacks and fragment binaries; app supplies cache/transport policy | Three.js/Fragments | Current integration, broad coverage, browser fallback | Large workers/Wasm, memory copies, coupled versions; keep behind adapters |
| IfcOpenShell | C++ core with Python API and mature semantics/geometry | Application-defined files/databases/caches; geometry iterator | Not a browser renderer | Best current semantic/edit authority; proven IFC coverage | Native deployment/lifecycle; browser use is not its primary strength |
| IFC Lite | Rust scanner/span index, lazy typed decode, columnar data, Rust geometry/CSG | Wasm/native workers, content-aware scheduling; project describes server cache/Parquet/SSE paths | WebGPU renderer with batches, entity IDs, reverse-Z, spatial culling | Shared native/Wasm language, memory safety, promising lazy/columnar and GPU architecture | New project, pre-1.0 independent packages, limited production evidence; benchmark, do not bet the product immediately |
| Dalux-style product architecture | Proprietary implementation details are not public | Public product supports huge federated/offline model workflows | Highly optimized desktop/mobile viewer | Excellent product benchmark for fast navigation, federation and offline UX | Cannot copy or validate internals; “style” recommendations are architectural inference |
| xeokit / XKT | Offline XKT conversion; direct IFC path uses web-ifc and is described as alpha | Compact XKT artifacts and loaders | Purpose-built WebGL BIM viewer, double precision | Strong reference for preconversion, batching and large-model viewing | Converter is AGPL unless separately licensed; migration loses current behavior; reference/benchmark only |
| Speckle Viewer | Speckle object/geometry conversion ecosystem | Content-addressed object graph and progressive loading | Three.js-based batching, BVH, instancing, relative-to-eye | Strong reference for extension/loader architecture and federation | Larger platform/data-model commitment; not a direct IFC converter replacement |
| Fully custom | Any chosen parser/kernel | Fully controlled format/cache | Fully controlled renderer | Maximum theoretical control | Highest correctness, security, staffing and long-tail IFC risk; multi-year effort |

### 11.2 IFC Lite assessment

[IFC Lite](https://github.com/LTplus-AG/ifc-lite) is a promising MPL-2.0 Rust project. Source inspection shows:

- a fast byte scanner and minimal span index before full decoding;
- lazy typed decoding and columnar/property-oriented storage;
- compressed relationship structures and on-demand access;
- native Rayon and browser worker parallelism;
- memory-aware worker scheduling;
- a Rust geometry/CSG pipeline usable natively and through Wasm;
- a WebGPU-oriented renderer with batching, per-element IDs, reverse-Z and spatial culling;
- server/cache and federation concepts.

These are relevant design ideas. However, the project was created in 2026, packages are versioned independently and remain pre-1.0 in important areas, public package examples/version claims are not fully consistent, and project benchmarks are not substitutes for Atlas fixtures. Treat it as a candidate and potential upstream collaboration, not as an approved replacement.

The bake-off should test its parser/geometry packages independently from its renderer. It may be valuable to adopt a Rust conversion core while keeping the current Three renderer, or adopt lazy metadata/index ideas without changing conversion.

### 11.3 Dalux-style assessment

[Dalux publicly states](https://www.dalux.com/en-ca/solutions/2d-and-3d-viewer-functionality/) that its viewer handles very large object counts, federated models, desktop/mobile use and offline workflows. Dalux does not publish enough implementation detail to make claims about its exact parser, binary format, spatial structure, culling algorithm, or renderer.

A “Dalux-style” Atlas architecture should therefore mean product principles inferred from observable behavior:

- preprocessing into application-owned, versioned render artifacts;
- shared coordinates and stable identities across federated revisions;
- aggressive batching/instancing and spatial partitioning;
- progressive visible-first loading and explicit residency budgets;
- LOD and offline/local caches;
- separate lightweight properties from heavy geometry;
- mobile-aware interaction and graceful degradation.

These principles are worth adopting. Claims about copying Dalux internals are not.

### 11.4 Other open-source references

- [That Open Fragments](https://github.com/ThatOpen/engine_fragment) demonstrates compact FlatBuffers geometry/properties/relationships and a Three-based IFC-oriented runtime. It remains the lowest-risk production path during migration.
- [xeokit SDK](https://github.com/xeokit/xeokit-sdk) and [xeokit-convert](https://github.com/xeokit/xeokit-convert) are useful references for offline XKT preprocessing, double precision, and large-model WebGL. The converter’s AGPL license must be reviewed before any code reuse.
- [Speckle Viewer](https://github.com/specklesystems/speckle-server/tree/main/packages/viewer) is a useful reference for automatic batching, relative-to-eye coordinates, multi-level BVH, instancing, loader contracts, and extensions.
- The [buildingSMART IFC specification](https://technical.buildingsmart.org/standards/ifc/ifc-schema-specifications/) illustrates why schema/representation correctness is a standards program, not a small parser task.

### 11.5 Build-versus-buy decision by component

| Component | Recommendation | Reason |
|---|---|---|
| IFC lexical/parser/schema layer | **Use existing** (IfcOpenShell; web-ifc fallback; evaluate IFC Lite) | Low differentiation, very high conformance burden |
| IFC placement/representation/CSG/BRep geometry | **Use existing** | Extreme long-tail correctness and numerical robustness cost |
| IFC-to-render-artifact orchestration | **Develop in-house around libraries** | Workload-specific profiles, identity, manifests, diagnostics and scheduling are differentiating |
| Artifact format contract | **Develop in-house** | Needed to decouple app from converter/renderer versions; can wrap existing codecs |
| Geometry algorithms such as triangulation, simplification, BVH | **Use libraries** | Mature optimized implementations already exist |
| Spatial partition and index policy | **Develop in-house using library primitives** | Must match Atlas queries, federation, tiles, LOD and cache budgets |
| Metadata/property projection and loader | **Hybrid** | Reuse IFC parsing; own projected schema, sharding, indexes and API |
| LOD policy and residency scheduler | **Develop in-house** | Highly workload/device/UX-specific |
| Visibility/appearance composition | **Develop in-house** | Encodes Atlas feature semantics |
| Rendering engine | **Use Three.js/Fragments behind adapter** | Custom engine has poor return and major browser/GPU compatibility cost |
| Streaming/cache/job system | **Develop application layer; use storage/network libraries** | Identity, versioning, offline behavior and budgets are product-specific |
| Compression/codecs | **Use existing** | Security, speed and interoperability |

## 12. Recommended technology stack

### 12.1 Recommended stack now

| Layer | Technology | Rationale |
|---|---|---|
| Web UI and application logic | TypeScript, React, focused Zustand stores | Existing expertise and features; strong type contract with browser APIs |
| Production renderer | Three.js WebGL via an Atlas adapter; Fragments implementation initially | Lowest migration risk and broad device support |
| Experimental renderer | Three.js WebGPU/TSL adapter behind capability flag | Provides a measured path without committing all users |
| API and semantic services | Python 3.12, FastAPI, Pydantic, IfcOpenShell | Best fit for current domain, AI, automation and IFC semantic work |
| Background jobs | Separate bounded Python/native worker processes with a simple job contract | Isolates CPU/native work and resource limits |
| Current converter | Node sidecar/web-ifc/Fragments, made explicit and versioned | Preserves existing parity while the contract is extracted |
| Candidate converter | Rust library and CLI/service, optionally based on IFC Lite or existing native libraries | One memory-safe codebase can target server/desktop and potentially Wasm |
| Browser fallback conversion | web-ifc worker, optional/lazy | Supports offline/local cases while avoiding default duplicate work |
| Artifact/storage | Content-addressed immutable blobs + manifest; filesystem/S3-compatible backend | Simple local and server deployment, cacheable and revision-safe |
| Desktop | Tauri 2 thin shell | Small trusted host and good existing integration |
| Contracts | OpenAPI/JSON Schema plus generated TypeScript; explicit artifact schema | Prevents manual DTO drift |
| Observability | OpenTelemetry-compatible traces/metrics, structured logs | Crosses upload, jobs, sidecar, viewer and LLM/tool paths |

### 12.2 Rust versus C++

Choose Rust for new performance-critical Atlas-owned code because it offers memory safety, strong concurrency primitives, good native/Wasm targets, and a clear package/test story. Use C++ through mature existing engines when it already solves the hard geometry problem. Starting a new C++ parser/kernel would add memory-safety and build complexity without a unique advantage.

Rust should enter only behind a process/library boundary and benchmark gate. It is not a reason to rewrite Python route logic or TypeScript UI logic.

### 12.3 Python scope

Continue using Python for:

- FastAPI and application orchestration;
- IfcOpenShell semantic queries and edits;
- AI/LLM/MCP integration;
- validation, reports, BCF/IDS/COBie/document automation;
- administration and non-frame-critical jobs.

Avoid Python for:

- browser frame loops and interaction;
- large repeated byte copying;
- custom tessellation/CSG kernels;
- high-throughput binary encoding where profiling proves it dominant.

### 12.4 Wasm scope

Wasm is useful for local/offline parsing and compute kernels, but it is not automatically faster end-to-end. Count JS↔Wasm copies, memory growth, worker startup, download/compile, threading isolation headers, and mobile limits. Prefer a native server conversion path when a network/server is available; retain lazy Wasm for desktop/browser-offline cases.

## 13. Components to keep

“Keep” does not mean “leave unchanged.” These components retain their role while gaining clearer boundaries, updates, and tests.

| Component | What remains | Required change | Verification |
|---|---|---|---|
| React and TypeScript | UI framework and application language | Split large components, tighten types, then upgrade in isolated cohorts | UI parity, type check, interaction tests, bundle and responsiveness budgets |
| Zustand | Lightweight client application state | Divide into domain slices/selectors and remove engine objects from durable state | Render-count tests and no behavior regressions |
| Three.js | Production graphics foundation | Access only through the render adapter; pin compatible version | Golden images, frame/memory metrics, feature parity |
| Fragments | Initial production artifact/runtime | Exact-pin; wrap in Atlas manifest and adapter; define invalidation | Cross-version artifact tests and load/unload soak |
| web-ifc | Current converter and offline fallback | Put behind converter interface; lazy-load; align versions | IFC corpus parity and worker memory benchmarks |
| IfcOpenShell | Semantic/edit/validation authority | Scoped immutable model sessions, bounded workers, pinned platform builds | Semantic/edit corpus and process stability |
| FastAPI/Pydantic/Uvicorn | Python service platform | Security/update cohort, thin routes, generated clients | Contract tests, load tests and audits |
| camera-controls / three-mesh-bvh | Camera dynamics and fast geometry queries | Encapsulate lifecycle; tune construction policy | Interaction parity and frame/pick benchmarks |
| MCP and direct LLM SDKs | Interoperability and providers | Upgrade, authorize at application boundary, consolidate duplicate paths | Provider contract tests, tool policy tests, cost telemetry |
| IFC domain libraries | IFC diff, IDS testing, reports | Pin, isolate and add malformed-input/resource tests | Domain fixture tests |
| Tauri | Thin desktop host | Least privilege, loopback token, secret vault | desktop end-to-end, permission audit |
| Playwright, Vitest, pytest | Test foundation | Add coverage/gates and representative fixtures | CI produces deterministic reports |
| Existing documentation | Product and architectural knowledge | Correct drift and add decision records | link/contract checks and release review |

## 14. Components to replace

| Current component/pattern | Replacement | Why | Migration risk |
|---|---|---|---|
| Filename-addressed mutable uploads | Content-addressed immutable source blobs and model revisions | Prevents collisions, enables dedupe/cache correctness and multi-user safety | Requires migration of saved projects and URLs |
| Raw express ID as broad identity | `{projectId, modelId, revisionId, elementKey}` plus local express-ID mapping | Supports federation, revisions and concurrent models | Touches state, selection, issues, properties and API DTOs |
| Process-global IFC/model authority | Request/project-scoped context and immutable model cache | Eliminates cross-user conflict and clarifies lifecycle | IfcOpenShell thread/process behavior needs careful tests |
| Full-body `/convert` endpoint | Job submission by source revision/file handle with streamed progress | Removes repeated transfer/copies and supports cancellation | Browser-only deployment needs an explicit fallback |
| Hand-written monolithic `api.ts` | Generated transport client plus small feature gateways | Eliminates DTO drift and improves cancellation/error handling | Generated changes may initially be noisy |
| `ViewerPanel` as engine/application/UI owner | `ViewerSession` + capabilities + small React host | Deterministic lifecycle and independent feature testing | High-touch refactor; must be incremental |
| Monolithic Zustand store | Domain stores/slices and selectors | Reduces coupling and unnecessary renders | Incorrect state migration can create subtle UI regressions |
| Scattered material/visibility writes | Appearance/visibility compositor | Features combine predictably | Requires defining conflict priority |
| Global CSS file | Design tokens, reset/layout primitives and feature-scoped styles | Maintainability, responsive behavior and smaller feature loading | Cascade/order visual regressions |
| Raw tool dispatcher | Typed command registry and policy middleware | Cuts complexity and makes auth/audit/test behavior explicit | Tool schemas and results must remain compatible |
| Mixed LangChain/LangGraph/direct provider orchestration | One application-owned provider/tool state machine, normally using direct SDKs | Smaller attack/update surface and clearer behavior | Edge workflows may rely on hidden framework behavior |
| JSON-only secret storage | OS keychain/Stronghold for desktop and managed secrets for server | Platform-appropriate protection | Migration and headless deployment paths |
| Best-effort converter deployment | Explicit self-contained converter image/binary or explicit browser-only profile | Production matches documented architecture | Image size/build platform work |

## 15. Components to remove

Removal occurs only after characterization tests and runtime/import confirmation.

| Candidate | Reason | Gate before removal |
|---|---|---|
| `ifc-atlas-desktop: file:..` frontend dependency | Invalid/unused package relation and audit blocker | Confirm root/Tauri packaging does not resolve it; clean install/build/package |
| `ClipPlaneControls.tsx` | No import sites detected | Search worker/dynamic registries, run viewer parity, then delete |
| `ColourByControl.tsx` | No import sites detected | Same gate |
| `SelectionHistoryNav.tsx` | No import sites detected | Same gate |
| Unused exports/types | Enlarged public surface and false architecture | Remove in small feature-owned batches with type/test/build gates |
| Duplicate profile/frustum/provider helpers | Behavior drift and maintenance | Establish canonical behavior tests, then consolidate |
| LangChain/LangGraph family | Likely redundant orchestration and current advisory burden | Remove only after every supported chat/tool flow passes against the smaller state machine |
| Base-install semantic vector dependencies | Heavy optional native footprint | Preserve feature through an install extra/service and verify lexical fallback |
| Browser source bytes after persistence | Avoid retained memory | Confirm revision/artifact endpoints support every reload/edit/export path |
| One of the duplicate conversion implementations | Reduce operational and bundle complexity | Select only after the converter bake-off and offline requirements are resolved |
| Stale documentation and configuration claims | Misleading operations | Replace with tested/generated facts and an ownership review |

Do not remove small, mature libraries such as `earcut`, camera controls, BVH, Markdown, or compression simply to reduce dependency count. Their replacement cost and correctness risk are larger than their maintenance cost.

## 16. Components worth developing in-house

### 16.1 Build now

1. **Model catalog and immutable revision identity.** This is the foundation for multi-model, caching, history, security, and reproducibility.
2. **Atlas Render Package manifest and compatibility rules.** Own the contract while allowing Fragments or a future codec underneath.
3. **Conversion job coordinator.** Own scheduling, cancellation, progress, resource budgets, diagnostics and cache lookup; delegate parsing/geometry to engines.
4. **Spatial/LOD artifact policy and residency scheduler.** This is specific to Atlas devices, interaction and federated workloads.
5. **Metadata projection/index API.** Own the query-oriented property/relationship shards and stable element keys while using IfcOpenShell/web-ifc/IFC Lite to parse.
6. **Visibility and appearance compositor.** Encode how Atlas features combine rather than letting renderer mutations race.
7. **Typed extension contracts and capability policy.** Make feature growth safe without exposing internal renderer/backend objects.
8. **Benchmark/telemetry harness.** It is essential product infrastructure for every later engine decision.

### 16.2 Prototype after boundaries exist

1. **Rust conversion/tiling core.** Prototype with existing crates/projects and Atlas fixtures. It should emit the same manifest and pass the same parity suite.
2. **WebGPU renderer adapter.** Prototype visible geometry, picking, clipping, edges, selection and measurements before pursuing full parity.
3. **Content-addressed revision store replacing GitPython.** Prototype only if Git process/storage overhead or deployment becomes material.

### 16.3 Do not build now

- a new IFC schema parser;
- a new CSG/BRep/tessellation kernel;
- a complete browser rendering engine;
- a general BVH, triangulator, simplifier or compression codec;
- a custom Markdown parser/sanitizer;
- custom LLM provider protocols;
- custom cryptographic secret storage.

The decision can change only with a written benchmark or capability gap showing that upstream contribution, wrapping, or licensing cannot meet the requirement.

## 17. Proposed target architecture

### 17.1 Logical architecture

```text
┌──────────────────────────────── Web / Desktop UI ────────────────────────────────┐
│ feature modules -> application commands/queries -> domain stores                │
│                                      │                                           │
│                               ViewerSession                                      │
│                     appearance + selection + residency                           │
│                                      │                                           │
│                     RendererAdapter (Three/Fragments first)                      │
└──────────────────────────────────────┬────────────────────────────────────────────┘
                                       │ generated API + artifact range requests
┌──────────────────────────────────────v────────────────────────────────────────────┐
│ API boundary: auth, project policy, quotas, request IDs, typed DTOs               │
│                                                                                   │
│ Model Catalog  Edit Use Cases  Query Use Cases  Chat/Tool Use Cases  Job API      │
│       │               │               │                 │              │           │
│ ProjectContext -> immutable ModelRevision -> capability policy -> audit events    │
└───────────┬───────────────────────┬───────────────────────────────┬───────────────┘
            │                       │                               │
       source/artifact store   semantic workers                converter workers
       filesystem / object     IfcOpenShell                    current Node
       storage / local IPC     validation/docs                 candidate Rust
            │                       │                               │
            └──────────── content-addressed manifests/artifacts ────┘
```

### 17.2 Core boundaries

**Model catalog**

- Owns project, model, revision, source hash, display name, schema, status and permissions.
- Model revisions are immutable. An edit transaction produces a new revision on commit.
- Maps source-local express IDs to stable application element keys.

**Artifact repository**

- Uses `(source hash, converter build, settings hash, artifact schema)` as the cache key.
- Never accepts a filename as identity.
- Supports local filesystem and S3-compatible implementations.
- Verifies checksums before use and garbage-collects only unreferenced artifacts.

**Converter interface**

```text
inspect(source) -> schema/units/coordinates/capabilities
convert(source revision, profile) -> job
job events -> progress/warnings/metrics/artifact manifest
cancel(job)
```

web-ifc/Fragments, browser fallback, and a Rust candidate implement the same conformance suite.

**Semantic model interface**

Provides typed spatial, property, relation, quantity, classification, validation and edit operations against a specific revision. It does not expose a global `ifc_file`.

**Viewer interface**

Consumes an artifact manifest and stable identity maps. Viewer capabilities do not depend on the source parser.

**Extension interface**

- Versioned manifest and API range.
- Declared capabilities such as `model.read`, `model.edit`, `network`, `filesystem.read`, `llm.invoke`.
- Typed commands, queries, events, panels and tool descriptors.
- Extensions run in an isolated web worker/iframe or backend worker process as appropriate.
- No extension receives secrets/environment by default.

### 17.3 Data consistency

Use optimistic concurrency:

- Commands include the expected revision.
- Read-only queries are revision-addressed and cacheable.
- Edit commits return a new revision and a structured change set.
- The viewer applies metadata-only changes when safe; geometry changes request new affected artifacts/tiles.
- Conflicts return a typed conflict rather than silently mutating the shared model.

### 17.4 Multi-model and federation

Federation should be a first-class collection of model revisions. Every selection, issue, search hit, property result and visible object uses a compound identity. Coordinate handling stores source georeference separately from a local render origin and supports relative-to-eye/high-low precision where needed. No global express-ID namespace is assumed.

### 17.5 Deployment profiles

| Profile | Conversion | Storage | Security |
|---|---|---|---|
| Desktop local | packaged native/Node converter or lazy browser fallback | local content-addressed store | loopback-only random token, OS vault, trusted/signed extensions |
| Single-server | dedicated converter worker | local or object store | authentication, project authorization, worker isolation |
| Scaled server | job queue + horizontally scaled converter/semantic workers | object store/CDN | tenancy, quotas, audit, network policy |
| Offline web | lazy web-ifc/Wasm converter | IndexedDB/OPFS where supported | origin isolation, explicit local-only limitations |

## 18. Proposed folder structure

The target structure is directional. Move code only when a feature is touched and covered; do not perform a repository-wide file shuffle.

```text
ifc-atlas/
├─ apps/
│  ├─ web/                         # React composition root
│  └─ desktop/                     # thin Tauri app
├─ packages/
│  ├─ contracts/                   # generated API DTOs + artifact schemas
│  ├─ model-identity/              # branded IDs and revision helpers
│  ├─ viewer-core/                 # ViewerSession, commands, events, capabilities
│  ├─ renderer-three/              # Three/Fragments adapter
│  ├─ appearance/                  # visibility/color resolution
│  ├─ ifc-client/                  # feature gateways and job streaming
│  ├─ ui/                          # tokens and reusable accessible primitives
│  └─ test-fixtures/               # non-sensitive small shared fixtures
├─ services/
│  ├─ api/
│  │  ├─ app/
│  │  │  ├─ api/                   # thin routers and DTO mapping
│  │  │  ├─ application/           # use cases and policies
│  │  │  ├─ domain/                # IDs, revisions, errors, capability types
│  │  │  ├─ infrastructure/        # storage, IfcOpenShell, providers, Git
│  │  │  └─ features/              # bcf, ids, cobie, cost, carbon, chat...
│  │  └─ tests/
│  ├─ converter-node/              # transitional current implementation
│  └─ converter-rust/              # only after bake-off approval
├─ benchmarks/
│  ├─ fixtures/                    # licensed/synthetic IFC corpus manifests
│  ├─ scenarios/                   # load, edit, orbit, federate, query
│  ├─ baselines/                   # machine/profile-specific results
│  └─ reports/
├─ docs/
│  ├─ architecture/
│  ├─ adr/
│  ├─ operations/
│  └─ security/
└─ tools/                          # build, schema generation, audit scripts
```

During migration, existing `frontend/`, `backend/`, and `src-tauri/` paths remain valid. New packages should not be created unless at least two real consumers or a strong runtime boundary justify them.

## 19. Migration strategy

### 19.1 Principles

1. Measure before optimizing.
2. Preserve a releasable application at the end of every phase.
3. Characterize externally visible behavior before moving it.
4. Introduce an interface around the current implementation before adding a new implementation.
5. Run old and new paths side by side on fixtures where practical.
6. Use feature flags for converter, artifact, renderer, state and auth migrations.
7. Make artifacts and APIs versioned and backward-readable for a defined support window.
8. Never combine an engine upgrade, architecture move and visual redesign in one change.
9. Remove compatibility code promptly after the rollback window.
10. Record material decisions as ADRs.

### 19.2 Migration sequence

**Step 1 — Freeze and measure the baseline.**

Create reproducible environments, fixture manifests, API/browser/converter metrics, bundle reports and golden interaction traces. Record reference machines and cold/warm cache conditions.

**Step 2 — Close urgent security and reliability gaps.**

Upgrade vulnerable dependencies, cap all untrusted inputs, add deadlines, add desktop loopback tokens/server authentication modes, scrub plugin environments, and mark arbitrary code as trusted-only until isolated.

**Step 3 — Add stable identity and contracts.**

Introduce project/model/revision/element identifiers, error codes, artifact manifest v1, and generated API DTOs without changing the current engine.

**Step 4 — Extract current implementations.**

Wrap the existing converter as `IfcConverter`, the current Three/Fragments path as `RendererAdapter`, and the current backend into scoped use cases. Behavior remains the same.

**Step 5 — Simplify frontend and backend internals.**

Split `ViewerPanel`, state, API gateways, routes, central services and tool dispatch. Delete confirmed dead code. Add deterministic lifecycle and policy tests.

**Step 6 — Replace the load path.**

Upload/hash once into immutable storage, submit conversion by revision, stream job progress, serve manifest/chunks, and release browser source bytes. Keep browser conversion behind an offline flag.

**Step 7 — Introduce spatial artifacts and residency.**

Emit spatial/LOD tables, property shards and metrics. Add visible-first streaming and separate persistent/CPU/GPU budgets.

**Step 8 — Run the converter bake-off.**

Compare improved current sidecar, IfcOpenShell native profiles, and an IFC Lite/Rust prototype. Select on correctness, memory, latency, output size, deployment, licensing and maintenance—not a single throughput number.

**Step 9 — Experiment with WebGPU.**

Implement the renderer adapter subset, run parity/performance tests, and retain WebGL as default until the promotion gate is met.

**Step 10 — Complete multi-model and extension boundaries.**

Migrate compound identity everywhere, isolate plugins, add capability/version enforcement, and remove global compatibility state.

### 19.3 Compatibility mechanisms

- Dual-read old and new cache/artifact formats; write only the new version after rollout.
- Shadow-convert selected fixtures/opt-in user models and compare manifests/geometry diagnostics.
- Map old source paths and checkpoint IDs to immutable revisions during migration.
- Emit deprecation telemetry before removing API fields.
- Use database/storage migration manifests even if the initial repository is filesystem-based.
- Retain a rollback switch for the previous converter/renderer for one stable release, provided doing so does not preserve a security vulnerability.

### 19.4 Recommendation register

The following records make the cost, benefit, risk and proof for major recommendations explicit.

| ID | What should change | Why | Benefit | Main risk | Difficulty | How success is verified |
|---|---|---|---|---|---|---|
| R01 | Add explicit desktop/server auth modes, project authorization and scoped contexts | Current routes and global state are unsafe for shared access | Prevents unauthorized operations and cross-user leakage | Broad route/client impact | High | Negative authorization tests for every route class; two-user isolation tests; threat-model review |
| R02 | Isolate or restrict plugin/code execution | Child restrictions and inherited environment are not a sandbox | Protects secrets/host and enables a credible extension story | OS-specific packaging and lost plugin capabilities | Very high | Escape/exfiltration test corpus fails closed; no ambient secrets/network/files; resource kills work |
| R03 | Lock and upgrade dependencies in cohorts | Current Python advisories and invalid npm tree undermine reproducibility | Fewer vulnerabilities and repeatable builds | Major-version behavior changes | Medium | Clean installs from locks, SBOM/audits, full suite and package smoke tests |
| R04 | Introduce immutable model revisions and compound element identity | Filenames/express IDs are not safe global identities | Correct caching, federation, history and concurrency | Data migration touches most domains | High | collision/revision/federation tests; every API/viewer event carries identity |
| R05 | Split `ViewerPanel` into `ViewerSession` and capabilities | Lifecycle/feature coupling blocks safe changes | Smaller components, deterministic cleanup, testable tools | Interaction regressions | High | renderer regression suite, event/resource counters, unchanged workflows |
| R06 | Split the Zustand store by domain and frequency | Broad shared state causes coupling/rerenders | Clear ownership and more responsive UI | stale synchronization between slices | Medium | render-count budgets, state migration tests, browser workflows |
| R07 | Replace full-body duplicate loading with one immutable ingest and jobs | Current path amplifies memory and work | Lower peak memory, faster reliable large-file load | Offline/browser behavior divergence | High | heap/RSS traces, byte counters, cancellation/retry tests, same feature parity |
| R08 | Add Atlas artifact manifest and renderer/converter adapters | Engine formats leak into the application | Engine independence, cache correctness and controlled experiments | “Leaky” abstraction that mirrors one engine | High | conformance suite with two stub/real implementations; version rejection tests |
| R09 | Add spatial/LOD artifact policy and residency scheduler | Whole-model loading does not scale smoothly | Visible-first UX and bounded CPU/GPU memory | LOD artifacts may break picking/measurement | Very high | camera traces, pixel/pick/measurement parity, memory budgets on large/federated fixtures |
| R10 | Run a converter bake-off before selecting Rust/IFC Lite | Claims and microbenchmarks do not establish Atlas fit | Evidence-based engine decision and avoided rewrite | Prototype cost may produce “no change” | Medium–high | published scorecard and go/no-go ADR using fixed corpus |
| R11 | Consolidate LLM/provider orchestration and optionalize heavy search | Duplicate stacks increase size, advisories and complexity | Smaller base install and clearer tool behavior | hidden framework behavior may be lost | Medium | recorded conversation/tool scenario parity, token/cost/error metrics |
| R12 | Strengthen CI with lint, audits, Rust, sidecar and renderer jobs | Important checks are currently absent or partial | Earlier regressions and reliable releases | CI time/flakiness | Medium | required checks, time budget, quarantined-flake policy and artifacts |
| R13 | Harden deployment images and make converter runtime explicit | Current production profile can silently lack server conversion and runs broadly | Predictable operations and smaller blast radius | Platform/image maintenance | Medium | clean-machine deployment, non-root/health/resource tests, conversion smoke |
| R14 | Define a typed capability-based extension API | Plugins currently couple to internals and broad authority | Safer extensibility and independent versioning | API design can overreach | High | example extensions, compatibility matrix, permission-denial tests |
| R15 | Keep ADRs, generated contract docs and operational runbooks current | Existing docs have drifted | Faster onboarding and safer decisions | Documentation becomes ceremonial | Low–medium | link/schema checks plus release-owner review |
| R16 | Add end-to-end metrics across upload, conversion, artifacts and frames | Optimization decisions lack comparable evidence | Finds actual bottlenecks and protects gains | telemetry overhead/privacy | Medium | trace correlation and overhead under 2%; anonymization review |
| R17 | Prototype WebGPU only through the adapter | Direct migration risks compatibility and duplicate renderer code | Potential GPU performance gains with rollback | shader/feature parity cost | High | supported-device matrix and promotion benchmark gate |
| R18 | Make federation/multi-model first-class | Current global assumptions limit scale and collaboration | Stable multi-model navigation, issues and search | widespread identity/coordinate changes | High | federated fixture suite with repeated express IDs and large coordinates |
| R19 | Replace global CSS incrementally with tokens/scoped feature styles | Large cascade makes responsive work fragile | Maintainable, accessible, more responsive UI | visual regressions and CSS duplication during transition | Medium | screenshot matrix, accessibility audit, CSS/initial-load budgets |
| R20 | Split backend routes/services and raw tool dispatch into use cases/handlers | Severe complexity and weak policy boundary | Easier testing, error handling, authorization and extension | temporary adapter layers | High | complexity ceilings, route contract parity, handler unit tests |
| R21 | Create query-oriented property/relation shards and indexes | Loading all metadata or recomputing filters delays interaction | Fast on-demand properties/search with smaller client memory | duplicated derived data and invalidation bugs | High | revision-keyed index determinism, query latency and cache invalidation tests |

## 20. Testing strategy

### 20.1 Test pyramid by boundary

| Level | Purpose | Required examples |
|---|---|---|
| Pure unit | Algorithms, policies and reducers | identity, appearance precedence, LOD selection, cache eviction, permission policy, error mapping |
| Contract | Stable boundary behavior independent of implementation | converter, artifact manifest, renderer adapter, semantic model, extension capabilities, generated API |
| Integration | Native/runtime combinations | IfcOpenShell revisions, sidecar jobs, object store, Wasm worker, secret vault |
| Browser component | React/store/lifecycle | feature panel commands, selection synchronization, responsive layout, disposal |
| End-to-end | Critical product workflows | import, cache reload, properties, selection, clipping, measurement, edit/undo, BCF/IDS, chat/tool, export, desktop open |
| Visual/renderer | Pixel and interaction parity | standard cameras, section planes, edges, colors, transparency, selection, large coordinates |
| Non-functional | Performance, security, reliability | load/frame/memory, malformed inputs, auth isolation, cancellation, crash recovery, soak |

### 20.2 IFC conformance corpus

Maintain a legally distributable fixture manifest covering:

- IFC2X3, IFC4 and supported IFC4x3 cases;
- mapped/instanced geometry;
- extrusions, swept disks, faceted and advanced BReps, booleans and openings;
- curves/surfaces and triangulated/polygonal face sets;
- unusual units, placements, rotations, georeferencing and very large coordinates;
- missing/invalid relationships and recoverable malformed STEP;
- colors, transparency, layer/style/material inheritance;
- large property sets, classifications, quantities and type inheritance;
- duplicate express IDs across federated models;
- tiny, medium, large and stress-scale files;
- adversarial ZIP/XML/PDF/IFC inputs stored separately from normal fixtures.

Record expected semantic counts, spatial tree, selected property values, geometry bounds, triangle/material counts, warnings and approved reference images. Avoid requiring exact triangle ordering where engines legitimately differ; compare toleranced geometry signatures and visual/interaction outcomes.

### 20.3 Coverage and quality gates

- New domain/application packages: 90% branch coverage target where logic is deterministic.
- Security policy, identity, artifact validation and edit transactions: 100% decision-branch coverage plus mutation/property tests where practical.
- Legacy modules: establish a baseline and require no decrease; raise thresholds as code moves.
- No new file may exceed agreed size/complexity limits without an ADR. Starting guidance: Python function complexity ≤15, React component ≤400 lines, application service ≤600 lines.
- Lint and type errors are zero. Existing Ruff issues are fixed in a dedicated small change rather than hidden with global ignores.
- Flaky tests are tagged, owned and time-limited; required suites do not silently retry indefinitely.

### 20.4 CI matrix

Pull requests should run:

- Python lock check, Ruff, type/static checks, fast tests and dependency audit;
- frontend clean install, lint, type check, Vitest, production build and bundle diff;
- sidecar clean install, type check, tests and build;
- Rust format, Clippy, `cargo check`, tests and audit;
- OpenAPI generation drift check;
- small IFC contract corpus and one Playwright renderer smoke;
- secret scan, SBOM generation and container configuration scan.

Main/nightly should add the full IFC corpus, browser/device matrix, screenshot comparison, full backend/native tests in isolated processes, package/desktop smoke tests, performance trends, fuzzing and load/soak tests.

## 21. Benchmarking strategy

### 21.1 Metrics

**Ingestion and conversion**

- bytes read/written over each boundary;
- hash, parse, semantic index, tessellation, encode and persist time;
- time to manifest, first spatial tree, first visible geometry and complete artifact;
- peak RSS per process, Wasm high-water mark, temporary disk and output size;
- triangles, vertices, unique geometries, instances, materials and warnings;
- warm/cold cache hit rate and invalidation reason.

**Viewer**

- asset transfer/decompress/compile time;
- main-thread long tasks and worker startup;
- time to interactive and first useful model;
- p50/p95/p99 frame and input latency along scripted camera traces;
- draw calls, visible/resident triangles, tiles requested/wasted/cancelled;
- CPU heap, GPU estimate and retained resources after unload;
- pick, selection, property and search latency.

**Backend**

- request/job latency and queue time;
- concurrent-model throughput;
- event-loop delay and worker utilization;
- cancellation latency and crash recovery;
- LLM latency/token/cost separated from IFC/tool latency.

### 21.2 Benchmark protocol

- Use named hardware profiles: developer workstation, recommended desktop, integrated-GPU laptop, and mobile-class/throttled browser.
- Pin browser, OS, driver, Python, native library and engine versions in every result.
- Run cold filesystem/browser cache and warm artifact cache separately.
- Use at least five measured iterations after warm-up; report median and p95 with raw samples.
- Preserve fixture hashes and scenario definitions.
- Reject results with background contention outside an allowed range.
- Track performance in CI trends, but require manual confirmation before blocking on noisy GPU results.

### 21.3 Converter bake-off scorecard

Candidates:

1. current Node web-ifc/Fragments path after copy/deployment fixes;
2. IfcOpenShell native geometry/conversion profile;
3. IFC Lite/Rust prototype;
4. browser web-ifc as offline baseline.

Weighted decision criteria:

| Criterion | Weight |
|---|---:|
| Geometry and semantic correctness/parity | 35% |
| Peak memory and stability | 20% |
| Time to first visible / total conversion | 15% |
| Artifact size and streamability | 10% |
| Deployment, platform and offline fit | 8% |
| Maintenance, API maturity and upstream health | 7% |
| License/security posture | 5% |

Correctness is a veto: a faster engine that fails critical supported representations is not promoted. A candidate should normally deliver at least a 30% improvement in a priority memory/latency metric or unlock a required capability to justify a migration.

## 22. Security-improvement plan

### 22.1 Immediate actions

1. Document that the current server is trusted/local only until R01 and R02 are complete.
2. Bind desktop backend to loopback and require a random per-launch bearer token from the Tauri host.
3. Add server authentication and a deny-by-default route capability map.
4. Disable arbitrary remote plugin/code execution, or restrict it to explicitly trusted local administrators.
5. Scrub child environments and set time, CPU, memory, PID, filesystem and network policy.
6. Upgrade vulnerable dependency cohorts and commit reproducible locks.
7. Enforce upload/body/archive/document limits before allocation.
8. Add finite HTTP deadlines and cancellation.
9. Move secrets to OS/server secret storage and stop exposing even partial values.

### 22.2 Input and parser hardening

- Validate IFC header/schema and size while streaming; reject unsupported content before conversion.
- Store untrusted input outside served/static paths with generated names and no execute permission.
- Use safe XML parsing and disable/limit external entities.
- For ZIP-based formats, cap member count, individual size, aggregate expanded size, compression ratio and nesting.
- Put PDF, geometry and validation work in constrained workers.
- Validate artifact manifests, paths, lengths, checksums and decompressed sizes before allocation.
- Fuzz STEP tokenization, manifest decoders, XML/BCF/IDS normalizers and command schemas.

### 22.3 Web and desktop hardening

- CORS is an allowlist convenience, not authentication.
- Add CSP, HSTS for server mode, `nosniff`, frame policy, referrer policy and cross-origin isolation only where Wasm threading requires it.
- Add CSRF protection if cookie authentication is used; otherwise use short-lived bearer tokens and strict origins.
- Rate-limit by user/project/operation cost, not only IP.
- Log security-relevant actions with actor, capability, project, revision and outcome; never log secrets or full model content.
- Review Tauri capabilities/allowlists and remove global bridge exposure not required by the webview.
- Sign desktop updates and packaged sidecars; verify signatures/checksums at launch/update boundaries.

### 22.4 Supply chain and deployment

- Generate CycloneDX or SPDX SBOMs for Python, npm, Cargo and container layers.
- Add Dependabot/Renovate-style grouped updates with compatibility labels.
- Run pip/npm/Cargo audits, secret scanning, license checks and container scanning.
- Pin container base images by digest for releases and rebuild regularly.
- Run as non-root, drop capabilities, use read-only roots and explicit writable volumes.
- Define backup, artifact retention, disaster recovery and key rotation procedures.

## 23. Documentation plan

### 23.1 Required documents

- `OVERVIEW.md`: generated topology diagram plus current authoritative load/edit flows.
- ADRs for model identity, artifact manifest, converter selection, renderer adapter, plugin sandbox, LLM orchestration and WebGPU decision.
- API reference generated from OpenAPI with hand-written authentication/error examples.
- Artifact format specification with compatibility, checksums, coordinate conventions and invalidation.
- Extension SDK guide with capability model and secure examples.
- Security model describing desktop versus server boundaries.
- Performance handbook with fixtures, commands, machines, metrics and interpretation.
- Operations runbooks for converter failure, corrupt cache, worker exhaustion, secret rotation and rollback.
- Contributor guide with environment locks, code boundaries, naming and test selection.

### 23.2 Documentation rules

- Every architecture statement names the owning module and last verified version where relevant.
- Every major dependency has an owner and upgrade/removal notes.
- Diagrams describe a tested current state or clearly say “target.”
- Contract/schema tables are generated where possible.
- Public interfaces include short examples and failure behavior.
- Comments explain invariants, numerical/IFC edge cases and ownership—not obvious syntax.
- Use concise language and stable domain names.

### 23.3 Drift prevention

CI should validate links, generated API/artifact docs, example compilation and command snippets that can run safely. Each release checklist includes a named owner review for architecture, deployment and security docs. Tests should reference ADR/contract IDs when enforcing a non-obvious invariant.

## 24. Risks and trade-offs

| Risk/trade-off | Consequence | Mitigation |
|---|---|---|
| Boundary extraction temporarily adds adapters and files | Code count may rise before it falls | Time-box compatibility layers and track deletion milestones |
| Immutable revisions consume more storage | Higher disk/object-store cost | Content-address dedupe, chunk reuse, retention policy and transparent reporting |
| Server-first conversion weakens pure browser/offline use | Some users need local workflows | Keep explicit lazy browser converter and packaged desktop converter profiles |
| Spatial/LOD rendering can reduce visual exactness | Picking, measurements or screenshots may differ | Pin exact tiles for precision operations; define screen-error and parity tests |
| Rust introduces a new toolchain | Hiring/build/debug complexity | Keep a narrow process/library boundary; proceed only after bake-off |
| IfcOpenShell and web-ifc may disagree | Metadata/geometry identity mismatch | Stable mapping table, diagnostics and corpus comparison |
| React/Three/That Open upgrades are coupled | Large upgrade blast radius | Exact engine compatibility matrix and one cohort per change |
| Removing LangChain/LangGraph may recreate orchestration | Internal state machine can grow | Limit scope to existing workflows and retain a framework only for proven needs |
| Plugin isolation reduces flexibility | Existing plugins may lose ambient access | Version capabilities, provide explicit services and migration tooling |
| WebGPU creates dual-renderer maintenance | Slow delivery and divergent visuals | Adapter contract, limited experiment, strict promotion/retirement gate |
| Security/tenancy work delays visible features | Short-term roadmap pressure | Treat shared deployment safety as a release requirement; separate local mode explicitly |
| Performance fixtures may not represent customer models | Optimizations can target the wrong cases | Add opt-in anonymized metrics and customer-representative licensed fixtures |
| Moving folders causes merge churn | Slower parallel work | Move only feature-by-feature after APIs stabilize |

The main trade-off is deliberate: own the application-specific control plane and artifacts, but do not own standards parsing, computational geometry, or browser GPU foundations without compelling evidence.

## 25. Estimated implementation phases

Estimates assume three to four engineers with access to product/QA input. They are effort ranges, not calendar commitments; some security and measurement work can overlap.

| Phase | Scope | Estimate | Primary deliverables |
|---|---|---:|---|
| 0. Baseline and deployment safety | Reproducible locks, metrics, urgent dependency/input fixes, local/server mode statement | 2–4 weeks | baseline report, fixture manifest, security gate, working audit jobs |
| 1. Characterization and contracts | Critical E2E tests, OpenAPI generation, IDs/errors, artifact manifest v1 | 3–5 weeks | contract packages, ADRs, compatibility tests |
| 2. Modularize without behavior change | Viewer session, renderer/converter façade, state slices, thin routes, scoped backend use cases | 6–10 weeks | smaller modules, lifecycle/tool policy tests |
| 3. Dependency and build simplification | Dead code, invalid package, provider convergence, optional extras, grouped upgrades, CI expansion | 3–6 weeks | auditable locks, smaller base graph, full required checks |
| 4. Ingestion, storage and job pipeline | Immutable source/revisions, job conversion, progress/cancel, artifact serving, browser byte release | 6–10 weeks | one-copy logical flow, stable cache and deployment parity |
| 5. Spatial streaming, metadata shards and LOD | artifact partitioning, residency budgets, appearance compositor, federated identity | 10–18 weeks | visible-first load, bounded memory, multi-model groundwork |
| 6. Converter bake-off | improved baseline, IfcOpenShell and Rust/IFC Lite prototypes, scorecard/ADR | 6–10 weeks | go/no-go decision; no forced replacement |
| 6b. Production Rust converter, only if approved | conformance completion, platform packaging, migration and rollback | additional 16–30 weeks | supported production converter |
| 7. Renderer hardening and WebGPU experiment | adapter parity, WebGL optimization, WebGPU subset and device lab | 6–12 weeks | promotion/no-go ADR |
| 8. Extensions, multi-user and operational maturity | sandbox, capabilities, full federation, audit/quotas, scale tests | 10–18 weeks | supported extension SDK and shared-server readiness |

Without a new parser/kernel, the main refactor is plausibly 6–10 months with overlapping phases. Building and supporting a complete IFC parser, geometry kernel and renderer would likely take 2–4+ years before matching the present feature breadth, followed by ongoing standards and GPU maintenance.

## 26. Clear acceptance criteria for each phase

### Phase 0 — Baseline and deployment safety

- [ ] Clean setup from committed locks succeeds on every supported platform.
  Windows/Python 3.12 is verified; Linux CI and packaged desktop matrices remain.
- [x] Python 3.12 is the declared/tested backend version; container and CI
  install the committed hash lock.
- [ ] Known critical/high dependency advisories are fixed or have a dated,
  reviewed exception. Python and the production frontend are clean; the
  sidecar scanner gap is recorded above.
- [ ] Full npm trees are valid and auditable. Both trees install and `npm ls`
  cleanly, but the sidecar advisory endpoint currently rejects its lock.
- [ ] All input routes have enforced size/resource limits and sidecar calls
  have finite deadlines. IFC/plugin paths and the sidecar deadline are
  bounded; a global JSON/multipart/request-budget review remains.
- [x] Desktop API is loopback and per-launch-token protected; shared-server
  mode requires authentication.
- [x] Plugin/code execution is trusted-local by default and disabled in server
  mode; its subprocess environment uses a strict allowlist.
- [ ] Baseline bundle, conversion and coarse process-memory reports exist in
  `PHASE_0_BASELINE.md`; frame, unload, time-series memory and larger corpus
  measurements remain.

### Phase 1 — Characterization and contracts

- [x] Critical user workflows have end-to-end tests and deterministic reference outputs; the main local renderer parity scenario passes.
- [x] `ProjectId`, `ModelId`, `RevisionId` and compound `ElementKey` are specified and used on new boundaries.
- [x] OpenAPI-generated TypeScript builds without hand-edited generated files.
- [x] Artifact manifest v1 is documented, validated and checksum-tested.
- [x] Stable error/job state contracts include cancellation, resource limit and unsupported-IFC cases.
- [x] ADRs record security modes, identity and artifact decisions.

### Phase 2 — Modularization

- [ ] `ViewerPanel` is a composition host; engine lifecycle resides in `ViewerSession`.
- [ ] Every viewer capability has idempotent disposal and no direct cross-feature engine mutation.
- [ ] Backend IFC routes contain transport mapping, not file/conversion/edit orchestration.
- [ ] Global mutable model state is absent from request paths or isolated behind a documented transitional adapter.
- [ ] Raw tool dispatch complexity is reduced to the agreed threshold using typed handlers/policy.
- [ ] Existing E2E, renderer and API contract tests pass with no baseline performance regression over 5%.

Phase 2A completed the following sub-gates:

- [x] One idempotent `ViewerSession` owns final engine disposal, cancellation,
  async teardown barriers, and worker object URLs.
- [x] Upload and full-fragment conversion handlers map transport only; their
  application workflows have focused unit tests.
- [x] Upload prebuild and interactive conversion share one conversion
  orchestration path.
- [x] The transitional single-model adapter and remaining Phase 2 work are
  explicitly documented.

Phase 2B completed the following sub-gates:

- [x] OBC renderer/camera/grid and FragmentsManager/model acknowledgement boot
  through one start-once session runtime.
- [x] Moved DOM, resize, context, scheduler, and worker-URL resources register
  with the session lifecycle.
- [x] Selection and visibility integrations publish typed commands; engine
  composition remains owned by `RenderStateCoordinator`.
- [x] Repeated lifecycle tests return resource counters to zero.
- [x] Unit, typecheck, build, bundle, and hardware renderer gates pass without
  changing the active geometry/converter stack.

### Phase 3 — Dependency/build simplification

- [ ] Confirmed dead components/exports and the invalid local package dependency are removed.
- [ ] Root, frontend, sidecar, backend and Rust builds are reproducible and audited in CI.
- [ ] Heavy semantic search dependencies are optional.
- [ ] One LLM orchestration path serves all supported provider/tool scenarios.
- [ ] Engine dependency compatibility is documented and exact versions are embedded in artifacts.
- [ ] Initial viewer/application bundle budgets pass or have a measured, approved exception.

### Phase 4 — Ingestion/storage/jobs

- [ ] Source uploads are streamed, hashed once, atomically stored and addressed by immutable revision.
- [ ] Original filenames cannot overwrite/collide and are metadata only.
- [ ] Conversion is submitted by revision; API and sidecar do not transfer redundant full bodies.
- [ ] Jobs expose progress, cancellation, structured diagnostics and bounded resource behavior.
- [ ] Browser source bytes are released after durable ingest except in explicit offline mode.
- [ ] Cold/warm cache correctness survives restart, corruption and converter-version changes.
- [ ] Peak memory and first-useful-view meet the Phase 0 improvement targets.

### Phase 5 — Spatial streaming/LOD

- [ ] Manifests provide spatial bounds, tile costs, dependencies, LOD errors and property shards.
- [ ] Visible-first scheduling and separate persistent/CPU/GPU budgets are enforced.
- [ ] Picking, selection, measurements, clipping and appearance pass parity at all supported LODs.
- [ ] Repeated load/unload and camera soak tests stay inside memory/resource budgets.
- [ ] Federated fixtures with duplicate express IDs and large coordinates behave correctly.
- [ ] Large-fixture p95 frame/load targets pass on reference device profiles.

### Phase 6 — Converter bake-off

- [ ] Every candidate consumes the same immutable source contract and emits a comparable manifest.
- [ ] The full IFC corpus has correctness, warning and unsupported-feature results.
- [ ] Latency, peak memory, artifact size, deployment, license and maintenance results are published.
- [ ] A scored ADR selects current, hybrid or Rust/IFC Lite direction.
- [ ] No replacement is approved if it fails correctness vetoes or lacks a material measured benefit.

### Phase 6b — Production Rust converter, conditional

- [ ] Supported IFC representation parity meets the product matrix.
- [ ] Server, desktop and chosen Wasm targets have reproducible signed builds.
- [ ] Crash/fuzz/resource-limit tests pass and malformed files fail safely.
- [ ] Old artifacts remain readable for the support window or have an automatic migration.
- [ ] Rollout telemetry and rollback path are proven with staged traffic.

### Phase 7 — Renderer/WebGPU

- [ ] The adapter contains no application dependence on Three/Fragments types.
- [ ] WebGL path meets or improves the established frame/memory budgets.
- [ ] WebGPU passes visual, picking, clipping, measurement and supported-device parity.
- [ ] Promotion requires a material p95 frame/memory improvement and an explicit fallback/maintenance plan.
- [ ] If the gate fails, experimental code is removed or remains a clearly bounded lab package.

### Phase 8 — Extensions, federation and server readiness

- [ ] Every extension declares version and capabilities and runs in the approved isolation boundary.
- [ ] No extension receives environment secrets, network or filesystem access without explicit policy.
- [ ] Two-user/two-project isolation, authorization, quota and audit tests pass.
- [ ] Multi-model issues, search, properties, selections, edits and exports use compound identity.
- [ ] Backup/restore, worker failure, secret rotation and incident runbooks are exercised.
- [ ] Security review and production load/soak tests approve shared-server deployment.

---

## Decision summary

Approve the refactor if the team agrees to these architectural constraints:

1. Preserve the product through incremental, benchmarked changes.
2. Make authentication, isolation, immutable revision identity and bounded input handling foundational work.
3. Own the Atlas artifact/job/index/residency contracts, not a new IFC parser or geometry kernel.
4. Keep Three.js/Fragments/web-ifc and IfcOpenShell behind replaceable interfaces while evidence is gathered.
5. Use TypeScript for the UI, Python for semantic/AI services, and Rust only for proven hot paths.
6. Keep WebGL production-ready and treat WebGPU as a gated experiment.
7. Require parity, security, memory, latency and maintainability evidence at every subsystem migration.

No large implementation should begin until the Phase 0/1 decisions—security mode, stable identity, artifact contract, benchmark corpus and compatibility policy—are reviewed and approved.
