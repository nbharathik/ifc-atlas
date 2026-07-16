# Frontend Architecture

Vite + React 18 + TypeScript. Zustand for state. `@thatopen/components` +
`web-ifc` + Three.js for rendering. Atlas design tokens on top of Tailwind-
style utility classes (tokens live in `frontend/src/index.css`).

## Tree

```
frontend/src/
├── components/
│   ├── chat/        ChatPanel, ChatManagerPanel, AiKeysModal, AIReadinessChip,
│   │                PromptSnippetPanel, SkillsSection, ToolsRegistrySection,
│   │                DocumentsSection, ModelsSection
│   ├── edit/        DiffPreviewPanel
│   ├── layout/      Topbar, Menubar, Sidebar, RightSidebar, Outliner, StatusBar,
│   │                CommandPalette, KeyboardShortcuts, SettingsModal, UploadOverlay
│   ├── panels/      PropertiesPanel, SearchPanel, ClassificationPanel,
│   │                ActivityPanel, ViewpointsPanel, CheckpointPanel,
│   │                BudgetDashboardPanel, ElementFilterPanel, ModelStatsPanel,
│   │                ModelHealthPanel, SummaryPanel
│   ├── viewer/      ViewerPanel, ViewerToolsPanel, ViewerContextMenu,
│   │                ClipPlaneControls, MeasurementControls, MeasurementPanel,
│   │                MeasurementLabels, SelectionHistoryNav, SelectionSummaryChip,
│   │                StoreyNavigatorBar, ColourByControl, FloatingChatDock,
│   │                ViewportNavControls, PerformanceHud, PerformanceDashboard
│   └── ui/          ErrorBoundary, Icon, ToastStack
├── services/
│   ├── api.ts       REST client
│   ├── chat/        WebSocket transport for /api/chat/ws
│   ├── ifc/         IFC upload + server-convert client (serverConvert.ts)
│   └── viewer/      Pure math + frustum cullers + share-link encoder
├── store/
│   └── useStore.ts  Zustand single-store
├── types/           Shared TS interfaces
├── workers/         Web-worker entry points
└── App.tsx          App shell
```

## State (Zustand)

One store, flat keys. Rough shape:

```ts
interface AppStore {
  // model
  modelId: string | null;
  elements: Record<ExpressID, Element>;
  storeys: Storey[];
  // selection
  selectedIds: ExpressID[];
  highlightedIds: ExpressID[];
  isolatedIds: ExpressID[] | null;   // null = isolate off
  hiddenIds: Set<ExpressID>;
  filterResultIds: ExpressID[];
  colourLayers: Record<string, ColourLayer>;
  // viewer
  clipPlane: ClipPlaneState | null;
  sectionWorkspace: SectionWorkspaceDefinition | null;
  measurement: MeasurementState;
  activeViewpoint: ViewpointID | null;
  theme: 'dark' | 'light';
  // chat
  messages: Message[];
  activeAgent: AgentPresetID;
  pendingEdit: DiffPreview | null;
  // …
}
```

Actions are individual functions on the store (no reducer-style dispatch).
State lives in one place; components subscribe with selectors.

## Viewer pipeline

```
User drops .ifc
     │
     ▼
POST /api/ifc/upload              ──► backend stores under uploads/
     │
     ▼
POST /api/ifc/convert             ──► server-side fragment build (default cold-load path)
     │                                falls back to web-ifc in-browser parse on failure
     ▼
FragmentsManager.load             ──► Three.js scene
     │
     ▼
camera-controls + raycaster hookups
     │
     ▼
First render → PerfHUD records TTFR / TTFG
```

**Never** set `IfcLoader.processData.raw = true`; pako.inflate expects the compressed buffer.

## Raycasting → Express ID

```ts
// mouse holds RAW client-pixel coordinates (event.clientX/Y),
// not normalized device coordinates.
const mouse = new THREE.Vector2(event.clientX, event.clientY);
const result = await model.raycast({ camera, mouse, dom: canvas });
if (result) {
  // result carries both the express id (`itemId`) and the
  // fragment-local id (`localId`).
  const productId = modelService.resolveProductIdFromHitSync(result.itemId, result.localId);
  store.setSelectedIds([productId]);
}
```

`FragmentsModel.raycast()` is the only supported path, manual Three.js
intersect-tests return wrong IDs for compressed fragments. A successful exact
hover hit can satisfy a click only when it is no more than 150 ms old, within
2 CSS pixels, and camera matrices, visibility, clipping, section state, and
fragment replacement state are unchanged. A cached miss never clears selection;
all other clicks use the exact fragment-worker raycast. This is an exact-result
reuse optimization, not GPU ID-buffer or tile-scoped coarse picking.

## Phase 3 BIM interaction contracts — 15 July 2026

### Construction measurement and snapping

`constructionMeasurement.ts` owns framework-light closest-point math, exact
triangle/triangle and triangle-set witnesses, project-up height, and coordinate
frame transforms. `constructionSnapCandidates.ts` resolves projected triangle
vertices, edges, midpoints, and face centers within a screen-space tolerance.
The same candidate is supplied to hover preview and click commit, so the blue
snap marker and stored witness cannot disagree.

`MeasurementController` keeps committed geometry and labels mounted while the
camera moves. Distance, height, clearance, position, rectangle, polygon area,
and angle share one interaction controller. Height constrains to project Y;
clearance currently measures the exact shortest witness between the two picked
hit triangles; position currently reports the World frame. Measurements carry
`exact`, `source`, and `snapKind` provenance through the viewport readout,
history, labels, and CSV export.

Axis and round-center candidate builders already distinguish explicit/exact
geometry from bounds- or three-point-inferred guides, but the live viewer has no
semantic BIM/grid/round-primitive feed for them yet. Object-set clearance via a
tile BVH and georeferenced project coordinates are also deferred.

### Absolute section workspace

`sectionWorkspace.ts` defines an immutable, schema-versioned workspace with
absolute plane positions and optional absolute box bounds. It validates,
serializes, compares, and builds selection/storey presets. The
`LatestSectionWorkspaceController` coalesces rapid requests and only commits the
latest normalized definition. `SectionBoxController` retains its six plane
objects and updates their equations in place when the clipping API supports it.

Zustand holds the durable workspace separately from the enable toggle. `Alt+X`,
the command palette, and Viewer Tools can fit exact merged bounds for a
multi-selection; Viewer Tools can fit an isolated storey's leaves. Editable box
gizmos, cut exclusions, saved-view serialization, and federated transforms are
not yet wired.

### Indexed named property filters

`ElementFilterPanel` sends up to 20 typed conditions plus AND/OR, IFC type, and
storey scope to `POST /api/ifc/elements/filter`. Definitions use the immutable
schema in `services/ifc/namedFilterEngine.ts` and persist in local browser
storage independently of model result IDs. The backend index is keyed by model
identity and revision; its result includes the exact count plus bounded IDs and
detail previews.

Every painted result owns a `filter:<definition-id>` colour layer. Paint,
isolate, hide, frame, show-all, and result-clear actions therefore do not reuse
the durable selection or AI highlight channel. Definitions are currently local
to one browser and must be applied again after loading or revising a model;
project sharing and automatic revision re-evaluation remain future work.

## Atlas design tokens

All UI uses design tokens from `frontend/src/index.css` (AMOLED black
base, near-white primary, blue-highlight accent, 4 px grid, radii 3/4/6/9999).

## Testing

- **Vitest** for pure math + controllers. Tests live next to the unit under test in an `__tests__/` folder.
- **Phase 3 contracts:** construction measurement/snap candidates and controller
  provenance; section workspace serialization/presets/latest-wins behavior;
  named filter schema/store integration; exact-hover reuse guards.
- **Baseline:** the full suite (2,500+ tests) stays green; pre-flight checks run `npm test`.
- **Real renderer regression:** `npm run test:e2e:renderer` drives Chromium/WebGL
  through load, orbit, canvas picking, selection persistence, hide/show,
  isolate, ghost, context loss, and frame/latency capture. See
  [Renderer regression harness](RENDERER_REGRESSION_HARNESS.md). Missing IFC
  fixtures skip locally; release evidence must use an explicit fixture and
  retain the generated JSON artifact with hardware metadata.

## Build flags

| Flag | Effect |
|---|---|
| `VITE_PUBLIC_DEMO=true` | Hides chat, tier-3 tools, backend calls; loads bundled sample IFC. Powers the GH-Pages deploy. |
| `VITE_PLATFORM=tauri` | Enables Tauri-specific hooks (recent-files, native menus, sidecar address). |
| `VITE_BACKEND_URL` | Points at a non-default backend origin. |

## Performance

- **TTFR (time-to-first-render) < 2.5 s cold / < 1.0 s warm** and **TTFG (time-to-fully-geometry-ready) < 4.0 s cold / < 1.5 s warm** on `BasicHouse.ifc` (Invariant 7).
- PerfHUD records + displays both; release verification diffs them against the baseline.
- WebGL is the baseline renderer. WebGPU is opt-in (not default) behind a flag.
- Browser conversion runs in an application worker and currently forces
  single-thread WebIFC; nested WebIFC classic workers are not compatible with
  this build's module-worker URLs. COOP/COEP remains platform telemetry, not a
  claim that the MT binary is active.

## Visibility ownership (single-writer contract)

`RenderStateCoordinator` is the sole normal-path writer of fragment visibility,
opacity, and highlight material. `ViewerPanel.tsx` and viewer services publish
named semantic layers; the coordinator computes the effective state, applies
only its delta, and acknowledges the exact fragment update plus a painted-frame
boundary. Every `FragmentsModels.update()` entry point, including the engine's
auto-redraw timer, is routed through the same single-flight scheduler. Forced
updates use the engine's `forceUpdateFinish()` promise as their acknowledgement;
non-forced camera updates use `onViewUpdated` with a bounded 2.5-second watchdog
so one lost worker event cannot freeze later appearance work.

| Priority | Layer owner | Fires on | Coordinator behavior |
|---|---|---|---|
| **1 (semantic)** | User hide/isolate and isolation ghost | Zustand visibility change | User masks atomically release every culler layer; incoming isolate geometry is revealed before outgoing geometry is hidden. |
| **2 (preferred spatial hint)** | `SpatialTileVisibilityController` | Camera settle; show-only pass during movement | Uses only matching real-AABB manifests, pins selected LOD0, and owns one named mask without removing geometry. |
| **3 (warm-up fallback)** | `StoreyFrustumCuller` | Camera settle; show-only pass during movement | Named mask, disabled by user policy; ownership epochs discard stale async acknowledgements. |
| **4 (warm-up fallback)** | `ElementFrustumCuller` | Same settle/show passes | Named mask over storey-eligible IDs; authoritative layer clear on navigation/policy/disposal. |

There is **no @thatopen-side culler** that independently writes visibility. The built-in `LodMode.DEFAULT` only *respects* `setVisible(...)`, it never sets it. `OBC.SimpleRenderer`'s `cullerPixelsPerMeter` belongs to an unrelated edge-projection pipeline.

`furnishingMerge.ts` mounts replacement geometry before hiding its source IDs
through its own coordinator mask. Unmerge restores originals before removing
the replacement. Failed restoration retains the replacement and is retryable,
so neither a blank frame nor missing ownership is accepted.

Base coloring, AI results, selection, user visibility, and focus opacity use
`createLatestAsyncScheduler(...)` before publishing layers. It is single-flight
and revision-aware: state that changes during an IFC express-to-local-ID lookup
invalidates that lookup's result before it can paint. `shutdown()` cancels
queued work and joins the current model read before fragment workers are
disposed.

The coordinator composes overlapping layers rather than globally resetting
them. Visibility is the union of hidden masks; opacity uses the lowest requested
value; highlight priority is base color, AI result, hover, then durable
selection. Fragments stores color and opacity in one material slot, so the
coordinator emits one combined material per ID. Whole-model proxy LOD remains
experimental/off by default until it is replaced by spatial, error-bounded LOD.

### The contract

- **#1 always wins.** When the user activates isolate or hide, every culler releases its named mask and stands down. Resuming is allowed once #1 returns to "all visible".
- **The preprocessed tile controller is exclusive.** Once a matching real-AABB manifest is ready, both client fallback cullers clear/dispose before the tile mask becomes active.
- **Fallback coarse ownership precedes fine ownership.** Any element whose storey is currently `autoCulled` is excluded from the element culler, and the storey tick completes before the element tick.
- **Movement reveals; idle hides.** Spatial and fallback paths may show geometry during camera motion, but they only publish new hides after settle. Failed acknowledgements do not advance local ownership flags.

### Pure decision helper

`services/viewer/cullerCoordinationHelpers.ts` encodes the contract:

- `decideCullerWork(snapshot)` → `'skip' | 'noop' | 'storey-only' | 'element-only' | 'storey-then-element'`. The settle handler routes on the verb.
- `partitionElementsByOwner(allElementIds, culledStoreyMembers)` → `{ ownedByStorey, eligibleForElement }` (disjoint sets). The element culler filters its records through this before running its frustum tests.
- `decideElementCullerAction({ ownedByStorey, autoCulled, inFrustum })` → `'noop' | 'hide' | 'show' | 'cede-to-storey'`. The single-element verdict.
- `tallyCullerCoordination(stream)` → counts `racingWrites`, `sequencedWrites`, `staleAutoCulled` over a synthetic tick stream. Pin for the regression: the follow-up wire-up must drive `racingWrites` to zero on the same inputs that produce >0 under the current arrangement.

The helper is framework-free (no THREE.js / @thatopen imports) and is wired into `ViewerPanel.tsx`.

## Spatial tile and LOD contract

`spatialTileManifestAdapter.ts` accepts a backend tile manifest only when its
fingerprint matches the mounted model and its provenance is `real`. It converts
IFC Express IDs to immutable fragment-local identities and rebases tile bounds
through the mounted model's `getMergedBox` so WebIFC axis/auto-coordinate policy
cannot put culling in the wrong coordinate space. Unproven IDs stay resident.
It rejects duplicate ownership and emits exact LOD0 content identifiers.
`SpatialTileLodService` validates that contract and owns
SSE/hysteresis decisions, request priorities, backpressure/cancellation, and
exact-pick leases. A coarse representation is never treated as an exact
raycast target.

`spatialTileVisibilityController.ts` is the current live integration: the full
fragment model stays mounted and the controller publishes one coordinator mask.
The binary client for `/api/ifc/fragments/tile` validates tile/grid/profile and
artifact headers before exposing bytes. Progressive multi-model mounting is the
next step; until it lands, fetching a tile would duplicate the already-resident
exact model and is therefore deliberately not performed by normal navigation.

Browser conversion and metadata preprocessing are separated. In concurrent
startup mode, `ModelService` registers the fragment model immediately but
defers its second full WebIFC metadata pass until browser idle; an early property
request still starts it on demand. The balanced browser fragment cache is the
new-install default and artifact compatibility is bumped whenever parse settings
change.

## Graphics profile transitions

`useStore.ts` exposes `setGraphicsProfile(p)` to flip between `quality`, `balanced`, `performance`, and `ultra_fast`. These settings are parse-time preferences. When no model is loaded, the preference is saved silently and the next load uses it. When a model is already loaded, `SettingsModal` runs the change through `decideProfileTransition(...)` and asks the user to confirm before saving because the current fragment scene cannot be re-profiled in place.

After confirmation, the user reloads or re-drops the IFC to render with the new profile. The release does not claim an automatic in-place profile rebuild.

### Knob inventory

Every difference between `quality` / `balanced` / `performance` / `ultra_fast` is a **parse-time** knob today (see `parseProfiles.ts` + the sidecar mirror `backend/sidecar/src/profiles.ts`):

| Knob | quality | balanced | performance | ultra_fast |
|---|---|---|---|---|
| `circle-segments` | 24 | 18 | 14 | 6 |
| `drops-non-visual-categories` (IFCSPACE / OPENING / ANNOTATION / GRID) | no | yes | yes | yes |
| `drops-property-classes` (abstract psets / units) | no | no | yes | yes |
| `drops-mep-and-furnishing` (MEP, furniture) | no | no | no | yes |
| `geometry-thresholds` (faceThreshold / precision) | default | default | performance | ultra_fast |
| `memory-limit` (MB) | (default) | (default) | 384 | 1024 |

No renderer-side knob exists yet (no LOD threshold, no edge-detection toggle, no shadow level scoped to the profile). Until one is added, every cross-profile flip is `reload-required`.

### Decision contract

`services/viewer/graphicsProfileTransitionHelpers.ts` encodes the rules:

- `PROFILE_KNOBS: Record<ParseProfile, ProfileKnobs>`, per-profile knob snapshot.
- `diffProfileKnobs(a, b)` → `ProfileKnob[]`, deterministic order, `[]` when `a === b`.
- `decideProfileTransition({ prev, next, modelLoaded })` → `{ kind, reason, changedKnobs }`:
  - `'noop'` (`prev === next`)
  - `'noop-no-model'`, just persist the pref; next load consumes it.
  - `'tweak-in-place'`, reserved for a future renderer-side knob; **unreachable today**.
  - `'reload-required'`, at least one parse-time knob differs; needs a re-parse.
- `tallyProfileTransitions(stream)`, `noop` / `noopNoModel` / `tweakInPlace` / `reloadRequired` / `total` counters for telemetry + regression pinning.

Pin for the regression: any future wire-up that lets `tweak-in-place` fire must (a) add the corresponding renderer-side knob to `KNOB_REBUILD_REQUIREMENT` and (b) flip the audit test that asserts `tweak-in-place` is unreachable.

The helper is framework-free. `SettingsModal` owns the current UI flow:

1. `noop` / `noop-no-model`: save the pref with no user-facing interruption.
2. `reload-required`: show a confirm dialog that names the changed knobs, then save the pref after confirmation.
3. `tweak-in-place`: reserved for a future renderer-side knob; if one is added, the caller can apply it without re-parsing.

## Viewer benchmark and target architecture

[`BIM_VIEWER_DALUX_REVIEW.md`](BIM_VIEWER_DALUX_REVIEW.md) contains the July
2026 end-to-end viewer audit, the confirmed-versus-inferred Dalux comparison,
the stable-geometry target architecture, and the phased implementation and
performance-test plan.

## Conventions

- **Architecture docs**, orientation before any work. Start with
  `docs/architecture/OVERVIEW.md` and the relevant file in this directory.
- **Prop drilling is fine** for small UI trees; reach for the store only when ≥2 distant components need the same state.
- **No inline styles.** Use Atlas token classes.
- **No `any` except at fragment boundaries.** Document why.
