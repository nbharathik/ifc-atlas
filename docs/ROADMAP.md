# Roadmap after v0.1.1

The roadmap favors complete workflows over feature count.

## Viewer reference principles

Established BIM viewers reinforce a small set of dependable interactions:
measure and cut the model, filter by model data, save a view, and keep hidden
context available when needed. Dalux combines 2D/3D inspection, filtering,
properties, measurements, cuts, comments, and saved views; Trimble Connect
adds an especially useful ghosted-visibility mode. IFC Atlas will adopt those
interaction principles incrementally without copying product branding or
proprietary implementations.

- [Dalux BIM Viewer](https://www.dalux.com/en-gb/products/bim-viewer/)
- [Dalux 2D and 3D viewer functionality](https://www.dalux.com/en-ca/solutions/2d-and-3d-viewer-functionality/)
- [Trimble Connect visibility tools](https://help.trimble.com/doc/trimble-connect/trimble-connect/connect-for-browsers-3d-viewer/work-in-3d/visibility-tools)

## Near term

Phase 1 foundations completed in July 2026:

- Single-writer render-state coordination for user visibility, culling,
  opacity, base/AI/hover/selection appearance, and furnishing source masks.
- Persistent highlight/visibility state through navigation, latest-revision
  async ID translation, model-FINISH and painted-frame acknowledgements, and
  bounded teardown of model-bound work.
- Serialized shared-importer conversion plus exact-version, checksummed,
  atomically published server fragment artifacts. The browser rejects an
  incompatible fragment runtime before load and local cache keys include the
  converter/runtime/profile/coordinate compatibility identity.
- A Playwright/Chromium/WebGL harness for real IFC load, orbit percentiles,
  click-to-highlight, selection persistence, visibility workflows, zero-
  geometry frames, context loss, and hardware-qualified JSON evidence.

Phase 2 foundations implemented in July 2026:

- Restart-durable, checksummed real-AABB tile manifests and exact standalone
  fragment subsets with fail-closed ID/GUID/geometry/material parity.
- A screen-space-error tile/LOD planner with hysteresis, bounded requests,
  cancellation, retain-until-ready transitions, and LOD0-only exact picking.
- Stable live spatial visibility: geometry stays mounted, selected content is
  pinned, movement only reveals, and idle settle owns hides through one named
  coordinator mask. Client AABB culling remains the preprocessing fallback.
- Correct browser parse-profile application, truthful single-thread WebIFC
  prewarm/telemetry, balanced cache by default for new installs, idle-deferred
  metadata parsing, and a parkable on-demand rendering loop.

Phase 3 inspection foundations implemented on 15 July 2026:

- Construction measurement modes for distance, project-Y height, exact
  two-hit-triangle clearance, World-frame position, rectangle, polygon area,
  and angle. Exact triangle vertex/edge/midpoint/face-center snaps are shared by
  hover and click, with exact/guide provenance retained in labels and CSV.
- A durable absolute section workspace with latest-definition application,
  in-place section-box plane updates, exact multi-selection bounds, and a
  Viewer Tools action that fits the box to an isolated storey.
- Model-version-aware indexed property predicates with AND/OR, exists/missing,
  numeric/string/boolean operators, type/storey/property-set scope, browser-
  local named definitions, and independent `filter:*` colour layers plus
  paint/isolate/hide/frame actions.
- Guarded reuse of a fresh successful exact-hover hit for a same-state click;
  the exact fragment-worker raycast remains authoritative for every other pick.

Remaining viewer release work:

- The cold BasicHouse Chromium correctness gate passes through load, orbit,
  exact selection, persistent highlighting, visibility transitions, and
  restore with no zero-geometry/context-loss frame. Establish repeatable
  desktop-GPU performance baselines and extend the corpus to IFC4,
  repeated-component, MEP, and georeferenced fixtures; SwiftShader measurements
  remain correctness diagnostics rather than FPS/latency targets.
- Replace the initial monolithic scene mount with progressive tile residency,
  mount simplified tile payloads through the SSE planner, then add preprocessing
  instancing/batching and compressed buffers. Spatial culling and invalidation
  rendering remain opt-in until hardware-qualified baselines pass.
- Add context-restoration replay and a renderer visual assertion for combined
  selection color plus ghost opacity.
- Feed semantic/grid/MEP axes and explicit round primitives into the snap
  resolver; add object-set/BVH clearance and georeferenced project coordinates.
- Implement true GPU/tile-scoped coarse-to-exact picking, then qualify click and
  hover p50/p95/p99 on the large-model hardware corpus. Fresh-hover reuse alone
  is not a sub-80 ms guarantee.
- Add editable section-box faces, user-facing level cut-plane presets, cut
  exclusions, and saved-view/federated section transforms.
- Re-evaluate named filter definitions automatically on model revision and add
  project-shared definitions with permissions/provenance.
- Structural revision remounting stays beta and deliberately deferred while
  viewing performance and BIM inspection workflows remain the priority.
- Fragment-level geometry replacement so structural edits do not require a full
  viewer refresh.
- First-class add/remove property and property-set operations with schema-aware
  value types and previewable bulk edits.
- Classification and material assignment editors backed by bSDD discovery.
- Saved selection sets and property-based coloring presets.

The detailed evidence, target architecture, feature decisions, and six-phase
plan are in the [BIM viewer architecture and Dalux benchmark](architecture/BIM_VIEWER_DALUX_REVIEW.md).

## Later

- Model comparison with spatial/geometry change visualization.
- BCF issue assignment and shareable viewpoints across hosted projects.
- Federated multi-model loading and discipline controls.
- Clash-result visualization and exportable validation reports.
- Signed/notarized macOS packages and ARM64 release targets.

## Deliberately out of scope

IFC Atlas is not intended to replace a full parametric BIM authoring tool.
Constraint solvers, family editors, fabrication modeling, and general-purpose
solid modeling will not be pursued until the viewer, semantic workspace, and
exchange reliability are mature.
