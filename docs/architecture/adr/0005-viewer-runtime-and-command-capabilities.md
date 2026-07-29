# ADR 0005: Viewer runtime and command capabilities

- Status: Accepted
- Date: 2026-07-26
- Owners: viewer, rendering, application shell

## Context

ADR 0004 made `ViewerSession` the final engine owner, but renderer creation,
FragmentsManager boot, worker setup, DPR behavior, and model acknowledgement
still lived in one React effect. Selection and visibility integrations also
wrote store state independently. That made resource ownership difficult to
test and allowed new integrations to bypass the intended render-state
coordinator.

Replacing Three.js, Fragments, or web-ifc is outside this phase. The boundary
must preserve current geometry, rendering, load strategies, UI behavior, and
public refs.

## Decision

`ViewerSession.start()` starts one runtime once and gives its initializer only
the engine, cancellation signal, cleanup registration, and object-URL
ownership hooks.

The runtime is split by responsibility:

- `viewerRuntime.ts` owns browser renderer, world, camera, grid, context,
  invalidation, resize, and DPR resources;
- `fragmentRuntime.ts` owns FragmentsManager boot, worker URL lifetime, update
  serialization, and the active model acknowledgement target;
- `ViewerStateCapabilities` is the application command boundary for selection
  and visibility;
- `RenderStateCoordinator` remains the only engine-side compositor for
  selection, visibility, opacity, and culling state.

React composes these objects and retains the existing public `ViewerRefs`.
Do not add a general dependency-injection container or a second renderer
implementation.

## Consequences

Benefits:

- startup and shutdown resources share one deterministic owner;
- renderer and fragment worker details no longer dominate the React effect;
- model residency and worker acknowledgements are explicit;
- external bridge and viewpoint restoration use the same selection/visibility
  policy as canvas interaction;
- resource counters and repeat-disposal tests can detect lifecycle leaks.

Risks:

- `ViewerPanel` remains large because clipping, measurements, picking, LOD,
  culling, and view-helper behavior are not yet extracted;
- renderer setup callbacks still connect runtime events to application logs and
  render-state repair;
- incorrect cleanup ordering could cancel a scheduler before an in-flight
  coordinator mutation settles;
- software rendering can starve the browser metadata worker even after geometry
  is painted.

## Verification

- concurrent `start()` calls initialize once;
- repeated start/dispose cycles return cleanup, barrier, and object-URL counts
  to zero and dispose each engine exactly once;
- selection and visibility capability tests cover ordering, precedence,
  clearing, copying, and post-disposal no-ops;
- TypeScript, frontend unit tests, production build, bundle budget, and the
  hardware-backed BasicHouse renderer scenario pass;
- web-ifc, Fragments, Three.js/WebGL, artifact bytes, and API contracts remain
  unchanged.
