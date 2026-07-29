# Phase 2C: Viewer Efficiency and Correctness

**Status:** Approved direction, implementation starting
**Supersedes:** the previously recommended "Phase 2C: backend edit/use-case extraction", which moves to Phase 2E
**Baseline measured:** 2026-07-29 on branch `refactor`

## Why this block exists

Phases 2A and 2B moved viewer ownership boundaries and both recorded the
`viewer-engine` artifact as exactly unchanged at 6,725,668 bytes. That was the
correct gate for a pure boundary move, but it means two consecutive blocks
produced no user-visible improvement. This block inverts the gate: every item
below must reduce bytes, reduce lines, or fix a defect a user can observe.

## Measured baseline

All numbers taken from a clean `npm run build` on the current tree.

| Metric | Value |
|---|---:|
| `dist` total | 23,256,217 B raw / 4,379,516 B gzip, 63 files |
| First paint JS + CSS | 535,618 B raw / 131,203 B gzip |
| Model open, server-convert path | 8,616,808 B raw / 1,719,796 B gzip |
| `viewer-engine` chunk | 6,725,668 B / 1,283,217 B gzip |
| `ViewerPanel.tsx` | 6,887 lines, 160 hook calls, one 3,732-line effect |
| `index.css` | 12,782 lines, built to 231,894 B / 36,667 B gzip |
| Frontend source | 107,857 lines (67,090 production, 31,366 test, 9,401 generated) |
| Frontend unit tests | 2,755 passing, 1 skipped |

`viewer-engine` composition, measured by building with per-package chunks:

| Package | Raw | Gzip | Share of gzip |
|---|---:|---:|---:|
| web-ifc | 3,616 kB | 415 kB | 32% |
| @thatopen/components + components-front | 2,005 kB | 582 kB | 45% |
| three | 594 kB | 152 kB | 12% |
| @thatopen/fragments | 476 kB | 135 kB | 11% |

## Negative results, recorded so they are not retried

These were tested and do not work. Do not spend effort here again.

1. **Tree-shaking the engine packages gains nothing.** Building with
   `rollupOptions.treeshake.moduleSideEffects` marking `three`, `web-ifc` and
   the three `@thatopen` packages side-effect-free produced byte-identical
   output. `@thatopen/fragments/dist/index.mjs:40` does
   `import * as WEBIFC from "web-ifc"` at the top of its barrel and the built
   chunk pulls roughly 500 named symbols across, so the graph is genuinely
   static.
2. **Removing `manualChunks` gains nothing.** Total emitted JS was 15,793,299 B
   versus the current 15,798,456 B, a 0.03% difference. It only redistributes
   bytes, and it merges web-ifc into a 5.6 MB `ModelService` chunk, which is
   worse for cache reuse.
3. **Vendor-prefix and keyframe cleanup in CSS is not a bloat source.** 30
   prefixed declarations, 20 keyframes, all referenced.

The conclusion is that the engine payload cannot be reduced by bundler
configuration. It is reduced by compression, by deleting unreferenced files,
and by removing static edges that pull unused code.

## Blocks

Each block leaves the application releasable and is independently revertable.

### Block 1: Transfer and deploy weight

No application code changes. Highest value per unit of risk in the programme.

| Item | Change | Effect |
|---|---|---|
| 1.1 | Add `encode zstd gzip` to `Caddyfile.prod` | Production currently serves everything uncompressed. First paint 535,618 to 131,203 B. Model open 8,616,808 to 1,719,796 B. |
| 1.2 | Stop emitting the unused `@thatopen/fragments` worker asset | 3,216,090 B of `dist` never fetched at runtime |
| 1.3 | Delete `public/web-ifc-mt.wasm` | 1,314,227 B, unreachable because `webIfcPatch` forces single-thread |
| 1.4 | Generate `public/worker.mjs` from the installed package | Removes a stale checked-in 1,335,963 B binary that is version-skewed against the pinned `@thatopen/fragments` 3.4.3 |
| 1.5 | Remove the `index.html` WASM preload | 1,303,940 B competing with critical JS during HTML parse; `App.tsx` already warms it after first paint |
| 1.6 | Make `ChatPanel` lazy inside `FloatingChatDock` | 205,006 B raw / 63,020 B gzip off every model open |
| 1.7 | Stub `three/webgpu` and `three/tsl` | 638,904 B raw / 180,107 B gzip for an unreachable feature |

**Result (2026-07-29):** `dist` 23,256,217 to 18,759,313 bytes, a reduction of
4,496,904 bytes (19.3%). Compressed, 4,379,516 to 3,468,510 bytes (20.8%).
`dist/worker.mjs` is now byte-identical to the installed
`@thatopen/fragments@3.4.3` `Worker/worker.min.mjs`, so the main thread and both
worker bundles run the same engine build for the first time. Typecheck clean,
2,756 unit tests pass.

Item 1.7 was **not shipped**. `three/tsl` feeds `getBvhcastEdgesWebgpu` in
`@thatopen/components`, the compute path behind clip edges, which is a live
feature and one this block repairs in 2.1. Only `THREEWEBGPU.WebGPURenderer` is
read from the namespace and `getRenderer()` is lazy, so a stub is plausible, but
it needs a test that proves clip edges still render before it can land.

Remaining acceptance: first-paint and model-open transfer measured against a
running Caddy with compression enabled, and renderer e2e parity on hardware.

### Block 2: Viewer defects

Every item is a defect a user can observe. Each needs a regression test.

| Item | Defect | Fix |
|---|---|---|
| 2.1 | Section and clip cap fills never render. `ClipEdgesService.setModel()` is called about 1,700 lines before the effect that constructs the service, so `ClipEdges.items` is always empty and `update()` is a no-op. Every section renders as a hollow shell. | Register the model inside the effect that owns the service |
| 2.2 | Clearance measurement is wrong. `hitTriangle` (`ViewerPanel.tsx:4655`) builds a triangle from the first three points of `facePoints`, which `@thatopen/fragments` 3.4.3 fills from a full N-gon face profile including hole loops. The fabricated 2 to 0 edge does not exist on the mesh. | Triangulate with `hit.faceIndices` and feed `shortestDistanceBetweenTriangleSets`, which is already written and tested with zero production callers |
| 2.3 | Clearance silently degrades to a point-to-point line when a hit carries no `facePoints`, labelled "Clearance" with no visual distinction. | Bail or mark the result inexact |
| 2.4 | `facePoints` are model-local while `point`, `normal` and `snappedEdgeP1/P2` are world-space. Correct only while the model matrix is identity. The helper docs assert the opposite. | Apply `model.object.matrixWorld` at the call site, correct the docs, add a non-identity-matrix test |
| 2.5 | Section-workspace effect omits `viewerReady` from its deps, so any section change made between model-loaded and viewer-ready is dropped permanently. `ViewerToolsPanel` renders on `modelLoaded`, which is earlier. | Add the dependency |
| 2.6 | 13 canvas and camera-controls listeners are never removed on teardown, each closure retaining `model`, `world`, `components` and the pick caches. | Collect into one `removeInteractionHooks` closure, matching the existing `removePanelResizeHooks` pattern |
| 2.7 | The server pre-build load path is the only one of six that omits the `graphicsQuality` seed, so a model loaded after orbiting starts at reduced quality. | Seed it like the other five |
| 2.8 | The server-manifest fast path swallows every failure with no log, so a fallback to a slow cold load is undiagnosable. | Warn and log to the activity feed |
| 2.9 | `public/worker.mjs` is version-skewed against the main-thread library, and `sw.js` pins it cache-first under a hand-bumped `CACHE_NAME`. The Fragments LOD classifier runs inside that worker. | Covered by 1.4, plus make the service worker cache key derive from content |

Acceptance: a regression test per item, renderer e2e passes, and 2.1 verified
visually because a cap fill cannot be asserted headlessly.

### Block 3: Deletion

Roughly 4,900 to 5,100 lines at high or medium confidence, about 5% of
non-generated frontend source. Sequenced so each step reverts independently.

1. Three components with zero import sites of any kind: `ClipPlaneControls.tsx`,
   `ColourByControl.tsx`, `SelectionHistoryNav.tsx` (376 lines). Note that the
   dead `ClipPlaneControls.tsx` carries a drag-performance optimisation the live
   path lacks; port it before deleting.
2. Seven modules imported only by their own test file (579 production plus 791
   test lines).
3. 253 CSS rules for 188 class names that exist nowhere (1,437 lines, 32,924
   minified bytes).
4. 26 unreferenced exported functions in `services/api.ts` (184 lines). Check
   each against the backend first: an endpoint with no client is a separate
   signal, not a silent delete.
5. 777 `var()` fallbacks whose token is always defined (7,067 minified bytes),
   as a scripted codemod with a screenshot check.
6. The permanently-disabled paths, pending an explicit product decision:
   `streamingRevealEnabled` is hardcoded false with a setter that has no
   callers, and four `VITE_*` gates (`STREAMING_GEOMETRY`,
   `NATIVE_GEOMETRY_PREVIEW`, `STOREY_FRAGMENT_PREVIEW`,
   `VIEWER_COMPUTE_SCENE_BVH`) are set in no env file, workflow, Dockerfile or
   script anywhere in the repository, making about 735 production lines
   unreachable in every shipped configuration.

Explicitly **not** deleted: the 3,064-line culling and LOD stack. It is
default-off but genuinely user-reachable through Settings toggles. If it is not
being carried forward, remove the toggles first, ship one release, then delete.

**Result (2026-07-29):** items 1 to 4 complete, 3,650 lines removed across 33
files, 17 files deleted. `frontend/src` is 120,322 lines, down from 123,745.
Typecheck clean, 2,664 unit tests pass across 162 files.

Two things were caught by verifying rather than trusting the audit:

- `ClipPlaneControls.tsx` was dead, but held a drag optimisation the live
  `ViewerToolsPanel` slider lacked. That slider called `updateClipPlane` on
  every `onChange`, and that reducer calls `writePref`, so dragging a clip plane
  ran a `JSON.stringify` plus a synchronous `localStorage.setItem` per pointer
  sample. Ported as `setClipPlaneOffsetTransient` with a single commit on drag
  end, then the component was deleted.
- The dead-export scan initially flagged `getIfcSaveAsUrl` and
  `invalidateChatManagerBootstrap` because it only searched other files; both
  are called inside `api.ts`. 25 functions removed, not 27.

Endpoints with a backend route and no frontend caller, reported rather than
treated as a defect: `/api/ifc/meta`, `/api/ifc/project`, `/api/ifc/stats`,
plus the agent and tool-set CRUD surfaces and the AABB cache endpoints.
`uploadIfc` was superseded by the live `uploadIfcWithMode`.

### Block 4: CSS co-location

`index.css` is the single render-blocking stylesheet and is larger than the
entry JS chunk. 67.1% of its minified bytes belong exclusively to lazily-loaded
components.

Order matters. 62 selectors are redeclared far apart as override layers, and
per-chunk CSS loads after the entry stylesheet, so a naive file split silently
changes which declaration wins.

1. Merge the 62 order-dependent override pairs into their base rules. Pure
   refactor, exact check: computed styles must be identical.
2. Delete the orphaned rules from Block 3.
3. Co-locate each lazy component's rules into a sibling `.css` file imported by
   that component, following the existing `pluginsPanel.css` convention.

Target: entry stylesheet from 231,894 B to roughly 37,600 B.

Acceptance: screenshot matrix across both themes unchanged, entry CSS size
recorded, no component owning rules in more than one file.

**Result (2026-07-29): step 2 only.** 256 rules for 183 orphaned class names
removed, `index.css` 12,783 to 11,207 lines, built entry stylesheet 231,894 to
202,622 bytes (33,203 gzip). The scan re-run reports zero further removable
rules, so it converged.

A naive orphan scan would have deleted 73 more classes and broken live UI: BEM
modifiers such as `ai-readiness-chip--ready` and `bdg-status-over_cap` are built
by interpolation, so their full names never appear as literals in source. Any
future dead-CSS guard in CI must treat `prefix${` as a use, or it will delete
working styles.

Steps 1 and 3 remain and are the larger share of the win. Step 1, merging the 62
order-dependent override pairs, needs computed-style comparison in a real
browser and cannot be verified headlessly, so it gates step 3 rather than the
other way round.

### Block 5: ViewerPanel dissolution

The file is 6,887 lines: 291 imports, 148 lines of module helpers, a 6,220-line
component body, and 227 lines of JSX. JSX is 3.3% of the file. One `useEffect`
spanning lines 2174 to 5905 is 3,732 lines, 54.2% of the file, and has only six
dependencies. That effect is the whole problem and every extraction below is a
sub-extraction of it.

The blocker is shared refs: six of the 56 `useRef`s are read across four to
eight capability clusters each. So the first step is not an extraction.

1. **`ViewerSessionPorts`.** One object created in the boot effect exposing
   named getters and setters for the six shared refs, threaded to every
   controller. Without this, any module boundary has to smuggle 15 to 17 refs
   across it.
2. **Low-coupling extractions**, in ascending risk: `viewHelperGizmo` (178
   lines), `devViewerHooks` (160), `useLoadProgressPacer` (109), z-fighting
   scheduler into the module that already owns the pass (80), `perfSampler`
   (129), `viewpointCapture` (291).
3. **De-duplication**, which removes lines with no new modules: the
   culler-ownership ladder is written out four times (about 200 lines), the
   navigation-enter handler body is byte-identical in three places and
   navigation-exit in two (about 60 lines), `expressToLocalIds` re-implements
   `localIdCachePrewarm` (49 lines), and the isolate/ghost partition
   re-implements `ghostModeHelpers`, whose decision engine has zero callers.
4. **`modelLoadPipeline`** (1,138 lines). The largest block, untestable today
   because it is welded to a React effect.
5. **`cameraNavigationController`** and **`canvasInteractionController`**
   (786 and 982 lines). Highest risk, done last. `onPointerUp` alone is 290
   lines multiplexing pick-plane placement, measurement commit and selection.

Target end state: the boot effect becomes roughly 30 lines calling
`startViewerSession(container, ports)`.

Also in this block: set `noUnusedLocals` to true in `tsconfig.app.json`, which
is currently false, so the 20 lines of dead locals found in this file stop
accumulating.

Acceptance: `ViewerPanel.tsx` under 1,500 lines, every extracted controller
unit-tested without a browser mount, renderer e2e parity unchanged, bundle not
regressed.

**Result (2026-07-29): steps 2 and 3 started.** `ViewerPanel.tsx` 6,887 to 6,740
lines, 41 to 37 effects.

- `useLoadProgressPacer` extracted to `hooks/useLoadProgressPacer.ts`: the pace
  model, the elapsed-second timer, the expected-total estimate and the
  presentation memo, removing 4 hooks and 3 effects from the component.
- The navigation-enter body, byte-identical in three places, is now
  `enterResizeNavigation`. The navigation-exit body, duplicated in two, is now
  `exitResizeNavigation`. About 110 lines and the class of bug where a new
  navigation field is added to two sites out of three.
- `expressToLocalIds` moved to `localIdCachePrewarm.resolveExpressToLocal` with
  the remembered-id lookup passed in as a callback, so a path used by selection,
  highlight and focus is unit-testable for the first time. Six tests added.

Note honestly: extraction relocates lines rather than deleting them, so the
repository total barely moves. The de-duplication is the part that deletes. The
value of the extraction is that the logic can now be tested without mounting a
browser, which is the precondition for the remaining items.

Not started: `modelLoadPipeline`, `cameraNavigationController`,
`canvasInteractionController`, the `ViewerSessionPorts` object, and the four
copies of the culler-ownership ladder. The three controllers are the bulk of the
file and carry the real regression risk.

**Result (2026-07-29, second stretch):**

- **Panel-resize flicker fixed** (user-reported: dragging the sidebar divider
  made the 3D view flicker or disappear). Root cause, confirmed in engine
  source: OBC SimpleRenderer's own ResizeObserver calls `three.setSize` per
  resize tick, which resets the drawing buffer to transparent black; observer
  callbacks are delivered after the frame's rAF render and before paint, so
  every tick painted a cleared canvas. In on-demand render mode the app's
  observer early-returned without a kick (the engine's observer fires first and
  resizes to identical values), so the viewport stayed blank for the whole drag.
  Fix in `viewerRuntime.ts`: a `renderNow` handler on `world.renderer.onResize`
  repaints synchronously in the same observer delivery, and `applyPixelRatio`
  repaints after its own direct `setSize`. Ghost postproduction and fragment
  update gating were investigated and refuted as causes.
- **Culler ownership ladder consolidated.** The tile/storey/element ladder was
  hand-written at four sites and had drifted: the tile-install site skipped the
  remembered-localId pinning fallback, and each site had its own error
  discipline. `cullerCoordinationHelpers.ts` now owns `clearCullPass`,
  `hideTickPass`, `showCullPass` and `anyCullerBuilt` over structural culler
  interfaces; ViewerPanel keeps one canonical `getTileViewOptions` plus a
  `cullerPassPorts` snapshot. The install-site pinning divergence is fixed as a
  side effect. The dead `cullerPlanIsNoop` local is gone.
- **Culler AABB builds moved to the engine.** Both frustum cullers rebuilt
  per-item bounding boxes by transferring raw vertex buffers and transforming
  every vertex on the main thread, 120 to 250 ms per model; they now call
  `model.getBoxes(chunk)` and the worker returns the boxes. Test mocks updated
  to the new contract.
- **Engine-reuse audit concluded.** Selection, hover, ghost, colour-by,
  visibility and the spatial tree already delegate to fragments-native APIs.
  Verified keep-ours verdicts, recorded so they are not re-litigated: no culler
  component exists in OBC 3.4.x; `MaterialDefinition` has no depth-bias field
  (z-fighting mitigation stays); `BoundingBoxer` only solves six axis-aligned
  views (camera math stays); OBCF `Marker` clusters labels (measurement labels
  stay); `RenderStateCoordinator` is a compositor the engine does not provide.
  One dead handle deleted: `ModelService.classifier` was constructed and never
  used.
- **Store hygiene.** `ViewerPanel` is memoized (all five props are stable
  refs), so App re-renders no longer re-run the component body. App's theme and
  accent effects subscribe instead of selecting, and App no longer subscribes
  to `spatialTree`.
- **Dead reveal path removed.** `streamingRevealEnabled` was hardcoded false
  with a setter no caller invoked; the reveal machinery in `streamingLoader.ts`
  (167 lines), the App effect, and four store members are gone. The live
  storey-manifest and storey-fragment helpers stay.
- **Verification.** Full unit suite green, and the hardware renderer e2e
  passed 5 of 6 specs in 5.3 minutes (the sixth is the long-standing
  context-restore fixme), covering paint, selection, measurement snapping,
  section workspace, and filter reset.

Known remaining feature gap, next block: the browser metadata worker misses
type-level psets that web-ifc `getPropertySets(includeTypeProperties=true)`
returns. Adopting the helper inside the worker fixes real coverage and deletes
the inverse-relation walks; classifications, the representation-owner index,
and the GlobalId map have no engine equivalent and stay. Backend-served
properties (the default path) are unaffected.

### Block 6: Store and transport hygiene

The store is in better shape than the repository plan assumes. Pointer-move
writes nothing to it, `perfMetrics` writes are gated on HUD visibility, and
there are zero unstable derived selectors. The plan's "re-render storm" framing
is wrong and the slice split it recommends buys maintainability, not
performance. Zustand subscribes per selector, not per store.

The genuine wins are narrow:

1. Two components subscribe to the entire store with no selector
   (`TimelinePanel.tsx:210`, `BudgetDashboardPanel.tsx:67`), re-rendering on
   every write in the app while open. Two-line `useShallow` fix each, matching
   the eight panels that already do this correctly.
2. `ViewerPanel` holds 10 reactive selectors that never reach its JSX, so
   toggling the grid or section box costs a full re-render of the largest
   component in the app for zero DOM output. Convert to the
   `useStore.subscribe` pattern already used five times in the same file.
3. `App()` holds four effect-only selectors and rebuilds an unmemoized 24-child
   tree including `ViewerPanel`.
4. Move the seven engine-callback closures, `ifcFileBytes`, `perfMetrics` and
   `modelHalfExtents` out of the store into a pub/sub module, following the
   proven `hoverTooltipBridge` pattern. The store currently pins the raw IFC
   file, 100 MB or more on large models, for the whole session.
5. `services/api.ts` has 99 functions, none using the generated schema, and 25
   hand-duplicated DTOs with verified drift. The most-read DTO types 10 fields
   as non-nullable that the backend may omit, so `getElement` consumers are one
   missing field from a runtime error the compiler has been told is impossible.
   Collapse the four independent fetch wrappers first, then migrate the nine
   feature services, then the drifted DTOs.

The 13-slice store split is worth doing but is the lowest priority item here.
Pilot it on `measurement` (3 members, 11 lines, one test file).

## Sequencing

Blocks 1 and 2 first, together, as one release: the user-visible payoff.
Block 3 next, since deletion makes everything after it smaller.
Blocks 4 and 6 can run in parallel with each other.
Block 5 last and slowest, because it carries the real regression risk.

Backend route and tool-dispatch extraction, previously numbered 2C and 2D,
become 2E and 2F and follow this block.

## Gates

Replacing the "bundle unchanged" gate from Phases 2A and 2B:

- [ ] `dist` total reduced by at least 4.5 MB
- [ ] Production transfer sizes measured with compression enabled and recorded
- [ ] Entry stylesheet under 60 KB
- [ ] `ViewerPanel.tsx` under 1,500 lines
- [ ] Frontend production source reduced by at least 4,500 lines
- [ ] Every defect in Block 2 has a regression test
- [ ] Renderer e2e parity passes on hardware
- [ ] No feature removed
