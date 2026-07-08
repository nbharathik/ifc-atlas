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
  // viewer
  clipPlane: ClipPlaneState | null;
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
  store.setSelectedIds([result.itemId]);
}
```

`FragmentsModel.raycast()` is the only supported path, manual Three.js
intersect-tests return wrong IDs for compressed fragments.

## Atlas design tokens

All UI uses design tokens from `frontend/src/index.css` (AMOLED black
base, near-white primary, blue-highlight accent, 4 px grid, radii 3/4/6/9999).

## Testing

- **Vitest** for pure math + controllers. Tests live next to the unit under test in an `__tests__/` folder.
- **Baseline:** the full suite (1,900+ tests) stays green at any point; pre-flight checks run `npm test -- --run`.
- **No browser tests yet.** Playwright E2E is planned but not yet implemented.

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
- COOP / COEP headers enable multi-threaded web-ifc parse.

## Visibility ownership (single-writer contract)

`ViewerPanel.tsx` owns three writers that all reach `model.setVisible(localIds, boolean)` on the same `FragmentsModel`. To stay race-free they obey a strict precedence order:

| Priority | Writer | Fires on | Gate |
|---|---|---|---|
| **1 (highest)** | `applyVisibility(...)`, user isolate / hide / ghost-mode | Zustand `isolatedIds` / `hiddenIds` / `ghostModeOn` change (rAF-coalesced, see `visibilityRebuildHelpers.ts`) | always allowed |
| **2** | `StoreyFrustumCuller.tick(...)`, coarse, per-storey AABB | `controls.controlend` settle (300 ms debounce) | `isolatedIds.length === 0 && hiddenIds.length === 0` |
| **3 (lowest)** | `ElementFrustumCuller.tick(...)`, fine, per-element AABB | same `controlend` settle | same gate as #2 + must cede ids owned by #2 |

There is **no @thatopen-side culler** that independently writes visibility. The built-in `LodMode.DEFAULT` only *respects* `setVisible(...)`, it never sets it. `OBC.SimpleRenderer`'s `cullerPixelsPerMeter` belongs to an unrelated edge-projection pipeline.

A fourth writer (`furnishingMerge.ts`) is a setup/teardown of a draw-call optimisation; it owns its own local-id set for the lifetime of the merge and restores on dispose.

### The contract

- **#1 always wins.** When the user activates isolate or hide, both AABB cullers `clearCull(...)` and stand down. Resuming is allowed once #1 returns to "all visible".
- **#2 owns the coarse partition.** Any element whose storey is currently `autoCulled` by the storey culler is owned by the storey culler. The element culler must not call `setVisible` on those ids in that tick.
- **#3 owns the fine partition.** Within the storey-eligible subset only, the element culler may hide ids whose AABB lies outside the camera frustum and re-show ids whose AABB re-enters.
- **#2 must complete before #3 starts.** The settle handler `await`s the storey tick before the element tick, otherwise the two writers race on overlapping ids and the element culler's `autoCulled` book-keeping drifts out of sync with the model.

### Pure decision helper

`services/viewer/cullerCoordinationHelpers.ts` encodes the contract:

- `decideCullerWork(snapshot)` → `'skip' | 'noop' | 'storey-only' | 'element-only' | 'storey-then-element'`. The settle handler routes on the verb.
- `partitionElementsByOwner(allElementIds, culledStoreyMembers)` → `{ ownedByStorey, eligibleForElement }` (disjoint sets). The element culler filters its records through this before running its frustum tests.
- `decideElementCullerAction({ ownedByStorey, autoCulled, inFrustum })` → `'noop' | 'hide' | 'show' | 'cede-to-storey'`. The single-element verdict.
- `tallyCullerCoordination(stream)` → counts `racingWrites`, `sequencedWrites`, `staleAutoCulled` over a synthetic tick stream. Pin for the regression: the follow-up wire-up must drive `racingWrites` to zero on the same inputs that produce >0 under the current arrangement.

The helper is framework-free (no THREE.js / @thatopen imports) and is wired into `ViewerPanel.tsx`.

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

## Conventions

- **Architecture docs**, orientation before any work. Start with
  `docs/architecture/OVERVIEW.md` and the relevant file in this directory.
- **Prop drilling is fine** for small UI trees; reach for the store only when ≥2 distant components need the same state.
- **No inline styles.** Use Atlas token classes.
- **No `any` except at fragment boundaries.** Document why.
