import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import * as OBC from '@thatopen/components';
import * as OBCF from '@thatopen/components-front';
import * as FRAGS from '@thatopen/fragments';
import { ViewHelper } from 'three/examples/jsm/helpers/ViewHelper.js';
import { useStore } from '../../store/useStore';
import type { ViewerPerformanceMode } from '../../store/useStore';
import { apiUrl } from '../../lib/platform';
import { BROWSER_ONLY, RENDER_ON_DEMAND } from '../../config/featureFlags';
import { modelService } from '../../services/ifc/ModelService';
import { ClipPlaneController } from '../../services/viewer/clipPlaneController';
import { SectionBoxController } from '../../services/viewer/sectionBoxController';
import { ClipEdgesService } from '../../services/viewer/clipEdgesService';
import {
  MeasurementController,
  type MeasurementSnapshot,
} from '../../services/viewer/measurementController';
import { snapToFaceVertex } from '../../services/viewer/vertexSnapHelpers';
// B5 mount point: wall drawing tool - all logic lives in services/editor/.
import { WallDrawController } from '../../services/editor/wallDrawController';
import EditToolbar from './EditToolbar';
import HighlightBadge from './HighlightBadge';
import SelectionSummaryChip from './SelectionSummaryChip';
import PerformanceHud from './PerformanceHud';
import PerformanceDashboard from './PerformanceDashboard';
import FloatingChatDock from './FloatingChatDock';
import MeasurementControls from './MeasurementControls';
import MeasurementLabels from './MeasurementLabels';
import MeasurementPanel from './MeasurementPanel';
import ViewerContextMenu, { type ContextMenuState } from './ViewerContextMenu';
import ViewerHoverTooltip from './ViewerHoverTooltip';
import ViewportNavControls from './ViewportNavControls';
import ErrorBoundary from '../ui/ErrorBoundary';
import { findIfcTypeForId, collectLeavesUnder, getSpatialNodeIndex } from '../../services/viewer/spatialTreeHelpers';
import { setHoverTooltipData } from '../../services/viewer/hoverTooltipBridge';
import {
  registerViewerBridge,
  unregisterViewerBridge,
  type ViewerBridgeCapabilities,
} from '../../services/viewer/viewerBridge';
import { buildColourGroups } from '../../services/viewer/colourByHelper';
import { flattenColourLayers } from '../../services/viewer/colourLayers';
import {
  resolveParseProfile,
  configureImporter,
  getRendererFlagsForProfile,
  getWebIfcSettingsForProfile,
  AUTO_PERF_PROFILE_THRESHOLD_BYTES,
} from '../../services/viewer/parseProfiles';
import { clientPointToNdc, queryFastPicker } from '../../services/viewer/fastPickerGuard';
import {
  GHOST_ISOLATION_OPACITY,
  decideGhostWork,
} from '../../services/viewer/ghostModeHelpers';
import {
  pushClickLatencySample,
  medianClickLatency,
  maxClickLatency,
  p95ClickLatency,
  CLICK_LATENCY_OK_MS,
} from '../../services/viewer/clickLatencyHelpers';
import {
  decideHoverWork,
} from '../../services/viewer/hoverHighlightHelpers';
import { HOVER_HIGHLIGHT_MATERIAL } from '../../services/viewer/hoverMaterialRegistry';
import {
  DEFAULT_INTERACTION_QUALITY_STATE,
  HOVER_INTENT_DELAY_MS,
  getRuntimeQualitySettings,
  reduceInteractionQuality,
  shouldDelayHoverRaycast,
  shouldRunHoverRaycast,
  type InteractionQualityEvent,
  type InteractionQualityState,
  type RuntimeViewerQuality,
} from '../../services/viewer/interactionQualityController';
import { isNoopSameElementClick } from '../../services/viewer/pickingPipeline';
import {
  resolveLodTier,
  resolveModelGraphicsQuality,
  type LodTier,
} from '../../services/viewer/lodTierPolicy';
import { solveCameraFrame } from '../../services/viewer/frameCameraMath';
import {
  createFragmentUpdateScheduler,
  type FragmentUpdatePriority,
  type FragmentUpdateReason,
  type FragmentUpdateScheduler,
} from '../../services/viewer/fragmentUpdateScheduler';
import { prewarmExpressToLocalCache } from '../../services/viewer/localIdCachePrewarm';
import {
  PANEL_RESIZE_END_EVENT,
  PANEL_RESIZE_START_EVENT,
} from '../../services/viewer/panelResizeSession';
import { summarizeFrameDeltas } from '../../services/viewer/frameTimeRecorder';
import {
  getMainPassStats,
  isMainPassFresh,
  recordMainPass,
  resetMainPassStats,
} from '../../services/viewer/renderStatsSnapshot';
import { LodSwapController, loadAndAttachLod, type AttachedLod } from '../../services/viewer/lodSwap';
import {
  applyGhostPostproductionState,
  type GhostPostproductionTarget,
} from '../../services/viewer/ghostPostproductionController';
import {
  SELECTION_HIGHLIGHT_OPACITY,
  computeAmberIds,
  decideSelectionWork,
  getSelectionHighlightColor,
} from '../../services/viewer/selectionHighlightHelpers';
import { createRebuildScheduler, type RebuildScheduler } from '../../services/viewer/rebuildScheduler';
import {
  decideVisibilityWork,
  planInvisibleSetTransition,
  type VisibilitySnapshot,
} from '../../services/viewer/visibilityRebuildHelpers';
import {
  convertIfcOnServer,
  getServerCapabilities,
  checkFragmentManifest,
  fetchFragmentByFingerprint,
  pollConvertProgress,
  waitForFragmentReady,
} from '../../services/ifc/serverConvert';
import {
  shouldAttemptServerConvert,
  shouldRepromoteCapabilities,
  defaultParsePathLabel,
  isRecoverableServerConvertFailure,
} from '../../services/viewer/loadStrategy';
import {
  fetchNativeGeometryPreview,
  removeNativePreview,
  type NativeGeometryPreview,
} from '../../services/ifc/nativeGeometry';
import {
  streamNativeGeometry,
  type DecodedMesh,
} from '../../services/viewer/streamingGeometryConsumer';
import {
  appendBatchToGroup,
  createStreamingMaterialCache,
  disposeStreamingPreview,
} from '../../services/viewer/streamingPreviewBuilder';
import {
  computeSceneBVH,
  getBVHCoverage,
  installBVH,
} from '../../services/viewer/bvhSetup';
import {
  applyFragmentZFightingMitigation,
  hasPendingFragmentZFightingMitigation,
  resetFragmentZFightingTracking,
} from '../../services/viewer/zFightingMitigation';
import { applyFurnishingMerge } from '../../services/viewer/furnishingMerge';
import type { FurnishingMergeResult } from '../../services/viewer/furnishingMerge';
import {
  StoreyFrustumCuller,
  extractStoreyNodes,
} from '../../services/viewer/storeyFrustumCuller';
import { ElementFrustumCuller } from '../../services/viewer/elementFrustumCuller';
import {
  decideCullerWork,
  runCullerPlan,
  type CullerSnapshot,
} from '../../services/viewer/cullerCoordinationHelpers';
import { decideCullerPolicy } from '../../services/viewer/cullerStatePolicy';
import { padBox } from '../../services/viewer/sectionBoxHelpers';
import {
  INITIAL_TREE_HOVER_STATE,
  isResolutionStale,
  onTreeHoverEnter,
  onTreeHoverLeave,
  onTreeHoverPainted,
  shouldSkipResetForSelection,
  type TreeHoverPreviewState,
} from '../../services/viewer/treeHoverPreviewHelpers';
import { IfcConvertWorker } from '../../services/viewer/ifcConvertWorker';
import {
  readFragmentCacheIDB,
  writeRawFragmentCacheIDB,
  scheduleFragmentCacheIDBPersist,
  requestPersistentStorageOnce,
  type FragmentCachePolicy,
} from '../../services/viewer/fragmentCacheIDB';
import {
  fetchStoreyFragment,
  type StoreyFragmentResult,
} from '../../services/viewer/streamingLoader';
import {
  STOREY_FRAGMENT_LOAD_TIMEOUT_MS,
  computeFragmentLoadTimeoutMs,
  computeLiveParseTimeoutMs,
  raceWithTimeout,
} from '../../services/viewer/loadTimeoutHelpers';
import {
  IMPORT_STAGE_LABELS,
  SERVER_FRAGMENT_LOAD_RETRIES,
  VIEWER_PERF_LOG_STORAGE_KEY,
  attachGeometryTitle,
  buildFragmentCacheKey,
  buildViewerPerfLogEntry,
  clearFragmentThreadPlaceholder,
  computeViewerReadyMetrics,
  formatUnknownLoadError,
  formatImportProgressDetail,
  formatStageTimings,
  formatViewerReadySummary,
  isCacheHitModelLoadSource,
  isBackendShaFingerprint,
  isSuspiciousServerFragmentBytes,
  loadFragmentsWithTimeout,
  makeViewerModelId,
  modelLoadSourceForServerFragmentSource,
  modelLoadSourceHint,
  normalizeImportProgress,
  serverCapabilityWaitMs,
  shouldUseServerFragmentManifest,
  shouldWaitForServerPrebuild,
  prependViewerPerfLogEntry,
  type ViewerLoadStageTimings,
  type ViewerModelLoadSource,
  type ViewerLoadProgress,
  type ViewerPerfLogEntry,
} from '../../services/viewer/loadPipelineHelpers';
import {
  LOAD_STAGES,
  advancePace,
  createPaceState,
  estimateExpectedTotal,
  formatEta,
  pathKindForSourceHint,
  presentLoadProgress,
  type LoadPathKind,
  type PaceState,
} from '../../services/viewer/loadProgressPresenter';

// Shared viewer references so toolbar and other components can access them
export interface ViewerRefs {
  components: OBC.Components;
  world: OBC.SimpleScene & { camera: OBC.SimpleCamera; renderer: OBC.SimpleRenderer; scene: OBC.SimpleScene };
  model: FRAGS.FragmentsModel;
  modelCenter: THREE.Vector3;
  modelSize: THREE.Vector3;
  /** Grid object returned by OBC.Grids.create(world). Used for theme updates. */
  grid?: { three: THREE.Object3D };
}

type FragmentRaycastHit = NonNullable<Awaited<ReturnType<FRAGS.FragmentsModel['raycast']>>>;

/** Theme-driven scene colors. Keeps the 3D scene in sync with the CSS theme.
 *  The dark bottom stop is intentionally lifted off pure black so that dark
 *  IFC materials (e.g. roofs with low-luminance surface styles) don't blend
 *  into the void and disappear; the top stop leans toward the AMOLED app
 *  chrome so the canvas no longer reads as a flat colored island. */
const THEME_COLORS = {
  dark: {
    background: 0x1a212e,
    backgroundTop: 0x10141c,
    backgroundBottom: 0x242d3d, // horizon - keeps dark materials separated
    grid: 0x39414f,
  },
  light: {
    background: 0xf3f4f6,
    backgroundTop: 0xf7f9fc,
    backgroundBottom: 0xe7ebf1,
    grid: 0xcbd5e0,
  },
} as const;

// Per-scene texture registry so theme changes dispose the old background.
const sceneBackgroundTextures = new WeakMap<THREE.Scene, THREE.Texture>();

function buildVerticalGradientTexture(top: number, bottom: number): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    grad.addColorStop(0, `#${top.toString(16).padStart(6, '0')}`);
    grad.addColorStop(1, `#${bottom.toString(16).padStart(6, '0')}`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

type ViewerTheme = keyof typeof THEME_COLORS;

const CHAT_HIGHLIGHT_COLOR = new THREE.Color(0x00d2ff);
const CHAT_HIGHLIGHT_LIMIT = 500;

type NativeHighlightSnapshot = {
  colourBy: string;
  spatialTreeRef: unknown;
  /** Reference identity of the store's `colourLayers` record at snapshot time. */
  colourLayersRef: unknown;
  highlightedIds: number[];
  amberIds: number[];
  /** Merged base colour used to restore ids leaving the amber/cyan sets. */
  baseExpressColors: Map<number, THREE.Color>;
};

function sameNumberSet(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  for (const value of b) {
    if (!set.has(value)) return false;
  }
  return true;
}

// Map the user-facing performance mode onto the runtime quality ladder.
function performanceModeToQualityTarget(mode: ViewerPerformanceMode): RuntimeViewerQuality {
  switch (mode) {
    case 'performance':
      return 'interactive';
    case 'quality':
      return 'quality';
    case 'balanced':
    case 'auto':
    default:
      return 'balanced';
  }
}

function differenceFromSet(source: ReadonlySet<number>, exclude: ReadonlySet<number>): number[] {
  const out: number[] = [];
  for (const value of source) {
    if (!exclude.has(value)) out.push(value);
  }
  return out;
}

function isExpressIdSelected(
  expressId: number | null,
  selectedElementId: number | null,
  selectedIds: readonly number[],
): boolean {
  if (expressId === null) return false;
  if (selectedElementId === expressId) return true;
  return selectedIds.includes(expressId);
}

function applySceneTheme(
  world: ViewerRefs['world'],
  grid: ViewerRefs['grid'] | undefined,
  theme: ViewerTheme,
) {
  const colors = THEME_COLORS[theme];

  try {
    const sceneThree = world.scene.three as THREE.Scene;
    if (sceneThree) {
      const texture = buildVerticalGradientTexture(colors.backgroundTop, colors.backgroundBottom);
      const previous = sceneBackgroundTextures.get(sceneThree);
      sceneThree.background = texture;
      sceneBackgroundTextures.set(sceneThree, texture);
      previous?.dispose();
    }
    // Fallback for capture/postproduction paths that bypass scene.background.
    world.renderer?.three.setClearColor(colors.background, 1);
  } catch {
    /* ignore */
  }

  try {
    if (grid?.three) {
      grid.three.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (!mat) return;
        const setColor = (m: THREE.Material) => {
          // OBC SimpleGrid exposes its line color through the uColor uniform.
          const uniformMaterial = m as unknown as { uniforms?: { uColor?: { value: THREE.Color } } };
          if (uniformMaterial.uniforms?.uColor?.value) {
            uniformMaterial.uniforms.uColor.value.setHex(colors.grid);
            m.needsUpdate = true;
          }
        };
        if (Array.isArray(mat)) mat.forEach(setColor);
        else setColor(mat);
      });
    }
  } catch {
    /* grid material API differs across @thatopen versions; safe to ignore */
  }
}

export interface CameraState {
  pos: [number, number, number];
  target: [number, number, number];
}

interface ViewerPanelProps {
  onCameraViewRef?: React.MutableRefObject<((view: string) => void) | null>;
  onFitModelRef?: React.MutableRefObject<(() => void) | null>;
  onScreenshotRef?: React.MutableRefObject<(() => void) | null>;
  onSaveViewpointRef?: React.MutableRefObject<((name: string) => void) | null>;
  onRestoreViewpointRef?: React.MutableRefObject<((id: string) => void) | null>;
}

export default function ViewerPanel({
  onCameraViewRef,
  onFitModelRef,
  onScreenshotRef,
  onSaveViewpointRef,
  onRestoreViewpointRef,
}: ViewerPanelProps = {}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<ViewerRefs | null>(null);
  const sceneThemeTargetsRef = useRef<Pick<ViewerRefs, 'world' | 'grid'> | null>(null);
  // Kept for the viewer lifetime; subsequent fragment loads reuse this worker URL.
  const workerBlobUrlRef = useRef<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingFading, setLoadingFading] = useState(false);
  const [loadingSlow, setLoadingSlow] = useState(false);
  // Drives the loader's elapsed/remaining time line.
  const [loadElapsedSec, setLoadElapsedSec] = useState<number | null>(null);
  const [loadProgress, setLoadProgress] = useState<ViewerLoadProgress>({
    title: 'Initializing 3D viewport',
    detail: 'Preparing renderer, camera, and worker...',
    progress: 4,
    sourceHint: 'Startup',
  });
  const [viewerReady, setViewerReady] = useState(false);
  // Canvas context-menu state; listeners call through a ref to avoid reattachment.
  const [contextMenuState, setContextMenuState] = useState<ContextMenuState | null>(null);
  const theme = useStore((s) => s.theme);
  const perfDashOpen = useStore((s) => s.perfDashOpen);
  const setPerfDashOpen = useStore((s) => s.setPerfDashOpen);
  const setContextMenuStateRef = useRef(setContextMenuState);
  setContextMenuStateRef.current = setContextMenuState;
  // Stale async highlight builds bail when this generation changes.
  const highlightGenRef = useRef(0);
  // Allows click handling to bypass the queued highlight rebuild when needed.
  const rebuildSchedulerRef = useRef<RebuildScheduler | null>(null);
  // Latest highlight callback for long-lived pointer handlers.
  const rebuildNativeHighlightsRef = useRef<(() => Promise<void>) | null>(null);
  const ghostAppliedRef = useRef(false);
  // Hover refs update at pointer frequency without re-rendering the viewer.
  const hoveredLocalIdRef = useRef<number | null>(null);
  const hoveredExpressIdRef = useRef<number | null>(null);
  const nativeHighlightSnapshotRef = useRef<NativeHighlightSnapshot | null>(null);
  // Raycasts provide both IDs; cache them to avoid later per-id async lookups.
  const expressToLocalCacheRef = useRef<Map<number, number>>(new Map());
  // Per-session rolling window for the PerformanceHud click-latency chip.
  const clickLatencyWindowRef = useRef<number[]>([]);
  // Armed for hit-clicks and cleared when the matching highlight flush lands.
  const pendingClickStartRef = useRef<number | null>(null);
  // Development-only attribution for slow click samples.
  const clickFlushAttributionRef = useRef<{
    runStartTs: number | null;
    paceWaitMs: number;
    flushMs: number;
  }>({ runStartTs: null, paceWaitMs: 0, flushMs: 0 });
  // Stale in-flight hover raycasts bail when this generation changes.
  const hoverGenRef = useRef(0);
  // Suppresses low-priority hover work during camera navigation.
  const cameraNavigatingRef = useRef(false);
  const lodCleanupRef = useRef<(() => void) | null>(null);
  // Runtime pixel ratio, graphics quality, and hover-gate ladder state.
  const interactionQualityRef = useRef<InteractionQualityState>(
    DEFAULT_INTERACTION_QUALITY_STATE,
  );
  // Full local-ID list cache for ghost-mode set calculations.
  const allLocalIdsCacheRef = useRef<number[] | null>(null);
  const ghostAppliedLocalSetRef = useRef<Set<number>>(new Set());
  const ghostAppliedOpacityRef = useRef(0);
  // Separate ghost-opacity set for non-isolated ids during isolate mode.
  const isolateGhostAppliedLocalSetRef = useRef<Set<number>>(new Set());
  const isolateGhostAppliedOpacityRef = useRef(0);
  // Structural ref: Postproduction is not a public export from OBC Front.
  const postproductionRef =
    useRef<GhostPostproductionTarget<OBCF.EdgeDetectionPassMode> | null>(null);
  const fragmentUpdateSchedulerRef = useRef<FragmentUpdateScheduler | null>(null);

  const updateLoadProgress = useCallback((next: Partial<ViewerLoadProgress>) => {
    setLoadProgress((previous) => {
      const merged: ViewerLoadProgress = {
        ...previous,
        ...next,
      };
      if (
        merged.title === previous.title
        && merged.detail === previous.detail
        && merged.progress === previous.progress
        && merged.sourceHint === previous.sourceHint
      ) {
        return previous;
      }
      return merged;
    });
  }, []);

  const applyGhostPostproduction = useCallback((navigating = cameraNavigatingRef.current) => {
    applyGhostPostproductionState(postproductionRef.current, {
      ghostModeOn: useStore.getState().ghostModeOn,
      navigating,
      fastEdgeMode: OBCF.EdgeDetectionPassMode.GLOBAL,
    });
  }, []);

  const requestFragmentUpdate = useCallback((
    reason: FragmentUpdateReason,
    force = true,
    priority: FragmentUpdatePriority = 'visual',
  ) => {
    const scheduler = fragmentUpdateSchedulerRef.current;
    if (scheduler) {
      scheduler.request({ priority, force, reason });
      return;
    }
    const refs = viewerRef.current;
    if (!refs) return;
    try {
      const fm = refs.components.get(OBC.FragmentsManager);
      void Promise.resolve(fm.core.update(force)).catch(() => {});
    } catch {
      /* best-effort render kick */
    }
  }, []);

  // Click-to-highlight latency is recorded after the highlight flush resolves.
  const recordClickLatencyFlush = useCallback(() => {
    const tClickStart = pendingClickStartRef.current;
    if (tClickStart === null) return;
    pendingClickStartRef.current = null;
    const latencyMs = performance.now() - tClickStart;
    clickLatencyWindowRef.current = pushClickLatencySample(
      clickLatencyWindowRef.current,
      latencyMs,
    );
    // p95 is the number the plan's <= 80 ms p95 target is judged against;
    // it surfaces in the PerformanceHud chip alongside median/max (the
    // store write is gated behind the perf-UI gate).
    const p95 = p95ClickLatency(clickLatencyWindowRef.current);
    useStore.getState().updatePerfMetrics({
      clickToHighlightMs: latencyMs,
      clickToHighlightMedianMs: medianClickLatency(clickLatencyWindowRef.current),
      clickToHighlightMaxMs: maxClickLatency(clickLatencyWindowRef.current),
      clickToHighlightP95Ms: p95,
    });
    if (import.meta.env.DEV) {
      if (latencyMs > CLICK_LATENCY_OK_MS) {
        console.warn(`[viewer] click-to-highlight ${latencyMs.toFixed(0)} ms exceeds ${CLICK_LATENCY_OK_MS} ms budget`);
      }
      // Self-attributing breakdown so a slow sample names its bottleneck:
      // queueWait = pick + highlight RPC posting + waiting out any in-flight
      // engine run; paceWait = engine drop-window deferral; flush = the
      // forced engine update (refresh round-trip + tile pump + fence).
      const attribution = clickFlushAttributionRef.current;
      console.debug('[viewer] click-to-highlight', {
        last: Math.round(latencyMs),
        median: medianClickLatency(clickLatencyWindowRef.current),
        p95,
        max: maxClickLatency(clickLatencyWindowRef.current),
        queueWaitMs: attribution.runStartTs === null
          ? null
          : Math.round(attribution.runStartTs - tClickStart),
        paceWaitMs: Math.round(attribution.paceWaitMs),
        flushMs: Math.round(attribution.flushMs),
      });
      attribution.runStartTs = null;
    }
  }, []);

  // Selection / highlight / focus-mode / ghost-opacity are NOT subscribed at
  // the React render level - they're consumed inside `rebuildNativeHighlights`
  // and the ghost-focus scheduler via `useStore.getState()` plus reactive
  // `useStore.subscribe(...)` calls. Subscribing here was forcing a full
  // ViewerPanel re-render on every click for no JSX benefit.
  const isolatedIds = useStore((s) => s.isolatedIds);
  // Ghost mode: shows non-isolated elements as semi-transparent ghosts with
  // xray edge rendering instead of hiding them completely. Stored in Zustand
  // so the Shift+G keyboard shortcut and the ghost button share the same state.
  const ghostModeOn = useStore((s) => s.ghostModeOn);
  const setGhostModeOn = useStore((s) => s.setGhostModeOn);

  // Translate IFC Express IDs into FragmentsModel local IDs; mixing them breaks
  // visibility/highlight operations.
  const expressToLocalIds = useCallback(async (
    model: FRAGS.FragmentsModel,
    expressIds: number[],
  ): Promise<number[]> => {
    const cache = expressToLocalCacheRef.current;
    const out: number[] = [];
    const misses: number[] = [];
    for (const id of expressIds) {
      const cached = cache.get(id);
      if (cached !== undefined) {
        out.push(cached);
      } else {
        const remembered = modelService.getRememberedLocalId(id);
        if (remembered !== null) {
          cache.set(id, remembered);
          out.push(remembered);
        } else {
          misses.push(id);
        }
      }
    }
    if (misses.length === 0) return out;
    // Resolve cache misses in chunks.
    const MISS_CHUNK = 64;
    for (let i = 0; i < misses.length; i += MISS_CHUNK) {
      const slice = misses.slice(i, i + MISS_CHUNK);
      const resolved = await Promise.all(
        slice.map(async (id) => {
          try {
            const item = model.getItem(id);
            const localId = await item.getLocalId();
            return localId != null ? { express: id, local: localId } : null;
          } catch {
            return null;
          }
        }),
      );
      for (const entry of resolved) {
        if (entry) {
          cache.set(entry.express, entry.local);
          out.push(entry.local);
        }
      }
      if (i + MISS_CHUNK < misses.length) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    return out;
  }, []);

  // Cache-only fast path; null means the caller must await full resolution.
  const peekLocalIdsSync = useCallback((expressIds: number[]): number[] | null => {
    const cache = expressToLocalCacheRef.current;
    const out: number[] = [];
    for (const id of expressIds) {
      let lid = cache.get(id);
      if (lid === undefined) {
        const remembered = modelService.getRememberedLocalId(id);
        if (remembered === null) return null;
        cache.set(id, remembered);
        lid = remembered;
      }
      out.push(lid);
    }
    return out;
  }, []);

  // Apply native fragment highlights (exact mesh geometry, not bounding boxes).
  // Cyan for AI/chat-highlighted elements, amber for the clicked selection.
  // Both use the fragment highlight API which renders the actual element faces.
  const rebuildNativeHighlights = useCallback(async () => {
    if (!viewerRef.current) return;
    const { model } = viewerRef.current;
    const myGen = ++highlightGenRef.current;
    const resolveLocalIdsForHighlight = async (expressIds: number[]) => {
      let lids = await expressToLocalIds(model, expressIds);
      if (lids.length === 0 && expressIds.length > 0) {
        lids = expressIds;
        if (import.meta.env.DEV) {
          console.warn('[viewer] express->local returned empty; trying raw IDs', expressIds);
        }
      }
      return lids;
    };
    const paintSelection = async (expressIds: number[]) => {
      const lids = await resolveLocalIdsForHighlight(expressIds);
      if (myGen !== highlightGenRef.current || lids.length === 0) return;
      await model.highlight(lids, {
        color: getSelectionHighlightColor(),
        opacity: SELECTION_HIGHLIGHT_OPACITY,
        transparent: false,
        renderedFaces: FRAGS.RenderedFaces.ONE,
      });
    };
    const paintChatHighlight = async (expressIds: number[]) => {
      const lids = await expressToLocalIds(model, expressIds);
      if (myGen !== highlightGenRef.current || lids.length === 0) return;
      await model.highlight(lids, {
        color: CHAT_HIGHLIGHT_COLOR,
        opacity: 1.0,
        transparent: false,
        renderedFaces: FRAGS.RenderedFaces.ONE,
      });
    };
    const restoreBaseHighlights = async (
      expressIds: number[],
      snapshot: NativeHighlightSnapshot,
    ) => {
      if (expressIds.length === 0) return;
      const chatSet = new Set(snapshot.highlightedIds);
      const chatIds: number[] = [];
      const colourGroups = new Map<THREE.Color, number[]>();
      for (const id of expressIds) {
        if (chatSet.has(id)) {
          chatIds.push(id);
          continue;
        }
        const color = snapshot.baseExpressColors.get(id);
        if (!color) continue;
        const group = colourGroups.get(color);
        if (group) group.push(id);
        else colourGroups.set(color, [id]);
      }
      // Resolve ids once, then repaint colour groups concurrently.
      const allRestoreIds: number[] = [];
      for (const ids of colourGroups.values()) allRestoreIds.push(...ids);
      if (allRestoreIds.length > 0) {
        await expressToLocalIds(model, allRestoreIds);
        if (myGen !== highlightGenRef.current) return;
      }
      const repaints: Promise<void>[] = [];
      for (const [color, ids] of colourGroups) {
        repaints.push((async () => {
          const lids = await expressToLocalIds(model, ids); // cache hits now
          if (myGen !== highlightGenRef.current || lids.length === 0) return;
          await model.highlight(lids, {
            color,
            opacity: 0.95,
            transparent: false,
            renderedFaces: FRAGS.RenderedFaces.ONE,
          });
        })());
      }
      if (chatIds.length > 0) {
        repaints.push(paintChatHighlight(chatIds));
      }
      await Promise.all(repaints);
    };
    try {
      const state = useStore.getState();
      const highlightedIds = state.highlightedIds.slice(0, CHAT_HIGHLIGHT_LIMIT);
      const amberIds = computeAmberIds(state.selectedElementId, state.selectedIds);
      const prevSnapshot = nativeHighlightSnapshotRef.current;
      const canDeltaSelection =
        prevSnapshot !== null
        && prevSnapshot.colourBy === state.colourBy
        && prevSnapshot.spatialTreeRef === state.spatialTree
        && prevSnapshot.colourLayersRef === state.colourLayers
        && sameNumberSet(prevSnapshot.highlightedIds, highlightedIds);

      if (canDeltaSelection) {
        const work = decideSelectionWork(prevSnapshot.amberIds, amberIds);
        if (work.skip) {
          // No flush will fire for this rebuild - drop any armed click-probe
          // start so a later unrelated 'click-highlight' flush (AI/chat
          // rebuild) can't consume it and record a bogus sample (C-15).
          pendingClickStartRef.current = null;
          return;
        }

        const idsToReset = differenceFromSet(work.prevIds, work.nextIds);
        const idsToPaint = differenceFromSet(work.nextIds, work.prevIds);

        // Selection fast path: when every id in all three stages - reset,
        // base-layer restore (colour-by / chat cyan under the outgoing
        // amber), fresh paint - resolves synchronously (always true for
        // canvas clicks - pointer-up seeds the cache), post the worker RPCs
        // fire-and-forget in dependency order and kick ONE flush in the
        // SAME turn. Ordering the pipeline already guarantees: the worker
        // executes messages in arrival order, and the flush's scheduler
        // drain posts its refreshView after this synchronous turn - i.e.
        // after every RPC below. The awaited fallback cost 3+ serial worker
        // round-trips per click while colour-by or chat layers were active.
        {
          const resetLids = peekLocalIdsSync(idsToReset);
          const paintLids = peekLocalIdsSync(idsToPaint);
          if (resetLids !== null && paintLids !== null) {
            // Restore plan for ids leaving the amber set: chat cyan wins
            // over colour-by, mirroring restoreBaseHighlights.
            const chatSet = new Set(prevSnapshot.highlightedIds);
            const chatRestoreIds: number[] = [];
            const colourRestore = new Map<THREE.Color, number[]>();
            for (const id of idsToReset) {
              if (chatSet.has(id)) {
                chatRestoreIds.push(id);
                continue;
              }
              const color = prevSnapshot.baseExpressColors.get(id);
              if (!color) continue;
              const group = colourRestore.get(color);
              if (group) group.push(id);
              else colourRestore.set(color, [id]);
            }
            const chatLids = peekLocalIdsSync(chatRestoreIds);
            let colourGroupsResolved: Array<[THREE.Color, number[]]> | null = [];
            for (const [color, ids] of colourRestore) {
              const lids = peekLocalIdsSync(ids);
              if (lids === null) {
                colourGroupsResolved = null;
                break;
              }
              colourGroupsResolved.push([color, lids]);
            }
            if (chatLids !== null && colourGroupsResolved !== null) {
              if (resetLids.length > 0) {
                model.resetHighlight(resetLids).catch(() => { /* non-fatal */ });
              }
              for (const [color, lids] of colourGroupsResolved) {
                if (lids.length === 0) continue;
                model.highlight(lids, {
                  color,
                  opacity: 0.95,
                  transparent: false,
                  renderedFaces: FRAGS.RenderedFaces.ONE,
                }).catch(() => { /* non-fatal */ });
              }
              if (chatLids.length > 0) {
                model.highlight(chatLids, {
                  color: CHAT_HIGHLIGHT_COLOR,
                  opacity: 1.0,
                  transparent: false,
                  renderedFaces: FRAGS.RenderedFaces.ONE,
                }).catch(() => { /* non-fatal */ });
              }
              if (paintLids.length > 0) {
                model.highlight(paintLids, {
                  color: getSelectionHighlightColor(),
                  opacity: SELECTION_HIGHLIGHT_OPACITY,
                  transparent: false,
                  renderedFaces: FRAGS.RenderedFaces.ONE,
                }).catch(() => { /* non-fatal */ });
              }
              nativeHighlightSnapshotRef.current = {
                ...prevSnapshot,
                amberIds,
              };
              requestFragmentUpdate('click-highlight');
              return;
            }
          }
        }

        if (idsToReset.length > 0) {
          const resetLocalIds = await resolveLocalIdsForHighlight(idsToReset);
          if (myGen !== highlightGenRef.current) return;
          if (resetLocalIds.length > 0) {
            await model.resetHighlight(resetLocalIds);
          }
          if (myGen !== highlightGenRef.current) return;
          await restoreBaseHighlights(idsToReset, prevSnapshot);
        }

        if (idsToPaint.length > 0) {
          await paintSelection(idsToPaint);
        }

        if (myGen !== highlightGenRef.current) return;
        nativeHighlightSnapshotRef.current = {
          ...prevSnapshot,
          amberIds,
        };
        requestFragmentUpdate('click-highlight');
        return;
      }

      await model.resetHighlight(undefined);
      hoveredLocalIdRef.current = null;
      hoveredExpressIdRef.current = null;
      if (myGen !== highlightGenRef.current) return;

      // Base colour layer; selection/chat highlights are painted on top.
      const baseExpressColors = new Map<number, THREE.Color>();
      if (state.colourBy !== 'off' && state.spatialTree) {
        const groups = buildColourGroups(state.spatialTree, state.colourBy);
        for (const group of groups) {
          if (myGen !== highlightGenRef.current) return;
          for (const id of group.ids) {
            baseExpressColors.set(id, group.color);
          }
          const lids = await expressToLocalIds(model, group.ids);
          if (myGen !== highlightGenRef.current) return;
          if (lids.length > 0) {
            await model.highlight(lids, {
              color: group.color,
              opacity: 0.95,
              transparent: false,
              renderedFaces: FRAGS.RenderedFaces.ONE,
            });
          }
        }
      }

      // Generic colour layers (store `colourLayers`): painted AFTER the
      // colour-by groups so a layer colour wins per id; flattenColourLayers
      // already applies the last-set-layer-wins rule for overlapping ids.
      // Same opacity as colour-by so the snapshot restore paths repaint
      // both sources through one code path.
      const layerGroups = flattenColourLayers(state.colourLayers);
      if (layerGroups.length > 0) {
        // One shared THREE.Color per hex string: the restore paths group
        // ids by colour-OBJECT identity, so per-id clones would shatter a
        // layer into single-id highlight calls on every deselect.
        const layerColourCache = new Map<string, THREE.Color>();
        for (const group of layerGroups) {
          if (myGen !== highlightGenRef.current) return;
          let colour = layerColourCache.get(group.color);
          if (!colour) {
            colour = new THREE.Color(group.color);
            layerColourCache.set(group.color, colour);
          }
          for (const id of group.ids) {
            baseExpressColors.set(id, colour);
          }
          const lids = await expressToLocalIds(model, group.ids);
          if (myGen !== highlightGenRef.current) return;
          if (lids.length > 0) {
            await model.highlight(lids, {
              color: colour,
              opacity: 0.95,
              transparent: false,
              renderedFaces: FRAGS.RenderedFaces.ONE,
            });
          }
        }
      }

      // Cyan highlight for elements surfaced by the AI/chat agent
      if (highlightedIds.length > 0) {
        await paintChatHighlight(highlightedIds);
      }

      // Amber highlight for selected element(s). Multi-select (Shift+click)
      // populates selectedIds; single select uses selectedElementId only.
      // The single-vs-multi rule lives in `computeAmberIds` so vitest can
      // pin it.
      if (amberIds.length > 0) {
        // Fragments' raycast returns `itemId` which in practice is the IFC
        // Express ID. We convert to local IDs for the highlight API. If the
        // conversion returns empty (older fragment versions, cached models,
        // or edge cases), fall back to passing the IDs straight through on
        // the chance they are already local IDs - the highlight API will
        // silently no-op on invalid IDs so it's safe to try.
        let lids = await expressToLocalIds(model, amberIds);
        if (lids.length === 0) {
          lids = amberIds;
          if (import.meta.env.DEV) {
            console.warn('[viewer] express-to-local returned empty; trying raw IDs', amberIds);
          }
        }
        if (import.meta.env.DEV) {
          console.debug('[viewer] highlight selection', {
            amberIds,
            localIds: lids,
          });
        }
        if (myGen !== highlightGenRef.current) return;
        if (lids.length > 0) {
          await model.highlight(lids, {
            color: getSelectionHighlightColor(),
            opacity: SELECTION_HIGHLIGHT_OPACITY,
            transparent: false,
            renderedFaces: FRAGS.RenderedFaces.ONE,
          });
        }
      }

      if (myGen !== highlightGenRef.current) return;
      nativeHighlightSnapshotRef.current = {
        colourBy: state.colourBy,
        spatialTreeRef: state.spatialTree,
        colourLayersRef: state.colourLayers,
        highlightedIds,
        amberIds,
        baseExpressColors,
      };
      // Fire-and-forget the coalesced render kick. The fragment scheduler
      // folds selection, chat-highlight, camera, and visibility refreshes
      // into the next paint instead of starting overlapping forced updates.
      requestFragmentUpdate('click-highlight');
    } catch (err) {
      // Highlight errors are non-fatal, but a silent swallow hides real
      // failures (no amber, no flush) - surface them in dev builds.
      if (import.meta.env.DEV) console.debug('[viewer] highlight rebuild failed', err);
    }
  }, [expressToLocalIds, peekLocalIdsSync, requestFragmentUpdate]);

  // Rebuild highlights whenever highlighted IDs, selected element,
  // multi-select, colourBy, or the colour-layer record changes.
  //
  // rAF coalesce (see `rebuildScheduler.ts`): a
  // single Zustand action that mutates two of these four keys (e.g.
  // Shift+click writing both `selectedElementId` and `selectedIds`)
  // would otherwise fire two rebuilds back-to-back. The `myGen`
  // cancellation pattern correctly suppresses the first call's *writes*,
  // but its `await model.resetHighlight(undefined)` and colour-by
  // recompute have already cost wall-clock work. The scheduler
  // collapses N synchronous subscriber notifications into one rebuild
  // on the next frame.
  // Tear down the LOD navigation swap when this ViewerPanel unmounts (the
  // component remounts per model load, so this fires between models).
  useEffect(() => () => {
    try { lodCleanupRef.current?.(); } catch { /* best-effort */ }
    lodCleanupRef.current = null;
  }, []);

  useEffect(() => {
    if (!viewerReady) return;
    let postPaintHandle: number | null = null;
    const scheduler = createRebuildScheduler({
      raf: (cb) => window.requestAnimationFrame(cb),
      cancelRaf: (handle) => window.cancelAnimationFrame(handle),
      run: () => {
        if (postPaintHandle !== null) {
          window.clearTimeout(postPaintHandle);
        }
        postPaintHandle = window.setTimeout(() => {
          postPaintHandle = null;
          void rebuildNativeHighlights();
        }, 0);
      },
    });
    rebuildSchedulerRef.current = scheduler;
    rebuildNativeHighlightsRef.current = rebuildNativeHighlights;
    const u1 = useStore.subscribe((s) => s.highlightedIds, scheduler.schedule);
    const u2 = useStore.subscribe((s) => s.selectedElementId, scheduler.schedule);
    const u3 = useStore.subscribe((s) => s.selectedIds, scheduler.schedule);
    const u4 = useStore.subscribe((s) => s.colourBy, scheduler.schedule);
    const u5 = useStore.subscribe((s) => s.spatialTree, scheduler.schedule);
    const u6 = useStore.subscribe((s) => s.colourLayers, scheduler.schedule);
    return () => {
      u1(); u2(); u3(); u4(); u5(); u6();
      scheduler.cancel();
      if (postPaintHandle !== null) {
        window.clearTimeout(postPaintHandle);
        postPaintHandle = null;
      }
      rebuildSchedulerRef.current = null;
      rebuildNativeHighlightsRef.current = null;
    };
  }, [viewerReady, rebuildNativeHighlights]);

  // Ghost mode for focused selection: use native setOpacity instead of
  // traversing THREE.js materials directly (avoids transparency-sort flickering).
  //
  // Performance strategy:
  //   1. Early-exit when nothing changed (mode='off' AND nothing applied).
  //   2. Cache `model.getLocalIds()` - the full id list is immutable per
  //      model load, so we only fetch it once instead of once per change.
  //   3. Apply only the *delta* between the previous focus set and the new
  //      one - `setOpacity` on a few elements is fast; `setOpacity` on
  //      thousands every selection click was the main slowness.
  //   4. rAF-coalesce slider drags via
  //      `createRebuildScheduler`. Profiling measured up to ~60
  //      `selectionGhostOpacity` writes/second during a continuous drag,
  //      each one firing a fresh fire-and-forget `apply()` that raced
  //      worker round-trips. The scheduler caps that at one apply per
  //      rAF and reads the latest opacity from `useStore.getState()` at
  //      apply time, so a 60-tick burst inside one frame collapses to a
  //      single `setOpacity` at the final value.
  useEffect(() => {
    if (!viewerReady) return;

    const apply = async () => {
      if (!viewerRef.current) return;
      const { model } = viewerRef.current;

      // Read latest state inside the rAF callback so high-frequency slider
      // ticks collapse into one apply per frame at the latest opacity.
      const state = useStore.getState();
      const selectedElementId = state.selectedElementId;
      const highlightedIds = state.highlightedIds;
      const selectionFocusMode = state.selectionFocusMode;
      const selectionGhostOpacity = state.selectionGhostOpacity;

      const hasFocus = selectedElementId != null || highlightedIds.length > 0;
      const shouldGhost = selectionFocusMode === 'ghost' && hasFocus;

      // Cheap early-exit: ghost-off and never applied.
      if (!shouldGhost && !ghostAppliedRef.current) return;

      // Lazy-init the full local-id list (cached for the model lifetime).
      // Only needed when we're about to compute the next ghost set.
      if (shouldGhost && !allLocalIdsCacheRef.current) {
        try {
          allLocalIdsCacheRef.current = await model.getLocalIds();
        } catch {
          return;
        }
      }

      // Build the next ghost set (empty when ghost-off).
      let nextGhostSet: Set<number> = new Set();
      if (shouldGhost) {
        const allLocal = allLocalIdsCacheRef.current;
        if (!allLocal || allLocal.length === 0) return;

        const focusExpressIds: number[] = [
          ...(selectedElementId != null ? [selectedElementId] : []),
          ...highlightedIds,
        ];
        const focusLocal = await expressToLocalIds(model, focusExpressIds);
        const focusSet = new Set(focusLocal);

        for (const id of allLocal) {
          if (!focusSet.has(id)) nextGhostSet.add(id);
        }
      }

      // Dispatch through the tested ghost-state helper.
      const plan = decideGhostWork({
        shouldGhost,
        ghostApplied: ghostAppliedRef.current,
        prevGhostSet: ghostAppliedLocalSetRef.current,
        nextGhostSet,
        prevOpacity: ghostAppliedOpacityRef.current,
        nextOpacity: selectionGhostOpacity,
      });

      switch (plan.kind) {
        case 'skip':
        case 'noop':
          return;
        case 'tear-down': {
          // Reset only the previously ghosted elements; keep the full reset as
          // a defensive fallback if the local refs drift.
          if (plan.idsToRestore.length > 0) {
            try { await model.resetOpacity(plan.idsToRestore); } catch {}
          } else {
            try { await model.resetOpacity(undefined); } catch {}
          }
          ghostAppliedLocalSetRef.current = new Set();
          ghostAppliedRef.current = false;
          ghostAppliedOpacityRef.current = 0;
          // Opacity flips need a forced render to appear immediately.
          requestFragmentUpdate('ghost-visibility');
          return;
        }
        case 'first-apply': {
          if (plan.idsToGhost.length > 0) {
            await model.setOpacity(plan.idsToGhost, plan.opacity);
          }
          ghostAppliedLocalSetRef.current = nextGhostSet;
          ghostAppliedRef.current = true;
          ghostAppliedOpacityRef.current = plan.opacity;
          requestFragmentUpdate('ghost-visibility');
          return;
        }
        case 'delta': {
          // Apply only ghost-set deltas and post restore/ghost writes together.
          await Promise.all([
            plan.newlyRestored.length > 0
              ? model.resetOpacity(plan.newlyRestored)
              : Promise.resolve(),
            plan.newlyGhosted.length > 0
              ? model.setOpacity(plan.newlyGhosted, plan.opacity)
              : Promise.resolve(),
          ]);
          ghostAppliedLocalSetRef.current = nextGhostSet;
          ghostAppliedOpacityRef.current = plan.opacity;
          requestFragmentUpdate('ghost-visibility');
          return;
        }
        case 'opacity-only-change': {
          // Slider drag: same focus set, new opacity value.
          await model.setOpacity(plan.ids, plan.opacity);
          ghostAppliedOpacityRef.current = plan.opacity;
          requestFragmentUpdate('ghost-visibility');
          return;
        }
      }
    };

    const scheduler = createRebuildScheduler({
      raf: (cb) => window.requestAnimationFrame(cb),
      cancelRaf: (handle) => window.cancelAnimationFrame(handle),
      run: () => { void apply().catch(() => {}); },
    });
    const u1 = useStore.subscribe((s) => s.selectedElementId, scheduler.schedule);
    const u2 = useStore.subscribe((s) => s.highlightedIds, scheduler.schedule);
    const u3 = useStore.subscribe((s) => s.selectionFocusMode, scheduler.schedule);
    const u4 = useStore.subscribe((s) => s.selectionGhostOpacity, scheduler.schedule);
    // Evaluate the current focus state on mount.
    scheduler.schedule();

    return () => {
      u1(); u2(); u3(); u4();
      scheduler.cancel();
    };
  }, [viewerReady, expressToLocalIds, requestFragmentUpdate]);

  // Visibility changes (isolate / hide), coalesced into one rebuild per frame.
  useEffect(() => {
    if (!viewerReady) return;
    let previousVisibilitySnapshot: VisibilitySnapshot = {
      isolatedIds: [],
      hiddenIds: [],
      ghostModeOn: false,
    };
    // Local ids last written invisible by the hide/isolate branches; the
    // delta plan writes only the symmetric difference on transitions.
    let appliedInvisibleLocalSet = new Set<number>();

    const getAllLocalIds = async (model: FRAGS.FragmentsModel) => {
      const cached = allLocalIdsCacheRef.current;
      if (cached) return cached;
      const localIds = await model.getLocalIds();
      allLocalIdsCacheRef.current = localIds;
      return localIds;
    };

    const applyVisibility = async (
      isolatedIds: number[],
      hiddenIds: number[],
      ghostOn: boolean,
    ) => {
      if (!viewerRef.current) return;
      const { model } = viewerRef.current;

      try {
        if (!useStore.getState().modelLoaded) return;
        const nextSnapshot: VisibilitySnapshot = {
          isolatedIds,
          hiddenIds,
          ghostModeOn: ghostOn,
        };
        const work = decideVisibilityWork(previousVisibilitySnapshot, nextSnapshot);
        if (work.skip) return;

        // model.setVisible expects LOCAL ids. Translate Express IDs first.
        const allLocalIds = await getAllLocalIds(model);

        // Delta discipline for the hide/isolate/reset branches: write only
        // the symmetric difference against the invisible set last written
        // (planInvisibleSetTransition). The reset branch keeps a full-model
        // repair write because visibility is co-owned with the frustum
        // cullers and the engine Hider state.
        const applyInvisibleSet = async (nextInvisible: Set<number>) => {
          const plan = planInvisibleSetTransition(appliedInvisibleLocalSet, nextInvisible);
          if (plan.toShow.length > 0) await model.setVisible(plan.toShow, true);
          if (plan.toHide.length > 0) await model.setVisible(plan.toHide, false);
          appliedInvisibleLocalSet = nextInvisible;
        };

        const clearIsolateGhostOpacity = async () => {
          const plan = decideGhostWork({
            shouldGhost: false,
            ghostApplied: isolateGhostAppliedLocalSetRef.current.size > 0,
            prevGhostSet: isolateGhostAppliedLocalSetRef.current,
            nextGhostSet: new Set<number>(),
            prevOpacity: isolateGhostAppliedOpacityRef.current,
            nextOpacity: 0,
          });
          if (plan.kind === 'tear-down' && plan.idsToRestore.length > 0) {
            await model.resetOpacity(plan.idsToRestore);
          }
          isolateGhostAppliedLocalSetRef.current = new Set();
          isolateGhostAppliedOpacityRef.current = 0;
        };

        if (isolatedIds.length > 0) {
          const isolatedLocal = await expressToLocalIds(model, isolatedIds);
          const isoSet = new Set(isolatedLocal);
          // Build the non-isolated set only for branches that need it.
          const buildNonIsoLocalSet = () => {
            const nonIso = new Set<number>();
            for (const id of allLocalIds) {
              if (!isoSet.has(id)) nonIso.add(id);
            }
            return nonIso;
          };

          if (ghostOn) {
            // Isolate ghosting uses its own delta-tracked ghost set.
            const nextGhostSet = new Set<number>();
            for (const id of allLocalIds) {
              if (!isoSet.has(id)) nextGhostSet.add(id);
            }
            const ghostApplied = isolateGhostAppliedLocalSetRef.current.size > 0;
            const plan = decideGhostWork({
              shouldGhost: true,
              ghostApplied,
              prevGhostSet: isolateGhostAppliedLocalSetRef.current,
              nextGhostSet,
              prevOpacity: isolateGhostAppliedOpacityRef.current,
              nextOpacity: GHOST_ISOLATION_OPACITY,
            });
            switch (plan.kind) {
              case 'skip':
              case 'noop':
                // Steady state: no renderer round-trip.
                break;
              case 'first-apply':
                // idsToGhost already contains the non-isolated set.
                if (plan.idsToGhost.length > 0) await model.setVisible(plan.idsToGhost, true);
                if (isolatedLocal.length > 0) await model.setVisible(isolatedLocal, true);
                if (plan.idsToGhost.length > 0) {
                  await model.setOpacity(plan.idsToGhost, plan.opacity);
                }
                isolateGhostAppliedLocalSetRef.current = nextGhostSet;
                isolateGhostAppliedOpacityRef.current = plan.opacity;
                break;
              case 'delta':
                // Newly restored ids are now isolated.
                if (plan.newlyRestored.length > 0) {
                  await model.setVisible(plan.newlyRestored, true);
                  await model.resetOpacity(plan.newlyRestored);
                }
                // Newly ghosted ids are now outside the isolate set.
                if (plan.newlyGhosted.length > 0) {
                  await model.setVisible(plan.newlyGhosted, true);
                  await model.setOpacity(plan.newlyGhosted, plan.opacity);
                }
                isolateGhostAppliedLocalSetRef.current = nextGhostSet;
                isolateGhostAppliedOpacityRef.current = plan.opacity;
                break;
              case 'opacity-only-change':
                // Defensive case for future isolate-opacity controls.
                await model.setOpacity(plan.ids, plan.opacity);
                isolateGhostAppliedOpacityRef.current = plan.opacity;
                break;
              case 'tear-down':
                // Defensive branch keeps the switch exhaustive.
                if (plan.idsToRestore.length > 0) {
                  await model.resetOpacity(plan.idsToRestore);
                }
                isolateGhostAppliedLocalSetRef.current = new Set();
                isolateGhostAppliedOpacityRef.current = 0;
                break;
            }
            // Ghost mode leaves the model visible, so reset the hidden-set tracker.
            appliedInvisibleLocalSet = new Set();
          } else {
            // Normal mode: hide non-isolated elements by delta.
            await clearIsolateGhostOpacity();
            await applyInvisibleSet(buildNonIsoLocalSet());
          }
        } else if (hiddenIds.length > 0) {
          const hiddenLocal = await expressToLocalIds(model, hiddenIds);
          await clearIsolateGhostOpacity();
          await applyInvisibleSet(new Set(hiddenLocal));
        } else {
          // Reset all visibility owners back to the all-visible baseline.
          await clearIsolateGhostOpacity();
          await model.setVisible(allLocalIds, true);
          appliedInvisibleLocalSet = new Set();
        }
        if (viewerRef.current?.model !== model || !useStore.getState().modelLoaded) return;
        previousVisibilitySnapshot = {
          isolatedIds: [...isolatedIds],
          hiddenIds: [...hiddenIds],
          ghostModeOn: ghostOn,
        };
        // Force a coalesced render kick for visibility and opacity writes.
        requestFragmentUpdate('ghost-visibility');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('Model not found')) return;
        console.warn('Visibility update failed:', e);
      }
    };

    const scheduler = createRebuildScheduler({
      raf: (cb) => window.requestAnimationFrame(cb),
      cancelRaf: (handle) => window.cancelAnimationFrame(handle),
      run: () => {
        const state = useStore.getState();
        void applyVisibility(state.isolatedIds, state.hiddenIds, state.ghostModeOn);
      },
    });
    const unsubIso = useStore.subscribe((state) => state.isolatedIds, scheduler.schedule);
    const unsubHide = useStore.subscribe((state) => state.hiddenIds, scheduler.schedule);
    const unsubGhost = useStore.subscribe((state) => state.ghostModeOn, scheduler.schedule);
    scheduler.schedule();

    return () => {
      unsubIso();
      unsubHide();
      unsubGhost();
      scheduler.cancel();
    };
  }, [viewerReady, expressToLocalIds, requestFragmentUpdate]);

  // Clip planes are controller-owned; store updates are consumed transiently.
  const updateClipPlane = useStore((s) => s.updateClipPlane);
  const clipControllerRef = useRef<ClipPlaneController | null>(null);
  const clipEdgesServiceRef = useRef<ClipEdgesService | null>(null);
  const sectionBoxEnabled = useStore((s) => s.sectionBoxEnabled);
  const setSectionBoxEnabled = useStore((s) => s.setSectionBoxEnabled);
  const toggleSectionBox = useStore((s) => s.toggleSectionBox);
  const sectionBoxControllerRef = useRef<SectionBoxController | null>(null);

  useEffect(() => {
    if (!viewerReady || !viewerRef.current) return;
    const { components, world, modelCenter } = viewerRef.current;
    const clipper = components.get(OBC.Clipper);
    const edgesService = new ClipEdgesService(components, world as unknown as OBC.World);
    clipEdgesServiceRef.current = edgesService;
    const controller = new ClipPlaneController(clipper, world as unknown as OBC.World, modelCenter, {
      onOffsetChanged: (id, offset) => updateClipPlane(id, { offset }),
      clipEdgesService: edgesService,
    });
    clipControllerRef.current = controller;
    return () => {
      controller.dispose();
      edgesService.dispose();
      clipControllerRef.current = null;
      clipEdgesServiceRef.current = null;
    };
  }, [viewerReady, updateClipPlane]);

  // Section box controller for the viewer lifetime.
  useEffect(() => {
    if (!viewerReady || !viewerRef.current) return;
    const { components, world } = viewerRef.current;
    const clipper = components.get(OBC.Clipper);
    const ctrl = new SectionBoxController(clipper, world as unknown as OBC.World);
    sectionBoxControllerRef.current = ctrl;
    return () => {
      ctrl.dispose();
      sectionBoxControllerRef.current = null;
    };
  }, [viewerReady]);

  useEffect(() => {
    const controller = clipControllerRef.current;
    if (!controller) return;
    // Drag frames repaint cheaply; the delayed commit refreshes fragment state once.
    let commitTimer: number | null = null;
    const syncPlanes = (planes: Parameters<ClipPlaneController['sync']>[0]) => {
      controller.sync(planes);
      // Keep the shared clipper enabled while the section box is active.
      if (sectionBoxEnabled && viewerRef.current) {
        viewerRef.current.components.get(OBC.Clipper).enabled = true;
      }
      requestFragmentUpdate('manual', false, 'camera');
      if (commitTimer !== null) window.clearTimeout(commitTimer);
      commitTimer = window.setTimeout(() => {
        commitTimer = null;
        requestFragmentUpdate('manual');
      }, 160);
    };
    syncPlanes(useStore.getState().clipPlanes);
    const unsubscribe = useStore.subscribe((s) => s.clipPlanes, syncPlanes);
    return () => {
      unsubscribe();
      if (commitTimer !== null) {
        window.clearTimeout(commitTimer);
        commitTimer = null;
      }
    };
  }, [viewerReady, sectionBoxEnabled, requestFragmentUpdate]);

  // React to sectionBoxEnabled store changes - enable or disable the 6-plane crop.
  useEffect(() => {
    const ctrl = sectionBoxControllerRef.current;
    const refs = viewerRef.current;
    if (!ctrl || !refs) return;
    if (sectionBoxEnabled) {
      // Compute an AABB from the loaded model's center + size.
      const { modelCenter: c, modelSize: s } = refs;
      const half = s.clone().multiplyScalar(0.5);
      const box = new THREE.Box3(c.clone().sub(half), c.clone().add(half));
      ctrl.enable(box);
      refs.components.get(OBC.Clipper).enabled = true;
    } else {
      ctrl.disable();
    }
  }, [sectionBoxEnabled]);

  // Alt+B toggles the section box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.key.toLowerCase() !== 'b') return;
      // Avoid hijacking text fields.
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      toggleSectionBox();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [toggleSectionBox]);

  // Alt+X clips the section box to the selected element.
  useEffect(() => {
    if (!viewerReady) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.key.toLowerCase() !== 'x') return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      const { selectedElementId, clipToElementFn } = useStore.getState();
      if (selectedElementId != null && clipToElementFn) clipToElementFn(selectedElementId);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [viewerReady]);

  // Measurement tool: the controller owns scene state; Zustand owns preferences.
  const measurementMode = useStore((s) => s.measurement.mode);
  const measurementUnit = useStore((s) => s.measurement.unit);
  const setMeasurementMode = useStore((s) => s.setMeasurementMode);
  const measurementControllerRef = useRef<MeasurementController | null>(null);
  const [measurementSnapshot, setMeasurementSnapshot] = useState<MeasurementSnapshot | null>(null);

  /** Active furnishing merge, disposed on toggle-off. */
  const furnishingMergeRef = useRef<FurnishingMergeResult | null>(null);

  /** Per-storey AABB frustum culler. */
  const storeyFrustumCullerRef = useRef<StoreyFrustumCuller | null>(null);
  const elementFrustumCullerRef = useRef<ElementFrustumCuller | null>(null);
  /** GPU color-coded model picker used as a fast miss guard before raycast. */
  const fastPickerRef = useRef<OBC.FastModelPicker | null>(null);

  useEffect(() => {
    if (!viewerReady || !viewerRef.current) return;
    const { world, model } = viewerRef.current;
    const scene = world.scene.three as THREE.Scene;
    const controller = new MeasurementController(scene, model, {
      onChange: (snap) => setMeasurementSnapshot(snap),
    });
    measurementControllerRef.current = controller;
    // Seed the HUD with an empty snapshot.
    setMeasurementSnapshot(controller.snapshot());
    return () => {
      controller.dispose();
      measurementControllerRef.current = null;
      setMeasurementSnapshot(null);
      // Reset store mode so the next mount does not inherit measurement clicks.
      useStore.getState().setMeasurementMode('off');
    };
  }, [viewerReady]);

  useEffect(() => {
    const controller = measurementControllerRef.current;
    if (!controller) return;
    controller.setMode(measurementMode);
  }, [measurementMode]);

  // B5 mount point: wall drawing tool (Edit mode). ViewerPanel only owns the
  // instance lifetime - same seam as the MeasurementController above. The ref
  // feeds the pointer-up click hub; the state feeds the EditToolbar overlay.
  const wallDrawControllerRef = useRef<WallDrawController | null>(null);
  const [wallDrawController, setWallDrawController] = useState<WallDrawController | null>(null);
  useEffect(() => {
    if (!viewerReady || !viewerRef.current) return;
    const { world } = viewerRef.current;
    const controller = new WallDrawController({
      scene: world.scene.three as THREE.Scene,
      dom: world.renderer!.three.domElement,
      getCamera: () => world.camera.three as THREE.Camera,
    });
    wallDrawControllerRef.current = controller;
    setWallDrawController(controller);
    return () => {
      controller.dispose();
      wallDrawControllerRef.current = null;
      setWallDrawController(null);
    };
  }, [viewerReady]);

  // Escape cancels pending measurement points, then exits the tool.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const ctrl = measurementControllerRef.current;
      if (!ctrl || ctrl.getMode() === 'off') return;
      const snap = ctrl.snapshot();
      if (snap.pending.length > 0) {
        e.stopPropagation();
        ctrl.cancel();
      } else {
        e.stopPropagation();
        setMeasurementMode('off');
      }
    };
    // Capture phase keeps measurement Escape handling ahead of global shortcuts.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [setMeasurementMode]);

  /** Apply theme colors to the live 3D scene. */
  const applyTheme = useCallback((theme: ViewerTheme) => {
    const targets = sceneThemeTargetsRef.current ?? viewerRef.current;
    if (!targets) return;

    applySceneTheme(targets.world, targets.grid, theme);

    // Background and grid color changes render on the next normal tick.
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme, applyTheme]);

  // Grid visibility mirrors the persisted viewer preference.
  const gridVisible = useStore((s) => s.gridVisible);
  // Frustum-culling master switch from Settings > Performance.
  const frustumCullingEnabled = useStore((s) => s.frustumCullingEnabled);
  useEffect(() => {
    if (!viewerReady) return;
    const gridObj = viewerRef.current?.grid?.three;
    if (gridObj) {
      gridObj.visible = gridVisible;
    }
  }, [viewerReady, gridVisible]);

  // Furnishing merge replaces furnishing meshes with one static mesh.
  const furnishingMerged = useStore((s) => s.furnishingMerged);
  useEffect(() => {
    if (!viewerReady || !viewerRef.current) return;
    const { model, world } = viewerRef.current;
    const scene = world.scene.three as THREE.Scene;

    if (furnishingMerged) {
      void applyFurnishingMerge(model, scene).then((result) => {
        furnishingMergeRef.current = result;
        // Flush immediately after the merge visibility changes.
        requestFragmentUpdate('manual');
      });
    } else {
      if (furnishingMergeRef.current) {
        void furnishingMergeRef.current.dispose().then(() => {
          furnishingMergeRef.current = null;
          requestFragmentUpdate('manual');
        });
      }
    }
  }, [viewerReady, furnishingMerged, requestFragmentUpdate]);

  // Storey AABB frustum culler builds when model and tree are ready.
  const spatialTree = useStore((s) => s.spatialTree);

  useEffect(() => {
    if (!viewerReady || !viewerRef.current || !spatialTree) return;
    const { model } = viewerRef.current;
    let cancelled = false;

    // Backend metadata mode can seed the express-to-local cache directly.
    const bridgeEntries = modelService.getIdBridgeEntries();
    if (bridgeEntries && bridgeEntries.length > 0) {
      const cache = expressToLocalCacheRef.current;
      for (const [localId, expressId] of bridgeEntries) {
        if (!cache.has(expressId)) cache.set(expressId, localId);
      }
      return;
    }

    const expressIds = collectLeavesUnder(spatialTree);
    void prewarmExpressToLocalCache(model, expressIds, expressToLocalCacheRef.current, {
      batchSize: 16,
      isCancelled: () => cancelled || viewerRef.current?.model !== model,
      yieldAfterBatch: () => new Promise<void>((resolve) => {
        window.setTimeout(resolve, 8);
      }),
    }).catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [viewerReady, spatialTree]);

  useEffect(() => {
    if (!viewerReady || !viewerRef.current || !spatialTree) return;
    const { model } = viewerRef.current;

    // Dispose the previous culler and restore any hidden storeys.
    const prev = storeyFrustumCullerRef.current;
    if (prev) {
      // Repaint after clearCull restores visibility.
      void prev.dispose(model).then(() => requestFragmentUpdate('culler-show'));
      storeyFrustumCullerRef.current = null;
    }

    // Master switch from Settings > Performance.
    if (!frustumCullingEnabled) return;

    const storeyNodes = extractStoreyNodes(spatialTree);
    if (storeyNodes.length < 2) {
      // Single-storey or no storeys - culling has no benefit.
      return;
    }

    // Size gate keeps storey culling off for models where it adds no benefit.
    const totalLeaves = collectLeavesUnder(spatialTree).length;
    const policy = decideCullerPolicy({
      navigationState: 'idle',
      elementCount: totalLeaves,
      isolatedCount: 0,
      hiddenCount: 0,
      storeyCullerBuilt: true,
      elementCullerBuilt: true,
      autoCulledCount: 0,
    });
    if (!policy.storeyCullerEnabled) return;

    // Padding keeps storey-edge geometry stable during small pans.
    const culler = new StoreyFrustumCuller({ padFraction: 0.03 });
    storeyFrustumCullerRef.current = culler;

    // Fire-and-forget async build; resolved ids reuse the express-to-local cache.
    void culler.build(model, storeyNodes, expressToLocalCacheRef.current)
      .catch(() => {/* build failure is silent */});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerReady, spatialTree, frustumCullingEnabled]);

  // Element-level AABB frustum culler.
  useEffect(() => {
    if (!viewerReady || !viewerRef.current || !spatialTree) return;
    const { model } = viewerRef.current;

    // Dispose the previous culler and restore any hidden elements.
    const prev = elementFrustumCullerRef.current;
    if (prev) {
      // Repaint after clearCull restores visibility (see storey effect).
      void prev.dispose(model).then(() => requestFragmentUpdate('culler-show'));
      elementFrustumCullerRef.current = null;
    }

    // Master switch from Settings > Performance.
    if (!frustumCullingEnabled) return;

    // Skip element culling for small models where the visibility churn costs more.
    const allExpressIds = collectLeavesUnder(spatialTree);
    const policy = decideCullerPolicy({
      navigationState: 'idle',
      elementCount: allExpressIds.length,
      isolatedCount: 0,
      hiddenCount: 0,
      storeyCullerBuilt: false,
      elementCullerBuilt: true,
      autoCulledCount: 0,
    });
    if (!policy.elementCullerEnabled) return;

    // Padding keeps frustum-edge elements from flapping visible/hidden.
    const culler = new ElementFrustumCuller({ padFraction: 0.03 });
    elementFrustumCullerRef.current = culler;

    // Convert leaf express ids through the cache-backed resolver, then build.
    const buildAsync = async () => {
      try {
        const localIds = await expressToLocalIds(model, allExpressIds);
        if (localIds.length > 0) {
          await culler.build(model, localIds);
        }
      } catch { /* build failure is silent */ }
    };
    void buildAsync();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerReady, spatialTree, frustumCullingEnabled]);

  const computeFitDistance = useCallback(
    (
      camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
      size: THREE.Vector3,
      padding = 1.1,
    ) => {
      const sx = Math.max(size.x, 0.001);
      const sy = Math.max(size.y, 0.001);
      const sz = Math.max(size.z, 0.001);

      if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
        const persp = camera as THREE.PerspectiveCamera;
        const vFov = THREE.MathUtils.degToRad(persp.fov);
        const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(0.1, persp.aspect));
        const fitHeight = (sy / 2) / Math.tan(vFov / 2);
        const fitWidth = (sx / 2) / Math.tan(hFov / 2);
        return (Math.max(fitHeight, fitWidth) + sz * 0.8) * padding;
      }

      return Math.max(sx, sy, sz) * 1.5 * padding;
    },
    [],
  );

  const applyCameraPreset = useCallback(
    (view: string, animate: boolean) => {
      if (!viewerRef.current) return;

      const { world, modelCenter: c, modelSize: s } = viewerRef.current;
      const camera = world.camera.three as THREE.PerspectiveCamera | THREE.OrthographicCamera;
      const distance = computeFitDistance(camera, s, 1.08);

      const vectors: Record<string, THREE.Vector3> = {
        front: new THREE.Vector3(0, 0.18, 1),
        back: new THREE.Vector3(0, 0.18, -1),
        left: new THREE.Vector3(-1, 0.18, 0),
        right: new THREE.Vector3(1, 0.18, 0),
        top: new THREE.Vector3(0, 1, 0.0001),
        bottom: new THREE.Vector3(0, -1, 0.0001),
        iso: new THREE.Vector3(1, 0.76, 1),
      };

      const dir = vectors[view];
      if (!dir) return;
      dir.normalize();
      const pos = c.clone().addScaledVector(dir, distance);

      // Normalize accumulated orbit angles so preset animation takes the short path.
      if (animate) world.camera.controls.normalizeRotations();

      world.camera.controls.setLookAt(pos.x, pos.y, pos.z, c.x, c.y, c.z, animate);
      useStore.getState().logActivity({ kind: 'view', summary: `Camera: ${view}` });
    },
    [computeFitDistance],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    const components = new OBC.Components();
    const initStart = performance.now();
    let perfSamplingCleanup: (() => void) | null = null;
    let firstFrameCaptured = false;
    let removePanelResizeHooks: (() => void) | null = null;
    let viewHelperCleanup: (() => void) | null = null;
    let pixelRatioCleanup: (() => void) | null = null;
    let renderOnDemandCleanup: (() => void) | null = null;
    let zFightingCleanup: (() => void) | null = null;
    let fragmentUpdateScheduler: FragmentUpdateScheduler | null = null;
    let hoverIntentTimer: number | null = null;
    // Unsubscribe for the viewer-performance-mode listener.
    let interactionQualityUnsub: (() => void) | null = null;
    const startupState = useStore.getState();
    const graphicsProfile = startupState.graphicsProfile;
    const cachePolicy = startupState.cachePolicy;
    const useServerCache = startupState.useServerCache;
    const startupMode = startupState.startupMode;
    const rendererMode = startupState.rendererMode;
    // rendererMode preference is stored; WebGPU path wires in when @thatopen adds support.
    // For now, log the preference (dev only) and use WebGL 2 (OBC.SimpleRenderer).
    if (import.meta.env.DEV) {
      console.debug(`[viewer] rendererMode=${rendererMode} -> using WebGL 2 (OBC.SimpleRenderer)`);
    }

    let modelLoadSource: ViewerModelLoadSource = 'ifc-parse';
    const stageTimings: ViewerLoadStageTimings = {};
    // Lifted to useEffect scope so cleanup can dispose if component unmounts mid-stream.
    let storeySubModel: FRAGS.FragmentsModel | null = null;
    // Native preview - hoisted so the cleanup return can abort + dispose.
    let nativePreview: NativeGeometryPreview | null = null;
    const nativePreviewAbort = new AbortController();

    async function init() {
      // Show slow-load feedback after 20 s on any loading path.
      const globalSlowTimer = window.setTimeout(() => {
        if (!disposed) setLoadingSlow(true);
      }, 20_000);
      try {
        // Install three-mesh-bvh global monkey-patch once at viewer boot so
        // all THREE.Raycaster.intersectObjects calls are BVH-accelerated.
        installBVH();

        // Set up the 3D world
        const worlds = components.get(OBC.Worlds);
        const world = worlds.create<
          OBC.SimpleScene,
          OBC.SimpleCamera,
          OBC.SimpleRenderer
        >();

        world.scene = new OBC.SimpleScene(components);
        // Renderer flags are construction-time only and come from the graphics profile.
        const rendererFlags = getRendererFlagsForProfile(graphicsProfile);
        world.renderer = new OBCF.PostproductionRenderer(components, container!, {
          antialias: rendererFlags.antialias,
          logarithmicDepthBuffer: rendererFlags.logarithmicDepthBuffer,
          powerPreference: 'high-performance',
          stencil: false,
          preserveDrawingBuffer: false,
        });
        try {
          const ppRenderer = world.renderer as unknown as OBCF.PostproductionRenderer;
          // Keep postprocessing manual-mode churn off when the composer is disabled.
          ppRenderer.turnOffOnManualMode = false;
          ppRenderer.manualModeDelay = 120;
        } catch {
          /* older @thatopen/components-front versions may not expose these knobs */
        }
        // On-demand rendering keeps engine updates alive while drawing only after visual changes.
        let renderKick: (ms?: number) => void = () => {};
        if (RENDER_ON_DEMAND) {
          try {
            const onDemandRenderer = world.renderer as unknown as {
              mode: OBC.RendererMode;
              needsUpdate: boolean;
            };
            onDemandRenderer.mode = OBC.RendererMode.MANUAL;
            let renderUntilTs = performance.now() + 1500; // initial paint window
            renderKick = (ms = 300) => {
              const until = performance.now() + ms;
              if (until > renderUntilTs) renderUntilTs = until;
              onDemandRenderer.needsUpdate = true;
            };
            const keepAliveMs = import.meta.env.DEV ? 1000 : 0;
            let lastKeepAlive = performance.now();
            let dirtyLoopHandle = 0;
            const dirtyLoop = () => {
              if (disposed) return;
              const now = performance.now();
              if (now < renderUntilTs) {
                onDemandRenderer.needsUpdate = true;
              } else if (keepAliveMs > 0 && now - lastKeepAlive >= keepAliveMs) {
                lastKeepAlive = now;
                onDemandRenderer.needsUpdate = true;
              }
              dirtyLoopHandle = window.requestAnimationFrame(dirtyLoop);
            };
            dirtyLoopHandle = window.requestAnimationFrame(dirtyLoop);
            renderOnDemandCleanup = () => {
              window.cancelAnimationFrame(dirtyLoopHandle);
              try {
                onDemandRenderer.mode = OBC.RendererMode.AUTO;
              } catch { /* renderer may already be disposed */ }
            };
            // Input-level kicks cover interactions outside the fragment scheduler.
            const kickOnPointer = (e: PointerEvent) => {
              if (e.buttons !== 0) renderKick(200);
            };
            const kickOnWheel = () => renderKick(400);
            container!.addEventListener('pointermove', kickOnPointer, { passive: true });
            container!.addEventListener('pointerdown', kickOnPointer, { passive: true });
            container!.addEventListener('wheel', kickOnWheel, { passive: true });
            // Store-driven visuals without camera events still need draw kicks.
            const unsubThemeKick = useStore.subscribe(
              (s) => s.theme,
              () => renderKick(400),
            );
            const unsubClipKick = useStore.subscribe(
              (s) => s.clipPlanes,
              () => renderKick(400),
            );
            const prevCleanup = renderOnDemandCleanup;
            renderOnDemandCleanup = () => {
              container!.removeEventListener('pointermove', kickOnPointer);
              container!.removeEventListener('pointerdown', kickOnPointer);
              container!.removeEventListener('wheel', kickOnWheel);
              unsubThemeKick();
              unsubClipKick();
              prevCleanup?.();
            };
          } catch {
            /* flag is best-effort: any shape mismatch keeps AUTO mode */
          }
        }
        // Postproduction starts disabled until an effect needs it.
        try {
          const pp = (world.renderer as unknown as OBCF.PostproductionRenderer).postproduction;
          pp.enabled = false;
          pp.edgesPass.mode = OBCF.EdgeDetectionPassMode.GLOBAL;
          postproductionRef.current = pp;
        } catch {
          postproductionRef.current = null;
        }
        // Disable the unused engine CSS2D pass; measurement labels use their own renderer.
        try {
          const with2D = world.renderer as unknown as {
            three2D?: { render: (...args: unknown[]) => void };
          };
          if (with2D.three2D) with2D.three2D.render = () => {};
        } catch { /* engine internals may change shape - stub is best-effort */ }
        world.camera = new OBC.SimpleCamera(components);
        // Tune camera controls for responsive orbiting and close indoor zoom.
        try {
          const feel = world.camera.controls;
          feel.smoothTime = 0.12;
          feel.draggingSmoothTime = 0.05;
          feel.minDistance = 0.5;
        } catch { /* camera-controls API varies by version - best-effort */ }

        // Use a close near plane so indoor orbiting does not clip nearby faces.
        try {
          const cam = world.camera.three;
          if (cam instanceof THREE.PerspectiveCamera) {
            cam.near = 0.05;
            cam.far = 5000;
            cam.updateProjectionMatrix();
          }
        } catch { /* best-effort */ }

        // Match device pixel ratio within a bounded cap for sharper orbiting.
        const HARD_PIXEL_RATIO_CAP = 2;
        const targetPixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
        const navigationPixelRatioCap = 1.0;
        const cameraSettleDelayMs = 320;
        const cullerShowPassMinIntervalMs = 220;
        let activePixelRatioCap = targetPixelRatio;
        const applyPixelRatio = () => {
          try {
            const r = world.renderer!.three;
            const nextPixelRatio = Math.min(window.devicePixelRatio || 1, activePixelRatioCap);
            const cont = container!;
            // Skip setSize when the ratio and backing buffer are already correct.
            const wantW = Math.floor(cont.clientWidth * nextPixelRatio);
            const wantH = Math.floor(cont.clientHeight * nextPixelRatio);
            const canvasEl = r.domElement;
            if (
              r.getPixelRatio() === nextPixelRatio
              && canvasEl.width === wantW
              && canvasEl.height === wantH
            ) {
              return;
            }
            if (r.getPixelRatio() !== nextPixelRatio) {
              r.setPixelRatio(nextPixelRatio);
            }
            // setSize applies the new ratio to the canvas backing buffer.
            r.setSize(cont.clientWidth, cont.clientHeight, true);
            // The realloc cleared the drawing buffer; repaint it.
            renderKick(250);
          } catch { /* best-effort */ }
        };
        const setInteractionPixelRatioCap = (cap: number) => {
          activePixelRatioCap = Math.min(HARD_PIXEL_RATIO_CAP, Math.max(1, cap));
          applyPixelRatio();
        };
        // Restore the pixel-ratio cap chosen by the interaction-quality ladder.
        const restoreLadderPixelRatioCap = () => {
          setInteractionPixelRatioCap(
            getRuntimeQualitySettings(interactionQualityRef.current.active).pixelRatioCap,
          );
        };
        applyPixelRatio();

        // Lower DPR only for sustained drags; wheel zoom and short nudges stay sharp.
        const DPR_DROP_DELAY_MS = 180;
        const WHEEL_GESTURE_WINDOW_MS = 300;
        // Deferred drops require recent camera motion to avoid pointless reallocs.
        const DPR_DROP_RECENT_MOTION_MS = 120;
        let lastCameraUpdateTs = -Infinity;
        let dprDropTimer: number | null = null;
        let lastWheelTs = -Infinity;
        try {
          world.renderer!.three.domElement.addEventListener(
            'wheel',
            () => { lastWheelTs = performance.now(); },
            { passive: true },
          );
        } catch { /* best-effort */ }
        const isWheelGesture = () => performance.now() - lastWheelTs < WHEEL_GESTURE_WINDOW_MS;
        const cancelDprDrop = () => {
          if (dprDropTimer !== null) {
            window.clearTimeout(dprDropTimer);
            dprDropTimer = null;
          }
        };

        // Explicit color management keeps materials and highlights stable across bundles.
        try {
          const r = world.renderer!.three;
          r.outputColorSpace = THREE.SRGBColorSpace;
          r.toneMapping = THREE.NeutralToneMapping;
          r.toneMappingExposure = 1.0;
        } catch { /* best-effort */ }

        // Re-apply pixelRatio after container resize.
        const pixelRatioObserver = new ResizeObserver(() => {
          applyPixelRatio();
        });
        pixelRatioObserver.observe(container!);
        pixelRatioCleanup = () => pixelRatioObserver.disconnect();

        components.init();
        updateLoadProgress({
          title: 'Booting 3D runtime',
          detail: 'Creating scene, camera controls, and fragment worker...',
          progress: 10,
          sourceHint: 'Startup',
        });

        // Configure scene; applyTheme keeps the background theme-aware.
        world.scene.setup({
          backgroundColor: new THREE.Color(0x0a0a1a),
        });
        // Rebalance default lights so face orientation remains readable.
        try {
          const sceneThree = world.scene.three as THREE.Scene;
          for (const child of sceneThree.children) {
            if (child instanceof THREE.AmbientLight) child.intensity = 0.4;
            else if (child instanceof THREE.DirectionalLight) child.intensity = 2.0;
          }
        } catch { /* lighting fallback not critical */ }
        sceneThemeTargetsRef.current = { world: world as unknown as ViewerRefs['world'] };
        applyTheme(useStore.getState().theme);

        // Fill lighting keeps dark IFC materials readable from all directions.
        try {
          const sceneThree = world.scene.three as THREE.Scene;

          // Sky/ground hemisphere fill for shadowed surfaces.
          const hemi = new THREE.HemisphereLight(0xffffff, 0x6b7280, 0.75);
          hemi.name = 'hemi-fill';
          sceneThree.add(hemi);

          // Soft ambient floor so even fully-shadowed regions stay visible.
          const amb = new THREE.AmbientLight(0xffffff, 0.55);
          amb.name = 'ambient-fill';
          sceneThree.add(amb);

          // Counter-key light for faces turned away from the primary light.
          const counterKey = new THREE.DirectionalLight(0xffffff, 0.6);
          counterKey.position.set(-30, 40, -30);
          counterKey.name = 'counter-key';
          sceneThree.add(counterKey);
        } catch {
          /* lighting fallback not critical */
        }

        // Camera position
        world.camera.controls.setLookAt(15, 15, 15, 0, 0, 0);

        // Interactive 3D view gizmo (three.js ViewHelper). Renders a 128px
        // axis indicator in the TOP-right of the canvas that rotates with
        // the camera. Click an axis to snap the camera view. We bypass both
        // ViewHelper's built-in render (which places the gizmo bottom-right)
        // and its camera animation (which fights camera-controls), and route
        // axis picks through applyCameraPreset instead.
        const viewHelperCanvas = world.renderer!.three.domElement;
        const viewHelper = new ViewHelper(world.camera.three, viewHelperCanvas);
        viewHelper.setLabels('X', 'Y', 'Z');

        const GIZMO_DIM = 128;
        const gizmoOrthoCam = new THREE.OrthographicCamera(-2, 2, 2, -2, 0, 4);
        gizmoOrthoCam.position.set(0, 0, 2);
        gizmoOrthoCam.updateProjectionMatrix();
        gizmoOrthoCam.updateMatrixWorld(true);
        const gizmoViewportBackup = new THREE.Vector4();

        // Honest per-frame counters (perf HUD chip, __ifcRenderStats).
        // THREE.js's `renderer.info.autoReset = true` (default) clears the
        // draw-call / triangle counters at the START of every
        // renderer.render() call, so the gizmo pass below used to wipe the
        // main scene's counts. Worse, a plain "manual reset on
        // onBeforeUpdate" is not enough either: the engine's RendererWith2D
        // base class re-triggers onBeforeUpdate from inside its own
        // constructor-time onAfterUpdate handler (it runs before any handler
        // we add), so a reset riding onBeforeUpdate fires AGAIN right after
        // the main render and the frame still ends gizmo-only (the perf
        // log's 9 calls / 72 tris). The fix:
        //   - autoReset stays off; we reset ONCE per frame at the real frame
        //     start, guarded by a cycle flag so the engine's re-trigger is a
        //     no-op;
        //   - renderGizmo accounts its own contribution into overlay
        //     counters;
        //   - after all overlay passes, captureMainPassStats snapshots
        //     (totals - overlay) into the renderStatsSnapshot singleton,
        //     which is what the HUD sampler and __ifcRenderStats read.
        // Off-frame passes (fast-picker ID pass, __ifcRenderStats' probe
        // render) land AFTER the capture and are wiped by the next frame's
        // reset, so they can never leak into the snapshot. Under
        // RENDER_ON_DEMAND no frame means no reset and no capture - the
        // snapshot keeps describing the frame that is actually on screen.
        world.renderer!.three.info.autoReset = false;
        let renderCycleOpen = false;
        let overlayDrawCalls = 0;
        let overlayTriangles = 0;
        const resetRenderInfo = () => {
          if (disposed || renderCycleOpen) return;
          renderCycleOpen = true;
          overlayDrawCalls = 0;
          overlayTriangles = 0;
          world.renderer!.three.info.reset();
        };
        world.renderer!.onBeforeUpdate.add(resetRenderInfo);

        const renderGizmo = () => {
          if (disposed) return;
          try {
            const renderer = world.renderer!.three;
            // Keep ViewHelper oriented to the main camera.
            viewHelper.quaternion.copy(world.camera.three.quaternion).invert();
            viewHelper.updateMatrixWorld(true);
            // WebGL viewport origin is bottom-left, so top-right of the canvas
            // is x = width - dim, y = height - dim.
            const x = viewHelperCanvas.offsetWidth - GIZMO_DIM;
            const y = viewHelperCanvas.offsetHeight - GIZMO_DIM;
            // CRITICAL: disable autoClear before the gizmo render. THREE.js's
            // renderer.render() calls renderer.clear() (color+depth+stencil)
            // when autoClear=true, IGNORING the viewport, so leaving it on
            // would wipe the main scene we just drew. We still manually
            // clear depth so gizmo depth-testing is independent.
            const savedAutoClear = renderer.autoClear;
            renderer.autoClear = false;
            renderer.clearDepth();
            renderer.getViewport(gizmoViewportBackup);
            renderer.setViewport(x, y, GIZMO_DIM, GIZMO_DIM);
            const callsBefore = renderer.info.render.calls;
            const trianglesBefore = renderer.info.render.triangles;
            renderer.render(viewHelper, gizmoOrthoCam);
            // Book the gizmo's cost as overlay so captureMainPassStats can
            // report the main scene alone.
            overlayDrawCalls += renderer.info.render.calls - callsBefore;
            overlayTriangles += renderer.info.render.triangles - trianglesBefore;
            renderer.setViewport(
              gizmoViewportBackup.x,
              gizmoViewportBackup.y,
              gizmoViewportBackup.z,
              gizmoViewportBackup.w,
            );
            renderer.autoClear = savedAutoClear;
          } catch {
            /* best-effort overlay; never break the main render */
          }
        };
        world.renderer!.onAfterUpdate.add(renderGizmo);

        // Registered AFTER renderGizmo on purpose: OBC events run handlers
        // in insertion order, so by the time this runs the frame's overlay
        // passes are fully booked and the counters hold the frame total.
        const captureMainPassStats = () => {
          if (disposed) return;
          renderCycleOpen = false;
          const info = world.renderer!.three.info;
          recordMainPass(
            info.render.calls,
            info.render.triangles,
            overlayDrawCalls,
            overlayTriangles,
            performance.now(),
          );
        };
        world.renderer!.onAfterUpdate.add(captureMainPassStats);

        // Click-to-align: raycast against ViewHelper's interactive sprites
        // using the same NDC math, adjusted for the top-right placement.
        const GIZMO_VIEW_MAP: Record<string, string> = {
          posX: 'right', negX: 'left',
          posY: 'top',   negY: 'bottom',
          posZ: 'front', negZ: 'back',
        };
        const gizmoRaycaster = new THREE.Raycaster();
        const gizmoMouseNdc = new THREE.Vector2();

        const hitGizmoAxis = (event: PointerEvent): string | null => {
          const domEl = world.renderer!.three.domElement;
          const rect = domEl.getBoundingClientRect();
          const offsetX = rect.left + (domEl.offsetWidth - GIZMO_DIM);
          const offsetY = rect.top;
          const boundY = rect.top + GIZMO_DIM;
          if (
            event.clientX < offsetX || event.clientX > rect.right ||
            event.clientY < offsetY || event.clientY > boundY
          ) return null;
          gizmoMouseNdc.x = ((event.clientX - offsetX) / (rect.right - offsetX)) * 2 - 1;
          gizmoMouseNdc.y = -((event.clientY - offsetY) / (boundY - offsetY)) * 2 + 1;
          gizmoRaycaster.setFromCamera(gizmoMouseNdc, gizmoOrthoCam);
          viewHelper.quaternion.copy(world.camera.three.quaternion).invert();
          viewHelper.updateMatrixWorld(true);
          const intersects = gizmoRaycaster.intersectObjects(viewHelper.children, false);
          for (const hit of intersects) {
            const type = hit.object?.userData?.type;
            if (typeof type === 'string' && type in GIZMO_VIEW_MAP) return type;
          }
          return null;
        };

        // Capture-phase listeners short-circuit the existing selection
        // raycast so a click on the gizmo doesn't also clear selection.
        let gizmoClickConsumed = false;
        const onGizmoPointerDown = (event: PointerEvent) => {
          if (event.button !== 0) return;
          const type = hitGizmoAxis(event);
          if (!type) return;
          const view = GIZMO_VIEW_MAP[type];
          if (!view) return;
          gizmoClickConsumed = true;
          event.stopImmediatePropagation();
          event.preventDefault();
          applyCameraPreset(view, true);
        };
        const onGizmoPointerUp = (event: PointerEvent) => {
          if (!gizmoClickConsumed) return;
          gizmoClickConsumed = false;
          event.stopImmediatePropagation();
          event.preventDefault();
        };
        viewHelperCanvas.addEventListener('pointerdown', onGizmoPointerDown, true);
        viewHelperCanvas.addEventListener('pointerup', onGizmoPointerUp, true);

        viewHelperCleanup = () => {
          try { world.renderer!.onAfterUpdate.remove(renderGizmo); } catch { /* renderer may be disposed */ }
          try { world.renderer!.onAfterUpdate.remove(captureMainPassStats); } catch { /* renderer may be disposed */ }
          try { world.renderer!.onBeforeUpdate.remove(resetRenderInfo); } catch { /* renderer may be disposed */ }
          resetMainPassStats();
          viewHelperCanvas.removeEventListener('pointerdown', onGizmoPointerDown, true);
          viewHelperCanvas.removeEventListener('pointerup', onGizmoPointerUp, true);
          try { viewHelper.dispose(); } catch { /* best-effort */ }
        };

        // Grid
        const grids = components.get(OBC.Grids);
        const grid = grids.create(world);
        sceneThemeTargetsRef.current = {
          world: world as unknown as ViewerRefs['world'],
          grid: grid as unknown as ViewerRefs['grid'],
        };
        applyTheme(useStore.getState().theme);

        // FastModelPicker - GPU color-coded pass for fast miss-detection.
        // getModelAt() renders one flat-shaded pass and reads back one pixel:
        // returns a model UUID if geometry sits under the cursor, or null for
        // empty space. We use it as a pre-filter before model.raycast() so
        // hover and click events skip the expensive triangle traversal when
        // the cursor is over void. models.dispose() is called by components.dispose().
        try {
          const pickers = components.get(OBC.FastModelPickers);
          fastPickerRef.current = pickers.get(world as unknown as OBC.World);
        } catch {
          // FastModelPicker may be unavailable in some preview/test environments.
          fastPickerRef.current = null;
        }

        // Initialize fragments with a blob-backed worker for broader runtime compatibility.
        const fragmentsManager = components.get(OBC.FragmentsManager);
        // Pace forced flushes around the engine maxUpdateRate guard.
        let droppedForcedFlushes = 0;
        // Resolve `core` lazily because the getter is unavailable before init().
        const readEngineLastUpdate = (): number | null => {
          const enginePacing = fragmentsManager.core as unknown as { _lastUpdate?: unknown };
          return typeof enginePacing._lastUpdate === 'number' ? enginePacing._lastUpdate : null;
        };
        const coreUpdatePaced = async (force: boolean): Promise<void> => {
          if (!force) {
            await fragmentsManager.core.update(false);
            return;
          }
          const tForcedStart = performance.now();
          for (let attempt = 0; attempt < 3; attempt += 1) {
            // Route disposed updates through the scheduler error path.
            if (disposed) throw new Error('viewer-disposed');
            const last = readEngineLastUpdate();
            const rate = fragmentsManager.core.settings.maxUpdateRate;
            if (last !== null && rate > 0) {
              const since = performance.now() - last;
              if (since < rate) {
                await new Promise((resolve) => {
                  window.setTimeout(resolve, Math.max(1, Math.ceil(rate - since) + 1));
                });
              }
            }
            const callAt = performance.now();
            await fragmentsManager.core.update(true);
            const after = readEngineLastUpdate();
            // _lastUpdate advancing past callAt means the engine accepted the run.
            if (after === null || after >= callAt) {
              if (import.meta.env.DEV) {
                const attribution = clickFlushAttributionRef.current;
                attribution.paceWaitMs = callAt - tForcedStart;
                attribution.flushMs = performance.now() - callAt;
              }
              return;
            }
            droppedForcedFlushes += 1;
            if (import.meta.env.DEV) {
              console.debug('[viewer] forced fragment flush dropped by engine pacing - retrying', {
                attempt: attempt + 1,
                droppedForcedFlushes,
              });
            }
          }
          // Surface exhausted retries as a scheduler error.
          throw new Error('fragments forced update dropped by engine pacing (3 attempts)');
        };
        fragmentUpdateScheduler = createFragmentUpdateScheduler({
          raf: (cb) => window.requestAnimationFrame(cb),
          cancelRaf: (handle) => window.cancelAnimationFrame(handle),
          update: (force) => coreUpdatePaced(force),
          // Stamp click-highlight flush starts for latency attribution.
          onRunStart: (run) => {
            // Every scheduler run mutates visuals; keep painting through it.
            renderKick(350);
            if (import.meta.env.DEV && run.reasons.includes('click-highlight')) {
              clickFlushAttributionRef.current.runStartTs = performance.now();
            }
          },
          // Stop click-to-highlight timing only after the highlight flush completes.
          onRunEnd: (run, error) => {
            // The flush just landed worker results - paint them.
            renderKick(350);
            if (!run.reasons.includes('click-highlight')) return;
            if (error !== null) {
              // Drop abandoned probes so later unrelated flushes cannot consume them.
              pendingClickStartRef.current = null;
              return;
            }
            recordClickLatencyFlush();
          },
        });
        fragmentUpdateSchedulerRef.current = fragmentUpdateScheduler;
        if (import.meta.env.DEV) {
          (window as unknown as Record<string, unknown>).__ifcSchedSnapshot =
            () => fragmentUpdateSchedulerRef.current?.snapshot() ?? null;
        }
        {
          const workerHttpUrl = new URL('/worker.mjs', window.location.origin).href;
          let workerInitUrl = workerHttpUrl;
          try {
            const workerResp = await fetch(workerHttpUrl);
            if (workerResp.ok) {
              const workerText = await workerResp.text();
              const workerBlob = new Blob([workerText], { type: 'application/javascript' });
              workerInitUrl = URL.createObjectURL(workerBlob);
            }
          } catch {
            // Fallback to http URL if fetch fails
          }
          fragmentsManager.init(workerInitUrl);
          // Keep the blob URL alive; FragmentsManager reuses it on later loads.
          if (workerInitUrl !== workerHttpUrl) {
            workerBlobUrlRef.current = workerInitUrl;
          }
        }

        // Tune fragment update pacing for interaction-driven redraws.
        fragmentsManager.core.settings.maxUpdateRate = 8;
        fragmentsManager.core.settings.forceUpdateRate = 1;
        fragmentsManager.core.settings.forceUpdateBuffer = 2;

        // Guard fragments.core.load() against a disposed manager. When HMR or
        // any fast remount fires during the CPU-intensive WASM parse phase,
        // components.dispose() kills the fragment workers. The subsequent
        // core.load() call then creates a Worker that never sends 'ready' -
        // hanging the Promise chain forever at "Finalizing fragment model".
        // Patching the method lets the abandoned init() bail out cleanly.
        {
          const coreRef = fragmentsManager.core as unknown as { load: (...a: unknown[]) => Promise<unknown> };
          const origLoad = coreRef.load.bind(fragmentsManager.core);
          coreRef.load = (...args: unknown[]) => {
            if (disposed) return Promise.reject(new Error('viewer-disposed'));
            return origLoad(...args);
          };
        }

        // RENDER_ON_DEMAND: the engine's auto-redraw timer calls core.update
        // directly after worker messages (tile arrivals have no app-visible
        // event), bypassing the fragment scheduler. Wrap it so every
        // engine-driven update marks the scene dirty - same guarded instance
        // patch pattern as the core.load wrap above.
        if (RENDER_ON_DEMAND) {
          try {
            const coreAny = fragmentsManager.core as unknown as {
              update: (force?: boolean) => Promise<void>;
            };
            const origUpdate = coreAny.update.bind(fragmentsManager.core);
            coreAny.update = (force?: boolean) => {
              renderKick(350);
              return origUpdate(force);
            };
          } catch { /* best-effort: AUTO-equivalent painting via other kicks */ }
        }

        // Adaptive graphics quality is now driven by the
        // interaction-quality ladder (interactionQualityController.ts) instead
        // of a hardcoded GQ_IDLE/GQ_ORBIT binary. `applyInteractionQuality`
        // maps the ladder's `active` level onto the two real renderer knobs we
        // own here (graphicsQuality + interaction pixel-ratio cap);
        // `dispatchQuality` feeds the reducer and re-applies only when the
        // resolved `active` level changes. Navigation transitions push
        // 'navigation-start'/'navigation-end'; the store's viewer-performance
        // mode pushes 'set-target'. Starting at the resolved idle level keeps
        // the first frame at full target detail; the orbit-throttle only kicks
        // in on real motion.
        // Per-model LOD tier, decided once per load from element count (the
        // post-load tier block below fills it). Unknown ids (mid-load race)
        // default to 'medium', whose floor rule is the safe behavior.
        const modelLodTiers = new Map<string, LodTier>();
        // The engine copies core.settings.graphicsQuality onto a model ONCE at
        // load; the worker reads the PER-MODEL field on every view refresh.
        // Without these writes the ladder's quality arm does nothing for
        // loaded models (the settings write below only seeds future loads).
        // The tier policy (lodTierPolicy.ts) keeps the navigation drop away
        // from small/medium models where it would widen the cull band and
        // make elements vanish during orbit.
        const applyPerModelGraphicsQuality = (ladderQuality: number) => {
          const idleQuality =
            getRuntimeQualitySettings(interactionQualityRef.current.target).graphicsQuality;
          let changed = false;
          try {
            for (const [id, m] of fragmentsManager.core.models.list) {
              const tier = modelLodTiers.get(id) ?? 'medium';
              const next = resolveModelGraphicsQuality(tier, ladderQuality, idleQuality);
              const target = m as unknown as { graphicsQuality?: unknown };
              if (typeof target.graphicsQuality === 'number' && target.graphicsQuality !== next) {
                target.graphicsQuality = next;
                changed = true;
              }
            }
          } catch { /* engine without the field keeps load-time behavior */ }
          if (changed) {
            // Ship the new per-model value with the next view refresh. During
            // navigation the camera stream refreshes anyway; this covers the
            // idle case (user flips the performance mode in Settings).
            requestFragmentUpdate('manual', true, 'idle');
          }
        };
        const applyInteractionQuality = (active: RuntimeViewerQuality) => {
          const settings = getRuntimeQualitySettings(active);
          try {
            fragmentsManager.core.settings.graphicsQuality = settings.graphicsQuality;
          } catch { /* ignore */ }
          applyPerModelGraphicsQuality(settings.graphicsQuality);
          // The ladder's pixelRatioCap is the *navigation* cap when navigating
          // (lower = cheaper) and the idle cap otherwise; both are clamped to
          // the device-derived targetPixelRatio inside setInteractionPixelRatioCap.
          // Cap DROPS are hysteresis-gated (wheel gestures never
          // degrade; drags degrade only after sustained motion); raises and
          // non-navigation changes apply immediately. A pending deferred drop
          // is cancelled by ANY later quality apply (e.g. the settle restore),
          // so short gestures never touch the backbuffer at all.
          cancelDprDrop();
          const droppingForNav =
            interactionQualityRef.current.navigating
            && settings.pixelRatioCap < activePixelRatioCap;
          if (!droppingForNav) {
            setInteractionPixelRatioCap(settings.pixelRatioCap);
            return;
          }
          if (isWheelGesture()) return;
          dprDropTimer = window.setTimeout(() => {
            dprDropTimer = null;
            if (disposed) return;
            if (!cameraNavigatingRef.current || isWheelGesture()) return;
            // Real sustained motion only - see DPR_DROP_RECENT_MOTION_MS.
            if (performance.now() - lastCameraUpdateTs > DPR_DROP_RECENT_MOTION_MS) return;
            setInteractionPixelRatioCap(settings.pixelRatioCap);
          }, DPR_DROP_DELAY_MS);
        };
        const dispatchQuality = (event: InteractionQualityEvent) => {
          const prev = interactionQualityRef.current;
          const next = reduceInteractionQuality(prev, event);
          interactionQualityRef.current = next;
          if (next.active !== prev.active) {
            applyInteractionQuality(next.active);
          }
        };
        // Seed the ladder target from the current preference, then apply the
        // resolved idle level for the very first frame.
        dispatchQuality({
          type: 'set-target',
          target: performanceModeToQualityTarget(useStore.getState().viewerPerformanceMode),
        });
        applyInteractionQuality(interactionQualityRef.current.active);
        // Live-update the ladder target when the user changes viewer performance mode.
        const unsubscribePerformanceMode = useStore.subscribe(
          (s) => s.viewerPerformanceMode,
          (mode: ViewerPerformanceMode) => {
            if (disposed) return;
            dispatchQuality({ type: 'set-target', target: performanceModeToQualityTarget(mode) });
          },
        );
        interactionQualityUnsub = unsubscribePerformanceMode;

        // Resize paths keep idle graphics quality while lowering pixel-ratio cap.
        const resolveIdleGraphicsQuality = () =>
          getRuntimeQualitySettings(interactionQualityRef.current.target).graphicsQuality;

        // Shared load-path state.
        const cacheEnabled = cachePolicy !== 'off';
        let cacheKey: string | null = null;
        let localFragmentCacheChecked = false;
        let model: FRAGS.FragmentsModel | null = null;

        // Manifest fast path for remounts with server-cached fragments.
        const storedFingerprint = useStore.getState().modelFingerprint;
        const serverCapsForManifest = useStore.getState().serverConvertCaps;
        const hasStoredIfcBytesForManifest = !!useStore.getState().ifcFileBytes;
        const manifestAttempt = {
          hasFileBytes: hasStoredIfcBytesForManifest,
          fingerprint: storedFingerprint,
          serverConvertAvailable: isRecoverableServerConvertFailure(serverCapsForManifest),
        };
        if (!BROWSER_ONLY && useServerCache && shouldUseServerFragmentManifest(manifestAttempt)) {
          const graphicsProfileForManifest = resolveParseProfile(graphicsProfile, 0);
          updateLoadProgress({
            title: 'Checking server fragment cache',
            detail: 'Querying server manifest (no re-upload needed)...',
            progress: 14,
            sourceHint: 'Manifest check',
          });
          try {
            const manifest = await checkFragmentManifest(manifestAttempt.fingerprint, graphicsProfileForManifest);
            if (manifest.cached && manifest.serve_url && !disposed) {
              updateLoadProgress({
                title: 'Fetching cached fragments',
                detail: `Server cache hit (${((manifest.size_bytes ?? 0) / 1024).toFixed(0)} KB). Skipping IFC re-upload...`,
                progress: 50,
                sourceHint: 'Server manifest',
              });
              const manifestResult = await fetchFragmentByFingerprint(manifestAttempt.fingerprint, graphicsProfileForManifest);
              if (!disposed) {
                updateLoadProgress({
                  title: 'Loading manifest fragments',
                  detail: `Received ${(manifestResult.bytes.byteLength / 1024).toFixed(0)} KB.`,
                  progress: 75,
                  sourceHint: 'Server manifest',
                });
                const manifestModelId = makeViewerModelId();
                const manifestLoadStart = performance.now();
                model = await loadFragmentsWithTimeout(
                  fragmentsManager,
                  manifestResult.bytes,
                  manifestModelId,
                  {
                    autoCoordinate:
                      graphicsProfileForManifest === 'quality' ||
                      graphicsProfileForManifest === 'balanced',
                    graphicsQuality: resolveIdleGraphicsQuality(),
                  },
                );
                stageTimings.cacheLoadMs = performance.now() - manifestLoadStart;
                modelLoadSource = 'server-cache';
                useStore.getState().logActivity({
                  kind: 'info',
                  summary: `Load path chosen: server-cache (manifest fast-path) in ${stageTimings.cacheLoadMs.toFixed(0)} ms.`,
                });
              }
            }
          } catch {
            // Manifest path failed - fall through to normal load below.
            model = null;
          }
        }

        // Normal IFC byte fetch, skipped when the manifest already loaded the model.
        if (!model) {
          updateLoadProgress({
            title: 'Reading IFC bytes',
            detail: 'Using in-memory bytes or backend fallback...',
            progress: 16,
            sourceHint: 'Startup',
          });
        }

        // Prefer in-memory upload bytes, otherwise re-fetch from the backend.
        let fileBytes = useStore.getState().ifcFileBytes;
        if (!model && !fileBytes && BROWSER_ONLY) {
          // Browser-only builds have no server to re-fetch lost bytes from.
          throw new Error('Model bytes are no longer in memory. Drop the IFC file again to reload.');
        }
        if (!model && !fileBytes) {
          try {
            const resp = await fetch(apiUrl('/api/ifc/file'));
            if (!resp.ok) throw new Error(`server ${resp.status}`);
            const buf = await resp.arrayBuffer();
            fileBytes = new Uint8Array(buf);
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            throw new Error(`Could not load IFC from backend: ${msg}`);
          }
        }

        if (disposed) return;

        // Optional native preview paths stay separate from the production fragment loader.
        const streamingEnabled = import.meta.env.VITE_STREAMING_GEOMETRY === 'true';
        const serverConvertAvailableForPreview =
          useStore.getState().serverConvertCaps?.server_convert === true;
        const nativeGeometryPreviewEnabled =
          import.meta.env.VITE_NATIVE_GEOMETRY_PREVIEW === 'true';
        const shouldRunNativePreview =
          !!fileBytes && nativeGeometryPreviewEnabled && !serverConvertAvailableForPreview;
        if (shouldRunNativePreview && streamingEnabled) {
          const scene = world.scene?.three as THREE.Scene | undefined;
          const matCache = createStreamingMaterialCache();
          const group = new THREE.Group();
          group.name = 'native-geometry-preview-streaming';
          let firstBatchAt: number | null = null;
          const startedAt = performance.now();
          const previewShell: NativeGeometryPreview = {
            group,
            meshCount: 0,
            elapsedMs: 0,
            dispose: () => disposeStreamingPreview(group, matCache),
          };
          // Add the empty group up front; meshes will pop in as they arrive.
          if (scene) scene.add(group);
          nativePreview = previewShell;

          void streamNativeGeometry(
            { ifcBytes: fileBytes!, signal: nativePreviewAbort.signal },
            {
              onBatch: (_batchIndex, decoded: DecodedMesh[]) => {
                if (disposed || nativePreviewAbort.signal.aborted) return;
                if (firstBatchAt === null) {
                  firstBatchAt = performance.now();
                  useStore.getState().logActivity({
                    kind: 'info',
                    summary: `Streaming preview: first batch in ${(firstBatchAt - startedAt).toFixed(0)} ms.`,
                  });
                }
                appendBatchToGroup(group, matCache, decoded);
                previewShell.meshCount = group.children.length;
              },
              onSummary: (ev) => {
                previewShell.elapsedMs = ev.totalElapsedMs;
                useStore.getState().logActivity({
                  kind: 'info',
                  summary: `Streaming preview done: ${ev.meshCount} meshes in ${ev.totalElapsedMs} ms (${ev.batchCount} batches).`,
                });
              },
              onError: (ev) => {
                useStore.getState().logActivity({
                  kind: 'error',
                  summary: `Streaming preview error: ${ev.message}`,
                });
              },
            },
          ).catch(() => {
            // Leave any arrived batches in place; the main load replaces them shortly.
          });
        } else if (shouldRunNativePreview) {
          void fetchNativeGeometryPreview(fileBytes!, nativePreviewAbort.signal).then((preview) => {
            if (disposed || nativePreviewAbort.signal.aborted || !preview) return;
            nativePreview = preview;
            // Add preview group to the Three.js scene.
            const scene = world.scene?.three as THREE.Scene | undefined;
            if (scene) {
              scene.add(preview.group);
              useStore.getState().logActivity({
                kind: 'info',
                summary: `Native preview: ${preview.meshCount} meshes ready in ${preview.elapsedMs} ms.`,
              });
            }
          });
        }

        let effectiveGraphicsProfile = resolveParseProfile(graphicsProfile, fileBytes?.byteLength ?? 0);
        // Browser-only large files use the performance parse profile unless the user overrides it.
        if (
          BROWSER_ONLY &&
          graphicsProfile === 'balanced' &&
          (fileBytes?.byteLength ?? 0) >= AUTO_PERF_PROFILE_THRESHOLD_BYTES
        ) {
          effectiveGraphicsProfile = 'performance';
          useStore.getState().logActivity({
            kind: 'info',
            summary: `Large file (${((fileBytes!.byteLength) / (1024 * 1024)).toFixed(0)} MB) on the web build: parsing with the performance profile. Pick a profile in Settings > Performance to override.`,
          });
        }
        const coordinateModel = effectiveGraphicsProfile === 'quality' || effectiveGraphicsProfile === 'balanced';

        // Unique per-mount ID avoids Worker thread placeholder conflicts when
        // two browser tabs load simultaneously with the same fixed modelId.
        let modelId = makeViewerModelId();
        if (
          cacheEnabled &&
          fileBytes &&
          (BROWSER_ONLY || !shouldAttemptServerConvert(useStore.getState().serverConvertCaps, true))
        ) {
          updateLoadProgress({
            title: 'Resolving model source',
            detail: 'Checking fragment cache for this IFC...',
            progress: 22,
            sourceHint: 'Cache check',
          });

          cacheKey = await buildFragmentCacheKey(fileBytes, effectiveGraphicsProfile);
          const cacheReadStart = performance.now();
          const cachedFragments = await readFragmentCacheIDB(cacheKey, cachePolicy);
          localFragmentCacheChecked = true;
          stageTimings.cacheReadMs = performance.now() - cacheReadStart;
          if (cachedFragments) {
            try {
              updateLoadProgress({
                title: 'Loading cached fragments',
                detail: 'Cache hit. Skipping IFC parse and restoring geometry...',
                progress: 70,
                sourceHint: 'Cache hit',
              });
              const cacheLoadStart = performance.now();
              model = await loadFragmentsWithTimeout(
                fragmentsManager,
                cachedFragments,
                modelId,
                { autoCoordinate: coordinateModel, graphicsQuality: resolveIdleGraphicsQuality() },
              );
              stageTimings.cacheLoadMs = performance.now() - cacheLoadStart;
              modelLoadSource = 'fragments-cache';
              useStore.getState().logActivity({
                kind: 'info',
                summary: 'Load path chosen: local-fragment-cache (backend hard-unavailable; IFC parse skipped).',
              });
            } catch {
              model = null;
              // Clear stale worker placeholders before falling back to live parse.
              clearFragmentThreadPlaceholder(fragmentsManager, modelId);
              modelId = makeViewerModelId();
              updateLoadProgress({
                title: 'Cache fallback',
                detail: 'Cached fragments were stale. Switching to browser parse fallback...',
                progress: 24,
                sourceHint: 'worker-parse',
              });
            }
          }
        } else if (cacheEnabled && fileBytes) {
          updateLoadProgress({
            title: 'Resolving model source',
            detail: 'Preparing local fragment cache key. Backend conversion remains primary...',
            progress: 22,
            sourceHint: 'Server first',
          });
          cacheKey = await buildFragmentCacheKey(fileBytes, effectiveGraphicsProfile);
        } else if (!model) {
          updateLoadProgress({
            title: 'Resolving model source',
            detail: 'Fragment cache disabled. Backend conversion remains primary...',
            progress: 22,
            sourceHint: 'Server first',
          });
        }

        // Optional storey preview before the full sidecar convert completes.
        let storeyPreviewResult: StoreyFragmentResult | null = null;
        const streamingFp = useStore.getState().modelFingerprint;
        const streamingCaps = useStore.getState().serverConvertCaps;
        const storeyPreviewEnabled = import.meta.env.VITE_STOREY_FRAGMENT_PREVIEW === 'true';
        if (!model && storeyPreviewEnabled && isBackendShaFingerprint(streamingFp) && streamingCaps?.server_convert) {
          // Non-blocking: fetch storey[0] bytes; resolve/reject is handled below.
          const storeyFetchPromise = fetchStoreyFragment(streamingFp, 0).then(
            (r) => { storeyPreviewResult = r; },
          ).catch(() => { /* non-fatal: full model load continues unchanged */ });
          // Give the smaller storey fetch a short head start.
          await Promise.race([
            storeyFetchPromise,
            new Promise<void>((resolve) => setTimeout(resolve, 800)),
          ]);
          if (!disposed && storeyPreviewResult) {
            const previewResult = storeyPreviewResult as StoreyFragmentResult;
            const storeyModelId = `storey-s0-${Date.now()}`;
            try {
              storeySubModel = await loadFragmentsWithTimeout(
                fragmentsManager,
                previewResult.bytes,
                storeyModelId,
                {
                  timeoutMs: STOREY_FRAGMENT_LOAD_TIMEOUT_MS,
                  autoCoordinate: coordinateModel,
                  graphicsQuality: resolveIdleGraphicsQuality(),
                },
              );
              updateLoadProgress({
                title: 'Streaming storey 1...',
                detail: `First storey visible (${previewResult.storeyName}). Loading full model in background...`,
                progress: 45,
                sourceHint: 'Storey stream',
              });
              useStore.getState().logActivity({
                kind: 'info',
                summary: `Streaming: storey[0] "${previewResult.storeyName}" loaded as preview (source: ${previewResult.source}).`,
              });
            } catch {
              storeySubModel = null; // sub-model load failed - continue normally
            }
          }
        }

        // Reuse an in-flight backend pre-build before re-uploading IFC bytes.
        if (!model) {
          const serverCaps = useStore.getState().serverConvertCaps;
          const prebuildFingerprint = useStore.getState().modelFingerprint;
          const waitPrefs = useStore.getState().prebuildWaitPrefs;
          const prebuildWait = {
            caps: serverCaps,
            fingerprint: prebuildFingerprint,
            timeoutMs: waitPrefs.timeoutMs,
          };
          if (!BROWSER_ONLY && useServerCache && shouldWaitForServerPrebuild(prebuildWait)) {
            updateLoadProgress({
              title: 'Awaiting server pre-build',
              detail: 'Backend is already converting this file - waiting for cache...',
              progress: 22,
              sourceHint: 'Server pre-build',
            });
            const waitStart = performance.now();
            // Poll live pre-build progress while awaiting completion.
            const prebuildPollController = new AbortController();
            void pollConvertProgress(
              `${prebuildWait.fingerprint.slice(0, 12)}-${effectiveGraphicsProfile}`,
              {
                pollIntervalMs: 500,
                signal: prebuildPollController.signal,
                onProgress: (snapshot) => {
                  if (disposed || !snapshot.in_flight) return;
                  const pct = Math.max(0, Math.min(100, snapshot.progress ?? 0));
                  updateLoadProgress({
                    title: 'Awaiting server pre-build',
                    detail: snapshot.stage ?? '',
                    progress: 30 + Math.round(pct * 0.4),
                    sourceHint: 'Server convert',
                  });
                },
              },
            ).catch(() => undefined);
            let status;
            try {
              status = await waitForFragmentReady(
                prebuildWait.fingerprint,
                effectiveGraphicsProfile,
                {
                  timeoutMs: waitPrefs.timeoutMs,
                  pollIntervalMs: waitPrefs.pollIntervalMs,
                },
              );
            } finally {
              prebuildPollController.abort();
            }
            if (status.status === 'complete' && status.serve_url && !disposed) {
              try {
                const fetched = await fetchFragmentByFingerprint(
                  prebuildWait.fingerprint,
                  effectiveGraphicsProfile,
                );
                stageTimings.sidecarMs = performance.now() - waitStart;
                updateLoadProgress({
                  title: 'Loading pre-built fragments',
                  detail: `Cache hit (${(fetched.bytes.byteLength / 1024).toFixed(0)} KB). Skipping IFC upload.`,
                  progress: 70,
                  sourceHint: 'Server pre-build',
                });
                const fragLoadStart = performance.now();
                model = await loadFragmentsWithTimeout(
                  fragmentsManager,
                  fetched.bytes,
                  modelId,
                  { autoCoordinate: coordinateModel },
                );
                stageTimings.cacheLoadMs = performance.now() - fragLoadStart;
                modelLoadSource = 'server-cache';
                if (cacheKey && cachePolicy !== 'off') {
                  void writeRawFragmentCacheIDB(cacheKey, fetched.bytes, cachePolicy);
                }
                useStore.getState().logActivity({
                  kind: 'info',
                  summary: `Load path chosen: server-cache (pre-build hit) in ${stageTimings.sidecarMs.toFixed(0)} ms.`,
                });
              } catch (servErr) {
                // Cache race: fall through to the upload path.
                clearFragmentThreadPlaceholder(fragmentsManager, modelId);
                modelId = makeViewerModelId();
                const msg = servErr instanceof Error ? servErr.message : String(servErr);
                useStore.getState().logActivity({
                  kind: 'info',
                  summary: `Server pre-build serve failed (${msg}). Falling back to upload.`,
                });
              }
            }
          }
        }

        // Server-side fragment conversion is the default cold-load path.
        if (!model && !BROWSER_ONLY) {
          let serverCaps = useStore.getState().serverConvertCaps;
          if (fileBytes && shouldRepromoteCapabilities(serverCaps)) {
            const capsWaitMs = serverCapabilityWaitMs(fileBytes.byteLength);
            updateLoadProgress({
              title: 'Checking server converter',
              detail: 'Probing sidecar availability for default server-convert path...',
              progress: 26,
              sourceHint: 'Server convert',
            });
            const caps = await getServerCapabilities({ timeoutMs: capsWaitMs });
            if (!disposed) {
              serverCaps = caps;
              if (import.meta.env.DEV) {
                console.info('[ViewerPanel] server capability probe', {
                  server_convert: caps.server_convert,
                  reason: caps.reason,
                  version: caps.version,
                  waitMs: capsWaitMs,
                });
              }
              if (caps.server_convert || !isRecoverableServerConvertFailure(caps)) {
                useStore.getState().setServerConvertCaps(caps);
              } else {
                useStore.getState().setServerConvertCaps(null);
              }
            }
            if (disposed) return;
          }
          if (fileBytes && defaultParsePathLabel(serverCaps, true) === 'server-convert') {
            useStore.getState().logActivity({
              kind: 'info',
              summary: 'Load path primary attempt: server-convert.',
            });
          }
          if (shouldAttemptServerConvert(serverCaps, !!fileBytes)) {
            let serverBytes: Uint8Array | null = null;
            let serverSource: 'cache' | 'sidecar' = 'sidecar';
            // Pure conversion time as reported by the server (0 on cache
            // hits or when the header is unavailable). Logged next to the
            // round-trip total so "slow load" reports separate conversion
            // cost from upload/transfer/wait overhead.
            let serverConvertMs = 0;
            try {
              updateLoadProgress({
                title: 'Server fragment conversion',
                detail: 'Sending IFC to backend sidecar for fast pre-build...',
                progress: 30,
                sourceHint: 'Server convert',
              });
              const sidecarStart = performance.now();
              // 500 ms polling keeps the bar moving smoothly through the
              // longest phase (the backend captures sidecar progress far more
              // often than that). The detail carries the raw process token
              // ("geometries"/"attributes"/...) so the overlay presenter can
              // translate it into plain language.
              const result = await convertIfcOnServer(fileBytes!, effectiveGraphicsProfile, modelId, {
                bypassCache: !useServerCache,
                progressPollIntervalMs: 500,
                onProgress: (snapshot) => {
                  if (disposed || !snapshot.in_flight) return;
                  const sidecarPct = Math.max(0, Math.min(100, snapshot.progress ?? 0));
                  updateLoadProgress({
                    title: 'Server fragment conversion',
                    detail: snapshot.stage ?? '',
                    progress: 30 + Math.round(sidecarPct * 0.4),
                    sourceHint: 'Server convert',
                  });
                },
              });
              stageTimings.sidecarMs = performance.now() - sidecarStart;
              serverBytes = result.bytes;
              serverSource = result.source;
              serverConvertMs = Number.isFinite(result.elapsedMs) ? result.elapsedMs : 0;
              if (import.meta.env.DEV) console.info('[ViewerPanel] server-convert response', {
                source: result.source,
                profile: result.profile,
                bytes: result.bytes.byteLength,
                elapsedMs: result.elapsedMs,
                sourceSha256: result.sourceSha256?.slice(0, 12),
              });
            } catch (sidecarErr) {
              const msg = sidecarErr instanceof Error ? sidecarErr.message : String(sidecarErr);
              console.warn('[ViewerPanel] server-convert call failed', msg);
              useStore.getState().logActivity({
                kind: 'info',
                summary: `Server convert failed (${msg}). Trying local-fragment-cache before browser parse.`,
              });
            }

            // Tiny fragment bytes usually mean an empty-model stub; use browser parse instead.
            if (isSuspiciousServerFragmentBytes(serverBytes)) {
              console.warn('[ViewerPanel] server-convert returned suspiciously small fragment', {
                bytes: serverBytes.byteLength,
                source: serverSource,
              });
              useStore.getState().logActivity({
                kind: 'info',
                summary: `Server convert produced empty fragment (${serverBytes.byteLength} B). Trying local-fragment-cache before browser parse.`,
              });
              serverBytes = null;
            }

            // Load valid server bytes, retrying with a fresh model id if needed.
            if (serverBytes && !disposed) {
              const bytes: Uint8Array = serverBytes;
              const sidecarMs = stageTimings.sidecarMs ?? 0;
              updateLoadProgress({
                title: 'Loading server-built fragments',
                detail: `Received ${(bytes.byteLength / 1024).toFixed(0)} KB from ${serverSource} in ${sidecarMs.toFixed(0)} ms.`,
                progress: 70,
                sourceHint: serverSource === 'cache' ? 'Server cache' : 'Server convert',
              });
              // Big fragments need more headroom than the 60 s base.
              const fragLoadTimeoutMs = computeFragmentLoadTimeoutMs(bytes.byteLength);
              for (let attempt = 1; attempt <= SERVER_FRAGMENT_LOAD_RETRIES; attempt++) {
                try {
                  const fragLoadStart = performance.now();
                  model = await loadFragmentsWithTimeout(
                    fragmentsManager,
                    bytes,
                    modelId,
                    {
                      autoCoordinate: coordinateModel,
                      timeoutMs: fragLoadTimeoutMs,
                      graphicsQuality: resolveIdleGraphicsQuality(),
                    },
                  );
                  stageTimings.cacheLoadMs = performance.now() - fragLoadStart;
                  modelLoadSource = modelLoadSourceForServerFragmentSource(serverSource);
                  if (cacheKey && cachePolicy !== 'off') {
                    void writeRawFragmentCacheIDB(cacheKey, bytes, cachePolicy);
                  }
                  useStore.getState().logActivity({
                    kind: 'info',
                    summary: `Load path chosen: ${modelLoadSource} in ${sidecarMs.toFixed(0)} ms`
                      + (serverConvertMs > 0 ? ` (conversion ${serverConvertMs.toFixed(0)} ms,` : ' (')
                      + ` attempt ${attempt}/${SERVER_FRAGMENT_LOAD_RETRIES}).`,
                  });
                  break;
                } catch (loadErr) {
                  clearFragmentThreadPlaceholder(fragmentsManager, modelId);
                  modelId = makeViewerModelId();
                  const msg = formatUnknownLoadError(loadErr);
                  console.warn('[ViewerPanel] server-fragment load failed', { attempt, msg, fragBytesMB: (bytes.byteLength / (1024 * 1024)).toFixed(1), fragLoadTimeoutMs });
                  if (attempt < SERVER_FRAGMENT_LOAD_RETRIES && !disposed) {
                    useStore.getState().logActivity({
                      kind: 'info',
                      summary: `Fragment load attempt ${attempt}/${SERVER_FRAGMENT_LOAD_RETRIES} failed (${msg}). Retrying with fresh modelId...`,
                    });
                    updateLoadProgress({
                      title: 'Retrying fragment load',
                      detail: `Attempt ${attempt + 1}/${SERVER_FRAGMENT_LOAD_RETRIES} after worker stall...`,
                      progress: 72,
                      sourceHint: 'Server convert',
                    });
                  } else {
                    useStore.getState().logActivity({
                      kind: 'info',
                      summary: `Fragment load exhausted ${SERVER_FRAGMENT_LOAD_RETRIES} retries (${msg}). Trying local-fragment-cache before browser parse.`,
                    });
                    model = null;
                  }
                }
              }
            }
          } else if (import.meta.env.DEV) {
            console.info('[ViewerPanel] server-convert skipped; using local/browser fallbacks', {
              serverCaps,
              hasFileBytes: !!fileBytes,
              profile: effectiveGraphicsProfile,
            });
          }
        }

        if (!model && cacheEnabled && cacheKey && !localFragmentCacheChecked) {
          // Probe hint deliberately differs from the confirmed-hit hint
          // ('local-fragment-cache' below) so the overlay presenter does not
          // claim a cache hit before the IDB read resolves.
          updateLoadProgress({
            title: 'Checking local fragment cache',
            detail: 'Backend fragment path unavailable. Checking local browser cache...',
            progress: 74,
            sourceHint: 'Local cache check',
          });
          const cacheReadStart = performance.now();
          const cachedFragments = await readFragmentCacheIDB(cacheKey, cachePolicy);
          stageTimings.cacheReadMs = performance.now() - cacheReadStart;
          if (cachedFragments) {
            try {
              updateLoadProgress({
                title: 'Loading local fragment cache',
                detail: 'Local cache hit after backend path was unavailable.',
                progress: 78,
                sourceHint: 'local-fragment-cache',
              });
              const cacheLoadStart = performance.now();
              model = await loadFragmentsWithTimeout(
                fragmentsManager,
                cachedFragments,
                modelId,
                { autoCoordinate: coordinateModel, graphicsQuality: resolveIdleGraphicsQuality() },
              );
              stageTimings.cacheLoadMs = performance.now() - cacheLoadStart;
              modelLoadSource = 'fragments-cache';
              useStore.getState().logActivity({
                kind: 'info',
                summary: 'Load path chosen: local-fragment-cache after backend fragments were unavailable.',
              });
            } catch {
              model = null;
              clearFragmentThreadPlaceholder(fragmentsManager, modelId);
              modelId = makeViewerModelId();
              updateLoadProgress({
                title: 'Local cache fallback',
                detail: 'Local fragments were stale. Switching to browser parse fallback...',
                progress: 80,
                sourceHint: 'worker-parse',
              });
            }
          }
        }

        // Worker-side IFC parse path: IfcImporter.process() runs in a
        // dedicated Web Worker so the main thread stays responsive at 60 fps
        // during the WASM geometry conversion step. Falls through to the
        // blocking IfcLoader.load() path on any worker error.
        if (!model && fileBytes) {
          const workerClient = new IfcConvertWorker();
          try {
            updateLoadProgress({
              title: 'Converting IFC (worker)',
              detail: 'Parsing geometry in background thread - UI stays responsive...',
              progress: 28,
              sourceHint: 'Worker parse',
            });
            const workerParseStart = performance.now();
            const workerTimeoutMs = computeLiveParseTimeoutMs(fileBytes.byteLength);
            const workerBytes = new ArrayBuffer(fileBytes.byteLength);
            new Uint8Array(workerBytes).set(fileBytes);
            const fragmentBytes = await raceWithTimeout(
              workerClient.convert(
                workerBytes,
                effectiveGraphicsProfile,
                import.meta.env.BASE_URL || '/',
                (stage, pct) => {
                  if (disposed) return;
                  // IfcImporter reports fractions (0..1); normalize before
                  // mapping into the 28-92 band or the bar freezes at ~28 %.
                  const cappedPct = Math.min(normalizeImportProgress(pct), 92);
                  updateLoadProgress({
                    title: stage ?? 'Converting IFC',
                    detail: cappedPct >= 92
                      ? 'Finalising geometry, please wait...'
                      : `Worker parse ${cappedPct.toFixed(0)}%`,
                    progress: 28 + Math.round(cappedPct * 0.64),
                    sourceHint: 'Worker parse',
                  });
                },
              ),
              workerTimeoutMs,
              'Worker parse',
            );
            stageTimings.parseMs = performance.now() - workerParseStart;

            if (!disposed) {
              updateLoadProgress({
                title: 'Loading worker fragments',
                detail: `Worker parse done in ${stageTimings.parseMs.toFixed(0)} ms. Loading geometry...`,
                progress: 94,
                sourceHint: 'Worker parse',
              });
              model = await loadFragmentsWithTimeout(
                fragmentsManager,
                fragmentBytes,
                modelId,
                { autoCoordinate: coordinateModel, graphicsQuality: resolveIdleGraphicsQuality() },
              );
              modelLoadSource = 'worker-parse';
              if (cacheKey) {
                scheduleFragmentCacheIDBPersist(cacheKey, model, cachePolicy);
              }
              useStore.getState().logActivity({
                kind: 'info',
                summary: `Load path chosen: worker-parse in ${stageTimings.parseMs.toFixed(0)} ms (main thread was free).`,
              });
            }
          } catch (workerErr) {
            clearFragmentThreadPlaceholder(fragmentsManager, modelId);
            modelId = makeViewerModelId();
            const msg = workerErr instanceof Error ? workerErr.message : String(workerErr);
            console.warn('[ViewerPanel] worker parse failed, falling back to IfcLoader:', msg);
            useStore.getState().logActivity({
              kind: 'info',
              summary: `Worker parse failed (${msg}). Falling back to blocking IFC parse.`,
            });
            model = null;
          } finally {
            workerClient.dispose();
          }
        }

        if (!model) {
          useStore.getState().logActivity({
            kind: 'info',
            summary: cacheEnabled
              ? 'Load path chosen: live-parse after server/local/worker fallbacks.'
              : 'Load path chosen: live-parse (cache disabled).',
          });

          const ifcLoader = components.get(OBC.IfcLoader);
          // BASE_URL keeps the wasm reachable on sub-path hosting (GH Pages
          // project sites); it is '/' in dev and root deployments.
          ifcLoader.settings.wasm.path = import.meta.env.BASE_URL || '/';
          ifcLoader.settings.wasm.absolute = true;
          ifcLoader.settings.autoSetWasm = false;
          ifcLoader.settings.webIfc = {
            ...ifcLoader.settings.webIfc,
            ...getWebIfcSettingsForProfile(effectiveGraphicsProfile),
          };

          updateLoadProgress({
            title: 'Preparing IFC importer',
            detail: 'Initializing WASM importer for live parse...',
            progress: 24,
            sourceHint: 'Live parse',
          });
          // Apply the single-thread web-ifc patch LAZILY but AWAITED,
          // right before the only main-thread IfcAPI.Init() in the app
          // (OBC.IfcLoader.setup() calls Init() on the calling thread). The
          // static import was removed from main.tsx so the entry no longer
          // pulls the web-ifc chunk before the shell paints (LCP); the .frag /
          // server / worker load paths never reach here, so web-ifc only loads
          // on the main thread when this blocking live-parse fallback fires.
          // The patch monkey-patches IfcAPI.prototype.Init, so applying it
          // before setup() (not before construction at components.get above) is
          // sufficient. Never fire-and-forget - Init() must see the patch.
          await import('../../services/ifc/webIfcPatch');
          const ifcSetupStart = performance.now();
          await ifcLoader.setup();
          stageTimings.ifcSetupMs = performance.now() - ifcSetupStart;

          const parseProgressTracker = {
            ts: 0,
            progress: -1,
            stage: '',
          };

          updateLoadProgress({
            title: 'Streaming geometry batches',
            detail: 'Live IFC parse in progress...',
            progress: 28,
            sourceHint: 'Live parse',
          });

          // Keep importer output compressed so the fragment worker can inflate it.
          const parseStart = performance.now();
          // Slow-load warning is handled by the pipeline-wide timer at the
          // top of init(), which covers this branch too.
          // Hard timeout so a broken FragmentsManager worker can't hang the
          // viewer indefinitely at "Finalizing fragment model 92 %".
          const liveParseTimeoutMs = computeLiveParseTimeoutMs(fileBytes!.byteLength);
          try {
            // coordinateModel is declared above (before the worker path) so both paths share it.
            model = await raceWithTimeout(
              ifcLoader.load(fileBytes!, coordinateModel, modelId, {
                processData: {
                  progressCallback: (progress, data) => {
                    if (disposed) return;

                    const normalizedProgress = normalizeImportProgress(progress);
                    const stageLabel = IMPORT_STAGE_LABELS[data.process] ?? 'Parsing IFC';
                    const now = performance.now();
                    const sameStage = parseProgressTracker.stage === stageLabel;
                    const tinyProgressStep = Math.abs(normalizedProgress - parseProgressTracker.progress) < 1;
                    const tooSoon = now - parseProgressTracker.ts < 70;
                    if (sameStage && tinyProgressStep && tooSoon) return;

                    parseProgressTracker.stage = stageLabel;
                    parseProgressTracker.progress = normalizedProgress;
                    parseProgressTracker.ts = now;

                    // Map importer progress into the viewer's 28-92 parse band.
                    const bandedProgress = 28 + Math.round(Math.min(normalizedProgress, 100) * 0.64);
                    const detail = normalizedProgress >= 92
                      ? 'Processing geometry, please wait...'
                      : formatImportProgressDetail(data);

                    updateLoadProgress({
                      title: stageLabel,
                      detail,
                      progress: bandedProgress,
                      sourceHint: 'Live parse',
                    });
                  },
                },
                instanceCallback: (importer) => {
                  configureImporter(importer, effectiveGraphicsProfile);
                },
              }),
              liveParseTimeoutMs,
              'Live IFC parse',
            );
          } catch (liveErr) {
            clearFragmentThreadPlaceholder(fragmentsManager, modelId);
            const msg = liveErr instanceof Error ? liveErr.message : String(liveErr);
            useStore.getState().logActivity({
              kind: 'error',
              summary: `Live IFC parse failed (${msg}).`,
              detail:
                'The viewer could not load the model after exhausting the server-convert, ' +
                'worker-parse, and live-parse paths. The fragment worker may be stuck - ' +
                'hard-refresh the page (Ctrl+Shift+R) to recover.',
            });
            throw liveErr;
          }
          stageTimings.parseMs = performance.now() - parseStart;

          if (disposed) return;

          updateLoadProgress({
            title: 'Finalizing fragment model',
            detail: 'Parse complete. Preparing render-ready scene...',
            progress: 94,
            sourceHint: 'Live parse',
          });
          if (cacheKey) {
            scheduleFragmentCacheIDBPersist(cacheKey, model, cachePolicy);
          }
        }

        if (!model) throw new Error('Model could not be loaded');

        // Cached-load backend warm-up: when the viewer loads from cached
        // fragments (manifest fast-path, IDB cache, or server cache hit
        // for a fingerprint that wasn't just uploaded), the backend's
        // IfcOpenShell handle may not be loaded - e.g. after a backend
        // restart, or when the page is reloaded without a fresh drop.
        // Without this, property queries return 400 and the AI ready chip
        // stays "idle". Fire-and-forget; never blocks the load path.
        if (!BROWSER_ONLY && isCacheHitModelLoadSource(modelLoadSource)) {
          const cachedFingerprint = useStore.getState().modelFingerprint;
          if (isBackendShaFingerprint(cachedFingerprint)) {
            void (async () => {
              if (disposed) return;
              try {
                const readiness = await import('../../services/api').then((m) => m.getReadiness());
                if (disposed) return;
                if (readiness.ifcopenshell !== 'ready' && readiness.ifcopenshell !== 'warming') {
                  useStore.getState().logActivity({
                    kind: 'info',
                    summary: 'Cached-load: warming backend IfcOpenShell handle from disk...',
                  });
                  await import('../../services/api').then((m) => m.warmFromCache(cachedFingerprint));
                  if (disposed) return;
                  useStore.getState().logActivity({
                    kind: 'info',
                    summary: 'Backend IfcOpenShell handle warm - property + AI queries ready.',
                  });
                }
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                useStore.getState().logActivity({
                  kind: 'info',
                  summary: `Backend warm-from-cache skipped (${msg}). Drop the file again to re-upload.`,
                });
              }
            })();
          }
        }

        // Add model to scene and connect camera for tile-based LOD rendering
        updateLoadProgress({
          title: attachGeometryTitle(modelLoadSource),
          detail: 'Mounting fragments into the viewport scene...',
          progress: 94,
          sourceHint: modelLoadSourceHint(modelLoadSource),
        });
        world.scene.three.add(model.object);
        model.useCamera(world.camera.three as THREE.PerspectiveCamera);

        // Opportunistically promote the IDB fragment cache to
        // persistent storage on first cache-eligible model load. Idempotent
        // (once-only guard inside requestPersistentStorageOnce); silent on
        // browsers that don't expose the API. Fire-and-forget; never blocks
        // the load path.
        if (cachePolicy !== 'off') {
          void requestPersistentStorageOnce().then((state) => {
            if (disposed) return;
            useStore.getState().setFragmentCachePersisted(state);
          });
        }

        // Optional diagnostic BVH on non-instanced scene meshes after the model is
        // mounted.  This accelerates every THREE.Raycaster.intersectObjects
        // call (gizmo picks, clip-plane drag origin, future scene objects).
        // InstancedMesh is skipped - @thatopen manages those internally.
        // Runs async-deferred so it doesn't stall the first paint.
        if (import.meta.env.VITE_VIEWER_COMPUTE_SCENE_BVH === 'true') {
          setTimeout(() => {
            const bvhCount = computeSceneBVH(world.scene.three);
            const cov = getBVHCoverage(world.scene.three);
            console.info(
              `[BVH] Computed BVH for ${bvhCount} meshes. ` +
              `Coverage: ${cov.bvhMeshes}/${cov.totalMeshes} (${cov.coveragePct.toFixed(0)}%)`,
            );
          }, 500);
        }

        // Kick off the first tile update WITHOUT awaiting its completion.
        // Previously we `await fragmentsManager.core.update(true)` here -
        // which blocks until ALL fragment tiles resolve synchronously. On
        // a ~100 MB hospital IFC that's 5-10 s of "stuck at 85%" where the
        // user can't tell if the app is working. Fire-and-forget lets the
        // first tiles paint within a frame or two and the rest stream in
        // naturally via the normal camera-change tile update cycle.
        try { void fragmentsManager.core.update(false); } catch { /* best-effort */ }
        updateLoadProgress({
          title: 'Rendering first frame',
          detail: 'Geometry is visible. Aligning camera and grid...',
          progress: 96,
          sourceHint: modelLoadSourceHint(modelLoadSource),
        });
        const ttfg = performance.now() - initStart;
        useStore.getState().updatePerfMetrics({ ttfgMs: ttfg });

        // In concurrent_fast we keep bytes around so remounts cannot fall back
        // to a stale backend IFC before deferred persistence completes.
        if (startupMode === 'full_upfront') {
          useStore.getState().setIfcFileBytes(null);
          modelService.releaseRawBytes();
        }

        // Fit camera to the loaded model bounding box and align the grid
        // to the model's actual ground plane (box.min.y) instead of world y=0.
        // IFC models are usually exported with their ground at z=0 in IFC
        // space, which maps to y=0 in the viewer's Y-up Three.js scene -
        // but some authoring tools export with arbitrary offsets, and even
        // sub-meter offsets make the default y=0 grid look "floating".
        const modelCenter = new THREE.Vector3();
        const modelSize = new THREE.Vector3();
        let groundY = 0;
        try {
          const allIds = await model.getLocalIds();
          const box = await model.getMergedBox(allIds);
          if (box) {
            box.getCenter(modelCenter);
            box.getSize(modelSize);
            groundY = box.min.y;
            const camera = world.camera.three as THREE.PerspectiveCamera | THREE.OrthographicCamera;
            const dist = computeFitDistance(camera, modelSize, 1.22);
            const isoDir = new THREE.Vector3(1, 0.76, 1).normalize();
            const eye = modelCenter.clone().addScaledVector(isoDir, dist);

            world.camera.controls.setLookAt(
              eye.x, eye.y, eye.z,
              modelCenter.x, modelCenter.y, modelCenter.z,
              true,
            );
            // Guarantee tiles render after the camera animation finishes.
            // The 'update' event listener may not fire during animated setLookAt
            // in all @thatopen/components versions, so we schedule an explicit
            // forced update ~400 ms after the camera starts moving (animation
            // is typically 300 ms) so tiles resolve regardless.
            setTimeout(() => {
              if (!disposed) {
                fragmentUpdateScheduler?.request({
                  priority: 'visual',
                  force: true,
                  reason: 'camera',
                });
              }
            }, 450);
          }
        } catch {
          world.camera.controls.setLookAt(30, 30, 30, 0, 0, 0);
          modelCenter.set(0, 0, 0);
          modelSize.set(10, 10, 10);
        }

        // Align the grid mesh to the model's ground plane so it visually
        // sits at the same level as the model's floor slab / storey 0.
        try {
          const gridObj = (grid as unknown as { three?: THREE.Object3D }).three;
          if (gridObj) {
            gridObj.position.y = groundY;
            gridObj.updateMatrixWorld(true);
          }
        } catch {
          /* grid position adjustment is purely cosmetic */
        }

        // Stable per-mesh depth buckets reduce flicker from coplanar IFC surfaces.
        let zFightPollInterval = 0;
        let zFightStableTicks = 0;
        let zFightDeferredDuringNav = false;
        // Once the poll has seen the scene fully biased (stable), the
        // per-flush traverse is throttled hard: onViewUpdated fires after
        // EVERY forced flush (each hover/click highlight), and on a
        // thousands-of-meshes model even the WeakMap-skip walk is real
        // per-flush cost. A late LOD tile swap during the throttle window
        // self-heals on the next allowed pass (<= 2 s).
        let zFightStableSince = 0;
        let zFightLastRunTs = 0;
        const Z_FIGHT_STABLE_MIN_INTERVAL_MS = 2000;
        const applyZFightBias = () => {
          // Never traverse the scene mid-navigation. onViewUpdated fires
          // after every camera-driven tile swap, so during an orbit this ran
          // per flush; one deferred pass now runs from the settle handler.
          // (The traverse itself is also idempotent-cheap since the
          // zFightingMitigation tracking pass - repeat calls are WeakMap
          // lookups, no userData writes, no material.needsUpdate.)
          if (cameraNavigatingRef.current) {
            zFightDeferredDuringNav = true;
            return;
          }
          const now = performance.now();
          if (zFightStableSince > 0 && now - zFightLastRunTs < Z_FIGHT_STABLE_MIN_INTERVAL_MS) {
            return;
          }
          zFightLastRunTs = now;
          try {
            const stats = applyFragmentZFightingMitigation(model.object);
            if (import.meta.env.DEV && stats.meshCount > 0) {
              console.debug('[viewer] z-fighting mitigation', stats);
            }
          } catch {
            /* z-fighting mitigation is best-effort */
          }
        };
        // @thatopen/fragments streams meshes in incrementally and swaps mesh
        // materials during LOD updates; onViewUpdated doesn't fire for every
        // streaming addition, and the OBC renderer only ticks onBeforeUpdate
        // on render-triggering events. Poll the scene at low frequency and
        // re-apply whenever a mesh has lost polygonOffset or the per-element
        // depth shader patch. Stop polling once the scene has been fully
        // biased for several ticks; onViewUpdated then covers later LOD swaps.
        const stopZFightPoll = () => {
          if (zFightPollInterval) {
            window.clearInterval(zFightPollInterval);
            zFightPollInterval = 0;
          }
        };
        const hasUnmitigatedOpaqueMesh = (): boolean => hasPendingFragmentZFightingMitigation(model.object);
        const onZFightPoll = () => {
          if (disposed) { stopZFightPoll(); return; }
          if (hasUnmitigatedOpaqueMesh()) {
            zFightStableSince = 0; // new unbiased meshes - lift the throttle
            applyZFightBias();
            zFightStableTicks = 0;
          } else {
            // Stop polling after a few stable ticks; view updates cover later swaps.
            zFightStableTicks += 1;
            if (zFightStableTicks >= 3) {
              zFightStableSince = performance.now();
              stopZFightPoll();
            }
          }
        };
        try {
          // New model: reset processed-mesh tracking.
          resetFragmentZFightingTracking();
          applyZFightBias();
          model.onViewUpdated.add(applyZFightBias);
          zFightPollInterval = window.setInterval(onZFightPoll, 1000);
          zFightingCleanup = () => {
            stopZFightPoll();
            try { model.onViewUpdated.remove(applyZFightBias); } catch { /* model may be disposed */ }
          };
        } catch { /* z-fighting mitigation is best-effort */ }

        // Store viewer references
        viewerRef.current = {
          components,
          world: world as any,
          model,
          modelCenter,
          modelSize,
          grid: grid as unknown as { three: THREE.Object3D },
        };

        // Optional LOD swap renders a lighter model while the camera is moving.
        {
          const lodSwap = new LodSwapController();
          lodSwap.setTargets(model.object, null);
          const lodControls = world.camera.controls;
          const onLodNav = () => lodSwap.onNavigate();
          const onLodRest = () => lodSwap.onRest();
          lodControls.addEventListener('wake', onLodNav);
          lodControls.addEventListener('controlstart', onLodNav);
          // Continuous navigation signal for the LOD controller.
          lodControls.addEventListener('update', onLodNav);
          lodControls.addEventListener('rest', onLodRest);
          lodControls.addEventListener('sleep', onLodRest);
          // Only swap when per-element visibility modes are inactive.
          const unsubLod = useStore.subscribe(
            (s) =>
              s.largeModelLod
              && s.isolatedIds.length === 0
              && s.hiddenIds.length === 0
              && !s.ghostModeOn,
            (canSwap: boolean) => lodSwap.setEnabled(canSwap),
            { fireImmediately: true },
          );
          const lodAbort = new AbortController();
          let lodAttached: AttachedLod | null = null;
          void loadAndAttachLod({
            fragmentsManager,
            worldScene: world.scene.three as unknown as THREE.Object3D,
            fullModelId: modelId,
            autoCoordinate: coordinateModel,
            fingerprint: useStore.getState().modelFingerprint,
            profile: graphicsProfile,
            signal: lodAbort.signal,
            // Pin the decimated model to ALL_VISIBLE too - it is the model
            // shown during motion, where DEFAULT LodMode would coverage-cull
            // its own elements every frame and reintroduce the flicker.
            allVisibleLodMode: FRAGS.LodMode.ALL_VISIBLE,
          }).then((attached) => {
            if (disposed || !attached) { attached?.dispose(); return; }
            lodAttached = attached;
            lodSwap.setTargets(model.object, attached.lodObject);
            if (import.meta.env.DEV) {
              (window as any).__ifcLodAttached = true;
            }
          });
          lodCleanupRef.current = () => {
            try { lodAbort.abort(); } catch { /* */ }
            try { unsubLod(); } catch { /* */ }
            try {
              lodControls.removeEventListener('wake', onLodNav);
              lodControls.removeEventListener('controlstart', onLodNav);
              lodControls.removeEventListener('update', onLodNav);
              lodControls.removeEventListener('rest', onLodRest);
              lodControls.removeEventListener('sleep', onLodRest);
            } catch { /* */ }
            try { lodSwap.dispose(); } catch { /* */ }
            try { lodAttached?.dispose(); } catch { /* */ }
          };
        }

        // LodMode.ALL_VISIBLE for every model, regardless of size. In DEFAULT
        // LodMode the worker's screen-coverage classifier re-evaluates every
        // element on each view refresh and hard-hides anything below the
        // sub-pixel / frustum-edge threshold. That verdict recomputes every
        // frame while the camera moves, so elements visibly flicker and vanish
        // during orbit/zoom and a hidden element cannot be picked - the exact
        // regression reported against the original viewer, which never culled
        // at view time. ALL_VISIBLE is the classifier's first branch: no
        // frustum cull, no screen-size cull - only explicit visibility (Hider /
        // isolate / ghost) is honored, so nothing disappears under the user
        // during navigation. Tiles stay GPU-resident either way (freed only
        // under memoryOverflow) and the lodTierPolicy.ts bench found the cull
        // band buys no measurable frame time up to ~5k elements; genuinely
        // large models get their motion-time budget from the decimated LOD
        // swap (loadAndAttachLod, itself pinned to ALL_VISIBLE), not from
        // hiding elements. The per-model graphicsQuality writes below stay
        // (inert under ALL_VISIBLE, but keep the tier plumbing correct).
        void (async () => {
          try {
            const ids = await model.getLocalIds();
            if (disposed || ids.length === 0) return;
            const tier = resolveLodTier(ids.length);
            modelLodTiers.set(modelId, tier);
            if (typeof model.setLodMode === 'function') {
              await model.setLodMode(FRAGS.LodMode.ALL_VISIBLE);
            }
            // Re-apply the current ladder level now that the tier is known:
            // covers a ladder change racing the load and applies the
            // large-tier resting cap to the freshly copied load seed.
            applyPerModelGraphicsQuality(
              getRuntimeQualitySettings(interactionQualityRef.current.active).graphicsQuality,
            );
          } catch { /* LOD mode is an optimization, never fatal */ }
        })();

        // Tell the ClipEdgesService which model to section so filled caps
        // show up on subsequent section cuts (or any cuts already active).
        clipEdgesServiceRef.current?.setModel(modelId);

        // Publish half-extents to the store for UI widgets that need a
        // model-relative range (e.g. the clip plane offset slider).
        useStore.getState().setModelHalfExtents({
          x: Math.max(1, modelSize.x * 0.5),
          y: Math.max(1, modelSize.y * 0.5),
          z: Math.max(1, modelSize.z * 0.5),
        });

        // Register with the client-side ModelService so panels and LLM
        // tools can read project info / psets / quantities without a
        // backend round-trip. register() populates refs + the
        // expressID<->localID map; consumer panels move from backend to
        // ModelService behind feature flags.
        try {
          await modelService.register({ model, fileBytes: fileBytes!, components });
        } catch (err) {
          console.warn('[ViewerPanel] ModelService register failed', err);
        }

        // Cleanup - real model is loaded; remove preview meshes so
        // we don't double-render.
        if (nativePreview) {
          const scene = world.scene?.three as THREE.Scene | undefined;
          if (scene) removeNativePreview(scene, nativePreview);
          nativePreview = null;
        }

        // Development-only window hook so the preview/E2E harness can drive the
        // viewer without reaching through React. Only set in development - the
        // import.meta.env.DEV gate keeps it out of production bundles.
        if (import.meta.env.DEV) {
          (window as any).__ifcViewer = viewerRef.current;
          (window as any).__ifcStore = useStore;
          (window as any).__ifcModelService = modelService;
          // Development-only performance harness. __ifcRenderStats() reports
          // the live main-pass snapshot when a frame was captured recently
          // (renderStatsSnapshot.ts - no extra render pass), and only falls
          // back to a dedicated probe render when the snapshot is stale
          // (no frame drawn yet, or MANUAL mode idle beyond the dev
          // keep-alive cadence); __ifcOrbitBench(seconds, degrees) drives a
          // constant-speed orbit and reports frame-time percentiles - run it
          // in a VISIBLE tab (hidden tabs freeze rAF and the numbers are
          // meaningless).
          (window as any).__ifcRenderStats = () => {
            const renderer = world.renderer!.three;
            const info = renderer.info;
            const heap = (performance as unknown as {
              memory?: { usedJSHeapSize?: number };
            }).memory?.usedJSHeapSize;
            const jsHeapMB = typeof heap === 'number' ? Math.round(heap / 1048576) : null;
            // Fresh window: 2 s covers the 1 s RENDER_ON_DEMAND dev
            // keep-alive with margin; the AUTO loop refreshes every vsync.
            if (isMainPassFresh(performance.now(), 2000)) {
              const snap = getMainPassStats();
              return {
                drawCalls: snap.drawCalls,
                triangles: snap.triangles,
                geometries: info.memory.geometries,
                textures: info.memory.textures,
                programs: info.programs?.length ?? null,
                jsHeapMB,
              };
            }
            // Stale snapshot: measure with a dedicated render pass - one
            // extra full-scene draw per probe call in development. The extra
            // counts land after the frame capture, so the snapshot stays
            // clean (next frame's reset wipes them).
            const before = { calls: info.render.calls, triangles: info.render.triangles };
            try {
              renderer.render(world.scene!.three, world.camera.three);
            } catch { /* fall back to loop counters */ }
            const delta = {
              calls: info.render.calls - before.calls,
              triangles: info.render.triangles - before.triangles,
            };
            return {
              drawCalls: delta.calls > 0 ? delta.calls : info.render.calls,
              triangles: delta.triangles > 0 ? delta.triangles : info.render.triangles,
              geometries: info.memory.geometries,
              textures: info.memory.textures,
              programs: info.programs?.length ?? null,
              jsHeapMB,
            };
          };
          (window as any).__ifcOrbitBench = (seconds = 5, degrees = 360) =>
            new Promise((resolve) => {
              const benchControls = world.camera.controls as unknown as {
                rotate: (az: number, polar: number, transition?: boolean) => void;
              };
              const totalMs = Math.max(500, seconds * 1000);
              const azPerMs = (degrees * (Math.PI / 180)) / totalMs;
              const deltas: number[] = [];
              const t0 = performance.now();
              let last = t0;
              const step = () => {
                if (disposed) {
                  resolve(summarizeFrameDeltas(deltas));
                  return;
                }
                const now = performance.now();
                const dt = now - last;
                last = now;
                deltas.push(dt);
                try {
                  benchControls.rotate(azPerMs * dt, 0, false);
                } catch { /* keep sampling even if the controls API shifts */ }
                if (now - t0 < totalMs) {
                  requestAnimationFrame(step);
                } else {
                  // First delta spans the call-to-first-frame gap; drop it.
                  const stats = {
                    ...summarizeFrameDeltas(deltas.slice(1)),
                    ...(window as any).__ifcRenderStats(),
                  };
                  console.info('[viewer] orbit bench', stats);
                  resolve(stats);
                }
              };
              requestAnimationFrame(step);
            });
          // One-shot draw-call/memory snapshot on the next rendered frame
          // after the model is ready - the per-load baseline line.
          const postLoadSnapshot = () => {
            try { world.renderer!.onAfterUpdate.remove(postLoadSnapshot); } catch { /* once */ }
            if (disposed) return;
            console.info('[viewer] post-load render stats', {
              modelId,
              source: modelLoadSource,
              ...(window as any).__ifcRenderStats(),
            });
          };
          world.renderer!.onAfterUpdate.add(postLoadSnapshot);
        }

        // Apply current theme to the live scene (background + grid colors)
        applyTheme(useStore.getState().theme);

        // Keep post-fit tile refresh out of the blocking startup path.
        // We trigger it after ready as fire-and-forget.
        updateLoadProgress({
          title: 'Finalizing viewport',
          detail: 'Applying interaction handlers and quality controls...',
          progress: 98,
          sourceHint: modelLoadSourceHint(modelLoadSource),
        });

        // Subscribe to camera movement so tiles re-evaluate LOD/visibility.
        // Two optimizations vs the previous straight listener:
        //
        //   1. rAF-coalesce - `update` fires on every mousemove during
        //      orbit, which was asking the tile system to reshuffle faster
        //      than it could complete, producing half-loaded frames. We
        //      schedule at most one non-forced update per animation frame.
        //   2. Adaptive graphicsQuality - drop to 0.7 while orbiting, snap
        //      back to 1.0 ~300 ms after the last movement. Idle users see
        //      full detail; orbiting users get +30-60% FPS on large models.
        //   3. A single forced update(true) 300 ms post-settle replaces the
        //      old [150, 400, 1000, 2500] ms setTimeout ladder, which caused
        //      visible pop-in/out as each forced update re-evaluated the
        //      LOD budget from scratch.
        try {
          const controls = world.camera.controls as unknown as {
            addEventListener: (ev: string, fn: () => void) => void;
          };
          let rafPending = false;
          let settleTimer: number | null = null;
          let orbiting = false;
          // Re-entrancy guard for the eager show-pass scheduled
          // from the rAF callback below. Without it a fast orbit can stack
          // overlapping showPass invocations and race their setVisible writes.
          let showPassPending = false;
          let lastShowPassTs = 0;
          let panelResizing = false;
          let windowResizeEndTimer: number | null = null;
          // Rest-keyed settle state guards active pointer gestures and damping tails.
          let controlActive = false;
          let suppressNavStartUntil = 0;

          const isPanelResizing = () => panelResizing || document.body.classList.contains('is-resizing');

          const onPanelResizeStart = () => {
            panelResizing = true;
            cameraNavigatingRef.current = true;
            fragmentUpdateScheduler?.setNavigating(true);
            applyGhostPostproduction(true);
            cancelDprDrop();
            setInteractionPixelRatioCap(navigationPixelRatioCap);
            hoverGenRef.current += 1;
            if (hoverIntentTimer !== null) {
              window.clearTimeout(hoverIntentTimer);
              hoverIntentTimer = null;
            }
            if (settleTimer !== null) {
              window.clearTimeout(settleTimer);
              settleTimer = null;
            }
            orbiting = false;
            try {
              fragmentsManager.core.settings.graphicsQuality = resolveIdleGraphicsQuality();
            } catch {
              /* ignore */
            }
          };

          const onPanelResizeEnd = () => {
            panelResizing = false;
            cameraNavigatingRef.current = false;
            fragmentUpdateScheduler?.setNavigating(false);
            applyGhostPostproduction(false);
            restoreLadderPixelRatioCap();
            if (disposed) return;
            requestAnimationFrame(() => {
              if (disposed || isPanelResizing()) return;
              try {
                fragmentsManager.core.settings.graphicsQuality = resolveIdleGraphicsQuality();
                fragmentUpdateScheduler?.request({
                  priority: 'visual',
                  force: true,
                  reason: 'resize',
                });
              } catch {
                /* ignore */
              }
            });
          };

          const onWindowResize = () => {
            panelResizing = true;
            cameraNavigatingRef.current = true;
            fragmentUpdateScheduler?.setNavigating(true);
            applyGhostPostproduction(true);
            cancelDprDrop();
            setInteractionPixelRatioCap(navigationPixelRatioCap);
            hoverGenRef.current += 1;
            if (hoverIntentTimer !== null) {
              window.clearTimeout(hoverIntentTimer);
              hoverIntentTimer = null;
            }
            if (settleTimer !== null) {
              window.clearTimeout(settleTimer);
              settleTimer = null;
            }
            if (windowResizeEndTimer !== null) {
              window.clearTimeout(windowResizeEndTimer);
              windowResizeEndTimer = null;
            }
            orbiting = false;
            try {
              fragmentsManager.core.settings.graphicsQuality = resolveIdleGraphicsQuality();
            } catch {
              /* ignore */
            }

            // Treat a resize burst as one interaction and refresh once it settles.
            windowResizeEndTimer = window.setTimeout(() => {
              windowResizeEndTimer = null;
              panelResizing = false;
              cameraNavigatingRef.current = false;
              fragmentUpdateScheduler?.setNavigating(false);
              applyGhostPostproduction(false);
              restoreLadderPixelRatioCap();
              if (disposed) return;
              requestAnimationFrame(() => {
                if (disposed || isPanelResizing()) return;
                try {
                  fragmentsManager.core.settings.graphicsQuality = resolveIdleGraphicsQuality();
                  fragmentUpdateScheduler?.request({
                    priority: 'visual',
                    force: true,
                    reason: 'resize',
                  });
                } catch {
                  /* ignore */
                }
              });
            }, 180);
          };

          window.addEventListener(PANEL_RESIZE_START_EVENT, onPanelResizeStart as EventListener);
          window.addEventListener(PANEL_RESIZE_END_EVENT, onPanelResizeEnd as EventListener);
          window.addEventListener('resize', onWindowResize);
          removePanelResizeHooks = () => {
            window.removeEventListener(PANEL_RESIZE_START_EVENT, onPanelResizeStart as EventListener);
            window.removeEventListener(PANEL_RESIZE_END_EVENT, onPanelResizeEnd as EventListener);
            window.removeEventListener('resize', onWindowResize);
            if (windowResizeEndTimer !== null) {
              window.clearTimeout(windowResizeEndTimer);
              windowResizeEndTimer = null;
            }
          };

          const onCameraChange = () => {
            if (disposed) return;
            lastCameraUpdateTs = performance.now();

            // During panel drag-resize, avoid LOD thrashing and forced tile refreshes.
            if (isPanelResizing()) {
              cameraNavigatingRef.current = true;
              fragmentUpdateScheduler?.setNavigating(true);
              applyGhostPostproduction(true);
              cancelDprDrop();
              setInteractionPixelRatioCap(navigationPixelRatioCap);
              hoverGenRef.current += 1;
              if (hoverIntentTimer !== null) {
                window.clearTimeout(hoverIntentTimer);
                hoverIntentTimer = null;
              }
              if (settleTimer !== null) {
                window.clearTimeout(settleTimer);
                settleTimer = null;
              }
              orbiting = false;
              try {
                fragmentsManager.core.settings.graphicsQuality = resolveIdleGraphicsQuality();
              } catch {
                /* ignore */
              }
              return;
            }

            // Suppress post-rest damping tails without losing repaint updates.
            if (!orbiting && performance.now() < suppressNavStartUntil) {
              // Renew suppression while programmatic transition tails keep emitting.
              suppressNavStartUntil = performance.now() + 400;
              fragmentUpdateScheduler?.request({
                priority: 'camera',
                force: false,
                reason: 'camera',
              });
              return;
            }

            // Adaptive LOD: drop quality while the user is actively moving.
            if (!orbiting) {
              orbiting = true;
              cameraNavigatingRef.current = true;
              fragmentUpdateScheduler?.setNavigating(true);
              applyGhostPostproduction(true);
              hoverGenRef.current += 1;
              if (hoverIntentTimer !== null) {
                window.clearTimeout(hoverIntentTimer);
                hoverIntentTimer = null;
              }
              // Orbit start moves the interaction-quality ladder to interactive.
              dispatchQuality({ type: 'navigation-start' });
            }
            // rAF coalesce - one non-forced update per frame, max.
            fragmentUpdateScheduler?.request({
              priority: 'camera',
              force: false,
              reason: 'camera',
            });
            if (!rafPending) {
              rafPending = true;
              requestAnimationFrame(() => {
                rafPending = false;
                if (disposed) return;

                // During orbit, reveal app-culled elements that re-enter the frustum.
                const now = performance.now();
                if (!showPassPending && now - lastShowPassTs >= cullerShowPassMinIntervalMs) {
                  const state = useStore.getState();
                  if (state.isolatedIds.length === 0 && state.hiddenIds.length === 0) {
                    const storeyCuller = storeyFrustumCullerRef.current;
                    const elemCuller = elementFrustumCullerRef.current;
                    if (storeyCuller?.isBuilt || elemCuller?.isBuilt) {
                      showPassPending = true;
                      lastShowPassTs = now;
                      const cameraThree = world.camera.three as THREE.Camera;
                      const runShow = async () => {
                        let revealed = 0;
                        try {
                          if (storeyCuller?.isBuilt) {
                            revealed += await storeyCuller.showPass(cameraThree, model);
                          }
                          if (elemCuller?.isBuilt) {
                            const ownedByStorey = storeyCuller?.isBuilt
                              ? new Set(storeyCuller.getCulledMemberIds())
                              : undefined;
                            revealed += await elemCuller.showPass(cameraThree, model, ownedByStorey);
                          }
                        } catch { /* best-effort */ }
                        // Paint newly visible elements immediately.
                        if (revealed > 0 && !disposed) {
                          fragmentUpdateScheduler?.request({
                            priority: 'visual',
                            force: true,
                            reason: 'culler-show',
                          });
                        }
                        showPassPending = false;
                      };
                      void runShow();
                    }
                  }
                }
              });
            }
            // Re-arm the settle backstop for cases the rest event cannot cover.
            if (settleTimer !== null) window.clearTimeout(settleTimer);
            settleTimer = window.setTimeout(() => {
              settleTimer = null;
              runSettle();
            }, cameraSettleDelayMs);
          };

          // Refresh near/far planes at rest to preserve depth precision.
          const planeCorner = new THREE.Vector3();
          const planeTarget = new THREE.Vector3();
          const updateCameraPlanes = () => {
            try {
              const cam = world.camera.three as THREE.PerspectiveCamera;
              if (!cam.isPerspectiveCamera) return;
              const planeControls = world.camera.controls as unknown as {
                getTarget: (out: THREE.Vector3) => THREE.Vector3;
              };
              planeControls.getTarget(planeTarget);
              const dist = Math.max(0.05, cam.position.distanceTo(planeTarget));
              const half = modelSize.clone().multiplyScalar(0.5);
              let farthest = 0;
              for (let i = 0; i < 8; i += 1) {
                planeCorner.set(
                  modelCenter.x + (i & 1 ? half.x : -half.x),
                  modelCenter.y + (i & 2 ? half.y : -half.y),
                  modelCenter.z + (i & 4 ? half.z : -half.z),
                );
                farthest = Math.max(farthest, cam.position.distanceTo(planeCorner));
              }
              const nextNear = Math.min(1, Math.max(0.01, dist * 0.001));
              const nextFar = Math.max(dist * 10, farthest * 1.25, nextNear + 10);
              const nearDelta = Math.abs(nextNear - cam.near) / cam.near;
              const farDelta = Math.abs(nextFar - cam.far) / cam.far;
              if (nearDelta > 0.2 || farDelta > 0.2) {
                cam.near = nextNear;
                cam.far = nextFar;
                cam.updateProjectionMatrix();
              }
            } catch { /* best-effort precision tuning */ }
          };

          // Settle: restore quality, flush any tiles starved/hidden during
          // the reduced-quality phase, then run the culler hide-pass at idle
          // priority so the stop gesture does not hitch.
          const runSettle = () => {
              if (disposed) return;
              orbiting = false;
              cameraNavigatingRef.current = false;
              fragmentUpdateScheduler?.setNavigating(false);
              applyGhostPostproduction(false);
              updateCameraPlanes();
              // Orbit settle drives the ladder back toward its
              // target (was the hardcoded GQ_IDLE snap + targetPixelRatio
              // restore). 'navigation-end' clears the navigating flag; the
              // follow-up 'set-target' snaps `active` straight to the resolved
              // target (the reducer restores to target when not navigating),
              // preserving the old immediate full-quality restore.
              dispatchQuality({ type: 'navigation-end' });
              dispatchQuality({
                type: 'set-target',
                target: performanceModeToQualityTarget(useStore.getState().viewerPerformanceMode),
              });
              // Run the z-fight pass that was deferred while navigating
              // (it tags itself when onViewUpdated fired mid-orbit).
              if (zFightDeferredDuringNav) {
                zFightDeferredDuringNav = false;
                applyZFightBias();
              }
              try {
                fragmentUpdateScheduler?.request({
                  priority: 'idle',
                  force: true,
                  reason: 'camera',
                });
              } catch { /* ignore */ }

              // Single-owner culler coordination. Without sequencing, the
              // storey + element culler tick calls would
              // run in parallel (`void tick(...)` twice in a row), racing
              // `model.setVisible(...)` writes for any element id both
              // cullers had a verdict on. `decideCullerWork` + `runCullerPlan`
              // (cullerCoordinationHelpers.ts) sequence the writes so the
              // storey tick fully settles before the element tick starts.
              const cullerRef = storeyFrustumCullerRef.current;
              const elemCullerRef = elementFrustumCullerRef.current;
              const cameraThree = world.camera.three as THREE.Camera;
              const cullerSnapshot: CullerSnapshot = {
                storeyCullerBuilt: !!cullerRef?.isBuilt,
                elementCullerBuilt: !!elemCullerRef?.isBuilt,
                isolatedCount: useStore.getState().isolatedIds.length,
                hiddenCount: useStore.getState().hiddenIds.length,
              };
              const cullerPlan = decideCullerWork(cullerSnapshot);
              // When no cullers are built (the default), runCullerPlan
              // resolves immediately and the chained 'culler-hide' force below
              // would be a second redundant forced flush per settle. Track it.
              const cullerPlanIsNoop = cullerPlan === 'noop';
              void runCullerPlan(cullerPlan, cullerSnapshot, {
                runStoreyTick: () => cullerRef!.tick(cameraThree, model),
                runElementTick: () => {
                  // Exclude storey-owned ids from element-level culling.
                  const ownedByStorey = cullerRef?.isBuilt
                    ? new Set(cullerRef.getCulledMemberIds())
                    : undefined;
                  return elemCullerRef!.tick(cameraThree, model, ownedByStorey);
                },
                runStoreyClear: async () => {
                  if (cullerRef?.isBuilt) await cullerRef.clearCull(model);
                },
                runElementClear: async () => {
                  if (elemCullerRef?.isBuilt) await elemCullerRef.clearCull(model);
                },
                onStoreyCulled: (n) => {
                  useStore.getState().updatePerfMetrics({ culledStoreys: n });
                },
                onElementCulled: (n) => {
                  useStore.getState().updatePerfMetrics({ culledElements: n });
                },
                isDisposed: () => disposed,
              })
                // Fetch LOD tiles for newly visible culler results.
                .then(() => {
                  if (disposed || cullerPlanIsNoop) return;
                  fragmentUpdateScheduler?.request({
                    priority: 'idle',
                    force: true,
                    reason: 'culler-hide',
                  });
                })
                .catch(() => { /* tick/clearCull throws ignored, matches prior fire-and-forget */ });
          };

          // Settle on the camera-controls rest signal, guarded against active gestures.
          const onCameraRest = () => {
            if (disposed || !orbiting || controlActive || isPanelResizing()) return;
            if (settleTimer !== null) {
              window.clearTimeout(settleTimer);
              settleTimer = null;
            }
            suppressNavStartUntil = performance.now() + 1500;
            runSettle();
          };
          const clearNavSuppression = () => { suppressNavStartUntil = 0; };

          // Zero-motion click guard. camera-controls fires controlstart /
          // controlend for EVERY left-click, motion or not, while 'update'
          // only fires on real camera deltas. Without the guard a plain
          // selection click entered the full navigation path - quality drop,
          // navigating flag, camera-priority refresh, and the settle backstop
          // with its forced idle flush - pure churn for a camera that never
          // moved. That churn also serialized the NEXT click's highlight
          // flush behind the settle flush (scheduler runs one update at a
          // time) and blocked hover raycasts while the navigating flag was
          // up, a large share of the click-to-highlight budget misses. Real
          // gestures (any 'update' during the gesture) behave exactly as
          // before; controlend with `orbiting` still true (e.g. releasing
          // while a damping tail is active) also passes through, because the
          // settle backstop must re-arm in that case.
          let gestureHadMotion = false;
          controls.addEventListener('update', () => {
            gestureHadMotion = true;
            // Real camera delta this frame (drags, damping tails, wheel,
            // programmatic transitions all emit 'update') - keep painting.
            renderKick(250);
            onCameraChange();
          });
          controls.addEventListener('controlend', () => {
            if (!gestureHadMotion && !orbiting) return;
            onCameraChange();
          });
          controls.addEventListener('rest', onCameraRest);
          controls.addEventListener('controlstart', () => {
            controlActive = true;
            gestureHadMotion = false;
            clearNavSuppression();
          });
          controls.addEventListener('controlend', () => { controlActive = false; });
          controls.addEventListener('transitionstart', clearNavSuppression);
          try {
            world.renderer!.three.domElement.addEventListener(
              'wheel',
              clearNavSuppression,
              { passive: true },
            );
          } catch { /* best-effort */ }
          // Seed the dynamic planes for the initial framing; settles keep
          // them current from here on.
          updateCameraPlanes();
        } catch {
          /* controls event API varies by @thatopen version */
        }

        // Element selection - attached to the WebGL canvas, not the outer
        // container, so clicks that land on overlay chrome (toolbar, HUD,
        // floating badges) don't trigger a raycast. We track pointer
        // down/up so that drag-orbits don't clear the selection: a real
        // click is defined as <= 4 px movement between down and up.
        const canvas = world.renderer!.three.domElement;
        let downX = 0;
        let downY = 0;
        let downTs = 0;
        let rightDownX = 0;
        let rightDownY = 0;
        type ClickPickResult = {
          hitModelId: string | null;
          result: FragmentRaycastHit | null;
        };
        let clickPickGeneration = 0;
        let pendingClickPick: {
          generation: number;
          x: number;
          y: number;
          promise: Promise<ClickPickResult>;
        } | null = null;
        // A2 + K - prefetch gating and pre-resolution state. The prefetch is
        // deferred a beat so orbit-starts (which move within the first frames)
        // never pay the FastPicker GPU readback; the pointer position is
        // tracked so the pre-resolve can tell a held click from a drag.
        let prefetchTimer: number | null = null;
        let lastPointerClientX = 0;
        let lastPointerClientY = 0;
        const PREFETCH_DELAY_MS = 35;
        const CLICK_DRAG_THRESHOLD_PX = 4;

        const pickElementAt = async (pt: { x: number; y: number }): Promise<ClickPickResult> => {
          const pickerPoint = clientPointToNdc(pt, canvas);
          const fastPicker = fastPickerRef.current;
          const camera = world.camera.three as
            | THREE.PerspectiveCamera
            | THREE.OrthographicCamera;
          const mouse = new THREE.Vector2(pt.x, pt.y);
          // Run the FastPicker void-guard and the
          // worker raycast CONCURRENTLY: pick latency becomes
          // max(GPU readback, worker raycast) instead of their sum (the
          // serial order cost fast clicks ~10-25 ms). The picker keeps its
          // role as the void authority - a confident picker miss still wins
          // and the in-flight raycast result is discarded (a wasted worker
          // raycast on a void click is cheap and off the main thread).
          const raycastPromise = model.raycast({ camera, mouse, dom: canvas });
          let hitModelId: string | null = '__no_picker__';
          if (fastPicker) {
            hitModelId = await queryFastPicker(fastPicker, pickerPoint);
            if (!hitModelId) {
              void raycastPromise.catch(() => { /* discarded void-click raycast */ });
              return { hitModelId, result: null };
            }
          }
          const result = await raycastPromise;
          return { hitModelId, result };
        };

        const prefetchClickPick = (pt: { x: number; y: number }) => {
          const generation = ++clickPickGeneration;
          const promise = pickElementAt(pt).catch(() => {
            return { hitModelId: '__picker_error__', result: null };
          });
          pendingClickPick = { generation, x: pt.x, y: pt.y, promise };
          // Pre-resolve held clicks to warm id and property caches.
          void promise.then((res) => {
            if (disposed || generation !== clickPickGeneration) return;
            const hit = res.result;
            if (!hit) return;
            const moved = Math.hypot(lastPointerClientX - downX, lastPointerClientY - downY);
            if (moved > CLICK_DRAG_THRESHOLD_PX) return;
            const productId = modelService.resolveProductIdFromHitSync(hit.itemId, hit.localId);
            expressToLocalCacheRef.current.set(hit.itemId, hit.localId);
            expressToLocalCacheRef.current.set(productId, hit.localId);
            void modelService.getElement(productId).catch(() => {});
          });
        };

        const onPointerDown = (event: PointerEvent) => {
          if (event.button === 2) {
            rightDownX = event.clientX;
            rightDownY = event.clientY;
            return;
          }
          if (event.button !== 0) return; // left button only
          hoverGenRef.current += 1;
          if (hoverIntentTimer !== null) {
            window.clearTimeout(hoverIntentTimer);
            hoverIntentTimer = null;
          }
          downX = event.clientX;
          downY = event.clientY;
          downTs = performance.now();
          lastPointerClientX = event.clientX;
          lastPointerClientY = event.clientY;
          // Defer prefetch briefly so orbit gestures avoid the GPU pick path.
          if (prefetchTimer !== null) window.clearTimeout(prefetchTimer);
          prefetchTimer = window.setTimeout(() => {
            prefetchTimer = null;
            if (disposed) return;
            const moved = Math.hypot(lastPointerClientX - downX, lastPointerClientY - downY);
            if (moved > CLICK_DRAG_THRESHOLD_PX) return;
            prefetchClickPick({ x: downX, y: downY });
          }, PREFETCH_DELAY_MS);
        };

        const onPointerUp = async (event: PointerEvent) => {
          if (disposed) return;
          if (event.button !== 0) return;
          if (prefetchTimer !== null) {
            // Released before the deferred prefetch fired (very fast click) -
            // the pick runs inline below via the no-prefetch fallback.
            window.clearTimeout(prefetchTimer);
            prefetchTimer = null;
          }
          const dx = event.clientX - downX;
          const dy = event.clientY - downY;
          const dragDist = Math.hypot(dx, dy);
          const elapsed = performance.now() - downTs;
          // Treat as a drag if the pointer moved meaningfully, OR the user
          // held down for a while (orbit gesture).
          if (dragDist > 4 || elapsed > 500) {
            pendingClickPick = null;
            clickPickGeneration += 1;
            if (import.meta.env.DEV) {
              console.debug('[viewer] click ignored as drag', { dragDist, elapsed });
            }
            return;
          }

          // B5 mount point: an armed wall tool consumes non-drag left clicks
          // ahead of picking/selection (mirrors the measurement hijack below).
          if (wallDrawControllerRef.current?.isArmed()) {
            pendingClickPick = null; // drop the prefetched raycast - unused
            wallDrawControllerRef.current.handleClick(event.clientX, event.clientY);
            return;
          }

          // Start click-to-highlight timing after drag detection.
          pendingClickStartRef.current = null;
          const tClickStart = performance.now();

          try {
            const pendingPick = pendingClickPick;
            pendingClickPick = null;
            const canUsePrefetch =
              pendingPick !== null
              && pendingPick.generation === clickPickGeneration
              && Math.hypot(pendingPick.x - downX, pendingPick.y - downY) <= 1;
            const tBeforeIO = import.meta.env.DEV ? performance.now() : 0;
            const { hitModelId, result } = canUsePrefetch
              ? await pendingPick.promise
              : await pickElementAt({ x: event.clientX, y: event.clientY });
            if (import.meta.env.DEV) {
              console.debug('[viewer] raycast', {
                client: { x: event.clientX, y: event.clientY },
                prefetched: canUsePrefetch,
                ioMs: +(performance.now() - tBeforeIO).toFixed(1),
                pickerHit: !!hitModelId,
                hit: result ? { itemId: result.itemId, localId: result.localId } : null,
              });
            }
            if (fastPickerRef.current && !hitModelId && !result) {
              const state = useStore.getState();
              if (!event.shiftKey && state.selectedElementId !== null) {
                state.selectElement(null);
                rebuildSchedulerRef.current?.cancel();
                void rebuildNativeHighlightsRef.current?.();
              }
              return;
            }
            // Pick-plane mode: next click on a model surface creates a clip
            // plane at the hit point, aligned to the dominant face-normal axis.
            if (useStore.getState().pickPlaneMode) {
              if (result?.point) {
                const normal = result.normal ?? new THREE.Vector3(0, 1, 0);
                const absX = Math.abs(normal.x);
                const absY = Math.abs(normal.y);
                const absZ = Math.abs(normal.z);
                const axis: import('../../store/useStore').ClipAxis =
                  absY >= absX && absY >= absZ ? 'y'
                  : absX >= absZ ? 'x'
                  : 'z';
                const { modelCenter } = viewerRef.current!;
                const axisOffset = axis === 'x'
                  ? result.point.x - modelCenter.x
                  : axis === 'y'
                  ? result.point.y - modelCenter.y
                  : result.point.z - modelCenter.z;
                useStore.getState().addClipPlaneAt(axis, axisOffset);
              } else {
                // Click in void - cancel pick mode without placing a plane
                useStore.getState().setPickPlaneMode(false);
              }
              return;
            }

            // Measurement mode hijacks clicks ahead of selection so the user
            // can drop rulers on visible geometry without first clearing
            // the currently-selected element. Requires a real hit - clicks
            // into the void in measurement mode are no-ops (keeps the UX
            // predictable and mirrors most BIM viewers).
            const measurementController = measurementControllerRef.current;
            if (measurementController && measurementController.getMode() !== 'off') {
              if (result?.point) {
                measurementController.handleClick(
                  result.point.clone(),
                  result.normal ? result.normal.clone() : null,
                );
              }
              return;
            }

            if (result) {
              // Normalize raycast hits to the owning IfcProduct express id.
              const rawHitId = result.itemId;
              const productId = modelService.resolveProductIdFromHitSync(rawHitId, result.localId);
              const stateBeforeSelect = useStore.getState();
              if (isNoopSameElementClick({
                clickedExpressId: productId,
                selectedElementId: stateBeforeSelect.selectedElementId,
                selectedIds: stateBeforeSelect.selectedIds,
                shiftKey: event.shiftKey,
              })) {
                if (event.detail >= 2) {
                  stateBeforeSelect.zoomToElement(productId);
                }
                return;
              }

              // Cache raw-hit and product-id mappings under the same local id.
              expressToLocalCacheRef.current.set(rawHitId, result.localId);
              expressToLocalCacheRef.current.set(productId, result.localId);

              // Hover state is wiped - the rebuild will paint the click
              // highlight; we don't want the lingering soft-amber tint.
              hoveredLocalIdRef.current = null;
              hoveredExpressIdRef.current = null;

              if (event.shiftKey) {
                // Shift+click: toggle into multi-select set
                useStore.getState().toggleSelectId(productId);
              } else {
                useStore.getState().selectElement(productId);
                if (event.detail >= 2) {
                  useStore.getState().zoomToElement(productId);
                }
              }
              // Start highlight rebuild in the same task as the click.
              rebuildSchedulerRef.current?.cancel();
              void rebuildNativeHighlightsRef.current?.();

              // Warm the properties cache for the selected element.
              void modelService.getElement(productId).catch(() => {});

              // Defer activity logging until after the selection paint.
              const activitySummary = event.shiftKey
                ? `Shift-selected element #${productId}`
                : `Selected element #${productId}`;
              window.setTimeout(() => {
                useStore.getState().logActivity({
                  kind: 'select',
                  summary: activitySummary,
                });
              }, 0);

              // Stop the click-to-highlight timer after the highlight flush completes.
              pendingClickStartRef.current = tClickStart;
            } else if (!event.shiftKey) {
              // Click on empty scene clears selection (but Shift+click on void is a no-op)
              useStore.getState().selectElement(null);
              rebuildSchedulerRef.current?.cancel();
              void rebuildNativeHighlightsRef.current?.();
            }
          } catch (err) {
            console.warn('Raycast failed:', err);
          }
        };

        // Pointer-move preview feeds measurement and hover from one rAF-throttled raycast.
        let pendingMovePoint: { x: number; y: number } | null = null;
        let moveRafHandle = 0;
        let moveInFlight = false;
        let replayMoveAfterFlight = false;
        let lastTooltipLocalId: number | null = null;
        let lastTooltipScreenX = 0;
        let lastTooltipScreenY = 0;
        let lastTooltipUpdateTs = 0;

        // Soft-amber hover highlight uses shared material instances.

        const clearHoverTooltip = () => {
          lastTooltipLocalId = null;
          setHoverTooltipData(null);
        };

        const maybeUpdateHoverTooltip = (
          result: FragmentRaycastHit,
          pt: { x: number; y: number },
          force: boolean,
        ) => {
          const now = performance.now();
          const moved = Math.hypot(pt.x - lastTooltipScreenX, pt.y - lastTooltipScreenY);
          if (
            !force
            && lastTooltipLocalId === result.localId
            && moved < 10
            && now - lastTooltipUpdateTs < 80
          ) {
            return;
          }

          const tree = useStore.getState().spatialTree;
          // Resolve representation hits to product ids before tree lookup.
          const tooltipId = modelService.resolveProductIdFromHitSync(result.itemId, result.localId);
          const node = getSpatialNodeIndex(tree)?.get(tooltipId) ?? null;
          const containerRect = containerRef.current?.getBoundingClientRect();
          if (!node || !containerRect) return;

          const TOOLTIP_W = 204;
          const TOOLTIP_H = 48;
          const rx = pt.x - containerRect.left;
          const ry = pt.y - containerRect.top;
          const tx = Math.min(rx + 14, containerRect.width - TOOLTIP_W);
          const ty = Math.max(4, ry - 36 - TOOLTIP_H);
          lastTooltipLocalId = result.localId;
          lastTooltipScreenX = pt.x;
          lastTooltipScreenY = pt.y;
          lastTooltipUpdateTs = now;
          setHoverTooltipData({
            x: tx,
            y: ty,
            name: node.name || node.ifc_type,
            type: node.ifc_type,
            storey: node.storey ?? null,
          });
        };

        function scheduleMovePreview() {
          if (moveInFlight) {
            replayMoveAfterFlight = true;
            return;
          }
          if (moveRafHandle) return;
          moveRafHandle = requestAnimationFrame(runMovePreview);
        }

        const runMovePreview = async () => {
          moveRafHandle = 0;
          const pt = pendingMovePoint;
          pendingMovePoint = null;
          if (!pt) return;
          const ctrl = measurementControllerRef.current;
          const measuring = !!ctrl && ctrl.getMode() !== 'off';
          const hoverOn = useStore.getState().hoverHighlightEnabled;
          // Skip raycast entirely if nothing depends on it.
          if (!shouldRunHoverRaycast({
            measuring,
            hoverHighlightEnabled: hoverOn,
            cameraNavigating: cameraNavigatingRef.current,
            hoverQualityEnabled:
              getRuntimeQualitySettings(interactionQualityRef.current.active).hoverRaycastEnabled,
          })) return;
          moveInFlight = true;

          // Cancel any stale in-flight raycast: bump the gen counter, and
          // bail out below if a newer pointermove has come in by the time
          // our async raycast resolves. Without this, fast mouse-moves
          // queue raycasts that finish out-of-order and "rubber-band"
          // the highlight back to a stale element.
          const myGen = hoverGenRef.current;

          const pickerPoint = clientPointToNdc(pt, canvas);
          const mouse2 = new THREE.Vector2(pt.x, pt.y);
          try {
            // Fast miss-guard: GPU color-coded pass (O(1)). Avoids raycast on void.
            const fastPicker = fastPickerRef.current;
            if (fastPicker) {
              const hitModelId = await queryFastPicker(fastPicker, pickerPoint);
              if (myGen !== hoverGenRef.current) return;
              if (!hitModelId) {
                const prevHoverLocal = hoveredLocalIdRef.current;
                const prevHoverExpress = hoveredExpressIdRef.current;
                if (prevHoverLocal !== null) {
                  hoveredLocalIdRef.current = null;
                  hoveredExpressIdRef.current = null;
                  const st = useStore.getState();
                  if (!isExpressIdSelected(prevHoverExpress, st.selectedElementId, st.selectedIds)) {
                    model.resetHighlight([prevHoverLocal]).catch(() => {});
                  }
                  // Schedule a render so the un-highlight
                  // is visible on the next frame instead of waiting for the
                  // next orbit tick. update(true) is required - highlight
                  // resets don't change LOD-tile structure, so update(false)
                  // is a no-op for the render flush.
                  fragmentUpdateScheduler?.request({
                    priority: 'visual',
                    force: true,
                    reason: 'hover-highlight',
                  });
                }
                clearHoverTooltip();
                if (ctrl && measuring) ctrl.handleMove(null);
                return;
              }
            }

            const cam = world.camera.three as THREE.PerspectiveCamera | THREE.OrthographicCamera;
            const result = await model.raycast({ camera: cam, mouse: mouse2, dom: canvas });
            // Stale: a newer pointermove fired while we were awaiting.
            if (myGen !== hoverGenRef.current) return;

            // Cache id mappings from hover hits for later click highlights.
            if (result) {
              const productId = modelService.resolveProductIdFromHitSync(result.itemId, result.localId);
              expressToLocalCacheRef.current.set(result.itemId, result.localId);
              expressToLocalCacheRef.current.set(productId, result.localId);
            }

            if (ctrl && measuring) {
              if (result?.point) {
                const worldPt = new THREE.Vector3(result.point.x, result.point.y, result.point.z);
                // Screen-space vertex snap: project face vertices and snap within 20px.
                const canvasRect = canvas.getBoundingClientRect();
                const cursorPx = new THREE.Vector2(
                  pt.x - canvasRect.left,
                  pt.y - canvasRect.top,
                );
                const vertSnap = snapToFaceVertex(
                  result.facePoints,
                  cursorPx,
                  cam,
                  canvas.clientWidth,
                  canvas.clientHeight,
                  20,
                );
                ctrl.handleMove(worldPt, vertSnap);
              } else {
                ctrl.handleMove(null);
              }
            }

            if (hoverOn && !measuring) {
              const st = useStore.getState();
              const hoverProductId = result
                ? modelService.resolveProductIdFromHitSync(result.itemId, result.localId)
                : null;
              const resultIsSelected = result
                ? isExpressIdSelected(hoverProductId, st.selectedElementId, st.selectedIds)
                : false;
              const newHoverLocal = result && !resultIsSelected ? result.localId : null;
              const newHoverExpress = result && !resultIsSelected ? hoverProductId : null;
              const prevHoverLocal = hoveredLocalIdRef.current;
              const prevHoverExpress = hoveredExpressIdRef.current;

              // Skip work if the hover target didn't change. `decideHoverWork`
              // is a pure helper pinned by vitest to prove
              // that stationary hover produces zero material churn.
              const decision = decideHoverWork(prevHoverLocal, newHoverLocal);
              if (result) {
                maybeUpdateHoverTooltip(result, pt, !decision.skip);
              } else if (!decision.skip) {
                clearHoverTooltip();
              }
              if (decision.skip) return;

              hoveredLocalIdRef.current = newHoverLocal;
              hoveredExpressIdRef.current = newHoverExpress;

              // Fire reset + highlight WITHOUT awaiting - they don't depend
              // on each other for the visible result, and awaiting adds
              // ~10 ms of stall per pointermove tick. The render kick at
              // the bottom is also fire-and-forget.
              if (decision.toReset !== null) {
                if (!isExpressIdSelected(prevHoverExpress, st.selectedElementId, st.selectedIds)) {
                  model.resetHighlight([decision.toReset]).catch(() => {});
                }
              }
              if (decision.toHighlight !== null) {
                model.highlight([decision.toHighlight], HOVER_HIGHLIGHT_MATERIAL).catch(() => {});
              }
              // Schedule a render so the new hover state is visible without
              // waiting for the next orbit tick. Fire-and-forget - we don't
              // need to wait for it to finish before starting the next
              // pointermove raycast. update(true) required: highlight changes
              // alone don't trigger a render flush via update(false).
              fragmentUpdateScheduler?.request({
                priority: 'visual',
                force: true,
                reason: 'hover-highlight',
              });
            }
          } catch {
            /* preview raycast misses are non-fatal */
          } finally {
            moveInFlight = false;
            if (replayMoveAfterFlight && pendingMovePoint) {
              replayMoveAfterFlight = false;
              scheduleMovePreview();
            } else {
              replayMoveAfterFlight = false;
            }
          }
        };

        const onPointerMove = (event: PointerEvent) => {
          // Track raw pointer travel for the prefetch/pre-resolve drag guards
          // BEFORE any policy short-circuit below.
          lastPointerClientX = event.clientX;
          lastPointerClientY = event.clientY;
          // Feed the shared move-preview as long as either consumer is
          // interested (measurement mode on OR hover highlight enabled).
          const ctrl = measurementControllerRef.current;
          const measuring = !!ctrl && ctrl.getMode() !== 'off';
          const hoverOn = useStore.getState().hoverHighlightEnabled;
          const policy = {
            measuring,
            hoverHighlightEnabled: hoverOn,
            cameraNavigating: cameraNavigatingRef.current,
            hoverQualityEnabled:
              getRuntimeQualitySettings(interactionQualityRef.current.active).hoverRaycastEnabled,
          };
          if (!shouldRunHoverRaycast(policy)) return;
          pendingMovePoint = { x: event.clientX, y: event.clientY };
          hoverGenRef.current += 1;
          if (shouldDelayHoverRaycast(policy)) {
            if (hoverIntentTimer !== null) {
              window.clearTimeout(hoverIntentTimer);
            }
            hoverIntentTimer = window.setTimeout(() => {
              hoverIntentTimer = null;
              scheduleMovePreview();
            }, HOVER_INTENT_DELAY_MS);
            return;
          }
          if (hoverIntentTimer !== null) {
            window.clearTimeout(hoverIntentTimer);
            hoverIntentTimer = null;
          }
          scheduleMovePreview();
        };

        // Clear any hover highlight and tooltip when the pointer leaves the canvas.
        const onPointerLeave = async () => {
          pendingMovePoint = null;
          replayMoveAfterFlight = false;
          hoverGenRef.current += 1;
          if (hoverIntentTimer !== null) {
            window.clearTimeout(hoverIntentTimer);
            hoverIntentTimer = null;
          }
          if (moveRafHandle) {
            cancelAnimationFrame(moveRafHandle);
            moveRafHandle = 0;
          }
          clearHoverTooltip();
          const prevHoverLocal = hoveredLocalIdRef.current;
          const prevHoverExpress = hoveredExpressIdRef.current;
          if (prevHoverLocal === null) return;
          hoveredLocalIdRef.current = null;
          hoveredExpressIdRef.current = null;
          try {
            const st = useStore.getState();
            if (!isExpressIdSelected(prevHoverExpress, st.selectedElementId, st.selectedIds)) {
              await model.resetHighlight([prevHoverLocal]);
            }
            // Forced update: highlight reset doesn't change LOD-tile
            // structure, so update(false) would skip the render flush.
            fragmentUpdateScheduler?.request({
              priority: 'visual',
              force: true,
              reason: 'hover-highlight',
            });
          } catch { /* noop */ }
        };

        // Right-click context menu. Raycasts under the cursor; if it hits an
        // element we open the full menu keyed by that element's ifc_type,
        // otherwise we open the short "Show all" menu. preventDefault blocks
        // the browser's native menu so we don't get two stacked menus.
        const onCanvasContextMenu = async (event: MouseEvent) => {
          if (disposed) return;
          event.preventDefault();
          event.stopPropagation();

          // Suppress menu when the right button was dragged (orbit/pan gesture).
          // A movement of >5 px between right-pointerdown and the contextmenu
          // event means the user was rotating the model, not requesting a menu.
          const rightDragDist = Math.hypot(event.clientX - rightDownX, event.clientY - rightDownY);
          if (rightDragDist > 5) return;

          // Skip while measuring - right-click cancels the in-flight ruler
          // (the MeasurementController already listens for Escape; we just
          // don't want a menu on top of the canceled measurement).
          const ctrl = measurementControllerRef.current;
          if (ctrl && ctrl.getMode() !== 'off') {
            ctrl.cancel();
            return;
          }

          const pointerPoint = { x: event.clientX, y: event.clientY };
          const pickerPoint = clientPointToNdc(pointerPoint, canvas);
          const mouseVec = new THREE.Vector2(event.clientX, event.clientY);
          let expressId: number | null = null;
          let ifcType: string | null = null;
          try {
            // Fast miss-guard for context menu: skip raycast when cursor is over void.
            const fastPicker = fastPickerRef.current;
            if (fastPicker) {
              const hitModelId = await queryFastPicker(fastPicker, pickerPoint);
              if (!hitModelId) {
                setContextMenuStateRef.current({ x: event.clientX, y: event.clientY, expressId: null, ifcType: null });
                return;
              }
            }

            const camera = world.camera.three as
              | THREE.PerspectiveCamera
              | THREE.OrthographicCamera;
            const raycastData: FRAGS.RaycastData = { camera, mouse: mouseVec, dom: canvas };
            const result = await model.raycast(raycastData);
            if (result) {
              // Normalize representation/geometry-item hits to the owning
              // IfcProduct so the context menu acts on the same element the
              // user thinks they clicked, not on a sub-entity.
              expressId = modelService.resolveProductIdFromHitSync(result.itemId, result.localId);
              // Look up the element's ifc_type from the in-memory spatial
              // tree. Avoids a round-trip to the backend; falls back to
              // null if the tree hasn't been populated yet.
              ifcType = findIfcTypeForId(useStore.getState().spatialTree, expressId);
            }
          } catch (err) {
            console.warn('Context-menu raycast failed:', err);
          }

          setContextMenuStateRef.current({
            x: event.clientX,
            y: event.clientY,
            expressId,
            ifcType,
          });
        };

        canvas.addEventListener('pointerdown', onPointerDown);
        canvas.addEventListener('pointerup', onPointerUp);
        canvas.addEventListener('pointermove', onPointerMove);
        canvas.addEventListener('pointerleave', onPointerLeave);
        canvas.addEventListener('contextmenu', onCanvasContextMenu);
        canvas.style.cursor = 'default';

        // Dispose the storey[0] sub-model now that the full model is loaded.
        if (storeySubModel) {
          try {
            await storeySubModel.dispose();
          } catch {
            // Best-effort: the sub-model may have already been cleaned up.
          }
          storeySubModel = null;
        }

        updateLoadProgress({
          title: 'Viewport ready',
          detail: 'Model loaded successfully.',
          progress: 100,
          sourceHint: modelLoadSourceHint(modelLoadSource),
        });

        // Flush one final render then wait for at least 3 rendered frames
        // before signalling ready. A forced tile rebuild here can make the
        // model visibly blink after it is already mounted.
        try { await fragmentsManager.core.update(false); } catch { /* best-effort */ }
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        );
        // Signal readiness after the first frames paint; fade the overlay independently.
        window.clearTimeout(globalSlowTimer);
        setLoadingSlow(false);
        setLoadingFading(true);
        setViewerReady(true);
        window.dispatchEvent(new CustomEvent('ifc-viewer-ready', {
          detail: { fingerprint: useStore.getState().modelFingerprint },
        }));
        // Unmount the overlay after the CSS fade completes - fire-and-forget so
        // it never blocks readiness. The duration matches the
        // `transition: opacity 350ms` on `.viewer-load-overlay` in index.css.
        window.setTimeout(() => {
          setLoading(false);
          setLoadingFading(false);
        }, 350);

        // Record TTFR (init -> viewer ready), total load time (upload -> ready),
        // and rolling fragment-cache hit rate.
        const state = useStore.getState();
        const wallClockNow = Date.now();
        const readyMetrics = computeViewerReadyMetrics({
          source: modelLoadSource,
          initStartMs: initStart,
          nowMs: performance.now(),
          loadStartTs: state.loadStartTs,
          wallClockNowMs: wallClockNow,
          previousCacheHitRate: state.perfMetrics.cacheHitRate,
        });
        state.updatePerfMetrics({
          ttfrMs: readyMetrics.ttfrMs,
          loadMs: readyMetrics.loadMs,
          cacheHitRate: readyMetrics.cacheHitRate,
        });

        // Persist perf sample to localStorage for the performance dashboard.
        try {
          const existing: unknown[] = JSON.parse(localStorage.getItem(VIEWER_PERF_LOG_STORAGE_KEY) ?? '[]');
          const entry = buildViewerPerfLogEntry({
            timestampMs: wallClockNow,
            source: modelLoadSource,
            ttfrMs: readyMetrics.ttfrMs,
            ttfgMs: ttfg,
            loadMs: readyMetrics.loadMs,
          });
          localStorage.setItem(
            VIEWER_PERF_LOG_STORAGE_KEY,
            JSON.stringify(prependViewerPerfLogEntry(existing, entry)),
          );
        } catch { /* quota / parse errors are non-critical */ }

        const timingDetail = formatStageTimings(stageTimings);
        state.logActivity({
          kind: 'info',
          summary: formatViewerReadySummary(modelLoadSource, readyMetrics.ttfrMs, ttfg),
          detail: timingDetail || undefined,
        });
        if (timingDetail && import.meta.env.DEV) {
          console.info(`[ViewerPanel] Stage timings (${modelLoadSource}): ${timingDetail}`);
        }

        // Fire-and-forget post-fit render so ready state is not blocked.
        void fragmentsManager.core.update(false).catch(() => {
          /* ignore */
        });

        // Kick off performance sampling loop (FPS, memory, draw calls)
        startPerfSampling();
      } catch (err: any) {
        window.clearTimeout(globalSlowTimer);
        if (!disposed) {
          // Surface the full stack so we can tell whether the error is
          // coming from the live IFC parse, cached-fragment inflate, post-
          // load tile update, or downstream. The raw error message alone
          // ("incorrect header check") tells us nothing about the phase.
          console.error('Viewer init error:', err, '\nstack:', err?.stack);
          setLoadError(err.message || 'Failed to initialize 3D viewer');
          setLoadingSlow(false);
          setLoading(false);
          useStore.getState().logActivity({
            kind: 'error',
            summary: 'Viewer init failed',
            detail: err.message,
          });
        }
      }
    }

    function startPerfSampling() {
      let frames = 0;
      let lastFrameTs = performance.now();
      let rafId = 0;
      let intervalId: number | null = null;

      const shouldSampleFrames = () => {
        const state = useStore.getState();
        return state.perfHudVisible || state.perfDashOpen;
      };

      const tick = () => {
        frames++;
        if (!firstFrameCaptured) {
          firstFrameCaptured = true;
        }
        rafId = shouldSampleFrames() ? requestAnimationFrame(tick) : 0;
      };

      const sampleTick = () => {
        if (disposed) return;
        const now = performance.now();
        const elapsedSec = (now - lastFrameTs) / 1000;
        const fps = elapsedSec > 0 ? frames / elapsedSec : 0;
        frames = 0;
        lastFrameTs = now;

        // Memory usage from performance.memory (Chromium only)
        let memMb: number | null = null;
        const perfAny = performance as unknown as { memory?: { usedJSHeapSize: number } };
        if (perfAny.memory) {
          memMb = perfAny.memory.usedJSHeapSize / (1024 * 1024);
        }

        // Draw calls / triangles come from the per-frame main-pass snapshot,
        // not renderer.info: the raw counters end each frame holding only
        // the passes drawn after the engine's mid-frame onBeforeUpdate
        // re-trigger (gizmo-only numbers - see the capture wiring next to
        // renderGizmo).
        const snap = getMainPassStats();
        useStore.getState().updatePerfMetrics({
          fps,
          memoryMb: memMb,
          drawCalls: snap.drawCalls,
          triangles: snap.triangles,
        });
      };

      // Sample ONLY while the perf HUD or dashboard is open. The
      // previous session-long 500 ms interval woke up forever just to learn
      // the HUD was closed, and stashed its rAF id on a DOM expando that a
      // restart could orphan. Start/stop now ride HUD-visibility transitions
      // via a transient store subscription; ids live in this closure only.
      const stopSampling = () => {
        if (intervalId !== null) {
          window.clearInterval(intervalId);
          intervalId = null;
        }
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
        frames = 0;
      };
      const startSampling = () => {
        if (disposed || intervalId !== null) return;
        frames = 0;
        lastFrameTs = performance.now();
        rafId = requestAnimationFrame(tick);
        intervalId = window.setInterval(sampleTick, 500);
      };

      if (shouldSampleFrames()) startSampling();
      const unsubscribe = useStore.subscribe(
        (s) => s.perfHudVisible || s.perfDashOpen,
        (sampling: boolean) => {
          if (disposed) return;
          if (sampling) startSampling();
          else stopSampling();
        },
      );
      perfSamplingCleanup = () => {
        unsubscribe();
        stopSampling();
      };
    }

    init();

    return () => {
      disposed = true;
      // Abort any in-flight native geometry request and dispose preview meshes.
      nativePreviewAbort.abort();
      if (nativePreview) {
        const scene = viewerRef.current?.world?.scene?.three as THREE.Scene | undefined;
        if (scene) removeNativePreview(scene, nativePreview);
        nativePreview = null;
      }
      removePanelResizeHooks?.();
      zFightingCleanup?.();
      fragmentUpdateScheduler?.cancel();
      fragmentUpdateSchedulerRef.current = null;
      if (hoverIntentTimer !== null) {
        window.clearTimeout(hoverIntentTimer);
        hoverIntentTimer = null;
      }
      // Tear down the interaction-quality wiring.
      interactionQualityUnsub?.();
      interactionQualityUnsub = null;
      perfSamplingCleanup?.();
      perfSamplingCleanup = null;
      setHoverTooltipData(null);
      // Reset native highlights/opacity (fire-and-forget; model may already be disposed)
      if (viewerRef.current) {
        void viewerRef.current.model.resetHighlight(undefined).catch(() => {});
        void viewerRef.current.model.resetOpacity(undefined).catch(() => {});
      }
      viewHelperCleanup?.();
      pixelRatioCleanup?.();
      renderOnDemandCleanup?.();
      // Dispose storey frustum culler (restores any auto-culled visibility)
      if (storeyFrustumCullerRef.current) {
        const cullerModel = viewerRef.current?.model;
        void storeyFrustumCullerRef.current.dispose(cullerModel).catch(() => {});
        storeyFrustumCullerRef.current = null;
      }
      // Dispose element frustum culler
      if (elementFrustumCullerRef.current) {
        const cullerModel = viewerRef.current?.model;
        void elementFrustumCullerRef.current.dispose(cullerModel).catch(() => {});
        elementFrustumCullerRef.current = null;
      }
      useStore.getState().updatePerfMetrics({ culledStoreys: 0, culledElements: 0 });
      // FastModelPicker is disposed by components.dispose(); just clear the ref.
      fastPickerRef.current = null;
      // Reset clip edges before the model is torn down so stale ClipEdges
      // instances don't reference a disposed model on the next load.
      clipEdgesServiceRef.current?.reset();
      // Dispose furnishing merge before tearing down the model
      if (furnishingMergeRef.current) {
        void furnishingMergeRef.current.dispose().catch(() => {});
        furnishingMergeRef.current = null;
      }
      useStore.getState().setFurnishingMerged(false);
      // Dispose storey[0] preview sub-model if component unmounts mid-stream.
      if (storeySubModel) {
        void storeySubModel.dispose().catch(() => {});
        storeySubModel = null;
      }
      modelService.dispose();
      components.dispose();
      // Revoke the FragmentsManager worker blob URL only after the manager
      // is fully torn down - premature revocation breaks subsequent
      // `core.load()` calls. See note at the init site.
      if (workerBlobUrlRef.current) {
        try { URL.revokeObjectURL(workerBlobUrlRef.current); } catch { /* best-effort */ }
        workerBlobUrlRef.current = null;
      }
      viewerRef.current = null;
      sceneThemeTargetsRef.current = null;
      useStore.getState().setModelHalfExtents(null);
    };
  }, [computeFitDistance, applyTheme, updateLoadProgress, applyGhostPostproduction]);

  // Toggle EdgeDetectionPass.xray on PostproductionRenderer for true ghost
  // edges. Fragment visibility/opacity is owned by the coalesced visibility
  // scheduler above so ghost mode has one mutation path.
  useEffect(() => {
    applyGhostPostproduction(cameraNavigatingRef.current);
  }, [applyGhostPostproduction, ghostModeOn]);

  // Reset ghost mode whenever isolation is cleared
  useEffect(() => {
    if (isolatedIds.length === 0) setGhostModeOn(false);
  }, [isolatedIds, setGhostModeOn]);

  // Camera control functions exposed to toolbar
  const setCameraView = useCallback((view: string) => {
    applyCameraPreset(view, true);
  }, [applyCameraPreset]);

  const fitToModel = useCallback(() => {
    applyCameraPreset('iso', true);
  }, [applyCameraPreset]);

  /**
   * Zoom the camera in or out by `delta` units along the line of sight.
   * Positive delta = zoom out (move away from target), negative = zoom in.
   * Uses camera-controls' dolly() which respects the min/max distance limits.
   */
  const handleViewerZoom = useCallback((delta: number) => {
    if (!viewerRef.current) return;
    try {
      type Ctrl = { dolly: (d: number, animate: boolean) => void };
      (viewerRef.current.world.camera.controls as unknown as Ctrl).dolly(delta, true);
    } catch { /* ignore if controls not ready */ }
  }, []);

  /**
   * Camera-controls' baseline transition smooth-time, captured lazily on the
   * first frame call so `frameBoxWithCamera` can restore it after each
   * travel-scaled transition. Re-reading it per call would capture our own
   * in-flight override when zooms overlap, and the value would drift.
   */
  const defaultSmoothTimeRef = useRef<number | null>(null);

  /**
   * Shared camera core for zoomToElement / frameElements: solve the landing
   * pose with `solveCameraFrame` (approach from the camera's current side,
   * elevation clamp, bounding-sphere fit, ortho zoom), then animate there
   * with a travel-scaled smooth-time.
   */
  const frameBoxWithCamera = useCallback(async (box: THREE.Box3) => {
    if (!viewerRef.current) return;
    const { world } = viewerRef.current;
    const controls = world.camera.controls;
    const camera = world.camera.three as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    const persp = camera as THREE.PerspectiveCamera;
    const ortho = camera as THREE.OrthographicCamera;
    const isPerspective = persp.isPerspectiveCamera === true;

    const solution = solveCameraFrame({
      center: box.getCenter(new THREE.Vector3()),
      size: box.getSize(new THREE.Vector3()),
      cameraPos: controls.getPosition(new THREE.Vector3()),
      isPerspective,
      fovDeg: isPerspective ? persp.fov : undefined,
      aspect: isPerspective ? persp.aspect : undefined,
      orthoWidth: isPerspective ? undefined : ortho.right - ortho.left,
      orthoHeight: isPerspective ? undefined : ortho.top - ortho.bottom,
    });

    if (defaultSmoothTimeRef.current == null) {
      defaultSmoothTimeRef.current = controls.smoothTime;
    }
    controls.smoothTime = solution.smoothTime;
    // Wrap accumulated azimuth/polar angles back into the canonical range so
    // the animated setLookAt takes the shortest rotation instead of unwinding
    // whole revolutions of orbit history (see applyCameraPreset).
    controls.normalizeRotations();
    try {
      const moves = [
        controls.setLookAt(
          solution.eye.x, solution.eye.y, solution.eye.z,
          solution.target.x, solution.target.y, solution.target.z,
          true,
        ),
      ];
      if (solution.orthoZoom != null) moves.push(controls.zoomTo(solution.orthoZoom, true));
      await Promise.all(moves);
    } finally {
      controls.smoothTime = defaultSmoothTimeRef.current;
    }
  }, []);

  /**
   * Frame the camera on a single element by IFC Express id. This is the
   * "zoom icon" action the tree, viewer double-click and chat tools share.
   */
  const zoomToElement = useCallback(async (expressId: number) => {
    if (!viewerRef.current) return;
    const { model } = viewerRef.current;
    try {
      const [localId] = await expressToLocalIds(model, [expressId]);
      if (localId == null) return;
      const box = await model.getMergedBox([localId]);
      if (!box) return;
      useStore.getState().logActivity({
        kind: 'view',
        summary: `Zoomed to element #${expressId}`,
      });
      await frameBoxWithCamera(box);
    } catch (e) {
      console.warn('zoomToElement failed:', e);
    }
  }, [expressToLocalIds, frameBoxWithCamera]);

  // Register zoomToElement with the store so deep components (tree rows,
  // chat tools, command palette) can trigger it without prop drilling.
  useEffect(() => {
    if (!viewerReady) return;
    useStore.getState().setZoomToElementFn((id) => { void zoomToElement(id); });
    return () => {
      useStore.getState().setZoomToElementFn(null);
    };
  }, [viewerReady, zoomToElement]);

  /**
   * Frame the camera on N elements via their merged bounding box.
   * Used by the "F" keyboard shortcut when a selection or multi-highlight is
   * active, so framing matches the existing H / I priority order.
   * Falls back to the merged AABB so a 50-element highlight still fits.
   */
  const frameElements = useCallback(async (expressIds: number[]) => {
    if (!viewerRef.current) return;
    if (expressIds.length === 0) return;
    const { model } = viewerRef.current;
    try {
      const localIdsRaw = await expressToLocalIds(model, expressIds);
      const localIds = localIdsRaw.filter((v): v is number => v != null);
      if (localIds.length === 0) return;
      const box = await model.getMergedBox(localIds);
      if (!box) return;
      const summary = expressIds.length === 1
        ? `Framed element #${expressIds[0]}`
        : `Framed ${expressIds.length} elements`;
      useStore.getState().logActivity({ kind: 'view', summary });
      await frameBoxWithCamera(box);
    } catch (e) {
      console.warn('frameElements failed:', e);
    }
  }, [expressToLocalIds, frameBoxWithCamera]);

  // Register frameElements with the store so KeyboardShortcuts (and the
  // command palette / chat tools, in future) can drive it without prop drilling.
  useEffect(() => {
    if (!viewerReady) return;
    useStore.getState().setFrameElementsFn((ids) => { void frameElements(ids); });
    return () => {
      useStore.getState().setFrameElementsFn(null);
    };
  }, [viewerReady, frameElements]);

  // Fit the section box to a single element's AABB (10 % padding on each axis).
  const clipToElement = useCallback(async (expressId: number) => {
    if (!viewerRef.current) return;
    const { model } = viewerRef.current;
    try {
      const [localId] = await expressToLocalIds(model, [expressId]);
      if (localId == null) return;
      const raw = await model.getMergedBox([localId]);
      if (!raw) return;
      const box = padBox(raw, 0.1);
      const ctrl = sectionBoxControllerRef.current;
      if (!ctrl) return;
      ctrl.enable(box);
      setSectionBoxEnabled(true);
      useStore.getState().logActivity({ kind: 'view', summary: `Section box clipped to element #${expressId}` });
    } catch (e) {
      console.warn('clipToElement failed:', e);
    }
  }, [expressToLocalIds, setSectionBoxEnabled]);

  // Register clipToElement with the store (same pattern as zoomToElement).
  useEffect(() => {
    if (!viewerReady) return;
    useStore.getState().setClipToElementFn((id) => { void clipToElement(id); });
    return () => {
      useStore.getState().setClipToElementFn(null);
    };
  }, [viewerReady, clipToElement]);

  // Soft amber preview highlight driven by sidebar tree-row hover.
  // Reuses HOVER_HIGHLIGHT_MATERIAL semantics (amber + transparent) so the
  // preview reads the same whether the user is hovering the canvas or a row
  // in the spatial tree.  State machine lives in `treeHoverPreviewHelpers.ts`
  // (gen-counter discards stale async resolutions so a fast cursor sweep
  // never paints behind the user); we keep a parallel local-id ref because
  // the FragmentsModel API speaks in local ids, not express ids.
  const treeHoverStateRef = useRef<TreeHoverPreviewState>(INITIAL_TREE_HOVER_STATE);
  const treeHoverPaintedLocalRef = useRef<number | null>(null);
  const treeHoverPreview = useCallback(async (expressId: number | null) => {
    if (!viewerRef.current) return;
    const { model } = viewerRef.current;

    // Advance the state machine first so any concurrent call sees the new gen.
    treeHoverStateRef.current = expressId === null
      ? onTreeHoverLeave(treeHoverStateRef.current)
      : onTreeHoverEnter(treeHoverStateRef.current, expressId);
    const myGen = treeHoverStateRef.current.gen;

    // Hover-leave: drop whatever was painted, unless it's click-selected.
    if (expressId === null) {
      const prevLocal = treeHoverPaintedLocalRef.current;
      const prevExpress = treeHoverStateRef.current.paintedId;
      if (prevLocal == null) return;
      treeHoverPaintedLocalRef.current = null;
      treeHoverStateRef.current = onTreeHoverPainted(treeHoverStateRef.current, null);
      const st = useStore.getState();
      if (!shouldSkipResetForSelection(prevExpress, st.selectedElementId, st.selectedIds)) {
        await model.resetHighlight([prevLocal]).catch(() => {});
        // resetHighlight alone doesn't dirty LOD tiles under the manual-render
        // renderer, so kick one coalesced frame - otherwise the un-paint may
        // linger until the next camera/visibility event (Appendix B picking #6).
        requestFragmentUpdate('hover-highlight');
      }
      return;
    }

    // Gate the hover-enter paint the same way the canvas hover path is gated
    // (Appendix B picking #6): don't churn highlights while the camera is
    // navigating, and respect the hoverHighlightEnabled preference so disabling
    // canvas hover also disables tree-row hover. Leave (above) still runs so a
    // stale preview clears promptly.
    if (
      cameraNavigatingRef.current
      || !useStore.getState().hoverHighlightEnabled
      || !getRuntimeQualitySettings(interactionQualityRef.current.active).hoverRaycastEnabled
    ) {
      return;
    }

    // Hover-enter: resolve express to local, then paint if still current.
    try {
      const [localId] = await expressToLocalIds(model, [expressId]);
      if (isResolutionStale(treeHoverStateRef.current, myGen)) return;
      if (localId == null) return;

      const prevLocal = treeHoverPaintedLocalRef.current;
      const prevExpress = treeHoverStateRef.current.paintedId;
      const st = useStore.getState();
      if (shouldSkipResetForSelection(expressId, st.selectedElementId, st.selectedIds)) {
        if (prevLocal != null && !shouldSkipResetForSelection(prevExpress, st.selectedElementId, st.selectedIds)) {
          await model.resetHighlight([prevLocal]).catch(() => {});
        }
        treeHoverPaintedLocalRef.current = null;
        treeHoverStateRef.current = onTreeHoverPainted(treeHoverStateRef.current, null);
        return;
      }
      if (prevLocal === localId) return;  // already painted; nothing to do

      if (prevLocal != null) {
        if (!shouldSkipResetForSelection(prevExpress, st.selectedElementId, st.selectedIds)) {
          await model.resetHighlight([prevLocal]).catch(() => {});
        }
      }

      if (isResolutionStale(treeHoverStateRef.current, myGen)) return;
      treeHoverPaintedLocalRef.current = localId;
      treeHoverStateRef.current = onTreeHoverPainted(treeHoverStateRef.current, expressId);
      // Reuse the shared frozen hover material (singleton THREE.Color) instead
      // of allocating a fresh THREE.Color + options object per row hover - a
      // fast tree sweep used to leak one of each per row (Appendix B picking
      // #2). HOVER_HIGHLIGHT_MATERIAL already encodes the same amber / 0.45 /
      // transparent / RenderedFaces.ONE the canvas hover path uses.
      model.highlight([localId], HOVER_HIGHLIGHT_MATERIAL).catch(() => {});
    } catch {
      // Resolution failure is non-fatal - just leave the previous paint alone.
    }
  }, [expressToLocalIds, requestFragmentUpdate]);

  useEffect(() => {
    if (!viewerReady) return;
    useStore.getState().setTreeHoverPreviewFn((id) => { void treeHoverPreview(id); });
    return () => {
      useStore.getState().setTreeHoverPreviewFn(null);
      // Clear any leftover paint on unmount / model swap.
      const prevLocal = treeHoverPaintedLocalRef.current;
      treeHoverPaintedLocalRef.current = null;
      treeHoverStateRef.current = INITIAL_TREE_HOVER_STATE;
      if (prevLocal != null && viewerRef.current) {
        viewerRef.current.model.resetHighlight([prevLocal]).catch(() => {});
      }
    };
  }, [viewerReady, treeHoverPreview]);

  // Keyboard zoom: + / = zoom in, - zoom out, 0 fit to model.
  // Only fires when no text input is focused (avoids hijacking form fields).
  useEffect(() => {
    if (!viewerReady) return;
    const onKey = (e: KeyboardEvent) => {
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      if (e.key === '+' || e.key === '=') { e.preventDefault(); handleViewerZoom(-3); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); handleViewerZoom(3); }
      else if (e.key === '0') { e.preventDefault(); fitToModel(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [viewerReady, handleViewerZoom, fitToModel]);

  // Register getCameraStateFn + setLookAtFn so share-link can read and restore camera.
  useEffect(() => {
    if (!viewerReady) return;
    useStore.getState().setGetCameraStateFn(() => {
      if (!viewerRef.current) return null;
      try {
        const controls = viewerRef.current.world.camera.controls as {
          getPosition: (out?: THREE.Vector3) => THREE.Vector3;
          getTarget: (out?: THREE.Vector3) => THREE.Vector3;
        };
        const pos = controls.getPosition(new THREE.Vector3());
        const tgt = controls.getTarget(new THREE.Vector3());
        return {
          pos: [pos.x, pos.y, pos.z],
          target: [tgt.x, tgt.y, tgt.z],
        };
      } catch {
        return null;
      }
    });
    useStore.getState().setSetLookAtFn((pos, tgt, animate) => {
      if (!viewerRef.current) return;
      try {
        viewerRef.current.world.camera.controls.setLookAt(
          pos[0], pos[1], pos[2],
          tgt[0], tgt[1], tgt[2],
          animate,
        );
      } catch { /* ignore */ }
    });
    return () => {
      useStore.getState().setGetCameraStateFn(null);
      useStore.getState().setSetLookAtFn(null);
    };
  }, [viewerReady]);

  // Render one fresh frame into the drawing buffer for capture. When the
  // postproduction composer is active (ghost mode), a plain renderer.render
  // bypasses the edge/xray passes and the capture doesn't match the screen
  // - route through the composer in that case.
  const renderForCapture = useCallback(() => {
    if (!viewerRef.current) return null;
    const { world } = viewerRef.current;
    const renderer = world.renderer!.three;
    const pp = postproductionRef.current as unknown as {
      enabled?: boolean;
      composer?: { render: () => void };
    } | null;
    if (pp?.enabled && pp.composer?.render) {
      try {
        pp.composer.render();
        return renderer.domElement;
      } catch { /* fall through to the plain render */ }
    }
    renderer.render(world.scene.three, world.camera.three);
    return renderer.domElement;
  }, []);

  // Capture a screenshot of the current 3D viewport
  const captureScreenshot = useCallback(() => {
    if (!viewerRef.current) return;
    try {
      const canvas = renderForCapture();
      if (!canvas) return;
      const dataUrl = canvas.toDataURL('image/png');

      const a = document.createElement('a');
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      a.download = `ifc-viewer-${ts}.png`;
      a.href = dataUrl;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      useStore.getState().logActivity({
        kind: 'screenshot',
        summary: `Screenshot saved (${a.download})`,
      });
    } catch (e: any) {
      console.error('Screenshot failed:', e);
      useStore.getState().logActivity({
        kind: 'error',
        summary: 'Screenshot failed',
        detail: e?.message,
      });
    }
  }, [renderForCapture]);

  // Generate a small JPEG thumbnail data URL from the current viewport
  const captureThumbnail = useCallback((): string | null => {
    if (!viewerRef.current) return null;
    try {
      // Fresh frame in the drawing buffer - composer-aware.
      const source = renderForCapture();
      if (!source) return null;
      const w = 200;
      const h = Math.round((source.height / source.width) * w) || Math.round(w * 0.7);
      const tmp = document.createElement('canvas');
      tmp.width = w;
      tmp.height = h;
      const ctx = tmp.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(source, 0, 0, w, h);
      return tmp.toDataURL('image/jpeg', 0.55);
    } catch {
      return null;
    }
  }, [renderForCapture]);

  // Parameterized JPEG snapshot for the viewer bridge (BCF viewpoints,
  // backend snapshot commands). Same composer-aware render + canvas-downscale
  // technique as captureThumbnail, but with a caller-chosen max width and a
  // higher quality suited to issue screenshots. captureThumbnail stays as-is:
  // its fixed 200px / 0.55 output feeds the saved-viewpoint chips.
  const captureBridgeSnapshot = useCallback((maxPx: number): string | null => {
    if (!viewerRef.current) return null;
    try {
      const source = renderForCapture();
      if (!source) return null;
      const w = Math.max(1, Math.min(Math.round(maxPx), source.width));
      const h = Math.round((source.height / source.width) * w) || Math.round(w * 0.7);
      const tmp = document.createElement('canvas');
      tmp.width = w;
      tmp.height = h;
      const ctx = tmp.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(source, 0, 0, w, h);
      return tmp.toDataURL('image/jpeg', 0.7);
    } catch {
      return null;
    }
  }, [renderForCapture]);

  // Save current camera/visibility/selection state as a viewpoint
  const saveViewpoint = useCallback((name: string) => {
    if (!viewerRef.current) return;
    const state = useStore.getState();
    if (!state.modelLoaded) return;
    const project = state.project;
    // Synthesize a project key when project meta isn't populated yet - some
    // load paths (manifest fast-path / cache-only) don't always set
    // `project` before the user starts using the viewer.
    const projectKey = project
      ? `${project.name}|${project.schema_version}`
      : `model|${state.modelFingerprint || 'unknown'}`;

    const { world } = viewerRef.current;
    const controls = world.camera.controls as {
      getPosition: (out?: THREE.Vector3) => THREE.Vector3;
      getTarget: (out?: THREE.Vector3) => THREE.Vector3;
    };
    const pos = controls.getPosition(new THREE.Vector3());
    const target = controls.getTarget(new THREE.Vector3());

    const vp = {
      id: `vp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      projectKey,
      name: name.trim() || `Viewpoint ${state.viewpoints.length + 1}`,
      createdAt: Date.now(),
      camera: {
        pos: [pos.x, pos.y, pos.z] as [number, number, number],
        target: [target.x, target.y, target.z] as [number, number, number],
      },
      isolatedIds: [...state.isolatedIds],
      hiddenIds: [...state.hiddenIds],
      selectedId: state.selectedElementId,
      highlightedIds: [...state.highlightedIds],
      thumbnail: captureThumbnail(),
    };

    state.saveViewpoint(vp);
    state.logActivity({
      kind: 'view',
      summary: `Saved viewpoint "${vp.name}"`,
    });
  }, [captureThumbnail]);

  // Restore a saved viewpoint: camera, visibility, selection, highlights
  const restoreViewpoint = useCallback((id: string) => {
    if (!viewerRef.current) return;
    const state = useStore.getState();
    const vp = state.viewpoints.find((v) => v.id === id);
    if (!vp) return;

    const { world } = viewerRef.current;
    const [px, py, pz] = vp.camera.pos;
    const [tx, ty, tz] = vp.camera.target;
    world.camera.controls.setLookAt(px, py, pz, tx, ty, tz, true);

    // Apply visibility first, then selection/highlights. The viewer's store
    // subscribers already handle the side effects.
    if (vp.isolatedIds.length > 0) {
      state.setIsolatedIds(vp.isolatedIds);
    } else if (vp.hiddenIds.length > 0) {
      state.setHiddenIds(vp.hiddenIds);
    } else {
      state.clearVisibility();
    }

    state.setHighlightedIds(vp.highlightedIds);
    state.selectElement(vp.selectedId);

    state.logActivity({
      kind: 'view',
      summary: `Restored viewpoint "${vp.name}"`,
    });
  }, []);

  // Register the viewer bridge so non-viewer code (BCF topics, the viewer
  // command executor, the viewer state reporter) can capture or apply 3D view
  // state without importing ViewerPanel. Same lifecycle pattern as the
  // zoomToElement / frameElements store registrations above: register once
  // the world is ready, unregister on dispose. Every capability guards
  // against "model not loaded / world disposed" by returning null / no-op.
  useEffect(() => {
    if (!viewerReady) return;
    const caps: ViewerBridgeCapabilities = {
      // Same camera read as saveViewpoint; visibility/selection from the
      // store. The canvas is only touched when a snapshot is requested -
      // the no-snapshot path runs on every viewer state report.
      captureViewState: async (opts) => {
        if (!viewerRef.current) return null;
        try {
          const { world } = viewerRef.current;
          const controls = world.camera.controls as {
            getPosition: (out?: THREE.Vector3) => THREE.Vector3;
            getTarget: (out?: THREE.Vector3) => THREE.Vector3;
          };
          const pos = controls.getPosition(new THREE.Vector3());
          const target = controls.getTarget(new THREE.Vector3());
          const state = useStore.getState();
          return {
            camera: {
              pos: [pos.x, pos.y, pos.z] as [number, number, number],
              target: [target.x, target.y, target.z] as [number, number, number],
            },
            isolatedIds: [...state.isolatedIds],
            hiddenIds: [...state.hiddenIds],
            selectedId: state.selectedElementId,
            highlightedIds: [...state.highlightedIds],
            snapshotDataUrl: opts?.snapshotMaxPx != null
              ? captureBridgeSnapshot(opts.snapshotMaxPx)
              : null,
          };
        } catch {
          return null;
        }
      },
      // Mirrors restoreViewpoint's order and smoothness: camera (smooth
      // setLookAt) first, then visibility, then highlights and selection.
      // Fields absent from the request leave the current state untouched.
      applyViewState: async (req) => {
        if (!viewerRef.current) return;
        try {
          const state = useStore.getState();
          if (req.camera) {
            const [px, py, pz] = req.camera.pos;
            const [tx, ty, tz] = req.camera.target;
            viewerRef.current.world.camera.controls.setLookAt(px, py, pz, tx, ty, tz, true);
          }
          if (req.isolatedIds !== undefined || req.hiddenIds !== undefined) {
            if (req.isolatedIds && req.isolatedIds.length > 0) {
              state.setIsolatedIds(req.isolatedIds);
            } else if (req.hiddenIds && req.hiddenIds.length > 0) {
              state.setHiddenIds(req.hiddenIds);
            } else {
              state.clearVisibility();
            }
          }
          if (req.highlightedIds !== undefined) {
            state.setHighlightedIds(req.highlightedIds);
          }
          if (req.selectedId !== undefined) {
            state.selectElement(req.selectedId);
          }
        } catch {
          // World disposed mid-apply - leave the viewer as it is.
        }
      },
      // Reuses the existing preset machinery: 'fit' takes the whole-model
      // fit path, the directional names map 1:1 onto the local
      // applyCameraPreset vectors (front/back/left/right/top/iso).
      applyCameraPreset: async (preset) => {
        if (!viewerRef.current) return;
        if (preset === 'fit') {
          fitToModel();
          return;
        }
        applyCameraPreset(preset, true);
      },
    };
    registerViewerBridge(caps);
    return () => {
      unregisterViewerBridge(caps);
    };
  }, [viewerReady, captureBridgeSnapshot, fitToModel, applyCameraPreset]);

  // Expose controls to parent via refs
  useEffect(() => {
    if (onCameraViewRef) onCameraViewRef.current = setCameraView;
    if (onFitModelRef) onFitModelRef.current = fitToModel;
    if (onScreenshotRef) onScreenshotRef.current = captureScreenshot;
    if (onSaveViewpointRef) onSaveViewpointRef.current = saveViewpoint;
    if (onRestoreViewpointRef) onRestoreViewpointRef.current = restoreViewpoint;
    return () => {
      if (onCameraViewRef) onCameraViewRef.current = null;
      if (onFitModelRef) onFitModelRef.current = null;
      if (onScreenshotRef) onScreenshotRef.current = null;
      if (onSaveViewpointRef) onSaveViewpointRef.current = null;
      if (onRestoreViewpointRef) onRestoreViewpointRef.current = null;
    };
  }, [
    setCameraView, fitToModel, captureScreenshot, saveViewpoint, restoreViewpoint,
    onCameraViewRef, onFitModelRef, onScreenshotRef,
    onSaveViewpointRef, onRestoreViewpointRef,
  ]);

  // Tick elapsed seconds for the whole load. Feeds the overlay's time line
  // (elapsed always, a remaining estimate when history backs it) instead of
  // only waking up after the slow-load threshold.
  useEffect(() => {
    if (!loading) {
      setLoadElapsedSec(null);
      return;
    }
    const startedAt = Date.now();
    setLoadElapsedSec(0);
    const id = window.setInterval(() => {
      setLoadElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [loading]);

  // Display progress runs through the pace model in loadProgressPresenter:
  // monotonic (raw checkpoints can regress on fallback paths, the bar never
  // does), never frozen (asymptotic drift toward the next checkpoint), and
  // time-weighted so long phases creep honestly instead of stalling. The
  // expected total comes from this machine's perf-log history with fixed
  // priors as fallback.
  const [displayProgress, setDisplayProgress] = useState<number>(loadProgress.progress);
  const paceRef = useRef<PaceState | null>(null);
  const targetProgressRef = useRef<number>(loadProgress.progress);
  targetProgressRef.current = loadProgress.progress;
  const expectedTotalRef = useRef<{ kind: LoadPathKind; ms: number; fromHistory: boolean }>({
    kind: 'unknown',
    ms: 25_000,
    fromHistory: false,
  });
  const loadPathKind = pathKindForSourceHint(loadProgress.sourceHint);
  useEffect(() => {
    if (loadPathKind === 'unknown' || expectedTotalRef.current.kind === loadPathKind) return;
    let history: ViewerPerfLogEntry[] | null = null;
    try {
      history = JSON.parse(
        localStorage.getItem(VIEWER_PERF_LOG_STORAGE_KEY) ?? '[]',
      ) as ViewerPerfLogEntry[];
    } catch {
      history = null;
    }
    const estimate = estimateExpectedTotal(loadPathKind, history);
    expectedTotalRef.current = { kind: loadPathKind, ...estimate };
    if (paceRef.current) {
      paceRef.current = { ...paceRef.current, expectedTotalMs: estimate.ms };
    }
  }, [loadPathKind]);
  // The pacing loop only runs while the overlay is visible: it spins up per
  // load and shuts down once the overlay is gone (no idle-loop tax).
  useEffect(() => {
    if (!loading) {
      paceRef.current = null;
      return;
    }
    let rafId = 0;
    let lastTs = performance.now();
    const tick = (now: number) => {
      const dt = Math.max(0, now - lastTs);
      lastTs = now;
      const previous = paceRef.current
        ?? createPaceState(targetProgressRef.current, expectedTotalRef.current.ms);
      const next = advancePace(previous, targetProgressRef.current, dt);
      paceRef.current = next;
      // Re-render at 0.1 pct granularity - finer is sub-pixel on the bar.
      if (Math.round(next.display * 10) !== Math.round(previous.display * 10)) {
        setDisplayProgress(next.display);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [loading]);
  // Snap to 100 without easing so completion lands cleanly. (No snap on low
  // values: fallback branches re-report low checkpoints and the bar must
  // never jump backwards.)
  useEffect(() => {
    if (loadProgress.progress >= 100) {
      paceRef.current = paceRef.current
        ? { ...paceRef.current, anchor: 100, display: 100 }
        : createPaceState(100, expectedTotalRef.current.ms);
      setDisplayProgress(100);
    }
  }, [loadProgress.progress]);

  const projectName = useStore((s) => s.project?.name ?? null);
  const serverCachePref = useStore((s) => s.useServerCache);
  const loadPresentation = useMemo(() => {
    const bytes = useStore.getState().ifcFileBytes;
    return presentLoadProgress(loadProgress, {
      fileName: projectName,
      fileSizeMB: bytes ? bytes.byteLength / (1024 * 1024) : null,
      cachesEnabled: serverCachePref,
    });
  }, [loadProgress, projectName, serverCachePref]);
  const loadEta = loadElapsedSec == null
    ? { text: null, overrun: false }
    : formatEta(
      loadElapsedSec * 1000,
      expectedTotalRef.current.ms,
      expectedTotalRef.current.fromHistory,
    );

  const loadPercent = Math.round(Math.max(0, Math.min(100, displayProgress)));
  const loadBarPercent = Math.max(6, loadPercent);
  // Once the first frame is on screen (96+), collapse the pill to a compact
  // one-row chip so the user watches their model, not the loader.
  const loadCompact = loadProgress.progress >= 96;

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', position: 'relative' }}
    >
      {loading && (
        <div className={`viewer-load-overlay${loadingFading ? ' fading' : ''}`}>
          <div
            className="viewer-load-bar-track"
            role="progressbar"
            aria-label="Model loading progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={loadPercent}
          >
            <div className="viewer-load-bar-fill" style={{ width: `${loadBarPercent}%` }} />
          </div>
          {/* Screen-reader channel: announces stage transitions only. The
              visible pill must NOT be a live region - its percent, elapsed
              seconds, and detail mutate continuously and would drown the
              reader. The percent itself is exposed via the progressbar. */}
          <span className="sr-only" role="status">
            {loadingSlow ? 'Still working. Large models take longest on their first open.' : loadPresentation.title}
          </span>
          <div
            className={`viewer-load-status${loadingSlow ? ' slow' : ''}${loadCompact ? ' compact' : ''}`}
          >
            {loadPresentation.chip && (
              <span className="viewer-load-chip">{loadPresentation.chip}</span>
            )}
            <div className="viewer-load-steps" aria-hidden="true">
              {LOAD_STAGES.map((s) => (
                <span
                  key={s.id}
                  className={`viewer-load-step${
                    s.index < loadPresentation.stage.index
                      ? ' done'
                      : s.index === loadPresentation.stage.index
                        ? ' active'
                        : ''
                  }`}
                />
              ))}
            </div>
            <div className="viewer-load-headline">
              <span className="viewer-load-title">{loadPresentation.title}</span>
              <span className="viewer-load-pct">{loadPercent}%</span>
              {loadEta.text && <span className="viewer-load-eta">{loadEta.text}</span>}
            </div>
            <span className="viewer-load-detail">{loadPresentation.detail}</span>
            {loadingSlow ? (
              <span className="viewer-load-slowline">
                Still working. Large models take longest on their first open.
              </span>
            ) : loadPresentation.caption ? (
              <span className="viewer-load-caption">{loadPresentation.caption}</span>
            ) : null}
            {loadPresentation.techDetail && (
              <span className="viewer-load-tech">{loadPresentation.techDetail}</span>
            )}
          </div>
        </div>
      )}
      {loadError && (
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          background: 'var(--s-2)',
          padding: 20,
          borderRadius: 6,
          border: '1px solid var(--danger)',
          boxShadow: 'var(--shadow-lg)',
          zIndex: 10,
          maxWidth: 400,
          textAlign: 'center',
        }}>
          <p style={{ color: 'var(--danger)', marginBottom: 8, fontSize: 13, fontWeight: 600 }}>
            3D loading error
          </p>
          <p style={{ fontSize: 12, color: 'var(--f-1)' }}>{loadError}</p>
          <p style={{ fontSize: 11, color: 'var(--f-2)', marginTop: 8 }}>
            The model data is still accessible via the tree and properties panels.
          </p>
        </div>
      )}
      {viewerReady && !BROWSER_ONLY && <FloatingChatDock />}
      <HighlightBadge />
      {viewerReady && <SelectionSummaryChip />}
      {/* Bottom-center tool row: nav/visibility pill + ghost-mode toggle
          (ghost appears only when elements are isolated) */}
      {viewerReady && (
        <div style={{
          position: 'absolute',
          bottom: 56,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 20,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <ViewportNavControls onFitModel={() => fitToModel()} />
          {isolatedIds.length > 0 && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              background: ghostModeOn ? 'var(--accent, #3b82f6)' : 'var(--s-2, #1e2535)',
              border: `1px solid ${ghostModeOn ? 'var(--accent, #3b82f6)' : 'var(--b-2, #374151)'}`,
              borderRadius: 20,
              padding: '5px 12px 5px 10px',
              cursor: 'pointer',
              boxShadow: 'var(--shadow-md, 0 4px 12px rgba(0,0,0,0.4))',
              userSelect: 'none',
              transition: 'background 0.15s, border-color 0.15s',
            }}
              onClick={() => setGhostModeOn(!ghostModeOn)}
              title={ghostModeOn ? 'Click to hide non-isolated elements (Shift+G)' : 'Click to show ghosted view with xray edges (Shift+G)'}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                stroke={ghostModeOn ? '#fff' : 'var(--f-2, #9ca3af)'}
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              >
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                <circle cx="12" cy="12" r="3"/>
                {ghostModeOn && <line x1="1" y1="1" x2="23" y2="23"/>}
              </svg>
              <span style={{
                fontSize: 11,
                fontWeight: 500,
                color: ghostModeOn ? '#fff' : 'var(--f-2, #9ca3af)',
                letterSpacing: '0.02em',
              }}>
                {ghostModeOn ? 'Ghost on' : 'Ghost off'}
              </span>
            </div>
          )}
        </div>
      )}
      <PerformanceHud />
      {perfDashOpen && (
        <PerformanceDashboard onClose={() => setPerfDashOpen(false)} />
      )}
      {/* Element name tooltip on hover - leaf component fed by hoverTooltipBridge */}
      <ViewerHoverTooltip />
      {/* Touch-friendly zoom controls (+/- buttons) */}
      {viewerReady && (
        <div className="viewer-zoom-controls" aria-label="Zoom controls">
          <button
            className="viewer-zoom-btn"
            onClick={() => handleViewerZoom(-3)}
            title="Zoom in"
            aria-label="Zoom in"
          >+</button>
          <button
            className="viewer-zoom-btn"
            onClick={() => fitToModel()}
            title="Fit to view"
            aria-label="Fit to view"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>
              <line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
            </svg>
          </button>
          <button
            className="viewer-zoom-btn"
            onClick={() => handleViewerZoom(3)}
            title="Zoom out"
            aria-label="Zoom out"
          >-</button>
        </div>
      )}
      {/* B5 mount point: edit-mode drawing toolbar (gates itself on editMode). */}
      {wallDrawController && <EditToolbar controller={wallDrawController} />}
      <MeasurementControls
        snapshot={measurementSnapshot}
        onFinish={() => measurementControllerRef.current?.commit()}
        onCancel={() => measurementControllerRef.current?.cancel()}
        onClear={() => measurementControllerRef.current?.clear()}
        onRemove={(id) => measurementControllerRef.current?.remove(id)}
      />
      <MeasurementLabels
        snapshot={measurementSnapshot}
        viewerRef={viewerRef}
        containerRef={containerRef}
      />
      <MeasurementPanel
        measurements={measurementSnapshot?.committed ?? []}
        unit={measurementUnit}
        onRemove={(id) => measurementControllerRef.current?.remove(id)}
        onClearAll={() => measurementControllerRef.current?.clear()}
      />
      <ErrorBoundary label="ViewerContextMenu" fallback={null}>
        <ViewerContextMenu
          state={contextMenuState}
          onClose={() => setContextMenuState(null)}
        />
      </ErrorBoundary>
    </div>
  );
}
