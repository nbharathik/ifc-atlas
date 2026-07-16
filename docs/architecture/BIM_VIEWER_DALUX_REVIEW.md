# BIM viewer architecture and Dalux benchmark

**Review date:** 14 July 2026
**Phase 1 implementation update:** 15 July 2026
**Phase 3 implementation checkpoint:** 15 July 2026
**Scope:** IFC Atlas `ifc-editor` branch at `cec7edc`, the public Dalux BIM
Viewer and Locations documentation, and the official Dalux video playlist
provided with the review request.

## Executive decision

IFC Atlas does not need a wholesale renderer rewrite to become materially
faster and more dependable. Its core direction is sound: convert IFC once,
cache a render-oriented fragment artifact, keep semantics in a separate index,
and let the browser own interaction. The highest-value work is to make that
pipeline deterministic and to stop independent asynchronous systems from
competing over the appearance of the same elements.

The current viewer already has a substantial BIM feature set: exact fragment
raycasting, persistent multi-selection and selection history, hide/isolate/
ghost, property and classification search, seven inspection modes, clipping
planes and a section box, saved viewpoints and share links, quantity takeoff,
IDS validation, BCF 2.1 topics, server-built fragments, progressive previews,
caches, performance instrumentation, and AI/MCP viewer commands. It also
already moved the property filter out of the bottom of the viewport and into
the docked **Tools** inspector.

The critical gaps at the start of the review were architectural:

1. Visibility, opacity, highlights, culling, proxy LOD, and furnishing merging
   were not one transactionally coordinated render-state system. Phase 1 now
   coordinates every normal appearance writer except experimental proxy LOD.
2. Durable highlighting sometimes cleared every highlight before repainting the
   desired layers. Named, diffed appearance layers now replace that path.
3. The large-model optimisation swaps between two whole-model roots instead of
   selecting LOD per spatial tile.
4. Structural IFC changes remount and rebuild the complete viewer.
5. At the start of this review, the conversion sidecar shared a mutable
   importer across concurrent requests without serializing the profile
   configure/process/restore transaction. This is now fixed by the first
   implementation slice described below.
6. Cache identities did not include every input that changes generated geometry.
   Server and browser artifact identities are now versioned and validated.
7. The application is still a single-model session and cannot yet federate
   disciplines or compare versions in one scene.
8. The UI has good individual panels but too many overlapping viewer controls,
   duplicated actions, and no coherent responsive/mobile workbench.

The Phase 1 implementation now provides the per-model render-state coordinator
recommended by this review. User masks, storey/element culling, focus/isolation
opacity, base coloring, AI results, hover, durable selection, and furnishing
source visibility publish independent named layers. Mutations are serialized,
superseded reads are discarded, intermediate generations are not presented,
every engine and application update is single-flight, worker/model completion
is correlated before the next run with a bounded event watchdog, and a commit
is acknowledged only after a paint boundary. The conversion sidecar also
serializes its shared importer and restores every profile-mutated setting.

The Phase 3 slice adds seven inspection modes, exact hit-triangle construction
snaps and clearance, durable absolute selection/storey sections, indexed named
AND/OR filters with independent result layers, and guarded reuse of a fresh
exact hover hit. It deliberately leaves true GPU/tile-scoped picking,
georeferenced coordinates, semantic axis/round-center snaps, and object-set
clearance for later qualification.

## Method and evidence boundaries

This comparison distinguishes three kinds of evidence:

- **Confirmed Dalux behavior** is stated in a current Dalux product or Help
  Center page, or visibly demonstrated in an official video.
- **Historical evidence** explains a direction but is not treated as proof of
  the current renderer.
- **Technical inference** describes an implementation consistent with the
  observed product, but not publicly disclosed by Dalux.

Dalux documentation mixes the free BIM Viewer with the common Locations
viewer and paid Box, Field, Design, InfraField, and FM workflows. This report
labels broader-platform features rather than presenting all of them as free
viewer capabilities. The supplied [official playlist](https://www.youtube.com/playlist?list=PL6h0TC8t9lowJLeUYR_xp6srCuE4nLuBC)
contains material from several product generations; current Help Center pages
take precedence when behavior or product scope differs.

The IFC Atlas findings are static-code findings plus the repository's existing
tests and documentation. The repository has no browser/WebGL end-to-end suite,
so visual stability and large-model FPS claims still require the performance
corpus defined later in this report.

## What Dalux publicly confirms

### Product, formats, and construction workflows

The current [Dalux BIM Viewer product page](https://www.dalux.com/de/produkte/bim-viewer/)
confirms native BIM/IFC, DWG, and PDF use, desktop and mobile access, automatic
federation, 2D/3D viewing, measurements, cuts, property filters, saved views,
properties, comments, and native-authoring integrations. Its [plugin catalogue](https://support.dalux.com/hc/en-us/articles/4406605418898-Download-plugins)
lists Revit, Archicad, Tekla, Navisworks, and Solibri integrations.

This is not simply a format list. Dalux organizes the viewer around recurring
construction tasks:

- find the building, level, drawing, room, discipline, or issue;
- orient in a synchronized drawing/model view;
- inspect an object's properties and surrounding construction;
- measure or cut without leaving that context;
- save or share the complete visual state;
- create, assign, discuss, and close a spatially anchored issue;
- carry prepared information to the field, including offline.

The broader [2D/3D viewer capability page](https://www.dalux.com/en-gb/solutions/2d-and-3d-viewer-functionality/)
also describes point-cloud context, parameter and room coloring, measurable
gridlines, box/section/level cuts, model comparison, and model checks. Some of
those features belong to paid Dalux products. InfraField additionally supports
infrastructure, terrain, point-cloud, alignment, and GIS formats; those should
not be attributed to the free building viewer. Dalux's [InfraField format list](https://support.dalux.com/hc/en-us/articles/25788124423452-Supported-data-formats-in-InfraField)
is the relevant scoped source.

The general Dalux viewer does not publish a definitive IFC schema-version
matrix. IFC 4.3 is explicitly documented for InfraField alignment data, not as
a blanket statement about every building-viewer workflow.

### Ingestion, conversion, and federation

Dalux confirms an upload-then-process workflow. An IFC is assigned metadata
and discipline, processed, associated with model levels, and used to create
automatic level cuts; 2D drawings are mapped with reference points. Some
changes, such as enabling model grids, trigger reprocessing. See the [IFC and
drawing upload guide](https://support.dalux.com/hc/en-us/articles/360003051733-Upload-IFC-model-files-and-2D-drawings).

Native plugins move useful preprocessing even earlier. The [Revit plugin guide](https://support.dalux.com/hc/en-us/articles/12810560583580-How-to-upload-3D-models-and-drawings-using-the-Revit-plugin)
states that it does not upload the raw `.rvt`; it exports a Dalux-specific
`.daluxbim` package and includes objects visible in the selected 3D view.
Level, discipline, property, and room choices are part of that export flow.
Archicad, Tekla, and Navisworks have similarly scoped exports.

Federation is confirmed, but correct alignment still depends on common model
coordinates. Dalux's [survey-point guidance](https://support.dalux.com/hc/en-us/articles/4413638221340-Revit-Survey-Point)
requires participating models to use the same coordinate relationship. This
is a useful product lesson: federation needs an explicit coordinate contract,
not just a UI that loads two files.

Dalux Desktop can compare two versions of the same 3D model and list added,
removed, geometry-changed, and property-changed objects, with result filtering
and synchronized inspection. The [version-comparison guide](https://support.dalux.com/hc/en-us/articles/10022982079004-Compare-versions)
scopes 3D comparison to the desktop application and the wider Dalux workflow;
it should not be described as a universal free-web-viewer feature.

### Measurements and inspection

The current [Dalux cut and measure guide](https://support.dalux.com/hc/en-us/articles/4405303854866-How-to-cut-and-measure)
confirms the following:

- 3D point-to-point distance;
- movable 3-axis laser measurement;
- center measurement for round objects;
- shortest distance between two objects in Dalux Desktop;
- coordinate/position marking;
- multiple simultaneous measurements, editing, undo, and repeat-last-tool;
- planar section measurement that snaps to intersected construction and grids;
- 2D chained distance, angle to baseline, polygon/rectangle area and perimeter,
  laser distances, and corner/90-degree snapping.

A general 3D angle tool and arbitrary 3D mesh-volume measurement are not
documented as free-viewer tools. Terrain cut/fill volume is an InfraField
Quantities workflow. Vertex, edge, face, axis, and BIM reference snaps are not
documented as five general-purpose snap modes; only the task-specific snapping
above is confirmed.

### Selection, cuts, filters, hierarchy, and saved context

Object selection shows grouped BIM property sets and exposes contextual
actions. A property can be turned into a filter criterion. Mobile selection
offers hide, measure, cut, property, and registration actions. Dalux does not
publicly specify a current GPU picking implementation, highlight render pass,
or selection-persistence algorithm. See [BIM properties](https://support.dalux.com/hc/en-us/articles/5794445568924-BIM-properties)
and [mobile navigation](https://support.dalux.com/hc/en-us/articles/360010386193-Navigate-in-Locations-on-mobile).

Confirmed cutting includes horizontal or vertical cuts derived from a surface,
multiple cut planes, a box cut, level-driven 3D sections, a planar 2D cut, and
the option to ignore a category or model file. Dalux bookmarks retain camera,
filters, measurements, and cuts, as documented in [2D/3D bookmarks](https://support.dalux.com/hc/en-us/articles/4404736328850-2D-and-3D-bookmarks-in-Locations).

Dalux [filters and visualization](https://support.dalux.com/hc/en-us/articles/15419725830556-Filters-and-visualization-in-Locations)
support free text, quick and advanced property criteria, multiple predicates,
file/category scope, saved personal or shared filters, automatic update after
model revisions, colorization, and 2D overlay use. Product tier and permission
control which sharing scopes and color functions are available.

The primary public hierarchy is location-oriented rather than a raw IFC entity
graph:

`project -> building -> level -> discipline -> drawing or automatic cut`

That is excellent for site and coordination work. IFC Atlas should retain its
deeper IFC tree for authoring and audit users, while adding a location-first
navigation mode instead of copying Dalux's hierarchy wholesale.

### Navigation, desktop/mobile, collaboration, and offline

Dalux exposes four clear modes: 3D, drawing, split drawing/3D, and 3D section.
Its [desktop navigation guide](https://support.dalux.com/hc/en-us/articles/15489351313052-Navigate-in-Locations-on-desktop)
documents orbit, pan, zoom, and synchronized split navigation. A drawing click
can position the 3D camera, while the plan shows camera location and direction.
Dalux recommends its desktop app for complex models because it can use more
local graphics resources than the browser.

Mobile uses a field-specific touch model and defaults toward drawing/model
orientation rather than merely shrinking the desktop interface. Offline is an
explicit preparation workflow: users select buildings, drawings, and offline
3D models; registrations go to an outbox and synchronize later. See [Dalux
offline mode](https://support.dalux.com/hc/en-us/articles/28263982197276-Use-Dalux-mobile-app-in-offline-mode).

Dalux comments can store a screenshot, viewpoint, filters, colorization, cuts,
and measurements. They support assignment, status, history, responses, and 2D
markup. See [Dalux comments](https://support.dalux.com/hc/en-us/articles/12727090183708-How-to-use-Comments).
The [Navisworks plugin](https://support.dalux.com/hc/en-us/articles/17354669716636-How-to-setup-the-Navisworks-plugin)
also supports clash/comment exchange and BCF-oriented coordination. Formal
tasks, inspections, checklists, and field registrations are adjacent product
workflows, not evidence that IFC Atlas should become a complete field
management suite.

### Large-model performance: facts and assumptions

Dalux publicly claims that its viewer can display more than one million visible
BIM objects on desktop and mobile. The official playlist includes a [large
model demonstration](https://www.youtube.com/watch?v=Mtm3z6-UYPg) and a
[one-million-object demonstration](https://www.youtube.com/watch?v=iyPFmg1Vyco).
This is a marketing capability claim, not a reproducible benchmark: hardware,
triangle count, draw calls, memory, visual error, and frame-time percentiles
are not supplied.

Dalux also confirms that it develops graphics technology in house, processes
uploads, produces prepared native packages, provides explicit offline 3D
downloads, and benefits from native desktop graphics resources. Those facts
support three high-confidence conclusions:

1. Authoring semantics and runtime render data are separated during ingestion.
2. Semantic object identity is mapped onto a compact viewer representation.
3. Expensive authoring-format parsing and tessellation are normally removed
   from interactive viewing.

The following current implementation details are **not publicly confirmed**:

- triangle simplification algorithm or error metric;
- number or shape of runtime LODs;
- screen-space-error selection or navigation-only proxy geometry;
- mesh merge, instancing, or material grouping rules;
- quantization, mesh compression, or buffer layout;
- octree, BVH, grid, frustum, or occlusion-culling implementation;
- GPU ID-buffer picking;
- worker topology, progressive chunk size, or cache eviction policy;
- whether filtered geometry stays GPU-resident;
- highlight or outline rendering design.

The safe inference is that Dalux's outcomes are consistent with aggressive
preprocessing, batching, spatial visibility evaluation, caching, and possibly
LOD and instancing. IFC Atlas should reproduce the measurable outcomes, not
claim or imitate undisclosed algorithms.

## Capability comparison

| Area | IFC Atlas today | Dalux public behavior | Decision for IFC Atlas |
|---|---|---|---|
| Primary inputs | `.ifc`; IFC2X3/IFC4 primary, IFC4X3 best effort | IFC, DWG, PDF, native-plugin packages; more formats in scoped products | Keep IFC authoritative now. Add federated IFC first; add 2D PDF/DWG through a separate drawing pipeline, not through the IFC renderer. |
| Conversion | Server sidecar builds fragments; browser worker fallback; disk and optional IndexedDB caches | Upload/native export followed by processing into viewer data | Same strategic direction. Harden concurrency, artifact identity, validation, and progressive spatial output. |
| Semantics/render split | Python/IfcOpenShell plus native metadata index; browser fragment geometry | Confirmed outcome, proprietary details | Preserve and formalize a versioned semantic-to-render ID table in every artifact. |
| Large-model strategy | Full fragments, optional preview, capped AABB cullers, and a whole-model decimated proxy during motion | Very high capacity claimed; internals undisclosed | Replace whole-model proxy swapping with spatial tile LOD and culling masks. Benchmark before enabling optimizations by default. |
| Selection | Exact fragment-worker raycast, hover, multi-select, history, native highlight | Object selection/properties and contextual actions; internals undisclosed | IFC Atlas already has useful advantages. Add coarse GPU/tile pick and persistent layered appearance. |
| Measurements | Linear, height, hit-triangle clearance, position, planar box, polygon area/perimeter, and 3D angle; exact vertex/edge/midpoint/face-center and prior-endpoint snaps; provenance labels/CSV | Strong 2D tools; 3D point, center, laser, 3-axis laser, shortest distance, position | Extend the shipped construction tools with semantic/grid axes, explicit round centers, and object-set/BVH clearance before volume. |
| Sections | Multiple planes, surface-aligned plane, durable absolute section box, multi-selection/storey fit | Multiple surface-derived cuts, box/level/2D cuts, ignore category/file, saved state | Add a true editable box gizmo, level plane presets in the UI, cut exclusions, and saved-view round-trip. |
| Filters | Indexed AND/OR property filters, named browser-local definitions, type/storey/pset scope, independent color layers, paint/isolate/hide/frame actions | Multi-predicate saved/shared property filters, file/category scope, coloring and drawing overlays | Move the shipped filter editor into the first-class Navigator workflow, re-evaluate definitions on model revision, then add shared/project filters. |
| Hierarchy | Deep spatial IFC tree, classification, storey controls; virtualized large tree | Location/drawing-first hierarchy | Offer both Location and IFC Structure views. Do not remove raw IFC relationships. |
| Views/share | Named viewpoints, thumbnails, screenshots, URL state | Bookmarks and links retain camera, filters, measures, and cuts | Extend current viewpoint schema to include all owned appearance layers and measurements. |
| Issues | BCF 2.1 topics, status, priority, assignment, comments, snapshots, import/export | Rich comments, markup, tasks and clash workflows | Deepen BCF/view integration; do not build generic workforce/task management now. |
| Federation | One active fragment model/session | Automatic multi-discipline federation using shared coordinates | Introduce a model-session registry and coordinate/alignment contract. High value, but after state stability. |
| Comparison | Semantic timeline/diff support, no two-version render overlay | Desktop 3D version comparison; broader drawing comparison | Add semantic diff first, then spatial/geometry overlay using the multi-model registry. |
| 2D/3D | 3D-centric; no mapped drawing/model split | Drawing, 3D, split, and section modes | High construction value, but depends on a drawing model and mapping metadata. Implement after federation foundation. |
| Offline/mobile | Web/Tauri caches, no explicit project download/outbox workflow | Explicit offline mobile packages and synchronization | Add desktop offline package/cache management first. Native field mobile is later and should have purpose-built touch UX. |
| AI | Model-aware agents, viewer commands, IDS/QTO/audit/edit tools, MCP, staged writes | Public AI assistant is primarily single-document Q&A | This is IFC Atlas's strongest differentiator. Convert AI results into deterministic filters, layers, sections, views, and reports with provenance. |

## Current IFC Atlas architecture

### Load and render path

```text
IFC file
  |
  +--> FastAPI upload ------------------> authoritative IFC / IfcOpenShell
  |       |                                  metadata, tree, properties, QTO
  |       +--> native metadata/AABB jobs
  |       +--> Node fragment sidecar ------> versioned .frag cache (partial today)
  |                                               |
  +--> cached fragment manifest / convert response+
  |                                               v
  +--> browser web-ifc worker fallback --> FragmentsManager.load
                                                  |
                                                  v
                                         FragmentsModel + ModelService
                                                  |
                            Three.js world, camera, overlays, Zustand state
```

This split is appropriate. It lets the browser remain responsive to camera and
selection work while Python owns authoritative IFC semantics. Server conversion
and caching avoid repeating WASM parse/tessellation on every open. The browser
fallback preserves portability.

The complication is that `ViewerPanel.tsx` now contains about 7,100 lines and
owns most lifecycle, load, scene, picking, measurement, selection, appearance,
culling, LOD, performance, and bridge behavior. `useStore.ts` is about 2,000
lines and includes both current and legacy layout modes. The system has many
good isolated helpers, but the integration point is too coupled to enforce one
ordering contract across all asynchronous render mutations.

### Scene contents and memory

Depending on load phase and preferences, the same model can be represented by:

- the full Fragments model;
- a temporary native or per-storey preview;
- a decimated whole-model LOD proxy;
- an optional merged furnishing mesh;
- highlight/measurement/clip/helper overlays;
- IFC input bytes, fragment response bytes, semantic indexes, and CPU-side
  mappings in addition to GPU buffers.

Those copies do not all remain forever, but their overlap raises peak memory.
The desktop open-file path reads the IFC in Rust, transfers it through Tauri
IPC, wraps it as a browser `File`, and then follows the web upload path. Large
files can therefore exist several times across Rust, WebView, HTTP, worker, and
fragment buffers. A trusted desktop path-to-backend handoff or streaming local
file endpoint would remove an avoidable copy chain.

### Stable parts worth preserving

- Normal hide/isolate uses fragment `setVisible` rather than destroying meshes.
- Camera and selection live in application state rather than only in Three.js.
- The element tree is indexed and windowed for large models.
- Hover raycasting has in-flight/replay protection.
- The renderer records TTFR, TTFG, click latency, draw calls, triangles, and
  frame statistics.
- Server fragment prebuild, manifests, disk cache, progress, browser fallback,
  and service-worker WASM caching provide a solid load foundation.
- AI operations already call viewer actions rather than existing only as an
  unrelated chat window.

## Why the viewer slows down, flickers, or loses appearance

### 1. Async visibility and opacity operations could finish out of order

`ViewerPanel.tsx` reconciles isolate, hide, user ghost mode, and focused-
selection ghosting through multiple awaited `FragmentsModel` calls. The old
frame scheduler coalesced synchronous store changes, but marked the frame free
before its asynchronous callback completed. A change on the next frame could
therefore start a second worker mutation. If the older request completed last,
the rendered scene briefly or permanently reflected stale state.

This directly explains intermittent disappear/reappear behavior and ghost
opacity that does not match the latest UI. The review's first code change adds
a latest-state, single-flight scheduler to these two paths. It prevents overlap
inside each path and discards intermediate snapshots. Remaining writers - user
visibility versus culling, highlight composition, LOD, and furnishing state -
still need the shared coordinator described below.

### 2. Highlight rebuilds use a reset-first operation

Durable highlight composition can call `resetHighlight(undefined)` and then
sequentially repaint color groups, tool/AI layers, and selection. Between reset
and repaint there is a real frame in which selection has disappeared. A newer
generation can cancel the repaint after the reset, but cannot undo the already
visible gap. Hover also performs fire-and-forget reset/highlight calls.

The cost of changing one selection can therefore scale with every active color
layer. The correct model is a per-source appearance compositor that computes
the effective material for each changed ID and diffs previous versus next
state. Selection should never be cleared globally in order to update another
layer.

### 3. Whole-model LOD is a scene swap, not spatial LOD

The current large-model feature holds a full model and decimated proxy, then
toggles their root `visible` flags during and after navigation. Exact picking
temporarily restores full geometry. Selection, hide/isolate, color, opacity,
and furnishing state can disable the proxy. These conditions make click,
navigation, and appearance changes trigger a whole-scene representation swap.

Consequences include visible popping, inconsistent silhouettes, double
resident geometry, and a sudden full-detail cost when a user interacts. It is
better than deleting the model, but it cannot provide stable per-element
appearance. Keep it experimental until spatial-tile LOD replaces it.

There is a second, separate LOD path inside `@thatopen/fragments`: the
worker's `LodMode.DEFAULT` screen-coverage classifier can degrade small/far
objects to wire bounds or cull them as the camera moves, which reads as
objects popping in and out with distance. Since 16 July 2026 small AND medium
models (below 20,000 elements) pin `ALL_VISIBLE`, so every element stays
resident and drawable at any camera distance or angle; the measured
navigation-time benefit of the classifier on this model class was within
noise while its visual instability was the single most reported viewer
complaint. Large models keep `DEFAULT` with graphics quality pinned to its
idle value (a navigation-time drop widened the cull bands without improving
FPS) until per-tile error-bounded LOD replaces the classifier; there,
selected, measured, issue-linked, or explicitly forced-visible objects should
be exempt from coverage culling, and thresholds need hysteresis and a visible
diagnostic in performance mode.

### 4. Optional furnishing merge creates an interactive replacement gap

The furnishing optimiser transforms and merges source vertices on the main UI
thread, hides the source fragments, and adds one unpickable, flat-material
mesh. Disposal removes the merged mesh before the original fragments have
necessarily finished restoring. Exact picking suspends the replacement.

This is disabled by default and should remain so. Repeated components should
be recognized and instanced during preprocessing. Material/storey/region
batching should also produce stable pick mappings before the model reaches the
viewer.

### 5. Culling mutates the same semantic visibility channel as the user

Storey and element cullers call `setVisible` on fragment IDs, just as hide and
isolate do. The code defines precedence and sequences storey before element
culling, which is a good mitigation. However, runtime visibility is still
represented by the same state mutation used for user intent. A culler tick
that overlaps another writer can re-show an object the user meant to hide, or
leave culler bookkeeping inconsistent.

The element culler covers at most 1,500 elements and the storey culler at most
5,000. Both may derive AABBs by walking geometry arrays, then exchange batches
of asynchronous worker visibility requests. This is incomplete for realistic
large models and can consume the CPU time it is intended to save. Both are off
by default; leave them opt-in until culling uses a separate runtime mask and a
persisted spatial index.

### 6. Structural edits remount the complete viewer

`App.tsx` keys `ViewerPanel` by the load timestamp. A structural edit fetches a
complete replacement IFC, changes that key, and the cleanup path disposes the
fragment model, world, renderer services, cullers, and helpers. Camera and
application state can be restored after the new model loads, but the geometry
cannot remain continuously visible during the transition.

Use a staged model session: build the replacement off-screen, transfer
semantic state, render and validate its first frame, atomically switch roots,
then dispose the previous session. Longer term, apply fragment-level deltas for
bounded structural changes and use the full staged swap only when necessary.

### 7. Picking is exact but not constant-time

Element selection correctly uses `FragmentsModel.raycast()` so compressed
fragment IDs resolve accurately. That is an asynchronous worker raycast, not a
GPU object-ID buffer. `three-mesh-bvh` accelerates scene-native helper meshes,
not the fragment worker's internal element raycast. ID bridge misses can add
worker batches, and exact picking may force full geometry when the proxy is
active.

This explains why click or hover latency degrades with large scenes even when
orbit FPS seems acceptable. Use a tile/GPU coarse pick, shortlist candidate
objects through the spatial index, and retain the exact worker raycast only as
the final precision step.

### 8. Render and update work continues during interaction

Postproduction antialiasing, logarithmic depth, the orientation-helper pass,
measurement/label overlays, fragment camera updates, performance sampling, and
React/store updates all compete for main-thread and GPU time. Render-on-demand
is optional, and its current mode still maintains a lightweight animation-frame
loop. Logarithmic depth is useful for extreme coordinate ranges but should not
be unconditional.

The 7,100-line viewer integration increases the chance that a state change
invalidates more work than intended. Split it into explicit services with
small subscriptions: `ModelSession`, `RenderStateCoordinator`, `PickingService`,
`MeasurementService`, `NavigationService`, `LoadController`, and `ViewportHud`.

The production build also shows a large delivery/compile surface: the shared
viewer-engine chunk is about 6.74 MB minified (1.29 MB gzip), while metadata and
IFC-conversion worker assets are several megabytes each. Lazy loading prevents
all UI panels from blocking first paint, but JavaScript/WASM download, compile,
and worker startup remain part of cold-load performance. Record these stages
separately and code-split optional editing, postproduction, and analysis paths
where library boundaries allow; do not treat gzip size as GPU-memory usage.

### 9. Conversion and cache nondeterminism can look like renderer loss

At the audit baseline, the Node sidecar reused one mutable importer while its
HTTP server accepted concurrent requests. Profile-specific settings were
mutated around conversion, and not every setting was restored. Two simultaneous
profiles could therefore interleave, while a later conversion could inherit
settings from an earlier one. Missing geometry produced there would appear to
the user as a viewer rendering failure.

This review implements a process-local FIFO executor around the complete
importer transaction and snapshots/restores all mutated settings, nested maps,
flags, classes, relations, and excluded attributes. It deliberately trades
parallel conversion throughput for deterministic geometry. A future bounded
worker pool can restore concurrency by owning one importer per worker.

Fragment cache identity is mostly IFC fingerprint plus profile name. It should
also include normalized profile content, converter/fragment format versions,
`@thatopen` and web-ifc versions, coordinate policy, and excluded categories.
LOD cache identity must include ratio/error inputs. Writes should validate into
a temporary file and atomically rename it.

### 10. Single-model identity limits every federated workflow

The viewer has one active fragment model, one semantic bridge, and one model
identity in most state. Adding another root without a session registry would
make element IDs, visibility, selection, clipping, filters, and cache identity
ambiguous. Federation is an architectural feature, not a loop around the
current load function.

## Stable-geometry target architecture

### Non-negotiable invariant

Once a render artifact is accepted into a live model session, normal camera,
selection, filter, hide/isolate, ghost, measurement, clipping, and highlight
operations must not destroy or rebuild its geometry. They may change masks,
materials, instance attributes, LOD residency, and render passes. Geometry may
be replaced only for a model revision, memory eviction, context recovery, or a
validated LOD/tile transition, and that replacement must be atomic from the
user's perspective.

### Proposed services

```text
                 Zustand / viewer intents / AI commands
                               |
                               v
                    RenderStateCoordinator
                 desired generation -> effective state
                    /          |          \
                   v           v           v
          VisibilityMask   Appearance   Clip/section
          user/filter/     compositor   state
          discipline/cull  by source
                   \           |          /
                    \          v         /
                     +-- one worker mutation queue --+
                                      |
                                      v
                              confirmed generation
                                      |
                                      v
                                rendered-frame ack

 ModelSessionRegistry
   model id -> immutable geometry repository, transform, spatial index,
               semantic ID map, cache/artifact metadata, residency state
```

The visibility calculation should keep independent masks:

```text
effectiveVisible(id) =
  modelEnabled
  AND userVisible
  AND filterVisible
  AND disciplineVisible
  AND storeyVisible
  AND tileResident
  AND runtimeFrustumVisible
```

Ghosting is not visibility. It is an appearance rule applied to the complement
of the focus set. Selection is not a filter. It is the highest-priority durable
appearance layer. Culling is not user intent. It is a reversible runtime mask
that must never change the saved hide/isolate state.

### Appearance precedence

Use named, independently clearable sources, for example:

1. selection;
2. hover;
3. active issue or validation result;
4. AI/tool result layer;
5. filter/analysis color layer;
6. ghost/transparency;
7. source material.

Each layer owns a stable ID, label, legend, source, and element set. The
compositor diffs the effective style of only changed IDs. Removing a filter
must remove that filter's layer without erasing an AI result or the user's
selection.

### Spatial artifacts and LOD

Preprocessing should emit immutable spatial tiles, not one monolithic proxy:

- tile bounds and hierarchy;
- stable local ID to application element key mapping;
- material batches and instance groups;
- LOD0 exact geometry plus one or two error-bounded coarser representations;
- compressed/quantized vertex and index buffers;
- semantic index references and per-element bounds;
- artifact version, source fingerprint, normalized settings hash, checksums.

At runtime, choose per-tile detail from projected error and motion state. During
navigation, lower the error target gradually; after the camera settles, refine
visible tiles without hiding the old tile until the replacement is ready. A
tile's semantic IDs and appearance masks do not change between LODs.

Frustum culling belongs at tile/batch/instance level. Hardware occlusion
queries or hierarchical-Z culling are later optimizations and should be added
only when measurements show overdraw - not as a substitute for batching and
spatial LOD.

## BIM interaction priorities

### Implement now

- Persistent layered selection/highlighting and source-specific result layers.
- Indexed, named, multi-predicate filters with hide/isolate/ghost/color actions.
- Perpendicular/shortest distance, vertical height, position/coordinate, edge,
  midpoint, axis, face-center, and round-object center snapping.
- Stable section planes and section box bounds, storey/level cut presets, and
  ignored category/model masks.
- Saved views that serialize the complete state: camera/projection, model
  enablement, filters, visibility, colors, cuts, measurements, and active issue.
- Keyboard, mouse, and touch action parity for select, multi-select, context,
  hide, isolate, frame, and clear.

### Implement after the stable model-session foundation

- Federated model registry with discipline enablement, common coordinates,
  transforms, alignment review, and per-model unloading.
- Version comparison using semantic mapping first, then geometry/property
  overlays and synchronized lists.
- Mapped drawing model and Dalux-like 2D/3D split navigation.
- Explicit offline project packages, cache status, integrity checks, and sync
  outbox if collaborative writes become remote.
- Camera walkthrough/first-person mode after collision, input, and accessibility
  requirements are defined.

### Do not implement merely because Dalux has it

- A generic field workforce/task-management suite. Keep BCF and viewer context
  integration strong; integrate with external task systems when needed.
- Raw mesh volume measurement presented as authoritative quantity. Prefer IFC
  quantities and label provenance; add geometric volume only for validated
  closed solids with an explicit approximation warning.
- A WebGPU rewrite before the WebGL frame, draw-call, and memory bottlenecks are
  measured and the fragment stack has a supported migration path.
- Always-on occlusion culling before tile batching and spatial indices exist.
- A full native mobile client that copies desktop UI. Prove a small field
  workflow and offline package first.
- Unrestricted AI-generated code with direct access to Three.js or fragment
  internals.

## UI and UX direction

### Current-state conclusion

The requested bottom filter removal is already complete in the current branch.
`FeatureLauncherPanel` mounts **Element filter** inside the right-hand Tools tab;
the bottom-center viewer row contains framing/visibility controls and a
conditional ghost toggle, not the old Dalux-style filter bar. Do not re-add a
bottom filter. The next improvement is to move filtering from a generic Tools
catalog into the left navigation/finding workflow.

The current three-column shell is a strong starting point, but actions are
duplicated across the top bar, viewer tools, floating measurement UI, bottom
navigation, context menu, status bar, and command palette. Independent overlays
can collide. The fixed 244 px left and 288 px right columns have weak narrow-
screen behavior. Some state is duplicated - for example, storey UI state can
drift from isolation state - and filter, AI, classification, and search results
share one highlight set.

### Proposed BIM workbench

```text
[File Edit View Review Help] [model / schema / load phase] [Command search]
[Explore] [Measure] [Section] [Review]       [camera] [projection] [settings]

+-------------------+-------------------------------+--------------------+
| Navigator         | Viewport                      | Inspector          |
| Tree | Filters    |                               | Properties         |
| Search | Classes  | context breadcrumb            | Selection actions  |
|                   |                               | Issues / Results   |
| location/storeys  | one HUD lane per edge/corner  | Views              |
| virtualized tree  |                               | Contextual AI      |
+-------------------+-------------------------------+--------------------+
[load phase | model/tile residency | selected/hidden | FPS/diagnostics]
```

Design rules:

- **Left means find and navigate.** Tree, location, search, storey, type,
  system, classification, discipline, and property filters belong together.
- **Right means understand and act.** Keep selected identity sticky above
  Properties, Issues, Results, Views, and contextual AI actions.
- **Modes reveal tools.** Explore, Measure, Section, and Review are mutually
  exclusive work modes. The active mode owns its compact contextual toolbar.
- **The viewport stays dominant.** Assign top-left, top-right, bottom-left, and
  bottom-center HUD lanes; no component positions itself without a lane.
- **State is visible.** Compact chips show active filters, hidden count, ghost,
  section count, model/discipline scope, and offline/cache state. Each chip has
  a clear action.
- **Selection is contextual.** Frame, hide, isolate, ghost others, measure,
  section-to, add issue, and explain properties appear beside selection - not in
  several permanent toolbars.
- **Touch is designed, not scaled.** Use 44 px targets, long-press context,
  bottom sheets for properties/actions, and a default location/split workflow.
- **Keep Atlas's visual identity.** Blue remains focus/action, amber remains
  selection, and monospace is reserved for IDs, coordinates, dimensions, and
  counts.

### Specific UI fixes

1. Add a first-class **Filters** pane beside Tree/Search and persist filter
   definitions. Keep advanced predicates collapsible.
2. Remove state mutations during `ViewerToolsPanel` render; derive active
   storey from the visibility model.
3. Expose all four existing measurement modes in one place. The viewer tray
   currently advertises fewer modes than the floating measurement toolbar.
4. Add retry, open-another-model, and copy-diagnostics actions to load errors.
   A renderer error boundary must not silently leave a blank center.
5. Use one load state machine - reading, hashing, upload, preprocessing,
   downloading, GPU upload, ready - across overlay and status bar.
6. Consolidate shortcut definitions into one command registry that generates
   handlers, menus, palette entries, tooltips, and help documentation.
7. Preserve local tree/search/filter scroll and expansion state when switching
   panes.
8. Add responsive tiers: desktop three-column; compact desktop one dock at a
   time; tablet drawer/bottom sheet; mobile purpose-built inspect workflow.
9. Move “simplify furnishings” and similar implementation toggles to an
   Advanced Performance section until they are safe and user-centered.
10. Remove dead bottom-toolbar components and legacy stacked-panel mode only
    after import and preference migration tests prove they are unused.

## AI-native advantage

IFC Atlas already has an architectural advantage over a document-only AI
assistant: its agents and MCP clients can select, isolate, highlight, set the
camera, capture the viewport, create section boxes, and color element groups.
Its editing path can stage and verify IFC mutations. The next step is to turn
AI output into durable viewer artifacts instead of transient global state.

Dalux's current public [AI Assistant documentation](https://support.dalux.com/hc/en-us/articles/19728327500060-AI-Assistant)
describes summary and question answering over one PDF or DOCX at a time, with
PDF citations, and explicitly limits cross-folder/project/document/version
search. It does not document BIM-semantic query or model manipulation. That is
a meaningful differentiation opportunity, not evidence that every IFC Atlas
workflow needs a chat surface.

### Recommended interaction contract

```text
Natural-language request
  -> typed query/intent plan with model scope and provenance
  -> deterministic preview (predicate, count, sample, estimated cost)
  -> user accepts or adjusts
  -> named filter / result layer / section / view / measurement / report
  -> render-state acknowledgement and optional saved artifact
```

High-value examples:

- “Show external walls on levels 2-5 with no fire rating” compiles to a named
  predicate, previews the count, and creates a durable filter layer.
- “Give me the shortest clear distance between this duct and nearby structure”
  runs a bounded spatial query and creates a measurement with source objects.
- “Prepare a view for the fire-stopping review” creates storey/discipline
  filters, a section, colors, and a saved viewpoint that the user can inspect.
- “Explain this property” cites the IFC schema/property-set source and the
  element's actual value; it does not invent a project rule.
- “Find inconsistent type properties” produces a sortable issue/result set,
  not only prose.
- “Compare this revision with last Friday” produces semantic and geometry
  change layers after the multi-model/version foundation exists.

Required safeguards:

- Viewer commands are typed, versioned, scoped to model/session IDs, and
  idempotent.
- Every result owns a separate appearance layer and clear action.
- Geometry/property writes remain previewed and user-approved.
- Generated analysis extensions return typed data or viewer intents; they do
  not mutate renderer internals.
- Tool completion is acknowledged only after the desired render generation has
  been applied, not immediately after Zustand dispatch.
- Quantities and measurements carry provenance: IFC quantity, geometric
  calculation, approximation, units, and assumptions.

## Prioritized implementation plan

Effort uses **S** (days), **M** (one to three focused iterations), **L**
(multi-iteration architectural work), and **XL** (program-level capability).
“Now” means the next stabilization releases; “Later” means after its named
dependencies; “No” means do not pursue under the current product goals.

### Phase 1 - rendering stability and critical performance

| Change | Problem and main use case | Expected benefit | Recommended implementation and architecture | Effort | Risks, trade-offs, dependencies | Required tests | Decision |
|---|---|---|---|---|---|---|---|
| Single `RenderStateCoordinator` | Async visibility, opacity, culling, and tool state can race; users rapidly hide/isolate/ghost while navigating | Deterministic final state, no stale worker completion, persistent camera/selection | Extend the new latest-state single-flight scheduler into a per-model coordinator with monotonically increasing generations, independent masks, one worker mutation queue, cancellation at boundaries, and rendered-frame acknowledgement | L | Requires migrating writers incrementally; an overly broad first rewrite could regress features | Rapid toggle/orbit stress test, state-generation unit tests, final GPU-visible set assertion, context-loss recovery | **Implemented in Phase 1; real renderer release gate remains** |
| Layered appearance compositor | Reset-first highlight causes visible gaps and tools overwrite one global highlight set | Stable selection/highlight and cheap incremental updates | Store source-specific named layers; compute precedence; diff effective material/opacity per changed ID; never global-reset before replacement; persist semantic selection through swaps | L | Fragment highlight API may constrain batch/material combinations; needs coordinator | Selection while orbiting, overlapping filter/AI/issue layers, clear-one-layer test, 10k-ID benchmark | **Implemented in Phase 1; visual material assertion remains** |
| Atomic model revision swap and fragment deltas | Structural edits dispose the live viewer, blanking geometry and risking state loss | Old scene remains usable until replacement is ready; smaller edits become near-instant | Add `ModelSession`; stage replacement root off-screen, transfer camera/visibility/appearance/clip state, validate first frame, atomically swap; wire fragment deltas for bounded edits | L | Temporary double memory during staged swap; delta ID stability is mandatory | Structural edit with continuous orbit, camera/selection preservation, failed replacement rollback, GPU leak checks | **Deferred; structural editing remains beta and is not the current viewer focus** |
| Serialize/reset sidecar conversion | Shared mutable importer can interleave profiles and generate inconsistent geometry | Deterministic fragments and fewer “missing object” failures | Smallest fix: one conversion queue around importer. Preferred follow-up: bounded worker pool with one importer per worker and immutable per-job configuration | S then M | Serial queue lowers concurrent throughput; pool uses more memory | Simultaneous mixed-profile hash determinism, failure recovery, queued progress/cancel behavior | **Serialized queue implemented; worker pool later if throughput requires it** |
| Versioned atomic caches | Incomplete keys can serve stale/profile-incompatible geometry; direct writes can expose partial files | Correct warm loads and safe invalidation | Artifact key = source hash + converter/format/dependency versions + normalized settings hash + coordinate policy; LOD inputs included; temp write, validate, atomic rename; manifest checksum | M | Warm caches invalidate once; larger metadata and migration handling | Cross-version/profile/LOD invalidation, corrupt/partial file recovery, concurrent writer test | **Implemented in Phase 1** |
| Renderer-level regression/performance corpus | 1,900+ unit tests do not prove WebGL appearance or FPS | Prevents recurring flicker, memory, and latency regressions | Add Playwright/WebGL harness with IFC2X3, IFC4, repeated-object, georeferenced, MEP-heavy, and federated fixtures; capture hardware/browser metadata and frame percentiles | M | Public fixtures/licensing and CI GPU variance; use relative plus hardware-qualified budgets | See full test matrix below | **Harness and BasicHouse correctness gate pass; broader hardware/fixture baselines remain** |
| Split `ViewerPanel` by lifecycle ownership | One 7,100-line component makes ordering and resource ownership hard to verify | Maintainability, smaller subscriptions, safer cleanup | Extract model/load session, render state, picking, navigation, measurement, and HUD controllers behind typed interfaces; no behavior redesign during extraction | L | Mechanical refactor can hide regressions without E2E first | Lifecycle mount/unmount, repeated load, all shortcuts/tools smoke suite | **Now after initial E2E harness** |

### Phase 2 - geometry preprocessing, spatial data, and LOD

| Change | Problem and main use case | Expected benefit | Recommended implementation and architecture | Effort | Risks, trade-offs, dependencies | Required tests | Decision |
|---|---|---|---|---|---|---|---|
| Versioned render artifact manifest | Bounds, stable IDs, settings, and provenance are spread across caches | Faster startup, reliable selection, deterministic cache reuse | Emit stable application key/local ID/GUID table, element/tile bounds, materials, units, transforms, profile hash, dependency versions, and checksums with fragments | M | Artifact-version migration and storage growth | Round-trip ID parity, manifest compatibility, corrupt entry fallback | **Phase 2 v1 implemented; richer material/unit table later** |
| Spatial tiles and progressive residency | Monolithic geometry/proxy makes large loads and culling coarse | Earlier useful view, bounded memory, local refinement | Partition by spatial hierarchy/region while respecting storey and element boundaries; prioritize camera/storey tiles; retain metadata before geometry; explicit load priority/backpressure | XL | Bad tile size raises draw calls or transfer overhead; opening geometry must remain associated with hosts | Tile-size benchmark, progressive cancellation, camera teleport, missing/duplicate geometry, peak memory | **Durable exact tile artifacts and stable visibility integrated; progressive first-load mounting next** |
| Precomputed batching and instancing | Many semantically separate repeated parts create draw calls; runtime furnishing merge is unstable | Lower CPU/GPU submission cost without interactive rebuilds | Detect identical geometry/material signatures; instance windows, chairs, fixtures, bolts; batch static material/storey/region geometry while retaining object-ID ranges | L | Per-object transparency/selection needs ID-aware shaders or fallback; edits can invalidate batches | Pixel and ID parity, selection inside batch/instance, transform precision, draw-call benchmark | **Now in preprocessing design; ship with tiles** |
| Per-tile error-bounded LOD | Whole-model proxy pops and doubles memory | Smooth motion, stable semantic state, gradual refinement | Generate LOD0 plus 1-2 simplified tile meshes; store geometric error; select by projected screen-space error and motion budget; cross-fade or retain old tile until replacement ready | XL | Simplification can close openings, damage thin MEP, or create cracks; extra storage | Hausdorff/silhouette error, thin-feature corpus, section cut parity, no-ID-change, navigation/rest frame budget | **SSE/hysteresis planner and fail-closed LOD identity/error proof implemented; simplified tile mounting later** |
| Buffer optimization and compression | Full float/index payloads increase network, CPU, and GPU memory | Faster warm/cold load and more resident detail | Index deduplication, compact index width, position quantization relative to tile origin, normalized attributes, optional meshopt-like transport compression; decode in worker | L | Decode cost and precision loss, especially georeferenced models | Geometry tolerance, decode throughput, buffer bytes/triangle, coordinate precision | **Later; prototype alongside artifact v2** |
| Genuine invalidation rendering | Continuous and helper passes consume power while view is static | Lower idle CPU/GPU, better laptop/mobile thermals | Schedule frames only for motion, streaming, animation, overlays, state application, or diagnostics; park all rAF loops; make log depth/AA profile- and model-dependent | M | CSS2D labels and controls must explicitly invalidate; diagnostics sampling changes | Zero/near-zero idle frames, wake-on-every-event, label correctness, battery/power observation | **Parkable invalidation loop implemented behind release flag; renderer qualification remains** |
| Lower-copy desktop load path | Tauri IPC/web upload duplicates large IFC buffers | Lower peak memory and faster local open | Pass a validated local path/capability token to backend, stream/hash file there, and return artifact progress; web path remains upload-based | M | Path security and lifetime; desktop/web behavior must converge | 1-5 GB local file peak RSS, path traversal/security, cancel/reopen | **Now for desktop large-model support** |

#### Phase 2 implementation checkpoint - 15 July 2026

The first Phase 2 slice is implemented end to end without making simplified
geometry eligible for exact selection:

- `spatial_tile_splitter` now writes restart-durable, versioned, atomically
  replaced and checksummed manifests. Its identity covers source SHA, grid,
  algorithm, storey membership, AABB provenance, and the complete AABB digest;
  placement-to-real warm-up and corrupt artifacts invalidate safely.
- `GET /api/ifc/fragments/tile` returns independently loadable exact fragment
  subsets. The subset authoring path reloads the result standalone and proves
  local-ID/GUID, sampled geometry, and material parity before publication. A
  failed or missing proof returns no bytes and is never cached.
- The frontend translates the Express-ID manifest into a stable local-ID
  contract, rejects stale/non-real bounds, then rebases each active tile from
  IFC world coordinates to the mounted fragment model with `getMergedBox`.
  Unproven tiles remain visible. It validates unique ownership and fetches tile
  bytes only when response identity headers match the request.
- `SpatialTileLodService` implements screen-space-error projection for
  perspective and orthographic cameras, navigation/idle budgets, hysteresis,
  bounded priority/backpressure, stale-request cancellation, retain-until-ready
  swaps, and LOD0-only exact-pick/measurement leases.
- The live viewer prefers the preprocessed tile index when spatial culling is
  enabled. Geometry remains mounted; the coordinator owns one named tile mask.
  Navigation performs show-only updates and idle performs hides, with selected
  exact geometry pinned. The existing client AABB cullers remain the warm-up
  fallback.
- Browser cold load now applies the selected WebIFC profile in the conversion
  worker, preloads only the actually used single-thread binary, versions the
  changed cache output, defaults new installations to the balanced local
  geometry cache, defers the second metadata parse until idle, and reports the
  broad conversion stage accurately.
- The optional invalidation renderer now fully parks its animation-frame loop
  after the dirty window expires instead of retaining an idle rAF forever.

Measured contract evidence, not a production FPS claim: the BasicHouse exact
8-element subset reduced a 3.66 MB full artifact to about 14 KB while preserving
the verified identities/geometry/material samples. The current whole-model LOD
smoke reduced 249,075 to 81,316 triangles and 3.66 MB to 1.61 MB, preserved all
331 identities, and recorded maximum error 0.00570 under a 0.05 target.

The real Chromium regression also passed the cold BasicHouse path on 15 July
2026: exact selection and its named highlight survived orbit and
hide/isolate/ghost/restore, the transition probe saw zero zero-geometry frames
and zero context-loss frames, and the coordinator ended on its latest rendered
generation with no error. That run used SwiftShader, so its load, click, and
frame timings are correctness diagnostics only, not desktop-GPU targets.

Still outstanding in Phase 2: replace the initial monolithic mount with a
multi-tile residency session; mount generated simplified tile payloads through
the planner; precompute material/storey/region batches and repeated-component
instances; add compressed/quantized tile buffers; garbage-collect superseded
tile artifacts; and qualify spatial culling plus on-demand rendering on the
hardware renderer corpus. Centroid ownership also requires neighbour prefetch
and hysteresis for geometry crossing tile boundaries.

### Phase 3 - core BIM interaction tools

| Change | Problem and main use case | Expected benefit | Recommended implementation and architecture | Effort | Risks, trade-offs, dependencies | Required tests | Decision |
|---|---|---|---|---|---|---|---|
| Hybrid coarse-to-exact picking | Full fragment raycast can become slow and proxy switching complicates clicks | Consistent sub-80 ms selection on large models | GPU/tile object-ID coarse pick, spatial candidate shortlist, exact fragment raycast only for candidates; generation/cancel policy for hover versus click | L | GPU readback stalls; transparent/clipped geometry needs defined behavior | Occlusion/transparency/section pick cases, click p50/p95/p99, hover backpressure, touch tolerance | **Fresh exact-hover reuse implemented; true GPU/tile-scoped picking deferred** |
| Snap index and construction measurements | Site users need trustworthy clearances, constrained height, coordinates, and construction snaps | Faster inspection with visible precision provenance | Use exact hit-triangle candidates for vertex, edge, midpoint, and face center; preserve exact/inferred provenance; add semantic axes, round centers, grids, BIM references, chained measure, and editable endpoints incrementally | L | Candidate explosion; unit/georeference correctness; distinguish exact from inferred axes | Snap priority/tolerance, round/MEP center, clipped plane, unit conversion, large candidate latency | **Height, hit-triangle clearance, position, and triangle-feature snaps implemented; semantic snap index later** |
| Stable section workspace | Rapid plane changes and clip-to-selection can race or overwrite intended bounds | Predictable inspection cuts | Keep normalized absolute definitions in state, coalesce controller application, update six box planes in place, then add draggable box faces/sliders, cut exclusions, and planar measure mode | M | Cap geometry and transparent materials; federated transforms later | Clip-to-selection, rapid updates, save/restore, multiple planes, ignored model/category | **Absolute workspace plus multi-selection/storey box presets implemented; editing and exclusions later** |
| Indexed named filters | Property filter was capped and used transient shared highlight; no reusable predicate object | Fast discovery and durable workflows | Compile typed AND/OR predicates against a revision-aware semantic index; save definitions and scope; actions create their own visibility/appearance layer; revision re-evaluates predicate | L | Missing/heterogeneous IFC properties; backend/frontend index consistency | Numeric/string/null operators, 100k+ results, revision update, independent clear, query explain | **Indexed evaluation, named local definitions, and independent result actions implemented; automatic revision re-evaluation later** |
| Unified selection/actions | Actions are spread across panels and selection ownership is ambiguous | Faster keyboard/mouse/touch work with persistent state | One selection model keyed by model+element; contextual action bar/menu; add/remove/range/set selection; history; saved sets; frame/hide/isolate/issue/measure commands share registry | M | Federated identity dependency for cross-model sets | Multi-select stress, history after hide/filter/reload, keyboard/touch parity | **Now** |

#### Phase 3 implementation checkpoint - 15 July 2026

The first Phase 3 slice is integrated around construction inspection without
expanding the beta structural-editing surface:

- Measurement now exposes distance, project-up height, clearance, project/world
  position, rectangle, polygon area, and angle from one compact construction
  selector. Hover and click use the same 20-pixel hit-triangle resolver for
  exact vertex, edge, midpoint, and face-center candidates; committed
  measurement endpoints remain a separate exact snap source.
- A two-pick clearance computes the exact shortest witness between the two hit
  triangles and records `hit-triangle-pair` provenance. Height constrains its
  witness to project Y and position records world/project-local coordinates.
  The live readout, history, labels, and CSV distinguish `EXACT` from inferred
  `GUIDE` results and retain the snap/source provenance.
- The construction math layer also contains tested exact triangle-set
  clearance, explicit/inferred axis candidates, face-normal axes, and
  explicit/inferred round-center candidates. They are not all live viewer
  features yet: clearance is scoped to the two picked triangles, semantic BIM
  axes/round primitives have no model feed, and position is not yet transformed
  through project georeferencing.
- Section state is now a normalized, serializable absolute workspace rather
  than a boolean plus transient controller bounds. A latest-definition
  controller coalesces rapid changes, and the section box updates its six plane
  objects in place when supported. Toggling a selection crop no longer replaces
  it with full-model bounds.
- `Alt+X`, the command palette, and Viewer Tools fit one stable section box to
  the exact merged bounds of the current multi-selection. After isolating a
  storey, **Section storey** fits the same workspace to all leaves in that
  storey. Storey cut-plane constructors are tested foundations; editable box
  faces, cut exclusions, saved-view round-trip, and federated transforms remain
  later work.
- `POST /api/ifc/elements/filter` evaluates up to 20 typed property predicates
  with AND/OR logic against a model-version-aware index. It covers direct IFC
  identity fields, property sets, simple quantities, type/storey scope,
  numeric/string/boolean comparisons, and explicit exists/missing semantics.
  The UI saves immutable named definitions in browser storage and paints each
  result into its own `filter:*` colour layer; paint, isolate, hide, frame,
  show-all, and clear-result actions do not borrow the selection or AI layer.
  Shared/project definitions and automatic re-evaluation after a model revision
  are not implemented.
- Picking remains authoritative `FragmentsModel.raycast()` work in the fragment
  worker. A successful exact hover hit may satisfy a click only when it is at
  most 150 ms old, within 2 pixels, and camera, visibility, clipping, and
  fragment-replacement state are unchanged. Cached misses are never trusted.
  This removes one redundant round trip for quick clicks, but it is not the
  planned GPU ID-buffer or tile-scoped candidate picker and does not justify a
  sub-80 ms large-model claim yet.

Focused unit tests cover construction measurement and snap math, controller
provenance, section serialization/presets/latest-wins behavior, filter schema
and index semantics, and the exact-hover reuse guard. Hardware renderer and
large-model latency qualification remain release gates. Structural editing
continues as beta and is deliberately unchanged by this phase.

### Phase 4 - UI and UX workbench

| Change | Problem and main use case | Expected benefit | Recommended implementation and architecture | Effort | Risks, trade-offs, dependencies | Required tests | Decision |
|---|---|---|---|---|---|---|---|
| Navigator/Inspector workflow layout | Generic Tools catalog and duplicate viewer controls obscure find-understand-act flow | Cleaner viewport and lower learning cost | Left tabs: Location/Tree, Search, Filters, Classification. Right: sticky Selection, Properties, Results/Issues, Views, contextual AI. Preserve collapsible panels and widths | M | Existing users need preference migration; avoid hiding expert tools | Task usability scripts, persisted layout, 1024/1440/1920 snapshots | **Now, incremental** |
| Explore/Measure/Section/Review modes | Simultaneous tool surfaces collide and measurement modes disagree | Clear active interaction and fewer accidental clicks | Typed mutually exclusive mode machine; contextual top tool row; Esc behavior and command registry; selection remains durable across modes | M | Wall edit mode and context menu need explicit arbitration | Mode transition matrix, pointer ownership, Esc/undo, measurement persistence | **Now** |
| Named viewport HUD lanes | Independently positioned overlays overlap | Predictable canvas and responsive placement | `ViewportHud` owns one component per lane and resolves priorities; bottom status carries diagnostics, not primary filters | M | Migration across many components | Collision visual tests, zoom/font scaling, toast and modal coexistence | **Now** |
| Unified load/error/empty states | Status can say Ready before GPU geometry; blank error boundaries offer no recovery | Trustworthy progress and recoverable failures | One load-state machine, stage/bytes/ETA/cache source, retry/open another/copy diagnostics, backend-degraded state that preserves geometry | S-M | Progress estimates must be honest; server and browser fallback stages differ | All transition/failure paths, offline/cache hit, screen-reader announcements | **Now** |
| Responsive and touch tiers | Fixed sidebars squeeze web/tablet view; small targets | Usable web and future field workflows | Breakpoints with one drawer at a time, bottom-sheet inspector, 44 px coarse-pointer targets, long-press context, gesture help, safe areas | L | Full mobile feature parity is not the goal; WebGL memory varies | Playwright touch profiles, rotation, 400% zoom, keyboard-only and axe | **Later for field tier; compact desktop now** |
| Command/accessibility consolidation | Shortcut documentation and handlers drift; rows/dialogs lack complete keyboard semantics | Discoverability and WCAG improvement | One command registry generates menus/palette/help; semantic buttons/tree roles; focus management/traps; live toasts; reduced-motion support | M | Large cross-cutting migration | Keyboard-only workflows, axe, focus restoration, shortcut conflict tests | **Now** |

### Phase 5 - advanced viewer workflows

| Change | Problem and main use case | Expected benefit | Recommended implementation and architecture | Effort | Risks, trade-offs, dependencies | Required tests | Decision |
|---|---|---|---|---|---|---|---|
| Federated `ModelSessionRegistry` | Current single model cannot coordinate architecture/structure/MEP | Multi-discipline review and scalable per-model loading | Session per model with transform, semantic/spatial index, artifact, masks, residency, cache and health; global camera/selection use compound IDs; common-coordinate validation and manual alignment review | XL | ID, clipping, filter, cache, and memory semantics all change | Shared coordinates, transforms, enable/unload, cross-model selection/cut, memory budget | **Later, but design IDs now** |
| Drawing model and synchronized split view | Users cannot orient model findings on construction drawings | Major field/coordination value | Ingest PDF/DWG to a separate vector/raster drawing artifact; level mapping by control points; synchronized camera marker and 2D/3D selection | XL | DWG licensing/conversion, scale/calibration, revision mapping | Calibration tolerance, selection mapping, rotated plans, responsive split | **Later after federation/session foundation** |
| Model/version comparison | Semantic timeline lacks live visual added/removed/changed overlay | Faster design review and edit verification | Match stable GUID/application keys, classify semantic/property/geometry changes, load two sessions, create independent diff layers and synchronized list | L-XL | GUID churn and geometry tolerance can create false changes | Known revision corpus, GUID churn, transforms, large diff performance | **Later** |
| Deep BCF/view integration | Current BCF is strong but not a complete contextual review loop | Better interoperable issue review without building a task suite | Serialize complete view state and model references, durable issue layer, viewpoint restore, markup, clash import adapters, assignment/status audit | L | BCF version/vendor variance and remote collaboration identity | BCF round trip with reference tools, missing model, comments/view state | **Now for view fidelity; collaboration later** |
| Explicit offline package | Cache behavior is implicit and not task-scoped | Predictable site/desktop use without network | Select models/drawings/views to package; show size/version/integrity; pin and evict; queue collaborative mutations for later sync | L | Storage and conflict resolution; only useful with hosted collaboration | Interrupted download, integrity, eviction, stale version, outbox conflict | **Later** |

### Phase 6 - AI-assisted BIM capabilities

| Change | Problem and main use case | Expected benefit | Recommended implementation and architecture | Effort | Risks, trade-offs, dependencies | Required tests | Decision |
|---|---|---|---|---|---|---|---|
| Natural-language query to named filter | Users know the intent but not IFC property spelling | Direct practical model control with inspectable logic | LLM maps request to typed filter AST; deterministic engine validates fields, previews count/sample, and saves a source-owned layer; show explanation and provenance | M | Ambiguity and hallucinated property names; never execute unvalidated raw query | Golden prompts, ambiguous/missing property handling, injection, result parity | **Now; flagship** |
| Contextual property explanation and QA | IFC values and missing data are hard to interpret | Faster audit and learning at selection | Selection-scoped actions explain schema/Pset meaning, find similar/inconsistent/missing values, and return sortable result layers with cited rules | M | Project requirements must not be confused with IFC schema | Citation/provenance, false-positive corpus, model-scope privacy | **Now** |
| AI-generated views, filters, sections, and measurements | Chat can issue some actions but results are transient and globally owned | Repeatable review packages instead of prose | Extend typed viewer intents to named artifacts; preview compound plans; coordinator acknowledges rendered generation; save/replay/share | M | Complex intents need rollback and partial failure reporting | Intent schema/version tests, preview/accept/cancel, replay after reload | **Now after coordinator** |
| Quantity and clearance summaries | Manual selection and measurement are slow for recurring reviews | Fast scoped takeoff/clearance answers with visible evidence | Combine deterministic QTO/spatial tools with named element set and measurement artifacts; label IFC-derived versus geometric/estimated values | M-L | Unit and geometry assumptions; potentially expensive spatial pairs | Unit/property provenance, bounded query, reference quantities, timeout/cancel | **Now for QTO; clearances after spatial index** |
| Revision reasoning and anomaly detection | Large diffs and unusual geometry/property patterns are hard to triage | Focus reviewers on likely problems | Run deterministic diff/statistical detectors first; let AI group/explain results and generate review views; never let model prose be the sole detector | L | False positives and user trust; requires comparison/session foundation | Labeled revision/anomaly corpus, precision/recall, explainability | **Later** |
| Sandboxed viewer-extension SDK | Generated scripts currently lack a stable render API | Safe project-specific analyses without coupling to engine internals | Versioned read-only model/query API plus typed output: tables, filters, layers, measurements, views; capability limits and time/memory budgets; writes remain IFC operation diffs | L | API compatibility and sandbox security | Capability escape tests, deterministic outputs, SDK compatibility matrix | **Later; do not expose raw renderer** |

## Performance budgets and verification

Absolute FPS without hardware, viewport, model, and visual settings is not a
meaningful comparison. Every recorded run must include CPU, GPU, RAM, browser/
WebView version, viewport/DPR, renderer profile, model source hash, object/
triangle/draw-call counts, and cache state.

### Fixture tiers

| Tier | Purpose | Minimum model characteristics |
|---|---|---|
| S | correctness and cold/warm load gate | Current BasicHouse plus IFC4 equivalent |
| M | normal project interaction | Multiple storeys/disciplines, repeated windows/furniture, transparent materials, openings, 100k+ selectable elements |
| L | large-building performance | Millions of rendered triangles, MEP, many materials, 500k+ semantic objects or a documented equivalent stress mix |
| F | federation/revision | At least architecture, structure, and MEP with shared coordinates; two known revisions |
| G | numerical robustness | Large georeferenced coordinates, thin geometry, curved MEP, malformed/partial edge cases |

### Initial release gates

- Existing BasicHouse TTFR/TTFG budgets remain release gates until superseded
  by a versioned benchmark record.
- Click-to-persistent-highlight p95 remains below 80 ms on S and has a
  hardware-qualified p95 target on M/L. Report p50/p95/p99, not only mean.
- Desktop orbit has a 60 FPS target (p95 frame <= 16.7 ms) and a 45 FPS floor
  (p95 <= 22.2 ms) for the defined M configuration. L targets are defined only
  after the artifact/tile prototype establishes a reproducible baseline.
- No long task above 50 ms during steady navigation; preprocessing tasks are
  off-main-thread or yield within an explicit budget.
- Rapid hide/isolate/ghost/selection stress ends with 100% agreement among
  desired state, coordinator-confirmed state, and an ID-buffer/visual probe.
- Selection highlight remains visible throughout orbit and unrelated layer
  changes. Only explicit clear may remove it.
- Repeated load/unload and structural swaps show no monotonic WebGL resource,
  worker, listener, heap, or process-RSS growth after settling.
- Cache hit outputs match cold conversion hashes for identical artifact inputs;
  incompatible inputs always miss.
- Sidecar mixed-profile concurrent requests are deterministic and do not leak
  settings between jobs.
- Accessibility gate: keyboard-only core workflow, automated axe scan, visible
  focus, 200%/400% zoom, reduced motion, and coarse-pointer target sizes.

### Required scenario tests

1. Orbit continuously while rapidly applying hide, isolate, ghost, filter,
   selection, hover, color, clip, and show-all. Assert stable final state and no
   uncommanded selection loss.
2. Select an object, navigate for 60 seconds, cross LOD/tile boundaries, resize
   panels, toggle projection, and restore a view. Selection remains semantic
   and visibly highlighted.
3. Start a structural refresh while navigating. The old scene remains visible
   until the replacement first frame is validated; failure rolls back without
   changing state.
4. Run simultaneous quality and ultra-fast conversions repeatedly. Outputs are
   deterministic for each profile and independent of request ordering.
5. Interrupt upload, conversion, download, decode, and GPU upload. Retry does
   not leave duplicate roots, workers, cache entries, or progress states.
6. Exercise clipping, transparency, instancing, batching, and LOD while picking
   and measuring; the reported semantic object and coordinate remain correct.
7. Force WebGL context loss and restoration. Camera, selection, visibility,
   layers, measurements, and sections recover from application state.
8. Run compact, desktop, high-DPI, touch, and keyboard-only layouts with all
   HUD lanes occupied; no control covers another critical action.

## Immediate changes from this review

### Implemented

- Added `RenderStateCoordinator`, the sole normal-path fragment appearance
  writer. It composes named visibility masks, opacity layers, and prioritized
  base/AI/hover/selection materials; applies only effective deltas; and retains
  selection, transparency, and visibility through navigation.
- Migrated user hide/isolate/ghost, focus opacity, storey and element culling,
  furnishing source masks, color-by/layers, AI results, hover, and multi-
  selection. Normal interaction no longer destroys and recreates IFC elements
  or uses a reset-first highlight pass.
- Added single-flight fragment refresh scheduling for application requests and
  the engine auto-redraw timer, forced-update completion, a bounded non-forced
  model-FINISH watchdog, and painted-frame acknowledgement. Culler hides remain
  idle before mutation, but an already-posted mutation can no longer be parked
  for an entire orbit.
- Made latest-state schedulers revision-aware and joinable. Obsolete async IFC
  ID translations are discarded before publication, and teardown waits for
  model-bound reads/updates with a bounded final worker shutdown.
- Added culler ownership epochs and authoritative named-layer release, including
  show-before-hide transitions. A stale async cull cannot reclaim ownership
  after navigation or user visibility takes over.
- Made furnishing merge/unmerge show-first and retryable: replacement geometry
  stays mounted until source visibility is acknowledged, including rollback
  and failed-dispose paths.
- Unified command-palette, keyboard, and viewport actions on one deterministic
  selection target; fixed context-menu pick staleness and the conditional-hook
  bug without changing the menu's intentional hit-scoped behavior.
- Changed whole-model navigation LOD to opt-in for new installations and
  labeled it experimental. Existing users who explicitly persisted the
  preference retain it. This favors stable exact geometry until spatial,
  appearance-aware tile LOD exists.
- Added a FIFO conversion executor around the sidecar's shared mutable
  `IfcImporter`. Rejected jobs do not block the queue.
- Added complete importer state snapshot/restore across profiles, including
  web-ifc and geometry settings, nested category thresholds, flags, classes,
  relations, and excluded attributes.
- Added sidecar tests for FIFO order, maximum concurrency of one, rejection
  recovery, complete state restoration, and no ultra-fast-to-quality setting
  leakage.
- Added versioned, checksummed, atomically published full/storey/LOD server
  artifacts. Keys include source, profile/settings, exact dependency/runtime
  provenance, artifact kind, LOD parameters, and converter source/bundle hash.
  The browser and sidecar pin `@thatopen/fragments` 3.4.3; incompatible or
  unversioned server binaries fall back before fragment load.
- Hardened local IndexedDB artifact identity, stale-entry deletion, late load-
  timeout quarantine, and overwrite byte accounting.
- Added the Playwright Chromium/WebGL renderer harness and hardware-qualified
  JSON diagnostics described in
  [Renderer regression harness](RENDERER_REGRESSION_HARNESS.md).

### Still required before claiming the flicker problem is closed

- ~~Complete a real hardware-qualified renderer run.~~ Done 16 July 2026: the
  cold BasicHouse scenario passed on an Intel Arc 140V (D3D11 ANGLE, new
  headless full Chromium via `IFC_E2E_FORCE_HW=1`). Orbit held 60 FPS
  (p50 16.6 ms, p95 17.8 ms) with zero context losses. The same run exposed a
  real click-to-highlight failure (~2.1 s), root-caused and fixed the same
  day; see the 16 July checkpoint below.
- ~~Add the visual-material assertion for simultaneous highlight color and
  ghost opacity.~~ Done 16 July 2026: the phase 1 spec samples real pixels
  (selection amber versus ghosted and background points) on both GPU
  profiles. A WebGL context-restoration replay spec also exists and found
  that fragment geometry cannot re-upload after a forced loss because the
  engine frees its CPU-side buffers post-upload; the spec is marked fixme
  and gates that fix. Additional representative IFC fixtures beyond
  BasicHouse remain outstanding.
- Replace whole-model proxy LOD with spatial residency and screen-space-error
  tile LOD. LOD is intentionally not part of the coordinator's stable normal
  path yet. Small and medium models now pin ALL_VISIBLE, so distance-based
  element popping is gone below 20,000 elements.
- Keep whole-model proxy LOD and dynamic furnishing merge experimental/off by
  default until their real renderer transitions and pick behavior pass.
- Structural model revision remounting remains beta and outside this viewer-
  first Phase 1 slice, as requested.

## Verification and hardening checkpoint - 16 July 2026

A full verification pass (multi-agent audit of every phase claim, adversarial
verification of each finding, all suites, and real-GPU end-to-end runs)
confirmed the phase checkpoints above are accurate, and closed the following
defects the unit suites had missed:

- **Click-to-highlight was ~1.6-2.3 s on every click, on any hardware.** The
  engine's auto-redraw ticks route through the single-flight scheduler as
  non-forced updates, and a no-change tick never emits the model FINISH event,
  so each one held the queue for its full 2.5 s acknowledgement watchdog;
  clicks queued behind it. Newly enqueued immediate work now preempts that
  wait and bounded silence resolves as a benign no-op instead of an error.
  Measured on the Intel Arc hardware run: 2,304 ms worst-case before, 105-219
  ms after (queue wait 25-59 ms; the remainder is the real forced worker
  flush). The phase 4 spec now records a multi-click latency window (median/
  p95/max), since the release gate is judged on percentiles.
- **`/api/ifc/fragments/tile` failed for essentially every real model.** Tile
  membership enumerated all `IfcElement` subtypes while every profile except
  `quality` drops openings from the fragment, so the fail-closed subset proof
  rejected any tile containing a door/window opening. Feature elements are now
  excluded from tile membership (`storey-centroid-grid-v2`), and the subset
  service filters requested IDs against a mirrored per-profile drop table
  before authoring (still fail-closed for anything unexpected).
- **New async routes ran CPU-bound work on the event loop** (property-filter
  index build, spatial manifest digests, full-artifact reads/hashes on the
  convert/LOD/tile paths), contrary to the repo's `asyncio.to_thread`
  convention. All offloaded; the filter route also captures its
  (version, model, fingerprint) triple stably so a concurrent edit cannot
  poison the version-keyed index.
- **Painted-frame acknowledgement could resolve before any paint** on a
  visible viewport under heavy load: the 160 ms fallback raced the double-rAF
  boundary. The short fallback now applies only to hidden documents; visible
  viewports keep the true paint boundary with a 2 s shutdown safety bound.
- Tile responses now carry `X-Fragment-Source-Sha` (validated client-side),
  capture AABB provenance before the async subset build, and key their
  identity headers by the filtered ID set; `/api/ifc/lod` gained the same
  cache-key/schema identity headers as every other artifact route.
- Spatial-tile lifecycle seams: the furnishing-unmerge idle tick now pins the
  selection's tile; a failed initial tile tick no longer triggers a reinstall
  that would orphan the live controller's hides; fragment replacements
  invalidate the exact-hover/prefetch pick caches explicitly; per-model tile
  manifests are evicted when a new fingerprint loads.
- Interaction correctness: first-click measurement commits now honor the
  committed-endpoint snap the preview promised; an unsnapped pick votes a
  measurement non-exact; hover previews use the same touch tolerance as
  committed clicks; the named-filter engine lowercases locale-independently to
  match the backend index; measurement CSV escapes all free-text fields and
  carries a UTF-8 BOM.
- The storey chips in Viewer Tools derive the active storey from the
  visibility model (no more state drift against isolation), and `Shift+1..9`
  isolates the same leaf set as the chips.
- Renderer harness hardening: the zero-geometry/context-loss probe now stops
  explicitly after the final restore (it previously self-terminated at 4.5 s,
  before the transitions it polices), `waitForRenderStateIdle` accepts a
  baseline generation so it cannot pass on a stale coordinator state, the
  phase 3 spec records whether the filter panel opened via keyboard or the
  dev-store fallback and attaches diagnostics on failure, and the sidecar
  gained a `npm test` entry plus 400-vs-500 mapping, UTF-8 identity framing,
  and whole-model decimation statistics.

Verified after the changes: backend 1,662 passed (fast lane), frontend
typecheck plus 2,728 vitest tests, sidecar 30 node tests plus typecheck,
strict mkdocs and generated API-doc checks, and the full three-spec Chromium
renderer suite on both the SwiftShader and Intel Arc hardware profiles.

### Pending-item closure pass (same day, release preparation)

A second pass closed the tractable items from the pending inventory ahead of
the v1.1 merge:

- Small and medium models (below 20,000 elements) pin `ALL_VISIBLE`: no
  element appears or disappears with camera distance or angle. Large models
  keep the coverage classifier until per-tile LOD ships.
- Superseded and legacy fragment/tile artifacts are garbage-collected on
  publish; `GET /api/ifc/fragments/storey` prefers the ID-preserving sidecar
  subset path with parity proofs and falls back to sub-IFC reconstruction.
- Applied saved filters re-evaluate automatically after a model revision;
  saved viewpoints round-trip the section workspace; workspace plane
  definitions (including storey cut-plane presets) apply as real clip planes.
- The sidecar cancels queued jobs on client disconnect, proves mixed-profile
  determinism in tests, covers the subset failure path, and drops the stale
  auto-promotion vocabulary.
- The harness adds the orbit-stress phase (visibility toggles during a
  continuous 60 FPS orbit, zero zero-geometry frames), the pixel-level
  selection-plus-ghost assertion, an opt-in click p95 budget gate, and the
  context-restore replay spec with its documented engine limitation.
- Dead pre-coordinator modules (reset-first rebuild scheduler, visibility
  rebuild helpers, the unmounted storey navigator bar and its helpers) are
  removed; the That Open logo overlay is disabled in the viewport.

Not in v1.1 and unchanged in status: progressive multi-tile mounting and
simplified tile payloads, GPU/tile-scoped picking, the ViewerPanel split,
precomputed batching/instancing, the Phase 4 workbench layout (HUD lanes,
mode machine, Navigator filters pane, command registry), semantic snap feeds,
georeferenced position frames, object-set clearance, shared/project filters,
the sidecar worker pool, the lower-copy desktop path, federation, 2D split
view, and the Phase 6 AI flows. These remain correctly documented as later
phases above.

## Recommended delivery order

1. Run and baseline the new WebGL harness on representative models and hardware.
2. Close any real zero-geometry, click-latency, or cold-load failures it finds.
3. Split `ViewerPanel` behind the now-tested scheduler, coordinator, culler,
   cache, load-pipeline, and picking service boundaries.
4. Stage model revisions atomically later; structural editing remains beta.
5. Emit artifact v2 with stable IDs, bounds, materials, and spatial hierarchy.
6. Build indexed filters, improved snaps/measurements, and section workspace on
   the stable coordinator/index.
7. Add batching/instancing and spatial progressive tiles; then error-bounded
   per-tile LOD.
8. Introduce the multi-model registry, federation, comparison, and 2D mapping.
9. Layer AI-generated filters, views, sections, quantities, and review results
   on the same typed, deterministic APIs.

The desired end state is not “Dalux, but copied.” It is a stable, measurable
BIM rendering core with Dalux-like construction fluency, plus IFC Atlas's
stronger transparent semantics, open BCF/IDS/QTO workflows, native IFC editing,
and agent-driven actions that remain inspectable, reversible, and tied to the
actual model.
