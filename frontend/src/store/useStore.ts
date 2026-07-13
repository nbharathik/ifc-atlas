import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type {
  ProjectInfo, SpatialNode, ElementDetail, ModelStats, ChatMessage, ToolCall, Viewpoint,
  AgentPreset, ChatAttachment, PendingEditEnvelope, OperationResult,
} from '../types/ifc';
import type { ServerConvertCapabilities } from '../services/ifc/serverConvert';
import { invalidateModelElementDetails } from '../services/ifc/elementDetailInvalidation';
import {
  DEFAULT_PREBUILD_WAIT_PREFS,
  PREBUILD_POLL_MAX_MS,
  PREBUILD_POLL_MIN_MS,
  PREBUILD_TIMEOUT_MAX_MS,
  PREBUILD_TIMEOUT_MIN_MS,
  clampPrebuildPref,
  sanitisePrebuildWaitPrefs,
  type PrebuildWaitPrefs,
} from '../services/ifc/fragmentPrebuildPrefs';
import {
  readMutedKindsFromStorage,
  toggleMutedKind as toggleMutedKindHelper,
  writeMutedKindsToStorage,
  type ActivityKind,
} from '../components/panels/activityFilterHelpers';
import {
  undoLastEdit as apiUndoLastEdit,
  executeOperation as apiExecuteOperation,
  undoOperation as apiUndoOperation,
  redoOperation as apiRedoOperation,
  applyPendingEditWithRetry as apiApplyPendingEdit,
  discardPendingEdit as apiDiscardPendingEdit,
} from '../services/api';
import type { ReadinessStatusDto } from '../services/api';
import {
  EMPTY_HISTORY,
  currentId as historyCurrentId,
  goBack as historyGoBack,
  goForward as historyGoForward,
  pushSelection as historyPushSelection,
  resetHistory,
  type SelectionHistoryState,
} from '../services/viewer/selectionHistoryHelpers';

/**
 * Snapshot of AI backend warm-up state held in the store.
 * Mirrors `/api/ifc/readiness` 1:1; re-exported here so consumers don't
 * have to import the API DTO directly.
 */
export type ReadinessSnapshot = ReadinessStatusDto;

export interface Toast {
  id: string;
  message: string;
  kind: 'success' | 'error' | 'info';
}

export interface PerfMetrics {
  fps: number;
  memoryMb: number | null;
  ttfrMs: number | null;    // Time to first render (viewer init -> first frame)
  ttfgMs: number | null;    // Time to first geometry visible
  loadMs: number | null;    // Total model load time (upload start -> viewer ready)
  drawCalls: number;
  triangles: number;
  cacheHitRate: number | null;
  culledStoreys: number;    // Storeys currently hidden by frustum culler (0 = none / not built)
  culledElements: number;   // Individual elements culled by element-level AABB culler
  // Click-to-highlight: ms from pointerup (after drag-detection) to the
  // resolution of the forced highlight flush (an upper bound a few ms past
  // first paint - see recordClickLatencyFlush in ViewerPanel).
  // Captures fast-picker/raycast race + selectElement + rebuild + flush.
  // null when no click has happened yet OR when last click landed in void.
  // Surfaces in PerformanceHud (budget: <= 50 ms typical / <= 80 ms p95).
  clickToHighlightMs: number | null;
  // Rolling median of the last N click-to-highlight samples (N defined by
  // CLICK_LATENCY_WINDOW_SIZE in clickLatencyHelpers). Quieter than the
  // last-click value used for click-latency measurements.
  // null until enough samples have accumulated to be meaningful.
  clickToHighlightMedianMs: number | null;
  // Worst click-to-highlight reading in the rolling window. Pairs with
  // the median so users can spot one-off spikes the median smooths away.
  // null until the first sample lands.
  clickToHighlightMaxMs: number | null;
  // Rolling p95 of the click-to-highlight window.
  // Less spike-sensitive than max, stricter than median. null until the
  // first sample lands.
  clickToHighlightP95Ms: number | null;
  // Time from streaming-load kickoff to the first batch's first
  // triangle landing in the scene. Only populated when
  // VITE_STREAMING_GEOMETRY=true (off by default in v1.0); null otherwise.
  // Surfaces the "first-triangle latency" the streaming path is meant
  // to deliver on 100 MB+ models.
  firstTriangleMs: number | null;
}

export interface ActivityEntry {
  id: string;
  ts: number;
  kind: 'select' | 'highlight' | 'isolate' | 'hide' | 'show-all' | 'tool' | 'chat' | 'screenshot' | 'view' | 'error' | 'info' | 'edit';
  summary: string;
  detail?: string;
}

export type Theme = 'dark' | 'light';

/** Which panel is currently focused in the tabbed right sidebar. */
export type RightTab = 'props' | 'views' | 'log' | 'chat' | 'tools';

/** Layout mode for the right sidebar. */
export type RightSidebarMode = 'tabs' | 'stacked';

/** Which pane is currently expanded in the collapsible left sidebar. */
export type LeftPane = 'tree' | 'search' | 'summary' | 'classify' | null;

/** The backend feature panels (quantity takeoff, IDS validation, BCF topics,
 *  plugins, 5D cost). Tracked by the single `activeFeaturePanel` field. */
export type FeaturePanel = 'qto' | 'ids' | 'bcf' | 'plugins' | 'cost' | 'carbon' | 'cobie' | 'diff';

/** Tool ids that ride the single `activeFeaturePanel` field (mutually exclusive
 *  with stats/filter/health). Extend this + the union to add a new feature
 *  panel; openTool/toggleTool then route it automatically. */
const FEATURE_PANEL_IDS: readonly FeaturePanel[] = ['qto', 'ids', 'bcf', 'plugins', 'cost', 'carbon', 'cobie', 'diff'];

/** Narrow a ToolId to a FeaturePanel (or null for stats/filter/health). */
function asFeaturePanel(id: string): FeaturePanel | null {
  return (FEATURE_PANEL_IDS as readonly string[]).includes(id) ? (id as FeaturePanel) : null;
}

/** Every tool that docks into the Tools tab: the four feature panels plus the
 *  model panels (statistics / property filter / health). The Tools tab shows
 *  exactly one at a time (its launcher otherwise), so opening one closes the
 *  rest - see openTool/closeTool/toggleTool, which keep the underlying
 *  per-panel open fields mutually exclusive. */
export type ToolId = FeaturePanel | 'stats' | 'filter' | 'health';

/** Derive which tool is docked in the Tools tab from the per-panel open fields
 *  (feature panels take priority, then stats / filter / health). Returns null
 *  when the Tools tab should show its launcher. */
export function activeToolOf(s: {
  activeFeaturePanel: FeaturePanel | null;
  statsPanelOpen: boolean;
  filterPanelOpen: boolean;
  healthPanelOpen: boolean;
}): ToolId | null {
  if (s.activeFeaturePanel) return s.activeFeaturePanel;
  if (s.statsPanelOpen) return 'stats';
  if (s.filterPanelOpen) return 'filter';
  if (s.healthPanelOpen) return 'health';
  return null;
}
export type StartupMode = 'concurrent_fast' | 'full_upfront';
export type ConsistencyMode = 'hybrid' | 'strong' | 'frontend_first';
export type EditFallbackMode = 'background_rebuild' | 'block_until_strong';
export type RendererMode = 'auto' | 'webgl' | 'webgpu';
export type CachePolicy = 'aggressive' | 'balanced' | 'off';
export type HighlightStrategy = 'wireframe' | 'stencil';
export type GraphicsProfile = 'quality' | 'balanced' | 'performance';
/** Runtime viewer performance mode - the single user-facing lever the
 *  interaction-quality ladder follows (wired in a later pass). `auto` lets the
 *  ladder pick quality from live frame-time feedback; the other three pin a
 *  fixed target. Distinct from `GraphicsProfile`, which is a parse-time
 *  conversion-quality preference, not a render-loop quality target. Persists
 *  across sessions. */
export type ViewerPerformanceMode = 'auto' | 'performance' | 'balanced' | 'quality';
export type SelectionFocusMode = 'off' | 'ghost';

/** Axis the clip plane is aligned perpendicular to. 'y' = horizontal cut
 * (cutting off the top of the model); 'x' and 'z' are vertical section
 * cuts along the two horizontal axes. */
export type ClipAxis = 'x' | 'y' | 'z';

/** Measurement tool mode - see services/viewer/measurementController.ts.
 *  `off` is the default and leaves pointer events to selection.
 *  `box` is a 2-click axis-aligned rectangle on the face plane of corner A. */
export type MeasurementMode = 'off' | 'linear' | 'area' | 'box' | 'angle';
/** Display unit for measurement readouts. Length units square for area. */
export type MeasurementUnit = 'm' | 'mm' | 'ft';

/** User-facing measurement-tool state. Only the preferences (mode + unit)
 *  live in the store; the in-flight pending points + committed geometry
 *  are owned by MeasurementController (imperative, THREE-side). The HUD
 *  subscribes to controller snapshots via the registered read fn. */
export interface MeasurementPrefs {
  mode: MeasurementMode;
  unit: MeasurementUnit;
}

/** Which property elements are coloured by in the 3D viewer. `off` = standard materials. */
export type ColourByProperty = 'off' | 'type' | 'storey' | 'material';

/** One paint group inside a colour layer: every express id gets `color`. */
export interface ColourLayerEntry {
  /** CSS hex colour, '#rrggbb'. */
  color: string;
  /** IFC express ids to paint. */
  ids: number[];
}

/** One row of a colour layer's on-screen legend. */
export interface ColourLayerLegendRow {
  color: string;
  label: string;
}

/**
 * A generic viewer colour layer - paint ANY element set with ANY colour.
 * Set via `setColourLayer(id, layer)`; painted over the colour-by overlay
 * and under the chat-cyan / selection-amber highlights. Within a layer,
 * later `entries` win for ids that appear in more than one entry. Layers
 * without a `legend` paint silently (no on-screen legend block).
 */
export interface ColourLayer {
  entries: ColourLayerEntry[];
  /** Optional legend rows rendered by the ColourLayerLegend overlay. */
  legend?: ColourLayerLegendRow[];
  /** Optional display name for the legend header (falls back to the layer id). */
  name?: string;
}

/** One issue in the model health report. */
export interface HealthIssue {
  rule_id: string;
  severity: 'error' | 'warning' | 'info';
  element_id: number | null;
  element_name: string;
  message: string;
}

/** One rule result in the model health report. */
export interface HealthRuleResult {
  rule_id: string;
  severity: 'error' | 'warning' | 'info';
  description: string;
  count: number;
  issues: HealthIssue[];
}

/** Full response from POST /api/ifc/health. */
export interface HealthCheckResult {
  total_issues: number;
  by_severity: { error: number; warning: number; info: number };
  rules: HealthRuleResult[];
  /** Wall-clock time the backend spent running all rules, in milliseconds. */
  duration_ms?: number;
}

/** One section plane entry. `id` is a stable client-side UUID so the
 * multi-plane controller can diff add/update/remove cheaply. `offset` is
 * in world units along the positive axis direction from the model centre. */
export interface ClipPlaneState {
  id: string;
  enabled: boolean;
  axis: ClipAxis;
  offset: number;
  inverted: boolean;
}

/** Maximum number of simultaneous clip planes. */
export const MAX_CLIP_PLANES = 3;

interface AppState {
  // Model state
  project: ProjectInfo | null;
  spatialTree: SpatialNode | null;
  stats: ModelStats | null;
  modelLoaded: boolean;
  loading: boolean;
  ifcFileBytes: Uint8Array | null;  // Raw IFC file for 3D viewer (avoids re-download)
  /** Populated when the background native-index build finishes. */
  nativeIndexReady: { elementCount: number; storeyCount: number; psetCount: number } | null;
  /**
   * AI backend warm-up state shown by the chat-panel readiness chip.
   * `null` until the chat panel first polls /api/ifc/readiness. Polling stops
   * once `ifcopenshell === 'ready'` (or `error`).
   */
  readiness: ReadinessSnapshot | null;
  modelVersion: number;
  modelFingerprint: string | null;
  lastEditId: string | null;

  // Selection
  selectedElementId: number | null;
  selectedElement: ElementDetail | null;
  highlightedIds: number[];
  /** Shift-click multi-select set. Empty = single-select mode (selectedElementId). */
  selectedIds: number[];
  /**
   * Browser-style selection history. Tracks the user's
   * single-element selection over time so `Alt+[` / `Alt+]` can step
   * backward / forward through it. Reset on model unload.
   */
  selectionHistory: SelectionHistoryState;
  /**
   * Sidebar tree: ancestor IDs on the path from root to the currently selected
   * element. Each TreeNode reads its own membership via a boolean selector
   * (`s.forceExpandIds.has(node.id)`) so only nodes whose ancestor-state flipped
   * re-render - Sidebar passing this as a prop would invalidate React.memo for
   * every TreeNode on every selection change.
   */
  forceExpandIds: ReadonlySet<number>;
  /**
   * Bumped every time `setForceExpandIds` runs. Lets TreeNode's auto-expand
   * effect re-fire when a *new path is set that still contains this node* -
   * boolean membership alone is sticky (the node is "still on the path"), so
   * a manually-collapsed ancestor would otherwise stay collapsed.
   */
  forceExpandSerial: number;

  // Visibility control
  isolatedIds: number[];    // If non-empty, only these IDs are visible
  hiddenIds: number[];      // Explicitly hidden IDs

  // UI panels (legacy 'open' flags kept for stacked mode compatibility)
  chatOpen: boolean;
  treeOpen: boolean;
  propsOpen: boolean;
  activityOpen: boolean;
  viewpointsOpen: boolean;

  // New tabbed right-sidebar layout (default mode)
  rightSidebarMode: RightSidebarMode;     // 'tabs' (default) or 'stacked'
  rightSidebarOpen: boolean;              // whether the right sidebar shell is visible at all
  rightActiveTab: RightTab;               // which tab is focused in 'tabs' mode
  lastNonChatTab: RightTab;              // last non-chat tab, restored when detaching chat
  rightSidebarExpanded: boolean;          // when true, right sidebar takes the entire viewport (full-screen panel)

  // New collapsible left-sidebar layout
  leftSidebarOpen: boolean;               // shell visibility (icon rail still shown when open)
  leftActivePane: LeftPane;               // which pane (tree/search) is expanded; null = icon rail only

  // Viewpoints (saved camera + visibility state) for current project
  viewpoints: Viewpoint[];

  // Chat
  chatMessages: ChatMessage[];
  chatLoading: boolean;
  chatProvider: string;
  chatModel: string;
  chatTemperature: number;
  /** Selected Model Registry entry id (Chat Manager > Models tab). Sent as
   *  `model_registry_id` so the backend resolves provider/model/sampling from
   *  the registry. null = legacy provider+model+temperature path. */
  chatModelRegistryId: string | null;
  /** Attachments staged on the input row for the next chat turn. Cleared
   * after the turn is sent. Mirrors ChatAttachment on the backend. */
  chatAttachments: ChatAttachment[];

  // Agent manager
  agents: AgentPreset[];
  agentsLoaded: boolean;
  /** Active agent id (null = backend default). Persisted to localStorage. */
  activeAgentId: string | null;
  /** Active tool-set id - applies to all 3 harnesses. null = no filter (all tools). */
  activeToolSetId: string | null;
  /** Active prompt-library entry id - overrides agent's system prompt for this turn. null = use agent's. */
  activePromptId: string | null;

  // Invariant-4 pending edits (sandbox diffs awaiting Apply/Discard). One
  // envelope per sandboxed proposal; the DiffPreviewPanel walks this list
  // newest-first.  Cleared when a model is reloaded.
  pendingEdits: PendingEditEnvelope[];
  /** Id of the pending edit currently being reviewed (opens the modal);
   *  null = panel dismissed / nothing to review. Legacy modal path; the chat
   *  now approves edits inline (see resolvePendingEdit). */
  activePendingEditId: string | null;
  /** Approval mode for AI edits (persisted). 'ask' = the chat shows an inline
   *  Approve/Discard below the tool call; 'auto' = staged edits are applied
   *  automatically. Selected from the icon next to the model dropdown. */
  editApprovalMode: 'ask' | 'auto';
  setEditApprovalMode: (mode: 'ask' | 'auto') => void;
  /** Resolution per pending edit id, so an inline approval widget can show the
   *  outcome even after the edit leaves `pendingEdits`. */
  pendingEditOutcomes: Record<string, 'applied' | 'discarded' | 'error'>;
  /** Apply or discard a pending edit inline (no modal). Shared by the inline
   *  Approve/Discard buttons and the auto-approve path. Idempotent per id. */
  resolvePendingEdit: (editId: string, action: 'apply' | 'discard') => Promise<void>;

  // UI
  settingsOpen: boolean;
  commandPaletteOpen: boolean;
  /** Keyboard-shortcut reference modal (the `?` help). */
  shortcutsHelpOpen: boolean;
  theme: Theme;
  accentPreset: string;          // accent colour preset id, e.g. 'blue'
  perfHudVisible: boolean;
  perfDashOpen: boolean;
  /** Model health check panel. */
  healthPanelOpen: boolean;
  healthCheckResult: HealthCheckResult | null;
  measurementPanelOpen: boolean;
  measurementLabelsVisible: boolean;
  /** Section box (AABB crop). Toggled via Alt+B. Planes managed by SectionBoxController in ViewerPanel. */
  sectionBoxEnabled: boolean;
  /** Floating chat dock: true = collapsed pill, false = expanded panel. */
  floatingChatMinimized: boolean;
  /** True once the WASM service worker has control of the page (WASM served from cache). */
  swReady: boolean;
  /** Outcome of `navigator.storage.persist()` for the IDB fragment cache.
   *  `null` until the first cache-eligible model load attempts the request.
   *  `'persistent'` means the cache survives storage-pressure eviction;
   *  `'best-effort'` means the UA denied the promotion; `'unavailable'` means
   *  the Storage API is absent (e.g. Safari < 16). Surfaced in Settings >
   *  Performance > Fragment cache as a badge. */
  fragmentCachePersisted: import('../services/viewer/fragmentCacheIDB').PersistedState | null;

  // IFC edit checkpoints
  checkpointPanelOpen: boolean;
  checkpoints: import('../types/ifc').IFCCheckpoint[];
  checkpointsAvailable: boolean;
  checkpointsLoading: boolean;
  setCheckpointPanelOpen: (v: boolean) => void;
  setCheckpoints: (checkpoints: import('../types/ifc').IFCCheckpoint[], available: boolean) => void;
  setCheckpointsLoading: (v: boolean) => void;

  // Budget dashboard
  budgetPanelOpen: boolean;
  setBudgetPanelOpen: (v: boolean) => void;

  // Model statistics panel
  statsPanelOpen: boolean;
  setStatsPanelOpen: (v: boolean) => void;

  // Floating feature panels (QTO / IDS / BCF / Plugins)
  /** Which floating feature panel is open; null = none. All four share one
   *  overlay slot, so this single field enforces "at most one open".
   *  Per-session only - never persisted. */
  activeFeaturePanel: FeaturePanel | null;
  /** Open a feature panel. Toggle semantics: passing the currently-open
   *  panel (or null) closes it. */
  setActiveFeaturePanel: (panel: FeaturePanel | null) => void;

  /** Open a tool in the Tools tab. Makes the per-panel open fields mutually
   *  exclusive (closes every other tool) and focuses the Tools tab so the
   *  docked panel is visible. */
  openTool: (id: ToolId) => void;
  /** Close whatever tool is docked in the Tools tab (back to its launcher).
   *  Leaves the sidebar open. */
  closeTool: () => void;
  /** Toggle a tool: open it (closing others) or, if it is already the active
   *  tool, close it. */
  toggleTool: (id: ToolId) => void;

  // Element filter panel
  filterPanelOpen: boolean;
  setFilterPanelOpen: (v: boolean) => void;
  /** Last filter result: element IDs that matched the property filter. */
  filterResultIds: number[];
  setFilterResultIds: (ids: number[]) => void;

  // Ghost mode
  ghostModeOn: boolean;
  setGhostModeOn: (on: boolean) => void;

  // Prompt snippet panel
  snippetPanelOpen: boolean;
  setSnippetPanelOpen: (v: boolean) => void;
  /** Transient signal: text to insert into the chat textarea. Consumed by ChatPanel. */
  snippetInsertText: string | null;
  setSnippetInsertText: (text: string | null) => void;

  // Chat manager initial section
  /** When set, the ChatManagerPanel reads this on next open and uses it as its initial section. */
  chatManagerInitialSection: string | null;
  setChatManagerInitialSection: (s: string | null) => void;

  // Document index
  docIndexFiles: import('../types/ifc').DocFile[];
  docIndexLoading: boolean;

  // Session memory
  /** Facts accumulated by the agent this WS session (list of human-readable lines). */
  sessionMemoryFacts: string[];
  setSessionMemoryFacts: (facts: string[]) => void;
  clearSessionMemoryFacts: () => void;

  // Chat thread persistence
  /** Stable UUID for the current chat thread. Generated once per browser session
   *  and persisted in localStorage so chat history survives page refreshes. */
  chatThreadId: string;
  /** True after history has been restored from the backend checkpoint this session. */
  chatHistoryRestored: boolean;
  setChatThreadId: (id: string) => void;
  setChatHistoryRestored: (v: boolean) => void;
  /** Replace chatMessages with a restored history snapshot (no loading state
   *  change). The store mints a stable `id` per restored message so callers
   *  pass id-less message objects. */
  restoreThreadHistory: (messages: Omit<ChatMessage, 'id'>[]) => void;

  perfMetrics: PerfMetrics;
  loadStartTs: number | null;
  startupMode: StartupMode;
  consistencyMode: ConsistencyMode;
  editFallback: EditFallbackMode;
  rendererMode: RendererMode;
  cachePolicy: CachePolicy;
  /** Whether to reuse the backend's on-disk fragment cache when loading an
   *  IFC the server has already converted. Enabled by default because the
   *  production load path is backend convert-once plus cached `.frag` reuse.
   *  When false, the viewer bypasses cache read/write via `no_cache=1` and
   *  every load runs a fresh sidecar conversion. */
  useServerCache: boolean;
  highlightStrategy: HighlightStrategy;
  graphicsProfile: GraphicsProfile;
  /** Runtime viewer performance mode (Auto/Performance/Balanced/Quality).
   *  Target the interaction-quality ladder will follow; no rendering is wired
   *  to it yet. Defaults to 'auto'. Persists across sessions. */
  viewerPerformanceMode: ViewerPerformanceMode;
  /** LOD navigation swap: on big models, render a decimated
   *  copy while the camera moves and the full model at rest. Only activates
   *  when the backend serves a decimated fragment (large models) and no
   *  isolation/hide/ghost is active. Persists across sessions. */
  largeModelLod: boolean;
  /** User-tunable budget for the server-side fragment pre-build
   *  wait that fires before the cold-load `/convert` upload. Persists across
   *  sessions. `timeoutMs: 0` disables the wait entirely. */
  prebuildWaitPrefs: PrebuildWaitPrefs;
  setPrebuildWaitTimeoutMs: (ms: number) => void;
  setPrebuildWaitPollIntervalMs: (ms: number) => void;
  resetPrebuildWaitPrefs: () => void;
  selectionFocusMode: SelectionFocusMode;
  selectionGhostOpacity: number;
  /** Whether the AABB frustum cullers (storey + element) are allowed to run.
   *  OFF by default: when off, no geometry is ever `setVisible(false)` for
   *  being out-of-frustum, so objects always stay in the scene and never
   *  "pop in late" when zooming back out. Mixed/large-model users can opt in
   *  via Settings > Performance; even when on, `decideCullerPolicy` keeps the
   *  cullers off for small models. Persists across sessions. */
  frustumCullingEnabled: boolean;
  /** Whether the ground grid is visible in the 3D viewport. Persists across
   *  sessions. On by default (most users prefer a ground reference). */
  gridVisible: boolean;
  /** Whether hover-preview highlight is drawn on the 3D element under the
   *  pointer. On by default - helps users see what they're about to pick.
   *  Persists across sessions. */
  hoverHighlightEnabled: boolean;
  /** Furnishing merge mode: when true, IfcFurnishingElement geometry is
   *  replaced with a single merged static mesh to reduce draw calls. */
  furnishingMerged: boolean;
  setFurnishingMerged: (v: boolean) => void;

  // Colour-by-property overlay (viewer)
  colourBy: ColourByProperty;

  /** Generic colour layers keyed by caller-chosen id (diff overlay, AI
   *  colouring, heatmaps...). Precedence, base to top: colour-by groups ->
   *  colour layers -> chat-cyan highlights -> selection amber. Key order is
   *  paint order; `setColourLayer` moves a re-set id to the END of the key
   *  order, so the last-SET layer wins for overlapping ids. Caveat of JS
   *  object key semantics: integer-like ids ('1', '42') are enumerated
   *  before string ids regardless of set order - prefer non-numeric ids.
   *  Cleared on model unload and on reset(). */
  colourLayers: Record<string, ColourLayer>;

  // Section / clip planes. Array supports up to MAX_CLIP_PLANES simultaneous planes.
  clipPlanes: ClipPlaneState[];
  /** When true the next left-click on the model surface creates a clip plane
   *  at the hit point, aligned to the dominant face normal axis. Resets to
   *  false automatically after the plane is placed. */
  pickPlaneMode: boolean;
  /** Measurement tool preferences. Mode is NOT
   *  persisted - it resets to `off` per session to avoid surprise (a user
   *  returning to the viewer shouldn't find clicks silently placing
   *  rulers). Unit IS persisted. */
  measurement: MeasurementPrefs;
  /** World-units half-extents of the current model's axis-aligned bounding
   *  box. Populated by ViewerPanel once the model is ready; cleared on
   *  reset. Used by the clip-plane slider to pick a sensible drag range
   *  so the plane never flies arbitrarily far from the model. */
  modelHalfExtents: { x: number; y: number; z: number } | null;

  // Activity log (most recent first)
  activity: ActivityEntry[];
  /** Kinds the user has hidden via the Activity Log chip bar. Empty = no filter. */
  activityMutedKinds: ReadonlySet<ActivityKind>;

  // AI-native engine - sidecar capability probe result (null = not yet probed).
  serverConvertCaps: ServerConvertCapabilities | null;

  // Viewer callbacks registered by ViewerPanel so deep components (tree rows,
  // command palette, chat tools) can drive the 3D camera without prop drilling.
  // The function takes an IFC Express ID and animates the camera to frame it.
  zoomToElementFn: ((expressId: number) => void) | null;
  /** Frame the camera on N elements via merged bbox. Registered by ViewerPanel. */
  frameElementsFn: ((expressIds: number[]) => void) | null;
  /** Registered by ViewerPanel; enables the section box fitted to a single element's AABB. */
  clipToElementFn: ((expressId: number) => void) | null;
  /** Soft amber preview highlight driven by sidebar tree-row hover.
   *  `null` clears the current preview.  Registered by ViewerPanel. */
  treeHoverPreviewFn: ((expressId: number | null) => void) | null;
  /** Returns current camera position + target; registered by ViewerPanel. */
  getCameraStateFn: (() => { pos: [number, number, number]; target: [number, number, number] } | null) | null;
  /** Animates camera to a position/target; registered by ViewerPanel. */
  setLookAtFn: ((pos: [number,number,number], tgt: [number,number,number], animate: boolean) => void) | null;

  // Actions
  setProject: (p: ProjectInfo) => void;
  setSpatialTree: (t: SpatialNode | null) => void;
  setStats: (s: ModelStats | null) => void;
  setModelLoaded: (v: boolean) => void;
  setLoading: (v: boolean) => void;
  setNativeIndexReady: (info: { elementCount: number; storeyCount: number; psetCount: number } | null) => void;
  /** Replace the AI-readiness snapshot (called by the chat panel after each /readiness poll). */
  setReadiness: (snap: ReadinessSnapshot | null) => void;
  setIfcFileBytes: (bytes: Uint8Array | null) => void;
  setModelContract: (contract: { model_version: number; model_fingerprint: string; edit_id?: string | null }) => void;
  selectElement: (id: number | null) => void;
  /**
   * Step backward / forward through the selection-history stack.
   * Returns the express ID that became active, or `null` if the stack edge
   * was already reached (no-op). Caller can use the return value to e.g.
   * raycast-zoom to the new selection.
   */
  navigateSelectionHistory: (direction: 'back' | 'forward') => number | null;
  setSelectedElement: (e: ElementDetail | null) => void;
  setHighlightedIds: (ids: number[]) => void;
  /** Flash-highlight a set of IDs for a brief duration, then clear. Used by entity_delta handler. */
  flashHighlightIds: (ids: number[], durationMs?: number) => void;
  /** Toggle an element in/out of the multi-select set (Shift+click). */
  toggleSelectId: (id: number) => void;
  /** Clear the multi-select set (does not affect selectedElementId). */
  clearSelectedIds: () => void;
  /**
   * Replace the multi-select set wholesale (viewer bridge / AI commands).
   * Keeps selectedElementId when it is already in the new set, else falls
   * back to the first id. Single-select side effects (history, tree
   * expansion, properties) stay with selectElement - bridge callers select
   * a primary first, then replace the set.
   */
  setSelectedIds: (ids: number[]) => void;
  setIsolatedIds: (ids: number[]) => void;
  setHiddenIds: (ids: number[]) => void;
  addHiddenIds: (ids: number[]) => void;
  clearVisibility: () => void;
  /** Replace the sidebar tree's force-expand path set (root to selected element). */
  setForceExpandIds: (ids: ReadonlySet<number>) => void;
  toggleChat: () => void;
  toggleTree: () => void;
  toggleProps: () => void;
  toggleActivity: () => void;
  toggleViewpoints: () => void;

  // New tabbed-layout actions
  setRightSidebarMode: (m: RightSidebarMode) => void;
  setRightSidebarOpen: (v: boolean) => void;
  setRightActiveTab: (t: RightTab) => void;
  /** Focus a tab; if it's already active and sidebar is open, close the sidebar. */
  focusRightTab: (t: RightTab) => void;
  toggleRightSidebarExpanded: () => void;
  setRightSidebarExpanded: (v: boolean) => void;

  setLeftSidebarOpen: (v: boolean) => void;
  setLeftActivePane: (p: LeftPane) => void;
  /** Focus a pane; if already active, collapse to icon rail. */
  focusLeftPane: (p: 'tree' | 'search' | 'summary' | 'classify') => void;

  // Viewpoints actions
  loadViewpointsForProject: (projectKey: string) => void;
  saveViewpoint: (vp: Viewpoint) => void;
  deleteViewpoint: (id: string) => void;
  renameViewpoint: (id: string, name: string) => void;
  /** Appends a chat message; the store mints a stable `id` so callers
   *  construct id-less message objects. */
  addChatMessage: (msg: Omit<ChatMessage, 'id'>) => void;
  updateLastAssistantMessage: (content: string) => void;
  setLastMessageUsage: (usage: import('../types/ifc').ChatUsage) => void;
  /** Budget warning state. Cleared when a new chat turn starts. */
  budgetWarning: import('../types/ifc').BudgetWarning | null;
  setBudgetWarning: (w: import('../types/ifc').BudgetWarning | null) => void;
  /** Model fallback active this turn. */
  activeFallbackModel: import('../types/ifc').ModelFallback | null;
  setActiveFallbackModel: (f: import('../types/ifc').ModelFallback | null) => void;
  addToolCallToLastMessage: (toolCall: ToolCall) => void;
  updateLastToolCallResult: (result: string, executedOn?: 'client' | 'server') => void;
  setChatLoading: (v: boolean) => void;
  setChatProvider: (p: string) => void;
  setChatModel: (m: string) => void;
  setChatTemperature: (t: number) => void;
  setChatModelRegistryId: (id: string | null) => void;
  addChatAttachment: (att: ChatAttachment) => void;
  removeChatAttachment: (index: number) => void;
  clearChatAttachments: () => void;
  setAgents: (agents: AgentPreset[]) => void;
  upsertAgent: (agent: AgentPreset) => void;
  removeAgent: (agentId: string) => void;
  setActiveAgentId: (id: string | null) => void;
  setActiveToolSetId: (id: string | null) => void;
  setActivePromptId: (id: string | null) => void;
  /** Insert or refresh a pending edit envelope by id. */
  upsertPendingEdit: (envelope: PendingEditEnvelope) => void;
  /** Drop a pending edit (after Apply/Discard, or when the model reloads). */
  removePendingEdit: (editId: string) => void;
  setActivePendingEditId: (id: string | null) => void;
  setSettingsOpen: (v: boolean) => void;
  setCommandPaletteOpen: (v: boolean) => void;
  setShortcutsHelpOpen: (v: boolean) => void;
  setTheme: (t: Theme) => void;
  setAccentPreset: (id: string) => void;
  setPerfHudVisible: (v: boolean) => void;
  setPerfDashOpen: (v: boolean) => void;
  setHealthPanelOpen: (v: boolean) => void;
  setHealthCheckResult: (r: HealthCheckResult | null) => void;
  setMeasurementPanelOpen: (v: boolean) => void;
  setMeasurementLabelsVisible: (v: boolean) => void;
  setSectionBoxEnabled: (enabled: boolean) => void;
  toggleSectionBox: () => void;
  setFloatingChatMinimized: (v: boolean) => void;
  /** Whether the viewer tools tray (floating, left of viewport) is expanded into the full panel. */
  viewerToolsOpen: boolean;
  setViewerToolsOpen: (v: boolean) => void;
  /** Whether the viewer tools tray is fully hidden (only the pull-tab is visible). */
  viewerToolsHidden: boolean;
  setViewerToolsHidden: (v: boolean) => void;
  /** Progressive storey-reveal animation: enabled by user (persisted), active right now. */
  streamingRevealEnabled: boolean;
  setStreamingRevealEnabled: (v: boolean) => void;
  streamingRevealActive: boolean;
  setStreamingRevealActive: (v: boolean) => void;
  /** Whether the full-screen Agent Manager is open. */
  agentManagerOpen: boolean;
  setAgentManagerOpen: (v: boolean) => void;
  setSwReady: (v: boolean) => void;
  /** Setter for the IDB fragment cache's persistent-storage promotion state. */
  setFragmentCachePersisted: (
    state: import('../services/viewer/fragmentCacheIDB').PersistedState | null,
  ) => void;
  // Document Index
  setDocIndexFiles: (files: import('../types/ifc').DocFile[]) => void;
  addDocIndexFile: (file: import('../types/ifc').DocFile) => void;
  removeDocIndexFile: (docId: string) => void;
  setDocIndexLoading: (v: boolean) => void;
  updatePerfMetrics: (m: Partial<PerfMetrics>) => void;
  setLoadStartTs: (ts: number | null) => void;
  setStartupMode: (m: StartupMode) => void;
  setConsistencyMode: (m: ConsistencyMode) => void;
  setEditFallback: (m: EditFallbackMode) => void;
  setRendererMode: (m: RendererMode) => void;
  setCachePolicy: (p: CachePolicy) => void;
  setUseServerCache: (enabled: boolean) => void;
  setHighlightStrategy: (s: HighlightStrategy) => void;
  setGraphicsProfile: (p: GraphicsProfile) => void;
  setViewerPerformanceMode: (mode: ViewerPerformanceMode) => void;
  setLargeModelLod: (v: boolean) => void;
  setSelectionFocusMode: (m: SelectionFocusMode) => void;
  setSelectionGhostOpacity: (opacity: number) => void;
  setFrustumCullingEnabled: (enabled: boolean) => void;
  setGridVisible: (visible: boolean) => void;
  toggleGrid: () => void;
  setHoverHighlightEnabled: (enabled: boolean) => void;
  toggleHoverHighlight: () => void;
  /** Switch the colour-by-property overlay (or turn it off). */
  setColourBy: (property: ColourByProperty) => void;
  /** Create or replace a colour layer. Re-setting an existing id moves the
   *  layer to the end of the paint order (last set wins on overlapping ids). */
  setColourLayer: (id: string, layer: ColourLayer) => void;
  /** Remove one colour layer. No-op (no repaint) when the id is unknown. */
  clearColourLayer: (id: string) => void;
  /** Remove every colour layer. No-op (no repaint) when none are active. */
  clearAllColourLayers: () => void;
  /** Add a new clip plane (up to MAX_CLIP_PLANES). No-op if already at limit. */
  addClipPlane: () => void;
  /** Add a clip plane positioned at a specific axis + offset (from surface pick). */
  addClipPlaneAt: (axis: ClipAxis, offset: number) => void;
  /** Enter / exit pick-plane mode. In pick mode the next click on the model
   *  surface places a clip plane at the hit point. */
  setPickPlaneMode: (enabled: boolean) => void;
  /** Remove a clip plane by id. */
  removeClipPlane: (id: string) => void;
  /** Partial merge patch for a plane by id. Switching axis resets offset to 0. */
  updateClipPlane: (id: string, patch: Partial<Omit<ClipPlaneState, 'id'>>) => void;
  /** Compat shim - patches the first (primary) plane. */
  setClipPlane: (patch: Partial<Omit<ClipPlaneState, 'id'>>) => void;
  /** Convenience for the keyboard shortcut (X). Toggles the first plane's enabled state. */
  toggleClipPlane: () => void;
  /** Partial merge patch for the measurement preferences. */
  setMeasurement: (patch: Partial<MeasurementPrefs>) => void;
  /** Shortcut for the mode picker - writes `mode` and keeps other prefs. */
  setMeasurementMode: (mode: MeasurementMode) => void;
  /** Set by the viewer once the model has been framed. Null on reset. */
  setModelHalfExtents: (ext: { x: number; y: number; z: number } | null) => void;
  logActivity: (entry: Omit<ActivityEntry, 'id' | 'ts'>) => void;
  clearActivity: () => void;
  /** Toggle a single activity kind in / out of the muted set. Persisted. */
  toggleActivityKindMute: (kind: ActivityKind) => void;
  /** Reset filter - show every kind again. Persisted. */
  clearActivityKindMutes: () => void;
  setServerConvertCaps: (caps: ServerConvertCapabilities | null) => void;
  /** Registered by ViewerPanel on mount; cleared on unmount. */
  setZoomToElementFn: (fn: ((expressId: number) => void) | null) => void;
  /** Thin wrapper: calls the registered fn if present, logs a no-op otherwise. */
  zoomToElement: (expressId: number) => void;
  /** Registered by ViewerPanel; frames N elements via merged bbox. */
  setFrameElementsFn: (fn: ((expressIds: number[]) => void) | null) => void;
  /** Thin wrapper: no-op if no element ids supplied or the fn is unset. */
  frameElements: (expressIds: number[]) => void;
  /** Registered by ViewerPanel; fits the section box to a single element's AABB. */
  setClipToElementFn: (fn: ((expressId: number) => void) | null) => void;
  /** Thin wrapper: calls the registered fn if present. */
  clipToElement: (expressId: number) => void;
  /** Registered by ViewerPanel; paints / clears the soft amber preview. */
  setTreeHoverPreviewFn: (fn: ((expressId: number | null) => void) | null) => void;
  /** Thin wrapper for tree-row hover handlers; pass `null` to clear. */
  treeHoverPreview: (expressId: number | null) => void;

  // Undo
  /** True while a POST /api/ifc/undo request is in flight (prevents double-trigger). */
  isUndoing: boolean;
  setIsUndoing: (v: boolean) => void;
  /** Invoke backend undo, show a toast, and emit metadata_changed to update tree/props. */
  undoLastEdit: () => Promise<void>;

  // Editor (operation layer) - human direct edits (ADR 003, Invariant 12).
  // Gated by the BACKEND's EDIT_MODE_ENABLED flag, probed at runtime via
  // /api/ifc/edit-state into editModeAvailable, so the two sides can never
  // disagree (the old compile-time frontend constant could).
  /** Backend EDIT_MODE_ENABLED (runtime probe). False until the probe lands;
   *  always false in BROWSER_ONLY builds (no backend to probe). */
  editModeAvailable: boolean;
  setEditModeAvailable: (v: boolean) => void;
  /** True when the working copy has unsaved edits (backend dirty flag,
   *  refreshed after every mutation). Drives the Save badge + close guards. */
  modelDirty: boolean;
  /** Debounced re-probe of /api/ifc/edit-state → editModeAvailable +
   *  modelDirty. Call after anything that may change the dirty flag. */
  refreshEditState: () => void;
  /** True when the editor is in Edit mode (editable fields, gizmos). */
  editMode: boolean;
  setEditMode: (v: boolean) => void;
  toggleEditMode: () => void;
  /** Edit scope (see dev/docs/EDIT_SCOPES.md). 'semantic' (default) = metadata
   *  edits only, which update the viewer in place with NO reload. 'structural'
   *  (beta) = also geometry edits (walls, delete), which reload the 3D viewer.
   *  Gates the wall-draw tool and the AI's structural write tools; persisted. */
  editScope: 'semantic' | 'structural';
  setEditScope: (scope: 'semantic' | 'structural') => void;
  /** Bumped whenever cached details for the SELECTED element are invalidated,
   *  so PropertiesPanel re-fetches even though selectedElementId is unchanged
   *  (fixes the blank-panel-after-commit dead end). */
  detailRefreshSerial: number;
  /** Whether a redo is currently armed (from the last operation response). */
  canRedo: boolean;
  /** Run one model operation as a human direct edit (actor=USER). Returns the
   *  result, or null on a transport error (403 gated / 400 no model). Adopts
   *  the fresh model contract from the response; the backend also emits the
   *  sync event that refreshes the tree + properties. */
  applyOperation: (operation: string, params: Record<string, unknown>) => Promise<OperationResult | null>;
  /** Redo the most recently undone operation (op layer; Ctrl+Y). */
  redoLastEdit: () => Promise<void>;

  // Toasts
  toasts: Toast[];
  addToast: (message: string, kind?: Toast['kind']) => void;
  removeToast: (id: string) => void;
  /** Registered by ViewerPanel so share-link can read current camera. */
  setGetCameraStateFn: (fn: (() => { pos: [number, number, number]; target: [number, number, number] } | null) | null) => void;
  /** Registered by ViewerPanel so share-link restore can animate camera. */
  setSetLookAtFn: (fn: ((pos: [number,number,number], tgt: [number,number,number], animate: boolean) => void) | null) => void;
  /** Encode current viewer state to URL hash and copy to clipboard. */
  copyShareLink: () => Promise<void>;
  /** Patch one node's name in the in-memory spatial tree after a rename edit.
   *  Walks the tree recursively; no-ops if the id isn't found. */
  patchSpatialTreeNodeName: (id: number, newName: string) => void;
  /** Invalidate cached element detail for a set of changed IDs.
   *  If the currently-selected element is in the set, clears selectedElement
   *  so PropertiesPanel re-fetches on next render. */
  invalidateElementDetails: (changedIds: number[]) => void;
  clearChat: () => void;
  reset: () => void;
}

const initialPerf: PerfMetrics = {
  fps: 0,
  memoryMb: null,
  ttfrMs: null,
  ttfgMs: null,
  loadMs: null,
  drawCalls: 0,
  triangles: 0,
  cacheHitRate: null,
  culledStoreys: 0,
  culledElements: 0,
  clickToHighlightMs: null,
  clickToHighlightMedianMs: null,
  clickToHighlightMaxMs: null,
  clickToHighlightP95Ms: null,
  firstTriangleMs: null,
};

// Perf-metric fields whose store writes are gated behind the perf-UI gate
// (perfHudVisible || perfDashOpen). These come from the high-frequency
// click-latency probe and culler ticks; when the HUD is closed they are
// dropped in updatePerfMetrics so whole-object perfMetrics subscribers don't
// re-render on every click / culler tick. The probe keeps its own in-ref
// rolling window, so the median/max values are unaffected by skipping the
// store write. Load metrics + the FPS sampler are intentionally excluded.
const PERF_GATED_KEYS: readonly (keyof PerfMetrics)[] = [
  'clickToHighlightMs',
  'clickToHighlightMedianMs',
  'clickToHighlightMaxMs',
  'clickToHighlightP95Ms',
  'culledStoreys',
  'culledElements',
];

// Persisted user preferences (read once at module load)
function readPref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    if (v == null) return fallback;
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

function writePref(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

const VIEWPOINTS_STORAGE_KEY = 'pref.viewpoints.v1';

function readAllViewpoints(): Record<string, Viewpoint[]> {
  try {
    const raw = localStorage.getItem(VIEWPOINTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function writeAllViewpoints(all: Record<string, Viewpoint[]>) {
  try {
    localStorage.setItem(VIEWPOINTS_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Likely quota exceeded -- try dropping thumbnails to save space
    try {
      const lite: Record<string, Viewpoint[]> = {};
      for (const [k, arr] of Object.entries(all)) {
        lite[k] = arr.map((v) => ({ ...v, thumbnail: null }));
      }
      localStorage.setItem(VIEWPOINTS_STORAGE_KEY, JSON.stringify(lite));
    } catch {
      /* give up */
    }
  }
}

function persistProjectViewpoints(projectKey: string, list: Viewpoint[]) {
  const all = readAllViewpoints();
  if (list.length === 0) {
    delete all[projectKey];
  } else {
    all[projectKey] = list;
  }
  writeAllViewpoints(all);
}

const initialState = {
  project: null,
  spatialTree: null,
  stats: null,
  modelLoaded: false,
  loading: false,
  ifcFileBytes: null as Uint8Array | null,
  nativeIndexReady: null as { elementCount: number; storeyCount: number; psetCount: number } | null,
  readiness: null as ReadinessSnapshot | null,
  modelVersion: 0,
  modelFingerprint: null as string | null,
  lastEditId: null as string | null,
  selectedElementId: null,
  selectedElement: null,
  highlightedIds: [] as number[],
  selectedIds: [] as number[],
  selectionHistory: EMPTY_HISTORY,
  forceExpandIds: new Set<number>() as ReadonlySet<number>,
  forceExpandSerial: 0,
  isolatedIds: [] as number[],
  hiddenIds: [] as number[],
  chatOpen: true,
  treeOpen: true,
  propsOpen: true,
  activityOpen: false,
  viewpointsOpen: false,

  // New layout defaults
  rightSidebarMode: readPref<RightSidebarMode>('pref.rightSidebarMode', 'tabs'),
  rightSidebarOpen: readPref<boolean>('pref.rightSidebarOpen', true),
  rightActiveTab: readPref<RightTab>('pref.rightActiveTab', 'props'),
  lastNonChatTab: 'props' as RightTab,
  rightSidebarExpanded: false,           // never persisted; full-screen is per-session
  leftSidebarOpen: readPref<boolean>('pref.leftSidebarOpen', true),
  leftActivePane: readPref<LeftPane>('pref.leftActivePane', 'tree'),

  viewpoints: [] as Viewpoint[],
  chatMessages: [] as ChatMessage[],
  chatLoading: false,
  chatProvider: readPref<string>('pref.chatProvider', 'openai'),
  chatModel: readPref<string>('pref.chatModel', 'gpt-4o'),
  chatTemperature: readPref<number>('pref.chatTemperature', 0.3),
  chatModelRegistryId: readPref<string | null>('pref.chatModelRegistryId', null),
  chatAttachments: [] as ChatAttachment[],
  agents: [] as AgentPreset[],
  agentsLoaded: false,
  activeAgentId: readPref<string | null>('pref.activeAgentId', null),
  activeToolSetId: readPref<string | null>('pref.activeToolSetId', null),
  activePromptId: readPref<string | null>('pref.activePromptId', null),
  pendingEdits: [] as PendingEditEnvelope[],
  editApprovalMode: readPref<'ask' | 'auto'>('pref.editApprovalMode', 'ask'),
  pendingEditOutcomes: {} as Record<string, 'applied' | 'discarded' | 'error'>,
  editMode: false,
  editModeAvailable: false,
  editScope: readPref<'semantic' | 'structural'>('pref.editScope', 'semantic'),
  modelDirty: false,
  detailRefreshSerial: 0,
  canRedo: false,
  activePendingEditId: null as string | null,
  budgetWarning: null as import('../types/ifc').BudgetWarning | null,
  activeFallbackModel: null as import('../types/ifc').ModelFallback | null,
  settingsOpen: false,
  commandPaletteOpen: false,
  shortcutsHelpOpen: false,
  theme: readPref<Theme>('pref.theme', 'dark'),
  accentPreset: readPref<string>('pref.accentPreset', 'blue'),
  perfHudVisible: readPref<boolean>('pref.perfHudVisible', false),
  perfDashOpen: false,
  healthPanelOpen: false,
  healthCheckResult: null,
  measurementPanelOpen: false,
  isUndoing: false,
  toasts: [] as Toast[],
  measurementLabelsVisible: true,
  sectionBoxEnabled: false,
  floatingChatMinimized: readPref<boolean>('pref.floatingChatMinimized', true),
  viewerToolsOpen: false,
  viewerToolsHidden: false,
  // Default off - the storey-by-storey reveal made the model feel like
  // it loaded in batches. Show the whole model at once when ready.
  streamingRevealEnabled: false,
  streamingRevealActive: false,
  agentManagerOpen: false,
  swReady: false,
  fragmentCachePersisted: null,
  checkpointPanelOpen: false,
  checkpoints: [],
  checkpointsAvailable: false,
  checkpointsLoading: false,
  budgetPanelOpen: false,
  statsPanelOpen: false,
  activeFeaturePanel: null as FeaturePanel | null,
  filterPanelOpen: false,
  filterResultIds: [] as number[],
  ghostModeOn: false,
  snippetPanelOpen: false,
  snippetInsertText: null as string | null,
  chatManagerInitialSection: null as string | null,
  docIndexFiles: [],
  docIndexLoading: false,
  sessionMemoryFacts: [] as string[],
  chatThreadId: (() => {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('ifc-viewer-chat-thread') : null;
    if (stored) return stored;
    const id = crypto.randomUUID();
    if (typeof localStorage !== 'undefined') localStorage.setItem('ifc-viewer-chat-thread', id);
    return id;
  })(),
  chatHistoryRestored: false,
  perfMetrics: initialPerf,
  loadStartTs: null as number | null,
  startupMode: readPref<StartupMode>('pref.startupMode', 'concurrent_fast'),
  consistencyMode: readPref<ConsistencyMode>('pref.consistencyMode', 'hybrid'),
  editFallback: readPref<EditFallbackMode>('pref.editFallback', 'background_rebuild'),
  rendererMode: readPref<RendererMode>('pref.rendererMode', 'auto'),
  // Cache OFF by default - the IDB fragment cache caused real-world load
  // failures (stale bytes, schema mismatch, hard-to-clear poisoned entries).
  // Users can opt in via Settings > Performance once their setup is stable.
  cachePolicy: readPref<CachePolicy>('pref.cachePolicy', 'off'),
  // Server-side fragment cache ON by default. This matches the intended
  // backend convert-once architecture and makes repeat loads hit cached
  // `.frag` bytes instead of forcing `no_cache=1` conversions.
  useServerCache: readPref<boolean>('pref.useServerCache', true),
  highlightStrategy: readPref<HighlightStrategy>('pref.highlightStrategy', 'wireframe'),
  graphicsProfile: readPref<GraphicsProfile>('pref.graphicsProfile', 'balanced'),
  viewerPerformanceMode: readPref<ViewerPerformanceMode>('pref.viewerPerformanceMode', 'auto'),
  largeModelLod: readPref<boolean>('pref.largeModelLod', true),
  prebuildWaitPrefs: sanitisePrebuildWaitPrefs(
    readPref<Partial<PrebuildWaitPrefs> | null>('pref.prebuildWait.v1', null),
  ),
  selectionFocusMode: readPref<SelectionFocusMode>('pref.selectionFocusMode', 'off'),
  selectionGhostOpacity: readPref<number>('pref.selectionGhostOpacity', 0.22),
  // Frustum culling OFF by default - objects always stay in the scene (no
  // "pop in late" flicker on zoom-out). Opt-in for large models.
  frustumCullingEnabled: readPref<boolean>('pref.frustumCullingEnabled', false),
  gridVisible: readPref<boolean>('pref.gridVisible', true),
  // Hover preview highlight OFF by default - opt-in via the toolbar or
  // Settings -> Viewer.
  hoverHighlightEnabled: readPref<boolean>('pref.hoverHighlightEnabled', false),
  furnishingMerged: readPref<boolean>('pref.furnishingMerged', false),
  colourBy: 'off' as ColourByProperty,
  colourLayers: {} as Record<string, ColourLayer>,
  clipPlanes: (() => {
    // Migrate legacy single-plane pref (v1) into the new array format
    const v1 = readPref<{ enabled: boolean; axis: ClipAxis; offset: number; inverted: boolean } | null>('pref.clipPlane.v1', null);
    const primary: ClipPlaneState = v1
      ? { id: 'primary', ...v1 }
      : { id: 'primary', enabled: false, axis: 'y', offset: 0, inverted: false };
    return [primary];
  })(),
  measurement: {
    mode: 'off' as MeasurementMode, // never persisted, see comment on MeasurementPrefs
    unit: readPref<MeasurementUnit>('pref.measurement.unit', 'm'),
  },
  pickPlaneMode: false,
  modelHalfExtents: null as { x: number; y: number; z: number } | null,
  activity: [] as ActivityEntry[],
  activityMutedKinds: readMutedKindsFromStorage() as ReadonlySet<ActivityKind>,
  serverConvertCaps: null as ServerConvertCapabilities | null,
  zoomToElementFn: null as ((expressId: number) => void) | null,
  frameElementsFn: null as ((expressIds: number[]) => void) | null,
  clipToElementFn: null as ((expressId: number) => void) | null,
  treeHoverPreviewFn: null as ((expressId: number | null) => void) | null,
  getCameraStateFn: null as (() => { pos: [number, number, number]; target: [number, number, number] } | null) | null,
  setLookAtFn: null as ((pos: [number,number,number], tgt: [number,number,number], animate: boolean) => void) | null,
};

let activitySeq = 0;

export const useStore = create<AppState>()(
  subscribeWithSelector((set) => ({
    ...initialState,

    setProject: (p) => set({ project: p }),
    setSpatialTree: (t) => set({ spatialTree: t }),
    setStats: (s) => set({ stats: s }),
    setModelLoaded: (v) => set((s) => ({
      modelLoaded: v,
      // Clear stale health result whenever a model is unloaded.
      healthCheckResult: v ? s.healthCheckResult : null,
      // Disable the section box on unload - stale clip planes confuse the next model.
      sectionBoxEnabled: v ? s.sectionBoxEnabled : false,
      // Clear stale checkpoints on unload.
      checkpoints: v ? s.checkpoints : [],
      // Clear native index status on unload so the next model starts fresh.
      nativeIndexReady: v ? s.nativeIndexReady : null,
      // Clear AI-readiness snapshot on unload - chip remounts on next upload.
      readiness: v ? s.readiness : null,
      // Drop selection history on unload - old express IDs would point at the wrong elements in the next model.
      selectionHistory: v ? s.selectionHistory : resetHistory(),
      // Reset the tree's force-expand set on unload so the next model's tree starts collapsed-by-default.
      forceExpandIds: v ? s.forceExpandIds : new Set<number>(),
      // Drop colour layers on unload - stale express ids would paint the wrong elements in the next model.
      colourLayers: v ? s.colourLayers : {},
    })),
    setLoading: (v) => set({ loading: v }),
    setNativeIndexReady: (info) => set({ nativeIndexReady: info }),
    setReadiness: (snap) => set({ readiness: snap }),
    setIfcFileBytes: (bytes) => set({ ifcFileBytes: bytes }),
    setModelContract: (contract) => set({
      modelVersion: contract.model_version,
      modelFingerprint: contract.model_fingerprint,
      lastEditId: contract.edit_id ?? null,
    }),
    selectElement: (id) => set((s) => {
      // Push every concrete selection onto the history stack so
      // the user can navigate back/forward via Alt+[/Alt+]. Re-clicking the
      // active element is a no-op inside the helper, so no churn.
      const nextHistory = id !== null
        ? historyPushSelection(s.selectionHistory, id)
        : s.selectionHistory;
      return { selectedElementId: id, selectedIds: [], selectionHistory: nextHistory };
    }),
    navigateSelectionHistory: (direction) => {
      const state = useStore.getState();
      const next = direction === 'back'
        ? historyGoBack(state.selectionHistory)
        : historyGoForward(state.selectionHistory);
      // Helper returns the same reference when at the edge - short-circuit.
      if (next === state.selectionHistory) return null;
      const id = historyCurrentId(next);
      // Update history *and* the active selection together. We bypass
      // `selectElement` so the navigation step doesn't re-push (which would
      // be a no-op anyway, but this keeps the intent explicit).
      set({ selectionHistory: next, selectedElementId: id, selectedIds: [] });
      return id;
    },
    setSelectedElement: (e) => set({ selectedElement: e }),
    setHighlightedIds: (ids) => set({ highlightedIds: ids }),
    flashHighlightIds: (ids, durationMs = 250) => {
      set({ highlightedIds: ids });
      setTimeout(() => {
        // Only clear if the highlight hasn't been overwritten since the flash started.
        const current = useStore.getState().highlightedIds;
        if (current === ids || (current.length === ids.length && current.every((v, i) => v === ids[i]))) {
          set({ highlightedIds: [] });
        }
      }, durationMs);
    },
    toggleSelectId: (id) => set((s) => {
      const has = s.selectedIds.includes(id);
      const next = has
        ? s.selectedIds.filter((x) => x !== id)
        : [...s.selectedIds, id];
      // Keep selectedElementId in sync with the last-toggled id
      return { selectedIds: next, selectedElementId: next.length > 0 ? next[next.length - 1] : s.selectedElementId };
    }),
    clearSelectedIds: () => set({ selectedIds: [] }),
    setSelectedIds: (ids) => set((s) => {
      if (ids.length === 0) return { selectedIds: [] };
      const primaryStays = s.selectedElementId != null && ids.includes(s.selectedElementId);
      return {
        selectedIds: ids,
        selectedElementId: primaryStays ? s.selectedElementId : ids[0],
      };
    }),
    setForceExpandIds: (ids) => set((s) => ({
      forceExpandIds: ids,
      forceExpandSerial: s.forceExpandSerial + 1,
    })),
    setIsolatedIds: (ids) => set({ isolatedIds: ids, hiddenIds: [] }),
    setHiddenIds: (ids) => set({ hiddenIds: ids }),
    addHiddenIds: (ids) => set((s) => {
      const merged = new Set([...s.hiddenIds, ...ids]);
      return { hiddenIds: Array.from(merged), isolatedIds: [] };
    }),
    clearVisibility: () => set({ isolatedIds: [], hiddenIds: [], ghostModeOn: false }),
    toggleChat: () => set((s) => ({ chatOpen: !s.chatOpen })),
    toggleTree: () => set((s) => ({ treeOpen: !s.treeOpen })),
    toggleProps: () => set((s) => ({ propsOpen: !s.propsOpen })),
    toggleActivity: () => set((s) => ({ activityOpen: !s.activityOpen })),
    toggleViewpoints: () => set((s) => ({ viewpointsOpen: !s.viewpointsOpen })),

    setRightSidebarMode: (m) => {
      writePref('pref.rightSidebarMode', m);
      set({ rightSidebarMode: m });
    },
    setRightSidebarOpen: (v) => {
      writePref('pref.rightSidebarOpen', v);
      set({ rightSidebarOpen: v, rightSidebarExpanded: v ? useStore.getState().rightSidebarExpanded : false });
    },
    setRightActiveTab: (t) => {
      writePref('pref.rightActiveTab', t);
      set((s) => ({
        rightActiveTab: t,
        ...(t !== 'chat' ? { lastNonChatTab: t } : {}),
      }));
    },
    focusRightTab: (t) => set((s) => {
      writePref('pref.rightActiveTab', t);
      writePref('pref.rightSidebarOpen', true);
      return {
        rightSidebarOpen: true,
        rightActiveTab: t,
        ...(t !== 'chat' ? { lastNonChatTab: t } : {}),
      };
    }),
    toggleRightSidebarExpanded: () => set((s) => ({
      rightSidebarExpanded: !s.rightSidebarExpanded,
      rightSidebarOpen: !s.rightSidebarExpanded ? true : s.rightSidebarOpen,
    })),
    setRightSidebarExpanded: (v) => set({ rightSidebarExpanded: v }),

    setLeftSidebarOpen: (v) => {
      writePref('pref.leftSidebarOpen', v);
      set({ leftSidebarOpen: v });
    },
    setLeftActivePane: (p) => {
      writePref('pref.leftActivePane', p);
      set({ leftActivePane: p });
    },
    focusLeftPane: (p) => set((s) => {
      if (!s.leftSidebarOpen) {
        writePref('pref.leftSidebarOpen', true);
        writePref('pref.leftActivePane', p);
        return { leftSidebarOpen: true, leftActivePane: p };
      }
      // Same pane already active => collapse to icon rail (or hide entirely)
      if (s.leftActivePane === p) {
        writePref('pref.leftActivePane', null);
        return { leftActivePane: null };
      }
      writePref('pref.leftActivePane', p);
      return { leftActivePane: p };
    }),
    loadViewpointsForProject: (projectKey) => {
      const all = readAllViewpoints();
      const list = (all[projectKey] || []).filter((v) => v.projectKey === projectKey);
      set({ viewpoints: list });
    },
    saveViewpoint: (vp) => set((s) => {
      const next = [vp, ...s.viewpoints.filter((v) => v.id !== vp.id)];
      persistProjectViewpoints(vp.projectKey, next);
      return { viewpoints: next };
    }),
    deleteViewpoint: (id) => set((s) => {
      const target = s.viewpoints.find((v) => v.id === id);
      const next = s.viewpoints.filter((v) => v.id !== id);
      if (target) persistProjectViewpoints(target.projectKey, next);
      return { viewpoints: next };
    }),
    renameViewpoint: (id, name) => set((s) => {
      const next = s.viewpoints.map((v) => (v.id === id ? { ...v, name } : v));
      const target = next.find((v) => v.id === id);
      if (target) persistProjectViewpoints(target.projectKey, next);
      return { viewpoints: next };
    }),
    addChatMessage: (msg) => set((s) => ({ chatMessages: [...s.chatMessages, { ...msg, id: crypto.randomUUID() }] })),
    updateLastAssistantMessage: (content) =>
      set((s) => {
        // Hot path: fires on every streamed token (and per-frame once the
        // caller coalesces tokens). Bail BEFORE cloning the
        // array so a stray call (no assistant tail) or an unchanged content
        // (a re-flush of the same accumulated string) keeps the existing
        // `chatMessages` reference and triggers no subscriber re-render.
        const last = s.chatMessages[s.chatMessages.length - 1];
        if (!last || last.role !== 'assistant' || last.content === content) return s;
        // Give only the streaming (last) message a fresh identity; prior
        // messages keep their reference, which is the foundation the
        // memoized message-row work relies on.
        const msgs = s.chatMessages.slice();
        msgs[msgs.length - 1] = { ...last, content };
        return { chatMessages: msgs };
      }),
    setLastMessageUsage: (usage) =>
      set((s) => {
        const msgs = [...s.chatMessages];
        const last = msgs[msgs.length - 1];
        if (last && last.role === 'assistant') {
          msgs[msgs.length - 1] = { ...last, usage };
        }
        return { chatMessages: msgs };
      }),
    setBudgetWarning: (w) => set({ budgetWarning: w }),
    setActiveFallbackModel: (f) => set({ activeFallbackModel: f }),
    addToolCallToLastMessage: (toolCall) =>
      set((s) => {
        const msgs = [...s.chatMessages];
        const last = msgs[msgs.length - 1];
        if (last && last.role === 'assistant') {
          const existing = last.toolCalls || [];
          // Stamp the tool call's position in the transcript: the amount of
          // assistant text emitted so far. The caller flushes the token buffer
          // into `content` first, so this offset is accurate. Enables the
          // chronological text↔tool interleaving in buildMessageParts.
          const stamped = { ...toolCall, contentOffset: last.content.length };
          msgs[msgs.length - 1] = { ...last, toolCalls: [...existing, stamped] };
        }
        return { chatMessages: msgs };
      }),
    updateLastToolCallResult: (result, executedOn) =>
      set((s) => {
        const msgs = [...s.chatMessages];
        const last = msgs[msgs.length - 1];
        if (last && last.role === 'assistant' && last.toolCalls?.length) {
          const calls = [...last.toolCalls];
          calls[calls.length - 1] = {
            ...calls[calls.length - 1],
            result,
            executedOn: executedOn ?? calls[calls.length - 1].executedOn,
          };
          msgs[msgs.length - 1] = { ...last, toolCalls: calls };
        }
        return { chatMessages: msgs };
      }),
    setChatLoading: (v) => set({ chatLoading: v }),
    setChatProvider: (p) => { writePref('pref.chatProvider', p); set({ chatProvider: p }); },
    setChatModel: (m) => { writePref('pref.chatModel', m); set({ chatModel: m }); },
    setChatTemperature: (t) => { writePref('pref.chatTemperature', t); set({ chatTemperature: t }); },
    setChatModelRegistryId: (id) => { writePref('pref.chatModelRegistryId', id); set({ chatModelRegistryId: id }); },
    addChatAttachment: (att) => set((s) => ({ chatAttachments: [...s.chatAttachments, att] })),
    removeChatAttachment: (index) =>
      set((s) => ({ chatAttachments: s.chatAttachments.filter((_, i) => i !== index) })),
    clearChatAttachments: () => set({ chatAttachments: [] }),
    setAgents: (agents) => set({ agents, agentsLoaded: true }),
    upsertAgent: (agent) => set((s) => {
      const idx = s.agents.findIndex((a) => a.id === agent.id);
      const next = idx >= 0
        ? s.agents.map((a) => (a.id === agent.id ? agent : a))
        : [...s.agents, agent];
      return { agents: next };
    }),
    removeAgent: (agentId) => set((s) => ({
      agents: s.agents.filter((a) => a.id !== agentId),
      activeAgentId: s.activeAgentId === agentId ? null : s.activeAgentId,
    })),
    setActiveAgentId: (id) => { writePref('pref.activeAgentId', id); set({ activeAgentId: id }); },
    setActiveToolSetId: (id) => { writePref('pref.activeToolSetId', id); set({ activeToolSetId: id }); },
    setActivePromptId: (id) => { writePref('pref.activePromptId', id); set({ activePromptId: id }); },
    upsertPendingEdit: (envelope: PendingEditEnvelope) => set((s) => {
      const existing = s.pendingEdits.findIndex((e) => e.edit_id === envelope.edit_id);
      if (existing >= 0) {
        const next = [...s.pendingEdits];
        next[existing] = envelope;
        return { pendingEdits: next };
      }
      // Do NOT auto-open the modal: the chat now shows an inline Approve /
      // Discard below the tool call (or auto-applies). The modal was
      // disruptive over the 3D viewer.
      return { pendingEdits: [envelope, ...s.pendingEdits] };
    }),
    removePendingEdit: (editId: string) => set((s) => ({
      pendingEdits: s.pendingEdits.filter((e) => e.edit_id !== editId),
      activePendingEditId: s.activePendingEditId === editId ? null : s.activePendingEditId,
    })),
    setActivePendingEditId: (id: string | null) => set({ activePendingEditId: id }),
    setEditApprovalMode: (mode) => { writePref('pref.editApprovalMode', mode); set({ editApprovalMode: mode }); },
    resolvePendingEdit: async (editId, action) => {
      const s = useStore.getState();
      if (s.pendingEditOutcomes[editId]) return; // already applied/discarded
      try {
        if (action === 'apply') {
          await apiApplyPendingEdit(editId);
          set((st) => ({ pendingEditOutcomes: { ...st.pendingEditOutcomes, [editId]: 'applied' } }));
          useStore.getState().logActivity({ kind: 'edit', summary: 'Applied edit' });
        } else {
          await apiDiscardPendingEdit(editId);
          set((st) => ({ pendingEditOutcomes: { ...st.pendingEditOutcomes, [editId]: 'discarded' } }));
          useStore.getState().logActivity({ kind: 'edit', summary: 'Discarded edit' });
        }
        useStore.getState().removePendingEdit(editId);
        useStore.getState().refreshEditState();
      } catch (err) {
        set((st) => ({ pendingEditOutcomes: { ...st.pendingEditOutcomes, [editId]: 'error' } }));
        useStore.getState().addToast(
          `Edit ${action === 'apply' ? 'apply' : 'discard'} failed: ${err instanceof Error ? err.message : String(err)}`,
          'error',
        );
      }
    },
    setSettingsOpen: (v) => set({ settingsOpen: v }),
    setCommandPaletteOpen: (v) => set({ commandPaletteOpen: v }),
    setShortcutsHelpOpen: (v) => set({ shortcutsHelpOpen: v }),
    setTheme: (t) => { writePref('pref.theme', t); set({ theme: t }); },
    setAccentPreset: (id) => { writePref('pref.accentPreset', id); set({ accentPreset: id }); },
    setPerfHudVisible: (v) => { writePref('pref.perfHudVisible', v); set({ perfHudVisible: v }); },
    setPerfDashOpen: (v) => set({ perfDashOpen: v }),
    setHealthPanelOpen: (v) => set({ healthPanelOpen: v }),
    setHealthCheckResult: (r) => set({ healthCheckResult: r }),
    setMeasurementPanelOpen: (v) => set({ measurementPanelOpen: v }),
    setMeasurementLabelsVisible: (v) => set({ measurementLabelsVisible: v }),

    // Undo
    setIsUndoing: (v) => set({ isUndoing: v }),
    undoLastEdit: async () => {
      const s = useStore.getState();
      if (s.isUndoing || !s.modelLoaded) return;
      set({ isUndoing: true });
      try {
        if (s.editModeAvailable) {
          // Operation-layer undo: recorded in the op log AND arms redo.
          const result = await apiUndoOperation();
          adoptOperationContract(result);
          if (result.changed) {
            useStore.getState().addToast(`Undid: ${result.description || 'last edit'}`, 'success');
            if (result.changed_ids?.length) {
              useStore.getState().invalidateElementDetails(result.changed_ids);
            }
          } else {
            useStore.getState().addToast(result.error ?? 'Nothing to undo', 'info');
          }
        } else {
          // Legacy inverse-delta undo (edit mode off / older backend).
          const result = await apiUndoLastEdit();
          if (result.undone) {
            useStore.getState().addToast(`Undid: ${result.description ?? 'last edit'}`, 'success');
            if (result.changed_ids?.length) {
              useStore.getState().invalidateElementDetails(result.changed_ids);
            }
          } else {
            useStore.getState().addToast(result.reason ?? 'Nothing to undo', 'info');
          }
        }
      } catch (err) {
        useStore.getState().addToast(`Undo failed: ${String(err)}`, 'error');
      } finally {
        set({ isUndoing: false });
      }
    },
    redoLastEdit: async () => {
      const s = useStore.getState();
      if (s.isUndoing || !s.modelLoaded || !s.editModeAvailable) return;
      set({ isUndoing: true });
      try {
        const result = await apiRedoOperation();
        adoptOperationContract(result);
        if (result.ok && result.changed) {
          useStore.getState().addToast(`Redid: ${result.description || 'edit'}`, 'success');
          if (result.changed_ids?.length) {
            useStore.getState().invalidateElementDetails(result.changed_ids);
          }
        } else {
          useStore.getState().addToast(result.error ?? 'Nothing to redo', 'info');
        }
      } catch (err) {
        useStore.getState().addToast(`Redo failed: ${String(err)}`, 'error');
      } finally {
        set({ isUndoing: false });
      }
    },

    // Editor - operation layer (human direct edits, actor=USER)
    setEditModeAvailable: (v) => set({ editModeAvailable: v }),
    refreshEditState: () => {
      if (editStateRefreshTimer !== null) clearTimeout(editStateRefreshTimer);
      editStateRefreshTimer = setTimeout(() => {
        editStateRefreshTimer = null;
        void import('../services/api').then(({ getEditState }) =>
          getEditState()
            .then((es) => set({
              editModeAvailable: Boolean(es.edit_mode_enabled),
              modelDirty: Boolean(es.dirty),
            }))
            .catch(() => { /* backend unreachable - keep last known state */ }),
        );
      }, 300);
    },
    setEditMode: (v) => set({ editMode: v }),
    toggleEditMode: () => set((s) => ({ editMode: !s.editMode })),
    setEditScope: (scope) => { writePref('pref.editScope', scope); set({ editScope: scope }); },
    applyOperation: async (operation, params) => {
      try {
        const result = await apiExecuteOperation(operation, params);
        adoptOperationContract(result);
        if (result.ok && result.changed && result.changed_ids?.length) {
          // Clear the cached detail so the properties panel re-fetches; the
          // backend's metadata_changed sync event refreshes the tree.
          useStore.getState().invalidateElementDetails(result.changed_ids);
        } else if (!result.ok) {
          useStore.getState().addToast(`Edit failed: ${result.error ?? 'unknown error'}`, 'error');
        }
        return result;
      } catch (err) {
        useStore.getState().addToast(`Edit failed: ${String(err)}`, 'error');
        return null;
      }
    },

    // Toasts
    addToast: (message, kind = 'info') => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      set((s) => ({ toasts: [...s.toasts, { id, message, kind }] }));
      setTimeout(() => useStore.getState().removeToast(id), 3500);
    },
    removeToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
    setSectionBoxEnabled: (enabled) => set({ sectionBoxEnabled: enabled }),
    toggleSectionBox: () => set((s) => ({ sectionBoxEnabled: !s.sectionBoxEnabled })),
    setFloatingChatMinimized: (v) => { writePref('pref.floatingChatMinimized', v); set({ floatingChatMinimized: v }); },
    setViewerToolsOpen: (v) => set({ viewerToolsOpen: v }),
    setViewerToolsHidden: (v) => set({ viewerToolsHidden: v }),
    setStreamingRevealEnabled: (v) => set({ streamingRevealEnabled: v }),
    setStreamingRevealActive: (v) => set({ streamingRevealActive: v }),
    setAgentManagerOpen: (v) => set({ agentManagerOpen: v }),
    setSwReady: (v) => set({ swReady: v }),
    setFragmentCachePersisted: (state) => set({ fragmentCachePersisted: state }),
    setCheckpointPanelOpen: (v) => set({ checkpointPanelOpen: v }),
    setCheckpoints: (checkpoints, available) => set({ checkpoints, checkpointsAvailable: available }),
    setCheckpointsLoading: (v) => set({ checkpointsLoading: v }),
    setBudgetPanelOpen: (v) => set({ budgetPanelOpen: v }),
    setStatsPanelOpen: (v) => set({ statsPanelOpen: v }),
    setActiveFeaturePanel: (panel) => set((s) => ({
      // Toggle: re-selecting the open panel closes it (and null always closes).
      activeFeaturePanel: panel !== null && s.activeFeaturePanel === panel ? null : panel,
    })),
    openTool: (id) => {
      // Persist the tab focus the same way focusRightTab does, so reopening the
      // app lands back on Tools when a tool was last open.
      writePref('pref.rightActiveTab', 'tools');
      writePref('pref.rightSidebarOpen', true);
      set({
        // Mutually exclusive: only the chosen tool stays open.
        activeFeaturePanel: asFeaturePanel(id),
        statsPanelOpen: id === 'stats',
        filterPanelOpen: id === 'filter',
        healthPanelOpen: id === 'health',
        rightActiveTab: 'tools',
        lastNonChatTab: 'tools',
        rightSidebarOpen: true,
      });
    },
    closeTool: () =>
      set({
        activeFeaturePanel: null,
        statsPanelOpen: false,
        filterPanelOpen: false,
        healthPanelOpen: false,
      }),
    toggleTool: (id) =>
      set((s) => {
        if (activeToolOf(s) === id) {
          return {
            activeFeaturePanel: null,
            statsPanelOpen: false,
            filterPanelOpen: false,
            healthPanelOpen: false,
          };
        }
        writePref('pref.rightActiveTab', 'tools');
        writePref('pref.rightSidebarOpen', true);
        return {
          // Route through the same FeaturePanel narrowing as openTool so every
          // feature panel (not just the first four) docks from toggleTool.
          activeFeaturePanel: asFeaturePanel(id),
          statsPanelOpen: id === 'stats',
          filterPanelOpen: id === 'filter',
          healthPanelOpen: id === 'health',
          rightActiveTab: 'tools',
          lastNonChatTab: 'tools',
          rightSidebarOpen: true,
        };
      }),
    setFilterPanelOpen: (v) => set({ filterPanelOpen: v }),
    setFilterResultIds: (ids) => set({ filterResultIds: ids }),
    setGhostModeOn: (on) => set({ ghostModeOn: on }),
    setSnippetPanelOpen: (v) => set({ snippetPanelOpen: v }),
    setSnippetInsertText: (text) => set({ snippetInsertText: text }),
    setChatManagerInitialSection: (s) => set({ chatManagerInitialSection: s }),
    setDocIndexFiles: (files) => set({ docIndexFiles: files }),
    addDocIndexFile: (file) => set((s) => ({ docIndexFiles: [file, ...s.docIndexFiles] })),
    removeDocIndexFile: (docId) => set((s) => ({ docIndexFiles: s.docIndexFiles.filter((f) => f.doc_id !== docId) })),
    setDocIndexLoading: (v) => set({ docIndexLoading: v }),
    setSessionMemoryFacts: (facts) => set({ sessionMemoryFacts: facts }),
    clearSessionMemoryFacts: () => set({ sessionMemoryFacts: [] }),
    updatePerfMetrics: (m) => {
      // Perf-UI gate: the click-latency probe and the culler
      // tick fire their updatePerfMetrics writes on every click / every
      // navigation tick with NO gate, minting a fresh perfMetrics object
      // each time. Whole-object subscribers (e.g. SummaryPanel) then re-render
      // on every click and during orbit even though the HUD is closed.
      // When neither the HUD nor the dashboard is open, drop these hot fields.
      // The click-latency probe keeps its own in-ref rolling window (median/max
      // are computed there, before this call), so skipping the store write
      // does NOT affect median/p95 computation. Load metrics (ttfr/ttfg/load/
      // cacheHitRate) and the FPS sampler (already gated upstream) are never
      // in PERF_GATED_KEYS, so they always pass through.
      const s = useStore.getState();
      if (s.perfHudVisible || s.perfDashOpen) {
        set({ perfMetrics: { ...s.perfMetrics, ...m } });
        return;
      }
      const filtered: Partial<PerfMetrics> = { ...m };
      for (const k of PERF_GATED_KEYS) delete filtered[k];
      // Only gated fields were present - skip set() entirely so the store is
      // not even woken (no subscriber commit) while the perf UI is closed.
      if (Object.keys(filtered).length === 0) return;
      set({ perfMetrics: { ...s.perfMetrics, ...filtered } });
    },
    setLoadStartTs: (ts) => set({ loadStartTs: ts }),
    setStartupMode: (m) => { writePref('pref.startupMode', m); set({ startupMode: m }); },
    setConsistencyMode: (m) => { writePref('pref.consistencyMode', m); set({ consistencyMode: m }); },
    setEditFallback: (m) => { writePref('pref.editFallback', m); set({ editFallback: m }); },
    setRendererMode: (m) => { writePref('pref.rendererMode', m); set({ rendererMode: m }); },
    setCachePolicy: (p) => { writePref('pref.cachePolicy', p); set({ cachePolicy: p }); },
    setUseServerCache: (enabled) => { writePref('pref.useServerCache', enabled); set({ useServerCache: enabled }); },
    setHighlightStrategy: (h) => { writePref('pref.highlightStrategy', h); set({ highlightStrategy: h }); },
    setGraphicsProfile: (p) => { writePref('pref.graphicsProfile', p); set({ graphicsProfile: p }); },
    setViewerPerformanceMode: (mode) => { writePref('pref.viewerPerformanceMode', mode); set({ viewerPerformanceMode: mode }); },
    setLargeModelLod: (v) => { writePref('pref.largeModelLod', v); set({ largeModelLod: v }); },
    setPrebuildWaitTimeoutMs: (ms) => set((s) => {
      const timeoutMs = clampPrebuildPref(ms, {
        min: PREBUILD_TIMEOUT_MIN_MS,
        max: PREBUILD_TIMEOUT_MAX_MS,
        fallback: DEFAULT_PREBUILD_WAIT_PREFS.timeoutMs,
      });
      // Sanitise the pair together so the poll never exceeds the new timeout.
      const next = sanitisePrebuildWaitPrefs({
        timeoutMs,
        pollIntervalMs: s.prebuildWaitPrefs.pollIntervalMs,
      });
      writePref('pref.prebuildWait.v1', next);
      return { prebuildWaitPrefs: next };
    }),
    setPrebuildWaitPollIntervalMs: (ms) => set((s) => {
      const pollIntervalMs = clampPrebuildPref(ms, {
        min: PREBUILD_POLL_MIN_MS,
        max: PREBUILD_POLL_MAX_MS,
        fallback: DEFAULT_PREBUILD_WAIT_PREFS.pollIntervalMs,
      });
      const next = sanitisePrebuildWaitPrefs({
        timeoutMs: s.prebuildWaitPrefs.timeoutMs,
        pollIntervalMs,
      });
      writePref('pref.prebuildWait.v1', next);
      return { prebuildWaitPrefs: next };
    }),
    resetPrebuildWaitPrefs: () => {
      writePref('pref.prebuildWait.v1', DEFAULT_PREBUILD_WAIT_PREFS);
      set({ prebuildWaitPrefs: { ...DEFAULT_PREBUILD_WAIT_PREFS } });
    },
    setSelectionFocusMode: (m) => { writePref('pref.selectionFocusMode', m); set({ selectionFocusMode: m }); },
    setSelectionGhostOpacity: (opacity) => {
      const clamped = Math.max(0.05, Math.min(1, opacity));
      writePref('pref.selectionGhostOpacity', clamped);
      set({ selectionGhostOpacity: clamped });
    },
    setFrustumCullingEnabled: (enabled) => {
      writePref('pref.frustumCullingEnabled', enabled);
      set({ frustumCullingEnabled: enabled });
    },
    setGridVisible: (visible) => {
      writePref('pref.gridVisible', visible);
      set({ gridVisible: visible });
    },
    toggleGrid: () => set((s) => {
      const next = !s.gridVisible;
      writePref('pref.gridVisible', next);
      return { gridVisible: next };
    }),
    setHoverHighlightEnabled: (enabled) => {
      writePref('pref.hoverHighlightEnabled', enabled);
      set({ hoverHighlightEnabled: enabled });
    },
    setFurnishingMerged: (v) => { writePref('pref.furnishingMerged', v); set({ furnishingMerged: v }); },
    toggleHoverHighlight: () => set((s) => {
      const next = !s.hoverHighlightEnabled;
      writePref('pref.hoverHighlightEnabled', next);
      return { hoverHighlightEnabled: next };
    }),
    setColourBy: (property) => set({ colourBy: property }),
    setColourLayer: (id, layer) => set((s) => {
      // Rebuild the record without the id first so a re-set layer moves to
      // the END of the key order - "last set wins" for overlapping ids.
      const next: Record<string, ColourLayer> = {};
      for (const key of Object.keys(s.colourLayers)) {
        if (key !== id) next[key] = s.colourLayers[key];
      }
      next[id] = layer;
      return { colourLayers: next };
    }),
    clearColourLayer: (id) => set((s) => {
      if (!(id in s.colourLayers)) return {};
      const next = { ...s.colourLayers };
      delete next[id];
      return { colourLayers: next };
    }),
    clearAllColourLayers: () => set((s) => (
      Object.keys(s.colourLayers).length === 0 ? {} : { colourLayers: {} }
    )),
    addClipPlane: () => set((s) => {
      if (s.clipPlanes.length >= MAX_CLIP_PLANES) return s;
      const id = `clip-${Date.now()}`;
      const newPlane: ClipPlaneState = { id, enabled: true, axis: 'y', offset: 0, inverted: false };
      const next = [...s.clipPlanes, newPlane];
      writePref('pref.clipPlanes.v2', next);
      return { clipPlanes: next };
    }),
    addClipPlaneAt: (axis, offset) => set((s) => {
      if (s.clipPlanes.length >= MAX_CLIP_PLANES) return { pickPlaneMode: false };
      const id = `clip-${Date.now()}`;
      const newPlane: ClipPlaneState = { id, enabled: true, axis, offset, inverted: false };
      const next = [...s.clipPlanes, newPlane];
      writePref('pref.clipPlanes.v2', next);
      return { clipPlanes: next, pickPlaneMode: false };
    }),
    setPickPlaneMode: (enabled) => set({ pickPlaneMode: enabled }),
    removeClipPlane: (id) => set((s) => {
      const next = s.clipPlanes.filter(p => p.id !== id);
      writePref('pref.clipPlanes.v2', next);
      return { clipPlanes: next };
    }),
    updateClipPlane: (id, patch) => set((s) => {
      const next = s.clipPlanes.map(p => {
        if (p.id !== id) return p;
        const resetOffset = patch.axis !== undefined && patch.axis !== p.axis;
        return {
          ...p,
          ...patch,
          offset: resetOffset ? 0 : (patch.offset ?? p.offset),
        };
      });
      writePref('pref.clipPlanes.v2', next);
      return { clipPlanes: next };
    }),
    setClipPlane: (patch) => set((s) => {
      // Compat shim - updates the first (primary) plane
      const primary = s.clipPlanes[0];
      if (!primary) return s;
      const resetOffset = patch.axis !== undefined && patch.axis !== primary.axis;
      const next = s.clipPlanes.map((p, i) =>
        i === 0
          ? { ...p, ...patch, offset: resetOffset ? 0 : (patch.offset ?? p.offset) }
          : p,
      );
      writePref('pref.clipPlanes.v2', next);
      return { clipPlanes: next };
    }),
    toggleClipPlane: () => set((s) => {
      const primary = s.clipPlanes[0];
      if (!primary) return s;
      const next = s.clipPlanes.map((p, i) =>
        i === 0 ? { ...p, enabled: !p.enabled } : p,
      );
      writePref('pref.clipPlanes.v2', next);
      return { clipPlanes: next };
    }),
    setMeasurement: (patch) => set((s) => {
      const next: MeasurementPrefs = { ...s.measurement, ...patch };
      // Only `unit` is persisted; `mode` is per-session.
      if (patch.unit !== undefined) writePref('pref.measurement.unit', next.unit);
      return { measurement: next };
    }),
    setMeasurementMode: (mode) => set((s) => ({ measurement: { ...s.measurement, mode } })),
    setModelHalfExtents: (ext) => set({ modelHalfExtents: ext }),
    logActivity: (entry) => set((s) => {
      const full: ActivityEntry = {
        id: `${Date.now()}-${activitySeq++}`,
        ts: Date.now(),
        ...entry,
      };
      // Cap at 200 entries to bound memory
      const next = [full, ...s.activity].slice(0, 200);
      return { activity: next };
    }),
    clearActivity: () => set({ activity: [] }),
    toggleActivityKindMute: (kind) => set((s) => {
      const next = toggleMutedKindHelper(s.activityMutedKinds, kind);
      writeMutedKindsToStorage(next);
      return { activityMutedKinds: next };
    }),
    clearActivityKindMutes: () => set(() => {
      const next: ReadonlySet<ActivityKind> = new Set();
      writeMutedKindsToStorage(next);
      return { activityMutedKinds: next };
    }),
    setServerConvertCaps: (caps) => set({ serverConvertCaps: caps }),
    setZoomToElementFn: (fn) => set({ zoomToElementFn: fn }),
    zoomToElement: (expressId) => {
      const fn = useStore.getState().zoomToElementFn;
      if (fn) fn(expressId);
    },
    setFrameElementsFn: (fn) => set({ frameElementsFn: fn }),
    frameElements: (expressIds) => {
      if (!Array.isArray(expressIds) || expressIds.length === 0) return;
      const fn = useStore.getState().frameElementsFn;
      if (fn) fn(expressIds);
    },
    setClipToElementFn: (fn) => set({ clipToElementFn: fn }),
    clipToElement: (expressId) => {
      const fn = useStore.getState().clipToElementFn;
      if (fn) fn(expressId);
    },
    setTreeHoverPreviewFn: (fn) => set({ treeHoverPreviewFn: fn }),
    treeHoverPreview: (expressId) => {
      const fn = useStore.getState().treeHoverPreviewFn;
      if (fn) fn(expressId);
    },
    setGetCameraStateFn: (fn) => set({ getCameraStateFn: fn }),
    setSetLookAtFn: (fn) => set({ setLookAtFn: fn }),
    copyShareLink: async () => {
      const { buildShareUrl } = await import('../services/viewer/shareLink');
      const s = useStore.getState();
      const cam = s.getCameraStateFn?.() ?? undefined;
      const state = {
        v: 1 as const,
        ...(cam ? { cam: { p: cam.pos, t: cam.target } } : {}),
        ...(s.isolatedIds.length > 0 ? { iso: s.isolatedIds } : {}),
        ...(s.highlightedIds.length > 0 ? { hi: s.highlightedIds } : {}),
        tab: s.rightActiveTab,
      };
      const url = buildShareUrl(state);
      history.replaceState(null, '', `#${url.split('#')[1]}`);
      try {
        await navigator.clipboard.writeText(url);
        s.logActivity({ kind: 'info', summary: 'Share link copied to clipboard' });
      } catch {
        s.logActivity({ kind: 'info', summary: `Share link: ${url}` });
      }
    },

    patchSpatialTreeNodeName: (id, newName) => set((s) => {
      if (!s.spatialTree) return {};
      function walk(node: SpatialNode): SpatialNode {
        if (node.id === id) return { ...node, name: newName };
        const children = node.children.map(walk);
        return children === node.children ? node : { ...node, children };
      }
      const patched = walk(s.spatialTree);
      return patched === s.spatialTree ? {} : { spatialTree: patched };
    }),

    invalidateElementDetails: (changedIds) => {
      // ModelService registers its already-loaded singleton with this tiny
      // bridge, so cache eviction is synchronous without pulling the heavy IFC
      // engine into the store's entry chunk.
      invalidateModelElementDetails(changedIds);
      set((s) => {
        if (s.selectedElementId !== null && changedIds.includes(s.selectedElementId)) {
          // The serial re-runs PropertiesPanel's fetch effect while keeping the
          // selected express id stable across semantic edits.
          return {
            selectedElement: null,
            detailRefreshSerial: s.detailRefreshSerial + 1,
          };
        }
        return {};
      });
    },

    clearChat: () => set({ chatMessages: [], chatLoading: false, chatHistoryRestored: false }),

    setChatThreadId: (id) => {
      if (typeof localStorage !== 'undefined') localStorage.setItem('ifc-viewer-chat-thread', id);
      set({ chatThreadId: id, chatMessages: [], chatHistoryRestored: false });
    },
    setChatHistoryRestored: (v) => set({ chatHistoryRestored: v }),
    restoreThreadHistory: (messages) => set({
      chatMessages: messages.map((m) => ({ ...m, id: crypto.randomUUID() })),
      chatHistoryRestored: true,
    }),
    reset: () => set((s) => ({
      ...initialState,
      // Preserve user prefs across reset
      theme: s.theme,
      chatProvider: s.chatProvider,
      chatModel: s.chatModel,
      chatTemperature: s.chatTemperature,
      perfHudVisible: s.perfHudVisible,
      floatingChatMinimized: s.floatingChatMinimized,
      rightSidebarMode: s.rightSidebarMode,
      rightSidebarOpen: s.rightSidebarOpen,
      rightActiveTab: s.rightActiveTab,
      leftSidebarOpen: s.leftSidebarOpen,
      leftActivePane: s.leftActivePane,
      startupMode: s.startupMode,
      consistencyMode: s.consistencyMode,
      editFallback: s.editFallback,
      rendererMode: s.rendererMode,
      cachePolicy: s.cachePolicy,
      useServerCache: s.useServerCache,
      highlightStrategy: s.highlightStrategy,
      graphicsProfile: s.graphicsProfile,
      viewerPerformanceMode: s.viewerPerformanceMode,
      selectionFocusMode: s.selectionFocusMode,
      selectionGhostOpacity: s.selectionGhostOpacity,
      clipPlanes: s.clipPlanes,
      // Preserve measurement unit (user preference); reset mode to 'off' so
      // reopening a project doesn't leave clicks hijacked by a stale tool.
      measurement: { ...s.measurement, mode: 'off' as MeasurementMode },
      // Always reset to an empty viewpoints list; the next project load will repopulate
      viewpoints: [] as Viewpoint[],
    })),
  })),
);

// Trailing-debounce handle for refreshEditState (module scope: the store is a
// singleton and the timer must survive re-renders).
let editStateRefreshTimer: ReturnType<typeof setTimeout> | null = null;

/** Adopt the fresh model contract carried on an applied OperationResult.
 *
 * Applied operations re-fingerprint the working file server-side; until the
 * store learns the new fingerprint, the model-sync stale filter would drop the
 * very events describing this edit. The HTTP response and the WS event race -
 * whichever lands first updates the contract, the other is a no-op. */
function adoptOperationContract(result: OperationResult | null | undefined): void {
  if (result?.changed && result.model_fingerprint) {
    useStore.getState().setModelContract({
      model_version: result.model_version ?? 0,
      model_fingerprint: result.model_fingerprint,
      edit_id: result.edit_id ?? '',
    });
  }
  if (result && typeof result.can_redo === 'boolean') {
    useStore.setState({ canRedo: result.can_redo });
  }
  // Any applied/undone/redone op may flip the backend dirty flag.
  if (result?.changed) {
    useStore.getState().refreshEditState();
  }
}
